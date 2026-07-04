// Canonical timeframe definitions + weight vectors.
//
// Before this module the TF weights lived in three places that had drifted
// out of sync (ta.js per-finding weights, conductor.js trade-plan alignment
// weights, ta-confirm.js tally weights) — audit finding §3.25. They serve
// genuinely different purposes, but they MUST agree on the TF set and on the
// relative ordering (higher TF = more conviction). Centralising them here is
// the single source of truth, and adding the 1-week timeframe is now a
// one-line change instead of three.
//
// Six timeframes participate now (was five): 1m, 5m, 1h, 4h, 1d, 1w. The
// weekly frame is AGGREGATED from daily bars (see aggregateWeekly) rather than
// fetched — most data providers don't expose a native weekly OHLCV and the
// aggregation is exact. Weekly improves macro-trend context and lets the
// trade-plan pick longer holding horizons when the big picture agrees.

// Ordered low → high. `interval` is the provider interval string (Coinalyze).
// `weekly: true` marks a frame that is derived locally, not fetched.
export const TIMEFRAMES = [
  // 1m is noisy; weight is low and we only compute RSI + wick analysis on it.
  { interval: '1min',  lookbackSec: 5 * 3600,          findingWeight: 0.10 },
  { interval: '5min',  lookbackSec: 24 * 3600,         findingWeight: 0.20 },
  { interval: '1hour', lookbackSec: 14 * 24 * 3600,    findingWeight: 0.30 },
  { interval: '4hour', lookbackSec: 60 * 24 * 3600,    findingWeight: 0.40 },
  // Daily lookback bumped to ~2.2y so weekly aggregation has ≥ MIN_BARS weeks
  // of history for RSI(14)/MACD(26+9)/ATR(14).
  { interval: 'daily', lookbackSec: 800 * 24 * 3600,   findingWeight: 0.50 },
  { interval: '1week', lookbackSec: 800 * 24 * 3600,   findingWeight: 0.60, weekly: true }
];

// The interval strings we actually FETCH from the provider (weekly is derived).
export const FETCH_INTERVALS = TIMEFRAMES.filter(t => !t.weekly).map(t => t.interval);

// All interval labels in canonical order (incl. derived weekly).
export const TF_ORDER = TIMEFRAMES.map(t => t.interval);

// Per-finding point multiplier used by ta.js — each TF's individual findings
// (RSI/MACD/wick/SMC...) are scaled by this before flowing into the conductor
// score. Higher TF = bigger weight.
export const TF_FINDING_WEIGHTS = Object.fromEntries(
  TIMEFRAMES.map(t => [t.interval, t.findingWeight])
);

// Trade-plan ALIGNMENT weights used by conductor #buildTradePlan. These sum to
// ~1.0 and represent each TF's share of "trend conviction" — a daily/weekly
// agreement is worth far more than 1m+5m. Used for horizon selection and
// leverage confidence scaling.
export const TF_ALIGNMENT_WEIGHTS = {
  '1min':  0.04,
  '5min':  0.08,
  '1hour': 0.14,
  '4hour': 0.22,
  'daily': 0.26,
  '1week': 0.26
};

// Confirmation-gate tally weights used by ta-confirm.js — daily/weekly
// disagreement matters more than 5m. (1m is excluded from the gate entirely.)
export const TF_CONFIRM_WEIGHTS = {
  '5min':  0.5,
  '1hour': 1.0,
  '4hour': 1.5,
  'daily': 2.0,
  '1week': 2.5
};

export const MIN_BARS = 30;

// Aggregate daily OHLCV bars (oldest → newest) into weekly bars. Bars use the
// Coinalyze shape: { t (unix-seconds), o, h, l, c, v } with open/high/low/
// close/volume fallbacks. Buckets by fixed 7-day windows anchored to MONDAY
// 00:00 UTC — the weekly candle boundary every charting platform (and the
// trader) uses. (Plain `floor(t/WEEK)` anchors to the unix epoch, which was a
// THURSDAY, so weekly RSI/MACD/swings would be computed on candles offset ~3
// days from the chart — wrong open and a stale macro read.) The most recent
// bucket may be a still-forming partial week — downstream code excludes the
// last (forming) bar.
//
// Returns weekly bars in the same shape, oldest → newest.
export function aggregateWeekly(dailyBars) {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  const WEEK_SEC = 7 * 24 * 3600;
  const MONDAY_ANCHOR = 4 * 24 * 3600;   // epoch (Thu) + 4d = first Monday 1970-01-05 00:00 UTC
  const num = (b, ...keys) => {
    for (const k of keys) { const v = Number(b[k]); if (isFinite(v)) return v; }
    return NaN;
  };
  const buckets = new Map();   // weekIdx → bar accumulator
  for (const b of dailyBars) {
    const t = num(b, 't', 'timestamp');
    const o = num(b, 'o', 'open');
    const h = num(b, 'h', 'high');
    const l = num(b, 'l', 'low');
    const c = num(b, 'c', 'close');
    const v = num(b, 'v', 'volume') || 0;
    if (![t, o, h, l, c].every(isFinite)) continue;
    const idx = Math.floor((t - MONDAY_ANCHOR) / WEEK_SEC);
    const acc = buckets.get(idx);
    if (!acc) {
      buckets.set(idx, { t: idx * WEEK_SEC + MONDAY_ANCHOR, o, h, l, c, v, _firstT: t });
    } else {
      acc.h = Math.max(acc.h, h);
      acc.l = Math.min(acc.l, l);
      acc.c = c;                          // bars are ordered, so last close wins
      acc.v += v;
      if (t < acc._firstT) { acc.o = o; acc._firstT = t; }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({ t: acc.t, o: acc.o, h: acc.h, l: acc.l, c: acc.c, v: acc.v }));
}
