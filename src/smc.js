// Smart Money Concepts (SMC) / ICT structure detector.
//
// Reads OHLCV bars for one timeframe and reports:
//   • Break of Structure (BOS)        — trend continuation
//   • Change of Character (CHoCH)     — first warning of trend reversal
//   • Double / Triple Top             — equal highs (stops accumulate above)
//   • Double / Triple Bottom          — equal lows (stops below)
//   • Liquidity Sweep                 — wick PIERCES a top/bottom then closes
//                                       back on the original side (failed
//                                       breakout = harvested stops, reversal)
//
// All detection is wick-aware: we use bar HIGH for swing highs and bar LOW
// for swing lows. That way an upper-wick spike that didn't close above still
// registers as a swept level, which is the entire SMC point.
//
// Swing detection is a simple fractal: a bar is a swing high if its high is
// the highest within ±FRACTAL_N bars; mirror for swing lows. FRACTAL_N=2 is
// the standard "5-bar fractal" used in ICT literature.

const FRACTAL_N = 2;                 // ±2 bars → 5-bar fractal
const EQUAL_TOL_PCT = 0.4;           // ±0.4% counts as "equal" for double/triple
// A Break of Structure is only ACTIONABLE if price is still NEAR the level it
// broke. On a token that ran 200%+, the last bar trivially closes above a swing
// high from weeks ago ("BOS above 0.17451" while price is 0.54) — a break that
// happened long ago, useless for today's trade (the STG case the reviewer
// flagged). Require the broken level to be within BOS_MAX_DIST_PCT of price so
// only RECENT, proximate breaks count; stale far-away breaks are dropped.
const BOS_MAX_DIST_PCT = (() => { const v = Number(process.env.BOS_MAX_DIST_PCT); return isFinite(v) && v > 0 ? v : 30; })();
const RECENT_WINDOW = 100;           // analyse last 100 bars only — older
                                     // structure is no longer relevant to entry

// Find all swing highs / lows in `bars` (oldest → newest), each as
// { idx, price }. Uses bar.h / bar.l so wicks count, not bodies.
// Exported so consumers (TP-snapping in trade plans) can reuse the
// same swing detection without re-running the full SMC pipeline.
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

// Are two prices within EQUAL_TOL_PCT of each other?
function isEqual(a, b) {
  if (!a || !b) return false;
  return Math.abs((a - b) / b) * 100 <= EQUAL_TOL_PCT;
}

// Analyse the bars and return { side, findings } where findings is the
// same shape used elsewhere in the bot: { kind, text, points }.
// `side` is whichever direction the SMC structure favors most strongly,
// or null if neutral. `weight` scales the points so the caller can apply
// timeframe importance externally.
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

  // ── Determine current "trend" from the chain of swings ─────────────────
  // Simplified: look at most recent 2 swings on each side.
  //   HH + HL  → uptrend
  //   LH + LL  → downtrend
  //   mixed    → ranging
  const hh = lastHigh && prevHigh && lastHigh.price > prevHigh.price;
  const hl = lastLow  && prevLow  && lastLow.price  > prevLow.price;
  const lh = lastHigh && prevHigh && lastHigh.price < prevHigh.price;
  const ll = lastLow  && prevLow  && lastLow.price  < prevLow.price;
  let trend = null;
  if (hh && hl) trend = 'up';
  else if (lh && ll) trend = 'down';

  // ── BOS — Break of Structure (continuation) ─────────────────────────────
  // In uptrend, last bar's HIGH closing above the most recent swing high
  // confirms the uptrend. In downtrend, last bar's LOW closing below
  // the most recent swing low confirms the downtrend.
  // Proximity gate: only count a BOS where price is still within BOS_MAX_DIST_PCT
  // of the broken level (a RECENT break, not an ancient one price ran far past).
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

  // ── CHoCH — Change of Character (early reversal) ────────────────────────
  // In uptrend, price closing BELOW the most recent HL = first sign the
  // uptrend is broken. Mirror for downtrend.
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

  // ── Double / Triple Top ─────────────────────────────────────────────────
  // Equal highs = stops cluster ABOVE the level. Short-biased setup IF the
  // level gets defended (or about-to-be-swept).
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

  // ── Double / Triple Bottom ──────────────────────────────────────────────
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

  // ── Liquidity Sweep (the bullseye signal) ───────────────────────────────
  // Recent bar wicks ABOVE a double/triple-top level then CLOSES BACK BELOW
  // it = failed breakout = stops above the level just got harvested.
  // Classic reversal setup. Use bars[-1] (the most recent bar).
  //
  // We only consider the sweep "active" if it happened within the last
  // SWEEP_BARS=3 bars — older sweeps are noise, fresh ones are tradeable.
  const SWEEP_BARS = 3;
  const recent = window.slice(-SWEEP_BARS);
  // Sweep above (bearish): any recent bar high pierces a multi-touch top
  // level and the bar closed back below it.
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
  // Sweep below (bullish)
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
