

export const TIMEFRAMES = [

  { interval: '1min',  lookbackSec: 5 * 3600,          findingWeight: 0.10 },
  { interval: '5min',  lookbackSec: 24 * 3600,         findingWeight: 0.20 },
  { interval: '1hour', lookbackSec: 14 * 24 * 3600,    findingWeight: 0.30 },
  { interval: '4hour', lookbackSec: 60 * 24 * 3600,    findingWeight: 0.40 },

  { interval: 'daily', lookbackSec: 800 * 24 * 3600,   findingWeight: 0.50 },
  { interval: '1week', lookbackSec: 800 * 24 * 3600,   findingWeight: 0.60, weekly: true }
];

export const FETCH_INTERVALS = TIMEFRAMES.filter(t => !t.weekly).map(t => t.interval);

export const TF_ORDER = TIMEFRAMES.map(t => t.interval);

export const TF_FINDING_WEIGHTS = Object.fromEntries(
  TIMEFRAMES.map(t => [t.interval, t.findingWeight])
);

export const TF_ALIGNMENT_WEIGHTS = {
  '1min':  0.04,
  '5min':  0.08,
  '1hour': 0.14,
  '4hour': 0.22,
  'daily': 0.26,
  '1week': 0.26
};

export const TF_CONFIRM_WEIGHTS = {
  '5min':  0.5,
  '1hour': 1.0,
  '4hour': 1.5,
  'daily': 2.0,
  '1week': 2.5
};

export const MIN_BARS = 30;

export function aggregateWeekly(dailyBars) {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  const WEEK_SEC = 7 * 24 * 3600;
  const MONDAY_ANCHOR = 4 * 24 * 3600;
  const num = (b, ...keys) => {
    for (const k of keys) { const v = Number(b[k]); if (isFinite(v)) return v; }
    return NaN;
  };
  const buckets = new Map();
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
      acc.c = c;
      acc.v += v;
      if (t < acc._firstT) { acc.o = o; acc._firstT = t; }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({ t: acc.t, o: acc.o, h: acc.h, l: acc.l, c: acc.c, v: acc.v }));
}
