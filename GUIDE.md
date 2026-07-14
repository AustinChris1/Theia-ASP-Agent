# Theia ASP — operator + user guide

How the system works, how to run and host it, how to use and test it, and how a
user (or another agent) interacts with it.

## 1. What this is (in one paragraph)

Theia is a deterministic crypto-intelligence engine (`src/`) exposed as an **Agent
Service Provider on OKX.AI**. It sells six paid data skills over **A2MCP** (x402
pay-per-call) and one premium **A2A** escrow audit. All market data comes from
**OKX v5**. The scoring is auditable; an LLM may narrate output but never decides a
trade. Other agents call it, pay in USDT on X Layer, and get structured JSON back.

## 2. How it works (data flow)

```
caller (agent/curl)
      │  POST /skills/theia_signal {token:"BTC"}
      ▼
server.js ── x402 gate (payments/x402.js) ── if enforced: 402 → pay → replay
      │
      ▼
skills/signal.js  (thin adapter, validates input, shapes JSON)
      │  engine.analyze("BTC")
      ▼
engine.js  ── conductor.evaluateForAnalysis()  (the brain, src/conductor.js)
      │
      ├── prices.js      → OKX SWAP tickers        (price, 24h vol)
      ├── ta.js          → OKX candles             (multi-TF RSI/MACD/BB/ATR/SMC)
      ├── funding.js     → OKX funding + OI         (on-demand per token)
      ├── liquidity-clusters.js → OKX orderbook     (heatmap walls)
      ├── liquidation-heatmap.js → Coinalyze        (neutral, liquidation clusters)
      ├── team-wallet-discovery.js → Moralis        (insider/holder discovery)
      └── cex-holdings.js → on-chain RPC            (cold-wallet cornered float)
      │
      ▼
scored read: side, tier, confidence, reasons[], tradePlan{entry,SL,TP1-3,lev}
```

OKX is the exchange source. `okx.com` is geo-blocked from most hosts, so the engine
reaches it through the Singapore relay in `relay/` (a tiny Fly.io reverse-proxy).
Coinalyze/CoinGecko/Moralis are neutral aggregators used for liquidations, the token
universe, and on-chain holders.

Every skill degrades gracefully: if one data source is missing, that skill's fidelity
drops but the server never crashes.

## 3. Run it locally

```
npm install
cp .env.example .env          # fill in the keys below
npm start                     # boots the engine, serves on :8402
npm test                      # 100 unit tests, no live network
```

Minimum `.env` for real reads (all free tiers):
- `RELAY_BASE_URL` + `RELAY_AUTH_SECRET` — the Singapore relay (see `relay/README.md`). This is what makes OKX reachable.
- `COINALYZE_API_KEY` — liquidations + TA fallback
- `COINGECKO_API_KEY` — token universe + spot prices
- `MORALIS_API_KEY` — insider/holder discovery

A healthy boot log shows: `price feed: OKX SWAP tickers`, `okx: N instruments
mapped`, `liq-clusters self-test OK via okx`, and `[ta] BTC ... → N findings`.

## 4. Use it (as a user / another agent)

Free discovery (no payment):
```
curl localhost:8402/            # manifest: skills, prices, payment info
curl localhost:8402/health      # engine subsystem status
curl localhost:8402/reputation  # verifiable win-rate scoreboard
```

Call a skill:
```
curl -XPOST localhost:8402/skills/theia_signal \
  -H 'content-type: application/json' -d '{"token":"BTC"}'
```

Get an A2A audit quote:
```
curl -XPOST localhost:8402/a2a/quote \
  -H 'content-type: application/json' -d '{"description":"audit BTC and ETH","budgetUsdt":20}'
```

The six skills: `theia_signal`, `theia_manipulation_check`, `theia_cex_flow`,
`theia_insider_scan`, `theia_liqmap`, `theia_cex_holdings`. Schemas + prices are in
the manifest (`curl localhost:8402/`).

### MCP (for MCP-native agents)

Same six skills as MCP tools over Streamable HTTP at `POST /mcp` (stateless). An MCP
client does `initialize` then `tools/list` → all six appear.

### The agent-to-agent demo

```
node demo/executor.js --token BTC     # dry-run: prints the call → 402 → pay → act loop
```
With a funded wallet + `X402_ENFORCE=1`, add `--live` to pay for real.

## 5. Test it

- `npm test` — the full unit suite (adapters, x402, reputation, A2A, engine
  functions, OKX client, relay routing). No live network; safe to run anytime.
- Live smoke: start the server and run the curl calls in section 4.
- Relay: `curl https://<your-relay>.fly.dev/health` → `ok`.

## 6. Host it (production)

The A2MCP endpoint must be a public, permanent `https://` URL before you register it
on-chain. Two pieces to deploy:

1. **The relay** (once): `cd relay && fly deploy` (see `relay/README.md`). Gives you
   `https://theia-okx-relay.fly.dev`.
2. **The ASP**: deploy this repo as a Render Web Service (see `render.yaml`):
   - Build `npm install`, Start `npm start`, Health check `/health`.
   - Set the `.env` values as Render environment variables, including the relay URL +
     secret (Render is a US host, so it needs the relay to reach OKX).
   - Set `ASP_PUBLIC_URL` to the Render URL.

Once `GET /health` returns 200 at your Render URL, follow
`identity/REGISTRATION.md` to register + list on OKX.AI.

## 7. Go live on OKX.AI (the submission path)

Full steps: `identity/REGISTRATION.md`. Summary:
1. Deploy relay + ASP; confirm `/health` = 200.
2. Log in to the Agentic Wallet; set `X402_PAY_TO`.
3. Wire live x402: X Layer USDT address + facilitator; `X402_ENFORCE=1`; pass `onchainos agent x402-check`.
4. Register the ASP + 6 A2MCP services + the A2A Deep Desk service (`identity/build-manifest.js` prints the service array).
5. List it; anchor the reputation ledger once.
6. Record the <=90s demo (`DEMO.md`), post on X with #okxai, submit the Google form.

Submission checklist + category positioning: `SUBMISSION.md`.

## 8. Where to read more

- `README.md` — entry point + skill table.
- `NOTES-okx.md` — OKX integration ground truth (x402, X Layer, A2MCP vs A2A).
- `CLAUDE.md` — architecture map (what lives where).
- `DEMO.md` — the 90-second video script.
- `relay/README.md` — the relay deploy.
