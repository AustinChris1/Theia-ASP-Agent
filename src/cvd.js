
import { OkxClient } from './okx.js';

const cache = new Map();

const env = (k, d) => { const v = process.env[k]; return v == null || v === '' ? d : v; };

function okxFromEnv(override = {}) {
  return new OkxClient({
    baseUrl: override.okxBaseUrl ?? env('OKX_BASE_URL', null),
    relayBaseUrl: override.relayBaseUrl ?? env('RELAY_BASE_URL', null),
    relayAuthSecret: override.relayAuthSecret ?? env('RELAY_AUTH_SECRET', null),
  });
}

export async function cvdVeto({ symbol, side, bars, minMovePct, opposeRatio, ttlMs = 30_000, ...override } = {}) {
  if (process.env.CVD_VETO !== '1') return { veto: false, reason: 'disabled' };
  const base = String(symbol || '').toUpperCase().replace(/USDT$/, '');
  const S = String(side || '').toUpperCase();
  if (!base || (S !== 'LONG' && S !== 'SHORT')) return { veto: false, reason: 'bad-args' };

  const N = Math.max(5, Math.min(60, Number(bars ?? env('CVD_BARS', 15))));
  const MIN_MOVE = Number(minMovePct ?? env('CVD_MIN_PRICE_MOVE_PCT', 0.4));
  const OPPOSE = Number(opposeRatio ?? env('CVD_OPPOSE_RATIO', 0.06));

  const key = `${base}|${N}`;
  const hit = cache.get(key);
  const nowTs = hit ? null : null;
  if (hit && (Date.now() - hit.ts) < ttlMs) return decide(hit.result, S, MIN_MOVE, OPPOSE);

  const okx = okxFromEnv(override);
  const [takers, candles] = await Promise.all([
    okx.getTakerVolume(base, '1m', N).catch(() => null),
    okx.getCandles(`${base}-USDT-SWAP`, '1m', N).catch(() => null),
  ]);
  if (!takers || !candles || !candles.length) {
    const noData = { reason: 'no-data', priceChangePct: null, cvdRatio: null, netDeltaUsd: null, totalUsd: null, bars: N };
    cache.set(key, { ts: Date.now(), result: noData });
    return { veto: false, ...noData };
  }

  let netDeltaUsd = 0, totalUsd = 0;
  for (const t of takers) {
    if (!isFinite(t.buy) || !isFinite(t.sell)) continue;
    netDeltaUsd += (t.buy - t.sell);
    totalUsd += (t.buy + t.sell);
  }
  const firstOpen = candles[0].o;
  const lastClose = candles[candles.length - 1].c;
  const priceChangePct = (isFinite(firstOpen) && firstOpen > 0 && isFinite(lastClose))
    ? ((lastClose - firstOpen) / firstOpen) * 100 : null;
  const cvdRatio = totalUsd > 0 ? netDeltaUsd / totalUsd : null;

  const result = { reason: 'ok', priceChangePct, cvdRatio, netDeltaUsd, totalUsd, bars: N };
  cache.set(key, { ts: Date.now(), result });
  return decide(result, S, MIN_MOVE, OPPOSE);
}

function decide(r, side, minMove, oppose) {
  const { priceChangePct: p, cvdRatio: c } = r;
  if (p == null || c == null) return { veto: false, ...r };

  if (side === 'LONG' && p >= minMove && c <= -oppose) {
    return { veto: true, reason: `price +${p.toFixed(2)}% but CVD ${(c * 100).toFixed(0)}% (net selling into the rally)`, ...r };
  }

  if (side === 'SHORT' && p <= -minMove && c >= oppose) {
    return { veto: true, reason: `price ${p.toFixed(2)}% but CVD +${(c * 100).toFixed(0)}% (net buying into the drop)`, ...r };
  }
  return { veto: false, ...r };
}

export function cvdDecision({ priceChangePct, cvdRatio, side, minMovePct = 0.4, opposeRatio = 0.06 }) {
  return decide({ priceChangePct, cvdRatio, reason: 'ok', bars: 0 }, String(side).toUpperCase(), minMovePct, opposeRatio).veto;
}
