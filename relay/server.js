

import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.PROXY_SECRET || '';
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

const ROUTES = [
  { prefix: '/okx', host: 'https://www.okx.com' },
  { prefix: '/coinalyze', host: 'https://api.coinalyze.net' },
];
const DEFAULT_HOST = 'https://www.okx.com';

const REQ_STRIP = new Set(['host', 'connection', 'content-length', 'x-proxy-auth', 'accept-encoding']);
const RESP_STRIP = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection']);

export function resolveTarget(pathname, search) {
  const route = ROUTES.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'));
  const host = route ? route.host : DEFAULT_HOST;
  const fwdPath = route ? pathname.slice(route.prefix.length) : pathname;
  return host + fwdPath + (search || '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://local');
    if (u.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (SECRET && req.headers['x-proxy-auth'] !== SECRET) { res.writeHead(403); return res.end('forbidden'); }

    const target = resolveTarget(u.pathname, u.search);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!REQ_STRIP.has(k.toLowerCase())) headers[k] = v;
    }
    const method = req.method.toUpperCase();
    const body = (method === 'GET' || method === 'HEAD') ? undefined : await readBody(req);

    const upstream = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const out = {};
    upstream.headers.forEach((val, key) => { if (!RESP_STRIP.has(key.toLowerCase())) out[key] = val; });
    res.writeHead(upstream.status, out);
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ proxyError: String((err && err.message) || err) }));
  }
});

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  server.listen(PORT, () => console.log(`[relay] listening on :${PORT} region=${process.env.FLY_REGION || '?'}`));
}

export default server;
