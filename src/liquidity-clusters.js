

const FETCH_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 60_000;
const BUCKET_PCT = 0.5;
const SCORE_DIST_PCT = 10;
const WIDE_DIST_PCT = 100;

export function aggregateOrderbookClusters(books, { bucketPct = BUCKET_PCT, confirmBoost = 1.4, soloDiscount = 0.6 } = {}) {
  const usable = (books ?? []).filter(b => b?.bids?.length && b?.asks?.length);
  if (usable.length === 0) return null;

  const rawBuckets = (levels, mid, sign) => {
    const m = new Map();
    for (const [pStr, sStr] of levels) {
      const price = Number(pStr), size = Number(sStr);
      if (!isFinite(price) || !isFinite(size) || price <= 0 || size <= 0) continue;
      const distPct = ((price - mid) / mid) * 100;
      if (Math.abs(distPct) > WIDE_DIST_PCT) continue;
      if (sign > 0 && distPct < 0) continue;
      if (sign < 0 && distPct > 0) continue;
      const idx = Math.round(distPct / bucketPct);
      const b = m.get(idx) ?? { sizeUsd: 0, count: 0 };
      b.sizeUsd += price * size; b.count += 1;
      m.set(idx, b);
    }
    return m;
  };

  let midSum = 0, midN = 0;
  const askMaps = [], bidMaps = [], sources = [];
  for (const book of usable) {
    const mid = (Number(book.bids[0][0]) + Number(book.asks[0][0])) / 2;
    if (!isFinite(mid) || mid <= 0) continue;
    midSum += mid; midN += 1;
    sources.push(book.source ?? 'venue');
    askMaps.push(rawBuckets(book.asks, mid, +1));
    bidMaps.push(rawBuckets(book.bids, mid, -1));
  }
  if (midN === 0) return null;
  const mid = midSum / midN;
  const venuesAvailable = midN;

  const mergeSide = (maps) => {
    const idxs = new Set();
    for (const m of maps) for (const k of m.keys()) idxs.add(k);
    const out = [];
    for (const idx of idxs) {
      let rawUsd = 0, venues = 0, levels = 0;
      for (const m of maps) {
        const b = m.get(idx);
        if (b?.sizeUsd > 0) { rawUsd += b.sizeUsd; venues += 1; levels += b.count; }
      }
      if (rawUsd <= 0) continue;

      const weight = venuesAvailable >= 2 ? (venues >= 2 ? confirmBoost : soloDiscount) : 1;
      const distancePct = idx * bucketPct;
      out.push({
        midPrice: mid * (1 + distancePct / 100),
        distancePct,
        sizeUsd: rawUsd * weight,
        rawUsd,
        venues, levels
      });
    }
    out.sort((a, b) => b.sizeUsd - a.sizeUsd);
    return out.slice(0, 40);
  };

  const askAll = mergeSide(askMaps), bidAll = mergeSide(bidMaps);
  const near = (arr) => arr.filter(c => Math.abs(c.distancePct) <= SCORE_DIST_PCT).slice(0, 10);

  return {
    mid,
    askClusters: near(askAll),
    bidClusters: near(bidAll),
    askClustersWide: askAll,
    bidClustersWide: bidAll,
    source: sources.length > 1 ? [...new Set(sources)].join('+') : (sources[0] ?? 'none'),
    venuesAvailable
  };
}

export class LiquidityClusters {
  constructor({ perpSymbolMap, verbose = false, okx = null }) {
    this.perpSymbolMap = perpSymbolMap;
    this.verbose = verbose;
    this.okx = okx;
    this.cache = new Map();
    this.pending = new Map();
  }

  async selfTest() {
    const r = await this.#fetchClusters('BTC');
    if (r && (r.askClusters.length > 0 || r.bidClusters.length > 0)) {
      const totalAsk = r.askClusters.reduce((s, c) => s + c.sizeUsd, 0);
      const totalBid = r.bidClusters.reduce((s, c) => s + c.sizeUsd, 0);
      console.log(`[liq-clusters] self-test OK via ${r.source} — BTC mid $${r.mid.toFixed(0)}, ${r.askClusters.length} ask clusters ($${(totalAsk/1e6).toFixed(1)}M total), ${r.bidClusters.length} bid clusters ($${(totalBid/1e6).toFixed(1)}M)`);
      return true;
    }
    console.warn('[liq-clusters] self-test FAILED — OKX orderbook depth unreachable from this host. Heatmap scoring will silently skip.');
    return false;
  }

  async getClusters(symbol) {
    const sym = (symbol ?? '').toUpperCase();
    const cached = this.cache.get(sym);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.clusters;
    if (this.pending.has(sym)) return this.pending.get(sym);

    const promise = this.#fetchClusters(sym);
    this.pending.set(sym, promise);
    try {
      const clusters = await promise;
      if (clusters) this.cache.set(sym, { ts: Date.now(), clusters });
      return clusters;
    } finally {
      this.pending.delete(sym);
    }
  }

  async #fetchClusters(sym) {

    const okx = await this.#fetchOkx(sym).catch(() => null);
    return aggregateOrderbookClusters([okx]);
  }

  async #fetchOkx(sym) {
    if (!this.okx) return null;
    const okxSym = `${sym}-USDT-SWAP`;
    try {
      const book = await this.okx.getOrderbook(okxSym, 400);
      if (!book) return null;

      return { bids: book.bids ?? [], asks: book.asks ?? [], source: 'okx' };
    } catch (err) {
      if (this.verbose) console.warn(`[liq-clusters] okx ${sym}: ${err.message}`);
      return null;
    }
  }
}
