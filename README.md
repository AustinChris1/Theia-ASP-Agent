# Theia ASP — an OKX.AI Agent Service Provider

Theia is a crypto intelligence engine (in `src/`) exposed as an **Agent Service
Provider** on OKX.AI. Other agents pay Theia to call:

- **A2MCP (pay-per-call, x402):** six skills, priced $0.02 to $0.10 in USDT on X
  Layer, settled instantly per call.
- **A2A (escrow):** "Theia Deep Desk", a full multi-token audit delivered as a
  structured report, escrow-backed, released on sign-off.

Plus a **verifiable-alpha ledger**: Theia's real resolved-signal win-rate, hashed
into a Merkle root anchored on X Layer, so the track record is auditable, not
claimed.

The scoring engine is imported from `src/`, not rebuilt. It is deterministic and
auditable: an LLM may narrate output but never decides a trade.

## The six A2MCP skills

| Skill | What it returns | Price |
|---|---|---|
| `theia_signal` | Confluence side, tier, confidence, scored reasons, full trade plan (entry, SL, TP1-3, R, leverage, horizon) | $0.10 |
| `theia_manipulation_check` | Pump-and-dump / wash-trade risk 0-100% with flags | $0.05 |
| `theia_cex_flow` | Direction and materiality of supply into/out of exchange cold custody | $0.05 |
| `theia_insider_scan` | Largest non-exchange insider holders + top-10 concentration | $0.05 |
| `theia_liqmap` | Leverage-liquidation clusters above/below price by leverage | $0.05 |
| `theia_cex_holdings` | Cornered float: cold-wallet concentration by token or exchange | $0.02 |

## Layout

```
server.js            HTTP host: x402-gated /skills/<name>, MCP /mcp, free /manifest /health /reputation /a2a/quote
engine.js            headless boot of the intelligence engine (imports src/, no telegram/bot/autotrade)
config.js            fresh env from .env only
skills/              thin adapters over the engine, one per A2MCP skill, each schema-validated
payments/x402.js     seller-side x402 V2 middleware (X Layer, configurable facilitator)
a2a/deep-desk.js     A2A audit: conviction filter, multi-skill run, report, CLI hooks
reputation/ledger.js real resolved-outcome win-rate + Merkle root + X Layer anchor
demo/executor.js     an agent that pays theia_signal via x402 then acts (the demo loop)
identity/            service manifest + the exact onchainos registration steps
src/                 the imported intelligence engine (21 files)
test/                unit suite (no live network)
```

The engine boots only the subsystems needed for on-demand analysis (universe,
prices, TA, funding, liquidation heatmap, insider discovery, CEX holdings). Every
optional subsystem degrades gracefully: a missing data key lowers one skill's
fidelity, never crashes the server.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in. Minimum for real reads:
   - `RELAY_BASE_URL` + `RELAY_AUTH_SECRET` (recommended): the Fly Singapore relay in `relay/`. `okx.com` is geo-blocked from most hosts, so this is what makes OKX prices/funding/OI/candles/orderbook reachable. See `relay/README.md`.
   - `COINALYZE_API_KEY` (neutral fallback for liquidations + TA cache): coinalyze.net, free tier
   - `COINGECKO_API_KEY` (token universe + spot prices): coingecko.com, free demo tier
   - `MORALIS_API_KEY` (insider/holder discovery): moralis.io, free tier
   - `ASP_ENABLE_OKX_MARKET_DATA=0` only if you have no relay and okx.com is blocked from your IP
   - For live x402: `X402_PAY_TO`, `X402_ASSET_USDT_ADDRESS`, `X402_FACILITATOR_URL`, `X402_ENFORCE=1`

### Market data

All exchange data comes from **OKX v5** (`src/okx.js`): SWAP tickers (prices), funding
rate, open interest, candles (multi-timeframe TA), orderbook depth (liquidity
clusters), and taker-volume (CVD). Coinalyze and CoinGecko are kept as neutral
aggregators for liquidations, TA cache, and the token universe. Deploy the Singapore
relay in `relay/` so a US host (or a geo-blocked local IP) can reach OKX.

## Run

```
npm start          # boot the engine + start the server (default :8402)
```

Then:
```
curl localhost:8402/                              # service manifest
curl localhost:8402/health                        # engine subsystem status
curl localhost:8402/reputation                    # win-rate scoreboard
curl -XPOST localhost:8402/skills/theia_signal -H 'content-type: application/json' -d '{"token":"BTC"}'
curl -XPOST localhost:8402/a2a/quote -H 'content-type: application/json' -d '{"description":"audit BTC and ETH","budgetUsdt":20}'
```

With `X402_ENFORCE=0` (default) the skill endpoints serve free so you can develop
and demo. With `X402_ENFORCE=1` plus a `payTo` + asset + facilitator, they return a
402 challenge and require x402 payment.

### MCP

The same six skills are exposed as MCP tools over Streamable HTTP at `POST /mcp`
(stateless). `initialize` then `tools/list` returns all six.

### Demo executor (agent-to-agent loop)

```
npm run demo -- --token BTC                       # dry-run: prints the pay/replay loop
node demo/executor.js --token SOL --url https://theia-asp.onrender.com --live
```

## Tests

```
npm test           # ASP adapters + x402 + reputation + A2A + engine functions (no live network)
```

## Deploy (Render)

The A2MCP endpoint must be a public, permanent `https://` URL before you register
it on-chain. Deploy this repo as a Render Web Service (see `render.yaml`):
- Build: `npm install`
- Start: `npm start`
- Env: set the `.env` values as Render environment variables (config reads real env
  vars over the file, so a committed `.env` is not needed on Render).
- Health check path: `/health`

Once `GET /health` returns 200 at your Render URL, follow
[identity/REGISTRATION.md](identity/REGISTRATION.md).

## Security

- No secret is read, copied, or committed. `.env`, `logs/`, and key material are
  gitignored. This repo is treated as a potential public submission.
- The x402 receiving wallet key lives in the `onchainos` CLI / TEE, never in this
  code or env.
- Every external fetch keeps an `AbortSignal.timeout`.

## Ground truth

The OKX integration facts (x402 V2, X Layer 196, A2MCP vs A2A, registration,
reputation) are documented from the installed `okx/onchainos-skills` package and
CLI source in [NOTES-okx.md](NOTES-okx.md). Open items (facilitator URL, X Layer
token addresses) are called out there and are config-driven.
