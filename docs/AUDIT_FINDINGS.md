# AUDIT FINDINGS — Actionable Roadmap to Win Rate > 50%

> **Historical record.** These findings were resolved in
> [AUDIT_RESOLUTION.md](AUDIT_RESOLUTION.md) (2026-05-30); current behaviour is in
> [CHANGELOG.md](CHANGELOG.md). Line numbers below predate the overhaul. Kept as a
> reference for how to run a similar audit.

**Audit date:** 2026-05-30
**Current win rates from `/tunestats`:**
- LONG side: 41% (losing edge)
- SHORT side: 55% (positive edge)
- teamFlow tag: 33% (N=3, noise)
- flow trigger: 42%
- supplyPct factor: 31%
- wick factor: 38%
- confirmation gate: 41% (it is *vetoing winners*)
- liquidation trigger: 58% (clear edge)
- movers trigger: 54% (solid)

---

## 1. Executive Summary — Top 5 Issues Most Likely To Move Win Rate

These are the highest-leverage fixes. Implement these first; everything else is secondary.

| # | Finding | File:Line | Why it dominates |
|---|---|---|---|
| 1 | **Orderbook cluster magnet direction INVERTED** | `conductor.js:509` | Up to +0.8 score is being added in the WRONG direction across all sizes. Pushes the engine into LONG when ask resistance argues against it (and vice versa). Directly degrades LONG win rate (currently 41%). |
| 2 | **Scan path skips `#applyTradeQualityPenalties`** | `conductor.js:361` | Movers-scan signals (54% trigger, large slice of volume) reach autotrade at full confidence with NO R:R demotion, NO weak-alignment demotion, NO sentiment-only cap. Bad-R:R scalps fire as HIGH. |
| 3 | **SL-priority in same-bar resolver** | `signal-tracker.js:277` | Resolver labels any bar that touches BOTH SL and TP as LOSS. Systematically understates win rate — measured 41-55% is actually higher. Mis-calibrates every downstream tuning decision based on `/stats`. |
| 4 | **Live-mode close detection wrong** | `auto-trader.js:281` | Reads "TP vs SL" by comparing the CURRENT poll price to TP. A TP-fill followed by retrace below TP gets recorded as SL with negative P&L. Stats and balance tracker corrupted on live mode. |
| 5 | **Confirmation gate over-aggressive RSI tally + threshold** | `ta-confirm.js:81, 179` | RSI exactly at 50 deducts on every TF → −1.0 tally → DROP. dropThreshold=−1.0 is reached with ONE TF disagreement. Confirmation 41% is the bottom trigger — fix this and it should flip well above 50%. |

Fixing items 1–5 alone should move the system from net-losing on LONG / borderline on SHORT into a clear positive-expectancy engine.

---

## 2. Critical Bugs

### 2.1 Orderbook cluster magnet inverted
- **File:** `src/conductor.js:509`
- **Code:**
  ```js
  candidates = side === 'LONG' ? lc.askClusters : lc.bidClusters
  ```
- **Root cause:** A heavy ask wall ABOVE current price is supply/resistance. The code treats it as a magnet that *helps* LONG with up to +0.8 score.
- **Fix:** Flip the mapping — `LONG → lc.bidClusters` (support fuelling rallies), `SHORT → lc.askClusters` (resistance shorts can lean on). If the intent is genuinely "magnet at unfilled-liquidity wall", invert the sign so trading INTO a wall is a *penalty*.

### 2.2 Authoritative duplicate guard is non-atomic (race condition)
- **File:** `src/signal-tracker.js:113`
- **Code:** Comment says it is the authoritative duplicate guard, but `hasOpenSignal()` reads disk then `appendFileSync` appends — not atomic.
- **Root cause:** `#onFlow` (sync), `#onSurge` (async), `#onLiquidation` (sync) can all see an empty open-set for the same symbol simultaneously and all append. Produces the EDEN-x4 duplicate described in the comment that the guard is supposed to prevent.
- **Fix:** Maintain an in-memory `Set<symbol|side>` of currently-open signals, checked & mutated SYNCHRONOUSLY before any `appendFileSync`. Sync from disk on boot.

### 2.3 SL-priority resolver mis-labels winners as losses
- **File:** `src/signal-tracker.js:277`
- **Code:** When LONG `trail.low ≤ sl AND trail.high ≥ tp1`, code returns LOSS unconditionally.
- **Root cause:** Aggregating max(high) and min(low) across many 1m bars loses ordering. A bar series that hit TP1 at minute #2 and SL at minute #4 is labelled LOSS.
- **Fix:** Iterate bars CHRONOLOGICALLY; for each bar in order, check SL then TPs and emit the FIRST level touched. Optionally fetch 15s bars to disambiguate same-bar wicks; otherwise mark `AMBIGUOUS` and exclude from win-rate denominator.

### 2.4 Live-mode close detection mis-labels TP fills as SL
- **File:** `src/autotrade/auto-trader.js:281`
- **Code:**
  ```js
  const reason = (dir > 0 ? px >= t.tp : px <= t.tp) ? 'TP' : 'SL';
  pnlUsd = (px - t.entry) * dir * t.qty;
  ```
- **Root cause:** Server-side TP fill happens at TP level; price often retraces by the next 30s poll. Bot then sees `px < tp`, labels SL, computes negative P&L on a winning trade. Daily-loss tracker is corrupted.
- **Fix:** Query Bybit `/v5/position/closed-pnl` after detecting a position disappeared. Use its `avgExitPrice` + `closedPnl` as the authoritative resolution.

### 2.5 Risk-engine cap binds → real risk far below intended
- **File:** `src/autotrade/risk-engine.js:102`
- **Root cause:** `notionalUsd = riskAmount / slFraction` then capped at `maxPositionUsd`. For small accounts the cap binds and effective per-trade risk is a fraction of the configured `riskPct`. Comment "a full SL loses this % of the account" is FALSE.
- **Fix:** Surface effective risk in the `sizing` return object; document explicitly that `maxPositionUsd` dominates `riskPct` at small balances. (No win-rate effect, but operator-trust effect.)

---

## 3. Accuracy Issues (severity high|critical, category=accuracy)

These do not crash but they bias scoring/sizing. Each cross-referenced to `/tunestats` data where relevant.

### 3.1 Liquidation cluster buckets drift with price
- **File:** `conductor.js:1505`
- **Issue:** `distPct = (ev.price - currentPrice) / currentPrice * 100;` — clusters re-bucket every tick.
- **Fix:** Bucket by absolute price (round `ev.price` to a 0.5%-of-`ev.price` grid). Compute `distancePct` from `currentPrice` only at read time.
- **/tunestats note:** Liquidation trigger is 58% — already a positive edge. This fix should *raise* it further; pair with bumping base score from +1.5 to +2.0 (see §6).

### 3.2 Scan-path skips trade-quality penalties
- **File:** `conductor.js:361` (`evaluateTokenAndMaybeEmit`)
- **Issue:** `#applyTradeQualityPenalties` is only invoked in `#evaluateAndMaybeEmit`. Movers-scan signals (54% trigger) never get R:R<1.5 demotion, weak-alignment demotion, daily-against demotion, or sentiment-only HIGH cap. Scalps with R:R 0.6 fire as HIGH/VERY HIGH.
- **Fix:** After building the trade plan in `evaluateForAnalysis`/`evaluateTokenAndMaybeEmit`, call `#applyTradeQualityPenalties(...)` with the real trigger object. Persist the demoted tier into the analysis before emit.
- **/tunestats note:** Movers trigger is 54%; this fix prevents the false-confidence subset that drags it down.

### 3.3 RSI bands asymmetric in ta.js → side bias toward SHORT
- **File:** `ta.js:408`
- **Issue:** LONG warning at rsi>75, SHORT support at rsi>70. RSI in [70, 75] adds +w to SHORT but nothing to LONG. Dead zone [30, 75] for LONG; [25, 70] for SHORT.
- **Fix:** Use symmetric breakpoints. Recommend LONG support `rsi<30`, LONG warning `rsi>70`, SHORT support `rsi>70`, SHORT warning `rsi<30`.
- **/tunestats note:** Directly explains the LONG=41% / SHORT=55% asymmetry. This is one of the cheapest, highest-impact fixes.

### 3.4 Confirmation gate RSI tally + drop threshold over-aggressive
- **File:** `ta-confirm.js:81, 179`
- **Issue:** RSI==50 deducts w*0.5 in `else` branch. dropThreshold=−1.0 is reached with one TF disagreement. Combined → real setups in transition silently DROPPED.
- **Fix:** Use a 50±5 neutral zone (no points either way). Loosen dropThreshold to −2.5 or −3.0. Normalize tally by total TF weight × indicator count.
- **/tunestats note:** Confirmation gate is at 41% — meaning when it DOESN'T drop, it still emits losers. But it is also *vetoing winners*. This is the single biggest leverage point on the gating layer.

### 3.5 BB pctB inversion — penalizing textbook entries
- **File:** `ta-confirm.js:109`
- **Issue:** SHORT at pctB>0.95 (near upper band) deducts w. That is the textbook mean-reversion short. LONG at pctB<0.05 likewise penalized.
- **Fix:** Invert the sign at the bands, OR remove the band penalty entirely if the philosophy is purely trend-following (then document that).

### 3.6 Supply % LONG-only — asymmetric scoring
- **File:** `conductor.js:980`
- **Issue:** Cold-inflow → LONG bonus exists. Cold-outflow → SHORT bonus does NOT. SHORT signals are systematically under-credited.
- **/tunestats note:** supplyPct at 31% — currently the WORST factor. Two possibilities: (a) the LONG-only logic itself is bad signal, or (b) it works for SHORTs but is never applied. Recommend BOTH mirror logic to SHORT side AND DOWNWEIGHT the LONG variant (or remove until proven on hold-out data). See §6 tuning.

### 3.7 Wick analysis fires on incomplete bars
- **File:** `ta.js:481`
- **Issue:** Uses `history[history.length - 1]` — the still-forming bar. Tiny body → ratio explodes → spurious "strong wick" finding.
- **Fix:** Require `body > 0.1% of close`. Compare wick to ATR, not body.
- **/tunestats note:** wick factor at 38%. Either this finding or the asymmetric on-bar problem (or both) is responsible.

### 3.8 Funding-velocity threshold mixes timescales
- **File:** `conductor.js:871`
- **Issue:** `velocity1h` (hourly delta) and `summary.delta` (poll-to-poll, 5m or 1h) compared under the same NEUTRAL=0.0003 / STRONG=0.001 threshold.
- **Fix:** Normalize both to a per-hour or per-8h frame BEFORE threshold. Prefer `velocity4h` (it's more robust); document the unit.

### 3.9 OI alignment direction defaulted from side
- **File:** `conductor.js:783`
- **Issue:** When there's no recent surge, surgeDir defaults to side → OI uptick on a SHORT signal always counts as "fresh shorts", even when price is pumping.
- **Fix:** Only score OI alignment when a real recent price direction exists (surge in last N minutes OR 1h candle trend). Skip when surgeDir comes from `side` alone.

### 3.10 L/S ratio: tiny crossover gets full credit
- **File:** `ta.js:343`
- **Fix:** Scale points by distance past the threshold, e.g. `min(1.0, (ratio − 1.7) / 2) * 0.4`.

### 3.11 Candlestick patterns on incomplete bars
- **File:** `ta-confirm.js:140`
- **Fix:** Use `patternTf.slice(-4, -1)` (last 3 CLOSED bars), or check timestamp is fully in the past.

### 3.12 Liquidity-grab swing detection includes forming bar
- **File:** `ta.js:506`
- **Fix:** Exclude still-forming bar: `history.slice(-window, -1)`.

### 3.13 Volume ratio on partial bar
- **File:** `ta.js:263`
- **Issue:** Compares partial in-progress 1m bar against full bars → ratio < 1.5 → surge silently suppressed at the top of each minute.
- **Fix:** Use `volumes[length-2]` (last CLOSED bar) vs `volumes.slice(0, -2)` mean. Or detect partial bars via timestamp.

### 3.14 Team-flow base score asymmetric & possibly under-weighted
- **File:** `conductor.js:706`
- **Fix:** Either bypass both buy and sell sides symmetrically OR document team-buys as +0.3-nudge only.
- **/tunestats note:** teamFlow at 33% but N=3 only — too small to act on alone. Keep monitoring.

### 3.15 Funding "mild positive = LONG support" gives free points
- **File:** `funding.js:351`
- **Fix:** Drop the +0.5 bonus for mild-positive→LONG (and mild-negative→SHORT) to 0 or +0.2. Reserve +0.5 for genuine short-squeeze setups (avg ≤ −NEUTRAL_BAND for LONG).

### 3.16 Suggested leverage `* 0.4` factor unjustified
- **File:** `conductor.js:1161`
- **Fix:** Either remove `* 0.4` (riskPct already controls risk) or document what it represents. Verify `suggested * slPct ≈ riskPct`.

### 3.17 maxLev uses 0.7 vs suggested 0.4, hardcodes risk=2%
- **File:** `conductor.js:1162`
- **Fix:** Pull from `this.riskPct`. Apply same tierCap as suggested.

### 3.18 Tier-cap leverage curve has 2.5%→2.6% discontinuity
- **File:** `conductor.js:1157`
- **Fix:** Smooth or use a monotonic mapping. 2.5–5% SL is a NORMAL swing horizon and shouldn't be punished.

### 3.19 R:R measured on TP1 only — penalizes good structural snaps
- **File:** `conductor.js:1395`
- **Fix:** Use `max(rr1, rr2 * 0.5, rr3 * 0.33)` or measure against TP2 (the autotrader default exit).

### 3.20 Confidence number diverges from tier label
- **File:** `conductor.js:1427`
- **Fix:** Anchor confidence to final tier (LOW=20, MEDIUM=50, HIGH=80, VERY HIGH=95) OR raise tier-drop deduction to 20 per tier.

### 3.21 Paper broker SL/TP via spot-tick only
- **File:** `paper-broker.js:76, 82`
- **Issue:** Misses wicks between polls → systematically over-reports paper P&L vs live.
- **Fix:** Consume same 1m OHLCV bars as SignalTracker. Alternatively prominently document the divergence.

### 3.22 Paper limit order = market order
- **File:** `paper-broker.js:46`
- **Fix:** Implement a pending-limit queue resolved in `resolveTouches`. Liquidity-grab signals are most affected — their paper stats are over-rosy.

### 3.23 Live-resolver autotrader uses local price as exit
- **File:** `auto-trader.js:282` — covered in §2.4.

### 3.24 SL-fill slippage assumed zero in signal-tracker
- **File:** `signal-tracker.js:297`
- **Fix:** For LOSS, use `min(bar.l, sig.sl)` (LONG) or `max(bar.h, sig.sl)` (SHORT). Or apply a 0.2% slippage haircut.

### 3.25 TF weight mismatch between ta.js and conductor trade plan
- **File:** `conductor.js:1050`
- **Fix:** Single canonical weight vector imported from a shared constant. Re-verify all thresholds (0.15, 0.20, 0.30, 0.50).

### 3.26 alignmentCount-based filter biased toward 1m+5m noise
- **File:** `auto-trader.js:144`
- **Fix:** Use `plan.weightedAlignment >= this.minAlignmentWeight`. Lets daily-only setups through with count=1.

---

## 4. Dead Code / Unimplemented

### Remove (no value, vestigial)
| File:Line | Item | Action |
|---|---|---|
| `funding.js:536` | `signalStrength()` — only used by tests, tiers no longer match | **Remove** export; re-base test on Conductor `#strengthLabel` |
| `prices.js:30,31` | `getVolume`, `getChange24h` accessors | **Remove** |
| `telegram.js:25,33` | `fundingIntervalHrs` field, `setSubscribers()` | **Remove** |
| `universe.js:36` | `isHotMover` | **Remove** |
| `coinalyze.js:71` | `exchanges()` | **Remove** |
| `signal-tracker.js:34` | `defaultValidityMs` unused | **Remove** OR wire as fallback |
| `signal-tracker.js:121` | Empty `if (this.priceMonitor)` block | **Remove** |
| `team-wallet-discovery.js:186` | `lookupAddress` not externally called | **Remove** OR route EvmMonitor through it |
| `conductor.js:573` | Outer-scope `let confirmation` | **Remove** outer `let`, declare inside block |
| `ta-confirm.js:43` | Unused `dropThreshold` parameter | **Either** wire to env OR drop param |
| `funding.js:285` | `velocity4h` computed but never read | **Implement** consumption in conductor OR remove |
| `stables.js:9` | `KNOWN_STABLES` export only consumed by test | **Remove** export |
| `telegram.js:3` | `EXPLORER_TX` duplicated with index.js | **Centralize** in src/explorers.js |
| `team-wallet-discovery.js:287` | `MIN_PERCENT_KEEP=0` dead branch | **Either** remove OR raise to 0.01 |

### Implement (these matter for win rate / system completeness)
| File:Line | Item | Action |
|---|---|---|
| `auto-trader.js:48` | `getPrice` constructor arg ignored | **Implement** as fallback when `_priceBySymbol` not set, OR remove arg |
| `binance-futures.js:119` | Velocity not computed → primary funding path has no rolling velocity | **Implement** using Binance `/fapi/v1/fundingRate` history |
| `team-wallet-discovery.js:211` | Solana team-wallet discovery | **Document as deferred** for now; tag README/help that team-flow is EVM-only |
| `exchange-bybit.js:297` | `closePosition` documented but no caller | **Implement** `/autotrade close <symbol>` operator command |

### Deferred (document)
| File:Line | Item |
|---|---|
| `onchain-sol.js:215` | Solana flows lack team-flow tagging — note in docs as known limitation |

---

## 5. Edge Cases (grouped)

### Critical — affect correctness or trading behavior
- **`conductor.js:1394`** — R:R based on tp1 punishes good structural snaps (also in §3.19).
- **`conductor.js:1409`** — `dailyAgainst` penalty stacks on already-defensive plan; missing daily metadata evades the penalty entirely. *Fix:* treat missing daily as soft penalty (idx -= 0.5).
- **`conductor.js:1418`** — Tier idx can drop to -4 before clamp; confidence becomes nonsense. *Fix:* early-return when raw is MIXED.
- **`conductor.js:1133`** — At MAX_SL_PCT cap, TP3 lands 54% from entry — unreachable in validity window. *Fix:* cap TP multiples when slPct is capped.
- **`signal-tracker.js:179`** — `fromTs` can be 6h before signal creation on restart; pre-signal wicks falsely register as SL/TP hits. *Fix:* `fromTs = max(sig.ts, lastChecked) - 60_000`.
- **`risk-engine.js:96`** — No margin-buffer check; with leverage*notional > balance*0.9 order will be rejected by exchange. *Fix:* explicit balance margin check.

### Hygiene — should be cleaned up but lower urgency
- **`prices.js:51`** — `getTopMovers` slice overlap when pool small.
- **`conductor.js:158`** — null-price flow bypasses min-USD gate.
- **`conductor.js:632`** — no defensive assert that tp1 is on correct side of entry.
- **`onchain-sol.js:39, 174, 215`** — duplicate-address overwrite warning; dual dedup mechanism documentation.
- **`paper-broker.js:46, 56`** — limit-order modeling; leverage not persisted on paper position record.

---

## 6. Tuning Recommendations from `/tunestats`

These are NOT audit findings — they come from observed win-rate data. Make these tuning changes IN PARALLEL with the bug fixes in §2 and §3.

### 6.1 LONG side underperforming (41%) — short-term mitigation
- **Action:** Set `AUTOTRADE_SHORT_ONLY=1` as a temporary measure UNTIL the RSI asymmetry (§3.3), supplyPct (§3.6), and orderbook cluster (§2.1) fixes ship and prove out.
- **OR** down-weight LONG-side scoring by ~15% globally in `#evaluate` until parity is restored.

### 6.2 teamFlow at 33% — likely small-N noise
- **Action:** Keep tracking. Do NOT change weights yet (N=3). Revisit at N≥20.

### 6.3 supplyPct (31%) — worst factor — REMOVE or downweight
- **Action:** Halve the supplyPct point values immediately (LONG +0.75 / +0.5 / +0.25 instead of +1.5 / +1.0 / +0.5). After confirming §3.6 (add SHORT mirror), re-evaluate on hold-out data over 2 weeks.

### 6.4 wick (38%) — REMOVE or downweight
- **Action:** Halve all wick-derived points in `#computeForTimeframe` until the incomplete-bar fix (§3.7) ships. Then re-measure.

### 6.5 confirmation gate (41%) — investigate before changing weights
- **Action:** Loosen `dropThreshold` from −1.0 to −2.5 (§3.4). Fix the RSI==50 deduction (§3.4) and BB inversion (§3.5). Then re-measure — expect this trigger to flip well above 50% with no other change.

### 6.6 Liquidation trigger (58%) — clear edge — RAISE base
- **Action:** Raise base score from +1.5 to +2.0 in `#evaluate` liquidation branch. Pair with §3.1 (anchor clusters to price).

### 6.7 movers trigger (54%) — solid, no change
- **Action:** Leave as-is, but ship §3.2 (apply trade-quality penalties on scan path) — the underlying signal is good; we are leaking quality through the un-penalized path.

### 6.8 flow trigger (42%) — WORST trigger — raise threshold
- **Action:** Raise `MIN_FLOW_USD` from $500k to $1M (and proportionally `effectiveMinFlow` for favored = $250k). Down-weight the `baseFlow` curve by 0.5 across the board (2.5M tier → 2.0, 5M → 2.5, 10M → 3.0). Re-measure after 2 weeks.

---

## 7. Prioritized Roadmap (4–6 next actions, impact ÷ effort)

Order: highest impact-per-hour FIRST.

### Action 1 — Flip orderbook cluster direction (10 min, huge impact)
- File: `conductor.js:509`
- Change one line. Fixes §2.1.
- **Expected:** Removes +0.3 to +0.8 of mis-aligned score across every event-driven LONG/SHORT signal.

### Action 2 — Confirmation gate: fix RSI==50 + loosen threshold (30 min, huge impact)
- Files: `ta-confirm.js:81, 109, 179`
- Add RSI 50±5 neutral zone; loosen `dropThreshold` to −2.5; invert BB band penalty.
- **Expected:** confirmation 41% → >50%; recovers winners currently being vetoed.

### Action 3 — Apply trade-quality penalties on the scan path (45 min, high impact)
- File: `conductor.js:361`
- Call `#applyTradeQualityPenalties` inside `evaluateTokenAndMaybeEmit`. Fixes §3.2.
- **Expected:** Stops scan signals reaching autotrader at false-HIGH confidence.

### Action 4 — Fix SL-priority resolver (1–2 hours, high impact on STATS accuracy)
- File: `signal-tracker.js:277`
- Iterate bars chronologically; emit first level touched.
- **Expected:** Reveals the TRUE win-rate (almost certainly higher than current measurement). Without this, every tuning step is calibrated on biased data.

### Action 5 — RSI symmetric breakpoints + halve wick + halve supplyPct (1 hour, medium-high impact)
- Files: `ta.js:408, 481`, `conductor.js:980`
- Fix asymmetric thresholds; halve weights on the two factors with <40% hit rate.
- **Expected:** LONG side gap closes. wick/supplyPct factor numbers either rise or become tunable.

### Action 6 — Live-mode close detection via Bybit closed-PnL endpoint (2–3 hours, critical for live autotrade)
- File: `auto-trader.js:281`
- Query `/v5/position/closed-pnl`; trust exchange-reported avgExitPrice + closedPnl.
- **Expected:** Live-mode P&L and daily-loss tracker become trustworthy. Without this, the live autotrader cannot be relied on for risk management.

### Stretch — Atomic in-memory open-signal set (1 hour, reliability)
- File: `signal-tracker.js:113`
- Sync `Set<symbol|side>` for the duplicate guard.
- **Expected:** Eliminates the EDEN-x4 class of duplicate bugs once and for all.

---

## Appendix: Severity & Category Tally

- **Critical (severity):** §2.1, §2.2, §2.3, §3.21 (paper P&L over-reports)
- **High:** ~25 findings across scoring, sizing, resolution
- **Medium / Low / Dead-code:** ~50 findings — see §4 and §5

The fastest path to >50% win rate is **§7 actions 1+2+3 shipped together**, followed by **action 4** to make all subsequent measurements reliable. Estimate: one focused day of work for the top 4; another half-day for tuning items in §6.
