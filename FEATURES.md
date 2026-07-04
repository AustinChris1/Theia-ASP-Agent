# Trade Alert Bot — Feature Breakdown

A multi-source Telegram alert bot that detects market-maker manipulation by
combining on-chain CEX wallet flows, price surges, funding-rate extremes,
liquidation cascades, and multi-timeframe technical analysis.

Written entirely in plain Node.js (ESM).

> **⚠️ Partially out of date.** This file describes the core engine. Several
> capabilities were added later and are documented authoritatively in
> [docs/CHANGELOG.md](docs/CHANGELOG.md) — read §0d for the current state:
> **Neon Postgres persistence** (not just JSON/JSONL files), **Render hosting +
> Singapore relay**, **multi-user auto-trade** (`/connect`, encrypted keys,
> per-user signal filters: horizons + min-alignment), **progressive TP1/TP2/TP3
> alerts** with a risk-free runner, **raw insider-sell alerts**, **Moralis-based
> insider discovery**, **distribution + exchange-listing triggers**, **BTC
> regime filter**, **structure-aware SL + trailing stops**, **liquidation
> heatmap** (`/liqmap`/`/heatmap`), **private-chat-only money UI**, and
> `/tunestats` sourced from Neon. The trigger/command/config lists below predate
> those and are incomplete.

---

## 1. Architecture overview

```
┌─── DATA SOURCES ────────────────────────────────────────────────────┐
│                                                                     │
│  CoinGecko       Coinalyze       Public RPCs       Telegram         │
│  (prices,        (perp OHLCV,    (eth_getLogs,     (bot polling     │
│   volume,        funding, OI,    Solana sigs)      for commands)    │
│   FDV)           liquidations,                                      │
│                  L/S ratio)                                         │
│      │              │                  │                 │          │
└──────┼──────────────┼──────────────────┼─────────────────┼──────────┘
       ▼              ▼                  ▼                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                     MONITORS (event emitters)                      │
│                                                                    │
│  PriceMonitor   FundingMonitor    EvmMonitor  SolanaMonitor        │
│      │             │                │            │                 │
│      │             │                │            │                 │
│      │ LiquidationMonitor  TAService     CexHoldings                │
│      │      │                │              │                      │
└──────┼──────┼────────────────┼──────────────┼─────────────────────┘
       │      │                │              │
       ▼      ▼                ▼              ▼
┌────────────────────────────────────────────────────────────────────┐
│                  CONDUCTOR (signal scoring engine)                 │
│  - Listens to: 'flow', 'surge', 'liquidation' events               │
│  - Periodic entries: funding-extreme scan, top-movers scan         │
│  - On-demand: /analyze command                                     │
│  - Scores confluence, builds trade plan, emits 'signal' / 'obs'    │
└────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────┐
│  SignalTracker        Notifier (Telegram)         SheetLogger      │
│  - Logs to JSONL      - Broadcasts to subs        - Mirrors to     │
│  - Resolves SL/TP     - Handles commands            Google Sheets  │
│  - Emits 'resolved'   - Per-chat silence                           │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data sources (real, no mocks)

| Source | What we pull | Module |
|---|---|---|
| **CoinGecko `/coins/markets`** | Live prices, 24h volume, 24h % change, market cap, FDV | `prices.js`, `universe.js` |
| **CoinGecko `/coins/{id}`** | Per-token chain addresses, supply, market data (for pinned tokens) | `universe.js` |
| **CoinGecko `/search`** | Free-text token name → CoinGecko slug | `coingecko.js` |
| **Coinalyze `/funding-rate`** | Current funding rate per perp | `funding.js` |
| **Coinalyze `/funding-rate-history`** | Hourly history for rolling velocity | `funding.js` |
| **Coinalyze `/open-interest`** | Current OI USD per perp | `funding.js` |
| **Coinalyze `/liquidation-history`** | 1-min bucketed liquidation $ per perp | `liquidations.js` |
| **Coinalyze `/ohlcv-history`** | 1m/5m/1h/4h/daily candles (the TA backbone) | `ta.js` |
| **Coinalyze `/long-short-ratio-history`** | L/S ratio per perp | `ta.js` |
| **Coinalyze `/future-markets`** | Token → perp symbol mapping at boot | `coinalyze.js` |
| **Public RPCs (ETH/BSC)** | `eth_getLogs` for Transfer events, `eth_call` for `balanceOf`, decimals | `onchain-evm.js`, `cex-holdings.js` |
| **Public RPCs (Solana)** | `getSignaturesForAddress`, `getTransaction` w/ token balance deltas | `onchain-sol.js` |
| **Telegram Bot API** | Polling for commands, sending alerts | `telegram.js` |

Every number in every alert is computed from one of these live sources.
No synthetic data, no backtests passed off as real, no LLM-generated values.

---

## 3. Token universe

**Built on boot, cached for 7 days** (`logs/.universe-cache.json`).

Two-pass build:
1. **Top N by market cap** (default 500) — CoinGecko `order=market_cap_desc`
2. **Top M by 24h volume** (default 300) — CoinGecko `order=volume_desc`

These pools are merged and deduped → typically ~700-800 unique tokens.
Volume pass catches **high-FDV low-MC tokens** (tight-float / actively-traded
manipulation candidates) that MC ranking alone misses.

**Pinned tokens** (from `config/tokens.json` and `logs/user-watchlist.json`)
are ALWAYS loaded regardless of MC rank — operator's explicit watchlist.

For every token we capture:
- `symbol`, `name`, `marketCapRank`
- `marketCap`, `fdv`, `fdvRatio` (= FDV ÷ MC)
- `circulatingSupply`, `totalSupply`
- `chains` → per-chain contract address + decimals (ETH/BSC/Solana)
- `pinnedCgIds` / `hotMoverCgIds` flags

### Pinned vs hot-mover vs favored

- **Pinned** = explicitly listed by operator (`tokens.json`, `/watchlist add`)
- **Hot mover** = currently in top-N gainers or losers from the periodic
  movers scan (rotates every 30 min)
- **Favored** = pinned ∪ hot-mover. Threshold relaxations apply.

Favored tokens get:
- Surge threshold dropped from 3% → 2%
- 24h volume floor bypassed entirely
- Minimum flow threshold scaled to 25% of normal ($125k instead of $500k)
- Signal score threshold dropped (2.55 instead of 3.0 by default)

This is how small-cap watchlist tokens (LAB, MITO, etc.) get signal coverage
they wouldn't otherwise get.

---

## 4. Five trigger types

A "trigger" is what *starts* an evaluation. Each carries a base score that
contributes to the final confluence score.

### 4.1 🚀 Surge trigger
**Source:** `prices.js` 1-minute polling of CoinGecko prices.

Fires when a token moves ≥ 3% (or ≥ 2% for favored tokens) in any 60-second
window, with 24h volume ≥ $500k (favored bypass this).

**Volume confirmation gate** (`ta.js` `getVolumeRatio`):
- Before evaluating, fetch the last 60 minutes of 1-min OHLCV from Coinalyze
- Compute ratio = current minute's volume ÷ prior 60-bar average
- `ratio < 1.5` → surge **suppressed** (low-volume wick, not a real move)
- `ratio ≥ 2.0` → score bonus +0.3
- `ratio ≥ 3.0` → score bonus +0.5

**Base score:** +1.0 (+ volume bonus)

### 4.2 💸 CEX flow trigger
**Source:** `onchain-evm.js` + `onchain-sol.js` polling labeled CEX wallets.

We monitor a curated list of CEX hot/cold wallets (`config/cex-wallets.json`)
on Ethereum, BSC, and Solana. Every Transfer log involving a labeled wallet
is processed.

**Direction classification:**
| Source → Destination | Meaning | Side |
|---|---|---|
| Same-exchange hot → cold | Exchange accumulating off-market | **LONG** |
| Same-exchange cold → hot | Exchange preparing to distribute | **SHORT** |
| External → cold | Unknown depositor → cold storage (likely incoming distribution) | **SHORT** |
| Cold → external | Cold withdrawal off-exchange (supply leaving market) | **LONG** |
| Anything else (hot↔hot cross-exchange, etc.) | Too noisy | skipped |

**Filter:** flow USD must be ≥ MIN_FLOW_USD ($500k default; $125k for favored).

**Base score:** scaled by USD size:
- < $2M → +2.0
- $2-5M → +2.5
- $5-10M → +3.0
- ≥ $10M → +3.5

**Anti-spam:** per-token in-flight poll guard + cross-poll dedup cache
(10-min TTL on EVM, 1-hour on Solana). On Solana, an additional
**transaction age filter** (10 minutes) catches stale txs that the RPC
may re-hand on each poll (publicnode's `until` parameter is unreliable).

### 4.3 💥 Liquidation trigger
**Source:** `liquidations.js` polling Coinalyze every 10 min.

Fires when a 1-min bucket has ≥ $500k cumulative liquidations on a token.

**Side derivation:**
- More longs liquidated → forced selling → **SHORT** bias
- More shorts liquidated → forced buying → **LONG** bias (short squeeze)

**Base score:** +1.5

### 4.4 📊 Funding-extreme trigger
**Source:** Periodic scan (every 30 min). Picks top funding-rate leaders.

Top 5 most-negative + most-positive funding rates (rotating through ranks
1-5 → 6-10 → 11-15 → 16-20 over consecutive scans).

For each, fires an evaluation:
- Negative funding (shorts crowded) → **LONG** thesis
- Positive funding (longs crowded) → **SHORT** thesis

**Base score:** +0.0 (radar entry only — funding contribution comes via the
funding alignment scoring layer, not the trigger base)

### 4.5 🔥 Top-movers trigger
**Source:** Periodic scan (every 30 min). Top 10 gainers + top 10 losers
by 24h % change.

Each is marked as a hot mover (favored thresholds), then evaluated via the
Conductor's full pipeline.

**Base score:** +0.0 (radar entry)

### 4.6 (Manual: `/analyze` command)
Same pipeline, no triggering event. Operator-driven exploration.

---

## 5. Conductor — the scoring engine

The Conductor builds a **confluence score** by adding contributions from
many independent measurements. Higher confluence = higher score = better tier.

### 5.1 Funding alignment (`fundingScoreForSide`)

Per-token funding rate (normalized to 8-hour period) interpreted vs trade side.

For a **LONG**:
| Funding | Score | Reading |
|---|---|---|
| ≤ −0.10%/8h | +2.0 | deeply negative, shorts overcrowded → squeeze fuel |
| ≤ −0.05% | +1.5 | shorts crowded |
| ≤ −0.01% | +0.5 | mild short bias |
| ±0.01% | 0 | neutral |
| ≤ +0.05% | +0.5 | healthy bullish trend |
| ≤ +0.10% | −1.0 | crowded longs, late entry |
| > +0.10% | −2.0 | extreme — long squeeze risk |

Mirrored for SHORT.

**Special rule:** when a $2M+ flow trigger drove the evaluation, the
"crowded longs/shorts" penalty is capped at −0.5. Reasoning: a large
cold-wallet flow + crowded funding usually means real positioning, not
retail late-chase.

### 5.2 OI alignment (`oiScoreForSide`)
| Situation | Score |
|---|---|
| LONG + OI rising + price up | +0.5 (healthy expansion) |
| LONG + OI falling + price up | −0.25 (short cover, less sustainable) |
| SHORT + OI rising + price down | +0.5 |
| SHORT + OI falling + price down | −0.25 |

### 5.3 Funding velocity (rolling 1h)
We fetch `/funding-rate-history` for top-50 tokens by absolute funding,
compute `velocity1h = current − one-hour-ago`.

| Velocity | Score |
|---|---|
| favorable + abs ≥ 0.1% | +0.7 (regime change supports trade) |
| favorable + abs ≥ 0.03% | +0.3 (mild favorable drift) |
| against + abs ≥ 0.1% | −0.3 (positioning unwinding against you) |

Falls back to poll-to-poll `delta` for tokens we didn't fetch history for.

### 5.4 Prior aligned events (confluence boosters)
| Pattern | Score |
|---|---|
| 1+ other CEX flow same-side in last 60min | +1.0 |
| Same as above, within 5min (near-simultaneous) | +0.5 extra |
| 1+ aligned 1m surge in last 30min | +0.5 |
| Near-simultaneous | +0.5 extra |
| 1+ aligned liquidation in last 60min | +1.0 |
| Near-simultaneous | +0.5 extra |

### 5.5 Cold-wallet supply impact (LONG only, real-time)
Recent cold inflows as % of circulating supply:
- 0.5% → +0.5
- 1% → +1.0
- 5% → +1.5

### 5.6 FDV overhang
FDV ÷ MC ratio. High ratios = significant supply waiting to unlock.

| Ratio | LONG penalty | SHORT bonus |
|---|---|---|
| ≥ 7× | −0.8 | +1.0 |
| ≥ 3× | −0.5 | +0.6 |
| ≥ 1.5× | −0.2 | +0.3 |

### 5.7 Liquidation clusters (24h aggregate)
Recent liquidations are bucketed by price (0.5% bands) over 24h. Clusters
within ±2-8% of current price aligned with trade direction add score.

| Cluster $ aligned with trade | Score |
|---|---|
| ≥ $10M | +1.0 |
| ≥ $5M | +0.7 |
| ≥ $2M | +0.5 |

LONG signal with shorts-dominated cluster above = squeeze magnet.
SHORT signal with longs-dominated cluster below = cascade fuel.

### 5.8 Multi-TF Technical Analysis (`ta.js`)

For each of **1m / 5m / 1h / 4h / daily**, with weights:

| TF | Weight |
|---|---|
| 1min | 0.05 |
| 5min | 0.10 |
| 1hour | 0.20 |
| 4hour | 0.30 |
| daily | 0.35 |

Per-TF findings (score scaled by TF weight `w`):
- **RSI** (14) oversold/overbought aligned with side: +w; against: −w
- **MACD** (12,26,9) bull/bear cross: +w; histogram rising/falling: +w × 0.6
- **Bollinger** (20,2σ) price at lower/upper band (5m + 1h only): +w × 0.5
- **Candle patterns** (5m + 1h) bullish/bearish detected: +w × 0.6
- **Wick analysis** (1m + 5m + 1h): strong wick ≥ 2× body aligned: +w × 0.6
  (≥ 4× body = violent wick → +w × 1.0); against trade: −w × 0.5
- **Liquidity grab pattern** (5m + 1h + 4h): bar wicks past prior swing
  extreme then closes back inside → +w × 1.2 aligned, −w × 0.6 against
- **L/S ratio** (extreme positioning): ±0.4

1m uses a smoothed 20-bar SMA for its trend direction (MACD on 1m is too
noisy). Other TFs use MACD histogram direction.

### 5.9 Strength tier
The total confluence score maps to a base tier:

| Score | Tier |
|---|---|
| ≥ 5 | 🔥 VERY HIGH |
| ≥ 4 | ✅ HIGH |
| ≥ 3 | 🟡 MEDIUM |
| ≥ 2 | 🟠 LOW |
| else | ⚠️ MIXED |

### 5.10 Trade-quality penalties (tier downgrades)
After the trade plan is built, the tier can drop:
- **R:R < 1.0** → −2 tiers (impossible structurally now, kept as safety)
- **R:R < 1.5** → −1 tier
- **Weak alignment (weighted ≤ 0.15) + SCALP/DAY** → −1 tier
- **Sentiment-only (funding_extreme with no flow/liq backing)** → cap at HIGH
- **alignmentCount = 0 AND daily-against** → extra −1 tier (counter-trend on dead chart)

### 5.11 Firing rule
| Tier | Score check | Result |
|---|---|---|
| MIXED / LOW | any | 👀 Observation (lightweight ping) |
| MEDIUM / HIGH / VERY HIGH | < 3.0 (or 2.5 for favored) | 👀 Observation |
| MEDIUM+ | ≥ threshold | 🟢 Signal (full alert + trade plan) |
| Score < 1.0 | — | Silent (nothing) |

---

## 6. Trade plan construction

After the score is finalized, the Conductor builds a trade plan.

### 6.1 Pick horizon by weighted alignment
**Weighted alignment** = sum of weights of TFs whose `trend` matches the
trade side (max 1.0 when all 5 aligned).

```
if daily-against:
    horizon = DAY if 1h aligned & weighted ≥ 0.20 else SCALP
else if 3+ aligned including daily & weighted ≥ 0.50:
    horizon = POSITION (4h ATR, 72h validity)
else if 1+ aligned with 4h or daily & weighted ≥ 0.30:
    horizon = SWING (1h ATR, 24h validity)
else if 1h aligned & weighted ≥ 0.20:
    horizon = DAY (1h ATR, 8h validity)
else:
    horizon = SCALP (5m ATR, 2h validity)
```

**Daily-against veto:** if daily trends against the trade direction,
SWING and POSITION are blocked entirely — the bot refuses to take big-
horizon trades against the dominant macro trend.

### 6.2 Wick-aware SL distance
`slMultiplier` adapts to volatility on the chosen TF:

| Recent wick ratio (last 10 bars) | Multiplier |
|---|---|
| ≥ 3 | 2.5× ATR (very choppy) |
| ≥ 2 | 2.0× ATR (moderately choppy) |
| < 2 | 1.5× ATR (calm — default) |

`slDistance = atr × slMultiplier`.

### 6.3 SL and TPs
- **SL** = `entry ± slDistance` (opposite of trade direction)
- **TP1** = `entry ± slDistance × 1.5` (real R:R 1.5)
- **TP2** = `entry ± slDistance × 3.0` (real R:R 3.0)
- **TP3** = `entry ± slDistance × 4.5` (real R:R 4.5)

### 6.4 Leverage
Three numbers combine:

```
rawMaxLev = 2 / slPct        # 2% account risk on full SL
confidenceFactor = 0.3 + weightedAlignment × 0.7   # 0.3 (no align) → 1.0 (all 5)
tierCap from slPct:
    < 0.5%  → 10x (very tight SL — slippage risk)
    < 1.0%  → 15x
    < 2.5%  → 20x
    < 5.0%  → 10x
    ≥ 5.0%  → 5x  (wide SL — drawdown control)

suggested = max(2, min(tierCap, floor(rawMaxLev × confidenceFactor × 0.4)))
maxLev    = max(2, min(25,      floor(rawMaxLev × 0.7)))
```

`suggested` is shown as the primary number; `maxLev` as the upper ceiling.

### 6.5 Entry — market vs counter-trend limit

**Trend-following** (daily aligned with trade): **market entry only**.
The bot is calling the trade NOW.

**Counter-trend** (daily against): **limit at stop-cluster zone**. The
limit is placed 0.3× ATR PAST the closest swing high (for SHORT) or
swing low (for LONG) from the highest TF available (daily → 4h → 1h).
This is a stable chart level — doesn't drift between analyses.

Counter-trend signals (`isLiquidityGrab = true`):
- SL = `limitEntry ± slDistance × slMultiplier`
- TPs measured from the limit, not the market price
- Trade triggers only if price actually reaches the limit zone (sweeps stops)
- If validity expires without fill → `EXPIRED_UNFILLED` (not a loss)

---

## 7. Signal tracking + outcome resolution

**File:** `logs/signals.jsonl` (one JSON record per line).

### 7.1 Record on fire
Every fired signal is appended with: side, symbol, score, strength,
trigger, reasons[], entry, marketEntry (for LG), limitEntry,
isLiquidityGrab, awaitingLimit, sl, tp1, tp2, tp3, horizon, atrTf,
alignmentCount, validityHrs.

### 7.2 Resolver (every 5 min)
For each open signal:

1. **Fetch 1m OHLCV bars** from Coinalyze for the gap since last check
   (gives true exchange-precision wicks, not CoinGecko's smoothed avg)
2. **Two-phase logic** for liquidity-grab signals:
   - Phase 1 (`awaitingLimit = true`): only check if price has touched
     the limit zone. SL/TP suppressed. If validity expires → `EXPIRED_UNFILLED`.
   - Phase 2 (after fill): trail resets to the limit price. Standard SL/TP
     tracking from here.
3. **Outcome check** (Phase 2 or normal market-entry signals):
   - SL touched → `LOSS`
   - TP3 touched → `WIN_TP3`
   - TP2 touched → `WIN_TP2`
   - TP1 touched → `WIN_TP1`
   - Validity expired with profit → `EXPIRED_PROFIT`
   - Validity expired with loss → `EXPIRED_LOSS`

### 7.3 Outcome broadcast
When a signal resolves, an alert goes out:
```
✅ TP1 hit — BTC 🔴 SHORT
Entry: $73,250 → Resolved: $71,815
P&L: +1.96%
MFE/MAE: +2.10% / -0.83%
Original score: 4.52 (HIGH)  •  Duration: 2.3h
```

### 7.4 Post-loss cooldown (smart, price-aware)
When a LOSS resolves, the Conductor stamps `(symbol, side, ts, entry)`.

Re-fire rules on same symbol+side:
- < 30 min after loss → **hard suppress**
- 30 min - 4h → only suppress if `|current − loss_entry| / loss_entry < 3%`
  (still same setup level)
- > 4h → allow regardless

Opposite side never suppressed by post-loss — reversal trades are valid.

---

## 8. Telegram interface

### 8.1 Multi-user broadcast
Subscriber list persisted in `logs/subscribers.json`. Each user who runs
`/start` is added. Notifications broadcast to all subscribers; individual
command replies go only to the issuing chat.

Auto-removal: if a user blocks the bot, the `Forbidden` error is caught
and the chat removed from the broadcast list.

### 8.2 Silence
`/silence 30m` (or `2h`, `1d`; max 7d) sets `silencedUntil` for the user.
Broadcasts skip silenced chats; commands still work.

### 8.3 Public commands
| Command | Description |
|---|---|
| `/start` | Subscribe to alerts |
| `/stop` / `/unsubscribe` | Unsubscribe |
| `/help` | Show command list (operator sees more) |
| `/analyze SYMBOL` | Full on-demand analysis — runs every check, returns the dominant-side verdict and full trade plan |
| `/find QUERY` | Look up CoinGecko slug by name or symbol |
| `/open` | List currently open signals with live unrealized P&L |
| `/recent [N]` | Last N fired signals with outcomes (default 5) |
| `/stats` / `/winrate` | Historical win-rate broken down by tier and trigger |
| `/leaders` | Current funding-rate leaders |
| `/movers` | Top 10 gainers + losers over last 24h |
| `/silence DURATION` | Mute alerts |
| `/unsilence` | Resume alerts |

### 8.4 Operator-only commands
Authentication: `msg.chat.id === TELEGRAM_CHAT_ID` from `.env`.

| Command | Description |
|---|---|
| `/watchlist` | List operator's pinned tokens |
| `/watchlist add <cgId>` | Add token at runtime; persists to `logs/user-watchlist.json` |
| `/watchlist remove <cgId>` | Remove |
| `/subscribers` / `/subs` | List all subscribers (username, chat id, silence state) |
| `/resetstats` | Archive `signals.jsonl` with timestamp suffix, start fresh win-rate counter |

### 8.5 Periodic broadcasts
- **Boot message** (operator only — not broadcast to all subscribers)
- **Funding Leaders** every 30 min (rotates through ranks 1-5 → 6-10 → 11-15 → 16-20)
- **Top-movers scan** every 30 min (also marks them as hot for the next cycle)
- **Stats summary** every 10 min (console log only)

---

## 9. Defensive engineering details

### 9.1 Stable filter
`stables.js` — explicit list of ~50 known USD/EUR-pegged stables + regex
patterns (`/^USD[A-Z0-9]{0,4}$/`, `/^EUR[A-Z]{0,3}$/`, etc.) to catch new
variants automatically. Applied at every signal entry point (`#onFlow`,
`#onSurge`, `evaluateFundingTrigger`, `evaluateTokenAndMaybeEmit`,
`evaluateForAnalysis`) and in surge detection.

### 9.2 Anti-dup
**EVM monitor** (`onchain-evm.js`):
- `pollInFlight` flag — `setInterval` skips a tick if previous poll still running
- `processedLogs` Map (10-min TTL) — cross-poll dedup of (txHash + logIndex)

**Solana monitor** (`onchain-sol.js`):
- `pollInFlight` flag
- `processedSigs` Map (1-hour TTL)
- **Startup preload**: marks last 25 sigs per wallet as "already seen" so the
  first real `#poll()` doesn't emit historical flows
- **Age filter on `#processTx`**: rejects transactions whose `blockTime`
  is > 10 minutes old (public RPC quirk-proof)

### 9.3 Price source for resolution
Outcome resolution uses **Coinalyze 1m bar high/low** (the actual exchange
perp price) instead of CoinGecko's smoothed cross-venue average. This catches
wicks that CoinGecko's polling would silently miss, and ensures SL/TP
detection matches what the user sees on Bybit/OKX/etc.

Falls back to CoinGecko for tokens without Coinalyze perp coverage.

### 9.4 Coinalyze rate-gate management
Client-side gate (default 20 calls/min, server allows 40). Pinned tokens
are mapped FIRST in `buildPerpSymbolMap` so they always get TA/funding/liq
coverage regardless of MC rank.

OHLCV requests are deduplicated by `${symbol}|${interval}` so parallel
LONG/SHORT analyses share the same fetch.

### 9.5 RPC failover
Both EVM and Solana monitors maintain RPC pools (`config/rpcs.json`) and
rotate on failure. Block-range errors trigger automatic chunk splitting.

### 9.6 Persistence
| File | Purpose |
|---|---|
| `config/tokens.json` | Static pinned watchlist (edited manually) |
| `config/cex-wallets.json` | Labeled CEX hot/cold wallets |
| `config/rpcs.json` | Public RPC endpoints + chain settings |
| `config/.universe-cache.json` | Universe build cache (7-day TTL, schema v2) |
| `logs/signals.jsonl` | Append-only signal records + outcomes |
| `logs/subscribers.json` | Subscriber list + silence state |
| `logs/user-watchlist.json` | Runtime-added pinned tokens (operator-mutated) |
| `logs/signals.YYYYMMDDTHHMMSS.jsonl` | Archives from `/resetstats` |

### 9.7 Tests
`test/sanity.js` — 49 assertions covering pure logic (stable detection,
funding scoring, OI scoring, strength tiers, funding leaders + rotation,
SubscriberStore persistence + silence, Universe favored semantics,
Conductor instantiation + recordLoss). Run with `node test/sanity.js`.

---

## 10. Configuration knobs (.env)

| Key | Default | Effect |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | required | Operator chat for boot message + admin commands |
| `COINGECKO_API_KEY` | optional | Demo-tier key, 30 calls/min, 10k/month |
| `COINALYZE_API_KEY` | optional | Required for TA / funding / liq / L/S ratio |
| `MIN_SIGNAL_SCORE` | 3.0 | Score threshold to fire as 🟢 Signal vs 👀 Observation |
| `MIN_SIGNAL_SCORE_PINNED` | 2.55 | Same, for favored tokens |
| `MIN_OBSERVATION_SCORE` | 1.0 | Below this = silent |
| `MIN_FLOW_USD` | 500000 | CEX flow trigger threshold |
| `OBSERVE_MIN_FLOW_USD` | 1000000 | Threshold for "👀 Observation" raw-flow alerts |
| `MIN_LIQUIDATION_USD` | 500000 | 1-min bucket threshold for liquidation trigger |
| `SURGE_PCT` | 3 | Surge threshold for top-MC tokens (favored use SURGE_PCT - 1) |
| `MIN_24H_VOLUME_USD` | 500000 | Volume floor (bypassed for favored) |
| `UNIVERSE_TOP_N` | 500 | Top-MC universe size |
| `UNIVERSE_VOLUME_TOP_N` | 300 | Top-volume universe addition |
| `FUNDING_POLL_INTERVAL_MS` | 3600000 | 60 min — funding+OI cycle |
| `FUNDING_TOP_N` | 250 | Number of perps polled for funding |
| `LIQUIDATION_POLL_INTERVAL_MS` | 600000 | 10 min |
| `LIQUIDATION_TOP_N` | 60 | Number of perps polled for liquidations |
| `FUNDING_LEADERS_MIN` | 30 | Minutes between funding-leaders broadcasts |
| `FUNDING_LEADERS_MIN_OI` | 10000000 | Min OI to appear in leaders ($10M) |
| `MOVERS_SCAN_MIN` | 30 | Top-movers scan interval |
| `MOVERS_TOP_N` | 10 | Gainers + losers per scan |
| `SIGNAL_COOLDOWN_MIN` | 30 | Per-token cooldown (same side) |
| `SIGNAL_RESOLVE_INTERVAL_MS` | 300000 | 5 min — outcome resolver cadence |
| `PRICE_POLL_INTERVAL_MS` | 60000 | 1 min |
| `ENABLE_ETH` / `ENABLE_BSC` / `ENABLE_SOL` | 1 | Chain toggles |
| `GOOGLE_SHEET_URL` | optional | Apps Script Web App for sheet mirroring |
| `VERBOSE` | 0 | Set to 1 for noisy diagnostic logs |

---

## 11. Quick mental model for "why did this signal fire?"

For any alert, walk through these in order:

1. **What started it?** Read "Triggered by:" — was it a surge, a flow, a
   liquidation, a funding-extreme scan, or top-movers?
2. **What's the score made of?** Each reason line shows its point contribution.
   Add them up — that's the raw score.
3. **What's the tier?** Score maps via the table in §5.9, then trade-quality
   penalties (§5.10) may downgrade it.
4. **Trade plan horizon?** Look at "Trend alignment: X/5 TFs — weighted N%".
   Higher weighted alignment = bigger horizon (SCALP < DAY < SWING < POSITION).
5. **Market or limit entry?** If "Daily trend is against" is shown → limit
   at stop-cluster zone. Otherwise market entry.
6. **SL distance?** `1.5× ATR` calm, `2.0× ATR` moderate chop, `2.5× ATR`
   very choppy.
7. **R:R?** Always 1.5 / 3.0 / 4.5 for TP1 / TP2 / TP3 (TPs are multiples of
   SL distance).
8. **Leverage?** Capped by SL%, scaled by alignment quality, halved by a
   safety multiplier.

---

## 12. What this bot does NOT do

To set expectations honestly:

- **No mock data, no backtests passed off as real.** Every number is live.
- **No execution.** It alerts; you trade.
- **No orderbook visibility.** Liquidity zones are inferred from chart
  structure (swing highs/lows + recent liquidation clusters), not from a
  real-time orderbook feed.
- **No paid CoinGlass heatmap.** The Coinalyze liquidation clusters are
  the cheap approximation of that.
- **No tick-level price.** Coinalyze 1m bars are the finest granularity.
- **No futures order-flow data.** Only funding, OI, liquidations, and L/S ratio.
- **No social sentiment.** Twitter/X, Reddit, news — none of it factored.
- **No machine learning.** All thresholds are hand-calibrated. The "Quality
  Score" (briefly added, then removed) was the closest we got and it didn't
  improve outcomes.
- **No automatic position management.** No trailing stops, no DCA, no
  partial-close automation.

Future possibilities (none committed):
- Real liquidation heatmap (paid CoinGlass)
- Bybit/OKX orderbook depth integration
- Per-signal trailing-stop tracking after TP1
- ML-based tier classification once we have ~500+ resolved signals
