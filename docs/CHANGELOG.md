# CHANGELOG — Current System State

This is the **authoritative record of what the bot does now**. The older
reference docs ([ARCHITECTURE.md](ARCHITECTURE.md), [SIGNAL_PIPELINE.md](SIGNAL_PIPELINE.md),
[TRADE_PLAN.md](TRADE_PLAN.md)) describe the pre-overhaul baseline and their
inline line-numbers predate these changes — read this file for the deltas.
The audit fix-by-fix mapping lives in [AUDIT_RESOLUTION.md](AUDIT_RESOLUTION.md).

Verified live on the boot of 2026-05-31 (627 Binance pairs normalised, hybrid
price feed active, paper positions restored, regime + trailing on). All changes
covered by `node test/sanity.js` (**154 passing** as of 2026-06-10).

---

## 0l. Manipulation-risk score + Upbit-via-relay (2026-06-15)

- **Manipulation-risk score** (`conductor.js assessManipulation` + `#assessManipulation`,
  exported + tested). NOX's low-cap pump-and-dump filters → 0..1 risk: futures>>spot
  volume (Bybit turnover vs CoinGecko, now split in `prices.js` getFuturesVolume/
  getSpotVolume), 24h volume ≈/≥ market cap, low circulating float (circ/total from
  the universe), top-10 holder concentration. In `#evaluate` it DE-WEIGHTS positive
  TA (`× (1 − risk·MANIP_TA_DEWEIGHT)` — chart is noise on a manipulated float),
  PENALISES a LONG (`−risk·MANIP_LONG_PENALTY`, don't chase the pump) and BOOSTS a
  SHORT (`+risk·MANIP_SHORT_BOOST`, fade the dump). Reason-kind `manipulation`.
  `MANIP_GUARD=1`. Negative/disconfirming TA still counts fully.
- **Upbit listings via the relay.** Confirmed `Upbit HTTP 403` (Cloudflare blocks the
  US datacenter IP) while Binance/Bithumb work. Added a `/upbit` route to
  `vercel-relay/api/proxy.js`; `listing-monitor.js #fetchUpbit` now tries the
  Singapore relay first (fuller browser headers), falls back to direct. Needs the
  relay redeployed (`cd vercel-relay && vercel --prod`). Tests: 204.

## 0k. Real-time liquidations + profit-trail + liq-safety (2026-06-15)

- **Real-time liquidation source** (`binance-liquidations.js` + `tools/binance-liq-forwarder.js`).
  Proved the Coinalyze liquidation-history feed reports ~1% of reality (a 63k→66k
  BTC squeeze showed a $33K max 1-min bucket). Binance's only all-market feed is the
  `!forceOrder` WS — but the host is geo-blocked (the WS hangs). Built the WS source
  (forwards into the existing `liquidations` emitter, covers all universe symbols)
  with a configurable `BINANCE_LIQ_WS_URL` + 15s connect-timeout, plus a deployable
  Singapore forwarder. `BINANCE_LIQ_WS=1`.
- **Profit-trail** (`auto-trader.js #trail`). The early-BE only ever locked breakeven,
  so the dominant "+2.3% peak then reverse" trades scratched. Now after breakeven the
  stop ratchets to `(favourable% − TRAIL_GAP_PCT)`, locking profit and only moving up —
  a pop to +4% that reverses exits ~+2% instead of scratching. `TRAIL_GAP_PCT=2.0`.
- **Liquidation-safety leverage cap** (`risk-engine.js sizePosition`). Leverage was
  capped only at `maxLeverage`, so a wide SL + high leverage got the position
  LIQUIDATED before the stop fired. Now caps leverage at `floor(1/(slFraction +
  AUTOTRADE_LIQ_BUFFER))` so the liquidation always sits beyond the SL.
- **Profit-trail is now PER-USER** (auto-trader `trailGapPct` param + `setProfitTrail`,
  persisted; user-accounts `setProfitTrail` + `#buildTrader` wiring; bot-commands
  "🏃 Bank pops" menu toggle + `at:ptrail`). Each account turns it on/off from the bot.
- **Top-MC majors scan** (`index.js`). Proactively runs the full confluence engine
  over the top market-cap names (where TA is reliable vs manipulated low-caps) at
  NORMAL thresholds, rotating `MAJORS_TOP_N` through `MAJORS_DEPTH` every
  `MAJORS_SCAN_MIN`(60). Source `majors` (skips momentum/CVD gates). Tests: 199.

## 0j. Deferred-fix sweep + RSI divergence (2026-06-12)

Closed the four §0i-deferred items and added the top trader-review edge:
- **Orphan watch (alert-only)** (`auto-trader.js #monitor`). A position open on the
  exchange but NOT in the journal (lost-journal after a crash, or a manual trade) is
  now detected and ALERTED once (de-duped via `_alertedOrphans`, skips in-flight
  `_reserved`) — never force-closed (that could kill a user's manual position). Moved
  the position fetch ahead of the no-journal early-return so a fully-lost journal still
  surfaces its orphans.
- **`/resetstats` race** (`signal-tracker.js reset`). Now snapshots + bumps `resetGen`
  + clears BEFORE persisting, so an in-flight `resolveOpen()` tick sees the new gen at
  its guard and abandons its (stale) write instead of resurrecting archived signals.
- **Decryption-failure notify** (`user-accounts.js start`). A user account that can't be
  restored (almost always a rotated `KEY_ENCRYPTION_SECRET`) now DMs the affected user
  (“reconnect with /connect”) + pings the operator, instead of silently not trading.
- **Heatmap fetch gating** (`conductor.js`). `computeFast` now runs only for candidates
  within the max magnet bump (~0.5) of the lowest firing bar, not every observation —
  skips wasted network fetches that could never promote to a signal.

- **RSI DIVERGENCE (regular)** (`ta.js detectRsiDivergence`, exported + tested). Price
  higher-high while RSI lower-high → bearish (supports SHORT); price lower-low while RSI
  higher-low → bullish (supports LONG). A reversal tell ORTHOGONAL to the anti-predictive
  momentum stack and strongest exactly where the bot's edge lives (exhaustion-reversal /
  liquidity-grab fades). Confirmation-only (never penalises), HTF-only (1h/4h/daily/1week
  — noise on 1m/5m), reason-kind `divergence`, score = TF weight × `DIVERGENCE_MULT`.
  `RSI_DIVERGENCE=1` default. From a 10y-trader strategy review; the other top items
  (pullback-limit entry for trend-following, FVG, VWAP, OI-credit→0) are documented but
  NOT yet applied (behavioural / pending validation).

Tests: 193 passing.

## 0i. Four-dimension audit pass — safety/correctness/efficiency (2026-06-12)

Parallel read-only audit (live-money safety, signal correctness, efficiency,
persistence). Many agent findings were over-reported / verified-false (onchain RPC
fetches DO have `AbortSignal.timeout`; `plan.sl` IS direction-aware so no wrong-side
SHORT stop; the "unbounded map" leak math assumed 100 flows/min when flows are
≥$500K whale moves). The CONFIRMED, fixed items:

- **Double-fill reservation** (`auto-trader.js #handle`). `hasOpen()` and
  `store.append()` straddle several awaits, so two signals for the SAME symbol in
  one tick could both pass the guard and open two positions (the CLAUDE.md known
  gap). Added a synchronous `_reserved` Set (check-then-add with no await between =
  atomic in single-threaded JS), cleared in `finally` so a failed attempt never
  locks the symbol. Closes the concurrent double-fill race.
- **NaN-PnL guard** (`auto-trader.js #monitor`). The last-price-estimate close did
  `px = lastPrice ?? t.tp`; if both null, `pnlUsd` became NaN and silently
  corrupted the daily-loss counter (defeating the breaker). Now falls back to
  `t.entry` (breakeven) so px is always finite.
- **structuralRoom false-shelf** (`conductor.js`). Each TF contributes both its
  `swingHighs` array AND its single `swingHigh` (usually the same value), so one
  distinct level appeared twice and a LONE level read as a 2-member "shelf" →
  over-demoted to observation. Now dedupes (`[...new Set(levels)]`).
- **TA timeframe fetches parallelized** (`ta.js analyze`). Per-TF OHLCV fetches ran
  sequentially (~4 stacked relay round-trips on the hot signal path); now one
  `Promise.all`, compute order unchanged. ~60-80ms off every signal's TA step.
- **loadJson boot crash** (`index.js`). A corrupt/missing required config died with
  a bare `SyntaxError` and no filename; now names the file before re-throwing.

Tests: 189 passing. DEFERRED (flagged, not auto-applied — risky or low-frequency):
orphaned-exchange-position handling (force-close is dangerous — wants alert-only),
signal-tracker `reset()`-vs-resolver write race, user-account decryption-failure
notification, heatmap `computeFast` gating on observations.

## 0h. Daily-loss counter persistence + listing autotrade (2026-06-10)

- **Daily-loss breaker survives restart** (`risk-engine.js` `daySnapshot`/
  `restoreDay`; `auto-trader.js` `#saveDayState`/`initDayState`, ns
  `autotrade-daystate`). The counter (dayKey/startBalance/realisedPnl/halted) is
  persisted to Neon after every realised PnL and restored at boot — but only if
  the snapshot is the CURRENT UTC day (stale → rolls fresh). Closes the live-money
  gap where a mid-day redeploy reset the breaker and could blow past the limit.
  Wired for operator (`dayStateKey:'operator'`) and each user (`user-<chatId>`).
  Persists to Neon when `DATABASE_URL` is set, else a file (operator: config
  sibling; users: `logs/autotrade-daystate-user-<id>.json`) — so file-only
  (no-DB) deployments persist the per-user breaker too (review finding, fixed).
- **Listing catalyst autotrade** (`conductor.js` `#applyTradeQualityPenalties`
  + `auto-trader.js #handle`). Upbit/Bithumb/Binance listings pump on the
  announcement before any multi-TF structure exists, so the TF-alignment
  downgrades were crushing them to observation-only. Listings are now EXEMPT from
  the weak-alignment penalty + the alignment tier cap (like exhaustion-reversal),
  and the autotrader trades them STRAIGHT — bypassing the horizon + alignment
  gates (still MEDIUM+, LONG, valid plan, risk/daily-loss/sizing gates intact).
  `AUTOTRADE_LISTING=1` default; `0` = signals-only. NOTE: only listings with a
  tradeable Bybit perp + enough price history for a plan can auto-trade; a
  brand-new token with no perp still only alerts (can't order what's not listed).

---

## 0g. CVD veto, WoE weights, daily-limit control, scoring knobs (2026-06-10)

Second wave of the signal-quality overhaul (ranks 4-6 + the CVD feature) plus a
per-user risk control.

- **CVD order-flow veto** (`src/cvd.js`, wired in `conductor.js #cvdVetoes`). The
  #1 loss cause was wrong-direction entries (49% of losses). CVD = taker-buy −
  taker-sell volume; a momentum entry where price rose but flow is net SELLING
  (or fell but net BUYING) is a fakeout and is dropped. No WebSocket needed —
  Binance futures klines carry per-bar taker-buy volume, fetched via the existing
  Singapore relay (geo-safe), on-demand + 30s cache, FAIL-OPEN, momentum-only.
  Live-validated end-to-end. Knobs `CVD_VETO/CVD_BARS/CVD_MIN_PRICE_MOVE_PCT/
  CVD_OPPOSE_RATIO`.
- **Per-user daily-loss limit** (`risk-engine.js` `setDailyLossLimitPct`,
  `auto-trader.js` `setDailyLimit`, `user-accounts.js`, `/autotrade` menu →
  🛑 Daily loss limit + `/autotrade daily <pct|off>`). Each account sets its own
  breaker %; persisted (operator via Neon config, users via their settings doc);
  0 = off; raising/lowering re-evaluates an active halt in both directions. The
  menu shows the limit + today's realised PnL.
- **Rank 6 — data-derived weights** (`src/tools/derive-weights.js`, `npm run
  derive-weights`). Offline, read-only. Computes shrunk Weight-of-Evidence per
  reason-kind, per-trigger WR, a score→P(win) reliability table, and an HONEST
  walk-forward (out-of-sample) check. First run on 346 records: top weights
  distribution +0.43 / funding +0.34 / flow +0.33 / supplyPct +0.33, only strong
  negative surge −0.17; OOS lift +3.8pts (🟡 directional — not yet ship-as-live).
- **Ranks 4-5 — env-tunable scoring weights** (`conductor.js` `SCORING`,
  `funding.js` `OI_FRESH_CREDIT`). De-fund anti-predictive surge/TA/OI; raise
  flow/funding_trigger/distribution. **Defaults reproduce pre-overhaul behaviour
  EXACTLY** — knobs ship ready + documented (`.env.example`) but change nothing
  until opted in, per the plan's "validate walk-forward before trusting new
  bases". Knobs: `SURGE_BASE/TA_SOFT_CAP/TA_HARD_CAP/OI_FRESH_CREDIT/
  FLOW_BASE_BOOST/TEAM_SELL_PTS/FUNDING_EXTREME_BASE/DISTRIBUTION_BASE`.

---

## 0f. Signal-quality overhaul — fire the edge, mute the noise (2026-06-10)

Driven by a live-data audit of **345 resolved signals** pulled from Neon. Finding:
the on-chain/funding triggers win 60-70% (distribution 70%, flow 60.6%,
funding_extreme 60%) but momentum (surge 41%, movers 33.8%) is **72% of volume at
~breakeven after fees** and drags the blended win rate to 45.8%. The scoring also
rewarded anti-predictive factors (reason-kind win-lift: `surge −10.3, ta −9.7,
oi −9.2` vs `flow +5.7, funding +6.6, distribution +5.7`), so "VERY HIGH" tier
won only 33%. Fix = **selection, not geometry** (winners' median heat is only 30%
of SL → stops are NOT too tight; widening them / partial-TP / min-R:R were all
adversarially refuted by the data).

Shipped (each behind an env flag, reversible, A/B-able via the per-trigger tag):
- **Rank 1 — momentum off live capital** (`auto-trader.js`): the autotrader no
  longer deploys capital on `movers` (33.8% WR) or `surge` (41%) by default;
  it runs on the +EV set (flow/funding_extreme/liquidation). Alerts still fire.
  Re-enable: `AUTOTRADE_ALLOW_MOVERS=1` / `AUTOTRADE_ALLOW_SURGE=1`.
- **Rank 2 — confirmSignal on the scan path** (`conductor.js` `#confirmGateDrops`):
  the movers/scan path now runs the same independent-indicator veto event
  signals get (it previously skipped it — the documented audit gap; movers was
  the worst bucket).
- **Rank 3 — soft confluence gate** (`conductor.js` `momentumLacksEdge`,
  exported + unit-tested): a `surge`/`movers` signal only FIRES if it carries a
  predictive on-chain/funding reason (`MOMENTUM_EDGE_KINDS`). Pure momentum goes
  silent. Kill switch `MOMENTUM_REQUIRE_EDGE=0`. **Honest caveat:** this is
  mostly a volume cut — total signals likely fall >40%, so winning-trade *count*
  may drop even as win rate / per-trade expectancy rise (trade less, better).

Staged but NOT yet shipped (need pairing + walk-forward validation): Rank 4
(de-fund anti-predictive surge/TA/OI weights), Rank 5 (raise flow/funding/
distribution base scores + exempt high-edge counter-trend triggers from the
alignment/sentiment caps), Rank 6 (replace hand-tuned weights with shrunk
Weight-of-Evidence + isotonic tier calibration). Top new-feature rec: build an
in-house **CVD** (Binance aggTrade WS) as a hard veto on momentum entries — the
single biggest data gap, directly attacks the 49% wrong-direction losses.

---

## 0e. Base chain, instant-win stats, dismiss UX (2026-06-10)

- **Base (Coinbase L2) support.** `base` is now a first-class EVM chain:
  CoinGecko platform key `base` → universe contracts (`universe.js`), Basescan
  explorer links (`explorers.js`, `conductor.js`), Base DEX router labels
  (Uniswap/Aerodrome in `onchain-evm.js`), Base RPC pool (`config/rpcs.json`),
  and a Base `EvmMonitor` in `index.js` (gated `ENABLE_BASE`, default on).
  `EvmMonitor.start()` no longer requires CEX wallets — it runs whenever there's
  an insider/team address to watch, and `refreshTeamIndex()` lazily boots the
  poll loop when the FIRST insider is added live (no restart). `/insider add
  <SYM> <wallet> base` works (aliases `eth`/`bnb`; lists which chains a token
  actually has on file when the requested one is missing). Base CEX **deposit**
  detection stays off until verified hot/cold addresses are added to
  `config/cex-wallets.json` (placeholder `base._note` documents this) — the
  insider **DEX-dump** path works today.
- **Win-rate updates the moment TP1 lands** (`signal-tracker.js`). A still-open
  signal that has banked TP1+ has a stop ratcheted to entry/TP1 → its terminal
  outcome is a guaranteed win, so it now counts in `/stats` immediately instead
  of waiting hours for the final TP3/stop. SL already resolved instantly.
- **`/open` hides banked TP1+ runners** — they're locked-in wins riding a
  trailing stop, not live-risk trades. The resolver still trails their stop in
  the background; they resurface only as the final TP/stop alert.
- **✖ Dismiss clears the command too.** Dismissable replies and the `/autotrade`
  menu are sent as replies to the triggering command; dismissing now deletes
  both the bot message and the user's command (`reply_to_message` survives
  in-place menu edits, so the link holds after many button taps).
- **Liquidation cascade verified live** (no code change): the Coinalyze path
  resolves perps, pulls 1-min buckets through the relay, and emits with correct
  long/short bias. "No alerts" in calm markets is the $500k threshold doing its
  job (30-min peak was ~$141k); the `lookback ≥ poll + 180s` overlap fix from 0d
  is active. Lower `MIN_LIQUIDATION_USD` to catch smaller flushes.

---

## 0d. Multi-user, persistence, progressive-TP & privacy (2026-06-02 → 06-09)

The bot moved from a single-operator VPS script to a multi-user, cloud-hosted
service. Major deltas since 0b:

**Hosting & persistence**
- **Neon Postgres** is now the durable store (`src/db.js` kv + journal namespaces).
  ALL state survives a Render redeploy: subscribers, encrypted user keys, signal
  journal, paper positions, autotrade journals/config, watchlist, team-wallet
  cache, regime toggle. Falls back to JSONL files when `DATABASE_URL` is unset.
- **Render hosting** (`src/health-server.js` `/health`) + a **Singapore Vercel
  relay** (`BYBIT_BASE_URL`) that proxies Bybit/Binance — the US datacenter IP is
  geo-blocked direct. `src/ta.js getLastPerpPrice` now routes via the relay too
  (was hitting Bybit direct → OKX-fallback price mismatch).

**Multi-user auto-trading**
- Any user can `/connect` their own Bybit **trade-only** keys (AES-256-GCM
  encrypted at rest, `src/crypto-vault.js`); the bot fans every signal to their
  isolated account (`src/autotrade/user-accounts.js`) — own store
  (`autotrades-user-<id>`), own paper balance, alerts only in their DM.
- **Per-user signal filters** (`/autotrade → 🎚️ Signal filters`): each account
  picks which **trade horizons** to auto-trade (Scalp / Day / Swing / Position)
  and a **min multi-TF-alignment** floor (off / 3 / 4 / 5 of 6). Operator filters
  persist in Neon; user filters in their account settings.

**Privacy**
- Operator identity is the Telegram **user id (`from.id`)**, never `chat.id` — a
  shared group can no longer make members "the operator".
- All money UI (`/autotrade`, `/pnl`, `/connect`, trade balances) is
  **private-chat only**; in a group the bot replies "DM me".

**Signal/outcome changes**
- **Progressive take-profit.** TP1, TP2, TP3 each fire their OWN alert as price
  reaches them (hours apart) instead of resolving on the first TP. After TP1 the
  trade is a **risk-free runner**: the tracked stop ratchets to **breakeven after
  TP1, then TP1 after TP2** (mirrors the autotrader), so it can't become a loss.
  Booked PnL exits at the **locked stop level** (not the TP target) so a
  round-tripped runner isn't over-credited. `src/signal-tracker.js #scan`.
- **Raw insider-sell alert** — when a tracked insider's qualified sell (≥$50k)
  is seen, a labelled transfer alert (token amount, USD, network, DEX/CEX venue,
  explorer link) fires IN ADDITION to any trade signal. `conductor #emitInsiderSell`.
- **Volume is no longer a standalone alert.** It only acts inside the surge gate
  (suppress <1.5× the 60-bar avg, upweight ≥2×/≥3×) — i.e. price + volume together.

**Insider auto-discovery**
- Primary holder source is the **Moralis token-owners API** (`MORALIS_API_KEY`),
  which serves datacenter IPs (etherscan/bscscan HTML scraping is Cloudflare-blocked
  on Render). Scrape (relay → direct) remains the fallback. Labelled holders are
  skipped only when the label looks like infra/exchange/DEX — team/treasury/
  deployer/unknown tags are kept (a blanket label-skip zeroed the API results).

**Stats**
- `/tunestats` reads the **Neon-backed** signal set (live + archived resets), not
  the ephemeral `signals.jsonl` (which Render wipes on redeploy). Adds win-rate
  breakdowns by anchor TF, aligned-TF, and TF combination.

**Known gaps (flagged in the 2026-06-09 audit, not yet fixed)**
- ⚠️ **Daily-loss breaker resets on restart** (`risk-engine.js` day counters are
  in-memory) — on Render the live daily-loss cap is ineffective across redeploys.
- The **movers-scan signal path bypasses the `confirmSignal` cross-validation
  veto** that event-driven signals must pass (asymmetry; can let weaker scan
  signals reach autotrade).
- No synchronous same-symbol reservation in `AutoTrader#handle` → two signals for
  one symbol in the same monitor gap could both place (exchange position check is
  the only backstop).
- If `AUTOTRADE_MIN_ALIGNMENT_WEIGHT>0` is ever set, it silently shadows the
  per-user `minAlignment` count gate (currently unset, so inactive).

---

## 0b. Regression fix — "short every pump" (2026-06-01)

Live data showed the win-rate had **regressed 50–60% → 32%** over the audit
overhaul (git baseline `0f48d3a` was 50–60%). Root cause from the stats: **SHORT
30% (n=20, 80% of all signals were counter-trend shorts)** and **VERY HIGH 0/2**
— the tier was driven by stacked overbought-RSI / funding / FDV / regime points,
so a 1/6-alignment counter-trend short scored VERY HIGH (MYX 5.43, with a 10.45%
SCALP stop). Three targeted reverts/fixes:

- **Alignment gates confidence.** A counter-trend trade (daily-against) with weak
  multi-TF support (≤0.30 weighted) is capped to **observation**; VERY HIGH now
  **requires ≥0.50 weighted alignment**. Kills the confident counter-trend shorts
  (MYX → observation, never fires). `#applyTradeQualityPenalties`.
- **SL ceiling is horizon-scaled** — SCALP 4% / DAY 6% / SWING 9% / POSITION 12%
  (was a flat 12%). A scalp can no longer ship a 10% stop; structure-SL can't drag
  a scalp out to a far swing (falls back to the tighter ATR stop).
- **Exhaustion-reversal shorts OFF** (`ENABLE_EXHAUSTION_REVERSAL=0`) — the
  riskiest short-generator (fading tops), off until measurement proves expectancy.

Expect **noticeably fewer signals** — that's intended; we're cutting the losing
counter-trend shorts, not adding more logic.

## 0. Accuracy audit pass (2026-06-01)

A four-front audit (scoring, TA, geometry, measurement) drove this batch. All
target the operator's named losing patterns: getting stopped right before the
move, entering against stretch, and chasing late.

**Geometry / entry**
- **Structure-aware SL** (market path): stop anchored just beyond the nearest
  swing instead of a fixed ATR multiple (the WAL stop-hunt). §4.
- **TP ladder forced monotonic**: a snap could invert TP1>TP2 → broke R:R +
  trailing. §4.
- **Counter-trend limit fixed** (the GENIUS miss): placed on the NEAR side of
  the swing (touch fills) instead of 0.3×ATR *beyond* it; reach gate tightened
  to 4% for SCALP/DAY; **fill-wait decoupled** from the hold (min 12h) so the
  sweep has time to tag the limit.

**Scoring (fewer, cleaner signals)**
- **Signal bar lifted off the MEDIUM floor**: `MIN_SIGNAL_SCORE` 3.0→**3.5**,
  pinned 2.5→**3.0** (at 3.0 every borderline setup fired at the weakest MEDIUM).
- **Acute counter-BTC-regime → hard cap** (observation-only), not a −1 nudge —
  a clean alt long no longer fires into a BTC dump.
- **De-double-counting**: a liquidation no longer scores 3× (trigger + prior +
  magnet); funding **level + velocity** no longer both credit the same crowding;
  mild-positive funding for a LONG (crowded/late) is now **neutral**, not +0.2.

**TA correctness (every finding now honest)**
- **No forming-bar lookahead**: RSI/MACD/BB/candles + SMC/swings (ta.js) and the
  confirm gate now compute on **closed bars only** — findings no longer flip
  intrabar / fire on a bar that never closes there.
- **Weekly candles anchored to Monday** (were epoch-Thursday → ~3-day-off macro).
- **Single swing level = nearest fractal pivot**, not the raw 20-bar extreme
  (a lone spike was a bad limit/SL anchor; also feeds the new structure-SL).

**Measurement (trustworthy win-rate)**
- **Resolver no longer scans pre-signal bars** (a wick in the minute *before* the
  signal could fabricate an SL/TP touch) and **sorts bars by time**.
- **MFE/MAE capped at the resolving bar** — excursions no longer absorb price
  action *after* the trade closed (was biasing the /tunestats tuning hints).

---

## 1. Data sources & infrastructure

### Singapore relay now serves Bybit **and** Binance
`vercel-relay/api/proxy.js` routes `/relay/*` → Bybit and `/relay/binance/*` →
`fapi.binance.com`. One Singapore-egress relay unblocks both exchanges for the
geo-blocked US VPS. The bot auto-derives the Binance base from `BYBIT_BASE_URL`
(or `RELAY_BASE_URL`); auth is the shared `BYBIT_PROXY_SECRET`.
**Redeploy the relay** (`cd vercel-relay && npx vercel deploy --prod`) after any
relay change.

### Funding + OI: Binance primary (via relay)
- `BinanceFuturesMonitor` probes direct → relay → falls back to Coinalyze. With
  the relay it's the **primary** funding source (more coverage + the
  source-of-truth venue). ~395 universe tokens covered (was ~250 on Coinalyze).
- **Funding-interval normalisation**: Binance no longer settles every pair at 8h
  (1h/4h/8h dynamic since 2026). `/fapi/v1/fundingInfo` is fetched and every rate
  is normalised to a **per-8h equivalent**, so a 4h pair isn't silently
  half-scored. (Boot logs how many non-8h pairs were found.)
- **Funding velocity** is now computed for the Binance path (was unimplemented).

### Price / surge feed: Binance tickers primary, CoinGecko spot-only
`PriceMonitor` now uses **Binance `/fapi/v1/ticker/24hr`** (ALL perps in ONE
relay call / 60s — free, unmetered) as the fast price + 24h% + volume feed.
CoinGecko drops to a **slow poll (every `PRICE_CG_EVERY_N` ticks ≈ 15min)** for
the spot-only tokens Binance doesn't list. This ended the monthly CoinGecko
quota exhaustion (~90% fewer CG calls) and made perp prices exchange-direct.
Degrades to CoinGecko-only if the relay/Binance is unreachable. `PRICE_BINANCE=0`
forces the old behaviour. Meme pairs Binance prices per-1000 (`1000PEPE`) fall
through to CoinGecko rather than risk a 1000×-wrong price.

### Orderbook heatmap source — cross-venue aggregated (Binance + Bybit)
`LiquidityClusters` now **aggregates Binance + Bybit** depth (both via the relay,
fetched in parallel) instead of a Binance-only fallback chain. Binance is the
deepest book and leads price; Bybit is the **actual execution venue** (your fills
happen there). Walls are bucketed by 0.5% distance-from-mid and **merged across
venues**: a wall confirmed on BOTH is weighted **up** (×1.4), a wall on a single
venue (when both were reachable) is weighted **down** (×0.6) — a free **spoof
filter**, since a fake/pulled wall rarely appears on both books. The conductor
scores on the confirmation-weighted `sizeUsd` but the alert shows the literal
combined book size (`rawUsd`) + a `✓2-venue` tag. The Bybit depth fetch is now
routed through the relay (it was hitting `api.bybit.com` directly → blocked on
the US VPS). OKX remains a last-resort fallback for tokens neither primary
covers. Pure merge logic is the tested `aggregateOrderbookClusters()`.

---

## 2. Six timeframes (added 1-week)

The system now runs **1m · 5m · 1h · 4h · 1d · 1w**. The weekly frame is
**aggregated from daily bars** (`aggregateWeekly` in `src/timeframes.js`) — no
provider exposes a native weekly. TF weight vectors are centralised in
`src/timeframes.js` (shared by `ta.js`, `ta-confirm.js`, `conductor.js`). Weekly
carries the most alignment weight alongside daily; it gates the longest holding
horizons and contributes TP swing levels. Displayed as `X/6 TFs`.

---

## 3. Signal scoring (conductor)

Beyond the audit fixes (see AUDIT_RESOLUTION.md), the scorer gained:

### Orderbook heatmap — in EVERY path, dominance-based
- Runs on event signals **and** `/analyze` **and** the movers scan (was
  event-only — `/analyze` never saw walls).
- Wall significance is **relative to the book** (dominance vs the median wall),
  with a small absolute floor — so a $555K wall on a low-cap registers like a
  $30M wall on BTC. The old absolute $1M threshold never fired on alts.
- A dominant wall **behind** the trade (bid below a LONG / ask above a SHORT)
  defends it → small bonus. A dominant wall **in the path** (ask above a LONG /
  bid below a SHORT) is a barrier to TP → small penalty. Walls are
  support/resistance, **not** magnets.

### Strong-momentum TA override
A bare surge scores `1.0 + 0.5` (high-volume bonus) = **1.5** on the trigger
alone; adverse funding/OI can drag that *below* the observation floor
(`MIN_OBSERVATION_SCORE`), and the deep TA (RSI/MACD/structure) normally only
runs once that floor is cleared — so a high-conviction, high-volume surge could
skip analysis. A **≥3× volume surge now forces the TA pass regardless of base
score**, so an explosive move is always charted. Firing stays strict: the signal
threshold (pinned 2.5 / 3.0) and the confirm + exhaustion + regime guards are
unchanged, and a surge is still *not* an observable trigger — so this only ever
yields a **signal** when TA earns it, never a noise observation. (Note: with the
deployed `MIN_OBSERVATION_SCORE=1.0`, a 1.5 surge already clears the floor — this
mainly matters for surges fighting funding, or if the floor is later raised. It
is **not** what blocked LABUSDT — that was the per-token cooldown; see below.)
Logged as `… analysing despite low base score … volume momentum override`.

### `/autotrade margin` now persists across restarts
`setMargin` only set an in-memory field, so a restart reverted it to the `.env`
default. It now saves `{paperMarginUsd, liveMarginUsd}` to
`logs/autotrade-config.json` and restores them on boot (the persisted value
overrides the `.env` default). `configPath` wired in index.js.

### Coinalyze dual-path egress (opt-in) — IP-block resilience
If Coinalyze rate-limits/blocks the VPS IP, it breaks THREE things at once: TA
OHLCV (fewer signals), liquidation alerts (none), and `/regime` (BTC TA
"unavailable"). A new API key doesn't help if it's IP-based. `COINALYZE_RELAY=1`
now runs **dual-path**: uses BOTH the VPS-direct path AND the Singapore relay
(`/relay/coinalyze/* → api.coinalyze.net`, added to `vercel-relay`), **alternating
per call** (load spread across two IPs) and **failing over both ways** on
429/403/network (relay throttled → VPS; VPS blocked → relay). Off by default
(direct only, unchanged); requires redeploying the relay. Note: the 40/min quota
is per-KEY (IP-independent), so this helps IP-BLOCKING not key-quota — but the
client already gates under 40/min. (Also: "fewer signals" is partly *intended* —
the threshold raise + alignment cap took the win-rate 32%→52%.)

### Bybit autotrade: one-way position mode (hedge-mode fix)
Entries failed with `position idx not match position mode (retCode 10001)` on
hedge-mode accounts — the bot trades `positionIdx 0` everywhere (entry, trailing
SL, close) but sent no `positionIdx`, so a Hedge account rejected it.
`setIsolatedAndLeverage` now switches the symbol to **one-way (Merged Single)**
mode before entry, and entries send `positionIdx: 0` explicitly. (Surest fix is
still setting the Bybit account to One-Way Mode in the app.)

### `/regime` robustness
`/regime` does an on-demand poll, **retries 3× through a transient** Coinalyze
OHLCV hiccup, and **logs the root cause** (`perpMap has BTC: …, coinalyze: …`)
instead of a silent "unavailable". The background warm-up (every 15s until
loaded) is unchanged. Regime **does** bias scoring — BTC down → shorts get a
tailwind + counter-trend longs capped; BTC up → the reverse — but only while the
monitor is loaded, so this matters.

### Exhaustion-reversal LONG — symmetric mirror, own toggle
The capitulation-bottom counterpart to the reversal short: a FAVORED token
extremely **oversold** (daily *or* weekly RSI ≤ 20) with the **5m turning up** →
HIGH-RISK reversal LONG, overriding the confirm gate's "too oversold to LONG"
veto + the counter-trend alignment cap, exactly like the short. **Own
kill-switch `ENABLE_EXHAUSTION_REVERSAL_LONG`** so the strong-side longs (80% WR)
run independently of the weaker shorts (45%). Pure, tested
`isExhaustionReversalLong()`. Both are gated entirely behind the flag, so no
other trade type is affected.

### Exhaustion-reversal SHORT — HIGH RISK, watchlist-only
The confirm gate hard-vetoes any SHORT into 4h/daily RSI ≥ 80 ("never short
momentum") — which also blocks fading a genuine blow-off top (the LABUSDT
+46%→−31% pump-and-dump; the bot would only long it, then refuse the short).
New opt-in path: when a **favored (watchlist)** token is **extremely overbought**
(daily *or* weekly RSI ≥ 80) **and both fast TFs (5m+1h) have rolled over** (MACD
trend down) — a top that's actually *cracking*, not merely stretched — the bot:
1. **overrides** the confirm RSI-veto (`allowExhaustionShort`), so the short can fire;
2. relaxes the **opposite-side cooldown to 1×** for favored tokens (a prior long
   observation would otherwise lock the short for 90min — past the dump);
3. tags the alert **⚠️ HIGH RISK — exhaustion-reversal** so it's unmistakably a
   counter-trend fade (size down, honor the stop).
Detection is the pure, tested `isExhaustionReversalShort(side, favored, taMetadata)`.
Firing still needs the full pinned signal score (2.5) + MEDIUM tier. SHORT-only
(alt blow-offs dump); kill-switch `ENABLE_EXHAUSTION_REVERSAL=0`. Logged as
`[exhaustion-reversal] SYM SHORT — HIGH-RISK reversal short on watchlist top`.

### CEX distribution SIGNAL (the SKYAI miss) — on-chain, never auto-traded
Modelled on how an on-chain analyst reads CEX flow. The bot used to **ignore
hot-wallet→external transfers entirely** (only cold↔hot / team→CEX / cold→ext),
so the SKYAI dump — a flood of small Bitget hot-wallet outflows to MEV bots /
exchange-deposit wallets as it fell ~50% — was invisible (each transfer also fell
below the $500K flow gate). Now `hot→external / cross-exchange` transfers are
captured as **distribution candidates** ([onchain-evm.js](src/onchain-evm.js)) and
**aggregated per token over a 2h window**. When the cumulative is **abnormal vs the
token's own 24h volume** (≥4%, ≥$500K, ≥5 transfers — scale-invariant so majors'
constant withdrawals don't false-fire), it routes through the conductor as a
**real SHORT signal with a trade plan** (`evaluateDistributionTrigger`, trigger
`distribution`, base +2.5). It still runs TA/structure, so it **fires as a SIGNAL
when price/TA confirm** the distribution and a **👀 observation when they don't**
(don't short an uptrend on outflows alone — the LAB fake-out). **NEVER
auto-traded**: the autotrader explicitly skips `trigger.type==='distribution'`
(signals-only, operator's call), and the alert carries a `🔴 NOT auto-traded`
banner + the $ out / transfer count / %-of-volume / top destinations. Pure, tested
`assessDistribution()`. Tunable: `DIST_WINDOW_MIN`, `DIST_MIN_USD`,
`DIST_MIN_VOL_PCT`, `DIST_MIN_TRANSFERS`, `DIST_COOLDOWN_MIN`.

### Exchange listings → tradeable signals (the SLX miss)
Two fixes after SLX (Upbit + Bithumb + Binance-futures, +80%) fired no signal:
- **Bithumb detection was dead.** `feed.bithumb.com/notice` now returns HTTP 403
  (Cloudflare), so Bithumb listings silently stopped surfacing. Switched to the
  modern JSON API **`feed-api.bithumb.com/v1/notices`** and made detection
  **category-aware** — a post tagged `마켓 추가` (market addition) is a listing;
  an airdrop `이벤트` post that names the same ticker is excluded (no dup).
  Verified live: SLX/HNT/BILL detected. Pure `classifyListing` + `extractTickers`.
- **Listings now run through the Conductor.** A `listing` event previously only
  sent a heads-up; it now also calls `conductor.evaluateListingTrigger(symbol,
  {exchange})` — a **LONG-biased** evaluation with a new `listing` trigger base
  (Korean Upbit/Bithumb **+3.0**, Binance **+2.5**, else +2.0) + full TA /
  heatmap / confirm / trade-plan, so a listing can fire a **real, tracked,
  autotrade-eligible signal** (still needs confluence + a plan — won't blind-LONG
  a sell-the-news blow-off). Exchange data lags the announcement, so the eval
  **retries at 0 / +2min / +5min** (cooldown dedupes). The heads-up alert still
  always fires. `🆕 Exchange listing` trigger label.

### BTC market-regime filter (`src/regime.js`)
`RegimeMonitor` classifies **BTC** every 5min from its 1h/4h/daily trend + 1h
ATR into **BTC_UP / BTC_DOWN / CHOP** (plus *acute* = the fast TFs agreeing, and
*high-vol*). The conductor applies a **global bias**: a LONG into a BTC
downtrend (or SHORT into a BTC rip) is penalised **−1.0** (**−1.5** when BTC is
acutely dumping/ripping); aligned trades get **+0.3**. BTC itself is exempt.
This encodes "most alt LONGs get invalidated when BTC breaks down." See
`/regime`. Tunables: `ENABLE_REGIME`, `REGIME_PENALTY`, `REGIME_HIGH_VOL_PCT`.

---

## 4. Trade plan & execution

### Hold time is now target/volatility-aware
Validity is sized from the TP2 distance ÷ ATR × a noise factor, clamped per
horizon (SCALP 3–8h, DAY 8–20h, SWING 24–60h, POSITION 72h–1 week) — so a winner
isn't time-expired before price can realistically reach TP.

### Structure-aware stop-loss (the WAL lesson)
The SL was purely `ATR × wick-multiplier` — a fixed distance regardless of WHERE
the real invalidation sits. WAL LONG stopped at 2.25% (mid-structure) then ran
to TP3: the stop sat ABOVE the Triple-bottom (the true invalidation), so the
liquidity sweep that *precedes* the move took it out. Now the market-entry SL is
**anchored just beyond the nearest protective swing** (swing low for LONG / swing
high for SHORT) so a stop-hunt wick into that level can't reach it. It only ever
**widens** past the ATR stop (never tightens), picks the **nearest** qualifying
swing (minimal widening), respects `MAX_SL_PCT` (12%), and the risk-engine sizes
the position down for the wider stop so account-risk is unchanged. The
counter-trend limit path keeps the ATR distance (its limit is already at
structure). Alert shows `SL … below/above structure`; field `slBasis`.

### TP ladder is now monotonic (latent trailing-stop bug)
`#snapTpsToStructure` snapped each TP independently with overlapping R-bands, so
a swing in the overlap could pull TP1 *past* TP2 — inverting the ladder, wrecking
R:R, and moving the trailing stop the wrong way ("at TP1 → SL to breakeven"). The
snapper now enforces a strictly monotonic ladder, reverting any out-of-order TP
to its (always-ordered) raw ATR multiple.

### TPs snap to orderbook walls
`#snapTpsToStructure` now considers **dominant walls in the path** alongside
swing levels — a LONG takes profit just below an ask wall, a SHORT just above a
bid wall (where price stalls).

### Trailing stops (item E) — `AUTOTRADE_TRAILING=1` (default)
The auto-trade **holds for TP3** and **ratchets the SL up**: at TP1 → SL to
**breakeven**; at TP2 → SL to **TP1**. A runner that tags TP1 then reverses can
no longer become a loss. Live amends the Bybit stop via
`/v5/position/trading-stop`; paper moves the in-memory stop; both fire a 🪜
*Trail* alert. Overrides `AUTOTRADE_TP_TARGET` while on. `=0` reverts to a single
TP exit.

### Limit-entry hold clock
A filled liquidity-grab limit gets its **own fresh hold window** from the fill
moment (was sharing one clock with the fill-wait, truncating late fills).

### Sizing & leverage
- **Fixed-margin sizing** (paper + live): commit a set collateral/trade
  (`notional = margin × leverage`). Env `AUTOTRADE_PAPER_MARGIN_USD`,
  `AUTOTRADE_MARGIN_USD`; runtime `/autotrade margin <usd>`. 0 = risk-based +
  `maxPositionUsd` cap.
- Leverage constants documented; tier-cap curve smoothed; `maxLev` tier-capped.
  `sizePosition` returns `effectiveRiskPct` + `capBound` (the cap dominates
  riskPct on small accounts).

### Autotrade correctness
- Live closes resolved from Bybit **closed-PnL**, matched to the bot's exact
  position by **qty + entry** (a manual trade on the same symbol can no longer
  have its P&L misattributed to the bot).
- **SCALPs are signals-only** by default (`AUTOTRADE_SKIP_SCALP=1`) — the weakest
  horizon doesn't risk capital; it still fires as an alert.
- **Paper positions persist** to `logs/paper-positions.json` (survive restart).
- **Mode isolation:** the monitor now only manages trades opened in the *current*
  mode — switching paper↔live no longer lets the live monitor resolve leftover
  paper trades (or feed their P&L into the live daily-loss breaker).
- **Duplicate-guard fix:** the per-symbol open-trade guard now checks the stored
  `…USDT` symbol (it was checking the bare ticker, so it never matched and
  multiple positions could stack on one symbol) and is scoped per mode.
- **Operator-only alerts:** auto-trade open/close/trail/fail notifications go to
  the operator chat (`notifyChatId`) only — they're no longer broadcast to every
  subscriber (other users can't act on the operator's Bybit trades).
- **RSI exhaustion + surge-chase + counter-trend guards** (in §3, conductor):
  a LONG into multi-TF extreme overbought / SHORT into oversold is demoted to
  observation (buying parabolic tops — the STG −10.86% pattern); a surge entry
  into the 5m extreme it's chasing is −1 tier; 0-alignment + daily-against is
  capped at LOW.

---

## 5. Stats & tooling

- **Signal resolver**: chronological bar walk (first level touched), 0.1% SL
  slippage haircut, atomic in-memory open-set (kills duplicate signals), and an
  `AMBIGUOUS` outcome (SL+TP in one 1m bar) excluded from win-rate.
  - **Phantom-touch fix:** `#firstTouch` now **skips bars that opened before the
    signal** (`b.t < sig.ts`) and **sorts bars by open-time** first. The −60s
    fetch overlap was letting a wick in the minute *before* the signal resolve
    the trade (earliest bar wins the first-touch race → fabricated/misordered
    SL/TP touches). This makes the reported win-rate trustworthy.
- **`/tunestats`**: `current` mode (live file only — no old-engine
  contamination), **low-N flagging** (⚪ <20 samples = noise), **by-horizon**
  breakdown (watch SCALP in isolation), and an **MFE/MAE excursion block** with
  TP/SL-calibration hints.

---

## 6. Telegram commands (current set)

Public: `/start /stop /help /analyze /open /recent /leaders /movers /heatmap
/regime /stats /winrate /silence /unsilence /find`
Operator: `/watchlist /subscribers /resetstats /tunestats [current] /autotrade
[paper|live|off|on|margin <usd>|close <sym>]`

New since the baseline docs: **`/heatmap <SYM>`** (order-book walls),
**`/regime`** (BTC market regime + its bias), **`/tunestats current`**,
**`/autotrade margin <usd>`**, **`/autotrade close <sym>`**.

---

## 7. Environment variables (added / changed)

| Var | Default | Purpose |
|---|---|---|
| `RELAY_BASE_URL` | falls back to `BYBIT_BASE_URL` | Singapore relay base for Binance data |
| `ENABLE_BINANCE_FUTURES` | `1` | Binance primary funding (set `1`, not `0`!) |
| `PRICE_BINANCE` | `1` | Binance ticker price feed (`0` = CoinGecko-only) |
| `PRICE_CG_EVERY_N` | `15` | CoinGecko poll cadence in 60s ticks |
| `MIN_FLOW_USD` | `1_000_000` | flow trigger floor (was 500k) |
| `TA_CONFIRM_DROP_THRESHOLD` | `-2.5` | confirmation-gate veto threshold |
| `LEV_RISK_BASIS` | `2` | advisory-leverage risk basis |
| `ENABLE_REGIME` | `1` | BTC regime filter |
| `REGIME_PENALTY` | `1.0` | penalty for fighting BTC's trend |
| `REGIME_POLL_INTERVAL_MS` | `300000` | regime refresh cadence |
| `REGIME_HIGH_VOL_PCT` | `1.2` | high-vol regime threshold (1h ATR%) |
| `ENABLE_EXHAUSTION_REVERSAL` | `1` | HIGH-RISK watchlist top-fade shorts (`0` to disable) |
| `MOVERS_DEPTH` | `20` | deep movers pool the scan rotates through |
| `AUTOTRADE_TRAILING` | `1` | hold tp3 + ratchet SL after TP1/TP2 |
| `AUTOTRADE_SKIP_SCALP` | `1` | SCALPs are signals-only |
| `AUTOTRADE_MIN_ALIGNMENT_WEIGHT` | `0` | weighted-alignment autotrade gate |
| `AUTOTRADE_PAPER_MARGIN_USD` | `0` | fixed margin/trade in paper |
| `AUTOTRADE_MARGIN_USD` | `0` | fixed margin/trade in live |

---

## 8. New / changed source files

- **New:** `src/timeframes.js` (canonical TF vectors + weekly aggregation),
  `src/explorers.js` (centralised tx links), `src/regime.js` (BTC regime).
- **Heavily changed:** `conductor.js` (heatmap-all-paths, regime, validity,
  weekly, all audit fixes), `prices.js` (hybrid feed), `binance-futures.js`
  (relay + interval normalisation + velocity), `signal-tracker.js` (chronological
  resolver + atomic open-set), `ta.js` / `ta-confirm.js` (weekly + audit fixes),
  `autotrade/*` (trailing, closed-PnL matching, margin, paper persistence),
  `bot-commands.js` (new commands + tunestats), `telegram.js`, `index.js`.
