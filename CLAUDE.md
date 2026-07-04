# CLAUDE.md — working in this codebase

Single-process Node.js **ESM** Telegram bot. Event-driven: data-source monitors
emit events → the **Conductor** scores confluence → **SignalTracker** resolves
outcomes → **Notifier** broadcasts to Telegram; **AutoTrader** optionally executes.

## Run / test

- Start: `npm start` (`node src/index.js`); `npm run dev` for `--watch`.
- Tests: `node test/sanity.js` — pure unit suite, **no live API calls**, 136 passing. Always run after changes.
- No linter/build step. Node ≥ 20. Verify edits with `node --check <file>`.

## Where things live

| Concern | File |
|---|---|
| Signal scoring + trade-plan builder (the brain, ~2.4k lines) | `src/conductor.js` |
| Outcome resolver + progressive TP (`#scan`) | `src/signal-tracker.js` |
| Multi-TF technical analysis | `src/ta.js`, `src/ta-confirm.js`, `src/timeframes.js`, `src/smc.js` |
| Telegram commands + inline menus (~2.1k lines) | `src/bot-commands.js` |
| Telegram transport / formatting | `src/telegram.js` |
| Boot + wiring of every subsystem | `src/index.js` |
| Prices (Binance primary, CoinGecko fallback) | `src/prices.js` |
| Funding / OI | `src/funding.js`, `src/binance-futures.js` |
| Coinalyze client (rate-gated) | `src/coinalyze.js` |
| On-chain flows | `src/onchain-evm.js`, `src/onchain-sol.js` |
| Insider/team discovery (Moralis + scrape) | `src/team-wallet-discovery.js`, `src/wallet-label-resolver.js` |
| Autotrade | `src/autotrade/{auto-trader,risk-engine,exchange-bybit,paper-broker,store,user-accounts}.js` |
| Encrypted key vault (AES-256-GCM) | `src/crypto-vault.js` |
| Persistence (Neon kv + journal) | `src/db.js` |

## Persistence model

- `src/db.js` exposes `kvGet/kvSet/kvAll` (namespaced JSON docs) and `journalUpsert/journalAll` (rows). Active only when `DATABASE_URL` (Neon) is set; otherwise everything falls back to JSONL/JSON files in `logs/`.
- **Render's filesystem is ephemeral** — anything that must survive a redeploy MUST go through `db.js`. node-pg serialises JS arrays as Postgres array literals, so kv values are stored `JSON.stringify(val)::jsonb` (see `db.js`); don't pass raw arrays.
- Per-user isolation is by namespace/key: operator store ns `autotrades`, user stores ns `autotrades-user-<chatId>`, paper dbKey `paper-user-<chatId>`.

## Conventions / gotchas

- **Identity = `from.id`**, not `chat.id` (`bot-commands.js #isOperator`). Money UI is **private-chat only** (`#privateOnly`). See `memory/money-ui-privacy.md`.
- Bybit/Binance are **geo-blocked** from the host → route via the relay (`BYBIT_BASE_URL`, header `X-Proxy-Auth`). Don't add direct `api.bybit.com` calls.
- Every external `fetch` uses `AbortSignal.timeout(...)`. Keep that.
- Secrets: `.env` is gitignored and holds real keys — never commit it. Adding a var to `.env.example` means adding it to `.env` too (`memory/env-mirror-rule.md`).
- Signal philosophy: **"analyze loose, fire strict"** — loosen detection, keep firing thresholds + guards tight (`memory/signal-tuning-philosophy.md`).
- The Conductor emits `signal` / `observation` / `insiderSell`; PriceMonitor emits `surge`; SignalTracker emits `resolved` / `tpProgress`. index.js wires these to the notifier/autotrader.

## Known gaps (2026-06-09 audit — see CHANGELOG §0d)

- `risk-engine.js` daily-loss breaker is in-memory → resets on restart (live-money safety gap).
- Movers-scan path (`conductor.evaluateTokenAndMaybeEmit`) skips the `confirmSignal` veto that event signals get.
- No synchronous same-symbol reservation in `AutoTrader#handle` (concurrent double-fill risk).

## Docs

`docs/CHANGELOG.md` is authoritative for current behaviour. `docs/ARCHITECTURE.md`,
`SIGNAL_PIPELINE.md`, `TRADE_PLAN.md` describe the pre-overhaul baseline (line
numbers stale) — cross-check against CHANGELOG. `README.md` is the entry point.
