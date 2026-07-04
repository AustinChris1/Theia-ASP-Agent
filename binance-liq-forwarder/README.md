# binance-liq-forwarder

Tiny WS relay that fixes Binance liquidation alerts when the bot's host is geo-blocked
from Binance market data (Render US → "connected but 0 frames"). Run it on a **non-US**
host; it holds the `!forceOrder@arr` socket open and re-broadcasts every frame to the bot.

## Why it's needed

Binance lets a US IP *open* `wss://fstream.binance.com/ws/!forceOrder@arr` but pushes it
**zero data**. A REST relay (the Vercel one) can't carry a WebSocket. So this service runs
where Binance is reachable (Singapore/EU) and forwards the stream.

## Deploy — Fly.io (free, always-on, Singapore)

```bash
npm i -g flyctl          # if not installed
fly auth login
cd binance-liq-forwarder
fly launch --no-deploy --name <unique-name> --region sin   # generates app (keep this fly.toml)
fly deploy
fly status               # note the hostname → <unique-name>.fly.dev
```

Then in the **bot's** env (Render):
```
BINANCE_LIQ_WS_URL=wss://<unique-name>.fly.dev
```
Redeploy the bot. Within ~30s its log should flip to:
`[binance-liq] receiving data ✓ — liquidation stream is LIVE`

## Deploy — Railway (alternative)

```bash
npm i -g @railway/cli && railway login
cd binance-liq-forwarder && railway init && railway up
```
Set the service region to a non-US one in the Railway dashboard, then use the public
domain as `BINANCE_LIQ_WS_URL` (Railway gives `wss://<name>.up.railway.app`).

## Verify it works (before touching the bot)

```bash
curl https://<your-host>/health
# {"up":true,"frames":1234,"lastFrameAgeMs":420,"clients":0}   ← up:true + frames climbing = good
```
If `up:false` or `frames:0`, THIS host is also geo-blocked — pick a different region.

## Optional auth

Set `FORWARDER_AUTH=<secret>` on the forwarder and append `?auth=<secret>` to
`BINANCE_LIQ_WS_URL` so only your bot can connect.
