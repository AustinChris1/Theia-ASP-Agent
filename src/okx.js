// OKX v5 public market-data client (candles, funding, open interest, instruments).
// Reachability-agnostic: hits www.okx.com directly, an OKX_BASE_URL override, or the
// relay (/okx prefix) when the host is geo-blocked. Every fetch carries a timeout.
const DEFAULT_HOST = 'https://www.okx.com';

// Coinalyze/engine TF interval -> OKX candle bar.
export const OKX_BAR = {
  '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m',
  '1hour': '1H', '4hour': '4H', 'daily': '1D', '1week': '1W',
};

export class OkxClient {
  constructor({ baseUrl = null, relayBaseUrl = null, relayAuthSecret = null, timeoutMs = 8000 } = {}) {
    if (baseUrl) {
      this.base = baseUrl.replace(/\/$/, '');
      this.auth = null;
    } else if (relayBaseUrl) {
      this.base = `${relayBaseUrl.replace(/\/$/, '')}/okx`;
      this.auth = relayAuthSecret || null;
    } else {
      this.base = DEFAULT_HOST;
      this.auth = null;
    }
    this.timeoutMs = timeoutMs;
  }

  async #get(path) {
    const opts = { signal: AbortSignal.timeout(this.timeoutMs) };
    if (this.auth) opts.headers = { 'X-Proxy-Auth': this.auth };
    const res = await fetch(`${this.base}/api/v5${path}`, opts);
    if (!res.ok) return null;
    const j = await res.json();
    // OKX wraps everything as { code:"0", data:[...] }; code!="0" is an API error.
    if (j?.code !== undefined && j.code !== '0') return null;
    return j?.data ?? null;
  }

  // Most-recent candles for an instrument. Returns ascending [{t(sec),o,h,l,c,v}] or null.
  // OKX rows are NEWEST first: [ts(ms), o, h, l, c, vol, volCcy, volCcyQuote, confirm].
  async getCandles(instId, bar, limit = 300) {
    if (!instId || !bar) return null;
    const lim = Math.min(Math.max(Number(limit) || 300, 1), 300);
    const data = await this.#get(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${lim}`);
    if (!Array.isArray(data) || data.length === 0) return null;
    const bars = data.map((k) => ({
      t: Math.floor(Number(k[0]) / 1000),
      o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]),
      v: Number(k[5] ?? 0),
    })).filter((b) => Number.isFinite(b.c) && Number.isFinite(b.h) && Number.isFinite(b.l));
    if (!bars.length) return null;
    return bars.sort((a, b) => a.t - b.t);
  }

  // Current funding rate for a SWAP instId. Returns { fundingRate(number, per-period),
  // nextFundingTime(ms) } or null.
  async getFundingRate(instId) {
    if (!instId) return null;
    const data = await this.#get(`/public/funding-rate?instId=${encodeURIComponent(instId)}`);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    const rate = Number(row.fundingRate);
    if (!Number.isFinite(rate)) return null;
    return { instId: row.instId, fundingRate: rate, nextFundingTime: Number(row.nextFundingTime) || null };
  }

  // Current open interest for a SWAP instId. Returns { oi(contracts), oiCcy(base units), ts } or null.
  async getOpenInterest(instId) {
    if (!instId) return null;
    const data = await this.#get(`/public/open-interest?instType=SWAP&instId=${encodeURIComponent(instId)}`);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    const oiCcy = Number(row.oiCcy);
    return { instId: row.instId, oi: Number(row.oi) || null, oiCcy: Number.isFinite(oiCcy) ? oiCcy : null, ts: Number(row.ts) || null };
  }

  // List instruments of a type (e.g. SWAP). Returns the raw OKX rows or null.
  async getInstruments(instType = 'SWAP') {
    return this.#get(`/public/instruments?instType=${instType}`);
  }

  // Build a base-symbol -> OKX USDT-SWAP instId map from the live instrument list.
  // e.g. BTC -> BTC-USDT-SWAP. Only USDT-margined linear perps.
  async buildSwapMap() {
    const rows = await this.getInstruments('SWAP');
    const map = new Map();
    if (!Array.isArray(rows)) return map;
    for (const r of rows) {
      if (r.settleCcy !== 'USDT' || r.ctType !== 'linear') continue;
      const base = String(r.ctValCcy || r.instId?.split('-')[0] || '').toUpperCase();
      if (base && !map.has(base)) map.set(base, r.instId);
    }
    return map;
  }
}

export default OkxClient;
