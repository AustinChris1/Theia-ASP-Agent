

const LEV_BRACKETS = [
  { lev: 5,   weight: 0.125 },
  { lev: 10,  weight: 0.275 },
  { lev: 25,  weight: 0.300 },
  { lev: 50,  weight: 0.200 },
  { lev: 100, weight: 0.100 },
];
const MMR = 0.005;
const BIN_PCT = 0.5;

const LIQMAP_ADAPTIVE_LEV = process.env.LIQMAP_ADAPTIVE_LEV === '1';
const LIQMAP_LEV_K = Number(process.env.LIQMAP_LEV_K) || 50;
const LEV_TIERS = [3, 5, 10, 25, 50, 100];

export function adaptiveLeverages(volPct, { tiers = LEV_TIERS, k = LIQMAP_LEV_K, spread = 0.85 } = {}) {
  const v = Math.max(0.4, Math.min(20, Number(volPct) || 4));
  const peak = Math.max(2, Math.min(100, k / v));
  const lnPeak = Math.log(peak);
  const raw = tiers.map(lev => {
    const d = Math.log(lev) - lnPeak;
    return { lev, w: Math.exp(-(d * d) / (2 * spread * spread)) };
  });
  const sum0 = raw.reduce((s, t) => s + t.w, 0) || 1;

  const kept = raw.filter(t => t.w / sum0 >= 0.03);
  const sum = kept.reduce((s, t) => s + t.w, 0) || 1;
  return kept.map(t => ({ lev: t.lev, weight: t.w / sum }));
}

export function realizedVolPct(candles) {
  const r = [];
  for (const c of candles ?? []) if (c.h > 0 && c.l > 0 && c.c > 0) r.push((c.h - c.l) / c.c * 100);
  if (!r.length) return 4;
  r.sort((a, b) => a - b);
  return r[Math.floor(r.length / 2)];
}

const MAX_DIST_PCT = Number(process.env.LIQMAP_MAX_DIST_PCT) || 80;

const LIQMAP_RECENCY_HL = Number(process.env.LIQMAP_RECENCY_HL ?? 1);

function addBin(bins, price, cur, usd, lev, binPct, maxDistPct) {
  if (!(price > 0) || !(usd > 0)) return;
  const distPct = ((price - cur) / cur) * 100;
  if (Math.abs(distPct) > maxDistPct) return;
  const idx = Math.round(distPct / binPct);
  const b = bins.get(idx) ?? { usd: 0, priceSum: 0, levSum: 0 };
  b.usd += usd; b.priceSum += price * usd; b.levSum += lev * usd;
  bins.set(idx, b);
}

export function computeLiquidationHeatmap(candles, oiByTs, lsByTs, {
  currentPrice = null, leverages = LEV_BRACKETS, mmr = MMR, binPct = BIN_PCT, maxDistPct = MAX_DIST_PCT, topN = 14,
  recencyHalfLife = LIQMAP_RECENCY_HL
} = {}) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const cur = currentPrice && currentPrice > 0 ? currentPrice : candles[n - 1].c;
  if (!(cur > 0)) return null;

  const suffMinLow = new Array(n), suffMaxHigh = new Array(n);
  suffMinLow[n - 1] = candles[n - 1].l; suffMaxHigh[n - 1] = candles[n - 1].h;
  for (let i = n - 2; i >= 0; i--) {
    suffMinLow[i] = Math.min(candles[i].l, suffMinLow[i + 1]);
    suffMaxHigh[i] = Math.max(candles[i].h, suffMaxHigh[i + 1]);
  }

  const longBins = new Map(), shortBins = new Map();
  let prevOi = null;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const oi = oiByTs.get(c.t);
    if (oi == null || !isFinite(oi)) continue;
    if (prevOi == null) { prevOi = oi; continue; }
    const dOi = oi - prevOi;
    prevOi = oi;
    if (dOi <= 0) continue;

    const openPx = c.c;
    if (!(openPx > 0)) continue;

    const ls = lsByTs.get(c.t);
    let longFrac;
    if (ls != null && isFinite(ls) && ls > 0) longFrac = ls / (1 + ls);
    else longFrac = c.c >= c.o ? 0.55 : 0.45;

    const ageFrac = n > 1 ? (n - 1 - i) / (n - 1) : 0;
    const recency = recencyHalfLife > 0 ? Math.pow(2, -ageFrac / recencyHalfLife) : 1;
    const newLong = dOi * longFrac * recency, newShort = dOi * (1 - longFrac) * recency;

    const afterLow = Math.min(i + 1 < n ? suffMinLow[i + 1] : cur, cur);
    const afterHigh = Math.max(i + 1 < n ? suffMaxHigh[i + 1] : cur, cur);

    for (const { lev, weight } of leverages) {
      const liqLong = openPx * (1 - 1 / lev + mmr);
      if (liqLong < openPx && afterLow > liqLong) addBin(longBins, liqLong, cur, newLong * weight, lev, binPct, maxDistPct);
      const liqShort = openPx * (1 + 1 / lev - mmr);
      if (liqShort > openPx && afterHigh < liqShort) addBin(shortBins, liqShort, cur, newShort * weight, lev, binPct, maxDistPct);
    }
  }

  const finalize = (bins) => {
    let total = 0;
    const all = [];
    for (const [, b] of bins) {
      total += b.usd;
      const price = b.priceSum / b.usd;
      all.push({ price, distancePct: ((price - cur) / cur) * 100, notionalUsd: b.usd, dominantLev: b.levSum / b.usd });
    }
    all.sort((a, b) => b.notionalUsd - a.notionalUsd);
    return { clusters: all.slice(0, topN), total };
  };

  const L = finalize(longBins), S = finalize(shortBins);
  return {
    currentPrice: cur,
    longLiqs: L.clusters,
    shortLiqs: S.clusters,
    totalLongUsd: Number(L.total.toFixed(2)),
    totalShortUsd: Number(S.total.toFixed(2)),
  };
}

export function detectLiquiditySweep(prevMap, newMap, { minClusterUsd = 1_000_000, shrinkFrac = 0.5, tagTolerancePct = 0.3 } = {}) {
  if (!prevMap || !newMap) return null;
  const cur = Number(newMap.currentPrice);
  if (!(cur > 0)) return null;

  const survived = (clusters, price, prevUsd) => {
    for (const c of clusters ?? []) {
      if (price > 0 && Math.abs((c.price - price) / price) * 100 <= tagTolerancePct) {
        return (c.notionalUsd ?? 0) >= prevUsd * shrinkFrac;
      }
    }
    return false;
  };

  let up = null;
  for (const c of prevMap.shortLiqs ?? []) {
    if ((c.notionalUsd ?? 0) < minClusterUsd || !(c.price > 0)) continue;
    if (cur >= c.price * (1 - tagTolerancePct / 100) && !survived(newMap.shortLiqs, c.price, c.notionalUsd)) {
      if (!up || c.notionalUsd > up.sweptUsd) up = { sweptPrice: c.price, sweptUsd: c.notionalUsd };
    }
  }

  let down = null;
  for (const c of prevMap.longLiqs ?? []) {
    if ((c.notionalUsd ?? 0) < minClusterUsd || !(c.price > 0)) continue;
    if (cur <= c.price * (1 + tagTolerancePct / 100) && !survived(newMap.longLiqs, c.price, c.notionalUsd)) {
      if (!down || c.notionalUsd > down.sweptUsd) down = { sweptPrice: c.price, sweptUsd: c.notionalUsd };
    }
  }

  const pickUp = up && (!down || up.sweptUsd >= down.sweptUsd);
  const chosen = pickUp ? up : down;
  if (!chosen) return null;

  const oppList = pickUp
    ? (newMap.longLiqs ?? []).filter(c => c.price > 0 && c.price < cur)
    : (newMap.shortLiqs ?? []).filter(c => c.price > 0 && c.price > cur);
  const target = oppList.sort((a, b) => (b.notionalUsd ?? 0) - (a.notionalUsd ?? 0))[0] ?? null;

  return {
    side: pickUp ? 'up' : 'down',
    fadeSide: pickUp ? 'SHORT' : 'LONG',
    sweptPrice: chosen.sweptPrice,
    sweptUsd: chosen.sweptUsd,
    targetPrice: target?.price ?? null,
    targetUsd: target?.notionalUsd ?? null,
    targetDistPct: target ? ((target.price - cur) / cur) * 100 : null,
  };
}

export class LiquidationHeatmap {
  constructor({ coinalyze, perpSymbolMap, taService = null, intervalDays = 120, interval = '4hour', verbose = false, cacheTtlMs = 5 * 60_000 }) {
    this.coinalyze = coinalyze;
    this.perpSymbolMap = perpSymbolMap;
    this.taService = taService;

    this.intervalDays = intervalDays;
    this.interval = interval;
    this.verbose = verbose;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();

    this.sweeps = new Map();
    this.sweepMinUsd = Number(process.env.LIQ_SWEEP_MIN_USD) || 1_000_000;

    this.aggMarkets = process.env.LIQMAP_AGG_MARKETS !== '0';
    this.aggMax = Number(process.env.LIQMAP_AGG_MAX) || 3;
  }

  async compute(symbol) {
    const sym = (symbol ?? '').toUpperCase();
    const perp = this.perpSymbolMap?.get(sym);
    if (!this.coinalyze || !perp) return null;

    const cached = this.cache.get(sym);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.map;

    const now = Math.floor(Date.now() / 1000);
    const from = now - this.intervalDays * 86400;
    const interval = this.interval;

    let oiSyms = [perp];
    if (this.aggMarkets && this.coinalyze.perpMarketsFor) {
      try {
        const all = await this.coinalyze.perpMarketsFor(sym, this.aggMax);
        if (all?.length) oiSyms = [perp, ...all.filter(s => s && s !== perp)].slice(0, this.aggMax);
      } catch {  }
    }

    let ohlcv, oi, ls;
    try {
      [ohlcv, oi, ls] = await Promise.all([
        this.coinalyze.ohlcvHistory([perp], interval, from, now),
        this.coinalyze.openInterestHistory(oiSyms, interval, from, now),
        this.coinalyze.longShortRatio([perp], interval, from, now).catch(() => null),
      ]);
    } catch (err) {
      if (this.verbose) console.warn(`[liq-map] ${sym} fetch failed: ${err.message}`);
      return null;
    }

    const candles = (ohlcv?.[0]?.history ?? [])
      .map(b => ({ t: b.t ?? b.timestamp, o: Number(b.o ?? b.open), h: Number(b.h ?? b.high), l: Number(b.l ?? b.low), c: Number(b.c ?? b.close) }))
      .filter(b => isFinite(b.t) && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0);
    if (candles.length < 5) return null;

    const oiByTs = new Map();
    let oiMarkets = 0;
    for (const series of (oi ?? [])) {
      if (!series?.history?.length) continue;
      oiMarkets++;
      for (const x of series.history) {
        const t = x.t ?? x.timestamp;
        const v = Number(x.c ?? x.close);
        if (isFinite(v)) oiByTs.set(t, (oiByTs.get(t) ?? 0) + v);
      }
    }
    const lsByTs = new Map();
    for (const x of (ls?.[0]?.history ?? [])) {
      const r = Number(x.r ?? x.ratio ?? (x.l && x.s ? x.l / x.s : NaN));
      if (isFinite(r) && r > 0) lsByTs.set(x.t ?? x.timestamp, r);
    }
    if (oiByTs.size < 3) {
      if (this.verbose) console.warn(`[liq-map] ${sym} — no OI history`);
      return null;
    }

    let currentPrice = candles[candles.length - 1].c;
    if (this.taService?.getLastPerpPrice) {
      try { const p = await this.taService.getLastPerpPrice(sym); if (p > 0) currentPrice = p; } catch {  }
    }

    const volPct = realizedVolPct(candles);
    const leverages = LIQMAP_ADAPTIVE_LEV ? adaptiveLeverages(volPct) : undefined;
    const map = computeLiquidationHeatmap(candles, oiByTs, lsByTs, { currentPrice, leverages });
    if (map) {
      map.symbol = sym; map.windowDays = this.intervalDays;
      map.volPct = Number(volPct.toFixed(2));
      map.oiMarkets = oiMarkets;
      if (leverages) map.levProfile = leverages.map(l => `${l.lev}x:${Math.round(l.weight * 100)}%`).join(' ');

      const prev = this.cache.get(sym)?.map;
      if (prev) {
        const sweep = detectLiquiditySweep(prev, map, { minClusterUsd: this.sweepMinUsd });
        if (sweep && sweep.targetPrice) {
          this.sweeps.set(sym, { ...sweep, ts: Date.now() });
          if (this.verbose) console.log(`[liq-map] ${sym} liquidity sweep ${sweep.side} ($${(sweep.sweptUsd / 1e6).toFixed(1)}M) → fade ${sweep.fadeSide} toward ${sweep.targetDistPct?.toFixed(1)}%`);
        }
      }
      this.cache.set(sym, { ts: Date.now(), map });
    }
    return map;
  }

  recentSweep(symbol, maxAgeMs = 30 * 60_000) {
    const s = this.sweeps.get((symbol ?? '').toUpperCase());
    if (!s || (Date.now() - s.ts) > maxAgeMs) return null;
    return s;
  }

  peek(symbol) {
    const c = this.cache.get((symbol ?? '').toUpperCase());
    if (!c || (Date.now() - c.ts) > this.cacheTtlMs * 4) return null;
    return c.map;
  }

  async computeFast(symbol, timeoutMs = Number(process.env.LIQMAP_FIRE_TIMEOUT_MS) || 2500) {
    const cached = this.peek(symbol);
    if (cached) return cached;
    let timer;
    try {
      return await Promise.race([
        this.compute(symbol).catch(() => null),
        new Promise(res => { timer = setTimeout(() => res(null), Math.max(300, timeoutMs)); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async warm(symbols, cap = 8) {
    let done = 0;
    for (const s of symbols ?? []) {
      if (done >= cap) break;
      const sym = (s ?? '').toUpperCase();
      const c = this.cache.get(sym);
      if (c && (Date.now() - c.ts) < this.cacheTtlMs) continue;
      try { if (await this.compute(sym)) done++; } catch {  }
      await new Promise(r => setTimeout(r, 500));
    }
    return done;
  }
}
