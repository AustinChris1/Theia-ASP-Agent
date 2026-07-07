// Cloudflare Worker: multi-upstream data relay for the Theia engine.
// Cloud/residential IPs are geo-blocked or rate-limited by these venues; the Worker
// egresses from Cloudflare's edge and forwards requests unchanged. Routes by prefix:
//   /okx/*       -> https://www.okx.com        (candles, funding, OI, orderbook)
//   /binance/*   -> https://fapi.binance.com   (funding, OI, orderbook depth)
//   /coinalyze/* -> https://api.coinalyze.net  (TA OHLCV, funding, liquidations)
//   everything else -> https://api.bybit.com   (klines, price, orderbook)
//
// Deploy (free, ~3 min): create a Cloudflare account, then from this folder:
//   npx wrangler secret put PROXY_SECRET      # any long random string
//   npx wrangler deploy
// Then in the app .env set (same value for both bases):
//   RELAY_BASE_URL=https://theia-relay.<sub>.workers.dev
//   BYBIT_BASE_URL=https://theia-relay.<sub>.workers.dev
//   BYBIT_PROXY_SECRET=<the PROXY_SECRET>

const ROUTES = [
  { prefix: '/okx', host: 'https://www.okx.com' },
  { prefix: '/binance', host: 'https://fapi.binance.com' },
  { prefix: '/coinalyze', host: 'https://api.coinalyze.net' },
];
const DEFAULT_HOST = 'https://api.bybit.com';

export default {
  async fetch(request, env) {
    // Gate on the shared secret so a leaked URL can't be abused as an open relay.
    if (env.PROXY_SECRET && request.headers.get('X-Proxy-Auth') !== env.PROXY_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const url = new URL(request.url);
    const route = ROUTES.find((r) => url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'));
    const host = route ? route.host : DEFAULT_HOST;
    const fwdPath = route ? url.pathname.slice(route.prefix.length) : url.pathname;
    const target = host + fwdPath + url.search;

    // Forward method/headers/body verbatim so signed requests reach the venue intact.
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('x-proxy-auth');
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');

    const method = request.method.toUpperCase();
    const init = {
      method,
      headers,
      body: (method === 'GET' || method === 'HEAD') ? undefined : await request.text(),
    };

    try {
      const resp = await fetch(target, init);
      const respHeaders = new Headers(resp.headers);
      respHeaders.delete('content-encoding');
      return new Response(resp.body, { status: resp.status, headers: respHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ proxyError: String(err) }), {
        status: 502, headers: { 'content-type': 'application/json' },
      });
    }
  },
};
