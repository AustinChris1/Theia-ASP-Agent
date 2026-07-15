# Deploying the Theia ASP to Render

Goal: a public, always-on `https://` endpoint in the **Singapore** region, so it
reaches OKX directly (no relay) and can be registered on OKX.AI.

Time: ~15 minutes. You need a GitHub account and a Render account (both free to make).

---

## Step 1 — Put the repo on GitHub (Render deploys from a Git provider)

Your repo is local only. Push it to a **private** GitHub repo (private is fine for
Render; make it public later for the submission if you want). `.env` is gitignored,
so no secret is pushed.

```bash
# from the repo root
git add -A
git commit -m "OKX-first ASP + Singapore deploy config"

# create an EMPTY repo on github.com first (no README), then:
git remote add origin https://github.com/<your-username>/theia-asp.git
git branch -M main
git push -u origin main
```

Double-check no secret went up: on GitHub, confirm there is **no `.env` file** in the
repo (only `.env.example`).

## Step 2 — Create the Render service

Two ways; the Blueprint is easiest because `render.yaml` pre-configures everything.

**A. Blueprint (recommended)**
1. Render dashboard → **New +** → **Blueprint**.
2. Connect your GitHub account, pick the `theia-asp` repo.
3. Render reads `render.yaml` and shows one web service: `theia-asp`, region
   `singapore`, build `npm install`, start `node server.js`, health `/health`.
4. It will prompt for the env vars marked `sync: false` (see Step 3). Fill them,
   then **Apply**.

**B. Manual (if you skip the blueprint)**
1. **New +** → **Web Service** → connect the repo.
2. Region **Singapore**. Runtime **Node**. Build `npm install`. Start `npm start`.
   Health check path `/health`. Instance type: see Step 5.
3. Add env vars in Step 3.

## Step 3 — Environment variables (set in the Render dashboard, never in git)

Minimum for a working deploy right now (x402 stays OFF until the wallet step):

| Key | Value |
|---|---|
| `NODE_VERSION` | `20` |
| `ASP_ENABLE_OKX_MARKET_DATA` | `1` |
| `COINGECKO_API_KEY` | your CoinGecko demo key |
| `COINALYZE_API_KEY` | your Coinalyze key |
| `MORALIS_API_KEY` | your Moralis key |
| `X402_ENFORCE` | `0` |
| `ASP_PUBLIC_URL` | set in Step 4 (leave blank on first deploy) |

Leave `RELAY_BASE_URL` / `RELAY_AUTH_SECRET` **unset** — a Singapore host reaches OKX
directly, so no relay is needed. (You can delete the Fly relay app to stop its billing.)

Do **not** set `X402_PAY_TO`, `X402_ASSET_USDT_ADDRESS`, or `X402_FACILITATOR_URL`
yet — those come from the Agentic Wallet + `x402-check` steps, and enforcement stays
off (`X402_ENFORCE=0`) until all three are set.

## Step 4 — Set the public URL, then redeploy

1. After the first deploy, Render gives you a URL like
   `https://theia-asp.onrender.com`.
2. Add env var `ASP_PUBLIC_URL` = that exact URL.
3. **Manual Deploy → Deploy latest commit** (or just save the env var, which
   triggers a redeploy). The manifest and future x402 challenges use this URL.

## Step 5 — Free vs always-on

- **Free instance**: `$0`, but Render **spins it down after ~15 min idle**, so the
  first call after idle cold-starts (10-30s while the engine reboots). Fine for
  initial testing and a demo you keep warm; **not** fine for a listed ASP that agents
  call anytime.
- **Starter (~$7/mo)**: always-on. Use this before you list on OKX.AI so callers
  never hit a cold start. `render.yaml` sets `plan: starter`; change to `free` in the
  dashboard if you want to test at `$0` first.

> Note: on the free plan Render may restrict the region to the US. If your instance
> is not in Singapore it will be geo-blocked from OKX. In that case either upgrade to
> Starter/Singapore, or (temporary) set `ASP_ENABLE_OKX_MARKET_DATA=0` so it runs on
> Coinalyze-only data until you move it to Singapore.

## Step 6 — Verify the deploy

```bash
curl https://<your-app>.onrender.com/health
# -> {"ok":true,"provider":"Theia","status":{... "okx":true ...}}

curl https://<your-app>.onrender.com/
# -> the service manifest (6 skills, payment mode "off")

curl -XPOST https://<your-app>.onrender.com/skills/theia_signal \
  -H 'content-type: application/json' -d '{"token":"BTC"}'
# -> ok:true with a scored signal
```

In the Render **Logs** tab, a healthy boot shows:
```
price feed: OKX SWAP tickers ...
okx: 405 USDT-SWAP instruments mapped
liq-clusters self-test OK via okx ...
[ta] BTC ... -> N findings
ready -- {"okx":true, ...}
```
If you see `okx: 0 ... mapped` / `okx:false`, the host can't reach OKX — confirm the
region is Singapore (Step 5 note).

## Step 7 — What comes next (not part of this deploy)

Once `/health` is 200 and `okx:true`:
1. Install `onchainos`, log in to the Agentic Wallet → get `X402_PAY_TO` + the X Layer
   USDT address. Add them + `X402_ENFORCE=1` in Render env.
2. Run `onchainos agent x402-check --endpoint https://<your-app>.onrender.com/skills/theia_signal`
   → get the facilitator URL → set `X402_FACILITATOR_URL`, redeploy.
3. Register the 6 A2MCP services + Deep Desk, then list. See `identity/REGISTRATION.md`.

## Notes / gotchas

- **Ephemeral disk**: Render wipes the disk on each deploy. The engine caches and the
  reputation journal (`logs/signals.jsonl`) reset on redeploy. That's fine now (the
  ledger is empty until signals resolve). For a persistent track record later, add a
  free Neon Postgres and set `DATABASE_URL`.
- **First boot is slow** (~1-2 min): it builds the token universe from CoinGecko. A
  `COINGECKO_API_KEY` avoids rate-limit stalls.
- **Auto-deploy**: `autoDeploy: true` means every push to `main` redeploys. Push
  fixes and Render ships them.
- **Secrets**: everything sensitive lives in Render env vars, never in the repo.
  `.env` stays gitignored.
