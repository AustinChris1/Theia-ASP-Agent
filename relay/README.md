# Theia data relay (Fly.io, Singapore egress)

`okx.com` blocks many US and cloud IPs, so it returns 000 / 403 from most hosts and
from Render. This relay runs a real container in a region OKX allows (Singapore) and
forwards requests to it. Fly pins the egress region; serverless/edge platforms egress
from IPs that are often blocked.

Routes: `/okx/*` -> okx.com, `/coinalyze/*` -> api.coinalyze.net (neutral fallback).
Gated by the `X-Proxy-Auth` header.

## Deploy (~3 min, free tier)

```
cd relay
fly launch --no-deploy --name theia-okx-relay --region sin   # accept the Dockerfile
fly secrets set PROXY_SECRET=$(openssl rand -hex 24)          # save this value
fly deploy
```

Your URL is `https://theia-okx-relay.fly.dev`. Check it:

```
curl https://theia-okx-relay.fly.dev/health                  # -> ok
curl -s -H "X-Proxy-Auth: <secret>" \
  "https://theia-okx-relay.fly.dev/okx/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=2"
```

If Singapore is ever blocked, redeploy in another region: `fly regions set nrt`
(Tokyo) or `hkg` (Hong Kong), then `fly deploy`.

## Wire into the app `.env`

```
RELAY_BASE_URL=https://theia-okx-relay.fly.dev
RELAY_AUTH_SECRET=<the PROXY_SECRET>
ASP_ENABLE_OKX_MARKET_DATA=1
# OKX auto-routes via ${RELAY_BASE_URL}/okx; leave OKX_BASE_URL blank
```

Restart the app. You should see `okx: N instruments mapped`, the `liq-clusters
self-test` pass via okx, and funding/OI fill in. Set the same vars on Render so the
deployed ASP reaches OKX too.
