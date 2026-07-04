// Liquidation + Upbit forwarder — runs on a NON-US host (Fly Tokyo). Two jobs:
//
//  1. BYBIT LIQUIDATIONS (the real feed). Binance geo-blocks market DATA to cloud
//     IPs — proven: Fly Tokyo opened the socket but got 0 frames. Bybit serves
//     market data globally, so we hold its `allLiquidation.<symbol>` WS here, buffer
//     ~10 min of liquidations in memory, and expose them at GET /liquidations. The
//     bot POLLS that (poll, not WS, because the bot's Render↔Fly path is flaky).
//     Bybit data is also more relevant — it's the venue the bot actually trades on.
//
//  2. UPBIT PROXY. /upbit/<path> server-side-fetches api-manager.upbit.com, which
//     403s US + Singapore datacenter IPs but works from a Tokyo IP.
//
// DEPLOY: cd binance-liq-forwarder && fly deploy   (app already exists in nrt)
// PROBE:  curl https://<host>/health   → bybit.frames climbing = reachable ✓
import http from 'node:http';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const UPBIT = 'https://api-manager.upbit.com';
const BYBIT_WS = process.env.BYBIT_WS_URL || 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_REST = process.env.BYBIT_REST_URL || 'https://api.bybit.com';
// Subscribe to top-N perps by turnover. Kept to the liquid majors/large alts on
// purpose: liquidations are a tradeable squeeze there, but rekt-bait on illiquid
// small-caps, so we don't even want their liquidation frames. (The real "no liq
// signals" cause was the conductor demoting majors, not coverage — fixed there.)
const BYBIT_TOP_N = Number(process.env.BYBIT_LIQ_TOP_N) || 150;   // subscribe to top-N perps by turnover
const BUFFER_MS = (Number(process.env.LIQ_BUFFER_MIN) || 10) * 60_000;

const log = (...a) => console.log('[forwarder]', ...a);

// ── Bybit liquidation state ────────────────────────────────────────────────
let bybitWs = null, bybitUp = false, bybitFrames = 0, bybitLastTs = 0, bybitReconnect = 1000;
let bybitSymbols = [];
const liqBuffer = [];   // { id, symbol, side:'long'|'short', usd, price, qty, ts }
let liqSeq = 0;

function bufferLiq(e) {
  liqBuffer.push(e);
  const cutoff = Date.now() - BUFFER_MS;
  while (liqBuffer.length && liqBuffer[0].ts < cutoff) liqBuffer.shift();   // age out
  if (liqBuffer.length > 8000) liqBuffer.splice(0, liqBuffer.length - 8000); // hard cap
}

// Bybit allLiquidation frame: { topic:"allLiquidation.BTCUSDT", data:[{T,s,S,v,p}] }
// S = the POSITION side that got liquidated (NOT the order side — this is the
// OPPOSITE of Binance forceOrder): "Buy" → a LONG position was wiped; "Sell" → a
// SHORT was wiped. Verified empirically: a BTC drop 67k→64.5k (which liquidates
// LONGS) was arriving as S="Buy". USD = v(qty) × p.
function onBybitMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.topic !== 'string' || !m.topic.startsWith('allLiquidation.') || !Array.isArray(m.data)) return;
  if (bybitFrames === 0) log('← first Bybit liquidation frame received ✓ — feed is LIVE');
  bybitFrames++; bybitLastTs = Date.now();
  for (const d of m.data) {
    const price = Number(d.p), qty = Number(d.v);
    if (!(price > 0) || !(qty > 0)) continue;
    bufferLiq({
      id: ++liqSeq,
      symbol: String(d.s || '').toUpperCase(),
      side: d.S === 'Buy' ? 'long' : 'short',
      usd: price * qty, price, qty,
      ts: Number(d.T) || Date.now(),
    });
  }
}

function subscribeBybit(ws) {
  const topics = bybitSymbols.map(s => `allLiquidation.${s}`);
  for (let i = 0; i < topics.length; i += 10) {   // batch ≤10 args/request
    try { ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) })); } catch { /* ignore */ }
  }
}

async function loadBybitSymbols() {
  if (process.env.BYBIT_LIQ_SYMBOLS) {
    return process.env.BYBIT_LIQ_SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  try {
    const r = await fetch(`${BYBIT_REST}/v5/market/tickers?category=linear`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    const list = (j?.result?.list || []).filter(t => String(t.symbol).endsWith('USDT'));
    list.sort((a, b) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0));
    const picked = list.slice(0, BYBIT_TOP_N).map(t => t.symbol);
    log(`fetched ${list.length} Bybit linear perps — subscribing top ${picked.length} by turnover`);
    return picked;
  } catch (e) {
    log('⚠️ Bybit symbols fetch failed:', e.message, '— using minimal default set');
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'SUIUSDT', 'HYPEUSDT'];
  }
}

function connectBybit() {
  const ws = new WebSocket(BYBIT_WS);
  bybitWs = ws;
  const timer = setTimeout(() => { log('⚠️ Bybit connect TIMEOUT (15s)'); try { ws.terminate(); } catch { /* ignore */ } }, 15_000);
  ws.on('open', () => {
    clearTimeout(timer); bybitUp = true; bybitReconnect = 1000;
    subscribeBybit(ws);
    log(`✓ connected to Bybit — subscribed allLiquidation for ${bybitSymbols.length} symbols`);
  });
  ws.on('message', (d) => onBybitMessage(d.toString()));
  ws.on('error', (e) => { clearTimeout(timer); log('Bybit ws error:', e.message); });
  ws.on('close', (c) => {
    clearTimeout(timer); bybitUp = false;
    log(`Bybit closed (${c}) — reconnecting in ${bybitReconnect}ms`);
    setTimeout(connectBybit, bybitReconnect);
    bybitReconnect = Math.min(bybitReconnect * 2, 30_000);
  });
}

// Bybit drops idle sockets — keep it alive with an app-level ping every 20s.
setInterval(() => {
  if (bybitWs?.readyState === WebSocket.OPEN) { try { bybitWs.send(JSON.stringify({ op: 'ping' })); } catch { /* ignore */ } }
}, 20_000).unref?.();

// ── Upbit cache ────────────────────────────────────────────────────────────
// The bot polls /upbit every 2min, but a LIVE upstream fetch holds the Render↔Fly
// connection open 3-4s while we fetch Upbit — and Render's flaky egress drops that
// long-held request ("(proxy)=fetch failed"), even though the same call is instant
// for /liquidations. So poll Upbit HERE every 30s and serve the cached JSON
// INSTANTLY (same pattern as /liquidations). The bot only ever fetches this path.
const UPBIT_PATH = '/api/v1/announcements?os=web&page=1&per_page=20&category=trade';
const UPBIT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  'Referer': 'https://upbit.com/',
  'Origin': 'https://upbit.com',
};
let upbitCache = null;   // { status, body, contentType, ts }
async function refreshUpbit() {
  try {
    const r = await fetch(UPBIT + UPBIT_PATH, { headers: UPBIT_HEADERS, signal: AbortSignal.timeout(12_000) });
    const body = await r.text();
    upbitCache = { status: r.status, body, contentType: r.headers.get('content-type') || 'application/json', ts: Date.now() };
  } catch (e) { log('upbit refresh failed:', e.message); }
}
setInterval(refreshUpbit, 30_000).unref?.();

// ── HTTP: /health (probe), /liquidations (poll), /upbit/* (proxy) ───────────
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      bybit: { up: bybitUp, frames: bybitFrames, lastFrameAgeMs: bybitLastTs ? Date.now() - bybitLastTs : null, symbols: bybitSymbols.length, buffered: liqBuffer.length },
    }));
    return;
  }
  if (req.url?.startsWith('/liquidations')) {
    // ?sinceId=N → only entries newer than the bot's last-seen id (incremental poll).
    const u = new URL(req.url, 'http://x');
    const sinceId = Number(u.searchParams.get('sinceId')) || 0;
    const rows = sinceId ? liqBuffer.filter(e => e.id > sinceId) : liqBuffer.slice();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ up: bybitUp, lastId: liqSeq, count: rows.length, liquidations: rows }));
    return;
  }
  if (req.url?.startsWith('/upbit/')) {
    // Serve the background cache INSTANTLY when fresh (≤2min) — no blocking upstream
    // fetch over the flaky Render↔Fly hop. Fall back to a live fetch if cache is cold.
    if (upbitCache && Date.now() - upbitCache.ts < 120_000) {
      res.writeHead(upbitCache.status, { 'content-type': upbitCache.contentType, 'x-cache': 'hit' });
      res.end(upbitCache.body);
      return;
    }
    const path = req.url.slice('/upbit'.length);
    try {
      const r = await fetch(UPBIT + path, { headers: UPBIT_HEADERS, signal: AbortSignal.timeout(12_000) });
      const body = await r.text();
      upbitCache = { status: r.status, body, contentType: r.headers.get('content-type') || 'application/json', ts: Date.now() };
      res.writeHead(r.status, { 'content-type': upbitCache.contentType, 'x-cache': 'miss' });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('forwarder ok — GET /health · /liquidations[?sinceId=N] · /upbit/<path>');
});

server.listen(PORT, async () => {
  log(`listening on :${PORT}`);
  refreshUpbit();                       // warm the Upbit cache immediately
  bybitSymbols = await loadBybitSymbols();
  connectBybit();
});
