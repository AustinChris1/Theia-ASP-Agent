// Liquidation heatmap — estimates the price levels where leveraged positions
// would get liquidated, and HOW MUCH notional sits at each. Unlike the
// order-book heatmap (resting limit orders, only near price), this maps the
// far-out "magnet" zones — e.g. shorts opened when a coin was 2× higher whose
// liquidation levels still sit up there waiting for a squeeze.
//
// Model (the standard Coinglass-style estimate, refined):
//   • Walk historical candles + open-interest. Each time OI RISES, that's new
//     notional opened ≈ at that candle's price.
//   • Split it long/short by the long-short ratio at that time (else 50/50,
//     nudged by candle direction).
//   • For a spread of leverage brackets, compute each side's liquidation price:
//        long  liq = open × (1 − 1/L + MMR)     (below open)
//        short liq = open × (1 + 1/L − MMR)     (above open)
//   • A level is only "live" (kept) if price has NOT traded through it since the
//     position opened (checked against the running min-low / max-high). Levels
//     price already swept are liquidated and removed.
//   • Bin surviving notional by % distance from current price → the heatmap.
//
// Returns { currentPrice, longLiqs[], shortLiqs[], totalLongUsd, totalShortUsd }
// where longLiqs sit BELOW price (long flushes) and shortLiqs ABOVE (short
// squeezes). Each cluster: { price, distancePct, notionalUsd, dominantLev }.

// Leverage distribution (how perp OI is typically split across leverage). Higher
// leverage → liquidation closer to entry; lower → farther. Weights are heuristic
// but match observed retail-heavy perp books.
const LEV_BRACKETS = [
  { lev: 5,   weight: 0.125 },
  { lev: 10,  weight: 0.275 },
  { lev: 25,  weight: 0.300 },
  { lev: 50,  weight: 0.200 },
  { lev: 100, weight: 0.100 },
];
const MMR = 0.005;          // maintenance-margin rate (~0.5%) — liquidate slightly before full loss
const BIN_PCT = 0.5;        // merge liq levels into 0.5% price bins

// ── Adaptive leverage distribution ──────────────────────────────────────────
// A FIXED 5/10/25/50/100x fan makes every token's liq ladder the same shape (the
// synthetic ±1/2/4/10/20% symmetry a reviewer flagged) and paints an implausible
// 100x@±1% band on coins that swing 8%/bar. Reality: degens on a HIGH-VOL token
// run LOWER leverage (100x liquidates in minutes there); a LOW-VOL major carries
// more high-lev OI. So derive the bracket weights from the token's realized
// volatility — a log-space bell centred on the "comfortable" leverage (peak ≈
// k / volPct) — and DROP the tiers that wouldn't realistically survive. Anchored
// to data (vol), not noise. Toggle with LIQMAP_ADAPTIVE_LEV=0; tune LIQMAP_LEV_K.
// Default OFF (=== '1' opt-in) — fixed Coinglass-style leverage cohorts (5/10/25/50/100x)
// matched the FA bot's heatmap better than vol-adaptive bands. Set LIQMAP_ADAPTIVE_LEV=1
// to re-enable the realized-vol-scaled leverage distribution.
const LIQMAP_ADAPTIVE_LEV = process.env.LIQMAP_ADAPTIVE_LEV === '1';
const LIQMAP_LEV_K = Number(process.env.LIQMAP_LEV_K) || 50;
const LEV_TIERS = [3, 5, 10, 25, 50, 100];   // liq distance ≈ 1/lev → 33/20/10/4/2/1%

export function adaptiveLeverages(volPct, { tiers = LEV_TIERS, k = LIQMAP_LEV_K, spread = 0.85 } = {}) {
  const v = Math.max(0.4, Math.min(20, Number(volPct) || 4));
  const peak = Math.max(2, Math.min(100, k / v));     // comfortable leverage given the vol
  const lnPeak = Math.log(peak);
  const raw = tiers.map(lev => {
    const d = Math.log(lev) - lnPeak;                 // log-distance from the peak
    return { lev, w: Math.exp(-(d * d) / (2 * spread * spread)) };
  });
  const sum0 = raw.reduce((s, t) => s + t.w, 0) || 1;
  // Drop negligible tiers (e.g. 100x on a meme), THEN re-normalize the survivors
  // so the kept weights still sum to 1.
  const kept = raw.filter(t => t.w / sum0 >= 0.03);
  const sum = kept.reduce((s, t) => s + t.w, 0) || 1;
  return kept.map(t => ({ lev: t.lev, weight: t.w / sum }));
}

// Median per-candle range % — a robust realized-volatility proxy for the leverage
// model (insensitive to the odd huge bar that a mean would chase).
export function realizedVolPct(candles) {
  const r = [];
  for (const c of candles ?? []) if (c.h > 0 && c.l > 0 && c.c > 0) r.push((c.h - c.l) / c.c * 100);
  if (!r.length) return 4;
  r.sort((a, b) => a - b);
  return r[Math.floor(r.length / 2)];
}
// Cap the mapped range. 250% pulled in far, stale, phantom levels (a trader
// flagged a "36M short liq" cluster that didn't exist) — Coinglass focuses on
// the ACTIONABLE band. 80% keeps real squeeze magnets without the noise.
const MAX_DIST_PCT = Number(process.env.LIQMAP_MAX_DIST_PCT) || 80;

// RECENCY weighting. A position opened 100 days ago is far more likely to have
// been closed, rolled, or already de-risked than one opened yesterday — so its
// liquidation level is less "live". Coinglass-style maps lean on recent OI builds.
// Weight each build by 2^(-ageFrac / halfLife), where ageFrac is 0 (newest) → 1
// (oldest across the window). halfLife = the window-fraction over which weight
// halves: 1.0 (default) = gentle (the oldest build counts ~0.5×, recent ~1×);
// smaller = sharper recency focus. 0 disables (every build weighted equally, the
// prior behaviour). Tunable with LIQMAP_RECENCY_HL.
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

// Pure, unit-testable. candles ascending [{ t, o, h, l, c }]; oiByTs/lsByTs are
// Map(t → number). oi in USD; ls = long/short ratio.
export function computeLiquidationHeatmap(candles, oiByTs, lsByTs, {
  currentPrice = null, leverages = LEV_BRACKETS, mmr = MMR, binPct = BIN_PCT, maxDistPct = MAX_DIST_PCT, topN = 14,
  recencyHalfLife = LIQMAP_RECENCY_HL
} = {}) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const cur = currentPrice && currentPrice > 0 ? currentPrice : candles[n - 1].c;
  if (!(cur > 0)) return null;

  // Running min-low / max-high AFTER each candle — for the survival check.
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
    if (dOi <= 0) continue;               // only NEW positions add liquidation levels

    const openPx = c.c;
    if (!(openPx > 0)) continue;

    // Long/short split.
    const ls = lsByTs.get(c.t);
    let longFrac;
    if (ls != null && isFinite(ls) && ls > 0) longFrac = ls / (1 + ls);   // ls = long/short
    else longFrac = c.c >= c.o ? 0.55 : 0.45;                              // up candle → more longs
    // Recency weight: down-weight old builds (likely already closed/rolled) so the
    // map reflects LIVE positioning, like Coinglass. ageFrac 0=newest → 1=oldest.
    const ageFrac = n > 1 ? (n - 1 - i) / (n - 1) : 0;
    const recency = recencyHalfLife > 0 ? Math.pow(2, -ageFrac / recencyHalfLife) : 1;
    const newLong = dOi * longFrac * recency, newShort = dOi * (1 - longFrac) * recency;

    // Lowest/highest price reached AFTER this candle (plus the live edge).
    const afterLow = Math.min(i + 1 < n ? suffMinLow[i + 1] : cur, cur);
    const afterHigh = Math.max(i + 1 < n ? suffMaxHigh[i + 1] : cur, cur);

    for (const { lev, weight } of leverages) {
      const liqLong = openPx * (1 - 1 / lev + mmr);     // below open
      if (liqLong < openPx && afterLow > liqLong) addBin(longBins, liqLong, cur, newLong * weight, lev, binPct, maxDistPct);
      const liqShort = openPx * (1 + 1 / lev - mmr);    // above open
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
    longLiqs: L.clusters,           // below price — long liquidations (downside flush magnets)
    shortLiqs: S.clusters,          // above price — short liquidations (upside squeeze magnets)
    totalLongUsd: Number(L.total.toFixed(2)),
    totalShortUsd: Number(S.total.toFixed(2)),
  };
}

// ── Liquidity-SWEEP detection (the "take liquidity both sides" pattern) ──────
// Price runs up to take the liquidity ABOVE (sweeping a short-liquidation cluster),
// then reverses to hunt the liquidity BELOW (the long-liquidation cluster), and
// vice-versa. The heatmap's own survival check already REMOVES a level once price
// trades through it, so a sweep shows up as: a sizable cluster that existed in the
// PRIOR snapshot, whose price level the CURRENT price has since reached, that is now
// gone (or shrunk past `shrinkFrac`) from the new snapshot. The fade target is the
// largest surviving cluster on the OPPOSITE side. Pure + exported for tests.
//
// Returns { side:'up'|'down', fadeSide:'SHORT'|'LONG', sweptPrice, sweptUsd,
//   targetPrice, targetUsd, targetDistPct } or null. side 'up' = highs swept → fade
// SHORT toward the long-liq cluster below; 'down' = lows swept → fade LONG toward the
// short-liq cluster above. Picks the larger side when price somehow swept both.
export function detectLiquiditySweep(prevMap, newMap, { minClusterUsd = 1_000_000, shrinkFrac = 0.5, tagTolerancePct = 0.3 } = {}) {
  if (!prevMap || !newMap) return null;
  const cur = Number(newMap.currentPrice);
  if (!(cur > 0)) return null;

  // Is a prior cluster at `price` ($prevUsd) still present in `clusters` (within
  // tolerance, not shrunk past shrinkFrac)? Absent/shrunk → it was swept.
  const survived = (clusters, price, prevUsd) => {
    for (const c of clusters ?? []) {
      if (price > 0 && Math.abs((c.price - price) / price) * 100 <= tagTolerancePct) {
        return (c.notionalUsd ?? 0) >= prevUsd * shrinkFrac;
      }
    }
    return false;
  };

  // UP sweep: a prior SHORT-liq cluster ABOVE that price has since reached, now gone.
  let up = null;
  for (const c of prevMap.shortLiqs ?? []) {
    if ((c.notionalUsd ?? 0) < minClusterUsd || !(c.price > 0)) continue;
    if (cur >= c.price * (1 - tagTolerancePct / 100) && !survived(newMap.shortLiqs, c.price, c.notionalUsd)) {
      if (!up || c.notionalUsd > up.sweptUsd) up = { sweptPrice: c.price, sweptUsd: c.notionalUsd };
    }
  }
  // DOWN sweep: a prior LONG-liq cluster BELOW that price has since reached, now gone.
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

  // Fade target = largest surviving cluster on the OPPOSITE side, beyond price.
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
    // 4-hour candles over 120 days = 720 points (vs 180 daily): 4× finer price
    // resolution so OI builds map to the RIGHT level instead of smearing onto a
    // single daily close (the source of phantom clusters). Same 1 API call.
    this.intervalDays = intervalDays;
    this.interval = interval;
    this.verbose = verbose;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();   // SYMBOL → { ts, map }
    // Liquidity-sweep events keyed by symbol → { ...sweep, ts }. Detected by
    // comparing each fresh recompute to the prior snapshot (see detectLiquiditySweep).
    this.sweeps = new Map();
    this.sweepMinUsd = Number(process.env.LIQ_SWEEP_MIN_USD) || 1_000_000;
    // Multi-market OI aggregation: sum open interest across the token's perp markets
    // on EVERY exchange Coinalyze covers (Binance + Bybit + OKX + …) instead of the
    // single first-listed market, so a magnet reflects TOTAL leverage. Price candles
    // + L/S stay on the primary market (prices track across venues). Costs +1 per
    // extra market on the shared Coinalyze budget. LIQMAP_AGG_MARKETS=0 disables.
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
    const interval = this.interval;   // 4h (finer) by default — see constructor

    // OI is summed across EVERY exchange's perp for this token (total leverage);
    // price candles + L/S come from the primary market. Falls back to the single
    // primary perp if the market lookup fails or only one venue lists it.
    let oiSyms = [perp];
    if (this.aggMarkets && this.coinalyze.perpMarketsFor) {
      try {
        const all = await this.coinalyze.perpMarketsFor(sym, this.aggMax);
        if (all?.length) oiSyms = [perp, ...all.filter(s => s && s !== perp)].slice(0, this.aggMax);
      } catch { /* keep single */ }
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

    // SUM open interest across every returned market, per timestamp (USD OI, so
    // cross-venue addition is meaningful). One series → identical to the old behaviour.
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

    // Freshest current price (Bybit live) if available, else last candle close.
    let currentPrice = candles[candles.length - 1].c;
    if (this.taService?.getLastPerpPrice) {
      try { const p = await this.taService.getLastPerpPrice(sym); if (p > 0) currentPrice = p; } catch { /* keep close */ }
    }

    // Leverage distribution adapted to THIS token's realized volatility (so a
    // meme that swings 10%/bar doesn't get the same 100x@±1% band as BTC).
    const volPct = realizedVolPct(candles);
    const leverages = LIQMAP_ADAPTIVE_LEV ? adaptiveLeverages(volPct) : undefined;
    const map = computeLiquidationHeatmap(candles, oiByTs, lsByTs, { currentPrice, leverages });
    if (map) {
      map.symbol = sym; map.windowDays = this.intervalDays;
      map.volPct = Number(volPct.toFixed(2));
      map.oiMarkets = oiMarkets;     // how many exchanges' OI was aggregated into this map
      if (leverages) map.levProfile = leverages.map(l => `${l.lev}x:${Math.round(l.weight * 100)}%`).join(' ');
      // Detect a liquidity sweep vs the PRIOR snapshot before overwriting it. Only
      // genuine recomputes reach here (the 5-min cache gates re-fetch), so the prior
      // map is at least a few minutes old, enough for a sweep to have happened.
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

  // Most recent liquidity-sweep event for a symbol, if fresher than maxAgeMs.
  // The Conductor reads this synchronously in the scoring path to bias a fade.
  recentSweep(symbol, maxAgeMs = 30 * 60_000) {
    const s = this.sweeps.get((symbol ?? '').toUpperCase());
    if (!s || (Date.now() - s.ts) > maxAgeMs) return null;
    return s;
  }

  // SYNCHRONOUS cache read — no network. The Conductor uses this in the hot
  // scoring path so incorporating the heatmap adds ZERO Coinalyze load (the
  // 180-day compute is heavy + the budget is shared). Returns the cached map or
  // null. Tolerates a staler passive read than /liqmap (zones move slowly).
  peek(symbol) {
    const c = this.cache.get((symbol ?? '').toUpperCase());
    if (!c || (Date.now() - c.ts) > this.cacheTtlMs * 4) return null;
    return c.map;
  }

  // Fire-time fetch: return the cached heatmap instantly, else compute it
  // on-demand BUT race it against a hard timeout so a slow/rate-gated fetch can
  // NEVER materially delay a signal (returns null → the magnet is simply skipped,
  // fail-open). On the dedicated liq key the 3 fetches run in parallel (~one
  // round-trip), so the typical cost is small; the cache makes re-fires instant.
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

  // Bounded background warm: compute heatmaps for up to `cap` of the given
  // symbols that aren't already fresh, so the Conductor's peek() has data for
  // the tokens that actually matter (hot movers / funding leaders). Sequential
  // with a breather to stay gentle on the shared Coinalyze rate budget.
  async warm(symbols, cap = 8) {
    let done = 0;
    for (const s of symbols ?? []) {
      if (done >= cap) break;
      const sym = (s ?? '').toUpperCase();
      const c = this.cache.get(sym);
      if (c && (Date.now() - c.ts) < this.cacheTtlMs) continue;   // already fresh
      try { if (await this.compute(sym)) done++; } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 500));
    }
    return done;
  }
}
