# AUDIT RESOLUTION — Accuracy Overhaul

**Date:** 2026-05-30
**Scope:** Every finding in [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md), plus the
1-week timeframe and Binance-via-Singapore-relay features. Goal: **accurate
signals.**

All changes are covered by `node test/sanity.js` (62 passing) and every changed
file passes `node --check`.

---

## New / changed env vars

| Var | Default | Meaning |
|---|---|---|
| `MIN_FLOW_USD` | **1_000_000** (was 500k) | Flow trigger min-USD — flow is the worst trigger (§6.8). Favored tokens fire at 0.25×. |
| `TA_CONFIRM_DROP_THRESHOLD` | `-2.5` (was −1.0) | Confirmation-gate veto threshold (§3.4/§6.5). |
| `LEV_RISK_BASIS` | `2` | Advisory-leverage risk basis (§3.16/§3.17). Leverage numbers unchanged at default. |
| `AUTOTRADE_MIN_ALIGNMENT_WEIGHT` | `0` (off) | Gate autotrades on `weightedAlignment` instead of raw count (§3.26). |
| `RELAY_BASE_URL` | falls back to `BYBIT_BASE_URL` | Singapore relay base used to reach Binance data when geo-blocked. Auth via `BYBIT_PROXY_SECRET`. |

**New commands:** `/heatmap <SYM>` (order-book liquidity walls) · `/autotrade close <SYM>` (manual reduce-only close).
**New files:** `src/timeframes.js` (canonical TF vectors + weekly aggregation) · `src/explorers.js` (centralized tx links).

---

## §2 Critical bugs — ALL FIXED

| # | Fix | File |
|---|---|---|
| 2.1 | Orderbook walls now modelled as **support/resistance, not magnets** (web-research-confirmed). Wall behind the trade = small bonus; wall in its path = penalty. Reverses the inverted LONG-degrading signal. | `conductor.js` |
| 2.2 | Authoritative **in-memory open-signal `Set`** (`openKeys`), checked+mutated synchronously before append; seeded from disk on boot; cleared on every resolution. Kills the EDEN-×4 duplicate class. | `signal-tracker.js` |
| 2.3 | Resolver now walks bars **chronologically** and emits the FIRST level touched (TP-then-SL → WIN, not LOSS). Same-bar SL+TP → `AMBIGUOUS`, excluded from win-rate. | `signal-tracker.js` |
| 2.4 | Live closes resolved from Bybit **`/v5/position/closed-pnl`** (authoritative `avgExitPrice` + `closedPnl`), with nearest-level TP/SL classification. No more TP-retrace-mislabelled-as-SL. | `auto-trader.js`, `exchange-bybit.js` |
| 2.5 | `sizePosition` returns **`effectiveRiskPct`** + `capBound`; header comment corrected (maxPositionUsd dominates riskPct on small accounts). | `risk-engine.js` |

## §3 Accuracy — ALL FIXED

| # | Fix |
|---|---|
| 3.1 | Liq clusters bucketed by **absolute price** (log-space, stable across ticks); base bumped to +2.0 (§6.6). |
| 3.2 | **Scan/analysis path now applies `#applyTradeQualityPenalties`** — movers signals can no longer fire HIGH with bad R:R. |
| 3.3 | RSI breakpoints **symmetric at 30/70** both sides (was 30/75 vs 70/25). |
| 3.4 | Confirmation RSI **50±5 neutral band**; `dropThreshold` −1.0 → −2.5 (env-tunable). |
| 3.5 | BB band touches **rewarded** (textbook mean-reversion), not penalized. |
| 3.6 | supplyPct **mirrored to SHORT** (bearish CEX supply flow) and **halved** (§6.3). |
| 3.7 | Wick analysis uses **last CLOSED bar**, requires body > 0.1% close, gated on ≥½ ATR, points **halved** (§6.4). |
| 3.8 | Funding velocity **normalized to per-hour**; prefers `velocity4h`. |
| 3.9 | OI alignment scored **only with a real price direction** (surge / 1h trend), never defaulted from side. |
| 3.10 | L/S ratio credit **scaled by distance past threshold**. |
| 3.11 | Candlestick patterns on **last 3 CLOSED bars**. |
| 3.12 | Liquidity-grab detection **excludes the forming bar**. |
| 3.13 | Volume ratio uses the **last CLOSED 1m bar** (no more top-of-minute suppression). |
| 3.14 | Team-flow base already asymmetric (+0.8 sell / +0.3 buy) — documented. |
| 3.15 | Mild same-direction funding bonus +0.5 → **+0.2**; full +0.5 reserved for genuine squeezes. |
| 3.16–3.18 | Leverage: single documented risk basis, named damp, **maxLev tier-capped**, **2.5–5% SL cliff smoothed**. |
| 3.19 | R:R = **best of TP1, ½·TP2, ⅓·TP3** (good structural snaps no longer punished). |
| 3.20 | Confidence% **anchored to the final tier** (can't contradict the label). |
| 3.21/3.22 | Paper broker divergence (spot-tick SL/TP, limit=market) **prominently documented**. |
| 3.24 | LOSS exits take a **0.1% slippage haircut**. |
| 3.25 | Single **canonical TF weight vector** in `timeframes.js` (shared by ta / ta-confirm / conductor). |
| 3.26 | Autotrade alignment gate uses **`weightedAlignment`** (lets daily/weekly-only setups through). |

## §5 Edge cases — FIXED
Missing-daily soft ½-tier penalty · MIXED early-return · capped-SL TP compression · `fromTs` clamped to signal creation · risk-engine margin buffer · null-price flow gated · TP/SL geometry assert · getTopMovers overlap.

## §4 Dead code
**Removed:** `prices.getVolume/getChange24h`, `coinalyze.exchanges()`, `telegram.setSubscribers()`, empty `priceMonitor` block, outer `let confirmation`. **Wired:** `defaultValidityMs` fallback, `velocity4h` consumption, `ta-confirm dropThreshold`, `exchange.closePosition` → `/autotrade close`. **Centralized:** `EXPLORER_TX` → `explorers.js`. **Kept (test deps):** `signalStrength`, `KNOWN_STABLES`, `isHotMover`. **Implemented:** Binance funding velocity.

---

## New features

### 1-week timeframe (now 1m · 5m · 1h · 4h · 1d · **1w**)
Weekly is **aggregated from daily bars** (`aggregateWeekly`) — no provider needs
a native weekly feed. It participates in trend alignment (heaviest weight with
daily), gates the longest holds (a **POSITION extends to 120h when weekly
aligns**), blocks multi-day holds against the weekly macro, and contributes TP
swing levels. Displayed as `X/6 TFs` and in `/analyze`.

### Binance data via the Singapore relay
The Vercel relay now routes **both** Bybit (`/relay/...`) **and** Binance
(`/relay/binance/...`). When this VPS is geo-blocked, the bot reaches Binance
through Singapore for: **funding + OI** (Binance becomes the primary funding
source with real velocity) and the **deep 1000-level order-book heatmap**
(best free heatmap source → preferred when the relay is configured). `probe()`
tries direct first, then the relay.

### Deferred (documented, not regressions)
- **Solana team-flow** tagging — EVM-only; `SolanaMonitor` intentionally has no `teamDiscovery` (Solana top-holder discovery unimplemented).
- **Real-time liquidation WebSocket heatmap** — Binance `!forceOrder@arr` needs a persistent socket from a non-geo-blocked host; a serverless relay can't hold one. The order-book-derived heatmap + Coinalyze liquidation clusters cover the same need today.
