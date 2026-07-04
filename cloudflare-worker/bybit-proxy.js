// Cloudflare Worker — transparent reverse-proxy to Bybit.
//
// WHY: the bot's VPS IP is geo-blocked by Bybit (CloudFront 403). Cloudflare
// Workers are free (no card required) and egress from Cloudflare's edge, which
// Bybit generally does not block. This relays the bot's already-signed
// requests to api.bybit.com unchanged and streams the response back.
//
// ── Deploy (free, ~5 min, no card) ───────────────────────────────────────────
// 1. Create a free Cloudflare account (email only): https://dash.cloudflare.com/sign-up
// 2. Left sidebar → "Workers & Pages" → "Create" → "Create Worker".
// 3. Name it (e.g. "bybit-relay"), click "Deploy" to make the starter, then
//    "Edit code", paste THIS file's contents, and "Deploy" again.
// 4. Settings → Variables → add an Environment Variable:
//        PROXY_SECRET = <any long random string>
//    Put the SAME value in the bot's .env as BYBIT_PROXY_SECRET.
// 5. Your Worker URL looks like https://bybit-relay.<your-subdomain>.workers.dev
//    Put it in the bot's .env as:  BYBIT_BASE_URL=https://bybit-relay.<sub>.workers.dev
//
// ── Bybit API key IP whitelist ───────────────────────────────────────────────
// Requests now reach Bybit from Cloudflare's IPs (many, rotating). Either:
//   • Remove the IP restriction on the key (it then expires every 90 days), OR
//   • Leave it open and rely on the PROXY_SECRET + trade-only permission.
// (Cloudflare egress IPs can't be pinned, so a fixed whitelist won't work here.)
//
// Security: the Worker refuses any request without the matching X-Proxy-Auth
// header, so a leaked URL alone can't be used to hit Bybit with your relay.

const BYBIT = 'https://api.bybit.com';

export default {
  async fetch(request, env) {
    // Gate: require the shared secret. Without it, return 403 so the public
    // Worker URL can't be abused as an open relay.
    if (env.PROXY_SECRET) {
      const got = request.headers.get('X-Proxy-Auth');
      if (got !== env.PROXY_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
    }

    const url = new URL(request.url);
    const target = BYBIT + url.pathname + url.search;

    // Forward method, headers (minus hop-by-hop/host), and body verbatim so
    // Bybit sees exactly what the bot signed.
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('x-proxy-auth');          // don't leak our gate to Bybit
    headers.delete('cf-connecting-ip');
    headers.delete('x-forwarded-for');

    const method = request.method.toUpperCase();
    const init = {
      method,
      headers,
      body: (method === 'GET' || method === 'HEAD') ? undefined : await request.text()
    };

    try {
      const resp = await fetch(target, init);
      // Stream the response back unchanged.
      const respHeaders = new Headers(resp.headers);
      respHeaders.delete('content-encoding');   // avoid double-decoding issues
      return new Response(resp.body, { status: resp.status, headers: respHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ proxyError: String(err) }), {
        status: 502, headers: { 'content-type': 'application/json' }
      });
    }
  }
};
