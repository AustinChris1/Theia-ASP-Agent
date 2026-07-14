// Liquidity cluster discovery — free, self-aggregated heatmap data.
//
// Why this exists: CoinGlass / Hyblock / Tensorcharts heatmaps are all
// paid. But the underlying signal (where market makers stack orders,
// where stops get hunted) can be derived directly from public exchange
// orderbook depth, which IS free.
//
// What we do:
//   1. Fetch L2 depth for a perp symbol from OKX (/api/v5/market/books).
//   2. Bucket bids/asks into 0.5% price buckets relative to mid.
//   3. Return buckets ranked by size — the densest are the "liquidity clusters".
//
// This complements the existing `#getLiquidationClusters` in conductor.js,
// which derives clusters from RECENT LIQUIDATIONS (where leverage was just
// wiped). Orderbook-derived clusters are PROSPECTIVE — where the next wipe
// is likely to happen.

const FETCH_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 60_000;
const BUCKET_PCT = 0.5;          // 0.5% wide buckets
const SCORE_DIST_PCT = 10;       // near band kept for trade SCORING (unchanged)
const WIDE_DIST_PCT = 100;       // far band kept for the /heatmap DISPLAY only

// Merge L2 books from one or more venues into a CROSS-CONFIRMED heatmap.
// Each wall (a 0.5% price bucket, keyed by distance-from-mid so venues with
// slightly different mids still align) sums its size across venues. When ≥2
// venues were reachable, a wall confirmed on BOTH is weighted UP and a wall
// present on only ONE venue (likely a spoof / pulled order) is weighted DOWN —
// a free manipulation filter, which is the whole point of looking at more than
// one exchange. `sizeUsd` is the confirmation-weighted size the conductor SCORES
// on; `rawUsd` is the literal combined book size (for honest display). Returns
// null when no venue produced a usable two-sided book.
export function aggregateOrderbookClusters(books, { bucketPct = BUCKET_PCT, confirmBoost = 1.4, soloDiscount = 0.6 } = {}) {
  const usable = (books ?? []).filter(b => b?.bids?.length && b?.asks?.length);
  if (usable.length === 0) return null;

  const rawBuckets = (levels, mid, sign) => {
    const m = new Map();
    for (const [pStr, sStr] of levels) {
      const price = Number(pStr), size = Number(sStr);
      if (!isFinite(price) || !isFinite(size) || price <= 0 || size <= 0) continue;
      const distPct = ((price - mid) / mid) * 100;
      if (Math.abs(distPct) > WIDE_DIST_PCT) continue; // keep a wide band for display
      if (sign > 0 && distPct < 0) continue;          // asks above mid only
      if (sign < 0 && distPct > 0) continue;          // bids below mid only
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
      // Confirmation weight only applies when ≥2 venues were reachable — a token
      // that only one venue covers isn't penalised for being single-source.
      const weight = venuesAvailable >= 2 ? (venues >= 2 ? confirmBoost : soloDiscount) : 1;
      const distancePct = idx * bucketPct;
      out.push({
        midPrice: mid * (1 + distancePct / 100),
        distancePct,
        sizeUsd: rawUsd * weight,   // confirmation-weighted (scored)
        rawUsd,                     // literal combined book size (displayed)
        venues, levels
      });
    }
    out.sort((a, b) => b.sizeUsd - a.sizeUsd);
    return out.slice(0, 40);     // top 40 by size across the wide band
  };

  // The NEAR band (≤ SCORE_DIST_PCT) drives trade scoring — unchanged top-10.
  // The full WIDE band is kept separately so /heatmap can show far walls without
  // affecting the conductor (which only scores the 2–8% band).
  const askAll = mergeSide(askMaps), bidAll = mergeSide(bidMaps);
  const near = (arr) => arr.filter(c => Math.abs(c.distancePct) <= SCORE_DIST_PCT).slice(0, 10);

  return {
    mid,
    askClusters: near(askAll),
    bidClusters: near(bidAll),
    askClustersWide: askAll,        // for display (up to ±WIDE_DIST_PCT)
    bidClustersWide: bidAll,
    source: sources.length > 1 ? [...new Set(sources)].join('+') : (sources[0] ?? 'none'),
    venuesAvailable
  };
}

export class LiquidityClusters {
  constructor({ perpSymbolMap, verbose = false, okx = null }) {
    this.perpSymbolMap = perpSymbolMap;
    this.verbose = verbose;
    this.okx = okx;              // OKX v5 client — the orderbook depth source
    this.cache = new Map();      // SYMBOL → { ts, clusters }
    this.pending = new Map();    // SYMBOL → in-flight Promise
  }

  // One-shot reachability test. Called at startup so the user sees in the
  // boot log whether OKX orderbook depth is actually reachable
  // from this host. Without this, the heatmap could silently never fire and
  // you wouldn't know which provider (if any) is being blocked.
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

  // Returns clusters for `symbol` (e.g. "BTC"), or null if no provider had
  // an orderbook for the perp. Result shape:
  //   {
  //     mid:        2380.5,
  //     askClusters: [{ midPrice, distancePct, sizeUsd }, ...],  // above mid
  //     bidClusters: [{ midPrice, distancePct, sizeUsd }, ...]   // below mid
  //   }
  // distancePct is signed (+ above mid, - below). Both arrays are sorted
  // by sizeUsd descending — first entry is the strongest magnet.
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
    // OKX orderbook depth only — on-brand, no competitor exchanges.
    const okx = await this.#fetchOkx(sym).catch(() => null);
    return aggregateOrderbookClusters([okx]);
  }

  // ── Provider fetcher — OKX orderbook only ────
  async #fetchOkx(sym) {
    if (!this.okx) return null;
    const okxSym = `${sym}-USDT-SWAP`;
    try {
      const book = await this.okx.getOrderbook(okxSym, 400);
      if (!book) return null;
      // OKX rows are [price, size, ?, count]; we only need [0],[1]
      return { bids: book.bids ?? [], asks: book.asks ?? [], source: 'okx' };
    } catch (err) {
      if (this.verbose) console.warn(`[liq-clusters] okx ${sym}: ${err.message}`);
      return null;
    }
  }
}
