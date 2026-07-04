// Coinalyze API client.
//
// Rate limit: 40 calls/min. "Each symbol consumes one API call" — so
// /funding-rate?symbols=A,B,C counts as 3 calls. We track a rolling 60s
// window and gate before exceeding the limit.
//
// Docs: https://api.coinalyze.net (free tier with API key).

const BASE = 'https://api.coinalyze.net/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class CoinalyzeClient {
  constructor({ apiKey, rateLimit = 20, relayBaseUrl = null, relayAuthSecret = null, relayPrimary = false, label = '' }) {
    if (!apiKey) throw new Error('CoinalyzeClient: apiKey required');
    this.apiKey = apiKey;
    this.label = label;                 // for logs (e.g. 'liq' vs '')
    this.rateLimit = rateLimit;        // calls per minute (per-KEY; ~40 cap)
    this.callTimes = [];                // rolling window of call timestamps
    // EGRESS PATHS. One client may have a direct path AND a Singapore-relay path.
    // The FIRST entry is primary; #request fails over to the next on 429/403/
    // network. `relayPrimary` puts the relay FIRST — used by the dedicated
    // liquidation client so its egress IP (Singapore) is separate from the
    // datacenter IP that Coinalyze may throttle. Without a relay it's direct-only.
    const relay = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    const direct = { name: 'direct', base: BASE, auth: null };
    const relayEg = relay ? { name: 'relay', base: `${relay}/coinalyze/v1`, auth: relayAuthSecret || null } : null;
    this.egresses = relayEg ? (relayPrimary ? [relayEg, direct] : [direct, relayEg]) : [direct];
    this.egressIdx = 0;
    // CIRCUIT BREAKER. After `breakerThreshold` consecutive all-egress failures
    // (timeout/429/block), FAIL FAST for `breakerCooldownMs` so callers fall back
    // immediately (TA → Bybit klines, monitors skip the poll) instead of every
    // in-flight call retrying for minutes and flooding the logs while Coinalyze
    // is degraded/unreachable. Replaces the old infinite recursive retry.
    this.failStreak = 0;
    this.breakerUntil = 0;
    this.breakerThreshold = 5;
    this.breakerCooldownMs = 60_000;
  }

  async #gate(cost = 1) {
    // Recompute the clock on every iteration so wait math stays correct
    // across multiple loop passes (previous bug: stale `now` made later
    // waits miscalculated, causing the gate to under-throttle).
    while (true) {
      const now = Date.now();
      this.callTimes = this.callTimes.filter(t => now - t < 60_000);
      if (this.callTimes.length + cost <= this.rateLimit) return;
      const earliest = this.callTimes[0];
      const wait = Math.max(50, 60_000 - (now - earliest) + 100);
      await sleep(wait);
    }
  }

  async #request(path, params = {}, cost = 1, attempt = 0) {
    // Circuit-breaker fast-fail — set after repeated all-egress failures. Throws
    // instantly (no fetch, no gate) so callers serve their fallbacks while
    // Coinalyze recovers, instead of piling up 12s timeouts behind the rate gate.
    if (Date.now() < this.breakerUntil) {
      throw new Error(`Coinalyze circuit open — ${Math.ceil((this.breakerUntil - Date.now()) / 1000)}s left`);
    }
    await this.#gate(cost);

    // Record call timestamps BEFORE the fetch so the gate accounts for them
    // even if the server returns 429. The server saw the request regardless
    // of our response handling — counting only successes drifts our gate
    // off the server's window and leads to runaway 429 loops.
    const callTime = Date.now();
    for (let i = 0; i < cost; i++) this.callTimes.push(callTime);

    // DIRECT is ALWAYS primary (egress[0]); the relay is a pure FAILOVER, tried
    // only if direct 429s / blocks / errors. Coinalyze is NOT geo-blocked (it's
    // a data API, not an exchange), so alternating half the calls into the relay
    // bought nothing and silently stalled the liquidation poll whenever the
    // relay was slow/cold — the regression that killed liquidation alerts. The
    // relay strips /coinalyze and forwards /v1<path>?...&api_key=... to Coinalyze.
    const n = this.egresses.length;
    const start = 0;                               // always try direct first
    let lastStatus = null;

    for (let k = 0; k < n; k++) {
      const eg = this.egresses[(start + k) % n];
      const url = new URL(eg.base + path);
      for (const [key, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(key, v);
      }
      url.searchParams.set('api_key', this.apiKey);
      const opts = { signal: AbortSignal.timeout(12_000) };   // fail a hung egress faster (was 20s)
      if (eg.auth) opts.headers = { 'X-Proxy-Auth': eg.auth };

      let res;
      try {
        res = await fetch(url, opts);
      } catch (err) {
        lastStatus = `network (${err.message})`;
        continue;                                  // this IP unreachable → try the other
      }
      if (res.status === 429 || res.status === 403) {
        lastStatus = res.status;
        continue;                                  // this IP throttled/blocked → try the other
      }
      if (res.status === 401) throw new Error('Coinalyze: invalid API key');
      if (!res.ok) throw new Error(`Coinalyze ${path} HTTP ${res.status} via ${eg.name}`);
      // Success — reset the failure streak (and close the breaker if it was open).
      if (this.breakerUntil) console.log(`[coinalyze${this.label ? ':' + this.label : ''}] recovered — circuit closed`);
      this.failStreak = 0;
      this.breakerUntil = 0;
      return res.json();
    }

    // EVERY egress was throttled/unreachable (timeout / 429 / block).
    this.failStreak++;
    if (this.failStreak >= this.breakerThreshold) {
      // Trip the breaker: fail fast for the cooldown so callers use fallbacks and
      // stop hammering a degraded API. Log ONCE on trip (not once per call).
      if (Date.now() >= this.breakerUntil) {
        this.breakerUntil = Date.now() + this.breakerCooldownMs;
        console.warn(`[coinalyze${this.label ? ':' + this.label : ''}] ${this.failStreak} consecutive egress failures (last: ${lastStatus}) — circuit OPEN ${this.breakerCooldownMs / 1000}s; callers serving fallbacks`);
      }
      throw new Error(`Coinalyze unavailable: ${path} (last: ${lastStatus})`);
    }
    // Below the trip threshold: ONE short backoff + a single retry, then give up.
    // (Was an INFINITE recursive retry — the cause of the multi-minute log flood
    // and stalled TA when Coinalyze slowed down.)
    if (attempt < 1) {
      await sleep(2000);
      return this.#request(path, params, cost, attempt + 1);
    }
    throw new Error(`Coinalyze ${path} failed via all egress (last: ${lastStatus})`);
  }

  futureMarkets() { return this.#request('/future-markets', {}, 1); }

  // Cached future-markets list (1h TTL). Used by resolvePerp so live token
  // additions don't fire a fresh /future-markets call every time.
  async cachedFutureMarkets() {
    if (this._marketsCache && Date.now() - (this._marketsCacheAt ?? 0) < 3_600_000) {
      return this._marketsCache;
    }
    const m = await this.futureMarkets();
    this._marketsCache = m;
    this._marketsCacheAt = Date.now();
    return m;
  }

  // Resolve a single token symbol → its Coinalyze perp symbol (USDT-margined
  // preferred, else any perp). Returns null if the token has no perp market.
  // Used to register tokens added at runtime via /watchlist so funding/TA
  // pick them up without a restart.
  async resolvePerp(symbol, { fresh = false } = {}) {
    const base = (symbol ?? '').toUpperCase();
    if (!base) return null;
    // `fresh` bypasses the 1h market cache — a brand-new LISTING's perp won't be in
    // the cached list yet, so a listing lookup must force a live fetch to find it.
    let markets;
    if (fresh) { markets = await this.futureMarkets(); this._marketsCache = markets; this._marketsCacheAt = Date.now(); }
    else markets = await this.cachedFutureMarkets();
    let usdt = null, other = null;
    for (const m of markets) {
      if (!m.is_perpetual) continue;
      if ((m.base_asset ?? '').toUpperCase() !== base) continue;
      if (m.quote_asset === 'USDT') { usdt = m.symbol; break; }
      if (!other) other = m.symbol;
    }
    return usdt ?? other ?? null;
  }

  // Resolve a token symbol → UP TO `max` perp markets ACROSS exchanges (USDT-margined
  // first, then others). The liquidation heatmap uses this to AGGREGATE open interest
  // across venues, so the magnet zones reflect TOTAL leverage rather than one
  // exchange's slice (Binance + Bybit + OKX + … instead of whichever was listed first).
  async perpMarketsFor(symbol, max = 3) {
    const base = (symbol ?? '').toUpperCase();
    if (!base) return [];
    const markets = await this.cachedFutureMarkets();
    const usdt = [], other = [];
    for (const m of markets) {
      if (!m.is_perpetual) continue;
      if ((m.base_asset ?? '').toUpperCase() !== base) continue;
      (m.quote_asset === 'USDT' ? usdt : other).push(m.symbol);
    }
    return [...usdt, ...other].slice(0, Math.max(1, max));
  }

  // Symbol-list endpoints: cost = number of symbols
  fundingRate(symbols) {
    return this.#request('/funding-rate', { symbols: symbols.join(',') }, symbols.length);
  }
  openInterest(symbols, convertToUsd = 'true') {
    return this.#request('/open-interest', { symbols: symbols.join(','), convert_to_usd: convertToUsd }, symbols.length);
  }
  liquidationHistory(symbols, interval, from, to, convertToUsd = 'true') {
    return this.#request('/liquidation-history', {
      symbols: symbols.join(','), interval, from, to, convert_to_usd: convertToUsd
    }, symbols.length);
  }
  ohlcvHistory(symbols, interval, from, to) {
    return this.#request('/ohlcv-history', {
      symbols: symbols.join(','), interval, from, to
    }, symbols.length);
  }
  openInterestHistory(symbols, interval, from, to, convertToUsd = 'true') {
    return this.#request('/open-interest-history', {
      symbols: symbols.join(','), interval, from, to, convert_to_usd: convertToUsd
    }, symbols.length);
  }
  fundingRateHistory(symbols, interval, from, to) {
    return this.#request('/funding-rate-history', {
      symbols: symbols.join(','), interval, from, to
    }, symbols.length);
  }
  longShortRatio(symbols, interval, from, to) {
    return this.#request('/long-short-ratio-history', {
      symbols: symbols.join(','), interval, from, to
    }, symbols.length);
  }
}

// Build a map of TOKEN_SYMBOL → coinalyze perp symbol.
// Prefers USDT-margined perps; falls back to any other perp.
//
// Order of inclusion:
//   1. Pinned tokens (operator's explicit watchlist) — ALWAYS mapped if a
//      perp exists, regardless of the topN cap. Without this, low-MC pinned
//      tokens like MITO/LAB never get TA/funding/liquidation coverage.
//   2. Top-MC tokens — fill remaining slots up to topN.
//
// Each symbol consumed at runtime costs one Coinalyze API call, so topN is
// our budget gate; pinned tokens are typically a handful, so they fit
// comfortably inside any reasonable topN.
export async function buildPerpSymbolMap(coinalyze, universe, topN = 100) {
  const markets = await coinalyze.futureMarkets();

  const usdtBySymbol = new Map();
  const otherBySymbol = new Map();
  for (const m of markets) {
    if (!m.is_perpetual) continue;
    const base = (m.base_asset ?? '').toUpperCase();
    if (!base) continue;
    if (m.quote_asset === 'USDT') {
      if (!usdtBySymbol.has(base)) usdtBySymbol.set(base, m.symbol);
    } else {
      if (!otherBySymbol.has(base)) otherBySymbol.set(base, m.symbol);
    }
  }

  const tryMap = (sym, result) => {
    if (!sym || result.has(sym)) return false;
    if (usdtBySymbol.has(sym))       { result.set(sym, usdtBySymbol.get(sym));  return true; }
    if (otherBySymbol.has(sym))      { result.set(sym, otherBySymbol.get(sym)); return true; }
    return false;
  };

  const result = new Map();
  let pinnedMapped = 0;
  let pinnedMissing = [];

  // 1. Pinned tokens first — guaranteed inclusion regardless of MC rank.
  for (const cgId of universe.allCgIds()) {
    if (!universe.isPinned?.(cgId)) continue;
    const t = universe.lookupByCgId(cgId);
    const sym = t?.symbol?.toUpperCase();
    if (tryMap(sym, result)) pinnedMapped++;
    else if (sym) pinnedMissing.push(sym);
  }
  console.log(`[coinalyze] pinned tokens mapped: ${pinnedMapped} (no perp on Coinalyze: ${pinnedMissing.length > 0 ? pinnedMissing.join(', ') : 'none'})`);

  // 1b. FAVORED (hot-mover) tokens next — guaranteed perp coverage while they're
  //     active, even if they sit below the MC top-N. Without this a token that's
  //     currently ripping (and most worth funding/liq/TA coverage) could be
  //     crowded out of the map by higher-MC-but-quiet names. Pinned already done.
  let favoredMapped = 0;
  for (const cgId of universe.allCgIds()) {
    if (result.size >= topN) break;
    if (universe.isPinned?.(cgId) || !universe.isHotMover?.(cgId)) continue;
    if (tryMap(universe.lookupByCgId(cgId)?.symbol?.toUpperCase(), result)) favoredMapped++;
  }
  if (favoredMapped) console.log(`[coinalyze] hot-mover tokens mapped: ${favoredMapped}`);

  // 2. Top-MC tokens fill the rest, in MC order, skipping anything already mapped.
  for (const cgId of universe.allCgIds()) {
    if (result.size >= topN) break;
    if (universe.isPinned?.(cgId)) continue;
    const t = universe.lookupByCgId(cgId);
    const sym = t?.symbol?.toUpperCase();
    tryMap(sym, result);
  }
  return result;
}
