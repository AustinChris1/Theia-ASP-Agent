import { EventEmitter } from 'node:events';
import { fundingScoreForSide, oiScoreForSide, describeFunding, describeOI } from './funding.js';
import { isStableSymbol } from './stables.js';
import { confirmSignal } from './ta-confirm.js';
import { cvdVeto } from './cvd.js';
import { TF_ALIGNMENT_WEIGHTS, TF_ORDER } from './timeframes.js';
import { regimeScoreForSide } from './regime.js';
import { assessDistribution } from './distribution.js';
import { cgSearch } from './coingecko.js';

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

const MOMENTUM_EDGE_KINDS = new Set([
  'flow', 'funding_trigger', 'distribution', 'teamFlow',
  'priorFlows', 'liquidation', 'fundingVelocity', 'supplyPct',
]);

export function momentumLacksEdge(triggerType, reasons, requireEdge = true) {
  if (!requireEdge) return false;
  if (triggerType !== 'surge' && triggerType !== 'movers') return false;
  return !(reasons ?? []).some(r => MOMENTUM_EDGE_KINDS.has(r?.kind));
}

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

export function enforceTpLadder(side, entry, snap, raw) {
  const beyond = (a, b) => (side === 'LONG' ? b > a : b < a);
  const has = (x) => x != null && isFinite(x);
  let tp1 = has(snap.tp1) ? snap.tp1 : raw.tp1, s1 = has(snap.tp1);
  let tp2 = has(snap.tp2) ? snap.tp2 : raw.tp2, s2 = has(snap.tp2);
  let tp3 = has(snap.tp3) ? snap.tp3 : raw.tp3, s3 = has(snap.tp3);
  if (!beyond(entry, tp1)) { tp1 = raw.tp1; s1 = false; }

  if (!beyond(tp1, tp2)) {
    if (s1 && !s2) { tp1 = raw.tp1; s1 = false; }
    else if (s2 && !s1) { tp2 = raw.tp2; s2 = false; }
    else { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }
  }
  if (!beyond(tp1, tp2)) { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }

  if (!beyond(tp2, tp3)) {
    if (s3 && !s2) { tp3 = raw.tp3; s3 = false; }
    else if (s2 && !s3) { tp2 = raw.tp2; s2 = false; }
    else { tp2 = raw.tp2; tp3 = raw.tp3; s2 = s3 = false; }
  }
  if (!beyond(tp2, tp3)) { tp2 = raw.tp2; tp3 = raw.tp3; s2 = s3 = false; }
  if (!beyond(tp1, tp2)) { tp1 = raw.tp1; tp2 = raw.tp2; s1 = s2 = false; }

  const nudge = side === 'LONG' ? 1.004 : 0.996;
  if (!beyond(entry, tp1)) { tp1 = entry * nudge; s1 = false; }
  if (!beyond(tp1, tp2))   { tp2 = tp1 * nudge;   s2 = false; }
  if (!beyond(tp2, tp3))   { tp3 = tp2 * nudge;   s3 = false; }
  return { tp1, tp2, tp3, snapped: { tp1: s1, tp2: s2, tp3: s3 } };
}

const numEnv = (k, d) => { const v = Number(process.env[k]); return isFinite(v) ? v : d; };

export function liquidationOiBonus(oiFrac) {
  const f = Number(oiFrac);
  if (!isFinite(f) || f <= 0) return 0;
  return Math.min(1.0, f / 0.01);
}

export function liquidationBaseScore(oiFrac, { fullOi = 0.003, base = 2.0, floor = 0.5 } = {}) {
  const f = Number(oiFrac);
  if (!isFinite(f)) return base;
  if (f <= 0) return floor;
  return floor + (base - floor) * Math.min(1, f / fullOi);
}

export function liquidationCascadeBase(cumulativeUsd, fullUsd = 2_000_000) {
  const u = Number(cumulativeUsd);
  if (!isFinite(u) || u <= 0) return 0;
  return 2.0 * Math.min(1, u / fullUsd);
}

export function liquidationSignalBase({ liquidMarket, cascadeUsd = 0, oiFrac = NaN, cascadeFullUsd = 2_000_000, baseFloor = 2.0, illiquidCap = 0.4, baseFullOi = 0.003 } = {}) {
  const oiBonus = liquidationOiBonus(oiFrac);
  if (liquidMarket) {
    return Math.max(baseFloor, liquidationCascadeBase(cascadeUsd, cascadeFullUsd)) + oiBonus;
  }
  return Math.min(illiquidCap, liquidationBaseScore(oiFrac, { fullOi: baseFullOi }));
}

export function isMomentumLive(trigger, side) {
  if (!trigger) return false;
  if (trigger.type === 'liquidation') return true;
  if (trigger.type === 'surge') {
    const dir = trigger.value?.direction;
    return (side === 'SHORT' && dir === 'down') || (side === 'LONG' && dir === 'up');
  }
  return false;
}

export function teamSellMaterialFloorUsd(mcap, { minMcapPct = 0.0003, absFloor = 50_000 } = {}) {
  const m = Number(mcap);
  if (!isFinite(m) || m <= 0) return absFloor;
  return Math.max(absFloor, m * minMcapPct);
}

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
  surgeBase:          numEnv('SURGE_BASE', 1),
  flowBaseBoost:      numEnv('FLOW_BASE_BOOST', 0),
  teamSellPts:        numEnv('TEAM_SELL_PTS', 0.8),
  fundingExtremeBase: numEnv('FUNDING_EXTREME_BASE', 0),
  distributionBase:   numEnv('DISTRIBUTION_BASE', 2.5),
  taSoftCap:          numEnv('TA_SOFT_CAP', 1.5),
  taHardCap:          numEnv('TA_HARD_CAP', 2.5),
  coldDepositBoost:   numEnv('COLD_DEPOSIT_BOOST', 0.6),
};

const STRUCT_GUARD          = process.env.STRUCT_GUARD !== '0';
const STRUCT_ROOM_PCT       = numEnv('STRUCT_ROOM_PCT', 4.0);
const STRUCT_ROOM_SINGLE_PCT= numEnv('STRUCT_ROOM_SINGLE_PCT', 2.0);
const STRUCT_SHELF_PCT      = numEnv('STRUCT_SHELF_PCT', 2.0);
const STRUCT_TFS            = ['5min', '1hour', '4hour', 'daily'];

const CASCADE_TP_EXTEND    = process.env.CASCADE_TP_EXTEND !== '0';
const CASCADE_TP_MAX_PCT   = numEnv('CASCADE_TP_MAX_PCT', 25);

const SL_MAX_PCT = {
  SCALP:    numEnv('SL_MAX_PCT_SCALP', 4),
  DAY:      numEnv('SL_MAX_PCT_DAY', 5),
  SWING:    numEnv('SL_MAX_PCT_SWING', 7),
  POSITION: numEnv('SL_MAX_PCT_POSITION', 9),
};

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

  const aheadFilter = side === 'LONG' ? (p => p > entry) : (p => p < entry);
  const ahead = [...new Set(levels)].filter(aheadFilter);
  if (!ahead.length) return null;
  const nearest = side === 'LONG' ? Math.min(...ahead) : Math.max(...ahead);
  const roomPct = Math.abs((nearest - entry) / entry) * 100;

  const cluster = ahead.filter(p => Math.abs((p - nearest) / nearest) * 100 <= shelfPct);
  return { roomPct: Number(roomPct.toFixed(2)), shelf: cluster.length >= 2, level: nearest };
}

const MANIP_GUARD        = process.env.MANIP_GUARD !== '0';
const MANIP_TA_DEWEIGHT  = numEnv('MANIP_TA_DEWEIGHT', 0.6);
const MANIP_LONG_PENALTY = numEnv('MANIP_LONG_PENALTY', 1.2);
const MANIP_SHORT_BOOST  = numEnv('MANIP_SHORT_BOOST', 0.6);

export function assessManipulation({ futuresVol, spotVol, volume, marketCap, floatPct, concentrationPct } = {}) {
  const flags = [];
  let score = 0;
  if (futuresVol > 0 && spotVol > 0) {
    const r = futuresVol / spotVol;
    if (r >= 2)        { score += 0.35; flags.push(`futures ${r.toFixed(1)}× spot vol`); }
    else if (r >= 1.3) { score += 0.15; flags.push(`futures ${r.toFixed(1)}× spot vol`); }
  }
  if (volume > 0 && marketCap > 0) {
    const vmc = volume / marketCap;
    if (vmc >= 1)        { score += 0.30; flags.push(`24h vol ${vmc.toFixed(1)}× market cap`); }
    else if (vmc >= 0.5) { score += 0.15; flags.push(`24h vol ${Math.round(vmc * 100)}% of MC`); }
  }
  if (floatPct != null && floatPct > 0) {
    if (floatPct < 0.25)     { score += 0.25; flags.push(`float ${Math.round(floatPct * 100)}% (<25%)`); }
    else if (floatPct < 0.40) { score += 0.10; flags.push(`float ${Math.round(floatPct * 100)}%`); }
  }
  if (concentrationPct != null) {
    if (concentrationPct >= 70)      { score += 0.25; flags.push(`top-10 hold ${Math.round(concentrationPct)}%`); }
    else if (concentrationPct >= 50) { score += 0.10; flags.push(`top-10 hold ${Math.round(concentrationPct)}%`); }
  }
  return { score: Math.min(1, Number(score.toFixed(2))), flags };
}

export function assessPumpRegime({ manipFlags = [], supplyShock = false, squeeze = false } = {}, minLegs = 3) {
  const legs = [...manipFlags];
  if (supplyShock) legs.push('supply → CEX');
  if (squeeze) legs.push('liquidation squeeze');
  const count = legs.length;
  return { count, legs, isRegime: count >= minLegs };
}

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

export function pumpRegimeBias({ fundingAvg = null, distributing = false, squeezeFuelAbove = false, ride = true } = {}) {
  if (distributing) return 'SHORT';
  if (typeof fundingAvg === 'number' && fundingAvg > 0) return 'SHORT';
  if (ride && typeof fundingAvg === 'number' && fundingAvg < 0 && squeezeFuelAbove) return 'LONG';
  return 'SHORT';
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '');

function fmtTokenAmount(n) {
  const x = Number(n);
  if (!isFinite(x)) return '?';
  if (x >= 1000) return Math.round(x).toLocaleString('en-US');
  if (x >= 1)    return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return x.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function isExhaustionReversalShort(side, favored, taMetadata) {
  if (side !== 'SHORT' || !favored || !taMetadata) return false;
  const rsiDaily = taMetadata['daily']?.rsi;
  const rsiWeek  = taMetadata['1week']?.rsi;
  const stretched = (typeof rsiDaily === 'number' && rsiDaily >= 80)
                 || (typeof rsiWeek  === 'number' && rsiWeek  >= 80);
  if (!stretched) return false;

  return taMetadata['5min']?.trend === 'down';
}

export function isExhaustionReversalLong(side, favored, taMetadata) {
  if (side !== 'LONG' || !favored || !taMetadata) return false;
  const rsiDaily = taMetadata['daily']?.rsi;
  const rsiWeek  = taMetadata['1week']?.rsi;
  const capitulated = (typeof rsiDaily === 'number' && rsiDaily <= 20)
                   || (typeof rsiWeek  === 'number' && rsiWeek  <= 20);
  if (!capitulated) return false;

  return taMetadata['5min']?.trend === 'up';
}

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
    liquidationHeatmap = null,
    teamDiscovery = null,
    minSignalScore = 3.0,
    minSignalScorePinned = null,

    minObservationScore = 2.0,

    minFlowUsd = 1_000_000,
    cooldownMs = 30 * 60_000,
    flowHistoryMs = HOUR,
    surgeHistoryMs = HALF_HOUR,
    liqHistoryMs = HOUR,

    levRiskBasis = 2,

    confirmDropThreshold = -2.5,

    regimeMonitor = null,
    regimePenalty = 1.0,

    enableExhaustionReversal = true,

    enableExhaustionReversalLong = true,

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
    this.liquidityClusters = liquidityClusters;
    this.liquidationHeatmap = liquidationHeatmap;
    this.teamDiscovery = teamDiscovery;
    this.signalTracker = null;
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

    this.flowsByToken = new Map();
    this.surgesByCgId = new Map();
    this.liquidationsByToken = new Map();
    this.liqClustersByToken = new Map();

    this.distributionByCgId = new Map();
    this.lastDistAlertAt = new Map();

    this.flowMaxFdvUsd = numEnv('FLOW_MAX_FDV_USD', 500_000_000);

    this.teamFlowMinMcapPct = numEnv('TEAM_FLOW_MIN_MCAP_PCT', 0.0003);

    this.liqBaseFullOi = numEnv('LIQ_BASE_FULL_OI', 0.003);

    this.liqCascadeWindowMs = numEnv('LIQ_CASCADE_WINDOW_MIN', 5) * 60_000;
    this.liqCascadeFullUsd = numEnv('LIQ_CASCADE_FULL_USD', 2_000_000);

    this.pumpRegimeMinLegs = numEnv('PUMP_REGIME_MIN_LEGS', 3);
    this.pumpRegimeMaxBonus = numEnv('PUMP_REGIME_MAX_BONUS', 1.0);

    this.enablePrePump  = process.env.ENABLE_PREPUMP === '1';
    this.prePumpMinLegs = numEnv('PREPUMP_MIN_LEGS', 2);
    this.prePumpMaxPts  = numEnv('PREPUMP_MAX_PTS', 1.0);

    this.liqMagnetMinUsd = numEnv('LIQ_MAGNET_MIN_USD', 1_000_000);
    this.liqMagnetMaxPts = numEnv('LIQ_MAGNET_MAX_PTS', 0.9);

    this.liqSweepDetect  = process.env.LIQ_SWEEP_DETECT !== '0';
    this.liqSweepMaxPts  = numEnv('LIQ_SWEEP_MAX_PTS', 0.8);
    this.liqSweepMinUsd  = numEnv('LIQ_SWEEP_MIN_USD', 1_000_000);
    this.liqSweepMaxAgeMs = numEnv('LIQ_SWEEP_MAX_AGE_MIN', 30) * 60_000;

    this.liqSignalMinOiUsd = numEnv('LIQ_SIGNAL_MIN_OI_USD', 30_000_000);
    this.liqSignalMinMcUsd = numEnv('LIQ_SIGNAL_MIN_MC_USD', 1_000_000_000);
    this.liqMajorBaseFloor = numEnv('LIQ_MAJOR_BASE_FLOOR', 2.0);
    this.liqIlliquidCap    = numEnv('LIQ_ILLIQUID_CAP', 0.4);

    this.listingPerpRetries = numEnv('LISTING_PERP_RETRIES', 6);
    this.listingPerpRetryMs = numEnv('LISTING_PERP_RETRY_SEC', 15) * 1000;
    this.distWindowMs    = Number(process.env.DIST_WINDOW_MIN ?? 120) * 60_000;
    this.distMinUsd      = Number(process.env.DIST_MIN_USD ?? 500_000);
    this.distMinVolPct   = Number(process.env.DIST_MIN_VOL_PCT ?? 4);
    this.distMinTransfers = Number(process.env.DIST_MIN_TRANSFERS ?? 5);
    this.distCooldownMs  = Number(process.env.DIST_COOLDOWN_MIN ?? 120) * 60_000;

    this.distConflictWindowMs = Number(process.env.DIST_CONFLICT_MIN ?? 90) * 60_000;
    this.distConflictPts = Number(process.env.DIST_CONFLICT_PTS ?? 1.5);

    this.lastFiredAt = new Map();

    this.recentLosses = new Map();
    this.postLossMinCooldownMs = 30 * 60_000;
    this.postLossExtendedCooldownMs = 4 * 60 * 60_000;
    this.postLossPriceDistPct = 3;

    this._symbolToCgId = null;
  }

  start() {
    for (const src of this.onchainSources) {
      src.on('flow', (flow) => { try { this.#onFlow(flow); } catch (err) { console.error('[conductor] onFlow err:', err.message); } });
    }
    this.prices.on('surge', (surge) => {

      Promise.resolve(this.#onSurge(surge)).catch(err => console.error('[conductor] onSurge err:', err.message));
    });
    if (this.liquidations) {
      this.liquidations.on('liquidation', (ev) => { try { this.#onLiquidation(ev); } catch (err) { console.error('[conductor] onLiquidation err:', err.message); } });
    }
    setInterval(() => this.#cleanup(), 60_000).unref();
  }

  #onFlow(flow) {

    if (isStableSymbol(flow.token.symbol)) return;

    if (flow.distribution) { this.#onDistributionFlow(flow); return; }

    const usd = this.#usdValue(flow.token, flow.amount);
    this.#recordFlow(flow, usd);

    if (!flow.direction) return;

    const tokenInfo = this.universe.lookupByCgId(flow.token.coingeckoId);
    const MIN_TEAM_FLOW_USD = teamSellMaterialFloorUsd(tokenInfo?.marketCap, { minMcapPct: this.teamFlowMinMcapPct });
    if (flow.teamFlow && usd !== null && usd < MIN_TEAM_FLOW_USD) {
      if (this.verbose) console.log(`[conductor] team flow ${flow.token.symbol} $${usd.toFixed(0)} < material $${MIN_TEAM_FLOW_USD.toFixed(0)} (mcap-relative) — demoting to ordinary flow`);
      flow = { ...flow, teamFlow: null };
    }

    const isTeamSell = flow.teamFlow?.side === 'sell';

    if (isTeamSell) this.#emitInsiderSell(flow, usd);

    if (!isTeamSell) {

      const universeInfo = this.universe.lookupByCgId(flow.token.coingeckoId);
      const fdv = universeInfo?.fdv;
      if (typeof fdv === 'number' && fdv >= this.flowMaxFdvUsd) {
        if (this.verbose) console.log(`[conductor] skip flow ${flow.token.symbol} — FDV $${(fdv/1e6).toFixed(0)}M ≥ $${(this.flowMaxFdvUsd/1e6).toFixed(0)}M`);
        return;
      }

      const favored = this.universe.isFavored?.(flow.token.coingeckoId);
      const effectiveMinFlow = favored ? this.minFlowUsd * 0.25 : this.minFlowUsd;

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

  #onDistributionFlow(flow) {
    const cgId = flow.token?.coingeckoId;
    if (!cgId) return;
    const usd = this.#usdValue(flow.token, flow.amount);
    if (usd == null || !(usd > 0)) return;

    const distInfo = this.universe?.lookupByCgId?.(cgId);
    if (typeof distInfo?.fdv === 'number' && distInfo.fdv >= this.flowMaxFdvUsd) {
      if (this.verbose) console.log(`[distribution] skip ${flow.token?.symbol} — FDV $${(distInfo.fdv / 1e6).toFixed(0)}M ≥ $${(this.flowMaxFdvUsd / 1e6).toFixed(0)}M ceiling`);
      return;
    }
    const now = Date.now();
    const arr = this.distributionByCgId.get(cgId) ?? [];
    arr.push({ usd, ts: now, dest: flow.toName ?? flow.toType ?? 'external', exchange: flow.exchange });
    while (arr.length && now - arr[0].ts > this.distWindowMs) arr.shift();
    this.distributionByCgId.set(cgId, arr);

    const vol24h = this.prices?.get24hVolume?.(cgId) ?? null;
    const a = assessDistribution(arr, {
      now, windowMs: this.distWindowMs, vol24h,
      minUsd: this.distMinUsd, minVolPct: this.distMinVolPct, minTransfers: this.distMinTransfers
    });
    if (!a) return;

    const last = this.lastDistAlertAt.get(cgId);
    if (last && now - last < this.distCooldownMs) return;
    this.lastDistAlertAt.set(cgId, now);

    const destCounts = new Map();
    for (const e of arr) destCounts.set(e.dest, (destCounts.get(e.dest) ?? 0) + 1);
    const topDestinations = [...destCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([d, c]) => `${d}×${c}`);

    console.log(`[distribution] ${flow.token.symbol} — $${Math.round(a.cumulativeUsd).toLocaleString()} out in ${a.count} transfers${a.volPct != null ? ` (${a.volPct.toFixed(1)}% of 24h vol)` : ''} → ${topDestinations.join(', ')}`);

    this.evaluateDistributionTrigger(flow.token, {
      exchange: flow.exchange,
      cumulativeUsd: a.cumulativeUsd,
      count: a.count,
      volPct: a.volPct,
      windowMins: Math.round(this.distWindowMs / 60_000),
      topDestinations
    }).catch(err => console.warn(`[distribution] eval ${flow.token.symbol} failed: ${err.message}`));
  }

  #emitInsiderSell(flow, usd) {
    const tx = flow.txHash;
    if (tx) {
      if (!this._seenInsiderTx) this._seenInsiderTx = new Set();
      if (this._seenInsiderTx.has(tx)) return;
      this._seenInsiderTx.add(tx);
      if (this._seenInsiderTx.size > 4000) this._seenInsiderTx.clear();
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
    if (isStableSymbol(surge.token?.symbol)) return;
    this.#recordSurge(surge);
    const side = surge.direction === 'up' ? 'LONG' : 'SHORT';
    const tokenInfo = this.universe.lookupByCgId(surge.token.coingeckoId);
    const enrichedToken = tokenInfo ? {
      ...surge.token,
      chain: this.#guessChain(tokenInfo)
    } : surge.token;

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

    if (!cgId) { if (this.verbose) console.log(`[conductor] liquidation ${ev.symbol} ($${Math.round((ev.usd ?? 0)/1000)}K) — no cgId in universe, dropped (no signal)`); return; }
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) { if (this.verbose) console.log(`[conductor] liquidation ${ev.symbol} — cgId ${cgId} not in universe lookup, dropped`); return; }
    const token = {
      symbol: ev.symbol,
      coingeckoId: cgId,
      chain: this.#guessChain(tokenInfo)
    };
    const side = ev.bias.toUpperCase();

    this.#evaluateAndMaybeEmit({
      token,
      side,
      trigger: { type: 'liquidation', value: ev }
    }).catch(err => console.warn(`[conductor] liquidation eval ${ev.symbol} failed: ${err.message}`));
  }

  setSignalTracker(tracker) {
    this.signalTracker = tracker;
  }

  recordLoss(sig) {
    if (!sig?.symbol || !sig?.side) return;
    const isLoss = sig.outcome === 'LOSS' || sig.outcome === 'EXPIRED_LOSS';
    if (!isLoss) return;
    this.recentLosses.set(sig.symbol, {
      side: sig.side,
      ts: Date.now(),
      entry: sig.entry ?? null
    });
  }

  async evaluateForAnalysis({ symbol, holdings = null, allowFetch = false }) {
    if (isStableSymbol(symbol)) return null;
    let cgId = this.#findCgIdForSymbol(symbol);

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

    let longTa = null, shortTa = null;
    if (this.taService) {
      [longTa, shortTa] = await Promise.all([
        this.taService.analyze(token.symbol, 'LONG'),
        this.taService.analyze(token.symbol, 'SHORT')
      ]);
    }

    const heatmap = await this.#fetchHeatmap(token.symbol);

    const trigger = { type: 'manual', value: { reason: 'on-demand analysis' } };
    const buildSide = (sideLabel, taResult) => {
      const ctx = this.#gatherContext({ token, side: sideLabel, trigger });

      ctx.taFindings = [ ...(taResult?.findings ?? []), ...this.#heatmapFindings(heatmap, sideLabel) ];

      const trendDir = taResult?.metadata?.['1hour']?.trend ?? taResult?.metadata?.['4hour']?.trend;
      if (trendDir === 'up' || trendDir === 'down') ctx.priceDir = trendDir;
      const ev = this.#evaluate(ctx);

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

    const winnerIsLong = longRes.evaluation.score >= shortRes.evaluation.score;
    const winner = winnerIsLong ? longRes : shortRes;
    const side = winnerIsLong ? 'LONG' : 'SHORT';

    const lowConviction = Math.abs(longRes.evaluation.score - shortRes.evaluation.score) < 0.3;

    const taMetadata = winner.ta?.metadata ?? null;
    const hmLiq = this.liquidationHeatmap?.peek?.(token.symbol);
    const liqMagnets = hmLiq ? ((side === 'SHORT' ? hmLiq.shortLiqs : hmLiq.longLiqs) ?? []) : [];
    const liqTargets = hmLiq ? ((side === 'SHORT' ? hmLiq.longLiqs : hmLiq.shortLiqs) ?? []) : [];
    const tradePlan = this.#buildTradePlan(winner.context.currentPrice, side, taMetadata, this.#tpWallsWithSweep(heatmap, side, token.symbol, winner.context.currentPrice), null, liqMagnets, liqTargets);

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

      sideScores: {
        long:  Number(longRes.evaluation.score.toFixed(2)),
        short: Number(shortRes.evaluation.score.toFixed(2))
      }
    };
  }

  #momentumLacksEdge(triggerType, reasons) {

    return momentumLacksEdge(triggerType, reasons, process.env.MOMENTUM_REQUIRE_EDGE === '1');
  }

  async #cvdVetoes(sym, side, triggerType) {
    if (process.env.CVD_VETO !== '1') return false;
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
    return false;
  }

  #confirmGateDrops(sym, side, reasons, label = '') {
    if (!this.taService?.getOhlcvByTf) return false;
    const ohlcvByTf = this.taService.getOhlcvByTf(sym);
    if (!ohlcvByTf || Object.keys(ohlcvByTf).length === 0) return false;
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
    if (isStableSymbol(symbol)) return null;
    const analysis = await this.evaluateForAnalysis({ symbol });
    if (!analysis) return null;

    const sym = analysis.token.symbol;
    const last = this.lastFiredAt.get(sym);
    if (last) {
      const elapsed = Date.now() - last.ts;
      const required = last.side === analysis.side ? this.cooldownMs : this.cooldownMs * 3;
      if (elapsed < required) return analysis;
    }

    const isFavored = this.universe.isFavored?.(analysis.token.coingeckoId) ?? false;

    const useMajorsBar = source === 'majors' && process.env.MAJORS_SCAN_PINNED !== '0';
    const sigThreshold = (isFavored || useMajorsBar) ? this.minSignalScorePinned : this.minSignalScore;
    const tier = analysis.strength.label;
    const tierOkForSignal = tier === 'MEDIUM' || tier === 'HIGH' || tier === 'VERY HIGH';

    const trigger = { type: source, value: { reason: source } };
    const emitData = { ...analysis, trigger };

    if (this.signalTracker?.hasOpenSignal && this.signalTracker.hasOpenSignal(sym)) {
      if (analysis.score >= sigThreshold && tierOkForSignal) {
        if (this.verbose) console.log(`[conductor] suppress scan ${analysis.side} ${sym} signal — open position exists`);
        return analysis;
      }
    }

    const tp = analysis.tradePlan;
    const planOk = tp && isFinite(tp.entry) && isFinite(tp.sl) && isFinite(tp.tp1);

    if (analysis.score >= sigThreshold && tierOkForSignal && planOk) {

      if (this.#momentumLacksEdge(source, analysis.reasons)) {
        if (this.verbose) console.log(`[conductor] gate scan ${analysis.side} ${sym} — ${source} without on-chain/funding edge (MOMENTUM_REQUIRE_EDGE)`);
        return analysis;
      }

      if (this.#confirmGateDrops(sym, analysis.side, analysis.reasons, 'scan')) return analysis;

      if (await this.#cvdVetoes(sym, analysis.side, source)) return analysis;
      this.lastFiredAt.set(sym, { ts: Date.now(), side: analysis.side });
      this.emit('signal', emitData);
    } else if (analysis.score >= sigThreshold && tierOkForSignal && !planOk && this.verbose) {
      console.log(`[conductor] skip scan ${analysis.side} ${sym} — no usable trade plan (score ${analysis.score.toFixed(2)})`);
    }

    return analysis;
  }

  async evaluateFundingTrigger(tokenSymbol, side, fundingRate) {
    if (isStableSymbol(tokenSymbol)) return;
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

  async evaluateListingTrigger(tokenSymbol, { exchange } = {}) {
    if (isStableSymbol(tokenSymbol)) return false;
    let cgId = this.#findCgIdForSymbol(tokenSymbol);

    if (!cgId) cgId = await this.#onboardListedSymbol(tokenSymbol);
    if (!cgId) return false;
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return false;

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

    this._symbolToCgId?.set(sym, pick.id);
    console.log(`[listings] onboarded ${sym} → ${pick.id} (${token.name ?? ''}) for conductor evaluation`);
    return pick.id;
  }

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

  async #evaluateAndMaybeEmit({ token, side, trigger }) {
    const sym = token.symbol;

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

    const last = this.lastFiredAt.get(sym);
    if (last) {
      const elapsed = Date.now() - last.ts;

      const favoredTok = this.universe.isFavored?.(token.coingeckoId) ?? false;
      const required = last.side === side ? this.cooldownMs : this.cooldownMs * (favoredTok ? 1 : 3);
      if (elapsed < required) return;
    }

    const context = this.#gatherContext({ token, side, trigger });
    let evaluation = this.#evaluate(context);

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

        const trendDir = taMetadata?.['1hour']?.trend ?? taMetadata?.['4hour']?.trend;
        if (trendDir === 'up' || trendDir === 'down') context.priceDir = trendDir;
        if (taFindings.length > 0) {
          const summary = taFindings.map(f => `${f.text} (${f.points >= 0 ? '+' : ''}${f.points})`).join(', ');
          console.log(`[ta] ${sym} ${side} → ${taFindings.length} finding(s): ${summary}`);
          context.taFindings = taFindings;
        }

        if (taFindings.length > 0 || context.priceDir) {
          evaluation = this.#evaluate(context);
        }
      } catch (err) {
        console.warn(`[conductor] TA enrichment failed for ${sym}: ${err.message}`);
      }
    }

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

    const heatmapWorthIt = evaluation.score >= (this.minSignalScorePinned - 0.6);
    if (this.liquidationHeatmap?.computeFast && heatmapWorthIt) {
      try {
        const before = this.liquidationHeatmap.peek?.(sym);
        if (!before) await this.liquidationHeatmap.computeFast(sym);
        if (this.liquidationHeatmap.peek?.(sym)) evaluation = this.#evaluate(context);
      } catch {  }
    }

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

    const hmLiq = this.liquidationHeatmap?.peek?.(sym);
    const liqMagnets = hmLiq ? ((side === 'SHORT' ? hmLiq.shortLiqs : hmLiq.longLiqs) ?? []) : [];
    const liqTargets = hmLiq ? ((side === 'SHORT' ? hmLiq.longLiqs : hmLiq.shortLiqs) ?? []) : [];
    const tradePlan = this.#buildTradePlan(entryPrice, side, taMetadata, this.#tpWallsWithSweep(heatmap, side, sym, entryPrice), trigger, liqMagnets, liqTargets);

    const exhShort = this.#exhaustionReversalShort(side, taMetadata, token.coingeckoId);
    const exhLong  = this.#exhaustionReversalLong(side, taMetadata, token.coingeckoId);
    const exhReversal = exhShort || exhLong;

    if (tradePlan) {
      evaluation.strength = this.#applyTradeQualityPenalties(
        evaluation.strength, tradePlan, trigger, context, exhReversal
      );
    }

    if (this.taService?.getOhlcvByTf && evaluation.score >= this.minObservationScore) {
      const ohlcvByTf = this.taService.getOhlcvByTf(sym);
      if (Object.keys(ohlcvByTf).length > 0) {
        try {
          const confirmation = confirmSignal({ side, ohlcvByTf, dropThreshold: this.confirmDropThreshold, allowExhaustionShort: exhShort, allowExhaustionLong: exhLong });
          if (confirmation.drop) {
            console.log(`[ta-confirm] drop ${sym} ${side} — ${confirmation.reason}`);

            return;
          }

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

    const isFavored = this.universe.isFavored?.(token.coingeckoId) ?? false;
    const sigThreshold = isFavored ? this.minSignalScorePinned : this.minSignalScore;
    const tier = evaluation.strength.label;

    const listingRelaxed = trigger?.type === 'listing' && process.env.LISTING_SIGNAL_RELAXED !== '0';
    const tierOkForSignal = tier === 'MEDIUM' || tier === 'HIGH' || tier === 'VERY HIGH'
      || (listingRelaxed && tier === 'LOW');

    if (this.signalTracker?.hasOpenSignal && this.signalTracker.hasOpenSignal(sym)) {
      if (evaluation.score >= sigThreshold && tierOkForSignal) {
        if (this.verbose) console.log(`[conductor] suppress ${side} ${sym} signal — open position already exists for this token`);
        return;
      }
    }

    const planOk = tradePlan && isFinite(tradePlan.entry) && isFinite(tradePlan.sl) && isFinite(tradePlan.tp1);

    const momentumGated = this.#momentumLacksEdge(trigger?.type, evaluation.reasons);
    if (momentumGated && this.verbose && evaluation.score >= sigThreshold && tierOkForSignal && planOk) {
      console.log(`[conductor] gate ${side} ${sym} — ${trigger?.type} without on-chain/funding edge (MOMENTUM_REQUIRE_EDGE)`);
    }
    const wouldFire = evaluation.score >= sigThreshold && tierOkForSignal && planOk && !momentumGated;

    if (wouldFire && await this.#cvdVetoes(sym, side, trigger?.type)) return;
    if (wouldFire) {
      this.lastFiredAt.set(sym, { ts: Date.now(), side });
      this.emit('signal', { ...context, ...evaluation, tradePlan });
    } else if (evaluation.score >= this.minObservationScore) {

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

    const manip = MANIP_GUARD ? this.#assessManipulation(context.token) : { score: 0, flags: [] };
    const taDeweight = 1 - manip.score * MANIP_TA_DEWEIGHT;

    if (trigger.type === 'flow') {

      const usd = trigger.usd ?? 0;

      let baseFlow = 1.5;
      if      (usd >= 10_000_000) baseFlow = 3.0;
      else if (usd >=  5_000_000) baseFlow = 2.5;
      else if (usd >=  2_000_000) baseFlow = 2.0;
      baseFlow += SCORING.flowBaseBoost;
      score += baseFlow;

      if (trigger.value.toType === 'cold' && side === 'SHORT' && SCORING.coldDepositBoost > 0) {
        score += SCORING.coldDepositBoost;
        reasons.push({
          kind: 'coldDeposit',
          text: `❄️ Deposited into ${trigger.value.exchange ?? 'CEX'} COLD storage — pre-distribution staging (supply parked to sell, stronger sell pressure)`,
          points: SCORING.coldDepositBoost
        });
      }

      const tf = trigger.value.teamFlow;
      if (tf) {

        const teamPts = tf.side === 'sell' ? SCORING.teamSellPts : 0.3;
        score += teamPts;
        const dirWord = tf.side === 'sell' ? 'TEAM DISTRIBUTION' : 'team accumulation';

        const hopNote = (tf.hops ?? 0) > 0 ? ` via ${tf.hops}-hop fresh wallet${tf.hops > 1 ? 's' : ''}` : '';

        const dest = tf.venue === 'dex'
          ? `dumped on ${tf.venueLabel ?? 'a DEX'} (on-chain sell into liquidity)`
          : `${tf.side === 'sell' ? 'sent to' : 'received from'} ${trigger.value.exchange}`;
        reasons.push({
          kind: 'teamFlow',
          text: `🚨 ${dirWord} — rank-#${tf.holderRank} insider holder of ${tf.tokenSymbol} ${dest}${hopNote}`,
          points: teamPts
        });
      }

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
      const surgeScore = SCORING.surgeBase + volBoost;
      score += surgeScore;
      const volTag = volBoost > 0 ? ` _(volume ${volBoost === 0.5 ? '≥3×' : '≥2×'} avg)_` : '';
      reasons.push({
        kind: 'surge',
        text: `Price ${trigger.value.direction.toUpperCase()} ${trigger.value.pctChange.toFixed(2)}% (${trigger.value.open} → ${trigger.value.close})${volTag}`,
        points: surgeScore
      });
    } else if (trigger.type === 'liquidation') {

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

      const pct = (trigger.value.rate * 100).toFixed(3);

      score += SCORING.fundingExtremeBase;
      reasons.push({
        kind: 'funding_trigger',
        text: `Extreme ${trigger.value.polarity} funding at ${pct}% per period (radar entry — needs confluence)`,
        points: SCORING.fundingExtremeBase
      });
    } else if (trigger.type === 'listing') {

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

      const v = trigger.value ?? {};
      const usdStr = (v.cumulativeUsd ?? 0) >= 1e6 ? `$${(v.cumulativeUsd / 1e6).toFixed(2)}M` : `$${Math.round((v.cumulativeUsd ?? 0) / 1e3)}K`;
      score += SCORING.distributionBase;
      reasons.push({
        kind: 'distribution',
        text: `🔴 ${v.exchange ?? 'CEX'} distribution — ${usdStr} hot-wallet outflow in ${v.count} transfers / ${v.windowMins}min${v.volPct != null ? ` (${v.volPct.toFixed(1)}% of 24h vol)` : ''}${v.topDestinations?.length ? ` → ${v.topDestinations.join(', ')}` : ''}`,
        points: SCORING.distributionBase
      });
    }

    let fScore = fundingScoreForSide(side, funding?.summary);
    if (fScore !== null) {

      const isFlowTrigger = trigger.type === 'flow' && (trigger.usd ?? 0) >= 2_000_000;
      if (isFlowTrigger && fScore < -0.5) fScore = -0.5;
      score += fScore;
      const desc = describeFunding(side, funding.summary, 1);
      reasons.push({ kind: 'funding', text: desc, points: fScore });
    }

    let surgeDir = trigger.type === 'surge' ? trigger.value.direction : null;
    if (!surgeDir && recentSurges.length > 0) {
      surgeDir = recentSurges[recentSurges.length - 1].surge.direction;
    }
    if (!surgeDir && (context.priceDir === 'up' || context.priceDir === 'down')) {
      surgeDir = context.priceDir;
    }
    if (surgeDir) {
      const oScore = oiScoreForSide(side, funding?.summary, surgeDir);
      if (oScore != null && oScore !== 0) {
        score += oScore;
        const oiDesc = describeOI(funding.summary);
        if (oiDesc) reasons.push({ kind: 'oi', text: oiDesc, points: oScore });
      }
    }

    const NEAR_SIM_MS = 5 * 60_000;
    const now = Date.now();
    const isNearSim = (ts) => (now - ts) <= NEAR_SIM_MS;

    const otherFlows = recentFlows.filter(e => {
      if (!e.flow.direction) return false;
      if (trigger.type === 'flow' && e.flow === trigger.value) return false;
      return e.flow.direction.toUpperCase() === side;
    });

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

      if (otherFlows.some(e => isNearSim(e.ts))) {
        score += 0.5;
        reasons.push({ kind: 'simultaneous', text: `⚡ aligned flow within last 5min (multi-event confluence)`, points: 0.5 });
      }
    }

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

    const v4 = funding?.summary?.velocity4h;
    const v1 = funding?.summary?.velocity1h;
    let fundingDeltaPerHr = null, velocitySource = null;
    if (typeof v4 === 'number' && isFinite(v4))      { fundingDeltaPerHr = v4 / 4; velocitySource = '4h-rolling'; }
    else if (typeof v1 === 'number' && isFinite(v1)) { fundingDeltaPerHr = v1;     velocitySource = '1h-rolling'; }
    else if (typeof funding?.summary?.delta === 'number' && isFinite(funding.summary.delta)) {
      fundingDeltaPerHr = funding.summary.delta; velocitySource = 'poll-delta';
    }
    if (fundingDeltaPerHr !== null) {
      const NEUTRAL_DELTA = 0.0003;
      const STRONG_DELTA  = 0.001;

      const favorable = (side === 'LONG' && fundingDeltaPerHr < 0) || (side === 'SHORT' && fundingDeltaPerHr > 0);
      const abs = Math.abs(fundingDeltaPerHr);
      const window = velocitySource === '4h-rolling' ? '/hr (4h-avg)'
                   : velocitySource === '1h-rolling' ? '/hr (1h)'
                   :                                    ' since last poll';

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

    if (currentPrice && trigger.type !== 'liquidation') {
      const clusters = this.#getLiquidationClusters(context.token.symbol, currentPrice);

      const magnets = clusters.filter(c => {
        const absDist = Math.abs(c.distancePct);
        if (absDist < 2 || absDist > 8) return false;
        if (side === 'LONG'  && c.dominantSide === 'shorts' && c.distancePct > 0) return true;
        if (side === 'SHORT' && c.dominantSide === 'longs'  && c.distancePct < 0) return true;
        return false;
      });
      if (magnets.length > 0) {

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

    const TA_SOFT_CAP = SCORING.taSoftCap;
    const TA_HARD_CAP = SCORING.taHardCap;
    let taPositiveAccum = 0;
    let taAppliedSum = 0;
    for (const f of context.taFindings ?? []) {
      let applied = f.points;
      if (f.points > 0) {
        const remainingBelowSoft = Math.max(0, TA_SOFT_CAP - taPositiveAccum);
        const inSoftZone = Math.min(f.points, remainingBelowSoft);
        const inDiminishedZone = Math.max(0, f.points - inSoftZone);

        applied = (inSoftZone + inDiminishedZone * 0.5) * taDeweight;

        const wouldExceed = Math.max(0, taAppliedSum + applied - TA_HARD_CAP);
        applied -= wouldExceed;
        if (applied < 0) applied = 0;
        taPositiveAccum += f.points;
        taAppliedSum += applied;
      }
      score += applied;
      reasons.push({ kind: f.kind ?? 'ta', text: f.text, points: Number(applied.toFixed(3)) });
    }

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

    const manipFavored = pumpRegimeBias({
      fundingAvg: funding?.summary?.avg ?? null, distributing, squeezeFuelAbove,
      ride: process.env.PUMP_REGIME_RIDE === '1',
    });
    const phaseWord = manipFavored === 'LONG'
      ? 'squeeze-up phase: ride into the liquidation fuel above (supports LONG)'
      : 'blow-off / distribution phase: fade the move (supports SHORT)';

    if (manip.score > 0 && manip.flags.length) {
      const pts = side === manipFavored ? (manip.score * MANIP_SHORT_BOOST) : -(manip.score * MANIP_LONG_PENALTY);
      score += pts;
      reasons.push({
        kind: 'manipulation',
        text: `⚠️ Manipulation risk ${Math.round(manip.score * 100)}%: ${manip.flags.join(', ')} (${side === manipFavored ? phaseWord : 'against the manipulation phase; TA de-weighted'})`,
        points: Number(pts.toFixed(3))
      });
    }

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

    if (this.enablePrePump && side === 'LONG' && !distributing) {

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

    if (side === 'LONG' && this.distConflictPts > 0) {
      const cgId = context.token?.coingeckoId;
      const now = context.timestamp ?? Date.now();
      let sellUsd = 0, legs = 0;
      for (const e of (recentFlows ?? [])) {
        if (e?.flow?.teamFlow?.side === 'sell' && e.usd > 0) { sellUsd += e.usd; legs++; }
      }
      for (const d of (this.distributionByCgId.get(cgId) ?? [])) {
        if (now - d.ts <= this.distConflictWindowMs && d.usd > 0) { sellUsd += d.usd; legs++; }
      }
      if (legs > 0 && sellUsd >= this.minFlowUsd * 0.25) {
        const mcap = universeInfo?.marketCap ?? null;
        const pctMcap = mcap > 0 ? (sellUsd / mcap) * 100 : null;
        const extra = pctMcap != null ? Math.min(1.5, pctMcap * 3) : 0;
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

  #assessManipulation(token) {
    if (!token) return { score: 0, flags: [] };
    const cgId = token.coingeckoId;

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

  async #fetchHeatmap(sym) {
    if (!this.liquidityClusters) return null;
    try { return await this.liquidityClusters.getClusters(sym); }
    catch (err) { if (this.verbose) console.warn(`[liq-clusters] ${sym}: ${err.message}`); return null; }
  }

  #wallScorer(lc) {
    const HEATMAP_ABS_FLOOR = 50_000;
    const sizes = [...(lc?.bidClusters ?? []), ...(lc?.askClusters ?? [])]
      .map(c => c.sizeUsd).filter(s => s > 0).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    return (usd) => {
      if (!(usd >= HEATMAP_ABS_FLOOR) || median <= 0) return 0;
      const d = usd / median;
      return d >= 5 ? 0.5 : d >= 3 ? 0.3 : d >= 2 ? 0.15 : 0;
    };
  }

  #pickBandWall(arr) {
    const inBand = (arr ?? []).filter(c => Math.abs(c.distancePct) >= 2 && Math.abs(c.distancePct) <= 8);
    return inBand.sort((a, b) => b.sizeUsd - a.sizeUsd)[0] ?? null;
  }

  #heatmapFindings(lc, side) {
    if (!lc) return [];
    const wallPts = this.#wallScorer(lc);
    const fmtUsd = (u) => u >= 1e6 ? `$${(u/1e6).toFixed(1)}M` : `$${(u/1e3).toFixed(0)}K`;

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

    const dailyTrend  = taMetadata.daily?.trend;
    const weeklyTrend = taMetadata['1week']?.trend;
    const dailyTrendKnown = dailyTrend != null;
    const dailyAgainst = (side === 'LONG'  && dailyTrend === 'down') ||
                         (side === 'SHORT' && dailyTrend === 'up');
    const weeklyAgainst = (side === 'LONG'  && weeklyTrend === 'down') ||
                          (side === 'SHORT' && weeklyTrend === 'up');

    const rsiAgainst = (rsi) => rsi != null && isFinite(rsi) && (side === 'LONG' ? rsi >= 80 : rsi <= 20);
    const extremeMag = (rsi) => side === 'LONG' ? rsi : 100 - rsi;
    let exhaustionTfs = 0, exhaustionMax = 0;
    for (const tf of ['1hour', '4hour', 'daily', '1week']) {
      const rsi = taMetadata[tf]?.rsi;
      if (rsiAgainst(rsi)) { exhaustionTfs++; exhaustionMax = Math.max(exhaustionMax, extremeMag(rsi)); }
    }
    const entryTfExhausted = rsiAgainst(taMetadata['5min']?.rsi);

    const structRoom = structuralRoom(side, entry, taMetadata);

    let horizon, chosenTfForAtr, validityHrs;
    if (dailyAgainst) {

      if (alignmentCount >= 1 && aligned.includes('1hour') && weightedAlignment >= 0.14) {
        horizon = 'DAY';      chosenTfForAtr = '1hour'; validityHrs = 8;
      } else {
        horizon = 'SCALP';    chosenTfForAtr = '5min';  validityHrs = 2;
      }
    } else if (!weeklyAgainst && alignmentCount >= 3 && aligned.includes('daily') && weightedAlignment >= 0.50) {

      horizon = 'POSITION';   chosenTfForAtr = '4hour'; validityHrs = aligned.includes('1week') ? 120 : 72;
    } else if (alignmentCount >= 1 && (aligned.includes('4hour') || aligned.includes('daily')) && weightedAlignment >= 0.24) {
      horizon = 'SWING';      chosenTfForAtr = '1hour'; validityHrs = 24;
    } else if (alignmentCount >= 1 && aligned.includes('1hour') && weightedAlignment >= 0.14) {
      horizon = 'DAY';        chosenTfForAtr = '1hour'; validityHrs = 8;
    } else {
      horizon = 'SCALP';      chosenTfForAtr = '5min';  validityHrs = 2;
    }

    let atr = taMetadata[chosenTfForAtr]?.atr;
    if (!atr || !isFinite(atr) || atr <= 0) {
      for (const tf of tfs) {
        const a = taMetadata[tf]?.atr;
        if (a && isFinite(a) && a > 0) { atr = a; break; }
      }
    }
    if (!atr || atr <= 0) return null;

    const wickRatio = taMetadata[chosenTfForAtr]?.recentWickRatio ?? 1;
    let slMultiplier;
    if      (wickRatio >= 3) slMultiplier = 2.5;
    else if (wickRatio >= 2) slMultiplier = 2.0;
    else                     slMultiplier = 1.5;
    let slDistance = atr * slMultiplier;
    const atrSlDistance = slDistance;
    let slPct = (slDistance / entry) * 100;

    const MAX_SL_PCT = SL_MAX_PCT[horizon] ?? SL_MAX_PCT.POSITION;

    let slBasis = 'atr';
    {
      const buffer = Math.max(atr * 0.3, entry * 0.0015);
      let bestDist = null;
      for (const tf of ['5min', '1hour', '4hour', 'daily']) {
        const m = taMetadata[tf];
        if (!m) continue;
        const levels = [ ...(side === 'LONG' ? (m.swingLows ?? []) : (m.swingHighs ?? [])) ];
        const ext = side === 'LONG' ? m.swingLow : m.swingHigh;
        if (isFinite(ext) && ext > 0) levels.push(ext);
        for (const lvl of levels) {
          if (!isFinite(lvl) || lvl <= 0) continue;
          if (side === 'LONG' ? lvl >= entry : lvl <= entry) continue;
          const dist = Math.abs(entry - lvl) + buffer;
          if (dist <= slDistance) continue;
          if ((dist / entry) * 100 > MAX_SL_PCT) continue;
          if (bestDist == null || dist < bestDist) bestDist = dist;
        }
      }
      if (bestDist != null) {
        if (this.verbose) console.log(`[trade-plan] ${side} SL → structure: ${slPct.toFixed(2)}% → ${(bestDist / entry * 100).toFixed(2)}% (just beyond nearest swing)`);
        slDistance = bestDist;
        slPct = (slDistance / entry) * 100;
        slBasis = 'structure';
      }
    }

    let slCapped = false;
    if (slPct > MAX_SL_PCT) {
      if (this.verbose) console.log(`[trade-plan] cap ${side} SL ${slPct.toFixed(1)}% → ${MAX_SL_PCT}% (ATR too wide on this TF/wick ratio)`);
      slDistance = entry * (MAX_SL_PCT / 100);
      slPct = MAX_SL_PCT;
      slCapped = true;
    }
    const sl  = side === 'LONG' ? entry - slDistance : entry + slDistance;

    const [m1, m2, m3] = slCapped ? [1.0, 1.75, 2.5] : [1.5, 3.0, 4.5];
    const rawTp1 = side === 'LONG' ? entry + slDistance * m1 : entry - slDistance * m1;
    const rawTp2 = side === 'LONG' ? entry + slDistance * m2 : entry - slDistance * m2;
    const rawTp3 = side === 'LONG' ? entry + slDistance * m3 : entry - slDistance * m3;

    {
      const barHrs = { '1min': 1/60, '5min': 1/12, '1hour': 1, '4hour': 4, 'daily': 24 }[chosenTfForAtr] ?? 1;
      const NOISE_FACTOR = 3;
      const barsToTp2 = atr > 0 ? (slDistance * m2) / atr : 6;
      const estHrs = barsToTp2 * NOISE_FACTOR * barHrs;
      const [vMin, vMax] = horizon === 'POSITION' ? [72, 168]
                         : horizon === 'SWING'    ? [24, 60]
                         : horizon === 'DAY'      ? [8, 20]
                         :                          [3, 8];
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

    let cascadeTp = false;
    const isCascade = trigger?.type === 'liquidation' || trigger?.type === 'liqSweep';
    if (CASCADE_TP_EXTEND && isCascade && (liqTargets?.length)) {
      let far = null;
      for (const m of liqTargets) {
        const px = m?.price;
        if (!(px > 0) || (m.notionalUsd ?? 0) < this.liqMagnetMinUsd) continue;
        if (Math.abs(m.distancePct ?? 999) > CASCADE_TP_MAX_PCT) continue;
        if (side === 'LONG' ? px <= tp3 : px >= tp3) continue;
        if (far == null || (side === 'LONG' ? px > far : px < far)) far = px;
      }
      if (far != null) { tp3 = side === 'LONG' ? far * 0.998 : far * 1.002; cascadeTp = true; }
    }

    const SUGGESTED_DAMP = 0.4;
    const MAX_DAMP = 0.7;
    const rawMaxLev = this.levRiskBasis / (slPct / 100);

    const confidenceFactor = 0.3 + Math.min(1, weightedAlignment) * 0.7;
    let tierCap;
    if      (slPct < 0.5) tierCap = 10;
    else if (slPct < 1.0) tierCap = 15;
    else if (slPct < 2.5) tierCap = 20;
    else if (slPct < 5.0) tierCap = 15;
    else if (slPct < 8.0) tierCap = 8;
    else                  tierCap = 5;

    const suggested = Math.max(2, Math.min(tierCap, Math.floor(rawMaxLev * confidenceFactor * SUGGESTED_DAMP)));
    const maxLev    = Math.max(2, Math.min(tierCap, Math.floor(rawMaxLev * MAX_DAMP)));

    let limitEntry = null;
    let isLiquidityGrab = false;
    let limitFromMagnet = false;

    const momentumLive = process.env.MOMENTUM_CMP_ENTRY === '1' && isMomentumLive(trigger, side);
    if (dailyAgainst && momentumLive && this.verbose) {
      console.log(`[conductor] ${side} counter-trend but momentum live (${trigger.type}) — CMP/market entry, no swing limit`);
    }
    if (dailyAgainst && !momentumLive) {

      const candidates = side === 'SHORT'
        ? [taMetadata.daily?.swingHigh, taMetadata['4hour']?.swingHigh, taMetadata['1hour']?.swingHigh]
        : [taMetadata.daily?.swingLow,  taMetadata['4hour']?.swingLow,  taMetadata['1hour']?.swingLow];
      const valid = candidates.filter(v => typeof v === 'number' && isFinite(v) && v > 0);
      let target = null;
      if (side === 'SHORT') {

        const above = valid.filter(v => v > entry);
        if (above.length) target = Math.min(...above);
      } else {

        const below = valid.filter(v => v < entry);
        if (below.length) target = Math.max(...below);
      }

      let magnetTarget = null;
      for (const m of liqMagnets ?? []) {
        const px = m?.price;
        if (!(px > 0) || (m.notionalUsd ?? 0) < this.liqMagnetMinUsd) continue;
        if (side === 'SHORT' ? px <= entry : px >= entry) continue;
        if (magnetTarget == null || (side === 'SHORT' ? px < magnetTarget : px > magnetTarget)) magnetTarget = px;
      }
      if (magnetTarget != null) { target = magnetTarget; limitFromMagnet = true; }
      if (target) {

        const buffer = atr * 0.1;
        const candidateLimit = side === 'SHORT' ? target - buffer : target + buffer;

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

    if (isLiquidityGrab && limitEntry) {
      const grabSlDistance = atrSlDistance;
      const grabSl  = side === 'LONG' ? limitEntry - grabSlDistance : limitEntry + grabSlDistance;

      const rawGrabTp1 = side === 'LONG' ? limitEntry + grabSlDistance * m1 : limitEntry - grabSlDistance * m1;
      const rawGrabTp2 = side === 'LONG' ? limitEntry + grabSlDistance * m2 : limitEntry - grabSlDistance * m2;
      const rawGrabTp3 = side === 'LONG' ? limitEntry + grabSlDistance * m3 : limitEntry - grabSlDistance * m3;

      const grabSnap = this.#snapTpsToStructure({
        side, entry: limitEntry, slDistance: grabSlDistance,
        rawTp1: rawGrabTp1, rawTp2: rawGrabTp2, rawTp3: rawGrabTp3, taMetadata, heatmapWalls
      });
      const grabTp1 = grabSnap.tp1;
      const grabTp2 = grabSnap.tp2;
      const grabTp3 = grabSnap.tp3;

      const grabRR = (tp) => Math.abs(tp - limitEntry) / grabSlDistance;

      return {
        entry, sl: grabSl, tp1: grabTp1, tp2: grabTp2, tp3: grabTp3,
        slPct: (grabSlDistance / limitEntry) * 100,
        limitEntry,
        isLiquidityGrab: true,
        limitBasis: limitFromMagnet ? 'liq-magnet' : 'swing',
        slMultiplier,
        slBasis: 'liquidity-grab',
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

    const profitSideOk = side === 'LONG'
      ? (sl < entry && tp1 > entry && tp2 > entry && tp3 > entry)
      : (sl > entry && tp1 < entry && tp2 < entry && tp3 < entry);
    if (!profitSideOk) {
      if (this.verbose) console.log(`[trade-plan] ${side} ${entry} rejected — TP/SL geometry invalid (sl=${sl} tp1=${tp1} tp2=${tp2} tp3=${tp3})`);
      return null;
    }

    const rrFor = (tp) => Math.abs(tp - entry) / slDistance;

    return {
      entry, sl, tp1, tp2, tp3, slPct,
      limitEntry,
      cascadeTp,
      isLiquidityGrab: false,
      slMultiplier,
      slBasis,
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

  #snapTpsToStructure({ side, entry, slDistance, rawTp1, rawTp2, rawTp3, taMetadata, heatmapWalls = [] }) {

    const candidates = [];
    if (taMetadata) {
      for (const tf of ['1week', 'daily', '4hour', '1hour', '5min']) {
        const m = taMetadata[tf];
        if (!m) continue;
        const pool = side === 'LONG' ? (m.swingHighs ?? []) : (m.swingLows ?? []);
        for (const px of pool) {
          if (!isFinite(px) || px <= 0) continue;
          if (side === 'LONG' && px <= entry)  continue;
          if (side === 'SHORT' && px >= entry) continue;
          candidates.push({ price: px, tf });
        }
      }
    }

    for (const w of heatmapWalls ?? []) {
      const px = w?.price;
      if (!isFinite(px) || px <= 0) continue;
      if (side === 'LONG' && px <= entry)  continue;
      if (side === 'SHORT' && px >= entry) continue;
      candidates.push({ price: px, tf: w.tf ?? 'wall' });
    }
    if (candidates.length === 0) {
      return { tp1: rawTp1, tp2: rawTp2, tp3: rawTp3, snapped: { tp1: false, tp2: false, tp3: false } };
    }

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

  static TIER_CONF  = { MIXED: 10, LOW: 25, MEDIUM: 50, HIGH: 78, 'VERY HIGH': 92 };
  static TIER_FLOOR = { MIXED: 0,  LOW: 2,  MEDIUM: 3,  HIGH: 4,  'VERY HIGH': 5 };
  static TIER_EMOJI = { MIXED: '⚠️', LOW: '🟠', MEDIUM: '🟡', HIGH: '✅', 'VERY HIGH': '🔥' };

  #tierConfidence(label, score) {
    const anchor = Conductor.TIER_CONF[label] ?? 50;
    const frac = Math.max(0, Math.min(1, score - (Conductor.TIER_FLOOR[label] ?? 0)));
    return Math.max(5, Math.min(100, anchor + Math.round((frac - 0.5) * 12)));
  }

  #strengthLabel(score) {
    const label = score >= 5 ? 'VERY HIGH'
                : score >= 4 ? 'HIGH'
                : score >= 3 ? 'MEDIUM'
                : score >= 2 ? 'LOW'
                :              'MIXED';
    return { label, emoji: Conductor.TIER_EMOJI[label], total: score, confidence: this.#tierConfidence(label, score) };
  }

  #applyTradeQualityPenalties(strength, tradePlan, trigger, context, exhReversal = false, lowConviction = false) {
    if (!tradePlan) return strength;

    if (strength.label === 'MIXED') return strength;

    const tiers = ['MIXED', 'LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'];
    const idxOriginal = Math.max(0, tiers.indexOf(strength.label));
    let idx = idxOriginal;

    const isListing = trigger?.type === 'listing';

    const isHighEdge = ['liquidation'].includes(trigger?.type)
      && process.env.HIGH_EDGE_ALIGNMENT_EXEMPT !== '0';
    const alignmentExempt = isListing || isHighEdge;

    const liqOiFrac = trigger?.type === 'liquidation' ? Number(trigger.value?.oiFrac) : NaN;
    const violentLiq = isFinite(liqOiFrac) && liqOiFrac >= (numEnv('LIQ_VIOLENT_OI_PCT', 0.005));
    if (violentLiq) idx += 1;

    const rr1 = tradePlan.rr1 ?? (tradePlan.slPct > 0 ? tradePlan.tp1Pct / tradePlan.slPct : 1);
    const rr = Math.max(rr1, (tradePlan.rr2 ?? 0) * 0.5, (tradePlan.rr3 ?? 0) * 0.33);
    if (rr < 1.0) idx -= 2;
    else if (rr < 1.5) idx -= 1;

    const weakAlignment = (tradePlan.weightedAlignment ?? 0) <= 0.15;
    const shortHorizon = tradePlan.horizon === 'SCALP' || tradePlan.horizon === 'DAY';
    if (weakAlignment && shortHorizon && !alignmentExempt) idx -= 1;

    const wa = tradePlan.weightedAlignment ?? 0;
    if (!exhReversal && !alignmentExempt) {
      if (tradePlan.dailyAgainst && wa <= 0.30) {
        idx = Math.min(idx, 1);
      } else if (wa < 0.30) {
        idx = Math.min(idx, 2);
      } else if (wa < 0.50) {
        idx = Math.min(idx, 3);
      }
    }

    if (this.regimeMonitor && this.regimePenalty > 0 && this.regimeMonitor.isEnabled?.() !== false) {
      const sym = context.token?.symbol?.toUpperCase();
      if (sym && sym !== (this.regimeMonitor.symbol ?? 'BTC')) {
        const r = this.regimeMonitor.get();
        const fights = (context.side === 'LONG'  && r?.regime === 'BTC_DOWN')
                    || (context.side === 'SHORT' && r?.regime === 'BTC_UP');
        if (fights && r?.acute) idx = Math.min(idx, 1);
      }
    }

    const exTfs = tradePlan.exhaustionTfs ?? 0;
    const exMax = tradePlan.exhaustionMax ?? 0;
    if (exTfs >= 3 || (exTfs >= 2 && exMax >= 88)) idx -= 2;
    else if (exTfs >= 2) idx -= 1;

    else if (exTfs >= 1 && exMax >= 88) idx -= 1;

    if (trigger.type === 'surge' && tradePlan.entryTfExhausted) idx -= 1;

    const sr = tradePlan.structRoom;
    if (STRUCT_GUARD && sr && !tradePlan.isLiquidityGrab && !exhReversal) {
      const tp1Pct = tradePlan.tp1Pct ?? Infinity;
      if (sr.shelf && sr.roomPct <= STRUCT_ROOM_PCT) {

        idx = Math.min(idx, 1);
        if (this.verbose) console.log(`[struct-guard] ${context.side} ${context.token?.symbol} — SHELF ${sr.roomPct}% ahead → observation`);
      } else if (sr.roomPct <= STRUCT_ROOM_SINGLE_PCT && sr.roomPct < tp1Pct) {

        idx -= 1;
        if (this.verbose) console.log(`[struct-guard] ${context.side} ${context.token?.symbol} — level ${sr.roomPct}% ahead (TP1 ${tp1Pct.toFixed?.(1)}%) → −1 tier`);
      }
    }

    if (tradePlan.dailyTrendKnown === false) idx -= 0.5;

    if (lowConviction) idx -= 1;

    const isSentimentOnly = trigger.type === 'funding_extreme' &&
      (context.recentFlows?.length ?? 0) === 0 &&
      (context.recentLiquidations?.length ?? 0) === 0;
    if (isSentimentOnly && idx >= 3) idx = 3;

    const idxFinal = Math.max(0, Math.min(tiers.length - 1, Math.floor(idx)));
    const finalLabel = tiers[idxFinal];

    return {
      label: finalLabel,
      emoji: Conductor.TIER_EMOJI[finalLabel],
      total: strength.total,
      confidence: this.#tierConfidence(finalLabel, strength.total)
    };
  }

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

  #getLiquidationClusters(symbol, currentPrice, minClusterUsd = 2_000_000) {
    if (!currentPrice || currentPrice <= 0) return [];
    const events = this.liqClustersByToken.get(symbol) ?? [];
    if (events.length === 0) return [];

    const cutoff = Date.now() - 24 * 60 * 60_000;

    const BUCKET_RATIO = 0.005;
    const logBase = Math.log(1 + BUCKET_RATIO);
    const buckets = new Map();

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
      const midPrice = Math.exp(idx * logBase);
      const distancePct = ((midPrice - currentPrice) / currentPrice) * 100;
      if (Math.abs(distancePct) > 10) continue;
      const dominantSide = b.longUsd >= b.shortUsd ? 'longs' : 'shorts';
      clusters.push({ midPrice, distancePct, longUsd: b.longUsd, shortUsd: b.shortUsd, dominantSide });
    }

    clusters.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    return clusters;
  }

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

    prune(this.liqClustersByToken, 24 * 60 * 60_000);

    const cooldownGc = this.cooldownMs * 3;
    for (const [k, entry] of this.lastFiredAt.entries()) {
      if (now - entry.ts > cooldownGc) this.lastFiredAt.delete(k);
    }

    for (const [k, entry] of this.recentLosses.entries()) {
      if (now - entry.ts > this.postLossExtendedCooldownMs) this.recentLosses.delete(k);
    }
  }
}
