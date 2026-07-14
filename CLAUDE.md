# CLAUDE.md — working in this codebase

Node.js **ESM** project. Theia's deterministic crypto intelligence engine (`src/`)
exposed as an **OKX.AI Agent Service Provider** at the repo root. The engine scores
confluence, manipulation, insider/CEX flow, and liquidation risk; the ASP layer
sells that intelligence to other agents via A2MCP (x402 pay-per-call) and A2A
(escrow). The Telegram bot, autotrade, and billing were removed; only the
intelligence core (`src/`) plus the ASP app (root) remain.

## Run / test

- Start: `npm start` (`node server.js`). Serves free until x402 is enforced.
- Tests: `npm test` (`node test/asp-sanity.js`) — pure unit suite, no live API calls. Always run after changes.
- No linter/build step. Node >= 20. Verify edits with `node --check <file>`.

## Where things live

| Concern | File |
|---|---|
| ASP host (x402 HTTP + MCP + manifest/health/reputation/a2a) | `server.js` |
| Headless engine boot (imports src/, graceful degradation) | `engine.js` |
| Six A2MCP skill adapters | `skills/*.js` |
| Seller-side x402 V2 middleware (X Layer, configurable facilitator) | `payments/x402.js` |
| A2A Deep Desk (conviction filter, audit, report, CLI hooks) | `a2a/deep-desk.js` |
| Reputation ledger (real outcomes -> Merkle root on X Layer) | `reputation/ledger.js` |
| Executor-agent demo (pays via x402 then acts) | `demo/executor.js` |
| Registration manifest + steps | `identity/build-manifest.js`, `identity/REGISTRATION.md` |
| Fresh config + env | `config.js`, `.env.example` |
| Signal scoring + trade-plan builder (the brain) | `src/conductor.js` |
| Outcome resolver + win-rate stats | `src/signal-tracker.js` |
| Multi-TF technical analysis | `src/ta.js`, `src/ta-confirm.js`, `src/timeframes.js`, `src/smc.js` |
| OKX market data (prices/funding/OI/candles/orderbook/CVD) | `src/okx.js` (client), `src/prices.js`, `src/funding.js`, `src/liquidity-clusters.js`, `src/coinalyze.js` (neutral fallback) |
| Insider/team discovery + cold-wallet holdings | `src/team-wallet-discovery.js`, `src/cex-holdings.js` |
| Persistence (Neon kv + journal, JSON fallback) | `src/db.js` |

## Conventions / gotchas

- The ASP IMPORTS the engine from `src/`; it never forks the scoring. `conductor.evaluateForAnalysis({symbol, allowFetch:true})` is the spine of `theia_signal`.
- The engine is deterministic and auditable. An LLM may narrate output, never decide a trade.
- The ASP reads ONLY the root `.env` (fresh, ASP-only). The x402 wallet lives in the `onchainos` CLI/TEE, not in env.
- OKX v5 is the exchange source for all market data (`src/okx.js`): prices, funding, OI, candles, orderbook, CVD. `okx.com` is geo-blocked from many hosts, so route it via the Fly Singapore relay in `relay/` (`RELAY_BASE_URL` + `RELAY_AUTH_SECRET`; OKX auto-routes `${RELAY_BASE_URL}/okx`). Coinalyze/CoinGecko/Moralis remain as neutral aggregators.
- Every external `fetch` uses `AbortSignal.timeout(...)`. Keep that.
- Secrets: `.env`, `logs/` are gitignored. Never commit a secret. This repo may become a public submission.
- Keep comments terse (one line max). No em-dashes in user-facing copy or docs.

## OKX ground truth + docs

`NOTES-okx.md` is authoritative for the OKX integration (x402 V2, X Layer 196,
A2MCP vs A2A, registration, reputation). `README.md` is the entry point;
`identity/REGISTRATION.md` and `SUBMISSION.md` cover listing + submission;
`DEMO.md` is the 90-second video script.
