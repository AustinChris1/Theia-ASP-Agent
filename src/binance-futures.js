// Binance Futures funding + OI monitor.
//
// Why Binance: it's the source-of-truth venue for ~85% of perp volume, and the
// public REST endpoints don't require an API key:
//   GET /fapi/v1/premiumIndex   → funding rate + mark price for ALL ~500 perps
//   GET /fapi/v1/openInterest   → OI in base asset (multiply by markPrice for USD)
// Rate limit is 2400 requests/min — effectively unlimited for our use.
//
// Exposes the same `bySymbol` shape as the Coinalyze-backed FundingMonitor so
// describeFunding/oiScoreForSide/etc work without changes.
//
// Reachability note: Binance is geo-blocked in some regions (US/UK/etc.) at the
// ISP level, but data-center IPs (VPS hosts) almost never get blocked. We
// `probe()` once at startup and fall back to Coinalyze if unreachable.

import { EventEmitter } from 'node:events';

const FAPI = 'https://fapi.binance.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class BinanceFuturesMonitor extends EventEmitter {
  constructor({ universe, pollIntervalMs = 5 * 60_000, oiConcurrency = 20, relayBaseUrl = null, relayAuthSecret = null }) {
    super();
    this.universe = universe;
    this.pollIntervalMs = pollIntervalMs;
    this.oiConcurrency = oiConcurrency;
    this.bySymbol = new Map();           // TOKEN_SYM → { rates, summary }
    this.intervalId = null;
    // Singapore relay fallback (audit / user request): when the VPS IP is
    // geo-blocked from Binance directly, route the PUBLIC futures-data calls
    // through the Vercel Singapore relay (same one used for Bybit trading).
    // relayBaseUrl is the relay's "/relay" base; we append "/binance/<path>".
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.useRelay = false;               // decided by probe()
  }

  getByCgId(cgId) {
    const info = this.universe.lookupByCgId(cgId);
    if (!info?.symbol) return null;
    return this.bySymbol.get(info.symbol.toUpperCase()) ?? null;
  }

  // Build a fapi URL — direct (fapi.binance.com) or via the Singapore relay
  // (relayBase/binance/<path>) once probe() has chosen.
  #fapiUrl(path) {
    return this.useRelay && this.relayBaseUrl ? `${this.relayBaseUrl}/binance${path}` : `${FAPI}${path}`;
  }
  #fapiFetch(path, opts = {}) {
    const o = { ...opts };
    if (this.useRelay && this.relayAuthSecret) {
      o.headers = { ...(o.headers ?? {}), 'X-Proxy-Auth': this.relayAuthSecret };
    }
    return fetch(this.#fapiUrl(path), o);
  }

  // Quick reachability probe — DIRECT first (skip the relay hop when the VPS
  // can reach Binance), then the Singapore relay. Sets this.useRelay. Returns
  // true if Binance is reachable by either route, false → caller falls back to
  // Coinalyze.
  async probe() {
    try {
      const res = await fetch(`${FAPI}/fapi/v1/ping`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) { this.useRelay = false; console.log('[funding] Binance reachable directly'); return true; }
    } catch { /* blocked — try the relay */ }
    if (this.relayBaseUrl) {
      try {
        const headers = this.relayAuthSecret ? { 'X-Proxy-Auth': this.relayAuthSecret } : {};
        const res = await fetch(`${this.relayBaseUrl}/binance/fapi/v1/ping`, { headers, signal: AbortSignal.timeout(12_000) });
        if (res.ok) { this.useRelay = true; console.log(`[funding] Binance reachable via Singapore relay`); return true; }
        console.warn(`[funding] Binance relay probe returned HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[funding] Binance relay probe failed: ${err.message}`);
      }
    }
    return false;
  }

  async start() {
    console.log(`[funding] polling Binance Futures every ${this.pollIntervalMs/1000}s`);
    this.#poll().catch(err => console.error('[funding] initial poll err:', err.message));
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.error('[funding] poll err:', err.message));
    }, this.pollIntervalMs);
  }

  async #poll() {
    // Build universe symbol set in Binance's <TOKEN>USDT format
    const universeBinanceSyms = new Set();
    for (const cgId of this.universe.allCgIds()) {
      const info = this.universe.lookupByCgId(cgId);
      if (!info?.symbol) continue;
      universeBinanceSyms.add(info.symbol.toUpperCase() + 'USDT');
    }

    // 1. Funding rates for ALL Binance perps — one call
    let premiumIndex;
    try {
      const res = await this.#fapiFetch(`/fapi/v1/premiumIndex`, {
        signal: AbortSignal.timeout(20_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      premiumIndex = await res.json();
    } catch (err) {
      console.error(`[funding] Binance premiumIndex failed: ${err.message}`);
      return;
    }
    if (!Array.isArray(premiumIndex)) return;

    // Filter to our universe; collect funding + markPrice
    const fundingByTokenSym = new Map();
    const markPriceByTokenSym = new Map();
    const symbolsToFetchOi = [];
    for (const item of premiumIndex) {
      if (!universeBinanceSyms.has(item.symbol)) continue;
      const rate = parseFloat(item.lastFundingRate);
      const markPrice = parseFloat(item.markPrice);
      if (!isFinite(rate)) continue;
      const tokenSym = item.symbol.replace(/USDT$/, '');
      fundingByTokenSym.set(tokenSym, rate);
      markPriceByTokenSym.set(tokenSym, markPrice);
      symbolsToFetchOi.push(item.symbol);
    }

    // 1b. Funding INTERVALS. Binance no longer settles every pair at 8h — it's a
    // 1h/4h/8h dynamic (changed in 2026), and the high-funding alts that trigger
    // signals are exactly the ones moved to 4h/1h. fundingInfo lists the pairs
    // with a non-default interval; anything unlisted is the 8h default. We
    // normalise every rate to a per-8h EQUIVALENT so the funding-score
    // thresholds (tuned on the 8h frame) and the per-1h display stay correct
    // regardless of a pair's real settlement cadence — otherwise a 4h pair's
    // funding is silently HALVED in the scoring.
    const intervalBySym = new Map();   // BINANCE_SYM → funding interval hours
    try {
      const res = await this.#fapiFetch(`/fapi/v1/fundingInfo`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const info = await res.json();
        if (Array.isArray(info)) {
          for (const it of info) {
            const h = Number(it.fundingIntervalHours);
            if (it.symbol && isFinite(h) && h > 0) intervalBySym.set(it.symbol, h);
          }
        }
      }
    } catch (err) {
      console.warn(`[funding] Binance fundingInfo failed (assuming 8h for all): ${err.message}`);
    }
    this._fundingIntervalBySym = intervalBySym;
    if (intervalBySym.size > 0) console.log(`[funding] ${intervalBySym.size} Binance pairs on non-8h funding — normalising to per-8h equivalent`);

    // 2. Open interest per symbol — parallel with concurrency cap
    const oiByTokenSym = new Map();
    for (let i = 0; i < symbolsToFetchOi.length; i += this.oiConcurrency) {
      const batch = symbolsToFetchOi.slice(i, i + this.oiConcurrency);
      const results = await Promise.allSettled(
        batch.map(async sym => {
          const res = await this.#fapiFetch(`/fapi/v1/openInterest?symbol=${sym}`, {
            signal: AbortSignal.timeout(10_000)
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          return { symbol: sym, oi: parseFloat(data.openInterest) };
        })
      );
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { symbol, oi } = r.value;
        if (!isFinite(oi)) continue;
        const tokenSym = symbol.replace(/USDT$/, '');
        const markPrice = markPriceByTokenSym.get(tokenSym) ?? 0;
        oiByTokenSym.set(tokenSym, oi * markPrice);  // convert base units → USD
      }
      await sleep(100);
    }

    // 3. Merge into bySymbol with previous-OI deltas
    const now = Date.now();
    let updated = 0;
    for (const [tokenSym, rawRate] of fundingByTokenSym) {
      // Normalise to a per-8h equivalent so a 4h/1h-settling pair isn't
      // under-scored vs an 8h pair (see step 1b).
      const intervalHrs = intervalBySym.get(tokenSym + 'USDT') ?? 8;
      const rate = rawRate * (8 / intervalHrs);
      const oi = oiByTokenSym.get(tokenSym) ?? null;
      const prev = this.bySymbol.get(tokenSym)?.summary ?? null;
      const previousOi = prev?.totalOi ?? null;
      const oiDelta = oi != null && previousOi != null ? oi - previousOi : null;
      const oiDeltaPct = oiDelta != null && previousOi > 0 ? (oiDelta / previousOi) * 100 : null;

      this.bySymbol.set(tokenSym, {
        rates: [{ exchange: 'Binance Futures', rate, oi, ts: now }],
        summary: {
          avg: rate,
          min: rate,
          max: rate,
          previousAvg: prev?.avg ?? null,
          delta: prev?.avg != null ? rate - prev.avg : null,
          // Preserve any velocity computed in the prior cycle until the next
          // enrichment refreshes it (so the conductor always has a value).
          velocity1h: prev?.velocity1h ?? null,
          velocity4h: prev?.velocity4h ?? null,
          fundingIntervalHrs: intervalHrs,    // 8 (default) / 4 / 1 — for transparency
          totalOi: oi,
          previousOi,
          oiDelta,
          oiDeltaPct,
          updatedAt: now
        }
      });
      updated++;
    }
    console.log(`[funding] updated funding+OI from Binance Futures for ${updated} tokens`);

    // Rolling funding velocity for the most-extreme tokens (audit §4 — the
    // primary Binance path previously had NO velocity, so the conductor's
    // funding-velocity edge never fired on Binance-sourced funding).
    await this.#enrichVelocities(fundingByTokenSym);
  }

  // Compute funding velocity from Binance's settlement history for the top
  // tokens by |funding|. Binance settles every 8h, so we derive a per-4h
  // velocity from consecutive settlements: velocity4h = (latest − prev) / 2.
  // The conductor normalises velocity4h to per-hour (÷4), recovering the true
  // per-hour rate-of-change ((latest − prev) / 8). Bounded to the top 50 to
  // stay well inside Binance's generous rate limit.
  async #enrichVelocities(fundingByTokenSym) {
    const ELEVATED = 0.0005;   // only bother with tokens whose funding is meaningful
    // Normalise to per-8h equivalent so 4h/1h pairs are ranked + measured on the
    // same frame as 8h pairs (see #poll step 1b).
    const norm = (token, raw) => raw * (8 / (this._fundingIntervalBySym?.get(token + 'USDT') ?? 8));
    const candidates = [...fundingByTokenSym.entries()]
      .map(([token, raw]) => [token, norm(token, raw)])
      .filter(([, rate]) => Math.abs(rate) >= ELEVATED)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 50);
    if (candidates.length === 0) return;

    let enriched = 0;
    for (let i = 0; i < candidates.length; i += this.oiConcurrency) {
      const batch = candidates.slice(i, i + this.oiConcurrency);
      const results = await Promise.allSettled(batch.map(async ([tokenSym]) => {
        const res = await this.#fapiFetch(`/fapi/v1/fundingRate?symbol=${tokenSym}USDT&limit=3`, {
          signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const hist = await res.json();
        return { tokenSym, hist };
      }));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { tokenSym, hist } = r.value;
        if (!Array.isArray(hist) || hist.length < 2) continue;
        // Binance returns ascending fundingTime — last two are the most recent.
        // Normalise both to per-8h equivalent before differencing, so velocity
        // is on the same frame as the score thresholds.
        const latest = norm(tokenSym, parseFloat(hist[hist.length - 1].fundingRate));
        const prev   = norm(tokenSym, parseFloat(hist[hist.length - 2].fundingRate));
        if (!isFinite(latest) || !isFinite(prev)) continue;
        const cur = this.bySymbol.get(tokenSym);
        if (cur?.summary) {
          cur.summary.velocity4h = (latest - prev) / 2;   // per-4h from the settlement delta
          enriched++;
        }
      }
      await sleep(100);
    }
    if (enriched > 0) console.log(`[funding] Binance funding velocity computed for ${enriched}/${candidates.length} top-funding tokens`);
  }
}
