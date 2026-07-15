

export function assessDistribution(events, {
  now,
  windowMs = 2 * 60 * 60_000,
  vol24h = null,
  minUsd = 500_000,
  minVolPct = 4,
  minTransfers = 5
} = {}) {
  if (!Array.isArray(events) || events.length < minTransfers) return null;
  const recent = events.filter(e => e && e.usd > 0 && (now - e.ts) <= windowMs);
  if (recent.length < minTransfers) return null;
  const cumulativeUsd = recent.reduce((s, e) => s + e.usd, 0);
  if (cumulativeUsd < minUsd) return null;
  const volPct = (vol24h && vol24h > 0) ? (cumulativeUsd / vol24h) * 100 : null;

  const abnormal = volPct != null ? volPct >= minVolPct : cumulativeUsd >= minUsd * 3;
  if (!abnormal) return null;
  return { cumulativeUsd, count: recent.length, volPct };
}
