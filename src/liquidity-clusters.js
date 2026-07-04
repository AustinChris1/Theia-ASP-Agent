// Liquidity cluster discovery — free, self-aggregated heatmap data.
//
// Why this exists: CoinGlass / Hyblock / Tensorcharts heatmaps are all
// paid. But the underlying signal (where market makers stack orders,
// where stops get hunted) can be derived directly from public exchange
// orderbook depth, which IS free.
//
// What we do:
//   1. Fetch L2 depth for a perp symbol from Binance AND Bybit in parallel
//      (both via the Singapore relay), falling back to OKX if neither covers
//      the token.
//   2. Bucket bids/asks into 0.5% price buckets relative to each venue's mid,
//      then MERGE across venues — a wall confirmed on both venues is weighted
//      up; a single-venue wall (likely spoof) is weighted down.
//   3. Return buckets ranked by confirmation-weighted size — the densest,
//      most-confirmed buckets are the "liquidity clusters" / heatmap walls.
//
// This complements the existing `#getLiquidationClusters` in conductor.js,
// which derives clusters from RECENT LIQUIDATIONS (where leverage was just
// wiped). Orderbook-derived clusters are PROSPECTIVE — where the next wipe
// is likely to happen. Together they give a view very similar to what the
// commercial heatmap products show.
//
// Sources tried (in order):
//   • Bybit  /v5/market/orderbook         (linear perps, no auth, 500 depth)
//   • OKX    /api/v5/market/books         (swap perps, no auth, 400 depth)
//   • Binance /fapi/v1/depth              (futures, no auth, 1000 depth)
//
// Each call returns within ~200ms in production. We cache results for
// 60s — clusters don't shift faster than that for normal-sized tokens.

const FETCH_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 60_000;
const BUCKET_PCT = 0.5;          // 0.5% wide buckets
const DEPTH_LIMIT = 500;         // Bybit linear max; deeper book → far walls visible
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
  constructor({ perpSymbolMap, verbose = false, relayBaseUrl = null, relayAuthSecret = null }) {
    this.perpSymbolMap = perpSymbolMap;
    this.verbose = verbose;
    // Singapore relay for Binance depth. Binance has the DEEPEST free book
    // (1000 levels) — the best heatmap source — but is geo-blocked on some
    // VPS IPs. With the relay configured we prefer Binance; otherwise it's the
    // last fallback (direct, usually blocked).
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.cache = new Map();      // SYMBOL → { ts, clusters }
    this.pending = new Map();    // SYMBOL → in-flight Promise
  }

  // One-shot reachability test. Called at startup so the user sees in the
  // boot log whether Bybit/OKX/Binance orderbook depth is actually reachable
  // from this VPS. Without this, the heatmap could silently never fire and
  // you wouldn't know which provider (if any) is being blocked.
  async selfTest() {
    const r = await this.#fetchClusters('BTC');
    if (r && (r.askClusters.length > 0 || r.bidClusters.length > 0)) {
      const totalAsk = r.askClusters.reduce((s, c) => s + c.sizeUsd, 0);
      const totalBid = r.bidClusters.reduce((s, c) => s + c.sizeUsd, 0);
      console.log(`[liq-clusters] self-test OK via ${r.source} — BTC mid $${r.mid.toFixed(0)}, ${r.askClusters.length} ask clusters ($${(totalAsk/1e6).toFixed(1)}M total), ${r.bidClusters.length} bid clusters ($${(totalBid/1e6).toFixed(1)}M)`);
      return true;
    }
    console.warn('[liq-clusters] self-test FAILED — Bybit/OKX/Binance orderbook depth unreachable from this host. Heatmap scoring will silently skip.');
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
    // Aggregate the two deepest venues we can reach — Binance (deepest book,
    // leads price) + Bybit (your actual execution venue) — both via the relay,
    // fetched in PARALLEL. Cross-confirmation between them is a free spoof
    // filter (see aggregateOrderbookClusters). OKX is a last-resort fallback
    // only when neither primary returns a usable book (token coverage).
    const [binance, bybit] = await Promise.all([
      this.#fetchBinance(sym).catch(() => null),
      this.#fetchBybit(sym).catch(() => null)
    ]);
    let result = aggregateOrderbookClusters([binance, bybit]);
    if (!result) {
      const okx = await this.#fetchOkx(sym).catch(() => null);
      result = aggregateOrderbookClusters([okx]);
    }
    return result;
  }

  // ── Provider fetchers — all return { bids, asks, source } or null ────

  async #fetchBybit(sym) {
    const perp = this.perpSymbolMap?.get(sym);
    if (!perp) return null;
    // perpSymbolMap stores formats like "BYBIT_USDT_BTC" or "BTCUSDT" depending
    // on how it was built. Try the Bybit-native form first; if our map gives
    // us a vendor-prefixed code, fall back to symbol+USDT.
    const bybitSym = /^[A-Z0-9]+USDT$/.test(perp) ? perp : `${sym}USDT`;
    const path = `/v5/market/orderbook?category=linear&symbol=${bybitSym}&limit=${DEPTH_LIMIT}`;
    // Route through the Singapore relay when configured — Bybit is geo-blocked
    // on the US VPS just like Binance (the relay proxies /relay/* → Bybit).
    const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
    const opts = { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      const j = await res.json();
      if (j.relayError) return null;     // relay reported an upstream failure
      if (j.retCode !== 0 || !j.result) return null;
      return { bids: j.result.b ?? [], asks: j.result.a ?? [], source: 'bybit' };
    } catch (err) {
      if (this.verbose) console.warn(`[liq-clusters] bybit ${sym}: ${err.message}`);
      return null;
    }
  }

  async #fetchOkx(sym) {
    const okxSym = `${sym}-USDT-SWAP`;
    try {
      const url = `https://www.okx.com/api/v5/market/books?instId=${okxSym}&sz=400`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const j = await res.json();
      const book = j.data?.[0];
      if (!book) return null;
      // OKX rows are [price, size, ?, count]; we only need [0],[1]
      return { bids: book.bids ?? [], asks: book.asks ?? [], source: 'okx' };
    } catch (err) {
      if (this.verbose) console.warn(`[liq-clusters] okx ${sym}: ${err.message}`);
      return null;
    }
  }

  async #fetchBinance(sym) {
    const binSym = `${sym}USDT`;
    // 1000 levels = the deepest free book (best heatmap). Routed through the
    // Singapore relay when configured (relayBase/binance/...), else direct.
    const path = `/fapi/v1/depth?symbol=${binSym}&limit=1000`;
    const url = this.relayBaseUrl ? `${this.relayBaseUrl}/binance${path}` : `https://fapi.binance.com${path}`;
    const opts = { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      const j = await res.json();
      if (j.relayError) return null;     // relay reported an upstream failure
      return { bids: j.bids ?? [], asks: j.asks ?? [], source: this.relayBaseUrl ? 'binance/relay' : 'binance' };
    } catch (err) {
      if (this.verbose) console.warn(`[liq-clusters] binance ${sym}: ${err.message}`);
      return null;
    }
  }
}
