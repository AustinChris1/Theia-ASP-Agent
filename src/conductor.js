import { EventEmitter } from 'node:events';
import { fundingScoreForSide, oiScoreForSide, describeFunding, describeOI } from './funding.js';
import { isStableSymbol } from './stables.js';
import { confirmSignal } from './ta-confirm.js';
import { cvdVeto } from './cvd.js';
import { TF_ALIGNMENT_WEIGHTS, TF_ORDER } from './timeframes.js';
import { regimeScoreForSide } from './regime.js';
import { assessDistribution } from './distribution.js';
import { cgSearch } from './coingecko.js';

// ── Insider-sell alert helpers ───────────────────────────────────────────────
// Human network names + explorer bases per chain (EVM today; solana ready for
// when on-chain SOL monitoring lands).
const NETWORK_LABEL = { ethereum: 'Ethereum', bsc: 'BNB Chain', base: 'Base', solana: 'Solana' };
const EXPLORER_TX = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  bsc:      (h) => `https://bscscan.com/tx/${h}`,
  base:     (h) => `https://basescan.org/tx/${h}`,
  solana:   (h) => `https://solscan.io/tx/${h}`
};
const EXPLORER_ADDR = {
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  bsc:      (a) => `https://bscscan.com/address/${a}`,
  base:     (a) => `https://basescan.org/address/${a}`,
  solana:   (a) => `https://solscan.io/account/${a}`
};
const explorerTxLink   = (chain, hash) => (chain && hash && EXPLORER_TX[chain])   ? EXPLORER_TX[chain](hash)   : null;
const explorerAddrLink = (chain, addr) => (chain && addr && EXPLORER_ADDR[chain]) ? EXPLORER_ADDR[chain](addr) : null;

// Reason-kinds that represent a genuinely PREDICTIVE on-chain / funding edge
// (per the 345-record live audit: win-lift +4 to +9). A MOMENTUM trigger
// (surge / movers — 34-41% WR, anti-predictive on its own) must carry at least
// one of these to fire a tradeable signal (see Conductor#momentumLacksEdge).
// Deliberately EXCLUDES the always-present / negative-lift kinds (funding, ta,
// smc, oi, fdv, liqGrab, surge, priorSurges).
const MOMENTUM_EDGE_KINDS = new Set([
  'flow', 'funding_trigger', 'distribution', 'teamFlow',
  'priorFlows', 'liquidation', 'fundingVelocity', 'supplyPct',
]);

// Pure decision for the soft confluence gate (exported for unit tests). A
// momentum trigger (surge/movers) with no predictive on-chain/funding reason
// returns true (= should be gated/silenced). Non-momentum triggers and the
// disabled state (requireEdge=false) always return false.
export function momentumLacksEdge(triggerType, reasons, requireEdge = true) {
  if (!requireEdge) return false;
  if (triggerType !== 'surge' && triggerType !== 'movers') return false;
  return !(reasons ?? []).some(r => MOMENTUM_EDGE_KINDS.has(r?.kind));
}

// A+ conviction grader (pure, exported for unit tests). Counts INDEPENDENT edge
// categories; an A+ ("fat pitch") needs a PROVEN-edge source (on-chain flow /
// funding extreme / liquidation), ≥4 edges total, a strong base tier, R:R ≥ 1.5,
// regime not against, and not a high-risk counter-trend fade. Selectivity — not
// a magic threshold — is the only honest path to a high win rate.
export function assessConviction({ reasons, tradePlan, triggerType, side, regime = null, exhReversal = false, tier = null }) {
  const kinds = new Set((reasons ?? []).map(r => r?.kind));
  const has = (...ks) => ks.some(k => kinds.has(k));
  const edges = [];
  if (has('flow', 'distribution', 'teamFlow', 'priorFlows') || triggerType === 'flow' || triggerType === 'distribution') edges.push('on-chain flow');
  if (has('funding_trigger', 'fundingVelocity') || triggerType === 'funding_extreme') edges.push('funding extreme');
  if (has('liquidation', 'liqCluster', 'liqLevels', 'priorLiquidations') || triggerType === 'liquidation') edges.push('liquidation/squeeze');
  if (kinds.has('smc')) edges.push('market structure');
  if (kinds.has('confirmation')) edges.push('indicator confirmation');
  if (kinds.has('supplyPct')) edges.push('supply concentration');
  const wa = tradePlan?.weightedAlignment ?? 0;
  if (wa >= 0.30 && !tradePlan?.dailyAgainst) edges.push('multi-TF trend');
  const rr = Math.max(tradePlan?.rr1 ?? 0, (tradePlan?.rr2 ?? 0) * 0.5, (tradePlan?.rr3 ?? 0) * 0.33);
  if (rr >= 2) edges.push('R:R ≥ 2');

  const PRIMARY = new Set(['on-chain flow', 'funding extreme', 'liquidation/squeeze']);
  const hasPrimary = edges.some(e => PRIMARY.has(e));
  const regimeAgainst = (side === 'LONG' && regime === 'BTC_DOWN') || (side === 'SHORT' && regime === 'BTC_UP');
  const tierStrong = tier === 'HIGH' || tier === 'VERY HIGH';
  const isHighConviction = hasPrimary && edges.length >= 4 && rr >= 1.5 && tierStrong && !exhReversal && !regimeAgainst;
  return { edges, count: edges.length, hasPrimary, rr: Number(rr.toFixed(2)), regimeAgainst, isHighConviction };
}

// Guarantee a strictly-monotonic take-profit ladder (TP1<TP2<TP3 for LONG,
// TP1>TP2>TP3 for SHORT, each beyond entry). Snapping a TP to a nearby structure
// level can pull an EARLIER rung PAST a later one — the STG bug, where TP1
// snapped to a wall ABOVE rawTP2 and the alert printed TP2 *below* TP1. Rule:
// prefer the clean RAW ladder (raw ATR multiples are monotonic by construction);
// if accepting a snap would invert the order, revert the OVERSHOOTING snapped
// rung. A final hard clamp forces strict ordering for any pathological input.
// `snap`/`raw` are { tp1, tp2, tp3 } price objects; snap values may be null.
export function enforceTpLadder(side, entry, snap, raw) {
  const beyond = (a, b) => (side === 'LONG' ? b > a : b < a);   // b strictly further from entry than a
  const has = (x) => x != null && isFinite(x);
  let tp1 = has(snap.tp1) ? snap.tp1 : raw.tp1, s1 = has(snap.tp1);
  let tp2 = has(snap.tp2) ? snap.tp2 : raw.tp2, s2 = has(snap.tp2);
  let tp3 = has(snap.tp3) ? snap.tp3 : raw.tp3, s3 = has(snap.tp3);
  if (!beyond(entry, tp1)) { tp1 = raw.tp1; s1 = false; }
  // TP1↔TP2: revert whichever rung was snapped (the overshoot); if ambiguous, both raw.
  if (!beyond(tp1, tp2)) {
    if (s1 && !s2) { tp1 = raw.tp1; s1 = false; }
    else if (s2 && !s1) { tp2 = raw.tp2; s2 = false; }
    else { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }
  }
  if (!beyond(tp1, tp2)) { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }
  // TP2↔TP3: same.
  if (!beyond(tp2, tp3)) {
    if (s3 && !s2) { tp3 = raw.tp3; s3 = false; }
    else if (s2 && !s3) { tp2 = raw.tp2; s2 = false; }
    else { tp2 = raw.tp2; tp3 = raw.tp3; s2 = s3 = false; }
  }
  if (!beyond(tp2, tp3)) { tp2 = raw.tp2; tp3 = raw.tp3; s2 = s3 = false; }
  if (!beyond(tp1, tp2)) { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }
  // Final hard guarantee — strict ordering even if the raw inputs were degenerate.
  const nudge = side === 'LONG' ? 1.004 : 0.996;
  if (!beyond(entry, tp1)) { tp1 = entry * nudge; s1 = false; }
  if (!beyond(tp1, tp2))   { tp2 = tp1 * nudge;   s2 = false; }
  if (!beyond(tp2, tp3))   { tp3 = tp2 * nudge;   s3 = false; }
  return { tp1, tp2, tp3, snapped: { tp1: s1, tp2: s2, tp3: s3 } };
}

// Data-tunable scoring weights (ranks 4-5 of the signal-quality overhaul).
// DEFAULTS REPRODUCE THE PRE-OVERHAUL BEHAVIOUR EXACTLY — set the env vars to
// rebalance toward the live-audit findings (de-fund anti-predictive surge/TA/OI;
// raise the predictive flow/funding/distribution edge). Recommended targets in
// the comments come from the 345-record audit + `node src/tools/derive-weights.js`
// (shrunk Weight-of-Evidence). Ship these only AFTER ranks 1-3 + CVD have a
// couple weeks of data, change surge/TA and flow/funding TOGETHER, and re-pull
// the Neon stats to confirm the good-trigger buckets don't lose volume.
const numEnv = (k, d) => { const v = Number(process.env[k]); return isFinite(v) ? v : d; };

// Extra liquidation score from cascade size RELATIVE TO OPEN INTEREST. A wick that
// liquidates 1% of a token's OI in a minute is genuinely violent and market-moving;
// the same dollar amount on BTC's huge OI is routine. Linear to +1.0 at ≥1% of OI
// (capped so it never overwhelms the confluence model). Pure + exported for tests.
export function liquidationOiBonus(oiFrac) {
  const f = Number(oiFrac);
  if (!isFinite(f) || f <= 0) return 0;
  return Math.min(1.0, f / 0.01);
}

// Significance-scaled liquidation BASE. A flat +2.0 for ANY liquidation over a $
// floor meant a $309k wipe on BTC (a blip vs BTC's enormous OI) scored the same
// as a real cascade on a small-cap. Scale the base by how big the liq is
// RELATIVE TO OI: full base once it's ≥ fullOi (default 0.3% of OI), tapering to
// a small floor below that — so a trivial liq can't fire a signal on its own,
// but a violent cascade keeps full weight. Unknown OI → full base (don't punish
// missing data; same philosophy as the FDV gate). Pure + exported for tests.
export function liquidationBaseScore(oiFrac, { fullOi = 0.003, base = 2.0, floor = 0.5 } = {}) {
  const f = Number(oiFrac);
  if (!isFinite(f)) return base;       // OI unknown → keep full base
  if (f <= 0) return floor;
  return floor + (base - floor) * Math.min(1, f / fullOi);
}

// Absolute-CASCADE base. A single liquidation print can be noise, but several
// stacking on the same symbol within minutes is a real cascade even on a major
// whose %-of-OI stays tiny (the $400k → $729k → $2.17M BTC case). Scales 0 → +2.0
// as the cumulative same-side liquidation USD over the window approaches fullUsd.
// Used as max(relative %OI base, this): low-caps fire on %OI, majors fire on
// cumulative cascade size. Pure + exported for tests.
export function liquidationCascadeBase(cumulativeUsd, fullUsd = 2_000_000) {
  const u = Number(cumulativeUsd);
  if (!isFinite(u) || u <= 0) return 0;
  return 2.0 * Math.min(1, u / fullUsd);
}

// The liquidation contribution to the SIGNAL score, gated by market liquidity. A
// liquidation is a tradeable squeeze on a LIQUID major and rekt-bait on an illiquid
// small-cap, so the %-of-OI base (which DEMOTED majors to ~0.7 → "liq notifications
// but never a signal", and PROMOTED small-caps) is replaced by:
//   • LIQUID market → strong base: max(baseFloor, cascade-scaled) + oiBonus, so a
//     $300k+ BTC/ETH squeeze reaches signal grade (restores the 2a110ea +2.0).
//   • ILLIQUID → damped to illiquidCap; stays a heads-up, never carries a signal alone.
// Pure + exported for tests.
export function liquidationSignalBase({ liquidMarket, cascadeUsd = 0, oiFrac = NaN, cascadeFullUsd = 2_000_000, baseFloor = 2.0, illiquidCap = 0.4, baseFullOi = 0.003 } = {}) {
  const oiBonus = liquidationOiBonus(oiFrac);
  if (liquidMarket) {
    return Math.max(baseFloor, liquidationCascadeBase(cascadeUsd, cascadeFullUsd)) + oiBonus;
  }
  return Math.min(illiquidCap, liquidationBaseScore(oiFrac, { fullOi: baseFullOi }));
}

// Is the move ALREADY underway in the trade's direction? A counter-trend
// "stop-cluster" limit assumes price is coiled and will retrace UP into a swing
// (for a SHORT) to sweep stops before reversing. But when the trigger is a LIVE
// directional move — a liquidation cascade (forced flow), or a surge in the
// trade's OWN direction (momentum continuation) — price is already running our
// way and won't retrace to the swing. Enter at CMP/market instead. A FADE (surge
// OPPOSITE the trade = exhaustion-reversal) is NOT momentum-live → keep the
// swing-limit. Pure + exported for tests.
export function isMomentumLive(trigger, side) {
  if (!trigger) return false;
  if (trigger.type === 'liquidation') return true;
  if (trigger.type === 'surge') {
    const dir = trigger.value?.direction;
    return (side === 'SHORT' && dir === 'down') || (side === 'LONG' && dir === 'up');
  }
  return false;
}

// Minimum USD for an insider SELL to count as MATERIAL distribution, scaled to
// the token's market cap. A $75k sell on $1.2B ENA is invisible; the same $75k
// on a $20M cap is a real dump. floor = max(absFloor, minMcapPct × mcap).
export function teamSellMaterialFloorUsd(mcap, { minMcapPct = 0.0003, absFloor = 50_000 } = {}) {
  const m = Number(mcap);
  if (!isFinite(m) || m <= 0) return absFloor;
  return Math.max(absFloor, m * minMcapPct);
}

// Count INDEPENDENT aligned prior flows for the corroboration bonus. A single
// insider splitting one exit into chunks (same fromName like "Insider #21",
// even via different fresh wallets) is ONE party, not five — and the flow that
// triggered the eval shouldn't corroborate itself. Dust legs below minUsd are
// ignored. Returns the count of DISTINCT senders other than the trigger's.
export function independentFlowCount(otherFlows, triggerValue, minUsd = 25_000) {
  const key = (f) => (f?.fromName ?? f?.fromAddress ?? f?.from ?? `${f?.exchange ?? ''}:${f?.fromType ?? ''}`).toString().toLowerCase();
  const trig = triggerValue ? key(triggerValue) : null;
  const senders = new Set();
  for (const e of otherFlows ?? []) {
    if ((e.usd ?? 0) < minUsd) continue;
    const s = key(e.flow);
    if (!s || s === trig) continue;
    senders.add(s);
  }
  return senders.size;
}

const SCORING = {
  surgeBase:          numEnv('SURGE_BASE', 1),            // recommend 0.5  (surge WoE -0.17)
  flowBaseBoost:      numEnv('FLOW_BASE_BOOST', 0),       // recommend +0.5 (flow is 60.6%, not the 42% the curve assumes)
  teamSellPts:        numEnv('TEAM_SELL_PTS', 0.8),       // recommend 1.2  (distribution 70%)
  fundingExtremeBase: numEnv('FUNDING_EXTREME_BASE', 0),  // recommend ~1.0 (keep <3 so it still needs confluence)
  distributionBase:   numEnv('DISTRIBUTION_BASE', 2.5),   // best bucket (70%); raise cautiously
  taSoftCap:          numEnv('TA_SOFT_CAP', 1.5),         // recommend 0.75 (ta WoE ~0 at selection; stop it manufacturing tiers)
  taHardCap:          numEnv('TA_HARD_CAP', 2.5),         // recommend 1.0
  coldDepositBoost:   numEnv('COLD_DEPOSIT_BOOST', 0.6),  // extra bearish weight when supply is deposited INTO exchange COLD storage (pre-distribution staging — the BEAT/VELVET/SAHARA "into cold wallet" tell)
};

// ── Structural-location guard ───────────────────────────────────────────────
// The single biggest losing pattern in the live data: a trend-following entry
// MARKET-FILLED right into the opposing structure — LONG into resistance / a
// double-top, SHORT into support / a double-bottom (FHE LONG at the 0.0244 shelf;
// TAG SHORT at the 0.00100 support). Excursion proof: losers go +2.8% then
// collapse −6.9% (brief continuation, then the wall rejects). The momentum/TA
// confluence said "go" but nobody asked "is there ROOM before the wall?".
// This guard measures the nearest opposing swing level in the trade's path and
// demotes entries jammed against it (a CLUSTERED shelf → observation-only; a
// single near level → −1 tier). Liquidity-grab + exhaustion-reversal entries are
// EXEMPT (they target structure on purpose). A genuine breakout (price already
// beyond all recent structure → nothing ahead) is naturally exempt (no level).
const STRUCT_GUARD          = process.env.STRUCT_GUARD !== '0';        // default ON
const STRUCT_ROOM_PCT       = numEnv('STRUCT_ROOM_PCT', 4.0);          // shelf within this % of entry → cap to observation
const STRUCT_ROOM_SINGLE_PCT= numEnv('STRUCT_ROOM_SINGLE_PCT', 2.0);   // single near level within this % → −1 tier
const STRUCT_SHELF_PCT      = numEnv('STRUCT_SHELF_PCT', 2.0);         // ≥2 opposing levels within this % of each other = a wall (double top/bottom)
const STRUCT_TFS            = ['5min', '1hour', '4hour', 'daily'];     // TFs whose swings define meaningful structure ('15min' was a typo — that TF doesn't exist, so the guard silently skipped fast structure)
// CASCADE TPs: on a liquidation / liquidity-sweep trade, the move is drawn toward the
// far liquidation cluster (the cascade exhausts THERE), so extend the FINAL target out
// to that magnet instead of capping TP3 at a normal ATR multiple — ride the cascade.
// Only affects liquidation/sweep triggers; TP1/TP2 still bank intermediate profit.
const CASCADE_TP_EXTEND    = process.env.CASCADE_TP_EXTEND !== '0';    // default ON (targeted, low-risk)
const CASCADE_TP_MAX_PCT   = numEnv('CASCADE_TP_MAX_PCT', 25);         // don't extend TP3 past this % from entry

// ── Stop-loss ceiling, horizon-scaled + env-tunable ─────────────────────────
// The SL is anchored to structure (just beyond a protective swing) but capped
// here so a wide-ATR token can't ship a ruinous stop. Live excursion: winners
// dip only −1.5% but losers bleed −6.9% — and on a maxPositionUsd-capped account
// the notional is FIXED, so a tighter stop is a smaller $ loss. Tightened from
// the old 4/6/9/12 (SWING 8% WR + DAY 0% were the wide-stop bleeders). Tension:
// too tight gets wicked out (WAL), too wide bleeds (MYX) — hence env-tunable.
const SL_MAX_PCT = {
  SCALP:    numEnv('SL_MAX_PCT_SCALP', 4),
  DAY:      numEnv('SL_MAX_PCT_DAY', 5),
  SWING:    numEnv('SL_MAX_PCT_SWING', 7),
  POSITION: numEnv('SL_MAX_PCT_POSITION', 9),
};

// Pure + testable. Nearest OPPOSING swing level in the trade's PATH (resistance
// above a LONG, support below a SHORT) and whether it's a clustered shelf.
// Returns { roomPct, shelf, level } or null when nothing is ahead (breakout /
// no structure / blue-sky) — in which case there is no location penalty.
export function structuralRoom(side, entry, taMetadata, {
  tfs = STRUCT_TFS, shelfPct = STRUCT_SHELF_PCT
} = {}) {
  if (!(entry > 0) || !taMetadata) return null;
  const levels = [];
  for (const tf of tfs) {
    const m = taMetadata[tf];
    if (!m) continue;
    const arr = side === 'LONG' ? m.swingHighs : m.swingLows;
    if (Array.isArray(arr)) for (const p of arr) if (p > 0) levels.push(p);
    const ext = side === 'LONG' ? m.swingHigh : m.swingLow;
    if (typeof ext === 'number' && ext > 0) levels.push(ext);
  }
  // Only levels IN FRONT of the entry matter (the path to profit). Dedupe: each
  // TF contributes BOTH its swingHighs array AND its single swingHigh (which is
  // usually ALSO the last array element), so the nearest level often appears
  // twice — which would make a LONE level look like a 2-member "shelf". Collapse
  // exact duplicates so `shelf` only fires on genuinely DISTINCT clustered swings.
  const aheadFilter = side === 'LONG' ? (p => p > entry) : (p => p < entry);
  const ahead = [...new Set(levels)].filter(aheadFilter);
  if (!ahead.length) return null;            // nothing overhead → free run (breakout)
  const nearest = side === 'LONG' ? Math.min(...ahead) : Math.max(...ahead);
  const roomPct = Math.abs((nearest - entry) / entry) * 100;
  // Shelf = ≥2 DISTINCT levels clustered within shelfPct% of the nearest one
  // (a double-top/bottom or a multi-touch wall — far stronger than one swing).
  const cluster = ahead.filter(p => Math.abs((p - nearest) / nearest) * 100 <= shelfPct);
  return { roomPct: Number(roomPct.toFixed(2)), shelf: cluster.length >= 2, level: nearest };
}

// ── Manipulation-risk score (NOX's low-cap pump-and-dump filters) ────────────
// Thin low-caps get pumped on tiny volume then dumped −90%. The tells: futures
// volume >> spot (leverage stacked), 24h volume approaching/exceeding market cap
// (inorganic), low circulating float (easy to move), and a few wallets holding
// most of the supply. This rolls them into a 0..1 risk score. Downstream the
// conductor uses it to DE-WEIGHT TA (noise on a manipulated chart), PENALISE a
// LONG (don't be late-FOMO into the pump) and BOOST a SHORT (fade the dump).
// Pure + testable. All inputs optional — missing ones just don't contribute.
const MANIP_GUARD        = process.env.MANIP_GUARD !== '0';            // default ON
const MANIP_TA_DEWEIGHT  = numEnv('MANIP_TA_DEWEIGHT', 0.6);          // at risk=1, positive TA keeps (1−0.6)=40%
const MANIP_LONG_PENALTY = numEnv('MANIP_LONG_PENALTY', 1.2);          // score subtracted from a LONG at risk=1
const MANIP_SHORT_BOOST  = numEnv('MANIP_SHORT_BOOST', 0.6);           // score added to a SHORT at risk=1

export function assessManipulation({ futuresVol, spotVol, volume, marketCap, floatPct, concentrationPct } = {}) {
  const flags = [];
  let score = 0;
  if (futuresVol > 0 && spotVol > 0) {                 // NOX #1 — futures > 2× spot = leverage stacked
    const r = futuresVol / spotVol;
    if (r >= 2)        { score += 0.35; flags.push(`futures ${r.toFixed(1)}× spot vol`); }
    else if (r >= 1.3) { score += 0.15; flags.push(`futures ${r.toFixed(1)}× spot vol`); }
  }
  if (volume > 0 && marketCap > 0) {                   // volume ≈/≥ market cap = inorganic
    const vmc = volume / marketCap;
    if (vmc >= 1)        { score += 0.30; flags.push(`24h vol ${vmc.toFixed(1)}× market cap`); }
    else if (vmc >= 0.5) { score += 0.15; flags.push(`24h vol ${Math.round(vmc * 100)}% of MC`); }
  }
  if (floatPct != null && floatPct > 0) {              // low circulating float — easy to move
    if (floatPct < 0.25)     { score += 0.25; flags.push(`float ${Math.round(floatPct * 100)}% (<25%)`); }
    else if (floatPct < 0.40) { score += 0.10; flags.push(`float ${Math.round(floatPct * 100)}%`); }
  }
  if (concentrationPct != null) {                      // supply in few hands
    if (concentrationPct >= 70)      { score += 0.25; flags.push(`top-10 hold ${Math.round(concentrationPct)}%`); }
    else if (concentrationPct >= 50) { score += 0.10; flags.push(`top-10 hold ${Math.round(concentrationPct)}%`); }
  }
  return { score: Math.min(1, Number(score.toFixed(2))), flags };
}

// Fused "pump / manipulation in progress" read. NOX's playbook is never ONE
// signal: it's several stacking at once (thin float + futures >> spot + supply
// moved to a CEX + a liquidation squeeze). Each leg already nudges the score on
// its own; this counts the CO-OCCURRING legs so the engine can treat a stack as
// one high-conviction regime (the whole > the sum of parts) instead of a few
// scattered small nudges. Returns the legs + whether the stack is a regime.
// Pure + exported for tests.
export function assessPumpRegime({ manipFlags = [], supplyShock = false, squeeze = false } = {}, minLegs = 3) {
  const legs = [...manipFlags];
  if (supplyShock) legs.push('supply → CEX');
  if (squeeze) legs.push('liquidation squeeze');
  const count = legs.length;
  return { count, legs, isRegime: count >= minLegs };
}

// Pre-pump SETUP (bullish, EARLY) — the accumulation forming BEFORE the spike, the
// mirror of assessPumpRegime's blow-off read: supply pulled OFF a CEX (float
// tightening), thin float, futures stacking (OI up), volume spiking, and shorts
// crowded (negative funding = squeeze fuel). Co-occurring legs = a setup forming.
// Returns { count, legs, isSetup }. LONG-ONLY by nature — the conductor applies it only
// to a LONG and only while NOT distributing, so it never flips/boosts a SHORT into a
// pump. Pure + exported for tests.
export function assessPrePumpSetup({ supplyOffCex = false, thinFloat = false, oiRising = false, volumeSpiking = false, shortsCrowded = false } = {}, minLegs = 2) {
  const legs = [];
  if (supplyOffCex)  legs.push('supply off CEX');
  if (thinFloat)     legs.push('thin float');
  if (oiRising)      legs.push('OI stacking');
  if (volumeSpiking) legs.push('volume spike');
  if (shortsCrowded) legs.push('shorts crowded');
  const count = legs.length;
  return { count, legs, isSetup: count >= minLegs };
}

// Phase-aware direction for a manipulation regime. The engineered pump runs in
// phases: a SQUEEZE-UP first (shorts crowded, so funding is negative, and price
// hunts the short-liquidation fuel sitting above), then a BLOW-OFF / DISTRIBUTION
// (supply leaves to CEXes, longs crowd in). Ride the squeeze early (LONG into the
// fuel), fade it late (SHORT the distribution).
//
// IMPORTANT (win-rate lesson, 2026-06-21): auto-RIDING an engineered pump means
// market-buying into a manipulated top — exactly the trade that dropped live WR
// 56%→35%. So the LONG/ride branch is OPT-IN (`ride` flag, default OFF). With ride
// off this ALWAYS fades (the safe behaviour from the best commit): manipulation =
// penalise LONG, boost SHORT. The ride read still surfaces in the alert text for
// MANUAL discretion; it just doesn't auto-flip the trade direction. Pure + tested.
export function pumpRegimeBias({ fundingAvg = null, distributing = false, squeezeFuelAbove = false, ride = true } = {}) {
  if (distributing) return 'SHORT';                                          // supply leaving = late → fade
  if (typeof fundingAvg === 'number' && fundingAvg > 0) return 'SHORT';      // longs crowded = late → fade
  if (ride && typeof fundingAvg === 'number' && fundingAvg < 0 && squeezeFuelAbove) return 'LONG';  // shorts crowded + fuel above → ride (opt-in)
  return 'SHORT';                                                            // unknown / no fuel / ride-off → conservative fade
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '');
// Token amounts span huge ranges (millions of a meme coin vs 1.5 of a blue-chip).
// Show no decimals ≥ 1000, else up to 4 significant decimals, with thousands separators.
function fmtTokenAmount(n) {
  const x = Number(n);
  if (!isFinite(x)) return '?';
  if (x >= 1000) return Math.round(x).toLocaleString('en-US');
  if (x >= 1)    return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return x.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

// HIGH-RISK exhaustion-reversal SHORT detector (pure, unit-testable). True when
// a FAVORED (watchlist) token is extremely overbought on a high TF (daily OR
// weekly RSI ≥ 80) AND the 5m has rolled over (MACD trend down) — a blow-off top
// starting to crack. This is the one case allowed to override the confirm gate's
// "never short an overbought 4h/daily" veto + the counter-trend alignment cap,
// and it tags the signal HIGH RISK. SHORT-only by request (alt blow-offs dump).
//
// Loosened 2026-06-02 from "5m AND 1h both down" to "5m down" only: the strict
// version never fired on violent vertical dumps (the LABUSDT +80%→crash — its 1h
// stayed bullish the whole way up, so the top broke faster than the 1h could
// roll). 5m-confirmation catches the crack earlier. TRADE-OFF: fires more (and
// earlier) reversal shorts → more risk of fading a move that keeps ripping.
// Watch it — kill-switch ENABLE_EXHAUSTION_REVERSAL=0. See [[signal-tuning-philosophy]].
export function isExhaustionReversalShort(side, favored, taMetadata) {
  if (side !== 'SHORT' || !favored || !taMetadata) return false;
  const rsiDaily = taMetadata['daily']?.rsi;
  const rsiWeek  = taMetadata['1week']?.rsi;
  const stretched = (typeof rsiDaily === 'number' && rsiDaily >= 80)
                 || (typeof rsiWeek  === 'number' && rsiWeek  >= 80);
  if (!stretched) return false;
  // The 5m must have flipped down — momentum has started to turn, so we're
  // shorting the crack, not the still-ripping push.
  return taMetadata['5min']?.trend === 'down';
}

// Mirror of isExhaustionReversalShort — a capitulation-bottom LONG. True when a
// FAVORED (watchlist) token is extremely OVERSOLD on a high TF (daily OR weekly
// RSI ≤ 20) AND the 5m has turned UP — a capitulation bottom starting to bounce.
// Overrides the confirm gate's "too oversold to LONG" veto + the counter-trend
// alignment cap, HIGH RISK tagged. OWN kill-switch (ENABLE_EXHAUSTION_REVERSAL_
// LONG). Same falling-knife risk profile as the short, but LONG is the stronger
// side (80% vs 45%). See [[signal-tuning-philosophy]].
export function isExhaustionReversalLong(side, favored, taMetadata) {
  if (side !== 'LONG' || !favored || !taMetadata) return false;
  const rsiDaily = taMetadata['daily']?.rsi;
  const rsiWeek  = taMetadata['1week']?.rsi;
  const capitulated = (typeof rsiDaily === 'number' && rsiDaily <= 20)
                   || (typeof rsiWeek  === 'number' && rsiWeek  <= 20);
  if (!capitulated) return false;
  // The 5m must have turned UP — the bounce has started, so we're buying the
  // reclaim, not catching the still-falling knife mid-air.
  return taMetadata['5min']?.trend === 'up';
}

// Conductor: proactive multi-trigger signal engine.
//
// Every detected event — CEX hot↔cold flow, 1m price surge, or large
// liquidation — immediately pulls the *complete* market context for that
// ticker (current funding, OI, recent same-token flow/surge/liquidation
// history) and scores the confluence. If the score crosses MIN_SIGNAL_SCORE,
// an enriched signal is emitted. This replaces the old Correlator pattern
// which only fired when two specific event types coincided.
//
// Scoring weights (rough caps):
//   trigger base      1.0–2.0
//   funding alignment ±2.0
//   OI alignment      ±0.5
//   prior aligned flow         +1.0
//   prior aligned surge        +0.5
//   prior aligned liquidation  +1.0
//   cold-wallet inflow ≥ 1% supply  +1.0
//   Plausible total: 0 .. 6+

const HOUR = 60 * 60 * 1000;
const HALF_HOUR = 30 * 60 * 1000;

export class Conductor extends EventEmitter {
  constructor({
    universe,
    prices,
    funding,
    liquidations,
    onchainSources,
    taService = null,
    liquidityClusters = null,
    liquidationHeatmap = null,      // optional LiquidationHeatmap (leverage-liq magnet zones)
    teamDiscovery = null,           // optional TeamWalletDiscovery (holder-concentration lookup)
    minSignalScore = 3.0,
    minSignalScorePinned = null,    // defaults to 0.85 × minSignalScore (e.g. 2.55 vs 3.0)
    // Observation floor bumped from 1.0 → 2.0 — at 1.0 the bot was emitting
    // a torrent of "👀 Watching LOW 53% confidence" alerts on every surge,
    // burying real signals in noise. Score ≥ 2.0 means at least one strong
    // edge (e.g. funding alignment + minor TA) before the user is pinged.
    minObservationScore = 2.0,
    // Flow trigger min-USD raised 500k → 1M (audit §6.8) — flow is the worst
    // trigger (42%); a higher bar filters the order-book-noise tier. Favored
    // tokens still fire at 0.25× this ($250k) via effectiveMinFlow in #onFlow.
    minFlowUsd = 1_000_000,
    cooldownMs = 30 * 60_000,
    flowHistoryMs = HOUR,
    surgeHistoryMs = HALF_HOUR,
    liqHistoryMs = HOUR,
    // Advisory-leverage risk basis: a full stop-out at the suggested leverage
    // (full margin) costs ~this % of the account. Single documented constant
    // (audit §3.16/§3.17) — kept at 2 so displayed leverage is unchanged.
    levRiskBasis = 2,
    // Confirmation-gate drop threshold (audit §3.4/§6.5). Net tally at/below
    // this drops the signal. Loosened from −1.0 → −2.5; env-tunable.
    confirmDropThreshold = -2.5,
    // Global BTC-regime filter (item G). Penalty for a signal that fights BTC's
    // macro trend (the biggest single source of "right setup, wrong market"
    // losses on alts). 0 disables the regime effect even if a monitor is wired.
    regimeMonitor = null,
    regimePenalty = 1.0,
    // HIGH-RISK exhaustion-reversal shorts (watchlist-only): override the
    // "never short an overbought 4h/daily" veto when a favored token blows off
    // and the fast TFs roll over, so the bot CAN fade a confirmed top (the LAB
    // dump). Kill-switch — counter-trend by design; set ENABLE_EXHAUSTION_REVERSAL=0
    // to disable if the reversal shorts hurt the win-rate.
    enableExhaustionReversal = true,
    // Symmetric reversal LONG (capitulation-bottom buy) — own kill-switch so it
    // runs independently of the short. ENABLE_EXHAUSTION_REVERSAL_LONG=0 disables.
    enableExhaustionReversalLong = true,
    // Emit "👀 Watching … Funding extreme" observations? These radar entries
    // (funding alone, needs confluence) were noisy, so they default OFF — a
    // funding extreme WITH confluence still fires as a real signal regardless.
    observeFundingExtreme = false,
    verbose = false,
  }) {
    super();
    this.universe = universe;
    this.verbose = verbose;
    this.observeFundingExtreme = observeFundingExtreme;
    this.prices = prices;
    this.funding = funding;
    this.liquidations = liquidations;
    this.onchainSources = onchainSources;
    this.taService = taService;
    this.liquidityClusters = liquidityClusters;     // optional LiquidityClusters
    this.liquidationHeatmap = liquidationHeatmap;    // optional LiquidationHeatmap
    this.teamDiscovery = teamDiscovery;              // optional holder-concentration lookup
    this.signalTracker = null;                       // wired post-construction via setSignalTracker
    this.minSignalScore = minSignalScore;
    this.minSignalScorePinned = minSignalScorePinned ?? (minSignalScore * 0.85);
    this.minObservationScore = minObservationScore;
    this.minFlowUsd = minFlowUsd;
    this.levRiskBasis = levRiskBasis;
    this.confirmDropThreshold = confirmDropThreshold;
    this.regimeMonitor = regimeMonitor;
    this.regimePenalty = regimePenalty;
    this.enableExhaustionReversal = enableExhaustionReversal;
    this.enableExhaustionReversalLong = enableExhaustionReversalLong;
    this.cooldownMs = cooldownMs;
    this.flowHistoryMs = flowHistoryMs;
    this.surgeHistoryMs = surgeHistoryMs;
    this.liqHistoryMs = liqHistoryMs;

    // Symbol → array of recent events. Pruned periodically.
    this.flowsByToken = new Map();         // SYMBOL → [{ flow, usd, ts }]
    this.surgesByCgId = new Map();         // cgId  → [{ surge, ts }]
    this.liquidationsByToken = new Map();  // SYMBOL → [{ event, ts }] (short-term, for prior-liq bonus)
    this.liqClustersByToken = new Map();   // SYMBOL → [{ ts, price, longUsd, shortUsd }] (24h, for cluster magnets)

    // CEX-distribution aggregation (the SKYAI watch). Hot→external/cross-exchange
    // outflows are noise individually; a CONCENTRATED stream for one token is a
    // distribution-watch. cgId → [{ usd, ts, dest, exchange }]; fires a WATCH
    // alert (never auto-traded). Env-tunable; defaults are conservative.
    this.distributionByCgId = new Map();
    this.lastDistAlertAt = new Map();
    // FDV ceiling shared by the flow + distribution paths. On-chain CEX flows only
    // have an edge on small, manipulable tokens; a hot-wallet outflow on a high-FDV
    // major (AAVE/PAXG/ASTER) is exchange ops / OTC, not insider distribution. Skip
    // those names. FDV-unknown tokens fall through (don't block on missing data).
    this.flowMaxFdvUsd = numEnv('FLOW_MAX_FDV_USD', 500_000_000);
    // Insider SELL must be material vs the token's mcap to count as distribution
    // (a $75k sell on $1.2B ENA is noise). Floor = max($50k, this% × mcap).
    this.teamFlowMinMcapPct = numEnv('TEAM_FLOW_MIN_MCAP_PCT', 0.0003);   // 0.03% of mcap
    // Liquidation base reaches full +2.0 at this fraction of OI; below it the base
    // tapers toward 0.5 so a trivial-%-of-OI liq (e.g. $309k on BTC) can't carry a signal.
    this.liqBaseFullOi = numEnv('LIQ_BASE_FULL_OI', 0.003);              // 0.3% of OI
    // Cumulative-cascade base: same-side liquidations on a symbol within this
    // window are summed; the base hits full +2.0 at this cumulative USD. Lets a
    // genuine major-coin cascade (tiny % of OI but $Ms stacking in minutes) fire,
    // which the %-of-OI base alone misses (the BTC/ETH cascade the user expected).
    this.liqCascadeWindowMs = numEnv('LIQ_CASCADE_WINDOW_MIN', 5) * 60_000;
    this.liqCascadeFullUsd = numEnv('LIQ_CASCADE_FULL_USD', 2_000_000);
    // Fused manipulation-regime detector: when this many manipulation legs stack
    // (float / futures>spot / vol>mcap / concentration / supply→CEX / squeeze) it's
    // treated as a coordinated pump → a co-occurrence conviction bonus (capped),
    // SHORT-favoring (fade the engineered move). 0 bonus disables.
    this.pumpRegimeMinLegs = numEnv('PUMP_REGIME_MIN_LEGS', 3);
    this.pumpRegimeMaxBonus = numEnv('PUMP_REGIME_MAX_BONUS', 1.0);
    // Pre-pump SETUP (bullish, EARLY accumulation). OPT-IN (=== '1') in this combined
    // bot so the win-rate A/B stays clean; the FA-only bot defaults it on. Capped,
    // LONG-only, confluence-only (can't fire a signal alone).
    this.enablePrePump  = process.env.ENABLE_PREPUMP === '1';
    this.prePumpMinLegs = numEnv('PREPUMP_MIN_LEGS', 2);
    this.prePumpMaxPts  = numEnv('PREPUMP_MAX_PTS', 1.0);
    // Liquidation-heatmap magnet: minimum cluster notional to use as a scoring
    // bump and as a counter-trend ENTRY target (where stops actually sit).
    this.liqMagnetMinUsd = numEnv('LIQ_MAGNET_MIN_USD', 1_000_000);
    this.liqMagnetMaxPts = numEnv('LIQ_MAGNET_MAX_PTS', 0.9);
    // Liquidity-SWEEP reversal ("take liquidity both sides"): after price sweeps a
    // sizable liq cluster on one side, it often reverses to hunt the other side.
    // A FRESH sweep that favours the trade's FADE direction adds a bounded,
    // confluence-only bonus (never fires alone). Detection lives in the heatmap.
    this.liqSweepDetect  = process.env.LIQ_SWEEP_DETECT !== '0';      // default ON
    this.liqSweepMaxPts  = numEnv('LIQ_SWEEP_MAX_PTS', 0.8);
    this.liqSweepMinUsd  = numEnv('LIQ_SWEEP_MIN_USD', 1_000_000);
    this.liqSweepMaxAgeMs = numEnv('LIQ_SWEEP_MAX_AGE_MIN', 30) * 60_000;
    // Liquidation SIGNAL gate. A liquidation is a tradeable SQUEEZE on a LIQUID major
    // (BTC/ETH/top perps) and manipulation-bait on an illiquid small-cap. On a liquid
    // market a detected liquidation gets a strong base (liqMajorBaseFloor — restores
    // the 2a110ea flat-+2.0 behaviour the %-of-OI demotion broke, the "I get liq
    // notifications but never a signal" bug) and can reach signal grade; on an illiquid
    // one it's damped to liqIlliquidCap and stays a notification (the user's
    // "don't get me rekt on small-cap liqs" guard). Liquid = OI ≥ minOi OR mcap ≥ minMc.
    this.liqSignalMinOiUsd = numEnv('LIQ_SIGNAL_MIN_OI_USD', 30_000_000);
    this.liqSignalMinMcUsd = numEnv('LIQ_SIGNAL_MIN_MC_USD', 1_000_000_000);
    this.liqMajorBaseFloor = numEnv('LIQ_MAJOR_BASE_FLOOR', 2.0);
    this.liqIlliquidCap    = numEnv('LIQ_ILLIQUID_CAP', 0.4);
    // Brand-new listings register their perp seconds-to-a-minute after the alert, so
    // retry the perp lookup (fresh, cache-bypassing) before evaluating, or the listing
    // fires perp-less and never auto-trades (the ARX case). retries × retryMs ≈ wait.
    this.listingPerpRetries = numEnv('LISTING_PERP_RETRIES', 6);
    this.listingPerpRetryMs = numEnv('LISTING_PERP_RETRY_SEC', 15) * 1000;
    this.distWindowMs    = Number(process.env.DIST_WINDOW_MIN ?? 120) * 60_000;   // 2h
    this.distMinUsd      = Number(process.env.DIST_MIN_USD ?? 500_000);
    this.distMinVolPct   = Number(process.env.DIST_MIN_VOL_PCT ?? 4);             // % of 24h vol
    this.distMinTransfers = Number(process.env.DIST_MIN_TRANSFERS ?? 5);
    this.distCooldownMs  = Number(process.env.DIST_COOLDOWN_MIN ?? 120) * 60_000;
    // LONG vs active-distribution reconciliation: an insider SELL / distribution
    // on a token within this window heavily penalises a LONG on it (the NFP
    // "insiders dump $518k while the bot fires LONG" contradiction). Penalty is the
    // base + a materiality bonus scaled by dump size vs market cap. 0 pts = off.
    this.distConflictWindowMs = Number(process.env.DIST_CONFLICT_MIN ?? 90) * 60_000;
    this.distConflictPts = Number(process.env.DIST_CONFLICT_PTS ?? 1.5);

    // Per-token last-fired timestamp to suppress duplicate alerts.
    this.lastFiredAt = new Map();           // SYMBOL → ts

    // Recent SL hits — used to suppress same-side signals when the bot
    // would otherwise re-enter at essentially the same price level it
    // just got stopped out of. We track the entry price of the loss so a
    // NEW setup at a meaningfully-different level CAN still fire.
    this.recentLosses = new Map();          // SYMBOL → { side, ts, entry }
    this.postLossMinCooldownMs = 30 * 60_000;       // hard 30min after every loss (let the move play out)
    this.postLossExtendedCooldownMs = 4 * 60 * 60_000;  // 4h if same price area
    this.postLossPriceDistPct = 3;          // % move from loss entry to count as a "new setup"

    // Reverse lookup symbol → cgId built lazily.
    this._symbolToCgId = null;
  }

  start() {
    for (const src of this.onchainSources) {
      src.on('flow', (flow) => { try { this.#onFlow(flow); } catch (err) { console.error('[conductor] onFlow err:', err.message); } });
    }
    this.prices.on('surge', (surge) => {
      // #onSurge is async (volume confirmation fetch) — use promise handling
      // so errors past the first await still surface in logs.
      Promise.resolve(this.#onSurge(surge)).catch(err => console.error('[conductor] onSurge err:', err.message));
    });
    if (this.liquidations) {
      this.liquidations.on('liquidation', (ev) => { try { this.#onLiquidation(ev); } catch (err) { console.error('[conductor] onLiquidation err:', err.message); } });
    }
    setInterval(() => this.#cleanup(), 60_000).unref();
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  #onFlow(flow) {
    // Stable filter — USD/EUR-pegged tokens never make for tradeable
    // moves. A 0.03% wobble around the peg should not fire a signal.
    if (isStableSymbol(flow.token.symbol)) return;

    // Distribution candidates (hot→external streams) are AGGREGATE-only: they go
    // to their own windowed detector and never into the normal flow path (which
    // would treat each tiny withdrawal as confluence). Watch alert, not a trade.
    if (flow.distribution) { this.#onDistributionFlow(flow); return; }

    const usd = this.#usdValue(flow.token, flow.amount);
    this.#recordFlow(flow, usd);

    if (!flow.direction) return;                       // unlabeled hot/cold → observation only

    // Team-flow MATERIALITY. A rank-#17 insider sending $4,147 (the ZBT case) or
    // a rank-#21 holder dumping $75k of a $1.2B token (the ENA case) is NOT a
    // meaningful distribution event — it's noise relative to the token's size.
    // The floor scales with market cap: max($50k, 0.03% × mcap). A $75k sell on
    // $1.2B ENA → floor ~$360k → demoted; the same $75k on a $20M cap → floor
    // $50k → kept (a real dump). Below the floor we strip the teamFlow flag so
    // it's evaluated as an ordinary flow (which the FDV ceiling then filters out
    // for the large caps). Keeps "a real insider dump on any token counts" while
    // killing the mega-cap noise that was producing fake VERY-HIGH shorts.
    const tokenInfo = this.universe.lookupByCgId(flow.token.coingeckoId);
    const MIN_TEAM_FLOW_USD = teamSellMaterialFloorUsd(tokenInfo?.marketCap, { minMcapPct: this.teamFlowMinMcapPct });
    if (flow.teamFlow && usd !== null && usd < MIN_TEAM_FLOW_USD) {
      if (this.verbose) console.log(`[conductor] team flow ${flow.token.symbol} $${usd.toFixed(0)} < material $${MIN_TEAM_FLOW_USD.toFixed(0)} (mcap-relative) — demoting to ordinary flow`);
      flow = { ...flow, teamFlow: null };
    }

    // ONLY team SELL flows (insider → CEX) bypass the FDV ceiling AND the
    // min-USD filter — that's the high-conviction "distribution incoming"
    // signal where the supply is leaving custody for sale regardless of
    // token cap. Team BUY flows (CEX → insider) are far weaker — could just
    // be the insider topping up gas, refunding from a closed position, etc.
    // — and fall through to the normal FDV/min-USD gates.
    const isTeamSell = flow.teamFlow?.side === 'sell';

    // Raw "insider sell" transfer alert — emitted IN ADDITION to whatever trade
    // signal (if any) the confluence engine produces below. The moment a
    // qualified insider sell is observed we surface the labelled transfer
    // (token amount, USD, network, venue, explorer link) so the operator sees
    // the on-chain dump in real time even if TA/structure don't reach a signal.
    if (isTeamSell) this.#emitInsiderSell(flow, usd);

    if (!isTeamSell) {
      // FDV ceiling for ordinary CEX-flow signals. Mega-cap and mature
      // tokens (BTC, ETH, BNB, SOL...) don't move on a single hot↔cold
      // transfer — the order book absorbs it. Empirically: tokens ≥ $500M
      // FDV produce mostly noise. Skip them and let surge / funding /
      // liquidation triggers do the work for these names. Falls through
      // if FDV is unknown — don't block on missing data.
      const universeInfo = this.universe.lookupByCgId(flow.token.coingeckoId);
      const fdv = universeInfo?.fdv;
      if (typeof fdv === 'number' && fdv >= this.flowMaxFdvUsd) {
        if (this.verbose) console.log(`[conductor] skip flow ${flow.token.symbol} — FDV $${(fdv/1e6).toFixed(0)}M ≥ $${(this.flowMaxFdvUsd/1e6).toFixed(0)}M`);
        return;
      }

      // Favored tokens (pinned + current hot movers) fire on smaller flows —
      // a $150k flow on a small-cap watchlist/mover can be as meaningful as a
      // $500k flow on a top-100 token.
      const favored = this.universe.isFavored?.(flow.token.coingeckoId);
      const effectiveMinFlow = favored ? this.minFlowUsd * 0.25 : this.minFlowUsd;
      // A flow with no USD value (token has no price cached yet) can't be sized
      // and previously slipped PAST the gate because the `usd !== null` guard
      // short-circuited (audit §5, conductor.js:158). Skip it — an unsizable
      // flow shouldn't fire a signal whose entire base scales with USD.
      if (usd === null || usd < effectiveMinFlow) return;
    } else if (this.verbose) {
      console.log(`[conductor] team SELL flow on ${flow.token.symbol} — bypassing FDV/USD filters`);
    }

    const side = flow.direction.toUpperCase();
    this.#evaluateAndMaybeEmit({
      token: flow.token,
      side,
      trigger: { type: 'flow', value: flow, usd }
    });
  }

  // Aggregate hot→external/cross-exchange outflows per token. When the cumulative
  // becomes ABNORMAL (vs the token's own 24h volume), emit a 'distribution' WATCH
  // event — judgment-required market intel, NEVER routed to autotrade. (A burst
  // of outflows can be a real dump OR a non-selling sub-wallet/OTC move, so we
  // surface the data + a caution and let the operator decide — the SKYAI/LAB
  // lesson.) See src/distribution.js.
  #onDistributionFlow(flow) {
    const cgId = flow.token?.coingeckoId;
    if (!cgId) return;
    const usd = this.#usdValue(flow.token, flow.amount);
    if (usd == null || !(usd > 0)) return;
    // FDV ceiling — distribution only has an edge on small, easily-manipulated
    // tokens. A $1M Binance outflow on a high-FDV major (AAVE, PAXG, ASTER) is
    // exchange operations / OTC, not insider distribution — skip it so it never
    // accumulates into a (noise) SHORT signal. Same ceiling as the flow path.
    const distInfo = this.universe?.lookupByCgId?.(cgId);
    if (typeof distInfo?.fdv === 'number' && distInfo.fdv >= this.flowMaxFdvUsd) {
      if (this.verbose) console.log(`[distribution] skip ${flow.token?.symbol} — FDV $${(distInfo.fdv / 1e6).toFixed(0)}M ≥ $${(this.flowMaxFdvUsd / 1e6).toFixed(0)}M ceiling`);
      return;
    }
    const now = Date.now();
    const arr = this.distributionByCgId.get(cgId) ?? [];
    arr.push({ usd, ts: now, dest: flow.toName ?? flow.toType ?? 'external', exchange: flow.exchange });
    while (arr.length && now - arr[0].ts > this.distWindowMs) arr.shift();   // prune to window
    this.distributionByCgId.set(cgId, arr);

    const vol24h = this.prices?.get24hVolume?.(cgId) ?? null;
    const a = assessDistribution(arr, {
      now, windowMs: this.distWindowMs, vol24h,
      minUsd: this.distMinUsd, minVolPct: this.distMinVolPct, minTransfers: this.distMinTransfers
    });
    if (!a) return;

    const last = this.lastDistAlertAt.get(cgId);
    if (last && now - last < this.distCooldownMs) return;       // one alert per episode
    this.lastDistAlertAt.set(cgId, now);

    // Top destinations in the window (for the operator's judgment).
    const destCounts = new Map();
    for (const e of arr) destCounts.set(e.dest, (destCounts.get(e.dest) ?? 0) + 1);
    const topDestinations = [...destCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([d, c]) => `${d}×${c}`);

    console.log(`[distribution] ${flow.token.symbol} — $${Math.round(a.cumulativeUsd).toLocaleString()} out in ${a.count} transfers${a.volPct != null ? ` (${a.volPct.toFixed(1)}% of 24h vol)` : ''} → ${topDestinations.join(', ')}`);
    // Route through the conductor as a real SHORT SIGNAL (with a trade plan the
    // operator can act on), NOT a bare watch. It still runs TA/structure, so it
    // fires as a SIGNAL when price/TA confirm the distribution and a 👀
    // observation when they don't (don't short an uptrend on outflows alone —
    // the LAB fake-out). NEVER auto-traded (the autotrader skips trigger
    // type=distribution). Fire-and-forget; #onFlow is sync.
    this.evaluateDistributionTrigger(flow.token, {
      exchange: flow.exchange,
      cumulativeUsd: a.cumulativeUsd,
      count: a.count,
      volPct: a.volPct,
      windowMins: Math.round(this.distWindowMs / 60_000),
      topDestinations
    }).catch(err => console.warn(`[distribution] eval ${flow.token.symbol} failed: ${err.message}`));
  }

  // Build + emit the raw insider-sell transfer alert. De-duped per tx hash so a
  // single transfer never alerts twice (the same log can be re-seen across
  // overlapping block polls). Fire-and-forget through the 'insiderSell' event,
  // which index.js broadcasts via notifier.sendInfo().
  #emitInsiderSell(flow, usd) {
    const tx = flow.txHash;
    if (tx) {
      if (!this._seenInsiderTx) this._seenInsiderTx = new Set();
      if (this._seenInsiderTx.has(tx)) return;
      this._seenInsiderTx.add(tx);
      if (this._seenInsiderTx.size > 4000) this._seenInsiderTx.clear();   // bound memory
    }
    try {
      const text = this.#formatInsiderSell(flow, usd);
      this.emit('insiderSell', { flow, usd, text });
    } catch (err) {
      if (this.verbose) console.warn(`[conductor] insiderSell format err: ${err.message}`);
    }
  }

  #formatInsiderSell(flow, usd) {
    const tf = flow.teamFlow ?? {};
    const sym = flow.token?.symbol ?? tf.tokenSymbol ?? '?';
    const chain = flow.chain ?? flow.token?.chain;
    const net = NETWORK_LABEL[chain] ?? (chain ? chain[0].toUpperCase() + chain.slice(1) : 'on-chain');
    // Venue: a DEX pool (on-chain dump) or a CEX (deposited for sale).
    const venue = tf.venue === 'dex'
      ? `${flow.exchange ?? tf.venueLabel ?? 'a DEX'} (DEX)`
      : `${flow.exchange ?? 'an exchange'} (CEX deposit)`;

    const amtStr = fmtTokenAmount(flow.amount);
    const usdStr = usd != null && usd > 0
      ? ` (~$${Math.round(usd).toLocaleString('en-US')})`
      : '';
    const rankBits = [];
    if (tf.holderRank != null) rankBits.push(`#${tf.holderRank}`);
    if (tf.holderPercent != null) rankBits.push(`${Number(tf.holderPercent).toFixed(2)}% of supply`);
    const who = rankBits.length ? `Insider ${rankBits.join(' · ')}` : 'Tracked insider';
    const hopNote = tf.hops > 0 ? ` _(via ${tf.hops} hop${tf.hops > 1 ? 's' : ''} — laundered through fresh wallet${tf.hops > 1 ? 's' : ''})_` : '';

    const from = flow.fromAddress;
    const walletLine = from ? `• Wallet: \`${shortAddr(from)}\`` : null;
    const txLink = explorerTxLink(chain, flow.txHash);
    const walletLink = explorerAddrLink(chain, from);

    const lines = [
      `🔴 *Insider Sell Detected* — *$${sym}*`,
      `${who} is selling${hopNote}`,
      ``,
      `• Amount: *${amtStr} ${sym}*${usdStr}`,
      `• Network: ${net}`,
      `• Venue: ${venue}`,
      walletLine,
      walletLink ? `• [Seller wallet ↗](${walletLink})` : null,
      txLink ? `• [View transaction ↗](${txLink})` : null
    ].filter(Boolean);
    return lines.join('\n');
  }

  async #onSurge(surge) {
    if (isStableSymbol(surge.token?.symbol)) return;   // defensive: prices.js already filters
    this.#recordSurge(surge);
    const side = surge.direction === 'up' ? 'LONG' : 'SHORT';
    const tokenInfo = this.universe.lookupByCgId(surge.token.coingeckoId);
    const enrichedToken = tokenInfo ? {
      ...surge.token,
      chain: this.#guessChain(tokenInfo)
    } : surge.token;

    // Volume confirmation: a 3% move with low 1m volume is a wick, not a
    // move. Suppress surge evaluation when volume is < 1.5× the 60-bar avg.
    // When > 3× avg, attach `volumeBoost` to the trigger so #evaluate can
    // upweight the surge.
    let volumeBoost = 0, volumeRatio = null;
    if (this.taService?.getVolumeRatio) {
      try {
        const v = await this.taService.getVolumeRatio(enrichedToken.symbol);
        if (v?.ratio != null) {
          volumeRatio = v.ratio;
          if (v.ratio < 1.5) {
            console.log(`[surge] suppressed ${enrichedToken.symbol} — 1m volume ${v.ratio.toFixed(2)}× avg (< 1.5× threshold)`);
            return;
          }
          if (v.ratio >= 3.0) {
            volumeBoost = 0.5;
            console.log(`[surge] ${enrichedToken.symbol} HIGH volume ${v.ratio.toFixed(2)}× avg — +0.5 bonus`);
          } else if (v.ratio >= 2.0) {
            volumeBoost = 0.3;
          }
        }
        // null result (no perp coverage) → fall through without gating
      } catch (err) {
        console.warn(`[surge] volume ratio check failed for ${enrichedToken.symbol}: ${err.message}`);
      }
    }

    await this.#evaluateAndMaybeEmit({
      token: enrichedToken,
      side,
      trigger: { type: 'surge', value: { ...surge, volumeBoost, volumeRatio } }
    });
  }

  #onLiquidation(ev) {
    this.#recordLiquidation(ev);
    const cgId = this.#findCgIdForSymbol(ev.symbol);
    // Not in the CoinGecko universe → can't build a trade plan (no price/TA), so
    // this liquidation can't become a SIGNAL. Log it (not silent) so a missing
    // liquidation signal is diagnosable instead of vanishing.
    if (!cgId) { if (this.verbose) console.log(`[conductor] liquidation ${ev.symbol} ($${Math.round((ev.usd ?? 0)/1000)}K) — no cgId in universe, dropped (no signal)`); return; }
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) { if (this.verbose) console.log(`[conductor] liquidation ${ev.symbol} — cgId ${cgId} not in universe lookup, dropped`); return; }
    const token = {
      symbol: ev.symbol,
      coingeckoId: cgId,
      chain: this.#guessChain(tokenInfo)
    };
    const side = ev.bias.toUpperCase();
    // #onLiquidation is sync but #evaluateAndMaybeEmit is async, so the outer
    // try/catch on the listener can't catch a rejection here — a thrown error would
    // escape as an UNHANDLED rejection (exactly how the `token is not defined` bug
    // surfaced). Catch it so one bad liquidation can never crash-spam the logs.
    this.#evaluateAndMaybeEmit({
      token,
      side,
      trigger: { type: 'liquidation', value: ev }
    }).catch(err => console.warn(`[conductor] liquidation eval ${ev.symbol} failed: ${err.message}`));
  }

  // Wire the SignalTracker after construction (it's created later in the
  // index.js boot sequence). Conductor uses it to check open-position state
  // before firing duplicate signals on tokens already in the trade book.
  setSignalTracker(tracker) {
    this.signalTracker = tracker;
  }

  // Public entry point — index.js calls this from the signal-tracker's
  // 'resolved' event whenever a signal closes. We only care about losses
  // (SL hits and time-expired losses) — those mean the side was wrong for
  // a while, so suppress same-side re-entries for postLossCooldownMs.
  recordLoss(sig) {
    if (!sig?.symbol || !sig?.side) return;
    const isLoss = sig.outcome === 'LOSS' || sig.outcome === 'EXPIRED_LOSS';
    if (!isLoss) return;
    this.recentLosses.set(sig.symbol, {
      side: sig.side,
      ts: Date.now(),
      entry: sig.entry ?? null    // for price-distance suppression
    });
  }

  // Public entry point: on-demand analysis for the /analyze chat command.
  // Picks the dominant side (LONG vs SHORT) from multi-TF TA, then runs the
  // full Conductor scoring on that side — same machinery as a real signal
  // except there is no triggering event, so the "trigger base" component is
  // zero. The score therefore reflects pure market context: funding alignment,
  // OI behavior, recent flows/surges/liquidations, funding velocity, supplyPct,
  // and multi-TF TA. Returns a signal-shaped object (token, side, reasons,
  // strength, currentPrice, tradePlan) so the formatter can render it just
  // like a real alert.
  async evaluateForAnalysis({ symbol, holdings = null, allowFetch = false }) {
    if (isStableSymbol(symbol)) return null;   // /analyze on a stable returns nothing
    let cgId = this.#findCgIdForSymbol(symbol);
    // On-demand: a token OUTSIDE the top-N universe + watchlist can still be
    // analyzed one-time — resolve it on CoinGecko and load its metadata WITHOUT
    // pinning or persisting (evicted on the next rebuild). Lets /analyze read any
    // recognized token, not just the tracked set. TA still needs a Bybit/perp.
    if (!cgId && allowFetch && this.universe?.ensureBySymbol) {
      const t = await this.universe.ensureBySymbol(symbol).catch(() => null);
      if (t?.coingeckoId) cgId = t.coingeckoId;
    }
    if (!cgId) return null;
    const universeInfo = this.universe.lookupByCgId(cgId);
    if (!universeInfo) return null;
    const token = {
      symbol: universeInfo.symbol,
      name: universeInfo.name,
      coingeckoId: cgId,
      chain: this.#guessChain(universeInfo)
    };

    // Run TA for both sides in parallel — they share the OHLCV cache so the
    // second one's API cost is ~zero.
    let longTa = null, shortTa = null;
    if (this.taService) {
      [longTa, shortTa] = await Promise.all([
        this.taService.analyze(token.symbol, 'LONG'),
        this.taService.analyze(token.symbol, 'SHORT')
      ]);
    }

    // Build a FULL evaluation for each side — including funding alignment,
    // FDV overhang, supply impact, etc. Then pick whichever has the higher
    // final score. (Previously side was picked from TA findings alone, then
    // evaluated — that's why /analyze on INX showed "LONG bias -2.06" even
    // though SHORT was the correct read.)
    // Fetch the orderbook heatmap ONCE — the same walls feed both sides' scoring
    // AND the winner's TP placement. This is the fix for "the heatmap isn't used
    // in /analyze": the event path scored walls, the analyze/movers path didn't.
    const heatmap = await this.#fetchHeatmap(token.symbol);

    const trigger = { type: 'manual', value: { reason: 'on-demand analysis' } };
    const buildSide = (sideLabel, taResult) => {
      const ctx = this.#gatherContext({ token, side: sideLabel, trigger });
      // TA findings + orderbook-heatmap findings (support/resistance walls).
      ctx.taFindings = [ ...(taResult?.findings ?? []), ...this.#heatmapFindings(heatmap, sideLabel) ];
      // Price-direction reference for OI scoring (§3.9) from the 1h/4h trend.
      const trendDir = taResult?.metadata?.['1hour']?.trend ?? taResult?.metadata?.['4hour']?.trend;
      if (trendDir === 'up' || trendDir === 'down') ctx.priceDir = trendDir;
      const ev = this.#evaluate(ctx);
      // Apply holdings scoring on this side
      if (holdings) {
        const pct = holdings.pctOfSupply ?? 0;
        if (pct >= 5) {
          const pts = sideLabel === 'SHORT'
            ? (pct >= 15 ? 1.5 : pct >= 10 ? 1.0 : 0.6)
            : (pct >= 15 ? -1.0 : pct >= 10 ? -0.6 : -0.3);
          ev.score += pts;
          ev.reasons.push({
            kind: 'supplyPct',
            text: sideLabel === 'SHORT'
              ? `${pct.toFixed(1)}% of supply in CEX cold wallets — heavy distribution overhang`
              : `${pct.toFixed(1)}% of supply in CEX cold wallets — overhang risk against LONG`,
            points: pts
          });
        } else if (pct > 0 && pct < 1 && sideLabel === 'LONG') {
          ev.score += 0.3;
          ev.reasons.push({
            kind: 'supplyPct',
            text: `Only ${pct.toFixed(2)}% of supply in CEX cold — clean float, no overhang`,
            points: 0.3
          });
        }
        ev.strength = this.#strengthLabel(ev.score);
      }
      return { context: ctx, evaluation: ev, ta: taResult };
    };

    const longRes  = buildSide('LONG',  longTa);
    const shortRes = buildSide('SHORT', shortTa);

    // Pick the side whose total evaluation is higher
    const winnerIsLong = longRes.evaluation.score >= shortRes.evaluation.score;
    const winner = winnerIsLong ? longRes : shortRes;
    const side = winnerIsLong ? 'LONG' : 'SHORT';

    // Low conviction when both sides score similarly — neither has a clear edge
    const lowConviction = Math.abs(longRes.evaluation.score - shortRes.evaluation.score) < 0.3;

    const taMetadata = winner.ta?.metadata ?? null;
    const hmLiq = this.liquidationHeatmap?.peek?.(token.symbol);
    const liqMagnets = hmLiq ? ((side === 'SHORT' ? hmLiq.shortLiqs : hmLiq.longLiqs) ?? []) : [];
    const liqTargets = hmLiq ? ((side === 'SHORT' ? hmLiq.longLiqs : hmLiq.shortLiqs) ?? []) : [];   // PROFIT-side clusters (cascade TP3)
    const tradePlan = this.#buildTradePlan(winner.context.currentPrice, side, taMetadata, this.#tpWallsWithSweep(heatmap, side, token.symbol, winner.context.currentPrice), null, liqMagnets, liqTargets);

    // Apply trade-quality penalties on the scan/analysis path too (audit §3.2).
    // Previously these ran ONLY on the event-driven path, so movers-scan
    // signals (a large slice of volume) reached autotrade at full confidence
    // with NO R:R demotion, NO weak-alignment demotion, NO daily-against
    // demotion — bad-R:R scalps fired as HIGH/VERY HIGH. R:R and alignment
    // penalties are trigger-independent and now apply uniformly here.
    if (tradePlan) {
      winner.evaluation.strength = this.#applyTradeQualityPenalties(
        winner.evaluation.strength, tradePlan, trigger, winner.context, false, lowConviction
      );
    }

    return {
      ...winner.context,
      ...winner.evaluation,
      tradePlan,
      taMetadata,
      holdings,
      lowConviction,
      // Surface both side scores so /analyze can show "LONG 1.2 vs SHORT 3.8"
      sideScores: {
        long:  Number(longRes.evaluation.score.toFixed(2)),
        short: Number(shortRes.evaluation.score.toFixed(2))
      }
    };
  }

  // Public entry point: scan-driven token evaluation. Used by periodic jobs
  // like the top-movers scan to run the full analysis pipeline on a token
  // and fire a signal/observation if the score crosses the thresholds.
  // Respects per-token cooldowns and the same tier-floor rule as event-driven
  // evaluations (LOW/MIXED tiers always become observations).
  //
  // Returns the analysis object so the caller can also build a digest from it.
  // Rank 3 (soft confluence gate). A MOMENTUM trigger (surge/movers) must carry
  // at least one PREDICTIVE on-chain/funding reason (MOMENTUM_EDGE_KINDS) to
  // fire a tradeable signal. Live audit (345 resolved): surge 41% / movers 34%
  // WR = 72% of volume at ~breakeven; flow/funding/distribution 60-70%. Pure
  // momentum (only surge/ta/oi/smc reasons — all negative win-lift) no longer
  // fires; it goes silent (momentum observations are off by design). Event +
  // funding/flow/liquidation/distribution triggers are unaffected.
  // Kill switch: MOMENTUM_REQUIRE_EDGE=0.
  #momentumLacksEdge(triggerType, reasons) {
    // OPT-IN (default OFF): the momentum confluence gate is disabled unless
    // MOMENTUM_REQUIRE_EDGE=1. Default behaviour = the 3ee561d baseline, where
    // surge/movers fire like any other token (the per-trigger win-rate that
    // motivated this gate was disputed as a pipeline symptom, not inherent).
    return momentumLacksEdge(triggerType, reasons, process.env.MOMENTUM_REQUIRE_EDGE === '1');
  }

  // Rank 2. Cross-validation veto, reusable across paths. Re-runs the cached
  // OHLCV through the independent indicator set (confirmSignal). Returns true to
  // DROP (libs disagree); on pass, pushes a 'confirmation' reason into `reasons`
  // (the +9.1-lift top predictor) so the alert renders the gate. Mirrors the
  // inline event-path gate so the movers/scan path — which historically skipped
  // it (the audit gap; movers is the worst bucket) — gets the same check.
  // CVD divergence veto for MOMENTUM entries (surge/movers). "Price up but no
  // real buying" (or down but no real selling) is the classic fakeout that
  // produces wrong-direction stop-outs. Fail-open + only momentum + only on
  // clear divergence, so it can only ever turn the bot's worst bucket quieter.
  // Disable with CVD_VETO=0. Returns true to DROP.
  async #cvdVetoes(sym, side, triggerType) {
    if (process.env.CVD_VETO !== '1') return false;   // OPT-IN (default OFF) — baseline firing
    if (triggerType !== 'surge' && triggerType !== 'movers') return false;
    try {
      const r = await cvdVeto({ symbol: sym, side });
      if (r?.veto) {
        console.log(`[cvd] drop ${triggerType} ${sym} ${side} — ${r.reason}`);
        return true;
      }
    } catch (err) {
      if (this.verbose) console.warn(`[cvd] ${sym} error: ${err.message}`);
    }
    return false;   // fail-open
  }

  #confirmGateDrops(sym, side, reasons, label = '') {
    if (!this.taService?.getOhlcvByTf) return false;
    const ohlcvByTf = this.taService.getOhlcvByTf(sym);
    if (!ohlcvByTf || Object.keys(ohlcvByTf).length === 0) return false;   // can't analyse → don't block
    try {
      const confirmation = confirmSignal({ side, ohlcvByTf, dropThreshold: this.confirmDropThreshold });
      if (confirmation.drop) {
        console.log(`[ta-confirm] drop ${label} ${sym} ${side} — ${confirmation.reason}`);
        return true;
      }
      const topNotes = confirmation.notes.slice(0, 3).join(' • ');
      reasons.push({ kind: 'confirmation', text: `Confirmation gate ✅ tally ${confirmation.tally} — ${topNotes || 'consensus'}`, points: 0 });
    } catch (err) {
      console.warn(`[ta-confirm] ${label} ${sym} error: ${err.message}`);
    }
    return false;
  }

  async evaluateTokenAndMaybeEmit({ symbol, source = 'movers' }) {
    if (isStableSymbol(symbol)) return null;       // movers scan skips stables
    const analysis = await this.evaluateForAnalysis({ symbol });
    if (!analysis) return null;

    const sym = analysis.token.symbol;
    const last = this.lastFiredAt.get(sym);
    if (last) {
      const elapsed = Date.now() - last.ts;
      const required = last.side === analysis.side ? this.cooldownMs : this.cooldownMs * 3;
      if (elapsed < required) return analysis;       // respect cooldown
    }

    const isFavored = this.universe.isFavored?.(analysis.token.coingeckoId) ?? false;
    // Top-MC majors are liquid, low-manipulation, and TA-reliable — the one place
    // a slightly lower bar surfaces signal rather than noise. So the majors scan
    // fires on the PINNED threshold (like a favored token) instead of the strict
    // 3.0 the low-cap movers scan uses; that's why BTC/HYPE never fired before —
    // a ranging major's TA-only score (capped ~2.5) almost never reaches 3.0.
    // Revert with MAJORS_SCAN_PINNED=0.
    const useMajorsBar = source === 'majors' && process.env.MAJORS_SCAN_PINNED !== '0';
    const sigThreshold = (isFavored || useMajorsBar) ? this.minSignalScorePinned : this.minSignalScore;
    const tier = analysis.strength.label;
    const tierOkForSignal = tier === 'MEDIUM' || tier === 'HIGH' || tier === 'VERY HIGH';

    // Tag the emitted event with the scan source so the alert reads
    // "Triggered by: 🔥 Top movers scan" instead of "manual".
    const trigger = { type: source, value: { reason: source } };
    const emitData = { ...analysis, trigger };

    // Open-position lockout for the scan path too — same rationale as
    // event-driven path. The movers scan was the worst offender for
    // duplicate signals on the same token.
    if (this.signalTracker?.hasOpenSignal && this.signalTracker.hasOpenSignal(sym)) {
      if (analysis.score >= sigThreshold && tierOkForSignal) {
        if (this.verbose) console.log(`[conductor] suppress scan ${analysis.side} ${sym} signal — open position exists`);
        return analysis;
      }
    }

    // Scan signals also require a usable trade plan — same guard as the
    // event-driven path. No plan → no trackable signal → skip.
    const tp = analysis.tradePlan;
    const planOk = tp && isFinite(tp.entry) && isFinite(tp.sl) && isFinite(tp.tp1);

    if (analysis.score >= sigThreshold && tierOkForSignal && planOk) {
      // Rank 3 (soft): a momentum scan hit must carry on-chain/funding edge.
      if (this.#momentumLacksEdge(source, analysis.reasons)) {
        if (this.verbose) console.log(`[conductor] gate scan ${analysis.side} ${sym} — ${source} without on-chain/funding edge (MOMENTUM_REQUIRE_EDGE)`);
        return analysis;
      }
      // Rank 2: same cross-validation veto the event path gets (this scan path
      // historically skipped it — the audit gap; movers is the worst bucket).
      if (this.#confirmGateDrops(sym, analysis.side, analysis.reasons, 'scan')) return analysis;
      // CVD veto: kill momentum entries the aggressive order-flow contradicts.
      if (await this.#cvdVetoes(sym, analysis.side, source)) return analysis;
      this.lastFiredAt.set(sym, { ts: Date.now(), side: analysis.side });
      this.emit('signal', emitData);
    } else if (analysis.score >= sigThreshold && tierOkForSignal && !planOk && this.verbose) {
      console.log(`[conductor] skip scan ${analysis.side} ${sym} — no usable trade plan (score ${analysis.score.toFixed(2)})`);
    }
    // Scan-driven path does NOT emit observations — the movers scan runs
    // every few minutes across hundreds of tokens, and observation-tier
    // matches at every tick were the main source of LOW-confidence noise.
    // Real signals from the scan still fire above; observations only flow
    // from the event-driven path (flow/liquidation/funding_extreme).
    return analysis;
  }

  // Public entry point: evaluate a token because its funding rate is extreme.
  // Used by the periodic funding-leaders scan in index.js so the Conductor
  // can fire signals without needing a coincident surge/flow/liquidation.
  async evaluateFundingTrigger(tokenSymbol, side, fundingRate) {
    if (isStableSymbol(tokenSymbol)) return;       // stables never trade on funding
    const cgId = this.#findCgIdForSymbol(tokenSymbol);
    if (!cgId) return;
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return;
    const token = {
      symbol: tokenSymbol.toUpperCase(),
      coingeckoId: cgId,
      chain: this.#guessChain(tokenInfo)
    };
    await this.#evaluateAndMaybeEmit({
      token,
      side,
      trigger: { type: 'funding_extreme', value: { rate: fundingRate, polarity: fundingRate < 0 ? 'negative' : 'positive' } }
    });
  }

  // Public entry point: evaluate a token because it was just LISTED on a major
  // exchange (Upbit / Bithumb / Binance …). A new listing is a LONG-biased pump
  // catalyst, so we force the LONG side and let the listing trigger-base +
  // TA/structure confluence decide whether it clears the signal bar. Returns
  // true if a real evaluation ran (token is in the universe with data), false
  // if there's nothing tradeable yet (brand-new token, no perp/price/OHLCV) —
  // the caller still sends the heads-up alert in that case.
  async evaluateListingTrigger(tokenSymbol, { exchange } = {}) {
    if (isStableSymbol(tokenSymbol)) return false;
    let cgId = this.#findCgIdForSymbol(tokenSymbol);
    // Brand-new listings are usually NOT in the universe yet — which is the
    // whole point of the listing trigger. Onboard the token on demand (resolve
    // symbol→cgId via CoinGecko search + load it into the universe) so the
    // conductor actually evaluates it instead of silently bailing here.
    if (!cgId) cgId = await this.#onboardListedSymbol(tokenSymbol);
    if (!cgId) return false;
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return false;

    // Map the Coinalyze perp so TA can run + the trade is auto-tradeable. A BRAND-NEW
    // listing registers its Bybit/Coinalyze perp seconds-to-a-minute AFTER the
    // announcement, and it isn't in the 1h-cached market list yet — so the FIRST
    // attempt usually finds no perp. Without a perp there's no TA, no price, no trade
    // plan → the listing fires as a bare alert and never auto-trades (the ARX case:
    // perp came online 48s after the alert). So force a FRESH lookup and retry for up
    // to ~listingPerpRetries × listingPerpRetryMs; a Korean listing pumps for minutes,
    // so a short wait still catches it. Once the perp resolves, eval runs WITH TA.
    let hasPerp = false;
    if (this.taService?.registerSymbol) {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i <= this.listingPerpRetries; i++) {
        try { hasPerp = await this.taService.registerSymbol(tokenSymbol, { fresh: i > 0 }); }
        catch { hasPerp = false; }
        if (hasPerp || i === this.listingPerpRetries) break;
        if (this.verbose) console.log(`[conductor] listing ${tokenSymbol} — perp not live yet, retry ${i + 1}/${this.listingPerpRetries} in ${Math.round(this.listingPerpRetryMs / 1000)}s`);
        await sleep(this.listingPerpRetryMs);
      }
    }

    const token = {
      symbol: tokenSymbol.toUpperCase(),
      coingeckoId: cgId,
      chain: this.#guessChain(tokenInfo)
    };
    await this.#evaluateAndMaybeEmit({
      token,
      side: 'LONG',
      trigger: { type: 'listing', value: { exchange } }
    });
    return true;
  }

  // Resolve a just-listed token SYMBOL to a CoinGecko id and load it into the
  // universe (unpinned — normal thresholds). Returns the cgId or null. Picks the
  // best EXACT-symbol match (search also returns name matches), preferring the
  // best market-cap rank; a wrong/garbage match is harmless downstream — it
  // won't have a perp, won't gather TA confluence, and won't auto-trade.
  async #onboardListedSymbol(tokenSymbol) {
    const sym = (tokenSymbol ?? '').toUpperCase();
    if (!sym || !this.universe?.ensureToken) return null;
    let candidates;
    try { candidates = await cgSearch(sym, 10); }
    catch (err) { console.warn(`[listings] cg-search ${sym} failed: ${err.message}`); return null; }
    const exact = candidates.filter(c => c.symbol === sym);
    const pick = (exact.length ? exact : candidates)[0];
    if (!pick?.id) return null;
    const token = await this.universe.ensureToken(pick.id);
    if (!token) return null;
    // Keep the symbol→cgId cache current so this + future lookups resolve it.
    this._symbolToCgId?.set(sym, pick.id);
    console.log(`[listings] onboarded ${sym} → ${pick.id} (${token.name ?? ''}) for conductor evaluation`);
    return pick.id;
  }

  // Public entry point: evaluate a token as a SHORT because abnormal CEX
  // distribution was detected (see #onDistributionFlow). Forces SHORT and runs
  // the full evaluation so the operator gets a real signal WITH a trade plan —
  // it fires as a SIGNAL when price/TA confirm and a 👀 observation when not.
  // NEVER auto-traded (the autotrader skips trigger type=distribution).
  async evaluateDistributionTrigger(token, distData = {}) {
    if (isStableSymbol(token?.symbol)) return;
    const cgId = token?.coingeckoId ?? this.#findCgIdForSymbol(token?.symbol);
    if (!cgId) return;
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return;
    await this.#evaluateAndMaybeEmit({
      token: { symbol: token.symbol.toUpperCase(), coingeckoId: cgId, chain: this.#guessChain(tokenInfo) },
      side: 'SHORT',
      trigger: { type: 'distribution', value: distData }
    });
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  async #evaluateAndMaybeEmit({ token, side, trigger }) {
    const sym = token.symbol;

    // Post-loss cooldown — smarter version. We DON'T blanket-block re-entry
    // for hours; that would miss valid new setups when the trend exhausts
    // and reverses. Instead:
    //   1. Always suppress for the first 30 min (let the move play out)
    //   2. After that, only suppress if the new entry is within 3% of the
    //      previous loss entry (i.e., we'd be re-entering the same setup
    //      that just stopped us out)
    //   3. Beyond 4h, allow regardless — different market state now
    const lastLoss = this.recentLosses.get(sym);
    if (lastLoss && lastLoss.side === side) {
      const elapsed = Date.now() - lastLoss.ts;
      const currentPx = this.prices.getPrice(token.coingeckoId);
      if (elapsed < this.postLossMinCooldownMs) {
        if (this.verbose) console.log(`[conductor] suppressed ${side} ${sym} — SL hit ${Math.round(elapsed / 60_000)}min ago (under 30min hard floor)`);
        return;
      }
      if (elapsed < this.postLossExtendedCooldownMs && lastLoss.entry && currentPx) {
        const movedPct = Math.abs(currentPx - lastLoss.entry) / lastLoss.entry * 100;
        if (movedPct < this.postLossPriceDistPct) {
          if (this.verbose) console.log(`[conductor] suppressed ${side} ${sym} — only ${movedPct.toFixed(1)}% from loss entry $${lastLoss.entry}, same setup as last loss`);
          return;
        }
      }
    }

    // Cooldown — don't spam same token. Same-side gets the configured cooldown;
    // opposite-side gets 3× the cooldown so we don't fire SHORT 30min after a
    // LONG signal on the same token based purely on shifting funding.
    const last = this.lastFiredAt.get(sym);
    if (last) {
      const elapsed = Date.now() - last.ts;
      // Opposite-side flips normally wait 3× the cooldown (anti-whipsaw). For
      // FAVORED (watchlist) tokens we relax that to 1× so the bot can flip
      // long↔short quickly on a hand-picked name — needed to catch an
      // exhaustion-reversal short shortly after a long observation (the LAB
      // top→dump, where a long obs would otherwise lock the short for 90min).
      // Same-side cooldown is unchanged.
      const favoredTok = this.universe.isFavored?.(token.coingeckoId) ?? false;
      const required = last.side === side ? this.cooldownMs : this.cooldownMs * (favoredTok ? 1 : 3);
      if (elapsed < required) return;
    }

    const context = this.#gatherContext({ token, side, trigger });
    let evaluation = this.#evaluate(context);

    // If we're at least close to firing, enrich with TA before final decision.
    // This avoids spending Coinalyze OHLCV calls on tokens with no confluence.
    //
    // EXCEPTION — strong-momentum override: a high-volume surge (≥3× avg, the
    // +0.5 boost tier) scores only 1.5 on the trigger alone, which sits BELOW
    // the 2.0 observation floor. Without this override the deep TA never runs
    // on an explosive move that has no *simultaneous* CEX-flow/funding/liq
    // confluence — so a 25×-volume pump (the LABUSDT case) gets ignored without
    // the chart ever being looked at. Force TA on these so the RSI/MACD/
    // structure read actually happens; firing stays strict (the signal
    // threshold 2.55/3.0 + the confirm/exhaustion/regime guards are unchanged,
    // and a surge is still NOT an observable trigger — so this only ever
    // produces a *signal* when TA pushes it over the bar, never noise).
    const strongMomentum = trigger.type === 'surge' && (trigger.value.volumeBoost ?? 0) >= 0.5;
    let taMetadata = null;
    if (this.taService && (evaluation.score >= this.minObservationScore || strongMomentum)) {
      if (strongMomentum && evaluation.score < this.minObservationScore) {
        const rx = trigger.value.volumeRatio;
        console.log(`[surge] ${sym} ${side} — analysing despite low base score (${evaluation.score.toFixed(2)}): ${rx ? rx.toFixed(1) + '×' : 'high'} volume momentum override`);
      }
      try {
        const taResult = await this.taService.analyze(sym, side);
        const taFindings = taResult?.findings ?? [];
        taMetadata = taResult?.metadata ?? null;
        // Price-direction reference for OI scoring (§3.9) — prefer the 1h
        // trend, fall back to 4h. Used when no surge gives us a direction.
        const trendDir = taMetadata?.['1hour']?.trend ?? taMetadata?.['4hour']?.trend;
        if (trendDir === 'up' || trendDir === 'down') context.priceDir = trendDir;
        if (taFindings.length > 0) {
          const summary = taFindings.map(f => `${f.text} (${f.points >= 0 ? '+' : ''}${f.points})`).join(', ');
          console.log(`[ta] ${sym} ${side} → ${taFindings.length} finding(s): ${summary}`);
          context.taFindings = taFindings;
        }
        // Re-evaluate if TA added findings OR gave us a price-direction the
        // first pass lacked (so OI alignment can now score).
        if (taFindings.length > 0 || context.priceDir) {
          evaluation = this.#evaluate(context);
        }
      } catch (err) {
        console.warn(`[conductor] TA enrichment failed for ${sym}: ${err.message}`);
      }
    }

    // Orderbook heatmap — score the live L2 walls as support/resistance and
    // surface them (see #heatmapFindings). Fetched once here and reused for TP
    // placement below. Gated on the observation floor to avoid wasted calls.
    let heatmap = null;
    if (this.liquidityClusters && evaluation.score >= this.minObservationScore) {
      heatmap = await this.#fetchHeatmap(sym);
      const hmFindings = this.#heatmapFindings(heatmap, side);
      if (hmFindings.length > 0) {
        for (const f of hmFindings) console.log(`[liq-clusters] ${sym} ${side} → ${f.text} (${f.points >= 0 ? '+' : ''}${f.points})`);
        context.taFindings = [ ...(context.taFindings ?? []), ...hmFindings ];
        evaluation = this.#evaluate(context);
      }
    }

    // Leverage-liquidation HEATMAP (Coinglass-style magnets) — make it count on
    // EVERY firing candidate, not just pre-warmed hot-movers. computeFast is
    // cache-first and races a hard timeout (on the DEDICATED liq key, so it never
    // starves TA and never materially delays the signal). Re-evaluate so the
    // liqLevels magnet enters the score. Fail-open: on timeout/miss it's skipped.
    // Only compute the (network) heatmap for candidates that could PLAUSIBLY fire —
    // within the max magnet bump (~0.5) of the LOWEST firing bar (the pinned
    // threshold). Below that, even a full magnet can't promote the observation to a
    // signal, so the fetch is wasted. (Was: every observation ≥ minObservationScore.)
    const heatmapWorthIt = evaluation.score >= (this.minSignalScorePinned - 0.6);
    if (this.liquidationHeatmap?.computeFast && heatmapWorthIt) {
      try {
        const before = this.liquidationHeatmap.peek?.(sym);
        if (!before) await this.liquidationHeatmap.computeFast(sym);
        if (this.liquidationHeatmap.peek?.(sym)) evaluation = this.#evaluate(context);
      } catch { /* fail-open — magnet simply absent */ }
    }

    // Resolve the trade-plan entry price. Prefer Coinalyze 1m close (the
    // actual exchange/perp price the user trades) over the CoinGecko-smoothed
    // cross-venue average. Falls back to the CoinGecko price for tokens
    // without perp coverage.
    let entryPrice = context.currentPrice;
    if (this.taService?.getLastPerpPrice) {
      try {
        const perpPx = await this.taService.getLastPerpPrice(sym);
        if (perpPx != null && isFinite(perpPx) && perpPx > 0) {
          entryPrice = perpPx;
          context.currentPrice = perpPx;
        }
      } catch (err) {
        console.warn(`[conductor] perp price fetch failed ${sym}: ${err.message}`);
      }
    }

    // Build trade plan (SL/TP/leverage/validity) from ATR if we have one.
    // Heatmap walls in the trade's path become TP-snap candidates (take profit
    // just before a wall where price stalls). The liquidation-heatmap clusters in
    // the sweep direction become the counter-trend ENTRY target (where stops sit).
    const hmLiq = this.liquidationHeatmap?.peek?.(sym);
    const liqMagnets = hmLiq ? ((side === 'SHORT' ? hmLiq.shortLiqs : hmLiq.longLiqs) ?? []) : [];
    const liqTargets = hmLiq ? ((side === 'SHORT' ? hmLiq.longLiqs : hmLiq.shortLiqs) ?? []) : [];   // PROFIT-side clusters (cascade TP3)
    const tradePlan = this.#buildTradePlan(entryPrice, side, taMetadata, this.#tpWallsWithSweep(heatmap, side, sym, entryPrice), trigger, liqMagnets, liqTargets);

    // HIGH-RISK exhaustion-reversal (watchlist-only): a favored token at an
    // extreme that's starting to crack — a blow-off TOP rolling over (SHORT) or a
    // capitulation BOTTOM bouncing (LONG). Computed here so each side can (a)
    // override its confirm veto below and (b) EXEMPT the setup from the
    // counter-trend alignment cap (a DELIBERATE counter-trend fade — capping it
    // would neuter the feature). Each is true ONLY for a favored trade at extreme
    // RSI with its own kill-switch on, so NO other trade type is affected.
    const exhShort = this.#exhaustionReversalShort(side, taMetadata, token.coingeckoId);
    const exhLong  = this.#exhaustionReversalLong(side, taMetadata, token.coingeckoId);
    const exhReversal = exhShort || exhLong;

    // Apply trade-quality penalties (R:R, alignment, sentiment-only) AFTER the
    // trade plan is built — same raw score, downgraded tier when the trade is
    // structurally weak. Prevents 100% confidence on 1-TF SCALPs with bad R:R.
    if (tradePlan) {
      evaluation.strength = this.#applyTradeQualityPenalties(
        evaluation.strength, tradePlan, trigger, context, exhReversal
      );
    }

    // Cross-validation gate — re-run the same OHLCV through an independent
    // indicator set (trading-signals + indicatorts + candlestick patterns).
    // If those libs disagree strongly (hard RSI veto on 4h/daily, or net
    // tally below threshold), drop the would-be signal rather than emit it.
    // Bypassed when no OHLCV is cached (token has no perp coverage / TA was
    // skipped) — gate must not block tokens it can't analyse.

    if (this.taService?.getOhlcvByTf && evaluation.score >= this.minObservationScore) {
      const ohlcvByTf = this.taService.getOhlcvByTf(sym);
      if (Object.keys(ohlcvByTf).length > 0) {
        try {
          const confirmation = confirmSignal({ side, ohlcvByTf, dropThreshold: this.confirmDropThreshold, allowExhaustionShort: exhShort, allowExhaustionLong: exhLong });
          if (confirmation.drop) {
            console.log(`[ta-confirm] drop ${sym} ${side} — ${confirmation.reason}`);
            // Hard drop: do NOT emit signal OR observation. The independent
            // indicator set disagreed — the bot should stay silent and wait
            // for a setup where the libs actually align.
            return;
          }
          // Push the confirmation result directly into evaluation.reasons so
          // the alert formatter renders a "Confirmation gate" line, making
          // the new indicator libraries visible to the user instead of
          // running silently. Top 3 notes are surfaced for context.
          const topNotes = confirmation.notes.slice(0, 3).join(' • ');
          evaluation.reasons.push({
            kind: 'confirmation',
            text: `Confirmation gate ✅ tally ${confirmation.tally} — ${topNotes || 'consensus'}`,
            points: 0
          });
          console.log(`[ta-confirm] ${sym} ${side} tally ${confirmation.tally} (${confirmation.notes.length} signals)`);
        } catch (err) {
          console.warn(`[ta-confirm] ${sym} error: ${err.message}`);
        }
      }
    }

    // Tag a surviving exhaustion-reversal as HIGH RISK so the alert is
    // unambiguous — the user opted into fading extremes on watchlist names, but
    // it's a deliberate counter-trend bet: tight invalidation, size down. The
    // flag flows into the emitted signal for the formatter to render.
    if (exhReversal) {
      evaluation.highRisk = true;
      evaluation.setupType = 'exhaustion-reversal';
      const desc = exhShort
        ? 'fading a blow-off top (extreme daily/weekly overbought, 5m rolling over)'
        : 'buying a capitulation bottom (extreme daily/weekly oversold, 5m turning up)';
      evaluation.reasons.push({
        kind: 'exhaustionReversal',
        text: `⚠️ HIGH-RISK exhaustion-reversal — ${desc}. Counter-trend; tight stop, size down.`,
        points: 0
      });
      console.log(`[exhaustion-reversal] ${sym} ${side} — HIGH-RISK reversal ${exhShort ? 'short on watchlist top' : 'long on watchlist bottom'} (daily RSI ${taMetadata?.['daily']?.rsi?.toFixed?.(0) ?? '?'})`);
    }

    // A+ CONVICTION GRADING. The only honest route to a high win rate is
    // RUTHLESS SELECTIVITY — fire confidently only when several INDEPENDENT
    // edges agree (proven on-chain/funding/liquidation source + structure +
    // confirmation + trend + R:R), the regime isn't against us, and it's not a
    // high-risk counter-trend fade. This tags the cream so the user (or the
    // autotrader, via AUTOTRADE_HIGH_CONVICTION_ONLY) can trade ONLY the fat
    // pitches. It does NOT suppress normal signals — it's an additive label.
    if (tradePlan) {
      const conviction = this.#assessConviction(evaluation, tradePlan, trigger, context, exhReversal);
      evaluation.conviction = conviction;
      evaluation.highConviction = conviction.isHighConviction;
      if (conviction.isHighConviction) {
        evaluation.reasons.push({
          kind: 'conviction',
          text: `🏆 A+ HIGH-CONVICTION — ${conviction.count} independent edges: ${conviction.edges.join(', ')}`,
          points: 0
        });
        console.log(`[conviction] ${sym} ${side} A+ (${conviction.edges.join(' + ')}; R:R ${conviction.rr})`);
      }
    }

    // Signal firing requires BOTH:
    //   (a) score above threshold (pinned tokens use a lower bar)
    //   (b) tier of MEDIUM or better — LOW/MIXED are observation-only no
    //       matter how high the raw score got (trade quality penalties
    //       already dragged the tier down for a reason)
    const isFavored = this.universe.isFavored?.(token.coingeckoId) ?? false;
    const sigThreshold = isFavored ? this.minSignalScorePinned : this.minSignalScore;
    const tier = evaluation.strength.label;
    // A new-listing catalyst (esp. Korean — ~90% pump on the announcement) is a
    // conviction trade on the EVENT, not on TA tier. A token listed minutes ago has
    // no multi-TF history to reach MEDIUM, so the normal gate turned EVERY listing
    // into an info-only observation (never a tradeable/autotrade signal). Let a
    // listing fire at LOW too — it still needs score ≥ bar (Korean base alone = 3.0)
    // AND a usable trade plan (which requires a real perp, so non-tradeable Korean
    // spot-only tokens stay info-only). MIXED stays blocked (genuine conflict / it
    // already blew off). Revert with LISTING_SIGNAL_RELAXED=0.
    const listingRelaxed = trigger?.type === 'listing' && process.env.LISTING_SIGNAL_RELAXED !== '0';
    const tierOkForSignal = tier === 'MEDIUM' || tier === 'HIGH' || tier === 'VERY HIGH'
      || (listingRelaxed && tier === 'LOW');

    // Open-position lockout — if there's already an unresolved signal on
    // this token, don't fire another one. Same side = pure duplicate (was
    // spamming "TIA LONG" three times in two hours). Opposite side = the
    // existing trade is at risk of invalidation; we'd rather the user see
    // their open trade resolve first than be flooded with both directions.
    // Observations are still allowed through (informational only).
    if (this.signalTracker?.hasOpenSignal && this.signalTracker.hasOpenSignal(sym)) {
      if (evaluation.score >= sigThreshold && tierOkForSignal) {
        if (this.verbose) console.log(`[conductor] suppress ${side} ${sym} signal — open position already exists for this token`);
        return;
      }
    }

    // A signal MUST have a usable trade plan (entry/SL/TPs). Without one the
    // SignalTracker can't track it and it never shows in /open — the GUA/BSB
    // "no entry, no TP, no SL" reports. If the plan is null (no ATR / no perp
    // OHLCV), downgrade to an observation instead of emitting a useless signal.
    const planOk = tradePlan && isFinite(tradePlan.entry) && isFinite(tradePlan.sl) && isFinite(tradePlan.tp1);

    // Rank 3 (soft): a standalone momentum trigger (surge) must carry a
    // predictive on-chain/funding reason to fire — else it goes silent (surge
    // observations are off by design). Event triggers (flow/funding_extreme/
    // liquidation/distribution) are unaffected.
    const momentumGated = this.#momentumLacksEdge(trigger?.type, evaluation.reasons);
    if (momentumGated && this.verbose && evaluation.score >= sigThreshold && tierOkForSignal && planOk) {
      console.log(`[conductor] gate ${side} ${sym} — ${trigger?.type} without on-chain/funding edge (MOMENTUM_REQUIRE_EDGE)`);
    }
    const wouldFire = evaluation.score >= sigThreshold && tierOkForSignal && planOk && !momentumGated;
    // CVD veto on momentum entries (drops, like the confirm gate — not even an
    // observation). Fail-open + momentum-only inside the helper.
    if (wouldFire && await this.#cvdVetoes(sym, side, trigger?.type)) return;
    if (wouldFire) {
      this.lastFiredAt.set(sym, { ts: Date.now(), side });
      this.emit('signal', { ...context, ...evaluation, tradePlan });
    } else if (evaluation.score >= this.minObservationScore) {
      // Observations are now restricted to ACTIONABLE trigger types — events
      // where the user might want a heads-up even without a full signal:
      //   • flow              — CEX wallet movement (rare, meaningful)
      //   • liquidation       — leverage wipe (rare, meaningful)
      //   • funding_extreme   — sentiment flip (rare-ish)
      // Movers/surge scans run continuously and were drowning users in
      // "👀 Watching LOW 53% confidence" alerts. Those tokens still get
      // re-evaluated each scan tick — if they actually cross the signal
      // threshold, they'll fire as real signals, not noise observations.
      // Funding-extreme observations are OFF by default (noisy radar entries) —
      // toggle with FUNDING_EXTREME_OBSERVATIONS=1. A funding extreme that
      // gathers real confluence still fires as a SIGNAL (above), not blocked here.
      const OBSERVABLE_TRIGGERS = new Set(['flow', 'liquidation', 'distribution']);
      if (this.observeFundingExtreme) OBSERVABLE_TRIGGERS.add('funding_extreme');
      if (!OBSERVABLE_TRIGGERS.has(trigger.type)) {
        if (this.verbose) console.log(`[conductor] skip observation ${sym} ${side} — trigger=${trigger.type} not observable (score ${evaluation.score.toFixed(2)})`);
        return;
      }
      this.lastFiredAt.set(sym, { ts: Date.now(), side });
      this.emit('observation', { ...context, ...evaluation, tradePlan });
    }
  }

  // Watchlist-gated wrappers around the pure detectors (see module top). Each
  // has its OWN kill-switch so longs/shorts run independently.
  #exhaustionReversalShort(side, taMetadata, cgId) {
    if (!this.enableExhaustionReversal) return false;
    return isExhaustionReversalShort(side, this.universe.isFavored?.(cgId) ?? false, taMetadata);
  }
  #exhaustionReversalLong(side, taMetadata, cgId) {
    if (!this.enableExhaustionReversalLong) return false;
    return isExhaustionReversalLong(side, this.universe.isFavored?.(cgId) ?? false, taMetadata);
  }

  #gatherContext({ token, side, trigger }) {
    const now = Date.now();
    const cgId = token.coingeckoId;
    const sym = token.symbol;

    const recentFlows = (this.flowsByToken.get(sym) ?? []).filter(e => now - e.ts <= this.flowHistoryMs);
    const recentSurges = (this.surgesByCgId.get(cgId) ?? []).filter(e => now - e.ts <= this.surgeHistoryMs);
    const recentLiquidations = (this.liquidationsByToken.get(sym) ?? []).filter(e => now - e.ts <= this.liqHistoryMs);

    const universeInfo = this.universe.lookupByCgId(cgId) ?? null;
    // Live monitored price; fall back to CoinGecko mcap/supply (= price) for a
    // token the price monitor doesn't track yet — e.g. an on-demand /analyze of a
    // token outside the universe. null only if neither is known.
    const cgPrice = (universeInfo?.marketCap > 0 && universeInfo?.circulatingSupply > 0)
      ? universeInfo.marketCap / universeInfo.circulatingSupply : null;
    return {
      token,
      side,
      trigger,
      funding: this.funding?.getByCgId(cgId) ?? null,
      currentPrice: this.prices.getPrice(cgId) ?? cgPrice,
      universeInfo,
      recentFlows,
      recentSurges,
      recentLiquidations,
      timestamp: now
    };
  }

  #evaluate(context) {
    const { side, trigger, funding, currentPrice, universeInfo, recentFlows, recentSurges, recentLiquidations } = context;
    const reasons = [];
    let score = 0;

    // Manipulation-risk (NOX low-cap pump-and-dump filters). Computed once and
    // used two ways below: (1) DE-WEIGHT positive TA (the chart is noise on a
    // manipulated float), (2) bias the final score — penalise a LONG (don't chase
    // the pump) and boost a SHORT (fade the dump).
    const manip = MANIP_GUARD ? this.#assessManipulation(context.token) : { score: 0, flags: [] };
    const taDeweight = 1 - manip.score * MANIP_TA_DEWEIGHT;

    // 1. Trigger base score
    if (trigger.type === 'flow') {
      // Scale base by USD size — a $10M cold-wallet move is a much stronger
      // signal than a $500k one. Caps at +3.5 to keep totals bounded.
      const usd = trigger.usd ?? 0;
      // Flow base curve down-weighted by ~0.5 across the board (audit §6.8):
      // the flow trigger is the WORST performer (42% win-rate), so a raw CEX
      // transfer should carry less of the signal and lean harder on confluence
      // (funding / TA / liquidations) before it fires. Paired with the higher
      // MIN_FLOW_USD gate ($1M default) in #onFlow.
      let baseFlow = 1.5;
      if      (usd >= 10_000_000) baseFlow = 3.0;
      else if (usd >=  5_000_000) baseFlow = 2.5;
      else if (usd >=  2_000_000) baseFlow = 2.0;
      baseFlow += SCORING.flowBaseBoost;   // rank 5: re-rate flow up (now 60.6% WR; 0 = unchanged)
      score += baseFlow;
      // ❄️ COLD-STORAGE DEPOSIT boost — supply moved INTO an exchange's COLD
      // custody is pre-distribution STAGING (the BEAT/VELVET/SAHARA "into cold
      // wallet" tell that precedes a dump): a stronger bearish signal than a hot
      // deposit (often just normal trading flow). Only on the bearish (SHORT)
      // read of a cold deposit. Scored separately so the alert shows it clearly.
      if (trigger.value.toType === 'cold' && side === 'SHORT' && SCORING.coldDepositBoost > 0) {
        score += SCORING.coldDepositBoost;
        reasons.push({
          kind: 'coldDeposit',
          text: `❄️ Deposited into ${trigger.value.exchange ?? 'CEX'} COLD storage — pre-distribution staging (supply parked to sell, stronger sell pressure)`,
          points: SCORING.coldDepositBoost
        });
      }
      // Team-wallet boost — the highest-conviction on-chain signal. When a
      // tracked top-holder (insider) sends to a CEX, the supply is leaving
      // private custody and entering exchange custody for sale. Add a
      // direct +1.5 to the score (on top of the normal flow base) and
      // emit a dedicated reason line so the user knows WHICH holder fired.
      const tf = trigger.value.teamFlow;
      if (tf) {
        // Team flow is CONFIRMING evidence, not a standalone trade thesis.
        // Previously +1.5 (sell) alone pushed borderline setups to VERY HIGH
        // on a single on-chain transfer (the ZBT 100%/6.55 case). Dropped to
        // +0.8 (sell) / +0.3 (buy) so the rest of the confluence — funding,
        // TA, OI — still has to carry the signal. A team sell on a token with
        // no other bearish confluence shouldn't be a max-confidence short.
        const teamPts = tf.side === 'sell' ? SCORING.teamSellPts : 0.3;
        score += teamPts;
        const dirWord = tf.side === 'sell' ? 'TEAM DISTRIBUTION' : 'team accumulation';
        // Multi-hop laundering note (team → fresh wallet → CEX) — the GUA
        // pattern. hops>0 means the supply was routed through intermediary
        // wallet(s) before hitting the exchange, which is what teams do to
        // obscure distribution.
        const hopNote = (tf.hops ?? 0) > 0 ? ` via ${tf.hops}-hop fresh wallet${tf.hops > 1 ? 's' : ''}` : '';
        // Destination wording: a DEX dump (on-chain sell into liquidity) reads
        // differently than a CEX deposit.
        const dest = tf.venue === 'dex'
          ? `dumped on ${tf.venueLabel ?? 'a DEX'} (on-chain sell into liquidity)`
          : `${tf.side === 'sell' ? 'sent to' : 'received from'} ${trigger.value.exchange}`;
        reasons.push({
          kind: 'teamFlow',
          text: `🚨 ${dirWord} — rank-#${tf.holderRank} insider holder of ${tf.tokenSymbol} ${dest}${hopNote}`,
          points: teamPts
        });
      }
      // Friendly endpoint labels: prefer the specific wallet name ("Gate 1",
      // "Binance 14") when available, else fall back to "<exchange> <type>"
      // ("gateio hot"). External counterparty stays just "external".
      const flowFromLabel = trigger.value.fromName
        ?? (trigger.value.fromType === 'external' ? 'external' : `${trigger.value.exchange} ${trigger.value.fromType}`);
      const flowToLabel = trigger.value.toName
        ?? (trigger.value.toType === 'external' ? 'external' : `${trigger.value.exchange} ${trigger.value.toType}`);
      reasons.push({
        kind: 'flow',
        text: `${trigger.value.exchange} ${flowFromLabel}→${flowToLabel}: ${trigger.value.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} (~$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })})`,
        points: baseFlow,
        txHash: trigger.value.txHash,
        chain: trigger.value.chain
      });
    } else if (trigger.type === 'surge') {
      const volBoost = trigger.value.volumeBoost ?? 0;
      const surgeScore = SCORING.surgeBase + volBoost;   // rank 4: de-fund surge (WoE -0.17; default 1 = unchanged)
      score += surgeScore;
      const volTag = volBoost > 0 ? ` _(volume ${volBoost === 0.5 ? '≥3×' : '≥2×'} avg)_` : '';
      reasons.push({
        kind: 'surge',
        text: `Price ${trigger.value.direction.toUpperCase()} ${trigger.value.pctChange.toFixed(2)}% (${trigger.value.open} → ${trigger.value.close})${volTag}`,
        points: surgeScore
      });
    } else if (trigger.type === 'liquidation') {
      // A liquidation is a tradeable SQUEEZE on a LIQUID major and manipulation-bait on
      // an illiquid small-cap. The old %-of-OI base did the INVERSE of what's wanted:
      // it DEMOTED majors (a $718k BTC liq = 0.007% of OI → ~0.7, never reached signal
      // grade → the "I get liq notifications but never a signal" complaint) while
      // PROMOTING small-caps (a liq that's a big % of a tiny OI → ~2.0). So:
      //   • LIQUID market (OI ≥ minOi OR mcap ≥ minMc) → strong base (liqMajorBaseFloor,
      //     restoring the 2a110ea +2.0), scaled UP by a stacking same-side cascade. A
      //     $300k+ squeeze on BTC/ETH now reaches signal grade with ordinary confluence.
      //   • ILLIQUID → damped to liqIlliquidCap; stays a notification, can't carry a
      //     signal alone (the "don't get me rekt on small-cap liqs" guard).
      const oiFrac = Number(trigger.value?.oiFrac);
      const liqOiUsd = Number(trigger.value?.oiUsd) || 0;
      const liquidMarket = liqOiUsd >= this.liqSignalMinOiUsd
        || (universeInfo?.marketCap >= this.liqSignalMinMcUsd);
      const cascadeUsd = (this.liquidationsByToken.get(context.token.symbol) ?? [])
        .filter(e => Date.now() - e.ts <= this.liqCascadeWindowMs && e.event?.bias === side.toLowerCase())
        .reduce((s, e) => s + (e.event?.total ?? e.event?.dominantUsd ?? 0), 0);
      const liqBase = liquidationSignalBase({
        liquidMarket, cascadeUsd, oiFrac,
        cascadeFullUsd: this.liqCascadeFullUsd, baseFloor: this.liqMajorBaseFloor,
        illiquidCap: this.liqIlliquidCap, baseFullOi: this.liqBaseFullOi,
      });
      score += liqBase;
      const cascNote = (cascadeUsd >= 1e6) ? ` · $${(cascadeUsd / 1e6).toFixed(1)}M cascade in ${Math.round(this.liqCascadeWindowMs / 60000)}m` : '';
      const liqNote = liquidMarket ? '' : ' · illiquid market (heads-up only, not signal-grade)';
      reasons.push({
        kind: 'liquidation',
        text: `${trigger.value.dominantSide} wiped $${trigger.value.dominantUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}${cascNote}${liqNote}`,
        points: Number(liqBase.toFixed(2))
      });
    } else if (trigger.type === 'funding_extreme') {
      // ZERO base — the funding alignment bonus below already captures the
      // magnitude of extreme funding; adding a separate +0.5 here was
      // double-counting. The trigger now serves only as the "entry point" for
      // the evaluation; the actual score must come from funding alignment +
      // other confluence (flows, TA, liquidations). This prevents
      // funding_extreme from auto-firing signals on sentiment alone.
      const pct = (trigger.value.rate * 100).toFixed(3);
      // rank 5: optional small base for the +6.6-lift funding trigger. Kept
      // BELOW the firing bar (default 0) so it still needs confluence, never
      // auto-fires on sentiment alone (the bug the 0-base hardened against).
      score += SCORING.fundingExtremeBase;
      reasons.push({
        kind: 'funding_trigger',
        text: `Extreme ${trigger.value.polarity} funding at ${pct}% per period (radar entry — needs confluence)`,
        points: SCORING.fundingExtremeBase
      });
    } else if (trigger.type === 'listing') {
      // New-listing catalyst (LONG-biased). Korean exchanges (Upbit/Bithumb)
      // drive the strongest retail-FOMO pumps; Binance is also a major catalyst.
      // Strong base, but deliberately BELOW the signal threshold on its own — it
      // still needs TA/structure confluence + a usable trade plan to fire, so we
      // don't blindly LONG a "sell-the-news" listing that's already blown off.
      const ex = String(trigger.value?.exchange ?? '').toLowerCase();
      const isKorean = ex.includes('upbit') || ex.includes('bithumb') || ex.includes('coinone');
      const base = isKorean ? 3.0 : ex.includes('binance') ? 2.5 : 2.0;
      score += base;
      reasons.push({
        kind: 'listing',
        text: `🚀 New listing on ${trigger.value?.exchange ?? 'exchange'}${isKorean ? ' (Korean retail FOMO — strongest pump catalyst)' : ''} — LONG bias`,
        points: base
      });
    } else if (trigger.type === 'distribution') {
      // On-chain CEX distribution — concentrated hot-wallet outflow (SHORT
      // thesis). Strong base, but BELOW the bar alone: it still needs price/TA to
      // confirm before firing as a signal (else it's a 👀 watch) — don't short an
      // uptrend on outflows alone (the LAB fake-out). Never auto-traded.
      const v = trigger.value ?? {};
      const usdStr = (v.cumulativeUsd ?? 0) >= 1e6 ? `$${(v.cumulativeUsd / 1e6).toFixed(2)}M` : `$${Math.round((v.cumulativeUsd ?? 0) / 1e3)}K`;
      score += SCORING.distributionBase;   // rank 5: best bucket (70% WR); default 2.5 = unchanged
      reasons.push({
        kind: 'distribution',
        text: `🔴 ${v.exchange ?? 'CEX'} distribution — ${usdStr} hot-wallet outflow in ${v.count} transfers / ${v.windowMins}min${v.volPct != null ? ` (${v.volPct.toFixed(1)}% of 24h vol)` : ''}${v.topDestinations?.length ? ` → ${v.topDestinations.join(', ')}` : ''}`,
        points: SCORING.distributionBase
      });
    }

    // 2. Funding alignment
    let fScore = fundingScoreForSide(side, funding?.summary);
    if (fScore !== null) {
      // When a large cold-wallet flow triggers the evaluation, "crowded longs"
      // funding is ambiguous — likely the same accumulation we just saw, not
      // retail piling in. Cap the penalty at -0.5 instead of full -2 so we
      // don't fight on-chain evidence with sentiment heuristics.
      const isFlowTrigger = trigger.type === 'flow' && (trigger.usd ?? 0) >= 2_000_000;
      if (isFlowTrigger && fScore < -0.5) fScore = -0.5;
      score += fScore;
      const desc = describeFunding(side, funding.summary, 1);
      reasons.push({ kind: 'funding', text: desc, points: fScore });
    }

    // 3. OI alignment — only meaningful with a REAL price-direction reference
    // (audit §3.9). Previously, when there was no surge, surgeDir defaulted to
    // the trade side, so an OI uptick on a SHORT signal was always scored as
    // "fresh shorts piling in" even when price was actually pumping (which would
    // be a short squeeze, the opposite read). Now we require an OBSERVED
    // direction: the triggering surge, a recent surge, or the 1h candle trend
    // (set on context during TA enrichment). If none exists, OI is left
    // unscored rather than guessed from the side.
    let surgeDir = trigger.type === 'surge' ? trigger.value.direction : null;
    if (!surgeDir && recentSurges.length > 0) {
      surgeDir = recentSurges[recentSurges.length - 1].surge.direction;
    }
    if (!surgeDir && (context.priceDir === 'up' || context.priceDir === 'down')) {
      surgeDir = context.priceDir;        // 1h MACD trend, when no surge reference
    }
    if (surgeDir) {
      const oScore = oiScoreForSide(side, funding?.summary, surgeDir);
      if (oScore != null && oScore !== 0) {
        score += oScore;
        const oiDesc = describeOI(funding.summary);
        if (oiDesc) reasons.push({ kind: 'oi', text: oiDesc, points: oScore });
      }
    }

    // Helper: any of these events happen within last 5min = near-simultaneous confluence
    const NEAR_SIM_MS = 5 * 60_000;
    const now = Date.now();
    const isNearSim = (ts) => (now - ts) <= NEAR_SIM_MS;

    // 4. Prior aligned flows (excluding the trigger itself if it's a flow)
    const otherFlows = recentFlows.filter(e => {
      if (!e.flow.direction) return false;
      if (trigger.type === 'flow' && e.flow === trigger.value) return false;
      return e.flow.direction.toUpperCase() === side;
    });
    // Corroboration requires INDEPENDENT parties: one insider chunking a single
    // exit (same "Insider #21" across fresh wallets) isn't extra confluence, and
    // the trigger flow can't corroborate itself. Count distinct senders other
    // than the trigger's, ignoring dust legs. (The ENA case: 5 "aligned flows"
    // were all Insider #21 → 0 independent → no bonus.)
    const independent = independentFlowCount(otherFlows, trigger.type === 'flow' ? trigger.value : null);
    if (independent >= 1) {
      score += 1;
      const summary = otherFlows
        .filter(e => (e.usd ?? 0) >= 25_000)
        .map(e => {
          const fLbl = e.flow.fromName ?? (e.flow.fromType === 'external' ? 'external' : `${e.flow.exchange} ${e.flow.fromType}`);
          const tLbl = e.flow.toName ?? (e.flow.toType === 'external' ? 'external' : `${e.flow.exchange} ${e.flow.toType}`);
          return `${fLbl}→${tLbl} ~$${(e.usd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        })
        .slice(0, 3)
        .join('; ');
      reasons.push({
        kind: 'priorFlows',
        text: `${independent} independent aligned CEX flow(s) in last ${Math.round(this.flowHistoryMs/60000)}min — ${summary}`,
        points: 1
      });
      // Near-simultaneous booster
      if (otherFlows.some(e => isNearSim(e.ts))) {
        score += 0.5;
        reasons.push({ kind: 'simultaneous', text: `⚡ aligned flow within last 5min (multi-event confluence)`, points: 0.5 });
      }
    }

    // 5. Prior aligned surges (only useful if trigger isn't a surge itself)
    if (trigger.type !== 'surge') {
      const aligned = recentSurges.filter(e =>
        (side === 'LONG' && e.surge.direction === 'up') ||
        (side === 'SHORT' && e.surge.direction === 'down')
      );
      if (aligned.length > 0) {
        score += 0.5;
        reasons.push({
          kind: 'priorSurges',
          text: `${aligned.length} aligned 1m surge(s) in last ${Math.round(this.surgeHistoryMs/60000)}min`,
          points: 0.5
        });
        if (aligned.some(e => isNearSim(e.ts))) {
          score += 0.5;
          reasons.push({ kind: 'simultaneous', text: `⚡ aligned surge within last 5min (multi-event confluence)`, points: 0.5 });
        }
      }
    }

    // 6. Prior aligned liquidations
    if (trigger.type !== 'liquidation') {
      const aligned = recentLiquidations.filter(e => e.event.bias === side.toLowerCase());
      if (aligned.length > 0) {
        score += 1;
        const last = aligned[aligned.length - 1].event;
        reasons.push({
          kind: 'priorLiquidations',
          text: `${aligned.length} aligned liquidation(s) — last: ${last.dominantSide} wiped $${last.dominantUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
          points: 1
        });
        if (aligned.some(e => isNearSim(e.ts))) {
          score += 0.5;
          reasons.push({ kind: 'simultaneous', text: `⚡ aligned liquidation within last 5min (multi-event confluence)`, points: 0.5 });
        }
      }
    }

    // 6b. Funding velocity — sudden funding shifts matter more than absolute
    // levels. All inputs are normalised to a PER-HOUR frame BEFORE thresholding
    // (audit §3.8): previously a 1h rolling delta and a poll-to-poll delta (5m
    // or 1h depending on source) were compared under the SAME threshold despite
    // representing different timescales. We now PREFER the 4h rolling velocity
    // ÷4 → per-hour (smoother, less single-bar noise — §4 wires up the
    // previously-unused velocity4h), fall back to the 1h rolling velocity
    // (already per-hour), then the raw poll delta as a last resort.
    const v4 = funding?.summary?.velocity4h;
    const v1 = funding?.summary?.velocity1h;
    let fundingDeltaPerHr = null, velocitySource = null;
    if (typeof v4 === 'number' && isFinite(v4))      { fundingDeltaPerHr = v4 / 4; velocitySource = '4h-rolling'; }
    else if (typeof v1 === 'number' && isFinite(v1)) { fundingDeltaPerHr = v1;     velocitySource = '1h-rolling'; }
    else if (typeof funding?.summary?.delta === 'number' && isFinite(funding.summary.delta)) {
      fundingDeltaPerHr = funding.summary.delta; velocitySource = 'poll-delta';
    }
    if (fundingDeltaPerHr !== null) {
      const NEUTRAL_DELTA = 0.0003;  // < 0.03%/hr change in the 8h-normalised rate → ignore
      const STRONG_DELTA  = 0.001;   // > 0.1%/hr change → strong regime shift

      // LONG benefits when funding is going MORE negative (shorts piling in further)
      // SHORT benefits when funding is going MORE positive (longs piling in further)
      const favorable = (side === 'LONG' && fundingDeltaPerHr < 0) || (side === 'SHORT' && fundingDeltaPerHr > 0);
      const abs = Math.abs(fundingDeltaPerHr);
      const window = velocitySource === '4h-rolling' ? '/hr (4h-avg)'
                   : velocitySource === '1h-rolling' ? '/hr (1h)'
                   :                                    ' since last poll';
      // De-dup with the funding-LEVEL alignment (accuracy audit C/§4): when the
      // level already credited a genuine squeeze (fScore ≥ 1.5), the favorable
      // velocity is the SAME crowding measured as a derivative — and it's
      // strongest exactly when the squeeze is closest to exhausting (late entry).
      // Suppress the favorable bonus in that case; the ADVERSE penalty still
      // applies (positioning unwinding is new information).
      const fundingAlreadyStrong = (fScore ?? 0) >= 1.5;
      if (favorable && abs >= STRONG_DELTA && !fundingAlreadyStrong) {
        score += 0.7;
        reasons.push({
          kind: 'fundingVelocity',
          text: `Funding shifting ${(fundingDeltaPerHr * 100).toFixed(3)}%${window} (regime change favors ${side})`,
          points: 0.7
        });
      } else if (favorable && abs >= NEUTRAL_DELTA && !fundingAlreadyStrong) {
        score += 0.3;
        reasons.push({
          kind: 'fundingVelocity',
          text: `Funding drifting ${(fundingDeltaPerHr * 100).toFixed(3)}%${window} (mild favorable)`,
          points: 0.3
        });
      } else if (!favorable && abs >= STRONG_DELTA) {
        score -= 0.3;
        reasons.push({
          kind: 'fundingVelocity',
          text: `Funding shifting ${(fundingDeltaPerHr * 100).toFixed(3)}%${window} AGAINST ${side} — positioning is unwinding`,
          points: -0.3
        });
      }
    }

    // 6c. Liquidation cluster magnets — recent zones where leverage was
    // forcibly wiped tend to be revisited (price magnets). Use them as
    // squeeze-fuel confirmation for the trade direction:
    //
    //   LONG side: any SHORTS-dominated cluster ABOVE current price (within
    //     +2% to +8%) is a magnet for upward squeeze moves.
    //   SHORT side: any LONGS-dominated cluster BELOW current price (within
    //     -2% to -8%) is a magnet for cascading flushes.
    //
    // Score boost scales with $ size of the cluster.
    // NOT when the trigger IS a liquidation (accuracy audit C/§3): that same
    // cascade already scored the +2.0 trigger base AND the prior-aligned-liq
    // bonus — crediting the magnet too is the same event counted a third time
    // (one cascade → false VERY HIGH), and a fresh cascade often means price is
    // already AT the cluster, i.e. the squeeze is spent (chasing).
    if (currentPrice && trigger.type !== 'liquidation') {
      const clusters = this.#getLiquidationClusters(context.token.symbol, currentPrice);
      // Filter to clusters aligned with our trade thesis + at meaningful distance
      const magnets = clusters.filter(c => {
        const absDist = Math.abs(c.distancePct);
        if (absDist < 2 || absDist > 8) return false;
        if (side === 'LONG'  && c.dominantSide === 'shorts' && c.distancePct > 0) return true;
        if (side === 'SHORT' && c.dominantSide === 'longs'  && c.distancePct < 0) return true;
        return false;
      });
      if (magnets.length > 0) {
        // Use the biggest cluster (most $ wiped) for the score
        const top = magnets.sort((a, b) => (b.longUsd + b.shortUsd) - (a.longUsd + a.shortUsd))[0];
        const totalUsd = top.longUsd + top.shortUsd;
        const pts = totalUsd >= 10_000_000 ? 1.0
                  : totalUsd >= 5_000_000  ? 0.7
                  :                          0.5;
        score += pts;
        const usdStr = totalUsd >= 1e9 ? `$${(totalUsd/1e9).toFixed(2)}B`
                     : totalUsd >= 1e6 ? `$${(totalUsd/1e6).toFixed(1)}M`
                     :                   `$${(totalUsd/1e3).toFixed(0)}K`;
        const distStr = `${top.distancePct >= 0 ? '+' : ''}${top.distancePct.toFixed(1)}%`;
        const sideWord = top.dominantSide === 'shorts' ? 'shorts wiped' : 'longs wiped';
        reasons.push({
          kind: 'liqCluster',
          text: `Liq cluster ${usdStr} ${sideWord} at $${top.midPrice.toLocaleString(undefined, { maximumSignificantDigits: 6 })} (${distStr}) — magnet for ${side}`,
          points: pts
        });
      }
    }

    // 6c-ii. Projected leverage-liquidation HEATMAP magnets (the Coinglass-style
    // /liqmap zones, now fed into scoring). Cache-only via peek() → ZERO added
    // Coinalyze load in the hot path (warmed in the background for hot tokens).
    // A large projected SHORT-liq cluster ABOVE (for a LONG) or LONG-liq cluster
    // BELOW (for a SHORT), within reach, is squeeze/flush fuel toward TP — the
    // same magnet logic as 6c but forward-looking (where stops SIT) rather than
    // where they were recently wiped. Skipped on liquidation triggers (the
    // cascade already scored its base — avoid triple-counting the same event).
    if (currentPrice && this.liquidationHeatmap?.peek && trigger.type !== 'liquidation') {
      const hm = this.liquidationHeatmap.peek(context.token.symbol);
      if (hm) {
        const pool = side === 'LONG' ? (hm.shortLiqs ?? []) : (hm.longLiqs ?? []);
        const best = pool
          .filter(c => side === 'LONG' ? (c.distancePct > 1 && c.distancePct <= 15)
                                       : (c.distancePct < -1 && c.distancePct >= -15))
          .sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
        if (best && best.notionalUsd >= this.liqMagnetMinUsd) {
          const usd = best.notionalUsd;
          // Heavier weight than before (was 0.2/0.35/0.5): the liquidation magnet
          // is a primary directional read in the NOX framework, not a footnote.
          const mx = this.liqMagnetMaxPts;
          const pts = Number((mx * (usd >= 20_000_000 ? 1 : usd >= 5_000_000 ? 0.67 : 0.4)).toFixed(2));
          score += pts;
          const usdStr = usd >= 1e9 ? `$${(usd / 1e9).toFixed(2)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(1)}M` : `$${(usd / 1e3).toFixed(0)}K`;
          reasons.push({
            kind: 'liqLevels',
            text: `Liq-heatmap magnet ${usdStr} ${side === 'LONG' ? 'short' : 'long'} liquidations at ${best.distancePct >= 0 ? '+' : ''}${best.distancePct.toFixed(1)}%, fuel toward ${side} TP`,
            points: pts
          });
        }
      }
    }

    // 6c-iii. LIQUIDITY-SWEEP reversal ("take liquidity both sides"). When price has
    // just swept a sizable liq cluster on one side (tagged it, the cluster is gone),
    // it tends to reverse and hunt the cluster on the OTHER side. A fresh sweep that
    // favours THIS trade's FADE direction (highs swept → SHORT; lows swept → LONG)
    // adds a bounded, size-scaled bonus and names the opposite cluster as the target.
    // Confluence-only: capped so it can never fire a trade by itself.
    if (this.liqSweepDetect && this.liquidationHeatmap?.recentSweep) {
      const sweep = this.liquidationHeatmap.recentSweep(context.token.symbol, this.liqSweepMaxAgeMs);
      if (sweep && sweep.fadeSide === side && sweep.targetPrice && trigger.type !== 'liquidation') {
        const pts = Number(Math.min(this.liqSweepMaxPts,
          this.liqSweepMaxPts * Math.min(1, (sweep.sweptUsd ?? 0) / (this.liqSweepMinUsd * 5))).toFixed(2));
        if (pts > 0) {
          score += pts;
          const swept = sweep.sweptUsd >= 1e6 ? `$${(sweep.sweptUsd / 1e6).toFixed(1)}M` : `$${Math.round((sweep.sweptUsd ?? 0) / 1e3)}K`;
          const tgt = sweep.targetUsd >= 1e6 ? `$${(sweep.targetUsd / 1e6).toFixed(1)}M` : `$${Math.round((sweep.targetUsd ?? 0) / 1e3)}K`;
          reasons.push({
            kind: 'liqSweep',
            text: `🌊 Liquidity sweep: ${sweep.side === 'up' ? 'highs' : 'lows'} swept (${swept} liqs taken), reversal targets the ${tgt} cluster ${sweep.targetDistPct >= 0 ? '+' : ''}${sweep.targetDistPct.toFixed(1)}% away (supports ${side})`,
            points: pts
          });
        }
      }
    }

    // 6d. FDV overhang — fully-diluted-vs-circulating ratio is supply waiting
    // to unlock. High ratios (≥3×) indicate significant future-dilution
    // pressure: bias LONG signals down (overhang risk), bias SHORT signals
    // up (sell pressure already baked into the supply structure). Mirrors
    // the CEX cold-wallet concentration check (`supplyPct`), but uses the
    // token's permanent supply structure instead of dynamic exchange
    // inventory. The two are independent — both can apply.
    const fdvRatio = universeInfo?.fdvRatio;
    if (typeof fdvRatio === 'number' && fdvRatio >= 1.5) {
      const pts = side === 'SHORT'
        ? (fdvRatio >= 7 ? 1.0 : fdvRatio >= 3 ? 0.6 : 0.3)
        : (fdvRatio >= 7 ? -0.8 : fdvRatio >= 3 ? -0.5 : -0.2);
      score += pts;
      reasons.push({
        kind: 'fdv',
        text: side === 'SHORT'
          ? `FDV/MC ${fdvRatio.toFixed(1)}× — heavy dilution overhang supports SHORT`
          : `FDV/MC ${fdvRatio.toFixed(1)}× — dilution overhang against LONG`,
        points: pts
      });
    }

    // 7. % of circulating supply moving through CEX custody recently.
    //   LONG  context: bullish supply flow (hot→cold accumulation / cold→
    //                  external withdrawal — supply leaving the market).
    //                  flow.direction === 'long'
    //   SHORT context: bearish supply flow (cold→hot distribution / insider→
    //                  CEX / external→cold — supply mobilising for sale).
    //                  flow.direction === 'short'
    // Audit §3.6: the SHORT mirror was missing, so SHORT signals were
    // systematically under-credited vs LONG. §6.3: point values HALVED
    // (supplyPct measured 31% — the worst single factor) until the now-
    // symmetric logic re-proves itself on hold-out data.
    if (currentPrice && universeInfo?.circulatingSupply) {
      const wantDir = side === 'LONG' ? 'long' : 'short';
      let supplyFlowUsd = 0;
      for (const e of recentFlows) {
        if (e.flow.direction === wantDir && e.usd) supplyFlowUsd += e.usd;
      }
      if (supplyFlowUsd > 0) {
        const supplyUsd = universeInfo.circulatingSupply * currentPrice;
        const pct = (supplyFlowUsd / supplyUsd) * 100;
        if (pct >= 0.5) {
          const pts = pct >= 5 ? 0.75 : (pct >= 1 ? 0.5 : 0.25);
          score += pts;
          const tail = side === 'LONG'
            ? 'supply leaving the market (accumulation)'
            : 'supply mobilising through CEX custody (distribution)';
          reasons.push({
            kind: 'supplyPct',
            text: `${side === 'LONG' ? 'Bullish' : 'Bearish'} CEX supply flow $${supplyFlowUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} (~${pct.toFixed(2)}% of circulating supply) in last ${Math.round(this.flowHistoryMs/60000)}min — ${tail}`,
            points: pts
          });
        }
      }
    }

    // 7a. HOLDER CONCENTRATION (manipulation risk — the "top 10 control 90%"
    // tell). When the float sits in very few non-CEX wallets, the token is prone
    // to coordinated pump-then-distribute (the BEAT/VELVET/H pattern). Bearish
    // bias: it makes a SHORT thesis MORE credible (dump risk) and a LONG riskier
    // (trap pump). Only fires when discovery has real holder data for the token.
    {
      const conc = this.teamDiscovery?.getConcentration?.(context.token?.symbol);
      const top10 = conc?.top10Pct;
      if (top10 != null && top10 >= 60) {
        const pts = side === 'SHORT' ? (top10 >= 85 ? 0.6 : 0.3) : (top10 >= 85 ? -0.5 : -0.25);
        score += pts;
        reasons.push({
          kind: 'concentration',
          text: `⚠️ Top-10 holders control ~${top10.toFixed(0)}% of the float — highly concentrated, manipulation-prone ${side === 'SHORT' ? '(coordinated-dump risk → supports SHORT)' : '(trap-pump risk → against LONG)'}`,
          points: pts
        });
      }
    }

    // 7b. Global BTC-regime filter (item G). The single biggest source of
    // "right setup, wrong market" losses on alts is BTC's macro: a LONG into a
    // BTC downtrend (or a SHORT into a BTC rip) usually gets invalidated no
    // matter how clean it looked. Penalise fighting BTC's trend; small tailwind
    // when aligned. Skip the regime symbol itself (its own TA IS the regime).
    if (this.regimeMonitor && this.regimePenalty > 0 && this.regimeMonitor.isEnabled?.() !== false) {
      const sym = context.token?.symbol?.toUpperCase();
      if (sym && sym !== (this.regimeMonitor.symbol ?? 'BTC')) {
        const r = regimeScoreForSide(side, this.regimeMonitor.get(), { penalty: this.regimePenalty });
        if (r && r.points !== 0) {
          score += r.points;
          reasons.push({ kind: r.kind, text: r.text, points: r.points });
        }
      }
    }

    // 8. Technical analysis findings (from taService, if any)
    //
    // Cap on combined TA contribution: individual findings are correlated
    // (MACD bear cross + MACD hist falling + BOS bearish + CHoCH bearish
    // are all "downward momentum" said four different ways). Summing them
    // unweighted lets a token with 8 correlated bearish findings rack up
    // +1.6, pushing it into HIGH/VERY-HIGH tier despite no independent
    // confirmation. We now apply diminishing-returns scaling across all TA
    // (and SMC) findings — the first +1.5 worth flows through, after that
    // each additional point only contributes 50% (capped at +2.5 total).
    // Negative TA points (e.g. RSI against the trade) always count fully —
    // we want disconfirmation to bite hard.
    const TA_SOFT_CAP = SCORING.taSoftCap;   // rank 4: cap correlated TA so it can't manufacture a tier (default 1.5)
    const TA_HARD_CAP = SCORING.taHardCap;   // default 2.5
    let taPositiveAccum = 0;
    let taAppliedSum = 0;
    for (const f of context.taFindings ?? []) {
      let applied = f.points;
      if (f.points > 0) {
        const remainingBelowSoft = Math.max(0, TA_SOFT_CAP - taPositiveAccum);
        const inSoftZone = Math.min(f.points, remainingBelowSoft);
        const inDiminishedZone = Math.max(0, f.points - inSoftZone);
        // De-weight positive TA on manipulated tokens — the chart is noise there
        // (negative/disconfirming TA below still counts fully).
        applied = (inSoftZone + inDiminishedZone * 0.5) * taDeweight;
        // Hard ceiling — never exceed TA_HARD_CAP cumulatively
        const wouldExceed = Math.max(0, taAppliedSum + applied - TA_HARD_CAP);
        applied -= wouldExceed;
        if (applied < 0) applied = 0;
        taPositiveAccum += f.points;       // track raw for ratio calc next finding
        taAppliedSum += applied;
      }
      score += applied;
      reasons.push({ kind: f.kind ?? 'ta', text: f.text, points: Number(applied.toFixed(3)) });
    }

    // ── Manipulation phase + regime (NOX playbook, PHASE-AWARE) ──────────────
    // The engineered pump runs in phases, so the bias is NOT always "fade":
    //   • SQUEEZE-UP (shorts crowded → negative funding → price hunts the short-
    //     liquidation fuel above): RIDE it (LONG into the fuel).
    //   • BLOW-OFF / DISTRIBUTION (supply leaving to CEXes, longs crowded): FADE
    //     it (SHORT the dump).
    // One phase read drives BOTH the per-leg manipulation bias and the regime
    // co-occurrence bonus, so they never point opposite ways.
    // "Supply shock" = a REAL distribution: a tracked insider selling into a CEX, or a
    // flagged distribution event. It must NOT fire on any transfer whose destination is
    // an exchange wallet (toType hot/cold) — those are mostly custody/treasury ops, and
    // counting them made a LONG flow signal flag itself as "distributing", flip the
    // regime bias to SHORT, and PENALISE its own LONG (the cross-module contradiction
    // behind 22%-WR flow / 30% supplyPct). One consistent definition of distribution.
    const supplyShock = (recentFlows ?? []).some(
      e => e.flow?.teamFlow?.side === 'sell' || e.flow?.distribution
    );
    const squeeze = trigger?.type === 'liquidation' || (recentLiquidations ?? []).length > 0;
    const distributing = supplyShock || trigger?.type === 'distribution'
      || (recentFlows ?? []).some(e => e.flow?.distribution);
    const hmPhase = this.liquidationHeatmap?.peek?.(context.token.symbol);
    const squeezeFuelAbove = !!(hmPhase?.shortLiqs ?? []).some(
      c => c.distancePct > 1 && c.distancePct <= 15 && (c.notionalUsd ?? 0) >= this.liqMagnetMinUsd
    );
    // ride OPT-IN: default OFF → manipulation always fades (the safe behaviour
    // from the 56%-WR commit). Set PUMP_REGIME_RIDE=1 to let a confirmed squeeze
    // flip the auto-trade direction to LONG (advanced; chases pumps if mistimed).
    const manipFavored = pumpRegimeBias({
      fundingAvg: funding?.summary?.avg ?? null, distributing, squeezeFuelAbove,
      ride: process.env.PUMP_REGIME_RIDE === '1',
    });
    const phaseWord = manipFavored === 'LONG'
      ? 'squeeze-up phase: ride into the liquidation fuel above (supports LONG)'
      : 'blow-off / distribution phase: fade the move (supports SHORT)';

    // Per-leg manipulation bias, pointed at the phase-favored side.
    if (manip.score > 0 && manip.flags.length) {
      const pts = side === manipFavored ? (manip.score * MANIP_SHORT_BOOST) : -(manip.score * MANIP_LONG_PENALTY);
      score += pts;
      reasons.push({
        kind: 'manipulation',
        text: `⚠️ Manipulation risk ${Math.round(manip.score * 100)}%: ${manip.flags.join(', ')} (${side === manipFavored ? phaseWord : 'against the manipulation phase; TA de-weighted'})`,
        points: Number(pts.toFixed(3))
      });
    }

    // FUSED regime — several legs stacked = one coordinated pump. A co-occurrence
    // conviction bump ON TOP of the per-leg nudges, pointed at the same phase side.
    const regime = assessPumpRegime({ manipFlags: manip.flags, supplyShock, squeeze }, this.pumpRegimeMinLegs);
    if (regime.isRegime && this.pumpRegimeMaxBonus > 0) {
      const amp = Math.min(this.pumpRegimeMaxBonus, 0.3 * (regime.count - (this.pumpRegimeMinLegs - 1)));
      const pts = side === manipFavored ? amp : -amp;
      score += pts;
      reasons.push({
        kind: 'manipRegime',
        text: `🎭 Manipulation regime: ${regime.count} signals stacked (${regime.legs.slice(0, 5).join(', ')}). ${phaseWord}.`,
        points: Number(pts.toFixed(2))
      });
    }

    // PRE-PUMP setup (bullish, EARLY) — opt-in, LONG-only, and only while NOT
    // distributing (so it never adds to a SHORT or to a token already dumping into
    // CEXes). Capped + confluence-only: it can lift a forming LONG toward grade but
    // can't fire one alone. Inputs are proxied from data already computed above:
    // supply off-CEX (an insider buy / cold-withdrawal flow), thin float + heavy
    // volume (manip flags), OI stacking (positive OI score), shorts crowded (neg funding).
    if (this.enablePrePump && side === 'LONG' && !distributing) {
      // OI score is block-scoped above (the `if (surgeDir)` block), so recompute it
      // here for the OI-rising leg instead of referencing the out-of-scope name.
      const oiForSide = surgeDir ? (oiScoreForSide(side, funding?.summary, surgeDir) ?? 0) : 0;
      const setup = assessPrePumpSetup({
        supplyOffCex:  (recentFlows ?? []).some(e => e.flow?.teamFlow?.side === 'buy' || e.flow?.fromType === 'cold'),
        thinFloat:     manip.flags.some(f => /float/i.test(f)),
        oiRising:      oiForSide > 0,
        volumeSpiking: manip.flags.some(f => /vol/i.test(f)) || (recentSurges ?? []).some(e => e.surge?.volumeRatio >= 2),
        shortsCrowded: (funding?.summary?.avg ?? 0) < 0,
      }, this.prePumpMinLegs);
      if (setup.isSetup) {
        const pts = Number(Math.min(this.prePumpMaxPts, 0.4 * setup.count).toFixed(2));
        score += pts;
        reasons.push({
          kind: 'prePump',
          text: `🌱 Pre-pump setup: ${setup.count} legs (${setup.legs.join(', ')}) — accumulation forming before the spike (LONG)`,
          points: pts
        });
      }
    }

    // DISTRIBUTION CONFLICT — bearish reconciliation for LONGs. A verified insider
    // SELL to a CEX, or an aggregate distribution episode, on THIS token within the
    // recent window is direct evidence supply is leaving custody for sale. Firing a
    // LONG into that is the NFP contradiction (bot said LONG while insider #11 dumped
    // $518k into Binance). Penalise heavily, scaled by dump size vs market cap, so the
    // LONG needs overwhelming other confluence to survive (usually drops to observation).
    if (side === 'LONG' && this.distConflictPts > 0) {
      const cgId = context.token?.coingeckoId;
      const now = context.timestamp ?? Date.now();
      let sellUsd = 0, legs = 0;
      for (const e of (recentFlows ?? [])) {                              // insider sells (already windowed)
        if (e?.flow?.teamFlow?.side === 'sell' && e.usd > 0) { sellUsd += e.usd; legs++; }
      }
      for (const d of (this.distributionByCgId.get(cgId) ?? [])) {        // aggregate distribution episodes
        if (now - d.ts <= this.distConflictWindowMs && d.usd > 0) { sellUsd += d.usd; legs++; }
      }
      if (legs > 0 && sellUsd >= this.minFlowUsd * 0.25) {                // material, not dust
        const mcap = universeInfo?.marketCap ?? null;
        const pctMcap = mcap > 0 ? (sellUsd / mcap) * 100 : null;
        const extra = pctMcap != null ? Math.min(1.5, pctMcap * 3) : 0;   // ~0.5% of mcap → +1.5 extra
        const pts = -(this.distConflictPts + extra);
        score += pts;
        reasons.push({
          kind: 'distributionConflict',
          text: `⚠️ Active insider distribution — ~$${Math.round(sellUsd).toLocaleString()} sold to CEX in the last ${Math.round(this.distConflictWindowMs / 60000)}min${pctMcap != null ? ` (${pctMcap.toFixed(2)}% of mcap)` : ''}; supply leaving custody, fading the LONG`,
          points: Number(pts.toFixed(2))
        });
      }
    }

    return { score, reasons, strength: this.#strengthLabel(score), manipulationRegime: regime.isRegime };
  }

  // Roll the live data sources into the NOX manipulation inputs (see
  // assessManipulation). Float = circulating/total supply from the universe.
  #assessManipulation(token) {
    if (!token) return { score: 0, flags: [] };
    const cgId = token.coingeckoId;
    // Supply / market-cap fields come from the FULL universe entry, not the
    // minimal {symbol,coingeckoId,chain} token the event + analyze paths pass in.
    // Reading them off the passed token silently nulled the float + vol/mcap legs
    // (they only fired when a caller happened to pass a full token).
    const u = (cgId && this.universe?.lookupByCgId?.(cgId)) || token;
    const circ = u.circulatingSupply, total = u.totalSupply;
    const floatPct = (circ > 0 && total > 0) ? circ / total : null;
    return assessManipulation({
      futuresVol: this.prices?.getFuturesVolume?.(cgId),
      spotVol: this.prices?.getSpotVolume?.(cgId),
      volume: this.prices?.get24hVolume?.(cgId),
      marketCap: u.marketCap,
      floatPct,
      concentrationPct: this.teamDiscovery?.getConcentration?.(token.symbol)?.top10Pct ?? null,
    });
  }

  // Build a TF-aware suggested trade plan from multi-timeframe TA metadata.
  //
  // Logic:
  //   1. Count timeframes whose MACD trend aligns with `side` (5m/1h/4h/1d)
  //   2. Pick a HOLDING horizon based on confluence:
  //        - 3-4 TFs aligned incl. daily → POSITION (24-72h hold, use 4h ATR)
  //        - 2-3 TFs aligned incl. 4h    → SWING    (8-24h hold, use 1h ATR)
  //        - 1-2 TFs aligned (mostly 1h) → DAY      (2-8h hold,  use 1h ATR)
  //        - else (5m only)              → SCALP    (30min-2h,   use 5m ATR)
  //   3. SL = 1.5× chosen-TF ATR; TP1/2/3 = 1/2/3× same ATR
  //   4. Leverage scaled by SL% AND trend-confidence (more alignment = more lev)
  //      Hard ceiling: 25x. For tight SLs the cap kicks in to control slippage risk.
  //   5. Validity matches the holding horizon
  //   6. TPs snap to swing structure AND orderbook walls (heatmapWalls)

  // ── Orderbook heatmap helpers (used by BOTH /analyze and event signals) ───

  // Fetch the live L2 orderbook heatmap for `sym` (cached by LiquidityClusters).
  async #fetchHeatmap(sym) {
    if (!this.liquidityClusters) return null;
    try { return await this.liquidityClusters.getClusters(sym); }
    catch (err) { if (this.verbose) console.warn(`[liq-clusters] ${sym}: ${err.message}`); return null; }
  }

  // A wall's significance is RELATIVE to its own book — dominance vs the median
  // wall — so a $555K wall on a low-cap registers like a $30M wall on BTC, while
  // uniform/dust books score nothing. Plus a small absolute floor. Returns a
  // points function. (Fixes the old absolute $1M threshold that never fired on
  // anything but majors.)
  #wallScorer(lc) {
    const HEATMAP_ABS_FLOOR = 50_000;
    const sizes = [...(lc?.bidClusters ?? []), ...(lc?.askClusters ?? [])]
      .map(c => c.sizeUsd).filter(s => s > 0).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    return (usd) => {
      if (!(usd >= HEATMAP_ABS_FLOOR) || median <= 0) return 0;
      const d = usd / median;                          // dominance
      return d >= 5 ? 0.5 : d >= 3 ? 0.3 : d >= 2 ? 0.15 : 0;
    };
  }

  // Biggest wall within the reachable 2–8% band from a cluster list.
  #pickBandWall(arr) {
    const inBand = (arr ?? []).filter(c => Math.abs(c.distancePct) >= 2 && Math.abs(c.distancePct) <= 8);
    return inBand.sort((a, b) => b.sizeUsd - a.sizeUsd)[0] ?? null;
  }

  // Score the heatmap for a side: a dominant wall BEHIND the trade defends it
  // (+), a dominant wall IN ITS PATH is a barrier to TP (−). Walls are
  // support/resistance, not magnets (audit §2.1). Returns finding objects.
  #heatmapFindings(lc, side) {
    if (!lc) return [];
    const wallPts = this.#wallScorer(lc);
    const fmtUsd = (u) => u >= 1e6 ? `$${(u/1e6).toFixed(1)}M` : `$${(u/1e3).toFixed(0)}K`;
    // Display the LITERAL combined book size (rawUsd); score on the
    // confirmation-weighted sizeUsd (via wallPts). Tag walls confirmed on ≥2
    // venues so a real (non-spoof) wall is visible in the alert.
    const shownUsd = (c) => fmtUsd(c.rawUsd ?? c.sizeUsd);
    const srcTag = (c) => `${lc.source}${(c.venues ?? 0) >= 2 ? ' ✓2-venue' : ''}`;
    const out = [];
    const support = this.#pickBandWall(side === 'LONG' ? lc.bidClusters : lc.askClusters);
    if (support && wallPts(support.sizeUsd) > 0) {
      const pts = wallPts(support.sizeUsd);
      const distStr = `${support.distancePct >= 0 ? '+' : ''}${support.distancePct.toFixed(1)}%`;
      const word = side === 'LONG' ? 'bid wall (support)' : 'ask wall (resistance cap)';
      out.push({ kind: 'liqHeatmap', text: `Orderbook ${word} ${shownUsd(support)} at ${distStr} (${srcTag(support)}) — defends ${side}`, points: pts });
    }
    const block = this.#pickBandWall(side === 'LONG' ? lc.askClusters : lc.bidClusters);
    if (block && wallPts(block.sizeUsd) > 0) {
      const pts = wallPts(block.sizeUsd);
      const distStr = `${block.distancePct >= 0 ? '+' : ''}${block.distancePct.toFixed(1)}%`;
      const word = side === 'LONG' ? 'ask wall (resistance)' : 'bid wall (support floor)';
      out.push({ kind: 'liqHeatmap', text: `Orderbook ${word} ${shownUsd(block)} at ${distStr} (${srcTag(block)}) — barrier to ${side} TP`, points: -pts });
    }
    return out;
  }

  // Dominant walls IN THE TRADE'S PATH as TP-snap candidates — a LONG takes
  // profit just BELOW an ask wall, a SHORT just ABOVE a bid wall (where price
  // stalls). Returns [{ price, sizeUsd }].
  #heatmapTpWalls(lc, side) {
    if (!lc) return [];
    const wallPts = this.#wallScorer(lc);
    const path = side === 'LONG' ? (lc.askClusters ?? []) : (lc.bidClusters ?? []);
    const out = [];
    for (const c of path) {
      if (!(c.midPrice > 0) || wallPts(c.sizeUsd) === 0) continue;
      out.push({ price: side === 'LONG' ? c.midPrice * 0.998 : c.midPrice * 1.002, sizeUsd: c.sizeUsd });
    }
    return out;
  }

  // TP-snap walls = orderbook walls PLUS, when a fresh liquidity sweep favours this
  // side, the OPPOSITE liq cluster the fade rides into. The directional read (fade)
  // and the cluster price now work hand in hand: the sweep biases the side in
  // #evaluate, and the cluster becomes a TP-snap target here, so a TP lands right at
  // the magnet the cascade is drawn toward. Same near-side nudge as orderbook walls
  // (exit a hair BEFORE the cluster, ahead of the cascade-and-bounce). The R-band in
  // #snapTpsToStructure still governs WHICH TP it anchors (or none, if out of reach).
  #tpWallsWithSweep(lc, side, symbol, refPrice) {
    const walls = this.#heatmapTpWalls(lc, side);
    if (!this.liqSweepDetect || !this.liquidationHeatmap?.recentSweep || !symbol) return walls;
    const sweep = this.liquidationHeatmap.recentSweep(symbol, this.liqSweepMaxAgeMs);
    if (sweep && sweep.fadeSide === side && sweep.targetPrice > 0) {
      const px = side === 'LONG' ? sweep.targetPrice * 0.998 : sweep.targetPrice * 1.002;
      if (side === 'LONG' ? px > refPrice : px < refPrice) {
        walls.push({ price: px, sizeUsd: sweep.targetUsd ?? this.liqSweepMinUsd, tf: 'liq-sweep' });
      }
    }
    return walls;
  }

  #buildTradePlan(entry, side, taMetadata, heatmapWalls = [], trigger = null, liqMagnets = [], liqTargets = []) {
    if (!entry || !taMetadata) return null;

    // 6 TFs now participate in alignment (1m,5m,1h,4h,1d,1w) — weights from the
    // canonical shared vector (audit §3.25), so ta.js, ta-confirm.js and this
    // trade-plan builder can no longer drift apart. Higher TFs carry more
    // conviction; daily + weekly together dominate.
    const tfs = TF_ORDER;
    const TF_WEIGHTS = TF_ALIGNMENT_WEIGHTS;
    const aligned = [];
    let weightedAlignment = 0;
    for (const tf of tfs) {
      const m = taMetadata[tf];
      if (!m) continue;
      if (side === 'LONG'  && m.trend === 'up')   { aligned.push(tf); weightedAlignment += TF_WEIGHTS[tf] ?? 0; }
      if (side === 'SHORT' && m.trend === 'down') { aligned.push(tf); weightedAlignment += TF_WEIGHTS[tf] ?? 0; }
    }
    const alignmentCount = aligned.length;

    // Higher-TF veto. Daily AGAINST → counter-trend; refuse long-horizon trades
    // (block SWING/POSITION, cap at DAY) and route to a stop-cluster limit
    // entry. Weekly AGAINST → still allow up to SWING (a daily-aligned pullback
    // inside a weekly downtrend is tradeable), but never a multi-day POSITION
    // hold against the weekly macro.
    const dailyTrend  = taMetadata.daily?.trend;
    const weeklyTrend = taMetadata['1week']?.trend;
    const dailyTrendKnown = dailyTrend != null;     // false → no daily bars (soft penalty downstream)
    const dailyAgainst = (side === 'LONG'  && dailyTrend === 'down') ||
                         (side === 'SHORT' && dailyTrend === 'up');
    const weeklyAgainst = (side === 'LONG'  && weeklyTrend === 'down') ||
                          (side === 'SHORT' && weeklyTrend === 'up');

    // RSI EXHAUSTION — entering AGAINST a stretched move: buying a parabolic top
    // (LONG into multi-TF overbought) or selling a capitulation (SHORT into
    // multi-TF oversold). This is the single most damaging losing pattern we've
    // seen (STG LONG −10.86% at RSI 86/91/80; HOME, LAB). Count the higher TFs
    // at the extreme AGAINST the trade, and flag the fast (5m) entry TF for the
    // surge-chase case (WAL: surge UP into 5m RSI 85). Penalised in
    // #applyTradeQualityPenalties so it runs on EVERY path (event + movers + /analyze).
    const rsiAgainst = (rsi) => rsi != null && isFinite(rsi) && (side === 'LONG' ? rsi >= 80 : rsi <= 20);
    const extremeMag = (rsi) => side === 'LONG' ? rsi : 100 - rsi;     // how deep into the extreme
    let exhaustionTfs = 0, exhaustionMax = 0;
    for (const tf of ['1hour', '4hour', 'daily', '1week']) {
      const rsi = taMetadata[tf]?.rsi;
      if (rsiAgainst(rsi)) { exhaustionTfs++; exhaustionMax = Math.max(exhaustionMax, extremeMag(rsi)); }
    }
    const entryTfExhausted = rsiAgainst(taMetadata['5min']?.rsi);

    // Structural room ahead of the entry (resistance overhead for a LONG, support
    // underfoot for a SHORT). Demotion applied downstream in
    // #applyTradeQualityPenalties — see the STRUCT_GUARD block. Null = clear path.
    const structRoom = structuralRoom(side, entry, taMetadata);

    // Horizon selection — weighted thresholds (re-tuned for the 6-TF weight
    // vector) gate the bigger horizons. POSITION is the longest hold; when the
    // WEEKLY also aligns the hold is extended (stronger macro conviction →
    // longer runway), which is the "probably hold time" improvement weekly
    // unlocks.
    let horizon, chosenTfForAtr, validityHrs;
    if (dailyAgainst) {
      // Daily against — block SWING/POSITION entirely.
      if (alignmentCount >= 1 && aligned.includes('1hour') && weightedAlignment >= 0.14) {
        horizon = 'DAY';      chosenTfForAtr = '1hour'; validityHrs = 8;
      } else {
        horizon = 'SCALP';    chosenTfForAtr = '5min';  validityHrs = 2;
      }
    } else if (!weeklyAgainst && alignmentCount >= 3 && aligned.includes('daily') && weightedAlignment >= 0.50) {
      // POSITION — daily on-side, weekly not against. Weekly aligned too → 5d hold.
      horizon = 'POSITION';   chosenTfForAtr = '4hour'; validityHrs = aligned.includes('1week') ? 120 : 72;
    } else if (alignmentCount >= 1 && (aligned.includes('4hour') || aligned.includes('daily')) && weightedAlignment >= 0.24) {
      horizon = 'SWING';      chosenTfForAtr = '1hour'; validityHrs = 24;
    } else if (alignmentCount >= 1 && aligned.includes('1hour') && weightedAlignment >= 0.14) {
      horizon = 'DAY';        chosenTfForAtr = '1hour'; validityHrs = 8;
    } else {
      horizon = 'SCALP';      chosenTfForAtr = '5min';  validityHrs = 2;
    }

    // Pick ATR from chosen TF; fall back to whatever ATR is available
    let atr = taMetadata[chosenTfForAtr]?.atr;
    if (!atr || !isFinite(atr) || atr <= 0) {
      for (const tf of tfs) {
        const a = taMetadata[tf]?.atr;
        if (a && isFinite(a) && a > 0) { atr = a; break; }
      }
    }
    if (!atr || atr <= 0) return null;

    // Wick-aware SL multiplier — choppier tokens (lots of wicks vs body)
    // need wider SLs so normal noise doesn't take them out. The chosen-TF
    // recentWickRatio (avg upper+lower wick / avg body over last 10 bars)
    // drives the multiplier:
    //   ratio ≥ 3   → 2.5× ATR (very choppy: think MYX/BAN-style charts)
    //   ratio ≥ 2   → 2.0× ATR (moderately choppy)
    //   otherwise   → 1.5× ATR (calm)
    // TPs remain multiples of SL distance so real R:R stays 1.5 / 3 / 4.5.
    const wickRatio = taMetadata[chosenTfForAtr]?.recentWickRatio ?? 1;
    let slMultiplier;
    if      (wickRatio >= 3) slMultiplier = 2.5;
    else if (wickRatio >= 2) slMultiplier = 2.0;
    else                     slMultiplier = 1.5;
    let slDistance = atr * slMultiplier;
    const atrSlDistance = slDistance;            // pre-structure ATR distance (LG path keeps this)
    let slPct = (slDistance / entry) * 100;
    // SL ceiling is HORIZON-SCALED (the MYX fix: a SCALP shipped a 10.45% stop,
    // turning a fast trade into a ruinous loss when wrong — losers averaged
    // −6.6%). A scalp's invalidation is near; a position's is far. Caps the
    // structure-SL widening below AND the final cap. Structure can't drag a
    // SCALP stop out to a swing 10% away — it falls back to the (tighter) ATR
    // stop instead.
    const MAX_SL_PCT = SL_MAX_PCT[horizon] ?? SL_MAX_PCT.POSITION;

    // ── Structure-aware SL (the WAL lesson) ───────────────────────────────────
    // A pure ATR stop sits at a FIXED distance regardless of WHERE the real
    // invalidation is. WAL LONG stopped at 2.25% (mid-structure) and THEN ran to
    // TP3 — its stop sat ABOVE the Triple-bottom (the true invalidation), so the
    // liquidity sweep that usually PRECEDES the move took it out. Anchor the stop
    // just BEYOND the nearest protective swing (swing low for LONG / swing high
    // for SHORT) so a stop-hunt wick into that level can't reach it. Only ever
    // WIDENS past the ATR stop (never tightens), picks the NEAREST qualifying
    // swing (minimal widening), and respects MAX_SL_PCT — the risk-engine then
    // sizes the position down for the wider stop, so account risk is unchanged.
    // Market-entry path only; the counter-trend LG path is already structure-
    // anchored to its limit, so it keeps the ATR distance (atrSlDistance).
    let slBasis = 'atr';
    {
      const buffer = Math.max(atr * 0.3, entry * 0.0015);    // sit PAST the wick, not on it
      let bestDist = null;
      for (const tf of ['5min', '1hour', '4hour', 'daily']) {
        const m = taMetadata[tf];
        if (!m) continue;
        const levels = [ ...(side === 'LONG' ? (m.swingLows ?? []) : (m.swingHighs ?? [])) ];
        const ext = side === 'LONG' ? m.swingLow : m.swingHigh;     // 20-bar extreme too
        if (isFinite(ext) && ext > 0) levels.push(ext);
        for (const lvl of levels) {
          if (!isFinite(lvl) || lvl <= 0) continue;
          if (side === 'LONG' ? lvl >= entry : lvl <= entry) continue;   // must be the protective side
          const dist = Math.abs(entry - lvl) + buffer;                   // stop just past the level
          if (dist <= slDistance) continue;                              // inside the ATR stop → noise
          if ((dist / entry) * 100 > MAX_SL_PCT) continue;               // too wide → skip
          if (bestDist == null || dist < bestDist) bestDist = dist;      // nearest qualifying swing
        }
      }
      if (bestDist != null) {
        if (this.verbose) console.log(`[trade-plan] ${side} SL → structure: ${slPct.toFixed(2)}% → ${(bestDist / entry * 100).toFixed(2)}% (just beyond nearest swing)`);
        slDistance = bestDist;
        slPct = (slDistance / entry) * 100;
        slBasis = 'structure';
      }
    }

    // Sanity CAP on SL distance (not reject). A raw 60% SL would force TP3
    // to cross zero (the BSB SHORT TP3 = -$1.12 bug). Previously we returned
    // null here — but that made the signal fire with NO entry/TP/SL at all
    // (the GUA / BSB "no trade plan" reports), and such signals can't be
    // tracked so they never appear in /open. Now we CAP the SL at MAX_SL_PCT
    // so the plan is always actionable: TPs stay positive (max move 54% at
    // 4.5R) and leverage scales down for the wide stop. The trade-quality
    // penalty system separately downgrades the tier for very wide stops.
    let slCapped = false;
    if (slPct > MAX_SL_PCT) {
      if (this.verbose) console.log(`[trade-plan] cap ${side} SL ${slPct.toFixed(1)}% → ${MAX_SL_PCT}% (ATR too wide on this TF/wick ratio)`);
      slDistance = entry * (MAX_SL_PCT / 100);
      slPct = MAX_SL_PCT;
      slCapped = true;
    }
    const sl  = side === 'LONG' ? entry - slDistance : entry + slDistance;
    // Raw ATR-multiple TPs — these are the FALLBACK levels. The chart-aware
    // snapper below pulls each TP to the nearest real swing extreme within
    // a tolerance band, so exits land on actual resistance/support rather
    // than arbitrary ATR multiples.
    //
    // When the SL was CAPPED (very wide ATR), the standard 1.5/3/4.5R multiples
    // would put TP3 at 4.5 × 12% = 54% from entry — unreachable inside the
    // validity window (audit §5, conductor.js:1133). Compress the multiples so
    // targets stay realistic when the stop is already at the max width.
    const [m1, m2, m3] = slCapped ? [1.0, 1.75, 2.5] : [1.5, 3.0, 4.5];
    const rawTp1 = side === 'LONG' ? entry + slDistance * m1 : entry - slDistance * m1;
    const rawTp2 = side === 'LONG' ? entry + slDistance * m2 : entry - slDistance * m2;
    const rawTp3 = side === 'LONG' ? entry + slDistance * m3 : entry - slDistance * m3;

    // ── Hold time, sized to the TARGET, not a flat per-horizon number ──────
    // Previously validity was a fixed 2/8/24/72h by horizon, so a winner could
    // be time-expired before price had any realistic chance to reach TP (the
    // "valid 2h but TP would hit at 4h" problem). Price nets ~1 chosen-TF ATR of
    // progress every few bars (with retracement), so bars-to-TP2 ≈ (TP2 distance
    // / ATR) × a noise factor. Convert to hours via the bar duration and clamp
    // to a sensible window — the horizon sets the floor/ceiling, volatility
    // decides where in between.
    {
      const barHrs = { '1min': 1/60, '5min': 1/12, '1hour': 1, '4hour': 4, 'daily': 24 }[chosenTfForAtr] ?? 1;
      const NOISE_FACTOR = 3;                       // ~3× the straight-line bar count
      const barsToTp2 = atr > 0 ? (slDistance * m2) / atr : 6;
      const estHrs = barsToTp2 * NOISE_FACTOR * barHrs;
      const [vMin, vMax] = horizon === 'POSITION' ? [72, 168]   // up to 1 week
                         : horizon === 'SWING'    ? [24, 60]
                         : horizon === 'DAY'      ? [8, 20]
                         :                          [3, 8];      // SCALP — was a flat 2h
      validityHrs = Math.round(Math.max(vMin, Math.min(vMax, estHrs)));
    }

    const snapped = this.#snapTpsToStructure({
      side, entry, slDistance,
      rawTp1, rawTp2, rawTp3,
      taMetadata, heatmapWalls
    });
    const tp1 = snapped.tp1;
    const tp2 = snapped.tp2;
    let tp3 = snapped.tp3;

    // CASCADE TP3 — on a liquidation / liquidity-sweep trade, extend the FINAL target
    // out to the FARTHEST sizable liquidation cluster in the profit direction (the
    // magnet the cascade is drawn into), capped at CASCADE_TP_MAX_PCT from entry. The
    // move runs to the cluster, so we ride it rather than capping TP3 at an ATR multiple.
    let cascadeTp = false;
    const isCascade = trigger?.type === 'liquidation' || trigger?.type === 'liqSweep';
    if (CASCADE_TP_EXTEND && isCascade && (liqTargets?.length)) {
      let far = null;
      for (const m of liqTargets) {
        const px = m?.price;
        if (!(px > 0) || (m.notionalUsd ?? 0) < this.liqMagnetMinUsd) continue;
        if (Math.abs(m.distancePct ?? 999) > CASCADE_TP_MAX_PCT) continue;       // within reach
        if (side === 'LONG' ? px <= tp3 : px >= tp3) continue;                   // must extend BEYOND tp3
        if (far == null || (side === 'LONG' ? px > far : px < far)) far = px;    // farthest in profit dir
      }
      if (far != null) { tp3 = side === 'LONG' ? far * 0.998 : far * 1.002; cascadeTp = true; }   // just before the cluster
    }

    // ── Leverage scaling (ADVISORY) ───────────────────────────────────────
    // rawMaxLev is the leverage at which a FULL stop-out costs `levRiskBasis`%
    // of the account, assuming the position uses the whole account as margin
    // (rawMaxLev = levRiskBasis / slPct%). The DISPLAYED suggestion is an UPPER
    // BOUND for manual sizing only — in autotrade mode the RiskEngine sizes the
    // real notional from its own riskPct + maxPositionUsd, so this number does
    // not by itself determine risk.
    //
    // Audit fixes:
    //   §3.16 — the previously-unexplained 0.4 is now the named SUGGESTED_DAMP
    //           (a safety buffer keeping the suggestion below the theoretical
    //           max), and the risk basis is a single documented constant.
    //   §3.17 — maxLev now derives from the SAME basis (not a hard-coded "2")
    //           and is tier-capped like suggested instead of a flat 25× ceiling.
    //   §3.18 — the tier-cap curve is smoothed: a normal 2.5–5% swing SL no
    //           longer falls off a cliff (was 20→10) and isn't punished.
    const SUGGESTED_DAMP = 0.4;
    const MAX_DAMP = 0.7;
    const rawMaxLev = this.levRiskBasis / (slPct / 100);
    // Confidence factor uses WEIGHTED alignment (daily/weekly carry the most).
    // Fully aligned → ~1.0; none → 0.3 floor.
    const confidenceFactor = 0.3 + Math.min(1, weightedAlignment) * 0.7;
    let tierCap;
    if      (slPct < 0.5) tierCap = 10;   // very tight SL → high slippage risk
    else if (slPct < 1.0) tierCap = 15;
    else if (slPct < 2.5) tierCap = 20;
    else if (slPct < 5.0) tierCap = 15;   // normal swing SL — smoothed (was a 20→10 cliff)
    else if (slPct < 8.0) tierCap = 8;
    else                  tierCap = 5;    // very wide SL → bigger drawdowns

    const suggested = Math.max(2, Math.min(tierCap, Math.floor(rawMaxLev * confidenceFactor * SUGGESTED_DAMP)));
    const maxLev    = Math.max(2, Math.min(tierCap, Math.floor(rawMaxLev * MAX_DAMP)));

    // Limit entry logic — ONLY for counter-trend ("stop-cluster") setups.
    //
    // Counter-trend: when daily trends against the trade direction, market
    // entry is statistically bad. Instead, target the next significant swing
    // high (for SHORT) or swing low (for LONG) on the highest TF available.
    // Price typically reaches into these zones to sweep stop-loss liquidity
    // before reversing — that's the meaningful entry point.
    //
    // The limit is placed ~0.3× ATR PAST the swing extreme (above the high
    // for SHORT, below the low for LONG). The zone is a STABLE chart level —
    // doesn't drift with current market price between analyses.
    //
    // Trend-following signals (daily aligned with trade direction) use
    // market entry only. The bot is calling the trade NOW; there's no
    // meaningful "wait for pullback" zone tied to chart structure for
    // those setups.
    let limitEntry = null;
    let isLiquidityGrab = false;
    let limitFromMagnet = false;   // limit target came from a liquidation-heatmap cluster (vs a raw swing)

    // Counter-trend, but only wait for a swing sweep when the move is COILED. If
    // the trigger is a LIVE directional move (a liquidation cascade, or a surge
    // in the trade's own direction), price is already running our way and won't
    // retrace to the swing — waiting for the bounce either misses it or fills
    // worse (the BTC-liq / HOME complaint). Enter at CMP instead. Fades (surge
    // INTO an extreme = exhaustion-reversal) still wait for the sweep-limit.
    // CMP/market entry on a live move is OPT-IN (default OFF). Reverting to "always
    // wait for the limit" is the win-rate fix (2026-06-21): when a counter-trend
    // limit doesn't fill, the correct outcome is NO TRADE, not a market chase into
    // a running move (the WCT top-long that hit SL). A missed trade is 0; a chase
    // is a loss. Set MOMENTUM_CMP_ENTRY=1 to re-enable market entry on live momentum.
    const momentumLive = process.env.MOMENTUM_CMP_ENTRY === '1' && isMomentumLive(trigger, side);
    if (dailyAgainst && momentumLive && this.verbose) {
      console.log(`[conductor] ${side} counter-trend but momentum live (${trigger.type}) — CMP/market entry, no swing limit`);
    }
    if (dailyAgainst && !momentumLive) {
      // Find the closest swing extreme on a higher TF (prefer daily → 4h → 1h)
      const candidates = side === 'SHORT'
        ? [taMetadata.daily?.swingHigh, taMetadata['4hour']?.swingHigh, taMetadata['1hour']?.swingHigh]
        : [taMetadata.daily?.swingLow,  taMetadata['4hour']?.swingLow,  taMetadata['1hour']?.swingLow];
      const valid = candidates.filter(v => typeof v === 'number' && isFinite(v) && v > 0);
      let target = null;
      if (side === 'SHORT') {
        // Pick the LOWEST swing high that is still above current price
        const above = valid.filter(v => v > entry);
        if (above.length) target = Math.min(...above);
      } else {
        // Pick the HIGHEST swing low that is still below current price
        const below = valid.filter(v => v < entry);
        if (below.length) target = Math.max(...below);
      }
      // LIQUIDATION-HEATMAP MAGNET as the sweep target, PREFERRED over the raw
      // swing: the cluster is where stops actually sit, so price is drawn there to
      // hunt it before reversing (the NOX liquidity-hunt thesis). For a SHORT take
      // the NEAREST sizable short-liq cluster ABOVE; for a LONG the nearest long-liq
      // cluster BELOW. Falls back to the swing when there is no qualifying magnet.
      let magnetTarget = null;
      for (const m of liqMagnets ?? []) {
        const px = m?.price;
        if (!(px > 0) || (m.notionalUsd ?? 0) < this.liqMagnetMinUsd) continue;
        if (side === 'SHORT' ? px <= entry : px >= entry) continue;        // must be in the sweep direction
        if (magnetTarget == null || (side === 'SHORT' ? px < magnetTarget : px > magnetTarget)) magnetTarget = px;
      }
      if (magnetTarget != null) { target = magnetTarget; limitFromMagnet = true; }
      if (target) {
        // Place the limit on the NEAR side of the swing (a small buffer INSIDE
        // it), not 0.3×ATR BEYOND it (accuracy audit E/§1, the GENIUS miss). The
        // old placement sat deeper in the stop cluster than the structure
        // itself, so price had to OVERSHOOT the level to fill — it routinely
        // didn't, and the setup expired while price ran to profit. A touch of
        // structure should fill: just below the swing high for a SHORT (price
        // rises into it), just above the swing low for a LONG (price falls into
        // it).
        const buffer = atr * 0.1;
        const candidateLimit = side === 'SHORT' ? target - buffer : target + buffer;
        // Reachability gate: if the limit sits more than MAX_LIMIT_DIST_PCT
        // away from current price, the "stop cluster" probably already got
        // swept and price is now moving away from it (the BSB case — SHORT
        // limit 68% above a falling token can't fill in a short validity window
        // without a moonshot rally). Drop the LG setup and fall back to market
        // entry. Tighter for SCALP/DAY: a 6% sweep rarely completes in 3-8h.
        const MAX_LIMIT_DIST_PCT = (horizon === 'SCALP' || horizon === 'DAY') ? 4 : 7;
        const distPct = Math.abs((candidateLimit - entry) / entry) * 100;
        if (distPct <= MAX_LIMIT_DIST_PCT) {
          limitEntry = candidateLimit;
          isLiquidityGrab = true;
        } else if (this.verbose) {
          console.log(`[conductor] ${side} LG limit ${candidateLimit.toFixed(6)} is ${distPct.toFixed(1)}% from market ${entry.toFixed(6)} — too far, falling back to market entry`);
        }
      }
    }
    // Trend-following (or LG with unreachable target): no limit. Market entry only.

    // When this is a liquidity-grab setup, SL/TPs are computed RELATIVE to
    // the limit entry — that's the real entry price if the trade triggers.
    // Otherwise SL/TPs stay anchored to the market entry (computed above).
    if (isLiquidityGrab && limitEntry) {
      const grabSlDistance = atrSlDistance;   // ATR basis: the limit is already at structure, so don't re-widen
      const grabSl  = side === 'LONG' ? limitEntry - grabSlDistance : limitEntry + grabSlDistance;
      // Same compressed multiples as the market path when the SL was capped (§5).
      const rawGrabTp1 = side === 'LONG' ? limitEntry + grabSlDistance * m1 : limitEntry - grabSlDistance * m1;
      const rawGrabTp2 = side === 'LONG' ? limitEntry + grabSlDistance * m2 : limitEntry - grabSlDistance * m2;
      const rawGrabTp3 = side === 'LONG' ? limitEntry + grabSlDistance * m3 : limitEntry - grabSlDistance * m3;
      // Snap LG TPs to swing structure relative to the limit entry (not market)
      const grabSnap = this.#snapTpsToStructure({
        side, entry: limitEntry, slDistance: grabSlDistance,
        rawTp1: rawGrabTp1, rawTp2: rawGrabTp2, rawTp3: rawGrabTp3, taMetadata, heatmapWalls
      });
      const grabTp1 = grabSnap.tp1;
      const grabTp2 = grabSnap.tp2;
      const grabTp3 = grabSnap.tp3;
      // R-multiples may differ from 1.5/3/4.5 after snapping — recompute
      const grabRR = (tp) => Math.abs(tp - limitEntry) / grabSlDistance;
      // Override the trade-plan price levels — the user sees these in the alert
      return {
        entry, sl: grabSl, tp1: grabTp1, tp2: grabTp2, tp3: grabTp3,
        slPct: (grabSlDistance / limitEntry) * 100,
        limitEntry,
        isLiquidityGrab: true,
        limitBasis: limitFromMagnet ? 'liq-magnet' : 'swing',
        slMultiplier,
        slBasis: 'liquidity-grab',     // limit sits at structure; SL is ATR beyond it
        tp1Pct: Math.abs(grabTp1 - limitEntry) / limitEntry * 100,
        tp2Pct: Math.abs(grabTp2 - limitEntry) / limitEntry * 100,
        tp3Pct: Math.abs(grabTp3 - limitEntry) / limitEntry * 100,
        rr1: Number(grabRR(grabTp1).toFixed(2)),
        rr2: Number(grabRR(grabTp2).toFixed(2)),
        rr3: Number(grabRR(grabTp3).toFixed(2)),
        tpSnapped: grabSnap.snapped,
        tpSources: grabSnap.sources,
        suggestedLeverage: suggested,
        maxLeverage: maxLev,
        validityHrs,
        horizon,
        atrTf: chosenTfForAtr,
        alignmentCount,
        alignedTfs: aligned,
        weightedAlignment: Number(weightedAlignment.toFixed(2)),
        dailyAgainst,
        dailyTrendKnown,
        weeklyAligned: aligned.includes('1week'),
        exhaustionTfs, exhaustionMax: Number(exhaustionMax.toFixed(1)), entryTfExhausted,
        structRoom,
        wickRatio: wickRatio != null ? Number(wickRatio.toFixed(2)) : null
      };
    }

    // Defensive geometry assert (audit §5, conductor.js:632) — every TP must
    // sit on the PROFIT side of entry and the SL on the LOSS side. A bad swing
    // level could otherwise snap a TP across entry, producing a "TP below entry
    // on a LONG" nonsense plan. If geometry is violated, return null so the
    // caller downgrades to an observation rather than emitting a broken plan.
    const profitSideOk = side === 'LONG'
      ? (sl < entry && tp1 > entry && tp2 > entry && tp3 > entry)
      : (sl > entry && tp1 < entry && tp2 < entry && tp3 < entry);
    if (!profitSideOk) {
      if (this.verbose) console.log(`[trade-plan] ${side} ${entry} rejected — TP/SL geometry invalid (sl=${sl} tp1=${tp1} tp2=${tp2} tp3=${tp3})`);
      return null;
    }

    // After snapping, R-multiples may differ from the raw 1.5/3/4.5 — the
    // snapper might pull TP1 to 1.2R if a swing high sits there. Recompute
    // so the alert shows the ACTUAL R achieved.
    const rrFor = (tp) => Math.abs(tp - entry) / slDistance;

    return {
      entry, sl, tp1, tp2, tp3, slPct,
      limitEntry,
      cascadeTp,                    // TP3 extended to the far liquidation magnet (ride the cascade)
      isLiquidityGrab: false,
      slMultiplier,                 // 1.5 / 2.0 / 2.5 — exposed so the alert can show "chop-adjusted"
      slBasis,                      // 'structure' (anchored beyond a swing) or 'atr' (no nearby swing)
      tp1Pct: Math.abs(tp1 - entry) / entry * 100,
      tp2Pct: Math.abs(tp2 - entry) / entry * 100,
      tp3Pct: Math.abs(tp3 - entry) / entry * 100,
      rr1: Number(rrFor(tp1).toFixed(2)),
      rr2: Number(rrFor(tp2).toFixed(2)),
      rr3: Number(rrFor(tp3).toFixed(2)),
      tpSnapped: snapped.snapped,
      tpSources: snapped.sources,
      suggestedLeverage: suggested,
      maxLeverage: maxLev,
      validityHrs,
      horizon,
      atrTf: chosenTfForAtr,
      alignmentCount,
      alignedTfs: aligned,
      weightedAlignment: Number(weightedAlignment.toFixed(2)),
      dailyAgainst,
      dailyTrendKnown,
      weeklyAligned: aligned.includes('1week'),
      exhaustionTfs, exhaustionMax: Number(exhaustionMax.toFixed(1)), entryTfExhausted,
      structRoom,
      wickRatio: wickRatio != null ? Number(wickRatio.toFixed(2)) : null
    };
  }

  // Snap each TP to the nearest natural reversal level in the trade
  // direction — swing highs (for LONG TPs) or swing lows (for SHORT TPs)
  // from any computed TF. Within an R-multiple tolerance window per TP
  // so we never pull a TP1 to where TP3 should be. Falls back to the raw
  // ATR-multiple TP when no structure is in range.
  //
  // Why this matters: ATR-multiple TPs land at arbitrary prices where
  // nothing on the chart actually causes a reversal. Snapping to swing
  // levels means exits coincide with real resistance/support, raising
  // hit probability.
  #snapTpsToStructure({ side, entry, slDistance, rawTp1, rawTp2, rawTp3, taMetadata, heatmapWalls = [] }) {
    // Collect candidate levels from every TF's swing list. Same-direction
    // only: SHORT exits ⇒ levels BELOW entry (use swingLows); LONG ⇒ ABOVE
    // (use swingHighs).
    const candidates = [];
    if (taMetadata) {
      for (const tf of ['1week', 'daily', '4hour', '1hour', '5min']) {
        const m = taMetadata[tf];
        if (!m) continue;
        const pool = side === 'LONG' ? (m.swingHighs ?? []) : (m.swingLows ?? []);
        for (const px of pool) {
          if (!isFinite(px) || px <= 0) continue;
          if (side === 'LONG' && px <= entry)  continue;     // need level ABOVE entry
          if (side === 'SHORT' && px >= entry) continue;     // need level BELOW entry
          candidates.push({ price: px, tf });
        }
      }
    }
    // Orderbook walls in the path are strong TP targets — price stalls at a big
    // resting wall, so taking profit just before it raises the hit rate (this is
    // the ESPORTS case: a $555K support wall right where the SHORT's TP should be).
    for (const w of heatmapWalls ?? []) {
      const px = w?.price;
      if (!isFinite(px) || px <= 0) continue;
      if (side === 'LONG' && px <= entry)  continue;
      if (side === 'SHORT' && px >= entry) continue;
      candidates.push({ price: px, tf: w.tf ?? 'wall' });   // tf carries the source (e.g. 'liq-sweep')
    }
    if (candidates.length === 0) {
      return { tp1: rawTp1, tp2: rawTp2, tp3: rawTp3, snapped: { tp1: false, tp2: false, tp3: false } };
    }

    // Per-TP tolerance: the level we snap to must lie roughly within the
    // R-multiple band of the target. TP1 (1.5R) accepts 0.8R–2.5R levels;
    // TP2 (3R) accepts 2.0R–4.5R; TP3 (4.5R) accepts 3.5R–6R+.
    const pickNearest = (rawTp, minR, maxR) => {
      const minDist = slDistance * minR;
      const maxDist = slDistance * maxR;
      let best = null;
      for (const c of candidates) {
        const dist = Math.abs(c.price - entry);
        if (dist < minDist || dist > maxDist) continue;
        const gap = Math.abs(c.price - rawTp);
        if (!best || gap < best.gap) best = { ...c, dist, gap };
      }
      return best;
    };

    const tp1Snap = pickNearest(rawTp1, 0.8, 2.5);
    const tp2Snap = pickNearest(rawTp2, 2.0, 4.5);
    const tp3Snap = pickNearest(rawTp3, 3.5, 6.5);

    // Resolve snapped levels, then enforce a MONOTONIC ladder. The per-TP bands
    // overlap (e.g. 2.0–2.5R qualifies for both TP1 and TP2), so independent
    // snaps can invert the ladder (TP1 pulled past TP2) — which wrecks R:R and
    // the trailing-stop logic ("at TP1 → SL to breakeven; at TP2 → SL to TP1").
    // Revert any out-of-order TP to its (always-monotonic) raw ATR multiple.
    // Resolve snapped levels and GUARANTEE a strictly-monotonic ladder (the STG
    // TP2<TP1 bug). enforceTpLadder reverts any snap that would invert the order.
    const L = enforceTpLadder(side, entry,
      { tp1: tp1Snap?.price ?? null, tp2: tp2Snap?.price ?? null, tp3: tp3Snap?.price ?? null },
      { tp1: rawTp1, tp2: rawTp2, tp3: rawTp3 });
    return {
      tp1: L.tp1, tp2: L.tp2, tp3: L.tp3,
      snapped: L.snapped,
      sources: {
        tp1: L.snapped.tp1 ? (tp1Snap?.tf ?? null) : null,
        tp2: L.snapped.tp2 ? (tp2Snap?.tf ?? null) : null,
        tp3: L.snapped.tp3 ? (tp3Snap?.tf ?? null) : null
      }
    };
  }

  // A+ CONVICTION GRADING — counts INDEPENDENT edges and decides whether a
  // signal is an elite "fat pitch". High win rate comes from selectivity, not a
  // magic threshold: an A+ needs (1) at least one PROVEN-edge source (on-chain
  // flow / funding extreme / liquidation — the 60-70% WR triggers), (2) ≥4
  // independent edge categories total, (3) a strong base tier (HIGH+), (4) R:R
  // ≥ 1.5, (5) regime NOT against, and (6) not a high-risk counter-trend fade.
  // Returns { edges, count, hasPrimary, rr, regimeAgainst, isHighConviction }.
  #assessConviction(evaluation, tradePlan, trigger, context, exhReversal) {
    return assessConviction({
      reasons: evaluation.reasons,
      tradePlan,
      triggerType: trigger?.type,
      side: context.side,
      regime: this.regimeMonitor?.get?.()?.regime ?? null,
      exhReversal,
      tier: evaluation.strength?.label,
    });
  }

  // Tier anchors — confidence% is anchored to the tier (audit §3.20) so the
  // number can never contradict the label (a HIGH always reads ~71–84%, a
  // MEDIUM ~44–56%, etc.). A small intra-tier nudge from the raw score keeps
  // same-tier signals rank-ordered.
  static TIER_CONF  = { MIXED: 10, LOW: 25, MEDIUM: 50, HIGH: 78, 'VERY HIGH': 92 };
  static TIER_FLOOR = { MIXED: 0,  LOW: 2,  MEDIUM: 3,  HIGH: 4,  'VERY HIGH': 5 };
  static TIER_EMOJI = { MIXED: '⚠️', LOW: '🟠', MEDIUM: '🟡', HIGH: '✅', 'VERY HIGH': '🔥' };

  #tierConfidence(label, score) {
    const anchor = Conductor.TIER_CONF[label] ?? 50;
    const frac = Math.max(0, Math.min(1, score - (Conductor.TIER_FLOOR[label] ?? 0)));
    return Math.max(5, Math.min(100, anchor + Math.round((frac - 0.5) * 12)));   // ±6 within tier
  }

  #strengthLabel(score) {
    const label = score >= 5 ? 'VERY HIGH'
                : score >= 4 ? 'HIGH'
                : score >= 3 ? 'MEDIUM'
                : score >= 2 ? 'LOW'
                :              'MIXED';
    return { label, emoji: Conductor.TIER_EMOJI[label], total: score, confidence: this.#tierConfidence(label, score) };
  }

  // Apply trade-quality penalties to the raw strength tier. The same score can
  // mean a great trade or a garbage one depending on R:R, trend alignment, and
  // whether the confluence is on-chain or pure sentiment. Penalties accumulate
  // as FRACTIONAL tier steps then floor, so a soft half-tier penalty (unknown
  // daily trend) can combine with full ones without over/undershooting.
  //   • R:R < 1.0                                                       −2 tiers
  //   • R:R < 1.5                                                       −1 tier
  //       R:R = best of TP1, ½·TP2, ⅓·TP3 (audit §3.19) — a good structural
  //       TP2/TP3 snap shouldn't be punished because TP1 snapped in close.
  //   • weak weighted-alignment on a SCALP/DAY horizon                  −1 tier
  //   • zero alignment AND daily explicitly against                     cap at LOW
  //   • RSI exhaustion (multi-TF extreme against entry)                 −1 / −2 tiers
  //   • surge-chase (surge into the 5m extreme it's chasing)            −1 tier
  //   • daily trend UNKNOWN (no daily bars)                             −½ tier (§5:1409)
  //   • sentiment-only (funding_extreme, no flow/liq) at HIGH+          cap at HIGH
  // Confidence% is ANCHORED to the FINAL tier (audit §3.20), so a downgraded
  // signal truthfully reports lower confidence and the number tracks the label.
  #applyTradeQualityPenalties(strength, tradePlan, trigger, context, exhReversal = false, lowConviction = false) {
    if (!tradePlan) return strength;
    // A raw MIXED is already the floor; further penalties just produce nonsense
    // negative idx / confidence (audit §5, conductor.js:1418). Return as-is.
    if (strength.label === 'MIXED') return strength;

    const tiers = ['MIXED', 'LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'];
    const idxOriginal = Math.max(0, tiers.indexOf(strength.label));
    let idx = idxOriginal;   // fractional during accumulation

    // A fresh exchange listing (esp. Upbit/Bithumb — ~95% pump on the announcement)
    // is a CATALYST trade, not a multi-TF-alignment trade: the token often has no
    // meaningful TF history to align, so the alignment penalties below would crush
    // a legitimate listing pump into observation-only. EXEMPT listings from the
    // alignment-based downgrades (like exhaustion-reversal). R:R / exhaustion /
    // regime safety checks still apply.
    const isListing = trigger?.type === 'listing';
    // HIGH-EDGE on-chain triggers (flow, distribution, liquidation) are the
    // bot's PROVEN edge and are counter-trend BY NATURE — a CEX outflow or a
    // liquidation cascade IS the directional thesis, not a TA trend-follow. The
    // alignment caps were silently demoting strong flow signals to observation-
    // only (e.g. SKYAI flow 3.96 → 👀 observation) because alt tokens rarely show
    // clean multi-TF alignment — a big reason signals dried up. Exempt these from
    // the ALIGNMENT downgrades (R:R / exhaustion / regime caps still apply).
    // DELIBERATELY EXCLUDES funding_extreme: negative funding is only a squeeze
    // POTENTIAL, not a direction. Into a downtrend the crowded shorts are often
    // RIGHT (the $PLAY case: −2.4% funding, yet the SHORT printed +1889%). The
    // dailyAgainst cap is PROTECTIVE there, so funding keeps it. HIGH_EDGE_ALIGNMENT_EXEMPT=0 to revert.
    // Only LIQUIDATION cascades are still treated as "directional by nature" and
    // exempt from the alignment cap. flow + distribution were REMOVED from this set:
    // the live sample has them at 22% / 20% WR (the worst buckets), and exempting
    // them let an on-chain SHORT fire straight into a daily uptrend (the squeeze that
    // killed them). They now get the protective dailyAgainst cap like any other trade.
    const isHighEdge = ['liquidation'].includes(trigger?.type)
      && process.env.HIGH_EDGE_ALIGNMENT_EXEMPT !== '0';
    const alignmentExempt = isListing || isHighEdge;

    // VIOLENT liquidation → +1 tier. A cascade that's a large % of OPEN INTEREST is a
    // genuinely market-moving event, so lift it one tier to offset a soft penalty
    // (e.g. R:R<1.5 or unknown-daily) and reach signal grade — the exact case your
    // BTC alert missed (MEDIUM→LOW). The HARD protective caps below still win
    // (R:R<1.0 = −2, acute counter-BTC-regime = cap LOW). Gated on LIQ_VIOLENT_OI_PCT.
    const liqOiFrac = trigger?.type === 'liquidation' ? Number(trigger.value?.oiFrac) : NaN;
    const violentLiq = isFinite(liqOiFrac) && liqOiFrac >= (numEnv('LIQ_VIOLENT_OI_PCT', 0.005));
    if (violentLiq) idx += 1;

    // R:R — best of TP1, half-credit TP2, third-credit TP3 (audit §3.19).
    const rr1 = tradePlan.rr1 ?? (tradePlan.slPct > 0 ? tradePlan.tp1Pct / tradePlan.slPct : 1);
    const rr = Math.max(rr1, (tradePlan.rr2 ?? 0) * 0.5, (tradePlan.rr3 ?? 0) * 0.33);
    if (rr < 1.0) idx -= 2;
    else if (rr < 1.5) idx -= 1;

    // "Weak alignment" uses the WEIGHTED metric — 5m+1m aligned (weighted ≈
    // 0.12) is weak regardless of count, while daily-only (0.26) is not.
    const weakAlignment = (tradePlan.weightedAlignment ?? 0) <= 0.15;
    const shortHorizon = tradePlan.horizon === 'SCALP' || tradePlan.horizon === 'DAY';
    if (weakAlignment && shortHorizon && !alignmentExempt) idx -= 1;

    // ── Alignment GATES confidence (the MYX fix). Data: VERY HIGH 0/2, SHORT
    // 30% (n=20 — 80% of signals were counter-trend shorts). The tier was driven
    // by STACKED overbought-RSI / funding / FDV / L-S / regime points, so a
    // 1/6-alignment counter-trend short scored VERY HIGH (MYX 5.43 with 5 of 6
    // TFs trending the OTHER way). But multi-TF ALIGNMENT — not a pile of
    // counter-points — is what predicts follow-through. So:
    //   • counter-trend (daily against) + weak alignment (≤0.30 weighted) → cap
    //     at LOW / observation-only: never confidently fade a trend on one slow
    //     TF. This kills the losing counter-trend shorts (MYX → observation).
    //   • else grade the CEILING by alignment: VERY HIGH now REQUIRES real
    //     multi-TF confluence (≥0.50 weighted); <0.30 → max MEDIUM.
    // EXEMPT exhaustion-reversal shorts: they are an INTENTIONAL counter-trend
    // fade of an extreme blow-off top (watchlist-only, opt-in, HIGH-RISK tagged),
    // so the counter-trend cap would defeat the whole feature. This exemption is
    // the ONLY thing gated on exhReversal here — every other trade keeps the cap.
    const wa = tradePlan.weightedAlignment ?? 0;
    if (!exhReversal && !alignmentExempt) {
      if (tradePlan.dailyAgainst && wa <= 0.30) {
        idx = Math.min(idx, 1);                 // → LOW (observation, won't fire)
      } else if (wa < 0.30) {
        idx = Math.min(idx, 2);                 // → max MEDIUM
      } else if (wa < 0.50) {
        idx = Math.min(idx, 3);                 // → max HIGH (VERY HIGH needs ≥0.50 alignment)
      }
    }

    // Acute counter-BTC-regime → HARD cap to observation (accuracy audit B/§2).
    // The −1 score nudge in #evaluate wasn't enough: a clean alt long still
    // cleared the MEDIUM floor into a BTC downtrend, and most alt longs get
    // invalidated when BTC leads down. When BTC is ACUTELY against the trade
    // (fast TFs dumping for a LONG / ripping for a SHORT), cap at LOW
    // (observation-only) regardless of local confluence.
    if (this.regimeMonitor && this.regimePenalty > 0 && this.regimeMonitor.isEnabled?.() !== false) {
      const sym = context.token?.symbol?.toUpperCase();
      if (sym && sym !== (this.regimeMonitor.symbol ?? 'BTC')) {
        const r = this.regimeMonitor.get();
        const fights = (context.side === 'LONG'  && r?.regime === 'BTC_DOWN')
                    || (context.side === 'SHORT' && r?.regime === 'BTC_UP');
        if (fights && r?.acute) idx = Math.min(idx, 1);   // cap at LOW → observation-only
      }
    }

    // RSI EXHAUSTION — buying a parabolic top / selling a capitulation. Multi-TF
    // extreme RSI against the entry is the most damaging losing pattern (STG
    // LONG −10.86% at RSI 86/91/80; HOME; LAB). ≥3 extreme TFs, or ≥2 with one
    // deeply extreme (≥88), is a −2-tier demotion (→ observation); ≥2 is −1.
    const exTfs = tradePlan.exhaustionTfs ?? 0;
    const exMax = tradePlan.exhaustionMax ?? 0;
    if (exTfs >= 3 || (exTfs >= 2 && exMax >= 88)) idx -= 2;
    else if (exTfs >= 2) idx -= 1;
    // SINGLE-TF BLOW-OFF — a lone TF at a screaming extreme (≥88) is itself a
    // top/bottom, even with the others quiet (VELVET LONG fired into daily RSI
    // 98.9 while 5m/1m were oversold on the dip — the ≥2-TF gate above missed it).
    else if (exTfs >= 1 && exMax >= 88) idx -= 1;

    // Surge-CHASE — a surge entry in the surge direction into an already-extreme
    // entry TF (LONG into 5m overbought / SHORT into 5m oversold) is buying the
    // exhaustion of the very move that triggered it (WAL: +3.5% surge into 5m
    // RSI 85 → −$48).
    if (trigger.type === 'surge' && tradePlan.entryTfExhausted) idx -= 1;

    // STRUCTURAL LOCATION — the headline fix. A trend-following MARKET entry
    // jammed against opposing structure (LONG into resistance / SHORT into
    // support) is the worst live pattern (FHE LONG into the double-top; TAG SHORT
    // into the 0.00100 support). The confluence said "go" but there's no ROOM —
    // TP1 sits past the wall, so price taps it, rejects, and stops out (losers
    // peak +2.8% then bleed −6.9%). Demote: a clustered SHELF (double-top/bottom)
    // → observation-only; a single near level → −1 tier. EXEMPT: liquidity-grab +
    // exhaustion-reversal entries (they target structure on purpose) and breakouts
    // (structRoom is null when nothing sits ahead).
    const sr = tradePlan.structRoom;
    if (STRUCT_GUARD && sr && !tradePlan.isLiquidityGrab && !exhReversal) {
      const tp1Pct = tradePlan.tp1Pct ?? Infinity;            // TP1 distance in %
      if (sr.shelf && sr.roomPct <= STRUCT_ROOM_PCT) {
        // A clustered double-top/bottom this close → poor location regardless of
        // where TP1 snapped (price rejects AT the wall). Observation-only.
        idx = Math.min(idx, 1);
        if (this.verbose) console.log(`[struct-guard] ${context.side} ${context.token?.symbol} — SHELF ${sr.roomPct}% ahead → observation`);
      } else if (sr.roomPct <= STRUCT_ROOM_SINGLE_PCT && sr.roomPct < tp1Pct) {
        // Single near level that also blocks TP1 (can't reach the first target
        // before the wall) → milder −1 tier.
        idx -= 1;
        if (this.verbose) console.log(`[struct-guard] ${context.side} ${context.token?.symbol} — level ${sr.roomPct}% ahead (TP1 ${tp1Pct.toFixed?.(1)}%) → −1 tier`);
      }
    }

    // Unknown daily trend → can't confirm the macro; soft half-tier penalty so a
    // missing-daily plan can't sail through at full confidence (audit §5:1409).
    if (tradePlan.dailyTrendKnown === false) idx -= 0.5;

    // No directional EDGE: the opposing side scored within 0.3 of the winner (a coin
    // flip — the token has ~equal bull and bear confluence). Demote a tier so a
    // marginal MEDIUM coin-flip drops to LOW and won't fire. This was computed in
    // evaluateForAnalysis but never gated, and it's a big reason the scan buckets
    // (watchlist 48%, movers 45%) sit at a coin flip.
    if (lowConviction) idx -= 1;

    const isSentimentOnly = trigger.type === 'funding_extreme' &&
      (context.recentFlows?.length ?? 0) === 0 &&
      (context.recentLiquidations?.length ?? 0) === 0;
    if (isSentimentOnly && idx >= 3) idx = 3;     // cap sentiment-only at HIGH, never VERY HIGH

    const idxFinal = Math.max(0, Math.min(tiers.length - 1, Math.floor(idx)));
    const finalLabel = tiers[idxFinal];

    return {
      label: finalLabel,
      emoji: Conductor.TIER_EMOJI[finalLabel],
      total: strength.total,
      confidence: this.#tierConfidence(finalLabel, strength.total)
    };
  }

  // ── History & lookup helpers ──────────────────────────────────────────────

  #usdValue(token, amount) {
    const price = this.prices.getPrice(token.coingeckoId);
    return price ? amount * price : null;
  }

  #recordFlow(flow, usd) {
    const arr = this.flowsByToken.get(flow.token.symbol) ?? [];
    arr.push({ flow, usd, ts: Date.now() });
    this.flowsByToken.set(flow.token.symbol, arr);
  }

  #recordSurge(surge) {
    const arr = this.surgesByCgId.get(surge.token.coingeckoId) ?? [];
    arr.push({ surge, ts: Date.now() });
    this.surgesByCgId.set(surge.token.coingeckoId, arr);
  }

  #recordLiquidation(ev) {
    const arr = this.liquidationsByToken.get(ev.symbol) ?? [];
    arr.push({ event: ev, ts: Date.now() });
    this.liquidationsByToken.set(ev.symbol, arr);

    // 24h cluster store — keyed by price at the time of the liquidation (we
    // approximate via current price since Coinalyze events arrive ~minutes
    // after they happen and we don't keep per-minute price history). This is
    // good enough because clusters are aggregated into 0.5% price buckets
    // and a few-minute lag rarely shifts price across a bucket boundary.
    const cgId = this.#findCgIdForSymbol(ev.symbol);
    const price = cgId ? this.prices.getPrice(cgId) : null;
    if (price && price > 0) {
      const cl = this.liqClustersByToken.get(ev.symbol) ?? [];
      cl.push({
        ts: ev.timestamp ?? Date.now(),
        price,
        longUsd: Number(ev.longLiq ?? 0),
        shortUsd: Number(ev.shortLiq ?? 0)
      });
      this.liqClustersByToken.set(ev.symbol, cl);
    }
  }

  // Aggregate the last 24h of liquidation events for `symbol` into 0.5%
  // price buckets and return clusters within ±10% of `currentPrice` that
  // have ≥ $minClusterUsd cumulative wipe on one side.
  //
  // Returned shape: [{ midPrice, longUsd, shortUsd, dominantSide,
  //                    distancePct (signed, + = above current) }]
  //
  // Why these matter: liquidation clusters mark prices where large leverage
  // was forcibly closed. Markets show a documented tendency to revisit
  // these zones (efficiency / inventory-reset effect), so:
  //   • Cluster of SHORT-side wipes ABOVE current price → magnet for upward
  //     moves (LONG signals get squeeze fuel)
  //   • Cluster of LONG-side wipes BELOW current price → magnet for
  //     downward moves (SHORT signals get cascade fuel)
  #getLiquidationClusters(symbol, currentPrice, minClusterUsd = 2_000_000) {
    if (!currentPrice || currentPrice <= 0) return [];
    const events = this.liqClustersByToken.get(symbol) ?? [];
    if (events.length === 0) return [];

    const cutoff = Date.now() - 24 * 60 * 60_000;
    // Bucket by ABSOLUTE price in log space (audit §3.1). Previously buckets
    // were keyed by % distance from the CURRENT price, so every cluster
    // re-bucketed on every tick as price moved — a wipe zone could drift in and
    // out of a bucket boundary, making the magnet flicker. log(price)/log(1.005)
    // gives a fixed 0.5%-wide band anchored to absolute price: a wipe at $1.23
    // always lands in the same bucket no matter when we read it. distancePct is
    // derived from currentPrice only at read time.
    const BUCKET_RATIO = 0.005;                 // 0.5% wide buckets
    const logBase = Math.log(1 + BUCKET_RATIO);
    const buckets = new Map();                  // absolutePriceBucketIdx → { longUsd, shortUsd }

    for (const ev of events) {
      if (ev.ts < cutoff) continue;
      if (!(ev.price > 0)) continue;
      const idx = Math.round(Math.log(ev.price) / logBase);
      const b = buckets.get(idx) ?? { longUsd: 0, shortUsd: 0 };
      b.longUsd  += ev.longUsd  || 0;
      b.shortUsd += ev.shortUsd || 0;
      buckets.set(idx, b);
    }

    const clusters = [];
    for (const [idx, b] of buckets.entries()) {
      const total = b.longUsd + b.shortUsd;
      if (total < minClusterUsd) continue;
      const midPrice = Math.exp(idx * logBase);                       // bucket centre (absolute price)
      const distancePct = ((midPrice - currentPrice) / currentPrice) * 100;
      if (Math.abs(distancePct) > 10) continue;                       // ignore far-away wipes (read-time filter)
      const dominantSide = b.longUsd >= b.shortUsd ? 'longs' : 'shorts';
      clusters.push({ midPrice, distancePct, longUsd: b.longUsd, shortUsd: b.shortUsd, dominantSide });
    }
    // Sort by distance from current price (closest first)
    clusters.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    return clusters;
  }

  // Invalidate the lazily-built symbol→cgId cache. Called after a token is
  // added at runtime (/watchlist add) so funding/liquidation triggers can
  // resolve the new symbol without a restart.
  invalidateSymbolCache() {
    this._symbolToCgId = null;
  }

  #findCgIdForSymbol(symbol) {
    if (!this._symbolToCgId) {
      this._symbolToCgId = new Map();
      for (const cgId of this.universe.allCgIds()) {
        const info = this.universe.lookupByCgId(cgId);
        if (info?.symbol) this._symbolToCgId.set(info.symbol.toUpperCase(), cgId);
      }
    }
    return this._symbolToCgId.get(symbol.toUpperCase()) ?? null;
  }

  #guessChain(tokenInfo) {
    // Picks the first chain with an address — purely for explorer link routing.
    if (tokenInfo.chains?.ethereum) return 'ethereum';
    if (tokenInfo.chains?.bsc) return 'bsc';
    if (tokenInfo.chains?.solana) return 'solana';
    return null;
  }

  #cleanup() {
    const now = Date.now();
    const prune = (map, ttl) => {
      for (const [k, arr] of map.entries()) {
        const filtered = arr.filter(e => now - e.ts <= ttl);
        if (filtered.length === 0) map.delete(k);
        else map.set(k, filtered);
      }
    };
    prune(this.flowsByToken, this.flowHistoryMs);
    prune(this.surgesByCgId, this.surgeHistoryMs);
    prune(this.liquidationsByToken, this.liqHistoryMs);
    prune(this.distributionByCgId, this.distWindowMs);
    // 24h retention for cluster magnets — independent of liqHistoryMs which
    // is for short-window "prior aligned liquidation" bonuses.
    prune(this.liqClustersByToken, 24 * 60 * 60_000);

    // Prune lastFiredAt — anything older than the longest cooldown window
    // (opposite-side = 3× cooldownMs). lastFiredAt values are now { ts, side }.
    const cooldownGc = this.cooldownMs * 3;
    for (const [k, entry] of this.lastFiredAt.entries()) {
      if (now - entry.ts > cooldownGc) this.lastFiredAt.delete(k);
    }
    // Prune recentLosses past the extended cooldown window.
    for (const [k, entry] of this.recentLosses.entries()) {
      if (now - entry.ts > this.postLossExtendedCooldownMs) this.recentLosses.delete(k);
    }
  }
}
