// TA confirmation gate.
//
// Cross-validates a candidate signal against an independent set of
// indicator libraries before we emit. The existing TAService runs
// `technicalindicators` (RSI/MACD/BB/ATR/ADX); this module re-runs the
// same OHLCV through:
//   • trading-signals    (RSI, MACD, BollingerBands)
//   • indicatorts        (Ichimoku Cloud)
//   • candlestick        (named candlestick patterns on the last 3 bars)
//
// Each indicator contributes a +/- score (weighted by timeframe importance):
// agreement adds, disagreement subtracts. We tally across all timeframes
// and return:
//   • drop: true  → a HARD veto fired (e.g. RSI deeply against on 4h/daily),
//                   OR the net tally is at or below `dropThreshold`
//   • tally       → signed number; > 0 = confirmed, < 0 = contradicted
//   • notes       → human-readable per-indicator decisions (for the alert)
//   • reason      → short reason string when drop=true
//
// Hard vetoes are reserved for cases where the new libs disagree so
// strongly that the existing scoring couldn't be right: e.g. trying to
// SHORT into RSI ≥ 80 on 4h is fading momentum at an extreme, which no
// proper indicator set would confirm.

import { RSI, MACD, BollingerBands, EMA } from 'trading-signals';
import { ichimokuCloud } from 'indicatorts';
import * as candlestick from 'candlestick';
import { TF_CONFIRM_WEIGHTS } from './timeframes.js';

const HARD_VETO_RSI_HI = 80;   // overbought extreme — drop SHORT (likely momentum, not top)
const HARD_VETO_RSI_LO = 20;   // oversold extreme — drop LONG (likely capitulation, not bottom)

// RSI neutral band — inside this, RSI gives NO points either way (audit §3.4).
// The old code deducted on every RSI ≥ 50 (LONG) / ≤ 50 (SHORT), so an RSI of
// exactly 50 cost w*0.5 on every timeframe, dragging the tally to a drop on
// setups that were merely in transition.
const RSI_NEUTRAL_LO = 45;
const RSI_NEUTRAL_HI = 55;

// Indicator weights per timeframe — daily/weekly disagreement matters more
// than 5m. Centralised in timeframes.js (shared canonical vector, §3.25).
const TF_WEIGHTS = TF_CONFIRM_WEIGHTS;

function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v.toString === 'function') return Number(v.toString());
  return Number(v);
}

// dropThreshold loosened from −1.0 to −2.5 (audit §3.4 / §6.5). At −1.0 a
// single timeframe disagreeing was enough to veto the whole signal, so the
// gate was throwing away winners. −2.5 requires a genuine multi-TF consensus
// against the trade before dropping. Tunable via TA_CONFIRM_DROP_THRESHOLD.
export function confirmSignal({ side, ohlcvByTf, dropThreshold = -2.5, allowExhaustionShort = false, allowExhaustionLong = false }) {
  if (!side || !ohlcvByTf) return { drop: false, tally: 0, notes: ['no ohlcv'], vetoReasons: [], reason: 'no input' };

  let tally = 0;
  const notes = [];
  const vetoReasons = [];

  for (const [tf, bars] of Object.entries(ohlcvByTf)) {
    if (!Array.isArray(bars) || bars.length < 30) continue;
    const w = TF_WEIGHTS[tf] ?? 0.5;

    // Drop the still-forming last bar (consistent with ta.js #computeForTimeframe)
    // so the independent RSI/MACD/BB cross-check doesn't flip intrabar either.
    const closedBars = bars.length > 1 ? bars.slice(0, -1) : bars;
    const closes = closedBars.map(b => Number(b.c ?? b.close)).filter(isFinite);
    const highs  = closedBars.map(b => Number(b.h ?? b.high)).filter(isFinite);
    const lows   = closedBars.map(b => Number(b.l ?? b.low)).filter(isFinite);
    if (closes.length < 29) continue;

    // ── RSI (trading-signals, 14-period) ─────────────────────────────────
    try {
      const rsi = new RSI(14);
      for (const c of closes) rsi.update(c, false);
      const v = toNumber(rsi.getResult());
      if (isFinite(v)) {
        // Hard veto on extreme TF only (4h/daily). Short-term extremes can
        // be just-entered and self-correct quickly — don't veto on 5m/1h.
        if (tf === '4hour' || tf === 'daily') {
          if (side === 'SHORT' && v >= HARD_VETO_RSI_HI) {
            // Normally a hard veto — never short into 4h/daily RSI ≥ 80 (fading
            // live momentum). EXCEPTION: an exhaustion-reversal short (watchlist
            // token, extreme high-TF RSI, fast TFs already rolled over) is
            // DELIBERATELY fading a blow-off top, so the override turns the veto
            // into a small caution credit (overbought = mean-reversion fuel) and
            // lets the confirmed reversal through. HIGH RISK by design.
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
            // Mirror of the SHORT override: an exhaustion-reversal LONG (watchlist
            // capitulation bottom, 5m turning up) DELIBERATELY buys the oversold
            // extreme, so the override turns the veto into a small caution credit
            // (oversold = mean-reversion fuel) and lets the confirmed reversal
            // through. HIGH RISK by design.
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
        // Neutral band 45–55 → no points either way (was: deduct on every
        // RSI ≥ 50 / ≤ 50, which punished setups merely in transition).
        if (v >= RSI_NEUTRAL_LO && v <= RSI_NEUTRAL_HI) {
          notes.push(`${tf} RSI ${v.toFixed(0)} · neutral (0)`);
        } else if (side === 'LONG' && v < RSI_NEUTRAL_LO) { tally += w; notes.push(`${tf} RSI ${v.toFixed(0)} ✓ LONG (+${w})`); }
        else if (side === 'SHORT' && v > RSI_NEUTRAL_HI) { tally += w; notes.push(`${tf} RSI ${v.toFixed(0)} ✓ SHORT (+${w})`); }
        else { tally -= w * 0.5; notes.push(`${tf} RSI ${v.toFixed(0)} ✗ (-${(w*0.5).toFixed(1)})`); }
      }
    } catch {/* skip on indicator error */}

    // ── MACD (trading-signals v7: takes pre-built EMA instances) ─────────
    try {
      const macd = new MACD(new EMA(12), new EMA(26), new EMA(9));
      for (const c of closes) macd.update(c, false);
      const hist = toNumber(macd.getResult().histogram);
      if (isFinite(hist)) {
        if (side === 'LONG' && hist > 0) { tally += w; notes.push(`${tf} MACD+ ✓ LONG (+${w})`); }
        else if (side === 'SHORT' && hist < 0) { tally += w; notes.push(`${tf} MACD- ✓ SHORT (+${w})`); }
        else { tally -= w * 0.5; notes.push(`${tf} MACD ✗ (-${(w*0.5).toFixed(1)})`); }
      }
    } catch {/* skip */}

    // ── Bollinger Bands position (trading-signals, 20/2) ─────────────────
    try {
      const bb = new BollingerBands(20, 2);
      for (const c of closes) bb.update(c, false);
      const r = bb.getResult();
      const upper = toNumber(r.upper);
      const lower = toNumber(r.lower);
      const px = closes[closes.length - 1];
      if (isFinite(upper) && isFinite(lower) && isFinite(px) && upper > lower) {
        const pctB = (px - lower) / (upper - lower); // 0 = lower band, 1 = upper
        // Band touches are textbook MEAN-REVERSION entries and should be
        // REWARDED, not penalised (audit §3.5). The old code subtracted on a
        // SHORT at the upper band (pctB > 0.95) — i.e. it punished the single
        // best location to fade. Now: price at the far band in the trade's
        // favour = strongest confirmation; upper/lower half = mild.
        if (side === 'SHORT' && pctB > 0.95) { tally += w; notes.push(`${tf} BB upper-band ✓ SHORT mean-revert (+${w})`); }
        else if (side === 'LONG' && pctB < 0.05) { tally += w; notes.push(`${tf} BB lower-band ✓ LONG mean-revert (+${w})`); }
        else if (side === 'SHORT' && pctB > 0.7) { tally += w * 0.5; notes.push(`${tf} BB upper-half ✓ SHORT (+${(w*0.5).toFixed(1)})`); }
        else if (side === 'LONG' && pctB < 0.3) { tally += w * 0.5; notes.push(`${tf} BB lower-half ✓ LONG (+${(w*0.5).toFixed(1)})`); }
      }
    } catch {/* skip */}

    // ── Ichimoku Cloud (indicatorts) — only 1h / 4h / daily / weekly ─────
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
      } catch {/* skip */}
    }
  }

  // ── Candlestick patterns on the most recent 1h bars ──────────────────
  // 1h preferred: less noisy than 5m, more current than 4h. Falls back if
  // 1h data isn't loaded for this run.
  const patternTf = ohlcvByTf['1hour'] ?? ohlcvByTf['4hour'] ?? ohlcvByTf['5min'];
  if (Array.isArray(patternTf) && patternTf.length >= 4) {
    // Last 3 CLOSED bars — exclude the still-forming bar (audit §3.11). A
    // forming bar can momentarily look like a hammer/engulfing and flip the
    // pattern verdict every tick until it closes.
    const last3 = patternTf.slice(-4, -1).map(b => ({
      open:  Number(b.o ?? b.open),
      high:  Number(b.h ?? b.high),
      low:   Number(b.l ?? b.low),
      close: Number(b.c ?? b.close)
    }));
    try {
      // Single-bar
      if (candlestick.isBullishHammer?.(last3[2])) {
        if (side === 'LONG') { tally += 1; notes.push('1h bullish hammer ✓ LONG'); }
        else                 { tally -= 1; notes.push('1h bullish hammer ✗ SHORT'); }
      }
      if (candlestick.isBearishHammer?.(last3[2])) {
        if (side === 'SHORT') { tally += 1; notes.push('1h bearish hammer ✓ SHORT'); }
        else                  { tally -= 1; notes.push('1h bearish hammer ✗ LONG'); }
      }
      // Two-bar
      if (candlestick.isBullishEngulfing?.(last3[1], last3[2])) {
        if (side === 'LONG') { tally += 1; notes.push('1h bullish engulfing ✓ LONG'); }
        else                 { tally -= 1; notes.push('1h bullish engulfing ✗ SHORT'); }
      }
      if (candlestick.isBearishEngulfing?.(last3[1], last3[2])) {
        if (side === 'SHORT') { tally += 1; notes.push('1h bearish engulfing ✓ SHORT'); }
        else                  { tally -= 1; notes.push('1h bearish engulfing ✗ LONG'); }
      }
      // Three-bar (strongest)
      if (candlestick.isMorningStar?.(last3[0], last3[1], last3[2])) {
        if (side === 'LONG') { tally += 1.5; notes.push('1h morning star ✓ LONG'); }
        else                 { tally -= 1.5; notes.push('1h morning star ✗ SHORT'); }
      }
      if (candlestick.isEveningStar?.(last3[0], last3[1], last3[2])) {
        if (side === 'SHORT') { tally += 1.5; notes.push('1h evening star ✓ SHORT'); }
        else                  { tally -= 1.5; notes.push('1h evening star ✗ LONG'); }
      }
    } catch {/* skip pattern errors */}
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
