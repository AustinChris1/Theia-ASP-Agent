import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Polls Coinalyze /liquidation-history every N minutes for a curated list of
// perp symbols. Emits 'liquidation' events when liquidation USD in a 1-minute
// bucket exceeds the threshold.
//
// Liquidation interpretation:
//   • Longs liquidated  → price dropped sharply, forced selling → may cascade
//                          OR be capitulation bottom.
//                          Squeeze direction is DOWN (short bias).
//   • Shorts liquidated → price rose sharply, forced buying → short squeeze.
//                          Squeeze direction is UP (long bias).
//
// Each Coinalyze history point typically returns:
//   { t: <unix-seconds>, l: <long-liq-USD>, s: <short-liq-USD> }
// We emit at the per-minute bucket level and dedupe by (symbol, t).

// Pure, exported for tests. Decide whether a 1-minute liquidation bucket is
// SIGNIFICANT. A flat USD threshold is the wrong model: $50K wipes nothing on ETH
// (OI ~$10B) but is violent on a $20M-OI micro-cap. So the primary signal is the
// liquidation as a FRACTION OF OPEN INTEREST (a price-impact proxy), with a dust
// floor and an absolute always-fire ceiling that also serves as the OI-unknown
// fallback.
//   • below minFloorUsd   → never        (dust)
//   • liq / OI >= oiPct    → fire 'oi%'   (scale-invariant — the real signal)
//   • liq >= absUsd        → fire 'abs'   (absolutely huge, OR OI unavailable)
export function liquidationSignificance({ totalUsd, oiUsd = 0, minFloorUsd = 25_000, oiPct = 0.0001, absUsd = 0 }) {
  const oiFrac = oiUsd > 0 ? totalUsd / oiUsd : null;
  if (!(totalUsd >= minFloorUsd)) return { fire: false, basis: 'dust', oiFrac };
  if (oiFrac !== null && oiPct > 0 && oiFrac >= oiPct) return { fire: true, basis: 'oi%', oiFrac };
  if (absUsd > 0 && totalUsd >= absUsd) return { fire: true, basis: 'abs', oiFrac };
  return { fire: false, basis: oiFrac !== null ? 'below' : 'no-oi', oiFrac };
}

export class LiquidationMonitor extends EventEmitter {
  constructor({ coinalyze, perpSymbolMap, pollIntervalMs = 120_000, minLiquidationUsd = 500_000, batchSize = 20, lookbackSec = 600, oiPct = 0.0001, minFloorUsd = 25_000, oiTtlMs = 30 * 60_000, oiOnly = false }) {
    super();
    this.coinalyze = coinalyze;
    this.perpSymbolMap = perpSymbolMap;   // TOKEN_SYMBOL → coinalyze perp symbol
    // OI-only mode: keep refreshing OI (so getOiUsd serves the Bybit poller's
    // significance model) but DON'T poll/emit Coinalyze liquidations — Bybit is the
    // real source and double-emitting would duplicate alerts.
    this.oiOnly = oiOnly;
    this.pollIntervalMs = pollIntervalMs;
    this.minLiquidationUsd = minLiquidationUsd;   // absolute always-fire + OI-unknown fallback
    this.oiPct = oiPct;                           // liq/OI fraction that counts as significant (0.0001 = 0.01%)
    this.minFloorUsd = minFloorUsd;               // dust floor — never alert below this regardless of OI%
    this.oiTtlMs = oiTtlMs;                       // re-fetch OI at most this often (it moves slowly)
    this.oiByPerp = new Map();                    // perp symbol → current OI in USD
    this.oiFetchedAt = 0;
    this.batchSize = batchSize;
    // The lookback window MUST comfortably exceed the EFFECTIVE poll interval.
    // Two things stretch the effective interval well past pollIntervalMs:
    //   1. Coinalyze populates 1-min buckets 1-2 min LATE.
    //   2. Under shared-rate-budget contention the poll runs > pollIntervalMs,
    //      so the re-entrancy guard SKIPS ticks → effective interval can be 2-3×.
    // If lookback ≈ effective interval, the lagged buckets fall in the gap and
    // are NEVER queried — exactly why a real $963k ETH 1-min liquidation didn't
    // alert. A WIDE lookback is essentially FREE: it's a time-range parameter,
    // not extra API calls, and the per-(symbol,minute) dedup prevents any double
    // alert. So cover ~4 poll intervals so even 2-3 skipped ticks can't drop a
    // bucket. Min 20 min.
    const pollSec = Math.ceil(pollIntervalMs / 1000);
    this.lookbackSec = Math.max(lookbackSec, 4 * pollSec + 120, 1200);
    this.seen = new Map();                // `${symbol}|${t}` → ts processed
    this.intervalId = null;
  }

  async start() {
    if (this.perpSymbolMap.size === 0) {
      console.warn('[liquidations] no perp symbols mapped — disabled');
      return;
    }
    if (this.oiOnly) {
      console.log(`[liquidations] OI-only mode — refreshing OI for ${this.perpSymbolMap.size} symbols every ${Math.round(this.oiTtlMs / 60000)}min (Bybit is the liquidation source); not polling/emitting Coinalyze liquidations`);
    } else {
      console.log(`[liquidations] polling Coinalyze every ${this.pollIntervalMs/1000}s (lookback ${this.lookbackSec}s) for ${this.perpSymbolMap.size} symbols — significance: ≥${(this.oiPct * 100).toFixed(3)}% of OI OR ≥$${this.minLiquidationUsd.toLocaleString()} abs (dust floor $${this.minFloorUsd.toLocaleString()})`);
    }
    // Non-blocking first poll so boot completes immediately
    this.#poll().catch(err => console.error('[liquidations] initial poll err:', err.message));
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.error('[liquidations] poll err:', err.message));
    }, this.pollIntervalMs);
  }

  async #poll() {
    // Re-entrancy guard: a slow poll (Coinalyze rate-gated behind funding/TA/OI
    // on the shared 20/min client) can run longer than pollIntervalMs. Without
    // this, setInterval stacks overlapping polls that re-query the same window,
    // compounding the rate pressure and starving each other — a key reason
    // liquidations went quiet under contention. Skip the tick if one's running.
    if (this._polling) {
      console.warn('[liquidations] previous poll still running — skipping this tick');
      return;
    }
    this._polling = true;
    try {
      // Build reverse map perpSymbol → tokenSymbol for emit
      const reverse = new Map();
      for (const [token, perp] of this.perpSymbolMap.entries()) reverse.set(perp, token);

      const perpSymbols = [...this.perpSymbolMap.values()];
      await this.#refreshOi(perpSymbols);   // OI for significance — cached, slow-moving
      if (this.oiOnly) return;              // OI provider only — Bybit emits the liquidations
      const now = Math.floor(Date.now() / 1000);
      const from = now - this.lookbackSec;

      let processed = 0;
      let emitted = 0;
      for (let i = 0; i < perpSymbols.length; i += this.batchSize) {
        const batch = perpSymbols.slice(i, i + this.batchSize);
        let data;
        try {
          data = await this.coinalyze.liquidationHistory(batch, '1min', from, now, 'true');
        } catch (err) {
          console.warn(`[liquidations] batch ${i/this.batchSize + 1} failed: ${err.message}`);
          continue;
        }
        for (const entry of data ?? []) {
          emitted += this.#processEntry(entry, reverse.get(entry.symbol));
          processed++;
        }
        await sleep(200); // small breather between batches
      }
      // Always log so user can confirm polls are completing even when no alerts fire
      console.log(`[liquidations] processed ${processed} symbols, emitted ${emitted} alerts`);
    } finally {
      this._polling = false;
    }
  }

  // OI moves slowly, so fetch at most every oiTtlMs and reuse the cache between
  // polls. On failure we keep the stale OI rather than blanking it (a transient
  // 429 shouldn't silently disable the OI% significance path). Coinalyze
  // /open-interest with convert_to_usd returns USD OI per perp as `entry.value`.
  async #refreshOi(perpSymbols) {
    if (this.oiByPerp.size && Date.now() - this.oiFetchedAt < this.oiTtlMs) return;
    let got = 0;
    for (let i = 0; i < perpSymbols.length; i += this.batchSize) {
      const batch = perpSymbols.slice(i, i + this.batchSize);
      try {
        const data = await this.coinalyze.openInterest(batch, 'true');
        for (const e of data ?? []) if (typeof e.value === 'number' && e.value > 0) { this.oiByPerp.set(e.symbol, e.value); got++; }
      } catch { /* keep stale OI */ }
      await sleep(200);
    }
    if (got) this.oiFetchedAt = Date.now();
  }

  // Token-keyed OI lookup so other liquidation sources (e.g. the Binance WS feed
  // on a clean-IP host) can reuse this cache for the same OI% significance model.
  getOiUsd(tokenSymbol) {
    const perp = this.perpSymbolMap.get(String(tokenSymbol).toUpperCase());
    const oi = perp ? this.oiByPerp.get(perp) : null;
    return (typeof oi === 'number' && oi > 0) ? oi : null;
  }

  #processEntry(entry, tokenSymbol) {
    if (!entry?.history?.length || !tokenSymbol) return 0;
    let emitted = 0;
    const cutoff = Date.now() - 24 * 60 * 60_000;

    for (const point of entry.history) {
      // Defensive: Coinalyze field names. Try common forms.
      const t = point.t ?? point.timestamp;
      if (!t) continue;
      const longLiq  = Number(point.l ?? point.long  ?? point.long_liquidations  ?? 0);
      const shortLiq = Number(point.s ?? point.short ?? point.short_liquidations ?? 0);
      const total = longLiq + shortLiq;

      // Significance by % of open interest (price-impact proxy), not flat USD.
      const oiUsd = this.oiByPerp.get(entry.symbol) ?? 0;
      const sig = liquidationSignificance({
        totalUsd: total, oiUsd,
        minFloorUsd: this.minFloorUsd, oiPct: this.oiPct, absUsd: this.minLiquidationUsd
      });
      if (!sig.fire) continue;

      const key = `${entry.symbol}|${t}`;
      if (this.seen.has(key)) continue;
      this.seen.set(key, Date.now());

      const dominantSide = longLiq > shortLiq ? 'longs' : 'shorts';
      const dominantUsd = Math.max(longLiq, shortLiq);
      // shorts wiped → upward pressure → LONG bias
      const bias = dominantSide === 'shorts' ? 'long' : 'short';

      this.emit('liquidation', {
        symbol: tokenSymbol,
        coinalyzeSymbol: entry.symbol,
        timestamp: t * 1000,
        longLiq, shortLiq, total,
        oiUsd, oiFrac: sig.oiFrac, basis: sig.basis,   // oiFrac = liq as fraction of OI
        dominantSide, dominantUsd,
        bias
      });
      emitted++;
    }

    // GC old seen entries
    for (const [k, v] of this.seen) if (v < cutoff) this.seen.delete(k);
    return emitted;
  }
}
