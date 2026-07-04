// CEX distribution detector — the on-chain "are they dumping?" read.
//
// A single hot-wallet→external transfer is normal customer-withdrawal noise.
// But a CONCENTRATED, continuous STREAM of them for one token over a short
// window is the distribution pattern a skilled on-chain analyst flags as a
// likely dump — the SKYAI case: a flood of small Bitget hot-wallet outflows to
// MEV bots / exchange-deposit wallets right as it fell ~50%.
//
// This is JUDGMENT-required market intel: it fires a WATCH alert, NEVER an
// auto-trade. A "distribution" can also be a non-selling sub-wallet or an OTC
// move (the LAB / SAHARA cases) — concentrated outflow is a reason to LOOK, not
// a mechanical short. So we surface the data + a caution and let the operator
// decide, the way the analyst does.

// Pure: given the recent distribution-candidate transfers for ONE token, decide
// whether the cumulative outflow is ABNORMAL. Scale-invariant — judged against
// the token's OWN 24h volume so majors' constant withdrawals don't false-fire.
// Returns { cumulativeUsd, count, volPct } or null.
export function assessDistribution(events, {
  now,
  windowMs = 2 * 60 * 60_000,   // 2h rolling window
  vol24h = null,
  minUsd = 500_000,             // absolute floor
  minVolPct = 4,                // ≥4% of 24h volume inside the window = abnormal
  minTransfers = 5              // the "continuous stream" requirement
} = {}) {
  if (!Array.isArray(events) || events.length < minTransfers) return null;
  const recent = events.filter(e => e && e.usd > 0 && (now - e.ts) <= windowMs);
  if (recent.length < minTransfers) return null;
  const cumulativeUsd = recent.reduce((s, e) => s + e.usd, 0);
  if (cumulativeUsd < minUsd) return null;
  const volPct = (vol24h && vol24h > 0) ? (cumulativeUsd / vol24h) * 100 : null;
  // Abnormal = clears the absolute floor AND (when 24h volume is known) is a
  // meaningful fraction of it. Without volume we require a higher absolute so we
  // don't fire on a token whose normal flow we can't gauge.
  const abnormal = volPct != null ? volPct >= minVolPct : cumulativeUsd >= minUsd * 3;
  if (!abnormal) return null;
  return { cumulativeUsd, count: recent.length, volPct };
}
