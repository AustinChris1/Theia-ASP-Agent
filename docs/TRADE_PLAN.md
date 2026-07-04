# Trade Plan Math — How the Bot Builds Entry / SL / TPs / Leverage

> **⚠️ Predates the overhaul.** The structure (ATR-based SL, R-multiple TPs,
> structure snapping, horizon selection, leverage) still holds, but specifics
> changed — see **[CHANGELOG.md](CHANGELOG.md)**: **6 TFs incl. 1w** in the
> alignment vote, **validity is now target/volatility-aware** (not flat per
> horizon), TPs also **snap to orderbook walls**, the SL-cap path **compresses TP
> multiples**, leverage constants were documented + the tier-cap smoothed, a
> geometry assert was added, and the live order can **hold for TP3 with a
> trailing stop** (item E). The `#buildTradePlan` signature is now
> `(entry, side, taMetadata, heatmapWalls)`.

This document is the source-of-truth specification for **exactly how every order is constructed** once the Conductor decides to fire a signal. It mirrors the code in `src/conductor.js`:

- `#buildTradePlan(entry, side, taMetadata)` — lines ~1043–1297
- `#snapTpsToStructure({ side, entry, slDistance, rawTp1, rawTp2, rawTp3, taMetadata })` — lines ~1309–1362
- `#applyTradeQualityPenalties(strength, tradePlan, trigger, context)` — lines ~1384–1435

The numbers (multipliers, caps, weights, R-multiples, validity hours) are **literal constants** in code, not heuristics — they appear below verbatim.

---

## 1. Inputs to `#buildTradePlan`

```js
#buildTradePlan(entry, side, taMetadata)
```

| Input | Source | Used for |
|---|---|---|
| `entry` | `taService.getLastPerpPrice(symbol)` (Bybit → OKX → Coinalyze fallback). For LG setups this becomes the *market* reference; the real fill is `limitEntry`. | Anchor for SL, raw TPs, slPct, leverage |
| `side` | `'LONG'` or `'SHORT'` decided by the scoring path | Direction sign of SL / TPs / LG search |
| `taMetadata` | Returned by `taService.analyze(symbol, side)`; one entry per TF (`1min`, `5min`, `1hour`, `4hour`, `daily`) | Alignment vote, ATR, wick multiplier, swing lists for TP snap |

`taMetadata[tf]` for each TF carries:

```
{
  atr,              // ATR(14) on that TF in price units
  rsi,              // RSI(14)
  macdHist,         // MACD histogram (last bar)
  trend,            // 'up' | 'down' | (null/other)
  lastClose,
  recentWickRatio,  // sum(upperWick+lowerWick) / sum(|close-open|) over last 10 bars
  swingHigh,        // most recent fractal swing high
  swingLow,         // most recent fractal swing low
  swingHighs: [],   // full list of recent fractal highs (for TP snapping)
  swingLows:  []    // full list of recent fractal lows (for TP snapping)
}
```

`#buildTradePlan` returns `null` if `entry` or `taMetadata` is missing, or if no ATR can be resolved from any TF.

---

## 2. Multi-TF Alignment Counting

```js
const tfs = ['1min', '5min', '1hour', '4hour', 'daily'];
const TF_WEIGHTS = { '1min': 0.05, '5min': 0.10, '1hour': 0.20, '4hour': 0.30, 'daily': 0.35 };
```

(Weights sum to **1.00**.)

For each TF:

- If `side === 'LONG'` and `taMetadata[tf].trend === 'up'` → counted aligned.
- If `side === 'SHORT'` and `taMetadata[tf].trend === 'down'` → counted aligned.
- Otherwise skipped (a TF with no `trend` set does not count for or against).

```
alignmentCount     = aligned.length                    // 0..5
weightedAlignment  = Σ TF_WEIGHTS[tf]  ∀ aligned tf    // 0.00..1.00
```

Examples:
- daily-only aligned → `count=1`, `weighted=0.35`
- 1h + 4h aligned → `count=2`, `weighted=0.50`
- All five aligned → `count=5`, `weighted=1.00`
- 1m + 5m aligned → `count=2`, `weighted=0.15` (counts as "weak" — see §14)

### `dailyAgainst`

```js
dailyAgainst = (side === 'LONG'  && daily.trend === 'down') ||
               (side === 'SHORT' && daily.trend === 'up');
```

Critical higher-TF veto. When true, the trade is fighting the macro trend and is **forced into a short horizon and (if a swing extreme is reachable) a liquidity-grab limit entry**.

---

## 3. Horizon Selection

The horizon decides which TF supplies the ATR, the validity window, and indirectly the SL distance.

```text
if dailyAgainst:
    if alignmentCount ≥ 1 AND '1hour' aligned AND weighted ≥ 0.20:
        DAY     atrTf=1hour   validity=8h
    else:
        SCALP   atrTf=5min    validity=2h

elif alignmentCount ≥ 3 AND 'daily' aligned AND weighted ≥ 0.50:
    POSITION    atrTf=4hour   validity=72h

elif alignmentCount ≥ 1 AND ('4hour' OR 'daily') aligned AND weighted ≥ 0.30:
    SWING       atrTf=1hour   validity=24h

elif alignmentCount ≥ 1 AND '1hour' aligned AND weighted ≥ 0.20:
    DAY         atrTf=1hour   validity=8h

else:
    SCALP       atrTf=5min    validity=2h
```

Notes:

- POSITION **requires the daily** to agree (`'daily'` in aligned set) **and** `weighted ≥ 0.50`.
- SWING needs at least one of {4h, daily}.
- `dailyAgainst` short-circuits POSITION/SWING entirely — counter-trend cannot earn a 24h+ horizon.
- The horizon-DAY branch under `dailyAgainst` is unreachable in practice because `dailyAgainst` requires daily-trend opposite the side, but the branch still uses 1h-aligned to allow a slightly longer counter-trend window.

---

## 4. ATR Selection and Fallback Chain

1. Try `taMetadata[chosenTfForAtr].atr`.
2. If missing / non-finite / ≤ 0, iterate `['1min', '5min', '1hour', '4hour', 'daily']` and pick the **first** TF with a usable ATR.
3. If none → `#buildTradePlan` returns `null` (no plan, no signal can fire with this entry).

The `chosenTfForAtr` from §3 is preferred specifically because its time scale matches the holding horizon — a SCALP off 5m volatility, a SWING off 1h, a POSITION off 4h.

---

## 5. Wick-Aware SL Multiplier

```js
wickRatio = taMetadata[chosenTfForAtr].recentWickRatio ?? 1;

if      (wickRatio >= 3) slMultiplier = 2.5;   // very choppy (MYX/BAN-style)
else if (wickRatio >= 2) slMultiplier = 2.0;   // moderately choppy
else                     slMultiplier = 1.5;   // calm

slDistance = atr * slMultiplier;
slPct      = (slDistance / entry) * 100;
```

The point: a chart whose recent bars have huge wicks needs a wider stop to avoid being knifed out by normal noise. TPs (which are multiples of `slDistance`) widen proportionally so realised R:R stays 1.5 / 3 / 4.5.

---

## 6. `MAX_SL_PCT` Cap (12%)

```js
const MAX_SL_PCT = 12;
if (slPct > MAX_SL_PCT) {
  slDistance = entry * (MAX_SL_PCT / 100);
  slPct      = MAX_SL_PCT;
}
```

- A raw ATR × multiplier producing > 12% SL is **capped at 12%**, not rejected.
- Historical reason: BSB SHORT at 60% SL produced a TP3 below zero. Returning `null` made the signal "fire with no plan" (untrackable). Capping keeps the plan actionable; the wide stop earns a tier downgrade in `#applyTradeQualityPenalties` instead.
- After the cap, `slDistance` is recomputed in price units; SL and TPs use the capped value.

```js
sl = side === 'LONG' ? entry - slDistance : entry + slDistance;
```

---

## 7. Raw R-Multiple TPs (1.5R / 3R / 4.5R)

Before snapping:

```js
rawTp1 = LONG: entry + slDistance * 1.5   SHORT: entry - slDistance * 1.5
rawTp2 = LONG: entry + slDistance * 3.0   SHORT: entry - slDistance * 3.0
rawTp3 = LONG: entry + slDistance * 4.5   SHORT: entry - slDistance * 4.5
```

These are the **fallback** levels — used only when no swing structure lands in the per-TP tolerance bands (§8).

---

## 8. Chart-Aware TP Snapping (`#snapTpsToStructure`)

The snapper pulls each raw TP to the nearest *real* swing extreme that lies in the trade direction.

### Candidate pool

Iterates TFs in the order **`daily → 4hour → 1hour → 5min`**. For each TF:

- LONG: pulls `taMetadata[tf].swingHighs` and keeps only `price > entry`
- SHORT: pulls `taMetadata[tf].swingLows`  and keeps only `price < entry`

Each surviving candidate is `{ price, tf }`. If the pool is empty → return raw TPs with `snapped:{tp1:false, tp2:false, tp3:false}` and `sources:{tp1:null, tp2:null, tp3:null}`.

### Per-TP tolerance bands

```js
tp1Snap = pickNearest(rawTp1, minR=0.8, maxR=2.5)   // TP1: 0.8R..2.5R window
tp2Snap = pickNearest(rawTp2, minR=2.0, maxR=4.5)   // TP2: 2.0R..4.5R window
tp3Snap = pickNearest(rawTp3, minR=3.5, maxR=6.5)   // TP3: 3.5R..6.5R window
```

`pickNearest(rawTp, minR, maxR)`:

```text
minDist = slDistance * minR
maxDist = slDistance * maxR
for each candidate c:
    dist = |c.price - entry|
    if dist < minDist OR dist > maxDist: skip
    gap  = |c.price - rawTp|
    keep the candidate that minimises gap
```

Two important properties:

- A TP1 cannot be pulled out to where TP3 should sit, and vice versa.
- TFs are not weighted in the selection — the **closest gap to the raw TP** wins regardless of which TF the swing came from. The TF is recorded only as `tpSources.tpN` (`'daily'`, `'4hour'`, `'1hour'`, or `'5min'`).

### Output

```js
{
  tp1: tp1Snap?.price ?? rawTp1,
  tp2: tp2Snap?.price ?? rawTp2,
  tp3: tp3Snap?.price ?? rawTp3,
  snapped: { tp1: !!tp1Snap, tp2: !!tp2Snap, tp3: !!tp3Snap },
  sources: { tp1: tp1Snap?.tf ?? null, tp2: tp2Snap?.tf ?? null, tp3: tp3Snap?.tf ?? null }
}
```

---

## 9. Recompute of tpNPct and rrN from Snapped Values

After snapping the **alert always shows the achieved-R, not 1.5/3/4.5**. The recompute is anchored to the *real* entry (`limitEntry` for LG, `entry` otherwise):

```js
tp1Pct = |tp1 - entry| / entry * 100
tp2Pct = |tp2 - entry| / entry * 100
tp3Pct = |tp3 - entry| / entry * 100

rr1 = Number((|tp1 - entry| / slDistance).toFixed(2))
rr2 = Number((|tp2 - entry| / slDistance).toFixed(2))
rr3 = Number((|tp3 - entry| / slDistance).toFixed(2))
```

So if TP1 snapped to a swing high at exactly 1.2R, the alert reads `rr1 = 1.20`, not 1.50.

---

## 10. Liquidity-Grab Limit Entries (Counter-Trend Only)

LG is attempted **only when `dailyAgainst === true`**. Trend-following trades use market entry exclusively (no "wait for pullback" zone is computed for them).

### Target swing extreme

```js
candidates = side === 'SHORT'
  ? [taMetadata.daily?.swingHigh, taMetadata['4hour']?.swingHigh, taMetadata['1hour']?.swingHigh]
  : [taMetadata.daily?.swingLow,  taMetadata['4hour']?.swingLow,  taMetadata['1hour']?.swingLow];

valid = candidates.filter(v => isFinite(v) && v > 0);

if SHORT:
    above = valid.filter(v => v > entry)
    target = above.length ? Math.min(...above) : null      // lowest swing high ABOVE entry
if LONG:
    below = valid.filter(v => v < entry)
    target = below.length ? Math.max(...below) : null      // highest swing low BELOW entry
```

Only the *single* `swingHigh`/`swingLow` per TF (most recent fractal) is considered — not the full lists used for TP snapping.

### Buffer

```js
buffer = atr * 0.3
candidateLimit = SHORT: target + buffer
                 LONG : target - buffer
```

The limit sits 0.3 × ATR **past** the extreme (above the high for SHORT, below the low for LONG) so the order fills *inside* the typical stop-sweep wick rather than at the level itself.

### Reachability cap — `MAX_LIMIT_DIST_PCT = 7%`

```js
const MAX_LIMIT_DIST_PCT = 7;
distPct = |candidateLimit - entry| / entry * 100;

if (distPct <= MAX_LIMIT_DIST_PCT) {
    limitEntry      = candidateLimit;
    isLiquidityGrab = true;
} else {
    // BSB case: SHORT limit 68% above a falling token — unfillable in
    // the validity window. Drop LG, fall back to market entry.
}
```

If LG is dropped, the trade proceeds with the original market `entry` and the SL/TP math from §6–§8 stands.

---

## 11. SL / TP Recomputation Relative to `limitEntry` (LG only)

When the LG fires (`isLiquidityGrab && limitEntry`), the original market-anchored SL/TPs are discarded and rebuilt around `limitEntry`:

```js
grabSlDistance = slDistance                              // same wick-aware multiplier
grabSl  = LONG : limitEntry - grabSlDistance
          SHORT: limitEntry + grabSlDistance

rawGrabTp1 = LONG: limitEntry + grabSlDistance * 1.5    SHORT: limitEntry - grabSlDistance * 1.5
rawGrabTp2 = LONG: limitEntry + grabSlDistance * 3.0    SHORT: limitEntry - grabSlDistance * 3.0
rawGrabTp3 = LONG: limitEntry + grabSlDistance * 4.5    SHORT: limitEntry - grabSlDistance * 4.5

grabSnap = #snapTpsToStructure({
    side,
    entry:      limitEntry,         // ← snap is anchored to limit, not market
    slDistance: grabSlDistance,
    rawTp1: rawGrabTp1, rawTp2: rawGrabTp2, rawTp3: rawGrabTp3,
    taMetadata
});
```

The returned plan reports:

```text
entry       = original market price          (informational — alert shows it)
limitEntry  = the fillable order price        (the real fill if it triggers)
sl          = grabSl
tp1/tp2/tp3 = grabSnap.tp1/tp2/tp3
slPct       = (grabSlDistance / limitEntry) * 100         ← % from LIMIT, not market
tpNPct      = |tpN - limitEntry| / limitEntry * 100
rrN         = |tpN - limitEntry| / grabSlDistance         (rounded to 2 d.p.)
isLiquidityGrab = true
```

The SignalTracker treats `limitEntry` as the effective entry: bars are watched and the order is "filled" once a bar high/low crosses `limitEntry`. SL/TP/MFE/MAE start only after fill; on fill the price-trail high/low resets to `limitEntry`. Validity-window expiry without a fill resolves the signal as `EXPIRED_UNFILLED`.

---

## 12. Leverage Scaling

Three quantities feed leverage:

```js
rawMaxLev        = 2 / (slPct / 100);                  // 2% account risk
confidenceFactor = 0.3 + weightedAlignment * 0.7;       // 0.30..1.00
tierCap          = f(slPct)                             // (table below)
```

### `rawMaxLev` derivation

A full stop-out at slPct% loses `slPct × leverage` % of margin. Solving `slPct × lev = 2` (cap at 2% margin risk) → `lev = 2 / slPct`. With `slPct` in **%** the working form is `rawMaxLev = 2 / (slPct/100)` — units cancel correctly.

### Tier cap by `slPct` band

```
slPct < 0.5%   → tierCap = 10   (very tight SL → slippage risk amplified)
slPct < 1.0%   → tierCap = 15
slPct < 2.5%   → tierCap = 20
slPct < 5.0%   → tierCap = 10
otherwise      → tierCap =  5   (very wide SL → bigger drawdowns)
```

The table is non-monotonic on purpose — both extremes are penalised. The sweet spot (1–2.5% SL) gets the highest cap.

### `suggested` vs `maxLev`

```js
suggested = Math.max(2, Math.min(tierCap, Math.floor(rawMaxLev * confidenceFactor * 0.4)));
maxLev    = Math.max(2, Math.min(25,      Math.floor(rawMaxLev * 0.7)));
```

- `suggested` is what the alert recommends — conservative (×0.4 of raw, then tier-capped).
- `maxLev` is the ceiling — aggressive (×0.7 of raw), but globally hard-capped at **25×** regardless of how tight SL is.
- Both have a floor of **2×** (no point taking a 1× leveraged perp position).

---

## 13. Validity Hours Per Horizon

| Horizon | `validityHrs` |
|---|---|
| POSITION | 72 |
| SWING | 24 |
| DAY | 8 |
| SCALP | 2 |

`SignalTracker.resolveOpen` expires an open signal once `now - sig.ts ≥ validityHrs × 3_600_000 ms`. For LG awaiting fill, expiry without a fill → `EXPIRED_UNFILLED`; after fill, expiry resolves as `EXPIRED_PROFIT` or `EXPIRED_LOSS` based on the current P&L sign.

---

## 14. Trade-Quality Penalties (`#applyTradeQualityPenalties`)

Applied **after** the plan is built. Tier index ladder:

```
0: MIXED   1: LOW   2: MEDIUM   3: HIGH   4: VERY HIGH
```

Starting from `idxOriginal = tiers.indexOf(strength.label)` (clamped ≥ 0), the following downgrades apply in order:

1. **R:R penalty** — `rr = tp1Pct / slPct` (or 1 if slPct ≤ 0):
   - `rr < 1.0`  → `idx -= 2`
   - `rr < 1.5`  → `idx -= 1`
   - else        → no change
2. **Weak alignment + short horizon** — `weak := weightedAlignment ≤ 0.15`, `short := horizon ∈ {SCALP, DAY}`:
   - both true → `idx -= 1`
3. **Zero alignment AND daily-against** — `alignmentCount === 0 && dailyAgainst`:
   - true → `idx -= 1` (forces pure counter-trend pumps to observation-only)
4. **Sentiment-only cap** — `trigger.type === 'funding_extreme' && no recent flows && no recent liquidations`:
   - if currently `idx ≥ 3` → `idx = 3` (HIGH max, never VERY HIGH)
5. **Clamp** — `idx = clamp(0, 4)`.

### Confidence% recalculation

```js
tierDrop  = idxOriginal - idx
baseConf  = clamp(0, 100, Math.round(strength.total * 20))
confidence = clamp(5, 100, baseConf - tierDrop * 10)
```

A two-tier downgrade subtracts 20 confidence points from the score-derived base (floor 5%).

---

## Worked Example 1 — POSITION SHORT, 5/5 alignment

**Inputs:** `side = SHORT`, `entry = $2.84`, `ATR = $0.005` (on 4h), `recentWickRatio = 1.0`, all five TFs trending down.

**Alignment:**
- `aligned = ['1min', '5min', '1hour', '4hour', 'daily']`, `alignmentCount = 5`
- `weightedAlignment = 0.05 + 0.10 + 0.20 + 0.30 + 0.35 = 1.00`
- `dailyAgainst = false`

**Horizon:** `alignmentCount ≥ 3 ✓`, `'daily' in aligned ✓`, `weighted ≥ 0.50 ✓` → **POSITION**, `atrTf = '4hour'`, `validityHrs = 72`.

**SL:**
- `wickRatio = 1.0 < 2` → `slMultiplier = 1.5`
- `slDistance = 0.005 × 1.5 = 0.0075`
- `slPct = 0.0075 / 2.84 × 100 = 0.2641%` (well below `MAX_SL_PCT = 12%`)
- `sl = 2.84 + 0.0075 = $2.8475`

**Raw TPs (SHORT — subtract from entry):**
- `rawTp1 = 2.84 − 0.0075 × 1.5 = 2.84 − 0.01125 = $2.82875`
- `rawTp2 = 2.84 − 0.0075 × 3.0 = 2.84 − 0.02250 = $2.81750`
- `rawTp3 = 2.84 − 0.0075 × 4.5 = 2.84 − 0.03375 = $2.80625`

(With no swing structure provided these are the final TPs; `tpSnapped = {false, false, false}`, `tpSources = {null, null, null}`. R-multiples remain exactly 1.50 / 3.00 / 4.50.)

**Percent moves and R-multiples:**
- `tp1Pct = 0.01125 / 2.84 × 100 = 0.3961%`,  `rr1 = 1.50`
- `tp2Pct = 0.02250 / 2.84 × 100 = 0.7923%`,  `rr2 = 3.00`
- `tp3Pct = 0.03375 / 2.84 × 100 = 1.1884%`,  `rr3 = 4.50`

**Leverage:**
- `rawMaxLev = 2 / (0.2641/100) = 2 / 0.002641 ≈ 757.29`
- `confidenceFactor = 0.3 + 1.00 × 0.7 = 1.00`
- `tierCap` (slPct < 0.5) = **10**
- `suggested = max(2, min(10, floor(757.29 × 1.00 × 0.4))) = max(2, min(10, 302)) = 10`
- `maxLev    = max(2, min(25, floor(757.29 × 0.7)))            = max(2, min(25, 530)) = 25`

**Result:**

| Field | Value |
|---|---|
| `entry` | 2.84 |
| `sl` | 2.8475 (+0.26%) |
| `tp1` | 2.82875 (−0.40%, 1.50R) |
| `tp2` | 2.81750 (−0.79%, 3.00R) |
| `tp3` | 2.80625 (−1.19%, 4.50R) |
| `suggestedLeverage` | **10×** |
| `maxLeverage` | **25×** |
| `horizon` | POSITION |
| `validityHrs` | 72 |
| `isLiquidityGrab` | false |

R:R for the tier penalty: `rr = 0.3961 / 0.2641 = 1.50` → no rr penalty. `weightedAlignment = 1.00 > 0.15` → no weak-alignment penalty. Tier preserved.

---

## Worked Example 2 — SCALP counter-trend LONG, dailyAgainst, 2/5 alignment

**Inputs:** `side = LONG`, `entry = $0.169`, `ATR = $0.0001` (on 5m), `recentWickRatio < 2` (calm), aligned TFs = `['5min', '4hour']` (so 1h is *not* aligned, daily is *against*).

**Alignment:**
- `alignmentCount = 2`
- `weightedAlignment = 0.10 + 0.30 = 0.40`
- `dailyAgainst = true`

**Horizon (under `dailyAgainst`):**
- `'1hour'` is **not** in aligned → fall through to **SCALP**, `atrTf = '5min'`, `validityHrs = 2`.

**SL (anchored to market entry first, used for LG distance):**
- `slMultiplier = 1.5`
- `slDistance = 0.0001 × 1.5 = 0.00015`
- Market `slPct = 0.00015 / 0.169 × 100 = 0.0888%` (well below cap)

**Liquidity-grab limit (LONG, `dailyAgainst`):**
- Assume `taMetadata.daily.swingLow = $0.160`, `taMetadata['4hour'].swingLow = $0.165`, `taMetadata['1hour'].swingLow = $0.167`. All are below entry.
- `valid below = [0.160, 0.165, 0.167]`. LONG picks `max(valid) = $0.167` (the *highest* swing low below entry — the nearest stop-sweep zone).
- `buffer = 0.0001 × 0.3 = 0.00003`
- `candidateLimit = 0.167 − 0.00003 = $0.16697`
- `distPct = |0.16697 − 0.169| / 0.169 × 100 = 0.00203 / 0.169 × 100 = 1.20%`
- `1.20% ≤ MAX_LIMIT_DIST_PCT (7%)` → LG accepted. **`limitEntry = $0.16697`, `isLiquidityGrab = true`**.

**LG SL/TPs (LONG — add to limit for TPs, subtract for SL):**
- `grabSlDistance = 0.00015`
- `grabSl  = 0.16697 − 0.00015 = $0.16682`
- `rawGrabTp1 = 0.16697 + 0.00015 × 1.5 = $0.167195`
- `rawGrabTp2 = 0.16697 + 0.00015 × 3.0 = $0.167420`
- `rawGrabTp3 = 0.16697 + 0.00015 × 4.5 = $0.167645`

(No `swingHighs` candidates supplied above `limitEntry` → snapper returns raw values. R-multiples stay 1.50 / 3.00 / 4.50.)

**Reported percentages (anchored to `limitEntry`):**
- `slPct_LG  = 0.00015 / 0.16697 × 100 = 0.0898%`
- `tp1Pct = 0.000225 / 0.16697 × 100 = 0.1348%`,  `rr1 = 1.50`
- `tp2Pct = 0.000450 / 0.16697 × 100 = 0.2695%`,  `rr2 = 3.00`
- `tp3Pct = 0.000675 / 0.16697 × 100 = 0.4043%`,  `rr3 = 4.50`

**Leverage (using LG slPct):**
- `rawMaxLev = 2 / (0.0898/100) = 2 / 0.000898 ≈ 2227.2`
- `confidenceFactor = 0.3 + 0.40 × 0.7 = 0.58`
- `tierCap` (slPct < 0.5) = **10**
- `suggested = max(2, min(10, floor(2227.2 × 0.58 × 0.4))) = max(2, min(10, floor(516.7))) = 10`
- `maxLev    = max(2, min(25, floor(2227.2 × 0.7)))            = max(2, min(25, 1559)) = 25`

**Result:**

| Field | Value |
|---|---|
| `entry` (market, informational) | 0.169 |
| `limitEntry` (real fill) | **0.16697** |
| `sl` | 0.16682 (−0.090% from limit) |
| `tp1` | 0.167195 (+0.135%, 1.50R) |
| `tp2` | 0.167420 (+0.270%, 3.00R) |
| `tp3` | 0.167645 (+0.404%, 4.50R) |
| `suggestedLeverage` | **10×** |
| `maxLeverage` | **25×** |
| `horizon` | SCALP |
| `validityHrs` | 2 |
| `isLiquidityGrab` | true |
| `dailyAgainst` | true |

**Penalties applied after the plan:**
- `rr = tp1Pct/slPct = 0.1348/0.0898 = 1.50` → no R:R penalty.
- `weightedAlignment = 0.40 > 0.15` → no weak-alignment penalty.
- `alignmentCount = 2 ≠ 0` → no zero-alignment penalty.
- Not a sentiment-only `funding_extreme` trigger → no cap.

Tier preserved. Confidence% comes from `strength.total × 20` with no `tierDrop` adjustment.

---

## Quick Reference Table of Constants

| Constant | Value | Where |
|---|---|---|
| `TF_WEIGHTS` | 1m:0.05, 5m:0.10, 1h:0.20, 4h:0.30, d:0.35 | §2 |
| POSITION threshold | count ≥ 3 ∧ daily aligned ∧ weighted ≥ 0.50 | §3 |
| SWING threshold | count ≥ 1 ∧ (4h ∨ daily) ∧ weighted ≥ 0.30 | §3 |
| DAY threshold | count ≥ 1 ∧ 1h aligned ∧ weighted ≥ 0.20 | §3 |
| SCALP | fallback (also under `dailyAgainst` w/o 1h) | §3 |
| Wick multipliers | 1.5× / 2.0× / 2.5× at ratios ≥0, ≥2, ≥3 | §5 |
| `MAX_SL_PCT` | 12% | §6 |
| Raw TP R-multiples | 1.5R / 3.0R / 4.5R | §7 |
| TP1 snap band | [0.8R, 2.5R] | §8 |
| TP2 snap band | [2.0R, 4.5R] | §8 |
| TP3 snap band | [3.5R, 6.5R] | §8 |
| LG buffer | `atr × 0.3` past extreme | §10 |
| `MAX_LIMIT_DIST_PCT` | 7% | §10 |
| `rawMaxLev` | `2 / (slPct/100)` | §12 |
| `confidenceFactor` | `0.3 + weighted × 0.7` | §12 |
| Tier caps (by slPct) | 10 / 15 / 20 / 10 / 5 | §12 |
| `suggested` multiplier | × 0.4 of raw | §12 |
| `maxLev` multiplier / global cap | × 0.7 of raw, hard cap 25× | §12 |
| Validity hours | 72 / 24 / 8 / 2 | §13 |
| R:R penalty | rr<1.0 → −2 tiers, rr<1.5 → −1 | §14 |
| Weak alignment threshold | weighted ≤ 0.15 | §14 |
| Sentiment-only cap | HIGH max (idx 3) | §14 |
