// CVD (Cumulative Volume Delta) veto for momentum entries.
//
// The #1 cause of stop-outs in the live audit was WRONG-DIRECTION entries — 49%
// of losses barely moved the right way before reversing. The classic tell of a
// fake breakout is "price up but no real buying": the candle is green, but the
// aggressive (market-order) flow is net SELLING into it. CVD measures exactly
// that — taker-buy volume minus taker-sell volume.
//
// We get it WITHOUT a WebSocket (the host is geo-blocked from Binance/Bybit and
// the relay only proxies HTTP): Binance futures klines already carry per-bar
// "taker buy" volume, so one REST call over the last N 1m bars yields a true
// CVD. Computed ON DEMAND only when a momentum signal is about to fire, then
// briefly cached — bounded and cheap. FAIL-OPEN: any fetch/parse problem returns
// veto=false, so a network blip never silences the bot.
//
// Veto rule (only the trade's OWN side, only on CLEAR divergence):
//   • LONG  fired on a price rise, but net taker delta is SELLING  → fakeout → veto
//   • SHORT fired on a price drop, but net taker delta is BUYING   → fakeout → veto
// Agreement (or weak/no divergence) never vetoes.

const FAPI = 'https://fapi.binance.com';
const cache = new Map();   // `${base}|${bars}` → { ts, result }

const env = (k, d) => { const v = process.env[k]; return v == null || v === '' ? d : v; };

function relayConfig(override = {}) {
  const base = override.relayBaseUrl ?? env('RELAY_BASE_URL', env('BYBIT_BASE_URL', null));
  return {
    relayBaseUrl: base ? String(base).replace(/\/$/, '') : null,
    relayAuthSecret: override.relayAuthSecret ?? env('BYBIT_PROXY_SECRET', null),
  };
}

async function fetchKlines(base, bars, { relayBaseUrl, relayAuthSecret }) {
  const path = `/fapi/v1/klines?symbol=${base}USDT&interval=1m&limit=${bars}`;
  // Relay first when configured (the host is geo-blocked direct); else direct.
  const targets = [];
  if (relayBaseUrl) targets.push({ url: `${relayBaseUrl}/binance${path}`, auth: relayAuthSecret });
  targets.push({ url: `${FAPI}${path}`, auth: null });
  for (const t of targets) {
    try {
      const opts = { signal: AbortSignal.timeout(6000) };
      if (t.auth) opts.headers = { 'X-Proxy-Auth': t.auth };
      const res = await fetch(t.url, opts);
      if (!res.ok) continue;
      const j = await res.json();
      if (Array.isArray(j) && j.length) return j;
    } catch { /* try next target */ }
  }
  return null;
}

// Returns { veto, reason, priceChangePct, cvdRatio, netDeltaUsd, totalUsd, bars }.
// veto is true only on clear price↔flow divergence against `side`.
export async function cvdVeto({ symbol, side, bars, minMovePct, opposeRatio, ttlMs = 30_000, ...override } = {}) {
  if (process.env.CVD_VETO !== '1') return { veto: false, reason: 'disabled' };   // OPT-IN (default OFF)
  const base = String(symbol || '').toUpperCase().replace(/USDT$/, '');
  const S = String(side || '').toUpperCase();
  if (!base || (S !== 'LONG' && S !== 'SHORT')) return { veto: false, reason: 'bad-args' };

  const N = Math.max(5, Math.min(60, Number(bars ?? env('CVD_BARS', 15))));
  const MIN_MOVE = Number(minMovePct ?? env('CVD_MIN_PRICE_MOVE_PCT', 0.4));   // % over the window
  const OPPOSE = Number(opposeRatio ?? env('CVD_OPPOSE_RATIO', 0.06));         // net taker delta vs volume

  const key = `${base}|${N}`;
  const hit = cache.get(key);
  const nowTs = hit ? null : null;   // Date.now() unavailable in some sandboxes; rely on ttl via caller cadence
  if (hit && (Date.now() - hit.ts) < ttlMs) return decide(hit.result, S, MIN_MOVE, OPPOSE);

  const klines = await fetchKlines(base, N, relayConfig(override));
  if (!klines) {
    const noData = { reason: 'no-data', priceChangePct: null, cvdRatio: null, netDeltaUsd: null, totalUsd: null, bars: N };
    cache.set(key, { ts: Date.now(), result: noData });
    return { veto: false, ...noData };   // FAIL-OPEN
  }

  let netDeltaUsd = 0, totalUsd = 0;
  const firstOpen = Number(klines[0][1]);
  const lastClose = Number(klines[klines.length - 1][4]);
  for (const k of klines) {
    const quoteVol = Number(k[7]);          // total quote (USD) volume
    const takerBuyQuote = Number(k[10]);    // taker BUY quote (USD) volume
    if (!isFinite(quoteVol) || !isFinite(takerBuyQuote)) continue;
    netDeltaUsd += (2 * takerBuyQuote - quoteVol);   // buy − sell
    totalUsd += quoteVol;
  }
  const priceChangePct = (isFinite(firstOpen) && firstOpen > 0 && isFinite(lastClose))
    ? ((lastClose - firstOpen) / firstOpen) * 100 : null;
  const cvdRatio = totalUsd > 0 ? netDeltaUsd / totalUsd : null;   // ∈ [-1, 1]

  const result = { reason: 'ok', priceChangePct, cvdRatio, netDeltaUsd, totalUsd, bars: N };
  cache.set(key, { ts: Date.now(), result });
  return decide(result, S, MIN_MOVE, OPPOSE);
}

function decide(r, side, minMove, oppose) {
  const { priceChangePct: p, cvdRatio: c } = r;
  if (p == null || c == null) return { veto: false, ...r };
  // LONG fired on a rise but aggressive flow is net selling → fakeout.
  if (side === 'LONG' && p >= minMove && c <= -oppose) {
    return { veto: true, reason: `price +${p.toFixed(2)}% but CVD ${(c * 100).toFixed(0)}% (net selling into the rally)`, ...r };
  }
  // SHORT fired on a drop but aggressive flow is net buying → fakeout.
  if (side === 'SHORT' && p <= -minMove && c >= oppose) {
    return { veto: true, reason: `price ${p.toFixed(2)}% but CVD +${(c * 100).toFixed(0)}% (net buying into the drop)`, ...r };
  }
  return { veto: false, ...r };
}

// Test seam: exported pure decision so the veto logic is unit-testable without
// network. Same rule as decide().
export function cvdDecision({ priceChangePct, cvdRatio, side, minMovePct = 0.4, opposeRatio = 0.06 }) {
  return decide({ priceChangePct, cvdRatio, reason: 'ok', bars: 0 }, String(side).toUpperCase(), minMovePct, opposeRatio).veto;
}
