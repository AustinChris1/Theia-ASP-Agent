

const BASE = 'https://api.coinalyze.net/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class CoinalyzeClient {
  constructor({ apiKey, rateLimit = 20, relayBaseUrl = null, relayAuthSecret = null, relayPrimary = false, label = '' }) {
    if (!apiKey) throw new Error('CoinalyzeClient: apiKey required');
    this.apiKey = apiKey;
    this.label = label;
    this.rateLimit = rateLimit;
    this.callTimes = [];

    const relay = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    const direct = { name: 'direct', base: BASE, auth: null };
    const relayEg = relay ? { name: 'relay', base: `${relay}/coinalyze/v1`, auth: relayAuthSecret || null } : null;
    this.egresses = relayEg ? (relayPrimary ? [relayEg, direct] : [direct, relayEg]) : [direct];
    this.egressIdx = 0;

    this.failStreak = 0;
    this.breakerUntil = 0;
    this.breakerThreshold = 5;
    this.breakerCooldownMs = 60_000;
  }

  async #gate(cost = 1) {

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

    if (Date.now() < this.breakerUntil) {
      throw new Error(`Coinalyze circuit open — ${Math.ceil((this.breakerUntil - Date.now()) / 1000)}s left`);
    }
    await this.#gate(cost);

    const callTime = Date.now();
    for (let i = 0; i < cost; i++) this.callTimes.push(callTime);

    const n = this.egresses.length;
    const start = 0;
    let lastStatus = null;

    for (let k = 0; k < n; k++) {
      const eg = this.egresses[(start + k) % n];
      const url = new URL(eg.base + path);
      for (const [key, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(key, v);
      }
      url.searchParams.set('api_key', this.apiKey);
      const opts = { signal: AbortSignal.timeout(12_000) };
      if (eg.auth) opts.headers = { 'X-Proxy-Auth': eg.auth };

      let res;
      try {
        res = await fetch(url, opts);
      } catch (err) {
        lastStatus = `network (${err.message})`;
        continue;
      }
      if (res.status === 429 || res.status === 403) {
        lastStatus = res.status;
        continue;
      }
      if (res.status === 401) throw new Error('Coinalyze: invalid API key');
      if (!res.ok) throw new Error(`Coinalyze ${path} HTTP ${res.status} via ${eg.name}`);

      if (this.breakerUntil) console.log(`[coinalyze${this.label ? ':' + this.label : ''}] recovered — circuit closed`);
      this.failStreak = 0;
      this.breakerUntil = 0;
      return res.json();
    }

    this.failStreak++;
    if (this.failStreak >= this.breakerThreshold) {

      if (Date.now() >= this.breakerUntil) {
        this.breakerUntil = Date.now() + this.breakerCooldownMs;
        console.warn(`[coinalyze${this.label ? ':' + this.label : ''}] ${this.failStreak} consecutive egress failures (last: ${lastStatus}) — circuit OPEN ${this.breakerCooldownMs / 1000}s; callers serving fallbacks`);
      }
      throw new Error(`Coinalyze unavailable: ${path} (last: ${lastStatus})`);
    }

    if (attempt < 1) {
      await sleep(2000);
      return this.#request(path, params, cost, attempt + 1);
    }
    throw new Error(`Coinalyze ${path} failed via all egress (last: ${lastStatus})`);
  }

  futureMarkets() { return this.#request('/future-markets', {}, 1); }

  async cachedFutureMarkets() {
    if (this._marketsCache && Date.now() - (this._marketsCacheAt ?? 0) < 3_600_000) {
      return this._marketsCache;
    }
    const m = await this.futureMarkets();
    this._marketsCache = m;
    this._marketsCacheAt = Date.now();
    return m;
  }

  async resolvePerp(symbol, { fresh = false } = {}) {
    const base = (symbol ?? '').toUpperCase();
    if (!base) return null;

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

  for (const cgId of universe.allCgIds()) {
    if (!universe.isPinned?.(cgId)) continue;
    const t = universe.lookupByCgId(cgId);
    const sym = t?.symbol?.toUpperCase();
    if (tryMap(sym, result)) pinnedMapped++;
    else if (sym) pinnedMissing.push(sym);
  }
  console.log(`[coinalyze] pinned tokens mapped: ${pinnedMapped} (no perp on Coinalyze: ${pinnedMissing.length > 0 ? pinnedMissing.join(', ') : 'none'})`);

  let favoredMapped = 0;
  for (const cgId of universe.allCgIds()) {
    if (result.size >= topN) break;
    if (universe.isPinned?.(cgId) || !universe.isHotMover?.(cgId)) continue;
    if (tryMap(universe.lookupByCgId(cgId)?.symbol?.toUpperCase(), result)) favoredMapped++;
  }
  if (favoredMapped) console.log(`[coinalyze] hot-mover tokens mapped: ${favoredMapped}`);

  for (const cgId of universe.allCgIds()) {
    if (result.size >= topN) break;
    if (universe.isPinned?.(cgId)) continue;
    const t = universe.lookupByCgId(cgId);
    const sym = t?.symbol?.toUpperCase();
    tryMap(sym, result);
  }
  return result;
}
