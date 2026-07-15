

import pkg from 'technicalindicators';
const { RSI, MACD, BollingerBands, ATR, bullish, bearish } = pkg;
import { analyzeSmc, findSwings } from './smc.js';
import { TIMEFRAMES, FETCH_INTERVALS, MIN_BARS, aggregateWeekly } from './timeframes.js';
import { OKX_BAR } from './okx.js';

const RSI_AGAINST_TREND_MULT = (() => { const v = Number(process.env.RSI_AGAINST_TREND_MULT); return isFinite(v) ? v : 0.4; })();

const RSI_BLOWOFF_OB = (() => { const v = Number(process.env.RSI_BLOWOFF_OB); return isFinite(v) ? v : 85; })();
const RSI_BLOWOFF_OS = (() => { const v = Number(process.env.RSI_BLOWOFF_OS); return isFinite(v) ? v : 15; })();

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
  const [b, a] = pivots;
  if (b.i - a.i < minApart) return null;
  if (wantHigh  && b.price > a.price && b.rsi < a.rsi) return { kind: 'bear', dPrice: b.price - a.price, dRsi: b.rsi - a.rsi };
  if (!wantHigh && b.price < a.price && b.rsi > a.rsi) return { kind: 'bull', dPrice: b.price - a.price, dRsi: b.rsi - a.rsi };
  return null;
}

function withSilencedConsole(fn) {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log; console.warn = warn; console.error = error;
  }
}

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

export class TAService {
  constructor({ coinalyze, perpSymbolMap, cacheTtlMs = 60_000, okx = null, okxSwapMap = null }) {
    this.coinalyze = coinalyze;
    this.perpSymbolMap = perpSymbolMap;

    this.okx = okx;
    this.okxSwapMap = okxSwapMap;
    this.okxSymCache = new Map();
    this.cache = new Map();
    this.cacheTtlMs = cacheTtlMs;
    this.volumeCache = new Map();

    this.ohlcvCache = new Map();
    this.pendingOhlcv = new Map();
  }

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

          try {
            const data = await this.coinalyze.ohlcvHistory([perp], tf.interval, now - tf.lookbackSec, now);
            history = data?.[0]?.history ?? [];
          } catch { history = []; }
        }

        if ((!Array.isArray(history) || history.length === 0) && this.okx) {
          const bar = OKX_BAR[tf.interval];
          if (bar) {
            const inst = this.#okxInstId(symbol);
            let bars = await this.okx.getCandles(inst, bar, 300);

            if ((!bars || !bars.length) && !inst.endsWith('-USDT')) {
              bars = await this.okx.getCandles(`${String(symbol).toUpperCase()}-USDT`, bar, 300);
            }
            if (bars && bars.length) history = bars;
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

  async getLastPerpPrice(symbol) {
    const sym = (symbol ?? '').toUpperCase();
    const perp = this.perpSymbolMap?.get(sym);
    if (!perp) return null;

    const cached = this.livePriceCache?.get(sym);
    if (cached && Date.now() - cached.ts < 3000) return cached.price;

    if (this.okx) {
      try {
        const last = await this.okx.getTickerLast(this.#okxInstId(sym));
        if (isFinite(last) && last > 0) {
          if (!this.livePriceCache) this.livePriceCache = new Map();
          this.livePriceCache.set(sym, { ts: Date.now(), price: last });
          return last;
        }
      } catch {  }
    }

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

  async getRecentBars(symbol, fromTs, toTs) {
    const sym = (symbol ?? '').toUpperCase();

    if (this.okx) {
      try {
        const bars = await this.okx.getCandles(this.#okxInstId(sym), '1m', 300);
        if (bars && bars.length) {
          const win = bars
            .filter((b) => b.t >= fromTs && b.t <= toTs)
            .map((b) => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
          if (win.length) return win;
        }
      } catch {  }
    }

    const perp = this.perpSymbolMap?.get(sym);
    if (!this.coinalyze || !perp) return null;
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

  #okxInstId(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return `${sym}-USDT-SWAP`;
    if (this.okxSymCache.has(sym)) return this.okxSymCache.get(sym);
    const inst = this.okxSwapMap?.get(sym) || `${sym}-USDT-SWAP`;
    this.okxSymCache.set(sym, inst);
    return inst;
  }

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

  async registerSymbol(symbol, { fresh = false } = {}) {
    const sym = (symbol ?? '').toUpperCase();
    if (!sym || !this.coinalyze || !this.perpSymbolMap) return false;
    if (this.perpSymbolMap.has(sym)) return true;
    try {

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

    if (!perp && !this.okx) return { findings: [], metadata: null };

    const cacheKey = `${sym}|${side}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.result;

    const findings = [];
    const metadata = {};
    const now = Math.floor(Date.now() / 1000);

    let dailyHistory = null;

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

    if (perp) try {
      const fromTs = now - 6 * 3600;
      const lsData = await this.coinalyze.longShortRatio([perp], '1hour', fromTs, now);
      const series = lsData?.[0]?.history;
      if (Array.isArray(series) && series.length > 0) {
        const last = series[series.length - 1];

        const longPct  = Number(last.l ?? last.long_pct ?? last.long ?? NaN);
        const shortPct = Number(last.s ?? last.short_pct ?? last.short ?? NaN);
        let ratio = Number(last.r ?? last.ratio ?? NaN);
        if (!isFinite(ratio) && isFinite(longPct) && isFinite(shortPct) && shortPct > 0) {
          ratio = longPct / shortPct;
        }
        if (isFinite(ratio) && ratio > 0) {
          metadata.lsRatio = ratio;

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

    const closed = history.length > 1 ? history.slice(0, -1) : history;
    const opens  = closed.map(b => parseFloat(b.o ?? b.open  ?? 0));
    const highs  = closed.map(b => parseFloat(b.h ?? b.high  ?? 0));
    const lows   = closed.map(b => parseFloat(b.l ?? b.low   ?? 0));
    const closes = closed.map(b => parseFloat(b.c ?? b.close ?? 0));
    const lastClose = closes[closes.length - 1];

    const findings = [];
    const w = tf.findingWeight ?? tf.weight;
    const lbl = tf.interval;

    let rsi = null;
    try {
      const series = RSI.calculate({ period: 14, values: closes });
      rsi = series[series.length - 1];
      if (typeof rsi === 'number' && isFinite(rsi)) {

        if      (side === 'LONG'  && rsi < 30) findings.push({ kind: 'ta', text: `RSI ${rsi.toFixed(1)} oversold (${lbl})`,   points: w });
        else if (side === 'SHORT' && rsi > 70) findings.push({ kind: 'ta', text: `RSI ${rsi.toFixed(1)} overbought (${lbl})`, points: w });

      }

      if (RSI_DIVERGENCE && (lbl === '1hour' || lbl === '4hour' || lbl === 'daily' || lbl === '1week') && series.length >= 12) {
        const aligned = new Array(closes.length).fill(null);
        const off = closes.length - series.length;
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
    } catch {  }

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
    } catch {  }
    }

    if (lbl === '1min' && closes.length >= 20) {
      const last20 = closes.slice(-20);
      const mean20 = last20.reduce((a, b) => a + b, 0) / last20.length;
      const buffer = mean20 * 0.001;
      if (lastClose > mean20 + buffer)      trend = 'up';
      else if (lastClose < mean20 - buffer) trend = 'down';

    }

    if (typeof rsi === 'number' && isFinite(rsi)) {
      const against = (side === 'LONG' && rsi > 70) || (side === 'SHORT' && rsi < 30);
      if (against) {
        const trendWith = (side === 'LONG' && trend === 'up') || (side === 'SHORT' && trend === 'down');

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

    let atr = null;
    try {
      const series = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      atr = series[series.length - 1];
      if (!isFinite(atr)) atr = null;
    } catch {  }

    if (lbl === '1min' || lbl === '5min' || lbl === '1hour') {
      const lastBar = history[history.length - 2];
      if (lastBar) {
        const o = parseFloat(lastBar.o ?? lastBar.open  ?? 0);
        const h = parseFloat(lastBar.h ?? lastBar.high  ?? 0);
        const l = parseFloat(lastBar.l ?? lastBar.low   ?? 0);
        const c = parseFloat(lastBar.c ?? lastBar.close ?? 0);
        const body = Math.abs(c - o);
        const upperWick = h - Math.max(o, c);
        const lowerWick = Math.min(o, c) - l;
        const minBody = c * 0.001;
        const wickFloor = atr ? atr * 0.5 : 0;
        if (body > minBody) {
          const uwRatio = upperWick / body;
          const lwRatio = lowerWick / body;
          const lwBig = lwRatio >= 2 && lowerWick >= wickFloor;
          const uwBig = uwRatio >= 2 && upperWick >= wickFloor;

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

    if ((lbl === '5min' || lbl === '1hour' || lbl === '4hour') && history.length >= 26) {
      const lookback = 20;
      const window = 3;

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
      } catch {  }
    }

    if (lbl === '5min' || lbl === '1hour') {
      const last5 = {
        open:  opens.slice(-5),
        high:  highs.slice(-5),
        low:   lows.slice(-5),
        close: closes.slice(-5)
      };
      try {

        const isBull = side === 'LONG'  && withSilencedConsole(() => bullish?.(last5));
        const isBear = side === 'SHORT' && withSilencedConsole(() => bearish?.(last5));
        if      (isBull) findings.push({ kind: 'ta', text: `Bullish candle pattern (${lbl})`, points: w * 0.6 });
        else if (isBear) findings.push({ kind: 'ta', text: `Bearish candle pattern (${lbl})`, points: w * 0.6 });
      } catch {  }
    }

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

    if (lbl !== '1min') {
      try {
        const smc = analyzeSmc(closed, { tfLabel: lbl, weight: w });
        for (const f of smc.findings ?? []) {
          if (f.smc?.side && f.smc.side !== side) continue;
          findings.push(f);
        }
      } catch {  }
    }

    let swings = { highs: [], lows: [] };
    try {
      swings = findSwings(closed);
    } catch {  }

    return {
      findings,
      summary: {
        atr, rsi, macdHist, trend, lastClose, recentWickRatio,

        swingHigh: swings.highs.length ? swings.highs[swings.highs.length - 1].price
                 : (highs.length >= 20 ? Math.max(...highs.slice(-20)) : (highs.length ? Math.max(...highs) : null)),
        swingLow:  swings.lows.length ? swings.lows[swings.lows.length - 1].price
                 : (lows.length >= 20 ? Math.min(...lows.slice(-20)) : (lows.length ? Math.min(...lows) : null)),

        swingHighs: swings.highs.map(s => s.price),
        swingLows:  swings.lows.map(s => s.price)
      }
    };
  }
}
