

import { RSI, MACD, BollingerBands, EMA } from 'trading-signals';
import { ichimokuCloud } from 'indicatorts';
import * as candlestick from 'candlestick';
import { TF_CONFIRM_WEIGHTS } from './timeframes.js';

const HARD_VETO_RSI_HI = 80;
const HARD_VETO_RSI_LO = 20;

const RSI_NEUTRAL_LO = 45;
const RSI_NEUTRAL_HI = 55;

const TF_WEIGHTS = TF_CONFIRM_WEIGHTS;

function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v.toString === 'function') return Number(v.toString());
  return Number(v);
}

export function confirmSignal({ side, ohlcvByTf, dropThreshold = -2.5, allowExhaustionShort = false, allowExhaustionLong = false }) {
  if (!side || !ohlcvByTf) return { drop: false, tally: 0, notes: ['no ohlcv'], vetoReasons: [], reason: 'no input' };

  let tally = 0;
  const notes = [];
  const vetoReasons = [];

  for (const [tf, bars] of Object.entries(ohlcvByTf)) {
    if (!Array.isArray(bars) || bars.length < 30) continue;
    const w = TF_WEIGHTS[tf] ?? 0.5;

    const closedBars = bars.length > 1 ? bars.slice(0, -1) : bars;
    const closes = closedBars.map(b => Number(b.c ?? b.close)).filter(isFinite);
    const highs  = closedBars.map(b => Number(b.h ?? b.high)).filter(isFinite);
    const lows   = closedBars.map(b => Number(b.l ?? b.low)).filter(isFinite);
    if (closes.length < 29) continue;

    try {
      const rsi = new RSI(14);
      for (const c of closes) rsi.update(c, false);
      const v = toNumber(rsi.getResult());
      if (isFinite(v)) {

        if (tf === '4hour' || tf === 'daily') {
          if (side === 'SHORT' && v >= HARD_VETO_RSI_HI) {

            if (allowExhaustionShort) {
              tally += w * 0.5;
              notes.push(`${tf} RSI ${v.toFixed(0)} ⚠️ overbought — exhaustion-reversal override (+${(w*0.5).toFixed(1)})`);
              continue;
            }
            tally -= 2 * w;
            vetoReasons.push(`RSI ${v.toFixed(0)} ${tf} too overbought to SHORT (momentum risk)`);
            notes.push(`${tf} RSI ${v.toFixed(0)} ✗ veto SHORT (-${(2*w).toFixed(1)})`);
            continue;
          }
          if (side === 'LONG' && v <= HARD_VETO_RSI_LO) {

            if (allowExhaustionLong) {
              tally += w * 0.5;
              notes.push(`${tf} RSI ${v.toFixed(0)} ⚠️ oversold — exhaustion-reversal override (+${(w*0.5).toFixed(1)})`);
              continue;
            }
            tally -= 2 * w;
            vetoReasons.push(`RSI ${v.toFixed(0)} ${tf} too oversold to LONG (capitulation risk)`);
            notes.push(`${tf} RSI ${v.toFixed(0)} ✗ veto LONG (-${(2*w).toFixed(1)})`);
            continue;
          }
        }

        if (v >= RSI_NEUTRAL_LO && v <= RSI_NEUTRAL_HI) {
          notes.push(`${tf} RSI ${v.toFixed(0)} · neutral (0)`);
        } else if (side === 'LONG' && v < RSI_NEUTRAL_LO) { tally += w; notes.push(`${tf} RSI ${v.toFixed(0)} ✓ LONG (+${w})`); }
        else if (side === 'SHORT' && v > RSI_NEUTRAL_HI) { tally += w; notes.push(`${tf} RSI ${v.toFixed(0)} ✓ SHORT (+${w})`); }
        else { tally -= w * 0.5; notes.push(`${tf} RSI ${v.toFixed(0)} ✗ (-${(w*0.5).toFixed(1)})`); }
      }
    } catch {}

    try {
      const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
      for (const c of closes) macd.update(c, false);
      const hist = toNumber(macd.getResult().histogram);
      if (isFinite(hist)) {
        if (side === 'LONG' && hist > 0) { tally += w; notes.push(`${tf} MACD+ ✓ LONG (+${w})`); }
        else if (side === 'SHORT' && hist < 0) { tally += w; notes.push(`${tf} MACD- ✓ SHORT (+${w})`); }
        else { tally -= w * 0.5; notes.push(`${tf} MACD ✗ (-${(w*0.5).toFixed(1)})`); }
      }
    } catch {}

    try {
      const bb = new BollingerBands(20, 2);
      for (const c of closes) bb.update(c, false);
      const r = bb.getResult();
      const upper = toNumber(r.upper);
      const lower = toNumber(r.lower);
      const px = closes[closes.length - 1];
      if (isFinite(upper) && isFinite(lower) && isFinite(px) && upper > lower) {
        const pctB = (px - lower) / (upper - lower);

        if (side === 'SHORT' && pctB > 0.95) { tally += w; notes.push(`${tf} BB upper-band ✓ SHORT mean-revert (+${w})`); }
        else if (side === 'LONG' && pctB < 0.05) { tally += w; notes.push(`${tf} BB lower-band ✓ LONG mean-revert (+${w})`); }
        else if (side === 'SHORT' && pctB > 0.7) { tally += w * 0.5; notes.push(`${tf} BB upper-half ✓ SHORT (+${(w*0.5).toFixed(1)})`); }
        else if (side === 'LONG' && pctB < 0.3) { tally += w * 0.5; notes.push(`${tf} BB lower-half ✓ LONG (+${(w*0.5).toFixed(1)})`); }
      }
    } catch {}

    if (tf === '1hour' || tf === '4hour' || tf === 'daily' || tf === '1week') {
      try {
        const cloud = ichimokuCloud(highs, lows, closes);
        const tenkanArr = cloud?.tenkan ?? [];
        const kijunArr  = cloud?.kijun  ?? [];
        const tenkan = tenkanArr[tenkanArr.length - 1];
        const kijun  = kijunArr[kijunArr.length - 1];
        const px = closes[closes.length - 1];
        if (isFinite(tenkan) && isFinite(kijun) && isFinite(px)) {
          const bullish = tenkan > kijun && px > kijun;
          const bearish = tenkan < kijun && px < kijun;
          if (side === 'LONG' && bullish) { tally += w; notes.push(`${tf} Ichimoku ✓ LONG (+${w})`); }
          else if (side === 'SHORT' && bearish) { tally += w; notes.push(`${tf} Ichimoku ✓ SHORT (+${w})`); }
          else if (side === 'LONG' && bearish) { tally -= w; notes.push(`${tf} Ichimoku ✗ LONG (-${w})`); }
          else if (side === 'SHORT' && bullish) { tally -= w; notes.push(`${tf} Ichimoku ✗ SHORT (-${w})`); }
        }
      } catch {}
    }
  }

  const patternTf = ohlcvByTf['1hour'] ?? ohlcvByTf['4hour'] ?? ohlcvByTf['5min'];
  if (Array.isArray(patternTf) && patternTf.length >= 4) {

    const last3 = patternTf.slice(-4, -1).map(b => ({
      open:  Number(b.o ?? b.open),
      high:  Number(b.h ?? b.high),
      low:   Number(b.l ?? b.low),
      close: Number(b.c ?? b.close)
    }));
    try {

      if (candlestick.isBullishHammer?.(last3[2])) {
        if (side === 'LONG') { tally += 1; notes.push('1h bullish hammer ✓ LONG'); }
        else                 { tally -= 1; notes.push('1h bullish hammer ✗ SHORT'); }
      }
      if (candlestick.isBearishHammer?.(last3[2])) {
        if (side === 'SHORT') { tally += 1; notes.push('1h bearish hammer ✓ SHORT'); }
        else                  { tally -= 1; notes.push('1h bearish hammer ✗ LONG'); }
      }

      if (candlestick.isBullishEngulfing?.(last3[1], last3[2])) {
        if (side === 'LONG') { tally += 1; notes.push('1h bullish engulfing ✓ LONG'); }
        else                 { tally -= 1; notes.push('1h bullish engulfing ✗ SHORT'); }
      }
      if (candlestick.isBearishEngulfing?.(last3[1], last3[2])) {
        if (side === 'SHORT') { tally += 1; notes.push('1h bearish engulfing ✓ SHORT'); }
        else                  { tally -= 1; notes.push('1h bearish engulfing ✗ LONG'); }
      }

      if (candlestick.isMorningStar?.(last3[0], last3[1], last3[2])) {
        if (side === 'LONG') { tally += 1.5; notes.push('1h morning star ✓ LONG'); }
        else                 { tally -= 1.5; notes.push('1h morning star ✗ SHORT'); }
      }
      if (candlestick.isEveningStar?.(last3[0], last3[1], last3[2])) {
        if (side === 'SHORT') { tally += 1.5; notes.push('1h evening star ✓ SHORT'); }
        else                  { tally -= 1.5; notes.push('1h evening star ✗ LONG'); }
      }
    } catch {}
  }

  const drop = vetoReasons.length > 0 || tally <= dropThreshold;
  return {
    drop,
    tally: Number(tally.toFixed(2)),
    notes,
    vetoReasons,
    reason: drop
      ? (vetoReasons[0] ?? `confirmation tally ${tally.toFixed(1)} ≤ ${dropThreshold}`)
      : `confirmed (tally ${tally.toFixed(1)})`
  };
}
