// Vercel serverless relay, pinned to Singapore (see ../vercel.json).
//
// Routes requests to either Bybit or Binance Futures based on a path prefix,
// so a single Singapore-egress relay unblocks BOTH exchanges for a geo-blocked
// VPS:
//
//   /relay/<path>            → https://api.bybit.com/<path>      (default; the
//                              Bybit signature covers timestamp+key+window+body
//                              only, so relaying is transparent to it)
//   /relay/binance/<path>    → https://fapi.binance.com/<path>   (public
//                              Binance USDⓈ-M Futures data — funding, OI, depth)
//
// Generic Vercel (no framework) doesn't support [...catch-all] file routing —
// that's a Next.js feature. Instead we use ONE function + a rewrite in
// vercel.json: every "/relay/*" request lands here, with the ORIGINAL path +
// query intact. We strip the "/relay" prefix, pick the upstream, and forward
// the remaining path + query bytes verbatim.

const BYBIT = 'https://api.bybit.com';
const BINANCE = 'https://fapi.binance.com';
const COINALYZE = 'https://api.coinalyze.net';   // /relay/coinalyze/* → Coinalyze (bypass VPS IP limits)
const ETHERSCAN = 'https://etherscan.io';        // /relay/etherscan/* → Etherscan (team-wallet holder scrape)
const BSCSCAN = 'https://bscscan.com';           // /relay/bscscan/*   → BscScan
const UPBIT = 'https://api-manager.upbit.com';   // /relay/upbit/*     → Upbit announcements (Cloudflare 403s US datacenter IPs)

export default async function handler(req, res) {
  const secret = process.env.PROXY_SECRET;
  if (secret && req.headers['x-proxy-auth'] !== secret) {
    res.status(403).send('forbidden');
    return;
  }

  // Original request path+query is in req.url. Strip our routing prefix
  // (/relay) — also tolerate the destination path leaking through (/api/proxy).
  const u = new URL(req.url, 'http://localhost');
  let path = u.pathname.replace(/^\/relay/, '').replace(/^\/api\/proxy/, '');

  // Upstream selection by leading segment. "/binance/..." → Binance Futures;
  // everything else → Bybit (preserves the original Bybit-only behaviour).
  let upstream = BYBIT;
  if (path === '/binance' || path.startsWith('/binance/')) {
    upstream = BINANCE;
    path = path.slice('/binance'.length) || '/';
  } else if (path === '/coinalyze' || path.startsWith('/coinalyze/')) {
    upstream = COINALYZE;
    path = path.slice('/coinalyze'.length) || '/';
  } else if (path === '/etherscan' || path.startsWith('/etherscan/')) {
    upstream = ETHERSCAN;
    path = path.slice('/etherscan'.length) || '/';
  } else if (path === '/bscscan' || path.startsWith('/bscscan/')) {
    upstream = BSCSCAN;
    path = path.slice('/bscscan'.length) || '/';
  } else if (path === '/upbit' || path.startsWith('/upbit/')) {
    upstream = UPBIT;
    path = path.slice('/upbit'.length) || '/';
  }

  if (!path || path === '/') {
    res.status(400).json({ relayError: 'no upstream path in request', sawUrl: req.url });
    return;
  }
  const target = upstream + path + u.search;

  // Raw body — must be byte-identical to what the bot signed for POST orders.
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body !== undefined && req.body !== null) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks).toString('utf8');
    }
  }

  const SKIP = new Set([
    'host', 'x-proxy-auth', 'connection', 'content-length',
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'x-real-ip', 'x-vercel-forwarded-for', 'x-vercel-id',
    'x-vercel-deployment-url', 'forwarded', 'accept-encoding'
  ]);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }

  try {
    const resp = await fetch(target, { method: req.method, headers, body });
    const text = await resp.text();
    res.status(resp.status);
    const ct = resp.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    res.send(text);
  } catch (err) {
    res.status(502).json({ relayError: String(err) });
  }
}
