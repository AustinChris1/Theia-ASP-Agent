// Binance liquidation WS forwarder — the missing link for liquidations.
//
// PROBLEM: the bot's host (and the US Render region) is GEO-BLOCKED from Binance,
// and Binance's only all-market liquidation feed is a WebSocket (no REST). The
// Vercel relay is REST-only serverless, so it can't carry a WS.
//
// SOLUTION: deploy THIS tiny service on a NON-US host where Binance is reachable
// (Railway, Fly.io, a $5 VPS, or Render's Singapore region all work). It holds the
// `!forceOrder@arr` stream and re-broadcasts every raw frame to connected clients.
// Then set the bot's BINANCE_LIQ_WS_URL=wss://<this-service-url> and the bot parses
// the frames exactly as if it reached Binance directly.
//
// DEPLOY:
//   1. New empty repo/dir with this file + a package.json ({"type":"module",
//      "dependencies":{"ws":"^8.18.0"}}). `npm i`.
//   2. Start command: `node binance-liq-forwarder.js`  (binds PORT, default 8080).
//   3. Host must expose wss:// (Railway/Fly/Render give you an HTTPS URL → use wss).
//   4. In the BOT's env: BINANCE_LIQ_WS_URL=wss://your-forwarder.up.railway.app
//   5. Watch the bot logs for `[binance-liq] connected (wss://your-forwarder…)`.
import WebSocket, { WebSocketServer } from 'ws';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 8080;
const UPSTREAM = 'wss://fstream.binance.com/ws/!forceOrder@arr';

const server = http.createServer((req, res) => { res.writeHead(200); res.end('binance-liq-forwarder ok'); });
const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

let upstream;
function connectUpstream() {
  upstream = new WebSocket(UPSTREAM);
  upstream.on('open', () => console.log('[forwarder] connected to Binance !forceOrder'));
  upstream.on('message', (data) => {
    const frame = data.toString();
    for (const c of clients) if (c.readyState === WebSocket.OPEN) { try { c.send(frame); } catch { /* drop */ } }
  });
  upstream.on('close', () => { console.warn('[forwarder] upstream closed — reconnecting in 2s'); setTimeout(connectUpstream, 2000); });
  upstream.on('error', (e) => console.warn('[forwarder] upstream error:', e.message));
}
connectUpstream();
server.listen(PORT, () => console.log(`[forwarder] listening on :${PORT}`));
