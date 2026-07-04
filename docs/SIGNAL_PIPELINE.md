# How a Signal Is Born

> **⚠️ Predates the overhaul.** The pipeline *shape* below is still accurate, but
> the `file:line` citations have shifted and several scoring components changed
> or were added. Read **[CHANGELOG.md](CHANGELOG.md)** for the deltas:
> 6 timeframes (added 1w), the orderbook-heatmap score now runs in **all** paths
> (dominance-based), a **BTC market-regime** penalty, normalised Binance funding,
> the audit fixes (RSI symmetry, supplyPct SHORT mirror, OI gating, inverted-wall
> fix, scan-path penalties, …), tier-anchored confidence, and a target-aware
> validity. The fix-by-fix audit map is in [AUDIT_RESOLUTION.md](AUDIT_RESOLUTION.md).

This is the canonical "what the bot actually does between a market event and a Telegram alert" document.
Every claim has a `file:line` citation and every score component shows the literal formula from source.

The two protagonists:

- **Conductor** (`src/conductor.js`) — multi-trigger scoring engine + trade-plan builder + emit gate.
- **SignalTracker** (`src/signal-tracker.js`) — JSONL persistence + wick-aware outcome resolver + feedback loop into Conductor.

---

## 1. The 5 entry points into the pipeline

Every signal ultimately routes through `#evaluateAndMaybeEmit` (`src/conductor.js:436`). There are four event-driven trigger sources plus two scan/manual paths that build their own trigger object.

### 1a. `flow` (on-chain CEX wallet transfers)

Wired in `Conductor.start()` (`src/conductor.js:93-95`) — every `onchainSource` (EVM + Solana monitors) emits `'flow'` into `#onFlow` (`src/conductor.js:109`).

Pre-gate filters before `#evaluateAndMaybeEmit`:

1. Stable symbol short-circuit via `isStableSymbol` (`src/conductor.js:112`).
2. Compute `usd = price × amount` via `#usdValue` (`src/conductor.js:114`, `1439-1442`).
3. Unconditionally `#recordFlow` regardless (`src/conductor.js:115`).
4. If `!flow.direction` (unlabeled hot/cold counterparty) → return without evaluating (`src/conductor.js:117`).
5. `MIN_TEAM_FLOW_USD = 50_000` — team-flow with `usd < $50k` has the `teamFlow` flag **stripped** and is demoted to ordinary flow (`src/conductor.js:125-129`).
6. `isTeamSell = flow.teamFlow?.side === 'sell'` (`src/conductor.js:137`).
7. If **not** team sell: lookup `universeInfo.fdv`; `fdv >= 500_000_000` → skip (mega-cap noise) (`src/conductor.js:146-151`). Favored tokens use `effectiveMinFlow = minFlowUsd * 0.25` = $125k; otherwise `minFlowUsd` = $500k. `usd < effectiveMinFlow` → return (`src/conductor.js:156-158`).
8. Team **SELL** bypasses both the FDV ceiling AND the min-USD gate (`src/conductor.js:139` branch).

Side derivation: `side = flow.direction.toUpperCase()` (`src/conductor.js:163`).
Trigger shape: `{ type: 'flow', value: flow, usd }`.

### 1b. `surge` (1-minute price moves)

Wired via `this.prices.on('surge', ...)` (`src/conductor.js:96-100`), handled by `#onSurge` (`src/conductor.js:171`).

Volume-confirmation gate via `taService.getVolumeRatio` (`src/conductor.js:186-205`):

```
ratio < 1.5  → SUPPRESS (return, no signal at all)
ratio ≥ 3.0  → volumeBoost = 0.5
ratio ≥ 2.0  → volumeBoost = 0.3
otherwise    → volumeBoost = 0
null ratio   → fall through ungated (no perp data)
```

Side: `surge.direction === 'up' ? 'LONG' : 'SHORT'` (`src/conductor.js:174`).
Trigger: `{ type: 'surge', value: { ...surge, volumeBoost } }`.

### 1c. `liquidation` (Coinalyze leverage wipes)

Wired in `Conductor.start()` (`src/conductor.js:101-103`), dispatched by `#onLiquidation` (`src/conductor.js:214`).

`side = ev.bias.toUpperCase()` (`src/conductor.js:225`). Recording into `liqClustersByToken` (24h bucket) happens here too (`src/conductor.js:1456-1478`) — fuels the **liq-cluster magnet** scoring component later.
Trigger: `{ type: 'liquidation', value: ev }`.

### 1d. `funding_extreme` (periodic funding-leaders scan)

Public entry `evaluateFundingTrigger(tokenSymbol, side, fundingRate)` (`src/conductor.js:416`).
Trigger: `{ type: 'funding_extreme', value: { rate, polarity: rate<0?'negative':'positive' } }` (`src/conductor.js:430`).

The trigger base score for this type is **zero** by design — funding-extreme must earn its score from funding alignment + other confluence, otherwise it auto-fires on sentiment alone.

### 1e. Scan path: `evaluateTokenAndMaybeEmit` (movers)

`src/conductor.js:361`. Calls `evaluateForAnalysis` internally, applies a per-token cooldown, then either fires a signal or stays silent. **Never** emits observations (`src/conductor.js:405-409`) — observation-tier matches at every movers tick were the main source of LOW-confidence noise.

Cooldown is asymmetric: `required = last.side === analysis.side ? this.cooldownMs : this.cooldownMs * 3` (`src/conductor.js:370`) — same-side 30min, opposite-side 90min.

### 1f. Manual path: `evaluateForAnalysis` (chat `/analyze`)

`src/conductor.js:264`. Runs `taService.analyze()` for **both** sides in parallel (`src/conductor.js:281-285`) — they share the OHLCV cache so the second call costs ~zero — then builds a full evaluation for each side via `buildSide` (`src/conductor.js:293`) and picks the higher score (`src/conductor.js:329`).

Holdings scoring (only used by `/analyze`) is applied inside `buildSide`, NOT inside `#evaluate`:

```
pct ≥ 15  → SHORT +1.5  / LONG -1.0
pct ≥ 10  → SHORT +1.0  / LONG -0.6
pct ≥  5  → SHORT +0.6  / LONG -0.3
pct < 1 and side=LONG → +0.3  (clean float)
```
(`src/conductor.js:298-321`)

`lowConviction = Math.abs(longRes.evaluation.score - shortRes.evaluation.score) < 0.3` (`src/conductor.js:334`).

---

## 2. The full evaluation pipeline

Master function: `#evaluateAndMaybeEmit({ token, side, trigger })` (`src/conductor.js:436`).

### Step A — Post-loss cooldown (`src/conductor.js:447-462`)

Reads `recentLosses.get(sym)` populated by `recordLoss` (`src/conductor.js:244-253`). Only applies when `lastLoss.side === side`.

```
elapsed < postLossMinCooldownMs (30 min)        → suppress (hard floor)
elapsed < postLossExtendedCooldownMs (4 h)
  AND lastLoss.entry exists AND currentPx exists
  AND movedPct = |currentPx − lastLoss.entry| / lastLoss.entry × 100 < postLossPriceDistPct (3%)
                                                → suppress (same setup as last loss)
otherwise                                       → allow
```
Defaults at `src/conductor.js:84-86`.

### Step B — Same/opposite-side cooldown (`src/conductor.js:464-472`)

```
required = last.side === side ? cooldownMs (30 min) : cooldownMs * 3 (90 min)
elapsed < required → return
```

### Step C — Gather context + first raw score

`#gatherContext` (`src/conductor.js:655-676`) snapshots:

- `funding = this.funding.getByCgId(cgId)`
- `currentPrice = this.prices.getPrice(cgId)` (CoinGecko)
- `universeInfo = this.universe.lookupByCgId(cgId)`
- `recentFlows` filtered to `flowHistoryMs` (60 min, `src/conductor.js:46`)
- `recentSurges` filtered to `surgeHistoryMs` (30 min, `src/conductor.js:47`)
- `recentLiquidations` filtered to `liqHistoryMs` (60 min, `src/conductor.js:48`)

Then `evaluation = #evaluate(context)` (`src/conductor.js:475`).

### Step D — TA enrichment (gated by score ≥ minObservationScore = 2.0)

`src/conductor.js:480-494`. Only if the cheap first-pass score is at least `2.0` does the bot spend Coinalyze API budget on full multi-TF TA (`taService.analyze(sym, side)`). On success, findings are pushed into `context.taFindings` and the **entire** `#evaluate` is rerun.

### Step E — Liquidity-cluster bonus (orderbook L2, gated by score ≥ 2.0)

`src/conductor.js:503-536`. Calls `liquidityClusters.getClusters(sym)`. For LONG uses `askClusters`; for SHORT uses `bidClusters`. Picks first cluster with `|distancePct| ∈ [2%, 8%]`:

```
sizeUsd ≥ $10M → +0.8
sizeUsd ≥  $5M → +0.5
sizeUsd ≥  $1M → +0.3
otherwise      → 0 (no finding added)
```

Pushed as a `liqHeatmap` TA-style finding and `#evaluate` runs again.

### Step F — Resolve real exchange entry price

`src/conductor.js:542-553`. Calls `taService.getLastPerpPrice(sym)` (Bybit → OKX → Coinalyze fallback). If finite and >0, overrides `context.currentPrice`.

### Step G — Build trade plan

`#buildTradePlan(entry, side, taMetadata)` (`src/conductor.js:1043`). See §5.

### Step H — Trade-quality penalties (tier downgrade)

`#applyTradeQualityPenalties(strength, tradePlan, trigger, context)` (`src/conductor.js:1384`). Mutates `evaluation.strength` only, not `evaluation.score`. See §5.

### Step I — Cross-validation confirmation gate

`src/conductor.js:573-601`. Calls `confirmSignal({ side, ohlcvByTf })` from `src/ta-confirm.js`. Re-runs RSI/MACD/BB/Ichimoku/candlestick on the SAME bars using a totally different indicator library set.

- `confirmation.drop === true` → **hard return** (no signal, no observation, total silence) (`src/conductor.js:579-585`).
- Otherwise pushes a `kind: 'confirmation'` reason line with `points: 0` (visible in alerts but score-neutral) (`src/conductor.js:591-595`).

Gate is bypassed when `Object.keys(ohlcvByTf).length === 0` — must not block tokens it has no data for.

### Step J — Emit decision

`src/conductor.js:608-652`:

```
isFavored      = universe.isFavored(cgId)
sigThreshold   = isFavored ? minSignalScorePinned (2.55) : minSignalScore (3.0)
tier           = evaluation.strength.label
tierOkForSignal = tier === 'MEDIUM' || tier === 'HIGH' || tier === 'VERY HIGH'
planOk         = tradePlan && isFinite(entry) && isFinite(sl) && isFinite(tp1)
```

Open-position lockout: if `signalTracker.hasOpenSignal(sym)` AND would-be-signal, suppress (`src/conductor.js:619-624`). Observations still pass through.

Final branching:

- `score ≥ sigThreshold AND tierOkForSignal AND planOk` → `emit('signal', ...)` (`src/conductor.js:632`).
- else `score ≥ minObservationScore (2.0) AND trigger.type ∈ OBSERVABLE_TRIGGERS` → `emit('observation', ...)` (`src/conductor.js:635-651`).

`OBSERVABLE_TRIGGERS = new Set(['flow', 'liquidation', 'funding_extreme'])` (`src/conductor.js:645`). Surge / movers / manual triggers **never** fire observations.

---

## 3. Every scoring component — exact formulas

All scoring happens inside `#evaluate(context)` (`src/conductor.js:678-1028`).

### 3.1 Trigger base score

**Flow** (`src/conductor.js:684-733`):

```
usd ≥ $10M → baseFlow = 3.5
usd ≥  $5M → baseFlow = 3.0
usd ≥  $2M → baseFlow = 2.5
otherwise  → baseFlow = 2.0
```

Plus team-flow add-on (`src/conductor.js:698-719`):

```
teamFlow.side === 'sell' → +0.8
teamFlow.side === 'buy'  → +0.3
```

Multi-hop note `hops>0` appears in the reason text via `tf.hops` (`src/conductor.js:713`).

**Surge** (`src/conductor.js:734-743`):
```
score += 1.0 + volumeBoost   // volumeBoost ∈ {0, 0.3, 0.5} from §1b
```

**Liquidation** (`src/conductor.js:744-750`): flat `+1.5`.

**Funding extreme** (`src/conductor.js:751-763`): `+0` (radar entry only — must earn score from funding alignment + confluence; reasons line carries `points: 0`).

### 3.2 Funding alignment (`src/conductor.js:766-778`)

```
fScore = fundingScoreForSide(side, funding?.summary)   // ±2.0 range from funding.js
```

**Flow-trigger leniency** — when `trigger.type === 'flow' AND usd ≥ $2M AND fScore < -0.5`, the penalty is **floored at −0.5** (`src/conductor.js:773-774`). Rationale: "crowded longs" funding alongside a $2M+ cold-wallet flow is likely the same accumulation we just saw, not retail piling in — don't fight on-chain evidence with sentiment.

### 3.3 OI alignment (`src/conductor.js:780-794`)

`surgeDir` inferred from trigger (`src/conductor.js:781`), or last recent surge (`src/conductor.js:782-784`), or fallback `side === 'LONG' ? 'up' : 'down'` (`src/conductor.js:785-788`).

```
oScore = oiScoreForSide(side, funding?.summary, surgeDir)
```

### 3.4 Prior aligned flows (`src/conductor.js:801-827`)

Window: `flowHistoryMs = 60 min`. Excludes the triggering flow itself.

```
any aligned flow            → +1.0
any within NEAR_SIM_MS (5min) → additional +0.5 ("simultaneous" booster)
```

`NEAR_SIM_MS = 5 * 60_000` (`src/conductor.js:797`).

### 3.5 Prior aligned surges (`src/conductor.js:829-847`)

Window: `surgeHistoryMs = 30 min`. Skipped when `trigger.type === 'surge'`.

```
any aligned surge           → +0.5
any within NEAR_SIM_MS        → additional +0.5
```

### 3.6 Prior aligned liquidations (`src/conductor.js:849-865`)

Window: `liqHistoryMs = 60 min`. Skipped when `trigger.type === 'liquidation'`.

```
any aligned liquidation     → +1.0
any within NEAR_SIM_MS        → additional +0.5
```

### 3.7 Funding velocity (`src/conductor.js:867-908`)

Preferred source: `funding.summary.velocity1h` (rolling 1h time-series); fallback `funding.summary.delta` (poll-to-poll).

Constants:
```
NEUTRAL_DELTA = 0.0003   // 0.03% per period
STRONG_DELTA  = 0.001    // 0.1%  per period
favorable     = (side==='LONG' && fundingDelta < 0) || (side==='SHORT' && fundingDelta > 0)
```

Scoring:
```
favorable     AND abs ≥ STRONG_DELTA  → +0.7
favorable     AND abs ≥ NEUTRAL_DELTA → +0.3
NOT favorable AND abs ≥ STRONG_DELTA  → −0.3
```

### 3.8 Liquidation cluster magnets (`src/conductor.js:910-949`)

Calls `#getLiquidationClusters(symbol, currentPrice)` (`src/conductor.js:1494`) — buckets 24h of liq events into 0.5% buckets within ±10% of current price, `minClusterUsd = 2_000_000` default.

Alignment filter (`src/conductor.js:923-929`):
- `LONG` wants `dominantSide === 'shorts'` cluster with `distancePct > 0` (above)
- `SHORT` wants `dominantSide === 'longs'` cluster with `distancePct < 0` (below)
- `|distancePct| ∈ [2%, 8%]`

Picks the largest by `longUsd + shortUsd`. Scoring:

```
totalUsd ≥ $10M → +1.0
totalUsd ≥  $5M → +0.7
otherwise       → +0.5
```

### 3.9 FDV overhang (`src/conductor.js:951-971`)

Triggers when `universeInfo.fdvRatio ≥ 1.5`:

```
SHORT:  ratio ≥ 7 → +1.0 ; ≥ 3 → +0.6 ; ≥ 1.5 → +0.3
LONG:   ratio ≥ 7 → −0.8 ; ≥ 3 → −0.5 ; ≥ 1.5 → −0.2
```

### 3.10 Supply % cold inflow (LONG only) (`src/conductor.js:973-991`)

```
coldInflowUsd = sum of recentFlows where flow.direction === 'long' (in USD)
supplyUsd     = universeInfo.circulatingSupply * currentPrice
pct           = coldInflowUsd / supplyUsd * 100

pct ≥ 5   → +1.5
pct ≥ 1   → +1.0
pct ≥ 0.5 → +0.5
pct < 0.5 → nothing
```

(Note: `evaluateForAnalysis`'s holdings path uses a different scoring matrix — see §1f.)

### 3.11 TA findings — diminishing returns (`src/conductor.js:993-1025`)

```
TA_SOFT_CAP = 1.5
TA_HARD_CAP = 2.5
```

For each positive finding `f.points`:
```
remainingBelowSoft = max(0, TA_SOFT_CAP − taPositiveAccum)
inSoftZone         = min(f.points, remainingBelowSoft)         // 100% counted
inDiminishedZone   = max(0, f.points − inSoftZone)              // 50% counted
applied            = inSoftZone + inDiminishedZone * 0.5
wouldExceed        = max(0, taAppliedSum + applied − TA_HARD_CAP)
applied           -= wouldExceed                                // hard ceiling 2.5
```

**Negative TA points always count 100%** (`src/conductor.js:1009-1010` branch — only `f.points > 0` enters the diminishing-returns logic). Rationale: disconfirmation should bite hard.

---

## 4. Tier thresholds + confidence%

`#strengthLabel(score)` (`src/conductor.js:1364-1373`):

```
confidence = clamp(0, 100, round(score * 20))

score ≥ 5  → VERY HIGH 🔥
score ≥ 4  → HIGH      ✅
score ≥ 3  → MEDIUM    🟡
score ≥ 2  → LOW       🟠
otherwise  → MIXED     ⚠️
```

Linear mapping: 1.0 → 20%, 3.0 → 60%, 5.0 → 100%.

After trade-plan penalties (see §5) confidence is recomputed:
```
baseConf   = clamp(0, 100, round(strength.total * 20))
confidence = clamp(5, 100, baseConf − tierDrop * 10)
```
(`src/conductor.js:1425-1427`)

---

## 5. Trade plan + trade-quality penalties

### 5.1 Multi-TF alignment vote (`src/conductor.js:1049-1059`)

```
tfs        = ['1min', '5min', '1hour', '4hour', 'daily']
TF_WEIGHTS = { '1min': 0.05, '5min': 0.10, '1hour': 0.20, '4hour': 0.30, 'daily': 0.35 }   // sum = 1.0
aligned            = tfs whose metadata[tf].trend matches side
weightedAlignment  = sum of weights for aligned TFs
dailyAgainst       = (side==='LONG' && taMetadata.daily?.trend === 'down') ||
                     (side==='SHORT' && taMetadata.daily?.trend === 'up')
```

### 5.2 Horizon selection (`src/conductor.js:1070-1086`)

```
if dailyAgainst:
    aligned≥1 && includes '1hour' && weighted≥0.20 → DAY      (1h ATR, 8h validity)
    else                                            → SCALP    (5m ATR, 2h validity)
elif aligned≥3 && includes 'daily' && weighted≥0.50 → POSITION (4h ATR, 72h validity)
elif aligned≥1 && (4h OR daily) && weighted≥0.30    → SWING    (1h ATR, 24h validity)
elif aligned≥1 && includes '1hour' && weighted≥0.20 → DAY      (1h ATR, 8h validity)
else                                                → SCALP    (5m ATR, 2h validity)
```

### 5.3 ATR, wick-aware SL multiplier, SL cap (`src/conductor.js:1088-1127`)

```
wickRatio = taMetadata[chosenTfForAtr]?.recentWickRatio ?? 1
wickRatio ≥ 3 → slMultiplier = 2.5
wickRatio ≥ 2 → slMultiplier = 2.0
otherwise     → slMultiplier = 1.5

slDistance = atr * slMultiplier
slPct      = (slDistance / entry) * 100

MAX_SL_PCT = 12       // CAP, not reject
if slPct > 12: slDistance = entry * 0.12 ; slPct = 12
sl = LONG ? entry − slDistance : entry + slDistance
```

### 5.4 Raw TPs + structure snapping (`src/conductor.js:1129-1144`, `1309-1362`)

Raw fallback TPs:
```
rawTp1 = entry ± slDistance * 1.5
rawTp2 = entry ± slDistance * 3.0
rawTp3 = entry ± slDistance * 4.5
```

`#snapTpsToStructure` pulls each TP to the nearest swing extreme within an R-tolerance band:
```
TP1: levels in [0.8R, 2.5R]
TP2: levels in [2.0R, 4.5R]
TP3: levels in [3.5R, 6.5R]
```
TFs scanned in order `['daily', '4hour', '1hour', '5min']` (`src/conductor.js:1315`). Falls back to raw if no candidate sits in the band.

### 5.5 Leverage (`src/conductor.js:1146-1162`)

```
rawMaxLev         = 2 / (slPct / 100)            // 2% account risk
confidenceFactor  = 0.3 + weightedAlignment * 0.7
tierCap by slPct:
    < 0.5%  → 10
    < 1.0%  → 15
    < 2.5%  → 20
    < 5.0%  → 10
    else    →  5
suggestedLeverage = clamp(2, tierCap, floor(rawMaxLev * confidenceFactor * 0.4))
maxLeverage       = clamp(2, 25,      floor(rawMaxLev * 0.7))
```

### 5.6 Liquidity-grab limit entry (only when `dailyAgainst`) (`src/conductor.js:1180-1218`)

- SHORT: target = lowest `swingHigh > entry` from daily/4h/1h pool.
- LONG: target = highest `swingLow < entry` from daily/4h/1h pool.
- `buffer = atr * 0.3` past the extreme.
- `MAX_LIMIT_DIST_PCT = 7` — limit further than 7% from market drops the LG and falls back to market entry.

When LG fires, SL/TPs are recomputed from `limitEntry` with the same `slMultiplier`, then re-snapped (`src/conductor.js:1224-1266`).

### 5.7 Trade-quality penalties (`src/conductor.js:1384-1435`)

```
tiers = ['MIXED', 'LOW', 'MEDIUM', 'HIGH', 'VERY HIGH']
idx   = tiers.indexOf(strength.label)

rr = slPct > 0 ? tp1Pct / slPct : 1
rr < 1.0  → idx -= 2
rr < 1.5  → idx -= 1

weakAlignment = weightedAlignment <= 0.15
shortHorizon  = horizon === 'SCALP' || horizon === 'DAY'
weakAlignment && shortHorizon → idx -= 1

alignmentCount === 0 && dailyAgainst → idx -= 1   // pure counter-trend bet on a pump

isSentimentOnly = trigger.type === 'funding_extreme'
                  && recentFlows.length === 0
                  && recentLiquidations.length === 0
isSentimentOnly && idx >= 3 → idx = 3            // cap at HIGH, never VERY HIGH

idx = clamp(0, 4, idx)
```

---

## 6. Signal vs Observation decision

Two gates determine whether the user gets a 📢 signal, a 👀 observation, or silence (`src/conductor.js:608-652`).

```
isFavored        = universe.isFavored?.(token.coingeckoId) ?? false
sigThreshold     = isFavored ? minSignalScorePinned (2.55) : minSignalScore (3.0)
tier             = evaluation.strength.label  // post-penalty
tierOkForSignal  = tier ∈ {'MEDIUM', 'HIGH', 'VERY HIGH'}
planOk           = tradePlan && isFinite(entry) && isFinite(sl) && isFinite(tp1)
```

Decision tree:

1. `signalTracker.hasOpenSignal(sym)` AND would-be-signal → suppress signal (observations still allowed) (`src/conductor.js:619-624`).
2. `score ≥ sigThreshold AND tierOkForSignal AND planOk` → `emit('signal', ...)` (`src/conductor.js:632-634`).
3. else `score ≥ minObservationScore (2.0) AND trigger.type ∈ OBSERVABLE_TRIGGERS` → `emit('observation', ...)` (`src/conductor.js:635-651`).
4. otherwise: silent.

```
OBSERVABLE_TRIGGERS = new Set(['flow', 'liquidation', 'funding_extreme'])
```
(`src/conductor.js:645`)

Surge / movers-scan / manual triggers **never** emit observations — only real signals.

The scan path (`evaluateTokenAndMaybeEmit`, `src/conductor.js:361-411`) bakes the same rule in explicitly: even for `OBSERVABLE_TRIGGERS`, scan-driven evaluations never emit observations (`src/conductor.js:405-409`).

---

## 7. Post-emit lockouts and cooldowns

### 7.1 Open-position lockout

`signalTracker.hasOpenSignal(symbol, side=null)` (`src/signal-tracker.js:392-400`) reads the JSONL and returns true if any row has `!outcome` and matching `symbol` (case-insensitive). Default is **same-token any-side** — if there's already an open TIA LONG, a TIA SHORT signal is also suppressed; rationale at `src/conductor.js:613-618`: the existing trade is at risk of invalidation, and the user would rather see it resolve first than be flooded with both directions.

Authoritative duplicate guard at the disk-write layer (`src/signal-tracker.js:56-69`): `record()` re-reads disk on every append and rejects same-symbol + same-side + still-open. Catches bursts that all pass the conductor-side check before any write completes (the EDEN LONG ×4 bug).

### 7.2 `lastFiredAt` cooldowns

`this.lastFiredAt` Map keyed by symbol → `{ ts, side }` (`src/conductor.js:77`). Set whenever a signal or observation emits (`src/conductor.js:633, 650`).

```
elapsed = Date.now() - last.ts
required = (last.side === side) ? cooldownMs (30 min) : cooldownMs * 3 (90 min)
elapsed < required → return
```
(`src/conductor.js:467-472` for event-driven path; identical logic in `evaluateTokenAndMaybeEmit` at `src/conductor.js:367-372`)

Pruned by `#cleanup` after `cooldownMs * 3` (90 min); runs every 60s (`src/conductor.js:104`).

### 7.3 Post-loss cooldown (price-distance aware)

Tracked in `this.recentLosses` Map keyed by symbol → `{ side, ts, entry }` (`src/conductor.js:83`). Populated only by `recordLoss(sig)` for outcomes `LOSS` or `EXPIRED_LOSS` (`src/conductor.js:244-253`).

Defaults at `src/conductor.js:84-86`:
```
postLossMinCooldownMs      = 30 * 60_000     // hard 30min after every loss
postLossExtendedCooldownMs = 4 * 60 * 60_000 // 4h if still in same price area
postLossPriceDistPct       = 3               // % from loss entry counted as "new setup"
```

Suppression logic (`src/conductor.js:447-462`), only when `lastLoss.side === side`:
```
elapsed < 30min                                → suppress (hard floor)
elapsed < 4h AND entry exists AND px exists
  AND |currentPx − entry|/entry * 100 < 3%    → suppress (same setup)
otherwise                                      → allow
```

`recentLosses` is pruned by `#cleanup` at `postLossExtendedCooldownMs` (4h).

---

## 8. SignalTracker — persistence & resolution

### 8.1 Record (`src/signal-tracker.js:56-119`)

JSONL append. Liquidity-grab two-phase:
```
isLG            = plan.isLiquidityGrab === true && plan.limitEntry != null
effectiveEntry  = isLG ? plan.limitEntry : plan.entry
awaitingLimit   = isLG          // suppresses SL/TP/MFE/MAE until limit touched
limitFilledAt   = null
```

Reasons stored as `{kind, points}` only (text dropped to keep file lean) (`src/signal-tracker.js:91`).

### 8.2 `resolveOpen` — wick-aware, two-phase, race-safe (`src/signal-tracker.js:153-354`)

Tick runs every `checkIntervalMs = 5min` (`src/signal-tracker.js:27`).

**Race-safety**: `startGen = this.resetGen` captured at top (`src/signal-tracker.js:154`); at the end of the tick, if `this.resetGen !== startGen` (reset() ran mid-tick), the `#writeAll` is abandoned to avoid resurrecting just-archived signals (`src/signal-tracker.js:346-349`).

**Bar fetch** (`src/signal-tracker.js:178-200`):
```
fromTs = floor( ((existing?.lastChecked ?? sig.ts) - 60_000) / 1000 )   // 60s back-overlap
toTs   = floor(now / 1000)
bars   = await taService.getRecentBars(sig.symbol, fromTs, toTs)
```
Aggregates `barHigh = max(b.h)`, `barLow = min(b.l)`, `barClose = last.c`. Fallback to `priceMonitor.getPrice(sig.cgId)` (no wick info) when bars unavailable.

**Phase 1 — awaiting limit fill** (`src/signal-tracker.js:206-251`):
```
limit  = sig.limitEntry ?? sig.entry
filled = sig.side === 'SHORT' ? barHigh >= limit : barLow <= limit
```
On fill: `awaitingLimit = false`, `limitFilledAt = now`, `trail.high = trail.low = limit` (reset so earlier wicks don't count), `justFilled = true`. If not filled and `now - sig.ts ≥ validityMs` → outcome `EXPIRED_UNFILLED`.

**Phase 2 — SL/TP detection** (`src/signal-tracker.js:253-340`):

Trail update only when `!justFilled` (`src/signal-tracker.js:258-263`).

MFE / MAE (`src/signal-tracker.js:266-271`):
```
LONG : maxFavorable = (trail.high - entry)/entry * 100
       maxAdverse  = (trail.low  - entry)/entry * 100
SHORT: maxFavorable = (entry - trail.low) /entry * 100
       maxAdverse  = (entry - trail.high)/entry * 100
```

Hit check — **SL first** (conservative when both touched in same bar window) (`src/signal-tracker.js:273-285`):
```
LONG : trail.low  <= sl  → LOSS
       trail.high >= tp3 → WIN_TP3
       trail.high >= tp2 → WIN_TP2
       trail.high >= tp1 → WIN_TP1
SHORT mirror with high vs sl and low vs tp
```

P&L uses the **level touched**, not bar close (`src/signal-tracker.js:297-305`):
```
exitPrice  = LOSS ? sl : WIN_TPn ? tpN : barClose
finalPnlPct = LONG ? (exit-entry)/entry*100 : (entry-exit)/entry*100
```
Fixes the HEI bug where WIN_TP1 reported -1.71% because price had bounced back past TP1 before the resolver tick.

**Time expiry** (`src/signal-tracker.js:321-340`):
```
validityMs = (sig.validityHrs ?? 24) * 3_600_000
now - sig.ts >= validityMs
  → outcome = finalPnl > 0 ? 'EXPIRED_PROFIT' : 'EXPIRED_LOSS'
```

### 8.3 Outcome resolution events

Every resolved outcome emits `'resolved'` (`src/signal-tracker.js:247, 317, 339`). Sheet-logger mirrors via `sheetLogger.updateOutcome(...)`. `getStats` (`src/signal-tracker.js:410-454`) and `#logSummary` (`src/signal-tracker.js:456-490`) both **exclude `NO_PLAN` and `EXPIRED_UNFILLED`** from win-rate denominators so console and `/stats` agree.

```
winPct = (wins + expiredProfit) / resolved.length * 100
```
(`src/signal-tracker.js:449, 469`)

---

## 9. Feedback loop — SignalTracker → Conductor

Wiring in `src/index.js:532-537`:

```js
signalTracker.on('resolved', async (sig) => {
  // Feed losses back into the Conductor so it can suppress same-side
  // re-entries on tokens that just stopped out.
  conductor.recordLoss(sig);
  ...
});
```

`Conductor.recordLoss(sig)` (`src/conductor.js:244-253`) only acts when `sig.outcome ∈ {'LOSS', 'EXPIRED_LOSS'}`, storing `{side, ts, entry: sig.entry ?? null}` into `recentLosses`. That entry then drives the price-distance-aware post-loss cooldown described in §7.3 on the next `#evaluateAndMaybeEmit` for that symbol.

This is the only closed loop in the engine: a stopped-out trade silently raises the bar for re-entry at the same price level for up to 4 hours, then the bot is free to fire again when either time passes or price has moved at least 3% from the loss entry.
