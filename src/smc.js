

const FRACTAL_N = 2;
const EQUAL_TOL_PCT = 0.4;

const BOS_MAX_DIST_PCT = (() => { const v = Number(process.env.BOS_MAX_DIST_PCT); return isFinite(v) && v > 0 ? v : 30; })();
const RECENT_WINDOW = 100;

export function findSwings(bars) {
  const highs = [];
  const lows  = [];
  for (let i = FRACTAL_N; i < bars.length - FRACTAL_N; i++) {
    const c = bars[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= FRACTAL_N; k++) {
      if (bars[i - k].h >= c.h) isHigh = false;
      if (bars[i + k].h >= c.h) isHigh = false;
      if (bars[i - k].l <= c.l) isLow = false;
      if (bars[i + k].l <= c.l) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: c.h });
    if (isLow)  lows.push({ idx: i, price: c.l });
  }
  return { highs, lows };
}

function isEqual(a, b) {
  if (!a || !b) return false;
  return Math.abs((a - b) / b) * 100 <= EQUAL_TOL_PCT;
}

export function analyzeSmc(bars, { tfLabel = '1hour', weight = 1.0 } = {}) {
  const findings = [];
  if (!Array.isArray(bars) || bars.length < FRACTAL_N * 2 + 5) {
    return { findings };
  }
  const window = bars.slice(-RECENT_WINDOW);
  const { highs, lows } = findSwings(window);
  if (highs.length < 2 && lows.length < 2) return { findings };

  const lastBar = window[window.length - 1];
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow  = lows[lows.length - 1];
  const prevLow  = lows[lows.length - 2];

  const hh = lastHigh && prevHigh && lastHigh.price > prevHigh.price;
  const hl = lastLow  && prevLow  && lastLow.price  > prevLow.price;
  const lh = lastHigh && prevHigh && lastHigh.price < prevHigh.price;
  const ll = lastLow  && prevLow  && lastLow.price  < prevLow.price;
  let trend = null;
  if (hh && hl) trend = 'up';
  else if (lh && ll) trend = 'down';

  const bullBosFresh = trend === 'up' && prevHigh && lastBar.c > prevHigh.price &&
    ((lastBar.c - prevHigh.price) / prevHigh.price) * 100 <= BOS_MAX_DIST_PCT;
  const bearBosFresh = trend === 'down' && prevLow && lastBar.c < prevLow.price &&
    ((prevLow.price - lastBar.c) / prevLow.price) * 100 <= BOS_MAX_DIST_PCT;
  if (bullBosFresh) {
    findings.push({
      kind: 'smc',
      text: `BOS bullish ${tfLabel} — price closed above prior swing high ${prevHigh.price.toPrecision(5)}`,
      points: 0.5 * weight,
      smc: { type: 'bos', side: 'LONG' }
    });
  } else if (bearBosFresh) {
    findings.push({
      kind: 'smc',
      text: `BOS bearish ${tfLabel} — price closed below prior swing low ${prevLow.price.toPrecision(5)}`,
      points: 0.5 * weight,
      smc: { type: 'bos', side: 'SHORT' }
    });
  }

  if (trend === 'up' && lastLow && lastBar.c < lastLow.price) {
    findings.push({
      kind: 'smc',
      text: `CHoCH bearish ${tfLabel} — uptrend broken (closed below HL ${lastLow.price.toPrecision(5)})`,
      points: 0.6 * weight,
      smc: { type: 'choch', side: 'SHORT' }
    });
  } else if (trend === 'down' && lastHigh && lastBar.c > lastHigh.price) {
    findings.push({
      kind: 'smc',
      text: `CHoCH bullish ${tfLabel} — downtrend broken (closed above LH ${lastHigh.price.toPrecision(5)})`,
      points: 0.6 * weight,
      smc: { type: 'choch', side: 'LONG' }
    });
  }

  if (highs.length >= 2) {
    const top = lastHigh.price;
    const equalToTop = highs.slice(-4).filter(h => isEqual(h.price, top));
    if (equalToTop.length >= 3) {
      findings.push({
        kind: 'smc',
        text: `Triple top ${tfLabel} at ~${top.toPrecision(5)} — heavy stops above`,
        points: 0.5 * weight,
        smc: { type: 'tripleTop', side: 'SHORT', level: top }
      });
    } else if (equalToTop.length === 2) {
      findings.push({
        kind: 'smc',
        text: `Double top ${tfLabel} at ~${top.toPrecision(5)} — stops above`,
        points: 0.3 * weight,
        smc: { type: 'doubleTop', side: 'SHORT', level: top }
      });
    }
  }

  if (lows.length >= 2) {
    const bot = lastLow.price;
    const equalToBot = lows.slice(-4).filter(l => isEqual(l.price, bot));
    if (equalToBot.length >= 3) {
      findings.push({
        kind: 'smc',
        text: `Triple bottom ${tfLabel} at ~${bot.toPrecision(5)} — heavy stops below`,
        points: 0.5 * weight,
        smc: { type: 'tripleBottom', side: 'LONG', level: bot }
      });
    } else if (equalToBot.length === 2) {
      findings.push({
        kind: 'smc',
        text: `Double bottom ${tfLabel} at ~${bot.toPrecision(5)} — stops below`,
        points: 0.3 * weight,
        smc: { type: 'doubleBottom', side: 'LONG', level: bot }
      });
    }
  }

  const SWEEP_BARS = 3;
  const recent = window.slice(-SWEEP_BARS);

  if (highs.length >= 2) {
    const top = Math.max(...highs.slice(-4).map(h => h.price));
    for (let i = recent.length - 1; i >= 0; i--) {
      const b = recent[i];
      if (b.h > top && b.c < top) {
        findings.push({
          kind: 'smc',
          text: `Liquidity sweep above ${tfLabel} ${top.toPrecision(5)} — wick took stops then rejected (bearish)`,
          points: 0.7 * weight,
          smc: { type: 'sweepHigh', side: 'SHORT', level: top }
        });
        break;
      }
    }
  }

  if (lows.length >= 2) {
    const bot = Math.min(...lows.slice(-4).map(l => l.price));
    for (let i = recent.length - 1; i >= 0; i--) {
      const b = recent[i];
      if (b.l < bot && b.c > bot) {
        findings.push({
          kind: 'smc',
          text: `Liquidity sweep below ${tfLabel} ${bot.toPrecision(5)} — wick took stops then bounced (bullish)`,
          points: 0.7 * weight,
          smc: { type: 'sweepLow', side: 'LONG', level: bot }
        });
        break;
      }
    }
  }

  return { findings, trend };
}
