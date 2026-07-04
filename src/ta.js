// Multi-timeframe Technical Analysis service.
//
// On each evaluation we pull OHLCV from Coinalyze for FOUR timeframes:
//   • 5m — short-term entry timing
//   • 1h — tactical trend
//   • 4h — strategic trend
//   • 1d — macro trend
//
// For each timeframe we compute RSI(14), MACD(12,26,9), Bollinger(20,2σ),
// ATR(14), and check candle patterns on the shorter TFs. Findings from all
// TFs are returned together with weighted points (higher TF = bigger weight).
//
// Per-TF metadata (atr/rsi/macdHist/trend) flows back to the Conductor so
// it can build a trade plan that respects trend alignment across timeframes.
//
// Cost: 4 Coinalyze OHLCV calls per analysis. Results cached for cacheTtlMs
// (60s default), so repeated triggers on the same token within that window
// reuse the prior fetch. Per-token cooldown in the Conductor (30min) further
// limits how often any one token re-enters this path.

import pkg from 'technicalindicators';
const { RSI, MACD, BollingerBands, ATR, bullish, bearish } = pkg;
import { analyzeSmc, findSwings } from './smc.js';
import { TIMEFRAMES, FETCH_INTERVALS, MIN_BARS, aggregateWeekly } from './timeframes.js';

// Coinalyze TF interval → Bybit kline interval, for the OHLCV FALLBACK: when a token
// has no Coinalyze perp but DOES trade on Bybit, multi-TF TA still runs off Bybit
// klines (the "/analyze AT — no coverage" gap). Weekly is derived from daily, not fetched.
const BYBIT_KLINE_INTERVAL = { '1min': '1', '5min': '5', '15min': '15', '30min': '30', '1hour': '60', '4hour': '240', 'daily': 'D' };

// Multiplier applied to the RSI-AGAINST penalty when the same TF is trending
// WITH the trade (overbought-in-uptrend = continuation, not exhaustion). 0.4 =
// 60% lighter; 1 = full penalty (disable the softening).
const RSI_AGAINST_TREND_MULT = (() => { const v = Number(process.env.RSI_AGAINST_TREND_MULT); return isFinite(v) ? v : 0.4; })();
// Beyond this, "overbought-in-uptrend = continuation" no longer holds — RSI ≥85
// (or ≤15) is a BLOW-OFF, not healthy trend, so the softening is switched OFF and
// the full penalty applies (VELVET LONG fired into daily RSI 98.9 because the
// softening swallowed the warning). Env: RSI_BLOWOFF_OB / RSI_BLOWOFF_OS.
const RSI_BLOWOFF_OB = (() => { const v = Number(process.env.RSI_BLOWOFF_OB); return isFinite(v) ? v : 85; })();
const RSI_BLOWOFF_OS = (() => { const v = Number(process.env.RSI_BLOWOFF_OS); return isFinite(v) ? v : 15; })();

// ── RSI divergence (regular) ────────────────────────────────────────────────
// A reversal tell INDEPENDENT of momentum-following TA: price prints a HIGHER high
// while RSI prints a LOWER high (bearish → supports SHORT), or a LOWER low while
// RSI prints a HIGHER low (bullish → supports LONG). The classic exhaustion signal
// at the END of a move — exactly the bot's proven edge (fades / liquidity grabs),
// and orthogonal to the anti-predictive momentum stack. HTF-only (it's noise on
// 1m/5m). `prices` = the high series (SHORT) or low series (LONG); `rsi` aligned
// 1:1 to `prices` (null before warmup). Confirmation-only (only ever supports the
// trade side). Pure + testable. Returns { kind:'bull'|'bear', dPrice, dRsi } | null.
const RSI_DIVERGENCE = process.env.RSI_DIVERGENCE !== '0';
const DIVERGENCE_MULT = (() => { const v = Number(process.env.DIVERGENCE_MULT); return isFinite(v) ? v : 1.0; })();

export function detectRsiDivergence(prices, rsi, side, { left = 2, right = 2, lookback = 40, minApart = 3 } = {}) {
  const n = Array.isArray(prices) ? prices.length : 0;
  if (n < 12 || !Array.isArray(rsi) || rsi.length !== n) return null;
  const wantHigh = side === 'SHORT';
  const from = Math.max(left, n - lookback);
  const pivots = [];
  for (let i = n - right - 1; i >= from && pivots.length < 2; i--) {
    if (rsi[i] == null || !isFinite(rsi[i]) || !isFinite(prices[i])) continue;
    let isPivot = true;
    for (let j = 1; j <= left && isPivot; j++)  if (!(wantHigh ? prices[i - j] < prices[i] : prices[i - j] > prices[i])) isPivot = false;
    for (let j = 1; j <= right && isPivot; j++) if (!(wantHigh ? prices[i + j] < prices[i] : prices[i + j] > prices[i])) isPivot = false;
    if (isPivot) pivots.push({ i, price: prices[i], rsi: rsi[i] });
  }
  if (pivots.length < 2) return null;
  const [b, a] = pivots;                       // b = most recent pivot, a = the prior one
  if (b.i - a.i < minApart) return null;
  if (wantHigh  && b.price > a.price && b.rsi < a.rsi) return { kind: 'bear', dPrice: b.price - a.price, dRsi: b.rsi - a.rsi };
  if (!wantHigh && b.price < a.price && b.rsi > a.rsi) return { kind: 'bull', dPrice: b.price - a.price, dRsi: b.rsi - a.rsi };
  return null;
}

// Run `fn` with console.warn/log/error temporarily muted. Used to wrap noisy
// third-party calls (technicalindicators' candlestick aggregate prints a
// "Data count less than data required" warning for every long-lookback
// strategy on a short window). Restores the originals in a finally block so
// an exception can't leave the console permanently silenced.
function withSilencedConsole(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
}

// Self-test at module load — proves every indicator is wired correctly.
(function selfTest() {
  const status = {
    bullish:        typeof bullish        === 'function' ? '✓' : '✗',
    bearish:        typeof bearish        === 'function' ? '✓' : '✗',
    RSI:            typeof RSI?.calculate === 'function' ? '✓' : '✗',
    MACD:           typeof MACD?.calculate === 'function' ? '✓' : '✗',
    BollingerBands: typeof BollingerBands?.calculate === 'function' ? '✓' : '✗',
    ATR:            typeof ATR?.calculate === 'function' ? '✓' : '✗'
  };
  console.log(`[ta] indicator self-test: ${Object.entries(status).map(([k,v]) => `${k}=${v}`).join('  ')}`);
})();

// Lookback window per timeframe + per-finding weights are now centralised in
// timeframes.js (the canonical source shared with conductor + ta-confirm).
// `findingWeight` replaces the old `weight` field; we alias it below so the
// per-TF compute code reads `tf.weight` unchanged.

export class TAService {
  constructor({ coinalyze, perpSymbolMap, cacheTtlMs = 60_000, relayBaseUrl = null, relayAuthSecret = null }) {
    this.coinalyze = coinalyze;
    this.perpSymbolMap = perpSymbolMap;
    this.cache = new Map();
    this.cacheTtlMs = cacheTtlMs;
    // Bybit is geo-blocked from US hosts (VPS/Render), so the DIRECT Bybit price
    // call below silently fails there and falls back to OKX — whose perp price
    // differs ~1% from Bybit on illiquid alts (the 0.0296-vs-0.0299 mismatch).
    // Route Bybit through the Singapore relay so the price MATCHES what the user
    // trades on. Same relay the autotrader uses.
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.volumeCache = new Map();   // SYMBOL → { ts, result } — 30s TTL
    // OHLCV cache shared across LONG/SHORT analysis — when both sides run in
    // parallel, the second one would otherwise fire duplicate Coinalyze
    // calls. With the in-flight dedup map below, parallel calls await the
    // same promise instead of double-fetching.
    this.ohlcvCache = new Map();    // `${symbol}|${interval}` → { ts, history }
    this.pendingOhlcv = new Map();  // same key → in-flight Promise
  }

  // Batched perp last-price lookup. Coinalyze accepts symbols=A,B,C in one
  // call, so /open with 10 open signals fires ONE call instead of 10
  // round-trips queueing through the rate gate.
  async getLastPerpPrices(symbols) {
    if (!this.coinalyze || !this.perpSymbolMap) return new Map();
    const symToPerp = new Map();
    for (const s of symbols ?? []) {
      const up = (s ?? '').toUpperCase();
      const perp = this.perpSymbolMap.get(up);
      if (perp) symToPerp.set(up, perp);
    }
    if (symToPerp.size === 0) return new Map();
    const perpToSym = new Map([...symToPerp.entries()].map(([s, p]) => [p, s]));
    const perps = [...symToPerp.values()];
    const now = Math.floor(Date.now() / 1000);
    const out = new Map();
    try {
      const data = await this.coinalyze.ohlcvHistory(perps, '1min', now - 180, now);
      for (const entry of data ?? []) {
        const sym = perpToSym.get(entry.symbol);
        const bars = entry?.history;
        if (!sym || !Array.isArray(bars) || bars.length === 0) continue;
        const close = Number(bars[bars.length - 1].c ?? bars[bars.length - 1].close);
        if (isFinite(close)) out.set(sym, close);
      }
    } catch (err) {
      console.warn(`[ta] batched perp prices failed: ${err.message}`);
    }
    return out;
  }

  // Internal: cached + in-flight-dedup'd OHLCV fetcher. Called from analyze()
  // for each TF; parallel LONG/SHORT analyses share the same fetch.
  async #fetchOhlcv(symbol, perp, tf) {
    const key = `${symbol}|${tf.interval}`;
    const cached = this.ohlcvCache.get(key);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.history;
    if (this.pendingOhlcv.has(key)) return this.pendingOhlcv.get(key);

    const now = Math.floor(Date.now() / 1000);
    const p = (async () => {
      try {
        let history = [];
        if (perp) {
          // Coinalyze can be rate-limited / time out / trip its circuit breaker.
          // Swallow that so we FALL THROUGH to the Bybit-klines fallback below
          // instead of failing the whole TA call (the throw would skip it).
          try {
            const data = await this.coinalyze.ohlcvHistory([perp], tf.interval, now - tf.lookbackSec, now);
            history = data?.[0]?.history ?? [];
          } catch { history = []; }
        }
        // FALLBACK: no Coinalyze perp (or it returned nothing / errored) → Bybit klines, so
        // multi-TF TA works on any token with a Bybit perp even when Coinalyze
        // doesn't cover it. Bybit bars are {t(ms),…}; normalise to the Coinalyze
        // shape (t in seconds, o/h/l/c/v) the TA pipeline expects.
        if (!Array.isArray(history) || history.length === 0) {
          const bi = BYBIT_KLINE_INTERVAL[tf.interval];
          if (bi && this.relayBaseUrl) {
            // perp klines first; spot klines as a last resort (spot-only tokens like SYN)
            let bars = await this.#fetchBybitKlines(symbol, now - tf.lookbackSec, now, bi);
            if (!bars || !bars.length) bars = await this.#fetchBybitSpotKlines(symbol, now - tf.lookbackSec, now, bi);
            if (bars && bars.length) {
              history = bars.map(b => ({ t: Math.floor(b.t / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
            }
          }
        }
        if (Array.isArray(history)) this.ohlcvCache.set(key, { ts: Date.now(), history });
        return history;
      } finally {
        this.pendingOhlcv.delete(key);
      }
    })();
    this.pendingOhlcv.set(key, p);
    return p;
  }

  // Returns the most recent 1m close price from Coinalyze for `symbol`,
  // or null if the token has no perp coverage. This is the *exchange* price
  // (perp futures), not the smoothed cross-venue CoinGecko price — use this
  // when calculating entry/SL/TP and when displaying live status, so the
  // numbers match what the user sees on their exchange (Bybit/OKX/etc.).
  // Resolve a base token symbol to its Bybit LINEAR perp symbol + the divisor
  // that converts Bybit's price back to PER-TOKEN. Bybit lists high-supply memes
  // per-1000 / per-1M ("1000PEPEUSDT", "1000000MOGUSDT"), whose price is
  // 1000×/1e6× the per-token price the bot's entry/SL/TP use. Without this, a
  // meme query for "PEPEUSDT" 404s and SL/TP silently resolve on a DIFFERENT
  // venue than the entry → phantom stop-outs. Tries bare → 1000× → 1e6×, caches
  // the winner (and negatives) so it costs at most a few probes once per symbol.
  async #resolveBybitSymbol(sym) {
    if (!sym) return null;
    if (!this._bybitSymCache) this._bybitSymCache = new Map();
    if (this._bybitSymCache.has(sym)) return this._bybitSymCache.get(sym);
    const variants = [
      { symbol: `${sym}USDT`, div: 1 },
      { symbol: `1000${sym}USDT`, div: 1000 },
      { symbol: `1000000${sym}USDT`, div: 1_000_000 },
    ];
    for (const v of variants) {
      try {
        const path = `/v5/market/tickers?category=linear&symbol=${v.symbol}`;
        const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
        const opts = { signal: AbortSignal.timeout(4000) };
        if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
        const res = await fetch(url, opts);
        if (!res.ok) continue;
        const j = await res.json();
        const last = Number(j?.result?.list?.[0]?.lastPrice);
        if (isFinite(last) && last > 0) {
          this._bybitSymCache.set(sym, v);
          return v;
        }
      } catch { /* try next variant */ }
    }
    this._bybitSymCache.set(sym, null);   // negative cache — no Bybit linear perp
    return null;
  }

  async getLastPerpPrice(symbol) {
    const sym = (symbol ?? '').toUpperCase();
    const perp = this.perpSymbolMap?.get(sym);
    if (!perp) return null;

    // PRIMARY: live last-traded-price from Bybit linear perps (~1s fresh).
    // Coinalyze's 1m close can be up to 60s stale, which on a volatile alt
    // can drift several % vs the real exchange price the user trades on.
    // Bybit endpoint returns immediately with the actual last fill price.
    // Cache for 3s — multiple signals in a burst share one HTTP round-trip.
    const cached = this.livePriceCache?.get(sym);
    if (cached && Date.now() - cached.ts < 3000) return cached.price;

    // Resolve the Bybit symbol (handles 1000×/1e6× memes) and divide back to
    // per-token so the live price matches the per-token entry/SL/TP.
    const variant = await this.#resolveBybitSymbol(sym);
    if (variant) {
      try {
        // Via the relay when configured (geo-blocked host + price matches Bybit), else direct.
        const path = `/v5/market/tickers?category=linear&symbol=${variant.symbol}`;
        const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
        const opts = { signal: AbortSignal.timeout(4000) };
        if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
        const res = await fetch(url, opts);
        if (res.ok) {
          const j = await res.json();
          const raw = Number(j?.result?.list?.[0]?.lastPrice);
          if (isFinite(raw) && raw > 0) {
            const price = raw / variant.div;   // per-token
            if (!this.livePriceCache) this.livePriceCache = new Map();
            this.livePriceCache.set(sym, { ts: Date.now(), price });
            return price;
          }
        }
      } catch { /* fall through to OKX */ }
    }

    // SECONDARY: OKX SWAP last price
    const okxSym = `${sym}-USDT-SWAP`;
    try {
      const res = await fetch(
        `https://www.okx.com/api/v5/market/ticker?instId=${okxSym}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (res.ok) {
        const j = await res.json();
        const last = Number(j?.data?.[0]?.last);
        if (isFinite(last) && last > 0) {
          if (!this.livePriceCache) this.livePriceCache = new Map();
          this.livePriceCache.set(sym, { ts: Date.now(), price: last });
          return last;
        }
      }
    } catch { /* fall through to Coinalyze */ }

    // FALLBACK: Coinalyze 1m close (could be up to ~60s stale).
    // Better than nothing for tokens without Bybit/OKX coverage.
    if (!this.coinalyze) return null;
    const now = Math.floor(Date.now() / 1000);
    try {
      const data = await this.coinalyze.ohlcvHistory([perp], '1min', now - 180, now);
      const bars = data?.[0]?.history;
      if (!Array.isArray(bars) || bars.length === 0) return null;
      const last = bars[bars.length - 1];
      const close = Number(last.c ?? last.close);
      return isFinite(close) ? close : null;
    } catch {
      return null;
    }
  }

  // Returns 1m OHLCV bars for `symbol` between unix-second timestamps
  // `fromTs` and `toTs`. Used by SignalTracker for wick-aware SL/TP
  // resolution — without bar high/low we'd miss any wick that touched a
  // level between resolver ticks (the previous CoinGecko-current-price
  // approach silently lost those, which is why exchange-real SL hits
  // weren't being detected by the bot).
  async getRecentBars(symbol, fromTs, toTs) {
    const sym = (symbol ?? '').toUpperCase();
    // PRIMARY: Bybit linear 1m klines — the SAME venue as getLastPerpPrice and
    // the user's actual trades. SL/TP resolution MUST use this so it can't fire
    // off a different exchange's market (the $H phantom-SL bug: the trade was
    // entered/priced on Bybit ~0.24 but Coinalyze's perp for "H" printed ~0.13,
    // tripping a stop that never happened on Bybit).
    const bybit = await this.#fetchBybitKlines(sym, fromTs, toTs);
    if (bybit && bybit.length) return bybit;

    // FALLBACK: Coinalyze (tokens without a Bybit linear perp).
    const perp = this.perpSymbolMap?.get(sym);
    if (!this.coinalyze || !perp) return bybit;   // null or [] — let caller fall back to price
    try {
      const data = await this.coinalyze.ohlcvHistory([perp], '1min', fromTs, toTs);
      const bars = data?.[0]?.history;
      if (!Array.isArray(bars)) return null;
      return bars.map(b => ({
        t: (b.t ?? b.timestamp ?? 0) * 1000,
        o: Number(b.o ?? b.open),
        h: Number(b.h ?? b.high),
        l: Number(b.l ?? b.low),
        c: Number(b.c ?? b.close),
        v: Number(b.v ?? b.volume ?? 0)
      })).filter(b => isFinite(b.c) && isFinite(b.h) && isFinite(b.l));
    } catch (err) {
      console.warn(`[ta] getRecentBars ${sym} failed: ${err.message}`);
      return null;
    }
  }

  // Bybit linear 1m klines between unix-second timestamps. Routes via the relay
  // (geo-blocked host) when configured. Bybit returns up to 1000 bars, NEWEST
  // first, each [start(ms), open, high, low, close, volume, turnover] as strings.
  async #fetchBybitKlines(sym, fromTs, toTs, interval = '1') {
    if (!sym) return null;
    // Resolve the Bybit symbol + per-token divisor (handles 1000×/1e6× memes) so
    // meme SL/TP resolve on Bybit (the trade venue), scaled to match the
    // per-token entry — instead of 404-ing and falling back to a foreign venue.
    const variant = await this.#resolveBybitSymbol(sym);
    if (!variant) return null;
    const div = variant.div;
    const start = Math.floor(Number(fromTs) * 1000);
    const end = Math.floor(Number(toTs) * 1000);
    if (!isFinite(start) || !isFinite(end)) return null;
    try {
      const path = `/v5/market/kline?category=linear&symbol=${variant.symbol}&interval=${interval}&start=${start}&end=${end}&limit=1000`;
      const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
      const opts = { signal: AbortSignal.timeout(6000) };
      if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      const j = await res.json();
      const list = j?.result?.list;
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.map(k => ({
        t: Number(k[0]),
        o: Number(k[1]) / div, h: Number(k[2]) / div, l: Number(k[3]) / div, c: Number(k[4]) / div,
        v: Number(k[5] ?? 0)
      })).filter(b => isFinite(b.c) && isFinite(b.h) && isFinite(b.l))
        .sort((a, b) => a.t - b.t);   // ascending (signal-tracker re-sorts, but keep tidy)
    } catch { return null; }
  }

  // Bybit SPOT klines — last-resort fallback for tokens with NO perp anywhere
  // (no Coinalyze perp, no Bybit linear perp) that ARE spot-listed on Bybit. Lets
  // /analyze run multi-TF TA on spot-only tokens too (the SYN gap). Spot has no
  // meme-prefix divisors, so the bare SYMUSDT symbol is used with div = 1.
  async #fetchBybitSpotKlines(sym, fromTs, toTs, interval = '1') {
    if (!sym) return null;
    const start = Math.floor(Number(fromTs) * 1000);
    const end = Math.floor(Number(toTs) * 1000);
    if (!isFinite(start) || !isFinite(end)) return null;
    try {
      const path = `/v5/market/kline?category=spot&symbol=${sym}USDT&interval=${interval}&start=${start}&end=${end}&limit=1000`;
      const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
      const opts = { signal: AbortSignal.timeout(6000) };
      if (this.relayBaseUrl && this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      const j = await res.json();
      const list = j?.result?.list;
      if (!Array.isArray(list) || list.length === 0) return null;
      return list.map(k => ({
        t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5] ?? 0)
      })).filter(b => isFinite(b.c) && isFinite(b.h) && isFinite(b.l))
        .sort((a, b) => a.t - b.t);
    } catch { return null; }
  }

  // Returns { ratio, currentVol, avgVol } for the most recent 1m bar vs the
  // average of the previous 59 bars. Used by Conductor to gate surges on
  // real volume confirmation — a 3% price move with 0.4× average volume is
  // a fake-out wick; only fire if the move came with real participation.
  //
  // Returns null if no perp coverage or Coinalyze returns too few bars to
  // compute a reliable average (caller decides what to do with null —
  // current policy: fall through, don't suppress).
  async getVolumeRatio(symbol) {
    if (!this.coinalyze || !this.perpSymbolMap) return null;
    const sym = (symbol ?? '').toUpperCase();
    const perp = this.perpSymbolMap.get(sym);
    if (!perp) return null;

    const cached = this.volumeCache.get(sym);
    if (cached && Date.now() - cached.ts < 30_000) return cached.result;

    const now = Math.floor(Date.now() / 1000);
    let history;
    try {
      const data = await this.coinalyze.ohlcvHistory([perp], '1min', now - 3600, now);
      history = data?.[0]?.history;
    } catch (err) {
      console.warn(`[volume] ${sym} 1m OHLCV fetch failed: ${err.message}`);
      return null;
    }
    if (!Array.isArray(history) || history.length < 10) return null;

    const volumes = history.map(b => parseFloat(b.v ?? b.volume ?? b.bv ?? 0)).filter(v => v >= 0);
    if (volumes.length < 10) return null;

    // Use the last CLOSED 1m bar, not the still-forming one (audit §3.13).
    // The forming bar is only partway through its minute, so its volume reads
    // low → ratio < 1.5 → real surges were being suppressed for the first
    // ~40s of every minute. The just-closed bar is the minute that actually
    // contains the move that tripped surge detection. Compare it to the mean
    // of the bars BEFORE it (exclude both the forming and the measured bar).
    const currentVol = volumes[volumes.length - 2];
    const priorVols = volumes.slice(0, -2);
    if (priorVols.length === 0) return null;
    const avgVol = priorVols.reduce((a, b) => a + b, 0) / priorVols.length;
    if (!isFinite(avgVol) || avgVol <= 0 || !isFinite(currentVol)) return null;
    const ratio = currentVol / avgVol;
    const result = { ratio, currentVol, avgVol };
    this.volumeCache.set(sym, { ts: Date.now(), result });
    return result;
  }

  // Register a token added at runtime (via /watchlist) so TA can analyse it
  // without a restart. Resolves the Coinalyze perp and adds it to the map.
  // Returns true if a perp was found and registered (or already present).
  async registerSymbol(symbol, { fresh = false } = {}) {
    const sym = (symbol ?? '').toUpperCase();
    if (!sym || !this.coinalyze || !this.perpSymbolMap) return false;
    if (this.perpSymbolMap.has(sym)) return true;
    try {
      // `fresh` forces a live market fetch — a brand-new listing's perp isn't in the
      // 1h-cached market list yet (the ARX case: perp appeared ~48s after the alert).
      const perp = await this.coinalyze.resolvePerp(sym, { fresh });
      if (!perp) return false;
      this.perpSymbolMap.set(sym, perp);
      console.log(`[ta] registered ${sym} → ${perp} (runtime add)`);
      return true;
    } catch (err) {
      console.warn(`[ta] registerSymbol ${sym} failed: ${err.message}`);
      return false;
    }
  }

  // Returns OHLCV bars per timeframe for `symbol`, drawn from the same
  // cache `analyze()` populates. Used by the TA confirmation gate which
  // re-runs the bars through an independent indicator library set. Returns
  // an empty object if no analyze() has run yet — caller is expected to
  // call analyze() first within the same evaluation cycle (the conductor
  // does this already).
  getOhlcvByTf(tokenSymbol) {
    const sym = (tokenSymbol ?? '').toUpperCase();
    const out = {};
    for (const tf of TIMEFRAMES) {
      const key = `${sym}|${tf.interval}`;
      const cached = this.ohlcvCache.get(key);
      if (cached?.history?.length) out[tf.interval] = cached.history;
    }
    return out;
  }

  async analyze(tokenSymbol, side) {
    if (!this.coinalyze || !this.perpSymbolMap) return { findings: [], metadata: null };
    const sym = (tokenSymbol ?? '').toUpperCase();
    const perp = this.perpSymbolMap.get(sym);
    // No Coinalyze perp is no longer fatal — if the relay is configured we fall back
    // to Bybit klines per TF (see #fetchOhlcv), so TA runs on any Bybit-listed token.
    // Bail only when there's neither a Coinalyze perp NOR a Bybit route.
    if (!perp && !this.relayBaseUrl) return { findings: [], metadata: null };

    const cacheKey = `${sym}|${side}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.result;

    const findings = [];
    const metadata = {};
    const now = Math.floor(Date.now() / 1000);

    // Fetch + compute the real (provider-backed) timeframes. Stash the daily
    // history so we can derive the weekly frame from it without a second call.
    let dailyHistory = null;
    // Fetch every (non-weekly) timeframe's OHLCV IN PARALLEL — they're
    // independent network calls, so awaiting them one-by-one needlessly stacked
    // ~4 relay round-trips of latency onto the hot signal path. The per-TF
    // compute below is synchronous, so the processing order is unchanged.
    const realTfs = TIMEFRAMES.filter(tf => !tf.weekly);
    const histories = await Promise.all(realTfs.map(tf =>
      this.#fetchOhlcv(sym, perp, tf).catch(err => {
        if (this.verbose) console.warn(`[ta] ${sym} ${tf.interval} fetch failed: ${err.message}`);
        return null;
      })
    ));
    for (let i = 0; i < realTfs.length; i++) {
      const tf = realTfs[i];
      const history = histories[i];
      if (!Array.isArray(history) || history.length < MIN_BARS) continue;
      if (tf.interval === 'daily') dailyHistory = history;

      const tfResult = this.#computeForTimeframe(history, side, tf);
      metadata[tf.interval] = tfResult.summary;
      for (const f of tfResult.findings) findings.push(f);
    }

    // ── Weekly timeframe — aggregated from daily bars (no native weekly OHLCV
    // on most providers). Gives macro-trend context and unlocks longer holding
    // horizons when the big picture aligns. Cached under the 1week key so the
    // confirmation gate (getOhlcvByTf) can re-run it through its own libs.
    const weeklyTf = TIMEFRAMES.find(t => t.weekly);
    if (weeklyTf && Array.isArray(dailyHistory) && dailyHistory.length >= MIN_BARS) {
      const weekly = aggregateWeekly(dailyHistory);
      if (weekly.length >= MIN_BARS) {
        this.ohlcvCache.set(`${sym}|1week`, { ts: Date.now(), history: weekly });
        const wRes = this.#computeForTimeframe(weekly, side, weeklyTf);
        metadata['1week'] = wRes.summary;
        for (const f of wRes.findings) findings.push(f);
      } else if (this.verbose) {
        console.log(`[ta] ${sym} weekly skipped — only ${weekly.length} weeks of daily history (<${MIN_BARS})`);
      }
    }

    // ── Long/Short ratio from Coinalyze ────────────────────────────────────
    // Extreme positioning beyond what funding alone shows. Coinalyze-perp only —
    // skipped for Bybit-fallback tokens (TA still runs; L/S just isn't available).
    if (perp) try {
      const fromTs = now - 6 * 3600;
      const lsData = await this.coinalyze.longShortRatio([perp], '1hour', fromTs, now);
      const series = lsData?.[0]?.history;
      if (Array.isArray(series) && series.length > 0) {
        const last = series[series.length - 1];
        // Coinalyze L/S structure varies — try common field names defensively
        const longPct  = Number(last.l ?? last.long_pct ?? last.long ?? NaN);
        const shortPct = Number(last.s ?? last.short_pct ?? last.short ?? NaN);
        let ratio = Number(last.r ?? last.ratio ?? NaN);
        if (!isFinite(ratio) && isFinite(longPct) && isFinite(shortPct) && shortPct > 0) {
          ratio = longPct / shortPct;
        }
        if (isFinite(ratio) && ratio > 0) {
          metadata.lsRatio = ratio;
          // Scale the credit by HOW FAR past the threshold the ratio sits
          // (audit §3.10) — a ratio of 1.71 is a marginal crossover and
          // shouldn't get the same +0.4 as a 3.5 (extreme one-sided
          // positioning). Each band maps its distance-past-threshold onto
          // [0,1] then × the 0.4 cap. ratio > 1 = more longs than shorts.
          const clamp01 = (x) => Math.max(0, Math.min(1, x));
          if (side === 'LONG' && ratio < 0.6) {
            const pts = Number((clamp01((0.6 - ratio) / 0.4) * 0.4).toFixed(2));
            if (pts > 0) findings.push({ kind: 'ta', text: `L/S ratio ${ratio.toFixed(2)} (shorts dominate — supports LONG via squeeze)`, points: pts });
          } else if (side === 'SHORT' && ratio > 1.7) {
            const pts = Number((clamp01((ratio - 1.7) / 2.0) * 0.4).toFixed(2));
            if (pts > 0) findings.push({ kind: 'ta', text: `L/S ratio ${ratio.toFixed(2)} (longs dominate — supports SHORT via squeeze)`, points: pts });
          } else if (side === 'LONG' && ratio > 2.5) {
            const pts = Number((clamp01((ratio - 2.5) / 2.0) * 0.4).toFixed(2));
            if (pts > 0) findings.push({ kind: 'ta', text: `L/S ratio ${ratio.toFixed(2)} (longs overextended — against LONG)`, points: -pts });
          } else if (side === 'SHORT' && ratio < 0.4) {
            const pts = Number((clamp01((0.4 - ratio) / 0.3) * 0.4).toFixed(2));
            if (pts > 0) findings.push({ kind: 'ta', text: `L/S ratio ${ratio.toFixed(2)} (shorts overextended — against SHORT)`, points: -pts });
          }
        }
      }
    } catch (err) {
      if (this.verbose) console.warn(`[ta] ${sym} L/S ratio fetch failed: ${err.message}`);
    }

    // Compact log so user can see what multi-TF observed
    const noteFor = (k) => {
      const m = metadata[k];
      if (!m) return `${k}=—`;
      const r = m.rsi != null ? `R${m.rsi.toFixed(0)}` : 'R?';
      const t = m.trend === 'up' ? '↑' : m.trend === 'down' ? '↓' : '·';
      return `${k}=${r}${t}`;
    };
    console.log(`[ta] ${sym} ${side} → ${findings.length} findings (${noteFor('5min')} ${noteFor('1hour')} ${noteFor('4hour')} ${noteFor('daily')} ${noteFor('1week')})`);

    const result = { findings, metadata };
    this.cache.set(cacheKey, { ts: Date.now(), result });
    if (this.cache.size > 500) {
      const t = Date.now();
      for (const [k, v] of this.cache) if (t - v.ts > this.cacheTtlMs * 5) this.cache.delete(k);
    }
    return result;
  }

  #computeForTimeframe(history, side, tf) {
    // Exclude the still-forming last bar from ALL indicator math (RSI/MACD/ATR/
    // BB/candles below, plus SMC + swings further down). Coinalyze's last bar is
    // the current, partway-through period; its close moves every poll, so a
    // finding computed on it flips on/off intrabar and can fire on a bar that
    // never closes there (accuracy audit D/§1-3). The wick + liq-grab blocks
    // already used history[-2] (the last CLOSED bar) — this makes the whole
    // function consistent. (`history` is kept intact for those blocks + the
    // wick-ratio, which slice their own closed windows.)
    const closed = history.length > 1 ? history.slice(0, -1) : history;
    const opens  = closed.map(b => parseFloat(b.o ?? b.open  ?? 0));
    const highs  = closed.map(b => parseFloat(b.h ?? b.high  ?? 0));
    const lows   = closed.map(b => parseFloat(b.l ?? b.low   ?? 0));
    const closes = closed.map(b => parseFloat(b.c ?? b.close ?? 0));
    const lastClose = closes[closes.length - 1];

    const findings = [];
    const w = tf.findingWeight ?? tf.weight;
    const lbl = tf.interval;

    // RSI
    let rsi = null;
    try {
      const series = RSI.calculate({ period: 14, values: closes });
      rsi = series[series.length - 1];
      if (typeof rsi === 'number' && isFinite(rsi)) {
        // Symmetric breakpoints at 30/70 for BOTH sides (audit §3.3). The old
        // code used 30/75 for LONG but 70/25 for SHORT — that asymmetry let
        // RSI in [70,75] credit SHORT while never penalising LONG, and is the
        // single cheapest contributor to the LONG=41% / SHORT=55% gap. Now
        // mirror-image: support at the oversold/overbought extreme, warning at
        // the opposite extreme.
        // SUPPORTING RSI (oversold for LONG / overbought for SHORT) — credit now.
        if      (side === 'LONG'  && rsi < 30) findings.push({ kind: 'ta', text: `RSI ${rsi.toFixed(1)} oversold (${lbl})`,   points: w });
        else if (side === 'SHORT' && rsi > 70) findings.push({ kind: 'ta', text: `RSI ${rsi.toFixed(1)} overbought (${lbl})`, points: w });
        // The AGAINST case (overbought-vs-LONG / oversold-vs-SHORT) is DEFERRED
        // until the TF trend is known (below) so it can be SOFTENED when the move
        // is a trend CONTINUATION — RSI sits overbought for weeks in a real
        // uptrend, and full-penalising it crushed strong trend-aligned signals
        // (the STG case: daily RSI 70.8 → -0.5 on a 5/6-TF, negative-funding LONG).
      }
      // RSI DIVERGENCE — reuse the series just computed. HTF only (noise on 1m/5m).
      if (RSI_DIVERGENCE && (lbl === '1hour' || lbl === '4hour' || lbl === 'daily' || lbl === '1week') && series.length >= 12) {
        const aligned = new Array(closes.length).fill(null);
        const off = closes.length - series.length;          // RSI(14) warmup offset
        for (let k = 0; k < series.length; k++) aligned[k + off] = series[k];
        const div = detectRsiDivergence(side === 'SHORT' ? highs : lows, aligned, side);
        if (div) {
          findings.push({
            kind: 'divergence',
            text: `RSI ${div.kind === 'bull' ? 'bullish' : 'bearish'} divergence (${lbl}) — price ${div.kind === 'bull' ? 'lower low' : 'higher high'} but RSI ${div.kind === 'bull' ? 'higher low' : 'lower high'} (reversal building)`,
            points: w * DIVERGENCE_MULT
          });
        }
      }
    } catch { /* needs ≥15 bars */ }

    // MACD — skip on 1m (too noisy, whipsaws constantly)
    let macdHist = null;
    let trend = 'flat';
    if (lbl !== '1min') {
    try {
      const series = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false
      });
      const last = series[series.length - 1];
      const prev = series[series.length - 2];
      if (last && prev) {
        macdHist = last.histogram ?? null;
        // TREND must come from the MACD LINE sign (fast EMA vs slow EMA = direction),
        // NOT the histogram (MACD − signal = acceleration). On a steady DOWNtrend the
        // MACD line is negative but rising toward its signal, so the histogram turns
        // POSITIVE — which mislabelled clean downtrends as 'up'. Verified ~54% accurate
        // (histogram) vs ~96% (line). This `trend` drives ~96% of the multi-TF
        // alignment weight, OI direction, and the counter-trend vetoes, so the old bug
        // made the whole TA confluence a coin flip. The histogram still feeds the
        // 'MACD hist rising/falling' momentum findings below — it just no longer sets trend.
        if (last.MACD != null) {
          if (last.MACD > 0) trend = 'up';
          else if (last.MACD < 0) trend = 'down';
        }
        const bullCross = prev.MACD < prev.signal && last.MACD > last.signal;
        const bearCross = prev.MACD > prev.signal && last.MACD < last.signal;
        const histRising  = (last.histogram ?? 0) > (prev.histogram ?? 0);
        const histFalling = (last.histogram ?? 0) < (prev.histogram ?? 0);
        if (side === 'LONG' && bullCross) {
          findings.push({ kind: 'ta', text: `MACD bull cross (${lbl})`, points: w });
        } else if (side === 'LONG' && histRising && last.histogram > 0) {
          findings.push({ kind: 'ta', text: `MACD hist rising (${lbl})`, points: w * 0.6 });
        } else if (side === 'SHORT' && bearCross) {
          findings.push({ kind: 'ta', text: `MACD bear cross (${lbl})`, points: w });
        } else if (side === 'SHORT' && histFalling && last.histogram < 0) {
          findings.push({ kind: 'ta', text: `MACD hist falling (${lbl})`, points: w * 0.6 });
        }
      }
    } catch { /* needs ≥35 bars */ }
    }   // end MACD-skip-on-1m

    // For 1m specifically, derive `trend` from price-vs-20-bar-mean instead
    // of MACD (which whipsaws on 1m). A 0.1% deadband suppresses chop.
    // This lets the 1m TF participate in alignment counting as an early
    // timing signal without injecting noise.
    if (lbl === '1min' && closes.length >= 20) {
      const last20 = closes.slice(-20);
      const mean20 = last20.reduce((a, b) => a + b, 0) / last20.length;
      const buffer = mean20 * 0.001;        // 0.1% deadband
      if (lastClose > mean20 + buffer)      trend = 'up';
      else if (lastClose < mean20 - buffer) trend = 'down';
      // else stays 'flat'
    }

    // RSI-AGAINST penalty (deferred from the RSI block, now that `trend` is
    // known). Overbought-vs-LONG / oversold-vs-SHORT is a REVERSAL warning only
    // when it ISN'T a trend continuation. When THIS TF is already trending WITH
    // the trade, the extreme RSI is momentum, not exhaustion → soften the penalty
    // (×RSI_AGAINST_TREND_MULT, default 0.4 = 60% lighter). Multi-TF blow-off
    // tops are still caught by the separate exhaustion gate (reads RSI from
    // metadata, unaffected here). RSI_AGAINST_TREND_MULT=1 reverts to full penalty.
    if (typeof rsi === 'number' && isFinite(rsi)) {
      const against = (side === 'LONG' && rsi > 70) || (side === 'SHORT' && rsi < 30);
      if (against) {
        const trendWith = (side === 'LONG' && trend === 'up') || (side === 'SHORT' && trend === 'down');
        // A BLOW-OFF extreme (RSI ≥85 / ≤15) is NOT continuation — never soften it.
        const blowoff = side === 'LONG' ? rsi >= RSI_BLOWOFF_OB : rsi <= RSI_BLOWOFF_OS;
        const soften = trendWith && !blowoff;
        const pts = soften ? -w * RSI_AGAINST_TREND_MULT : -w;
        const label = side === 'LONG' ? 'overbought' : 'oversold';
        const note = soften
          ? `${lbl} — but ${lbl} trending ${trend} (continuation, penalty softened)`
          : blowoff
            ? `${lbl} ⚠️ BLOW-OFF extreme — full penalty${trendWith ? ' (not continuation)' : ''}`
            : `${lbl} — against ${side}`;
        findings.push({ kind: 'ta', text: `RSI ${rsi.toFixed(1)} ${label} ${note}`, points: pts });
      }
    }

    // ATR — computed here (before wick analysis) so the wick gate can compare
    // wick size against true range rather than against body alone.
    let atr = null;
    try {
      const series = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      atr = series[series.length - 1];
      if (!isFinite(atr)) atr = null;
    } catch { /* needs ≥15 bars */ }

    // ── Wick analysis (1m, 5min, 1hour) ────────────────────────────────────
    // Large wicks vs body = absorption/rejection at price extremes:
    //   • Long lower wick → buyers absorbed sellers at the low (bullish)
    //   • Long upper wick → sellers absorbed buyers at the high (bearish)
    // Side-specific scoring so a "rejection wick" in our favor helps and
    // an "exhaustion wick" against us subtracts.
    //
    // Audit §3.7 + §6.4 fixes:
    //   1. Use the last CLOSED bar (history[-2]), NOT the still-forming bar —
    //      a forming bar has a tiny body so the wick/body ratio explodes and
    //      every tick produced a spurious "strong wick".
    //   2. Require a real body (> 0.1% of close) before trusting the ratio.
    //   3. Gate the wick on ATR — the wick must be a meaningful fraction of
    //      true range (≥ 0.5× ATR) to count as genuine absorption.
    //   4. Halve all wick points (this factor measured 38% win-rate) until it
    //      re-proves itself on the cleaned-up logic.
    if (lbl === '1min' || lbl === '5min' || lbl === '1hour') {
      const lastBar = history[history.length - 2];   // last CLOSED bar
      if (lastBar) {
        const o = parseFloat(lastBar.o ?? lastBar.open  ?? 0);
        const h = parseFloat(lastBar.h ?? lastBar.high  ?? 0);
        const l = parseFloat(lastBar.l ?? lastBar.low   ?? 0);
        const c = parseFloat(lastBar.c ?? lastBar.close ?? 0);
        const body = Math.abs(c - o);
        const upperWick = h - Math.max(o, c);
        const lowerWick = Math.min(o, c) - l;
        const minBody = c * 0.001;                    // 0.1% of close
        const wickFloor = atr ? atr * 0.5 : 0;        // wick must clear ½ ATR
        if (body > minBody) {
          const uwRatio = upperWick / body;
          const lwRatio = lowerWick / body;
          const lwBig = lwRatio >= 2 && lowerWick >= wickFloor;
          const uwBig = uwRatio >= 2 && upperWick >= wickFloor;
          // 2× body = "strong wick", 4× body = "violent wick" (points halved)
          if (side === 'LONG' && lwBig) {
            const pts = lwRatio >= 4 ? w * 0.5 : w * 0.3;
            findings.push({ kind: 'wick', text: `Strong lower wick ${lwRatio.toFixed(1)}× body (${lbl}) — buyers absorbed sellers`, points: pts });
          } else if (side === 'LONG' && uwBig) {
            findings.push({ kind: 'wick', text: `Upper wick ${uwRatio.toFixed(1)}× body (${lbl}) — rejection at top, against LONG`, points: -w * 0.25 });
          } else if (side === 'SHORT' && uwBig) {
            const pts = uwRatio >= 4 ? w * 0.5 : w * 0.3;
            findings.push({ kind: 'wick', text: `Strong upper wick ${uwRatio.toFixed(1)}× body (${lbl}) — sellers absorbed buyers`, points: pts });
          } else if (side === 'SHORT' && lwBig) {
            findings.push({ kind: 'wick', text: `Lower wick ${lwRatio.toFixed(1)}× body (${lbl}) — rejection at bottom, against SHORT`, points: -w * 0.25 });
          }
        }
      }
    }

    // ── Liquidity grab pattern (5m, 1h, 4h) ───────────────────────────
    // Real liquidity grab detection — what traders see on the chart:
    //   Bearish grab: a recent bar's HIGH pierces above the prior swing
    //     high (sweeps stops sitting above the level), but the bar CLOSES
    //     back below the swing high. No follow-through → reversal pattern,
    //     SHORT bias.
    //   Bullish grab: mirror — recent bar's LOW pierces below the prior
    //     swing low (sweeps short stops), but closes back above. → LONG.
    //
    // Score: +1.2× TF weight when aligned with side (strong reversal signal),
    // −0.6× when against side (recent grab pointing the other way).
    if ((lbl === '5min' || lbl === '1hour' || lbl === '4hour') && history.length >= 26) {
      const lookback = 20;
      const window = 3;
      // Exclude the still-forming last bar (audit §3.12): a sweep is only
      // confirmed once the bar that pierced-and-rejected has CLOSED. The
      // reference swing window and the "recent" window are both shifted back
      // by one so detection runs on closed bars only.
      const refBars = history.slice(-(lookback + window + 1), -(window + 1));
      const refHighs = refBars.map(b => parseFloat(b.h ?? b.high ?? 0));
      const refLows  = refBars.map(b => parseFloat(b.l ?? b.low  ?? 0));
      const swingHigh = Math.max(...refHighs);
      const swingLow  = Math.min(...refLows);
      const recentBars = history.slice(-(window + 1), -1);
      const bearishGrab = recentBars.some(b => {
        const bh = parseFloat(b.h ?? b.high  ?? 0);
        const bc = parseFloat(b.c ?? b.close ?? 0);
        return bh > swingHigh && bc < swingHigh;
      });
      const bullishGrab = recentBars.some(b => {
        const bl = parseFloat(b.l ?? b.low   ?? 0);
        const bc = parseFloat(b.c ?? b.close ?? 0);
        return bl < swingLow && bc > swingLow;
      });
      if (side === 'SHORT' && bearishGrab) {
        findings.push({
          kind: 'liqGrab',
          text: `Bearish liq grab — stops above swing high swept then rejected (${lbl})`,
          points: w * 1.2
        });
      } else if (side === 'LONG' && bullishGrab) {
        findings.push({
          kind: 'liqGrab',
          text: `Bullish liq grab — stops below swing low swept then bought back (${lbl})`,
          points: w * 1.2
        });
      } else if (side === 'LONG' && bearishGrab) {
        findings.push({
          kind: 'liqGrab',
          text: `Recent bearish grab on ${lbl} — supply still in control, against LONG`,
          points: -w * 0.6
        });
      } else if (side === 'SHORT' && bullishGrab) {
        findings.push({
          kind: 'liqGrab',
          text: `Recent bullish grab on ${lbl} — demand absorbed, against SHORT`,
          points: -w * 0.6
        });
      }
    }

    // Bollinger Bands (only adds findings on shorter TFs to avoid clutter)
    if (lbl === '5min' || lbl === '1hour') {
      try {
        const series = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        const last = series[series.length - 1];
        if (last && typeof lastClose === 'number') {
          const width = last.upper - last.lower;
          if (width > 0) {
            const pctB = (lastClose - last.lower) / width;
            if      (side === 'LONG'  && pctB < 0.1) findings.push({ kind: 'ta', text: `Price at lower BB (${lbl})`, points: w * 0.5 });
            else if (side === 'SHORT' && pctB > 0.9) findings.push({ kind: 'ta', text: `Price at upper BB (${lbl})`, points: w * 0.5 });
          }
        }
      } catch { /* needs ≥20 bars */ }
    }

    // (ATR already computed above the wick block so wicks can be gated on it.)

    // Candle patterns (only on 5m and 1h — daily/4h patterns need full strategies)
    if (lbl === '5min' || lbl === '1hour') {
      const last5 = {
        open:  opens.slice(-5),
        high:  highs.slice(-5),
        low:   lows.slice(-5),
        close: closes.slice(-5)
      };
      try {
        // technicalindicators' bullish()/bearish() internally run EVERY
        // candlestick strategy; the multi-bar ones (MorningStar, TweezerBottom,
        // DownsideTasukiGap...) spam console.warn "Data count less than data
        // required" on our 5-bar window. Silence console during the call so
        // logs stay readable — detection behaviour is unchanged.
        const isBull = side === 'LONG'  && withSilencedConsole(() => bullish?.(last5));
        const isBear = side === 'SHORT' && withSilencedConsole(() => bearish?.(last5));
        if      (isBull) findings.push({ kind: 'ta', text: `Bullish candle pattern (${lbl})`, points: w * 0.6 });
        else if (isBear) findings.push({ kind: 'ta', text: `Bearish candle pattern (${lbl})`, points: w * 0.6 });
      } catch { /* library quirks */ }
    }

    // Recent wick-to-body ratio over last 10 bars. Higher ratio = choppier
    // token (frequent wicks vs body). Conductor uses this to widen SL on
    // volatile assets so noise wicks don't stop trades out.
    let recentWickRatio = null;
    if (history.length >= 10) {
      const recentBars = history.slice(-10);
      let totalWick = 0, totalBody = 0;
      for (const b of recentBars) {
        const bO = parseFloat(b.o ?? b.open  ?? 0);
        const bH = parseFloat(b.h ?? b.high  ?? 0);
        const bL = parseFloat(b.l ?? b.low   ?? 0);
        const bC = parseFloat(b.c ?? b.close ?? 0);
        const body  = Math.abs(bC - bO);
        const upper = bH - Math.max(bO, bC);
        const lower = Math.min(bO, bC) - bL;
        totalWick += (upper + lower);
        totalBody += body;
      }
      if (totalBody > 0) recentWickRatio = totalWick / totalBody;
    }

    // ── SMC structure (BOS/CHoCH/double-top/sweep) ──────────────────────
    // Skip 1m (whipsaws constantly) and run on 5m/1h/4h/daily. Each finding
    // includes a `.smc.side` tag — we only accept findings that match the
    // side being analysed (a bullish CHoCH on a SHORT analysis is just
    // counter-evidence; the conductor already penalizes that via the
    // confirmation gate, so we don't double-dip here).
    if (lbl !== '1min') {
      try {
        const smc = analyzeSmc(closed, { tfLabel: lbl, weight: w });
        for (const f of smc.findings ?? []) {
          if (f.smc?.side && f.smc.side !== side) continue;     // only same-side
          findings.push(f);
        }
      } catch { /* SMC needs ≥ 9 bars; some TFs may not have enough */ }
    }

    // Full swing list — every fractal swing high/low detected on this TF.
    // The Conductor's trade-plan builder uses these as TP candidates: each
    // TP gets SNAPPED to the nearest swing extreme in the trade direction
    // (within an R-multiple tolerance band), so exits land on real chart
    // structure instead of arbitrary ATR multiples. Empty arrays are safe;
    // caller falls back to math TPs when no structure is in range.
    let swings = { highs: [], lows: [] };
    try {
      swings = findSwings(closed);
    } catch { /* small histories may not produce swings */ }

    return {
      findings,
      summary: {
        atr, rsi, macdHist, trend, lastClose, recentWickRatio,
        // Single "nearest structural swing" (used by LG limit-entry + the
        // structure-aware SL in conductor.js). Prefer the MOST RECENT fractal
        // pivot (a swing the market actually respects) over the raw 20-bar
        // min/max — the window extreme is often a lone spike/wick that makes a
        // bad limit/SL anchor (accuracy audit D/§5). Fall back to the window
        // extreme only when no pivot has formed yet.
        swingHigh: swings.highs.length ? swings.highs[swings.highs.length - 1].price
                 : (highs.length >= 20 ? Math.max(...highs.slice(-20)) : (highs.length ? Math.max(...highs) : null)),
        swingLow:  swings.lows.length ? swings.lows[swings.lows.length - 1].price
                 : (lows.length >= 20 ? Math.min(...lows.slice(-20)) : (lows.length ? Math.min(...lows) : null)),
        // All swings on this TF (price levels only — idx not needed downstream)
        swingHighs: swings.highs.map(s => s.price),
        swingLows:  swings.lows.map(s => s.price)
      }
    };
  }
}
