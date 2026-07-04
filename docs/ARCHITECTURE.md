# Trade Alert Bot — Architecture

> **⚠️ Updated since this was written.** Major additions — weekly (1w)
> timeframe, Binance price/funding/heatmap via the Singapore relay, hybrid
> Binance-tickers + CoinGecko price feed, dominance-based orderbook-heatmap
> scoring in all paths, a BTC market-regime filter, and trailing stops — are
> recorded in **[CHANGELOG.md](CHANGELOG.md)**. The subsystem notes below have
> been refreshed; the deeper flow/formula docs ([SIGNAL_PIPELINE.md](SIGNAL_PIPELINE.md),
> [TRADE_PLAN.md](TRADE_PLAN.md)) predate those changes — cross-check the changelog.

## 1. High-Level Overview

The Trade Alert Bot is an event-driven Node.js process that fuses on-chain CEX wallet flow with off-chain perp-market data (1m price surges, funding rate / OI, liquidations, L2 orderbook, multi-timeframe TA, and exchange listings) into a single weighted scoring engine — the **Conductor** — which emits two classes of Telegram alerts (`observation` and `signal`) and, optionally, forwards the signals to an isolated **AutoTrader** that places real or paper orders on Bybit USDT-margined linear perps via a geo-bypass relay (Vercel Singapore or Cloudflare Workers). Every signal is journaled to `logs/signals.jsonl` and resolved by a 5-minute background tick that fetches Coinalyze 1m OHLCV bars and detects wick-aware SL/TP touches, writing outcomes back to the same file plus (optionally) a Google Sheet via Apps Script. The whole system is single-process: subsystems communicate exclusively through Node `EventEmitter` events plus direct method calls from `index.js`, with `Universe` (the CoinGecko-built token registry) shared by every component as the single source of truth for what to watch.

## 2. ASCII Diagram

```
                                  ┌──────────────────────────┐
                                  │   Universe (CoinGecko)   │  <── tokens.json + user-watchlist.json (pinned)
                                  │  cgId → {symbol,chains,  │
                                  │   fdv, fdvRatio, ...}    │
                                  └──────────┬───────────────┘
                                             │ (lookups, allCgIds, isFavored, isPinned)
                                             ▼
 ┌─────────────────────┐   flow   ┌──────────────────────────────────────────────┐
 │ EvmMonitor (ETH)    ├─────────►│                                              │
 │ EvmMonitor (BSC)    ├─────────►│                                              │
 │ SolanaMonitor       ├─────────►│                                              │
 ├─────────────────────┤          │                                              │
 │ TeamWalletDiscovery │ index ──►│                                              │
 │ WalletLabelResolver │ lookups─►│                                              │
 ├─────────────────────┤  surge   │              CONDUCTOR                       │
 │ PriceMonitor (CG)   ├─────────►│        (scoring + plan engine)               │   signal
 ├─────────────────────┤  liq     │                                              ├─────────►┐
 │ LiquidationMonitor  ├─────────►│  triggers: flow / surge / liq /              │   obs    │
 ├─────────────────────┤  state   │     funding_extreme / movers / manual        ├─────────►┤
 │ FundingMonitor      │ pulled──►│                                              │          │
 │   (Binance or       │ on eval  │  context: funding+OI+L/S, recent flows/      │          │
 │    Coinalyze)       │          │   surges/liqs, supplyPct, TA, liq-cluster    │          │
 ├─────────────────────┤  TA pulled│   magnets, orderbook walls, FDV overhang    │          │
 │ TAService (Coinalyze│ on eval──►│                                              │          │
 │   OHLCV + indicators)│         │  → raw score → tier (MIXED..VERY HIGH) →     │          │
 ├─────────────────────┤ pulled──►│    quality penalties → confirmSignal gate    │          │
 │ LiquidityClusters   │ on eval  │  → trade plan (entry/SL/TP/leverage/horizon) │          │
 │   (Bybit/OKX/Binance│          │                                              │          │
 │    orderbook L2)    │          └──────────────────────────────────────────────┘          │
 ├─────────────────────┤                                                                    │
 │ ListingMonitor      ├──────────────► direct notifier (its own alert path) ───────────────┤
 │ (Upbit/Binance/     │                                                                    │
 │  Bithumb)           │                                                                    │
 └─────────────────────┘                                                                    │
                                                                                            │
                                                  ┌─────────────────────────────────────────┘
                                                  │
                                                  ▼
                              ┌─────────────────────────────────────────┐
                              │           index.js dispatcher           │
                              │  (signal/observation/resolved/listing)  │
                              └─┬──────────────┬──────────────┬─────────┘
                                │              │              │
                ┌───────────────┘              │              └──────────────────┐
                ▼                              ▼                                 ▼
       ┌─────────────────┐         ┌────────────────────────┐         ┌──────────────────┐
       │  Notifier       │         │   SignalTracker        │         │   AutoTrader     │
       │  (Telegram bot, │         │   logs/signals.jsonl   │         │   (paper | live  │
       │   subscribers,  │         │   + 5m resolveOpen tick│         │    | off)        │
       │   BotCommands)  │         │   + sheetLogger mirror │         └────────┬─────────┘
       └────────┬────────┘         └──────────┬─────────────┘                  │
                │                             │                                │
                │           resolved (LOSS/WIN_TP{1,2,3}/EXPIRED_*)            │
                │              ────────────────►  back to Conductor            │
                │                  (recordLoss → post-loss cooldowns)          │
                ▼                                                              ▼
        Subscribers chats                                              ┌─────────────────┐
        (signals, observations,                                        │  RiskEngine     │
         outcomes, listings,                                           │  + PaperBroker  │
         funding leaders, movers)                                      │  + BybitExchange│──► Vercel-relay (SIN) ──► api.bybit.com
                                                                       │   (signed v5)   │   or Cloudflare Worker
                                                                       └─────────────────┘   or direct (if no geo-block)
                                                                                 │
                                                                                 ▼
                                                                       logs/autotrades.jsonl
```

## 3. Per-Subsystem Reference

### 3.1 Universe — token registry
- **Purpose:** single source of truth for which tokens the bot watches. Built once at boot from CoinGecko `/coins/markets` (top-N by market cap + top-by-volume + pinned), persisted to `src/config/.universe-cache.json`, mutable at runtime via `/watchlist add`. Exposes `lookupByCgId`, `lookupByAddress(chain,addr)`, `allCgIds`, `isFavored`, `isPinned`, `setHotMovers`, `setDecimals`.
- **Files:** `src/universe.js`, config in `src/config/tokens.json` + `logs/user-watchlist.json`.
- **Inputs:** CoinGecko REST.
- **Outputs:** in-memory token info maps consumed by every other subsystem.
- **Dependencies:** `./coingecko.js`, on-disk cache.

### 3.2 PriceMonitor — 1m price surge detector (hybrid feed)
- **Purpose:** keep a 180s rolling price history per cgId and emit `surge` events when the 60s % change crosses threshold and the 24h volume floor passes.
- **Feed (updated):** **Binance `/fapi/v1/ticker/24hr`** via the Singapore relay — ALL perps in ONE call / 60s — is the primary price + 24h% + volume source for perp-listed tokens. **CoinGecko `/coins/markets`** drops to a slow poll (every `PRICE_CG_EVERY_N` ticks ≈ 15min) for the spot-only remainder. Degrades to CoinGecko-only if the relay is absent/unreachable (`PRICE_BINANCE=0` forces this). Ended the monthly CoinGecko-quota exhaustion. See [CHANGELOG §1](CHANGELOG.md).
- **Files:** `src/prices.js`.
- **Outputs:** `surge` events `{token, direction, pctChange, open, close, high, low, timestamp}`, plus `getPrice(cgId)`, `getTopMovers(n)`.
- **Quirks:** favored tokens use `max(1.5%, surgePct-1)` and bypass volume floor; surge resets history to prevent re-fire; meme `1000XXX` pairs fall through to CoinGecko (avoid 1000×-scaled price).

### 3.3 FundingMonitor (Binance Futures or Coinalyze fallback)
- **Purpose:** poll funding rate + open interest for all mapped perps, expose `bySymbol`/`getByCgId`, plus rolling 1h/4h funding velocity for top 50 by |avg|. State persisted atomically (`logs/funding-state.json`).
- **Files:** `src/funding.js` (Coinalyze path), `src/binance-futures.js` (**primary** — reached directly or via the Singapore relay when geo-blocked).
- **Inputs:** Binance Futures (`premiumIndex`, `openInterest`, `fundingRate`, `fundingInfo`) or Coinalyze REST.
- **Updated:** Binance funding is normalised to a **per-8h equivalent** using `/fapi/v1/fundingInfo` — most pairs now settle on 1h/4h intervals, so an un-normalised 4h rate would be silently half-scored. Velocity is computed for the Binance path too. See [CHANGELOG §1](CHANGELOG.md).
- **Outputs:** `getByCgId(cgId)` / `bySymbol.get(SYM)` returning `{summary:{avg, totalOi, velocity1h, velocity4h, fundingIntervalHrs, ...}}`, plus `fundingLeaders` / `formatFundingLeaders`, plus scoring helpers `fundingScoreForSide`, `oiScoreForSide`, `describeFunding`, `describeOI`.
- **Quirks:** `MAX_PLAUSIBLE_FUNDING=5%`/period guards bad rows; STATE_TTL=2h; thresholds NEUTRAL=0.01%, ELEVATED=0.05%, EXTREME=0.10% (on the 8h frame).

### 3.4 LiquidationMonitor
- **Purpose:** poll Coinalyze `liquidationHistory` per minute, bucket per-minute points, emit `liquidation` events when `longLiq+shortLiq ≥ minLiquidationUsd` (default $500k), dedupe by `(symbol|t)`.
- **Files:** `src/liquidations.js`.
- **Inputs:** Coinalyze, perpSymbolMap.
- **Outputs:** `liquidation` events `{symbol, longLiq, shortLiq, total, dominantSide, dominantUsd, bias}` (bias = short squeeze → LONG; long cascade → SHORT).

### 3.5 LiquidityClusters — orderbook heatmap (lazy)
- **Purpose:** on-demand build of top 10 ask/bid clusters from L2 depth, bucketized into 0.5% bands relative to mid; 60s cache + in-flight dedup.
- **Files:** `src/liquidity-clusters.js`. Exposed to users via `/heatmap <SYM>`.
- **Inputs (updated):** **Binance `/fapi/v1/depth` (1000 levels) via the relay is preferred** when configured (deepest free book), else Bybit → OKX.
- **Outputs:** `getClusters(symbol)` → `{mid, askClusters[], bidClusters[], source}`.
- **Scoring (updated):** the Conductor now scores walls in **all paths** (event, `/analyze`, movers) as **support/resistance, not magnets**, with **dominance-based** significance (a wall large vs its book's median) so low-cap walls register. A wall behind the trade defends it (+); a wall in the path is a barrier to TP (−), and also becomes a **TP-snap level**. See [CHANGELOG §3](CHANGELOG.md).

### 3.6 ListingMonitor — exchange listings
- **Purpose:** poll Upbit / Binance announcement / Bithumb RSS every 2 min, dedupe by `(exchange:id)`, filter by listing keywords minus negatives, extract parenthesised TICKERS, soft-match against universe. First poll is primed silently to suppress backlog.
- **Files:** `src/listing-monitor.js`. Cache: `logs/seen-listings.json`.
- **Outputs:** `listing` events `{exchange, symbol, title, url}` — index.js bypasses the Conductor and broadcasts directly as a high-priority alert.

### 3.7 On-chain monitors (EVM + Solana)
- **Purpose:** watch labelled CEX hot/cold wallets and discovered team-wallet addresses for ERC-20 / SPL transfers, classify into LONG/SHORT direction via a flow matrix, emit `flow` events.
- **EVM (`src/onchain-evm.js`):** every `pollIntervalMs` two `eth_getLogs` calls (to+from topic-indexed CEX∪team padded addresses) over `[lastBlock+1, current-2]`; intra/cross-poll dedup; lazy ERC-20 decimals (cache → universe → eth_call `0x313ce567`); RPC failover via `#rpcCall` discriminating block-range vs quota errors. Multi-hop derived-team registration (up to 2 hops, 48h TTL, max 300 entries) so insider→fresh→CEX still flags as team distribution.
- **Solana (`src/onchain-sol.js`):** per-wallet `getSignaturesForAddress({limit:25, until: lastSig})` → `getTransaction` → diff `pre/postTokenBalances` by `owner|mint` → match send/recv pairs of same mint AND same exchange → emit. 600s age filter, 1h `processedSigs` TTL, signature preloading on start to suppress backlog.
- **TeamWalletDiscovery (`src/team-wallet-discovery.js`):** scrape etherscan/bscscan `generic-tokenholders2` page for PINNED tokens only (formerly top-100 MC — caused USDT/ETH false positives), filter out CEX/burn/infra/labelled-anything, cap at top 15, 7-day TTL. Cache `logs/team-wallets.json`.
- **WalletLabelResolver (`src/wallet-label-resolver.js`):** on-demand HTTP scrape of `etherscan.io/address/`, `bscscan.com/address/`, `solscan.io/account/` for any unlabelled counterparty; positive TTL 7d, negative 1d, MAX_INFLIGHT=6. Cache `logs/wallet-labels.json`.
- **Outputs:** `flow` events `{chain, token, exchange, direction, fromType, toType, fromName, toName, teamFlow, amount, txHash, timestamp}`.

### 3.8 TAService — multi-TF technical analysis
- **Purpose:** pull Coinalyze OHLCV across **6 TFs (1m/5m/1h/4h/1d/1w)** and compute RSI/MACD/BB/ATR/wick/liquidity-grab/SMC per TF and an L/S-ratio finding; return `{findings, metadata}`. The **weekly frame is aggregated from daily bars** (no native weekly feed); TF weight vectors are centralised in `src/timeframes.js`. See [CHANGELOG §2](CHANGELOG.md). Also serves live exchange prices via Bybit→OKX→Coinalyze fallback (`getLastPerpPrice`), wick-aware 1m bars for SL/TP resolution (`getRecentBars`), surge-volume gate (`getVolumeRatio`), runtime token registration (`registerSymbol`), and an OHLCV-cache expose (`getOhlcvByTf`) for the independent confirmation gate.
- **Files:** `src/ta.js`, `src/smc.js` (BOS/CHoCH/double-top/sweep), `src/ta-confirm.js` (cross-validation gate using trading-signals + indicatorts + candlestick libs).
- **Quirks:** MIN_BARS=30 hard skip; per-TF cache 60s; analyze cache prunes only when size>500; 4000ms timeout on Bybit/OKX live-price.

### 3.9 Conductor — scoring engine
- **Purpose:** every trigger (flow, surge, liquidation, funding_extreme, movers, manual `/analyze`) pulls full market context → raw score from weighted components → tier (MIXED < 2, LOW ≥ 2, MEDIUM ≥ 3, HIGH ≥ 4, VERY HIGH ≥ 5) → trade-quality penalties (R:R, alignment, sentiment-only) → `ta-confirm.confirmSignal` hard-veto gate → trade plan → emits `signal` / `observation`.
- **Scoring components now also include (see [CHANGELOG §3](CHANGELOG.md)):** the **orderbook-heatmap** support/resistance score (all paths, dominance-based) and the **global BTC market-regime filter** (penalty for fighting BTC's macro trend; tailwind when aligned). Confidence% is anchored to the final tier.
- **Files:** `src/conductor.js`, `src/regime.js`, `src/timeframes.js`, `src/stables.js`.
- **Outputs:** `signal` and `observation` events consumed by `index.js`.
- **Cooldowns:** same-side 30 min; opposite-side 90 min; post-loss 30 min hard, extended to 4 h if within 3 % of loss entry.
- **Key thresholds (updated):** **minFlowUsd $1M** (favored $250k); team-sell bypasses both FDV ($500M) and minFlowUsd; surge gate suppresses if 1m vol < 1.5× avg, +0.5 if ≥ 3×, +0.3 if ≥ 2×; liquidation base +2.0; flow base curve down-weighted.

### 3.10 SignalTracker — outcome resolver
- **Purpose:** persist every fired signal as JSONL, then every 5 min fetch 1m OHLCV bars since last check and resolve outcomes. **Updated:** bars are walked **chronologically** (first level touched wins — was max/min with SL-priority, which mislabelled "TP-then-SL" as a loss); a same-bar SL+TP is `AMBIGUOUS` (excluded from win-rate); LOSS exits take a 0.1% slippage haircut; the duplicate guard is an **atomic in-memory `Set`**; `fromTs` is clamped to signal creation. Two-phase LG-limit tracking with its own hold clock. See [CHANGELOG §5](CHANGELOG.md).
- **Files:** `src/signal-tracker.js`. Persistence: `logs/signals.jsonl` (+ timestamped archives).
- **Outputs:** `resolved` event `{outcome: WIN_TP1|WIN_TP2|WIN_TP3|LOSS|EXPIRED_PROFIT|EXPIRED_LOSS|EXPIRED_UNFILLED|AMBIGUOUS|NO_PLAN, exitPrice, pnlPct, maxFavorable, maxAdverse, ...}`. Mirrors to Google Sheets if `GOOGLE_SHEET_URL` set.

### 3.11 Notifier + BotCommands + SubscriberStore
- **Purpose:** Telegram bot via `node-telegram-bot-api`. Notifier formats and broadcasts signals/observations/outcomes/listings/info to all chats in `SubscriberStore` (excluding silenced). BotCommands handles inbound `/commands`. SubscriberStore persists `logs/subscribers.json`.
- **Files:** `src/telegram.js`, `src/bot-commands.js`, `src/subscribers.js`.
- **Inputs:** Telegram Bot API (long-polling).
- **Outputs:** Telegram messages.

### 3.12 AutoTrader (isolated)
- **Purpose:** subscribe (read-only) to Conductor `signal` events, filter, size via RiskEngine, place order on Bybit with server-side SL+TP, journal to `logs/autotrades.jsonl`. 30 s monitor loop resolves closes + manages trailing stops. Live interlocked: `mode === 'live' && armed === true`.
- **Updated (see [CHANGELOG §4](CHANGELOG.md)):**
  - **Trailing stops** (`AUTOTRADE_TRAILING=1`, default): holds for TP3, ratchets the SL → breakeven after TP1, → TP1 after TP2 (Bybit `/v5/position/trading-stop`; paper moves its in-memory stop).
  - **SCALPs are signals-only** (`AUTOTRADE_SKIP_SCALP=1`) — weakest horizon, not auto-traded.
  - **Fixed-margin sizing** via env or `/autotrade margin <usd>`; else risk-based + `maxPositionUsd` cap.
  - Live closes resolved from **Bybit closed-PnL matched by exact qty+entry** (no manual-trade misattribution).
  - **Paper positions persist** to `logs/paper-positions.json` (survive restart).
- **Files:** `src/autotrade/auto-trader.js`, `exchange-bybit.js`, `paper-broker.js`, `risk-engine.js`, `store.js`.
- **Outputs:** real or paper orders; Telegram notifications; `logs/autotrades.jsonl`.
- **Geo-bypass:** Bybit + Binance routed via `BYBIT_BASE_URL`/`RELAY_BASE_URL` (Singapore relay) or `BYBIT_PROXY`. Signature is host-independent.

### 3.16 RegimeMonitor — global BTC market regime
- **Purpose:** classify **BTC** every 5min from its 1h/4h/daily trend + 1h ATR into `BTC_UP` / `BTC_DOWN` / `CHOP` (+ *acute*, *high-vol*). The Conductor penalises signals fighting BTC's macro trend and gives a small tailwind to aligned ones — the dominant "right setup, wrong market" loss on alts.
- **Files:** `src/regime.js`. Exposed via `/regime`. Tunables `ENABLE_REGIME`, `REGIME_PENALTY`, `REGIME_HIGH_VOL_PCT`.

### 3.13 Coinalyze client + perpSymbolMap
- **Files:** `src/coinalyze.js` — REST wrapper for `fundingRate`, `openInterest`, `fundingRateHistory`, `liquidationHistory`, `ohlcvHistory`, `longShortRatio`, `resolvePerp`. `buildPerpSymbolMap(client, universe, maxTopN)` resolves the top-N universe symbols to Coinalyze perp ids at boot.

### 3.14 CexHoldings — on-demand cold-wallet balance lookup (for `/analyze`)
- **Files:** `src/cex-holdings.js`. Reads ETH/BSC balances of configured cold wallets via the same RPC pool; used by `/analyze` to show supply concentration.

### 3.15 SheetLogger — optional Google Sheets mirror
- **Files:** `src/sheet-logger.js`. POSTs JSON to a Google Apps Script Web App URL (`GOOGLE_SHEET_URL`) on signal append and outcome resolve.

## 4. Boot Sequence (`src/index.js`)

In order:
1. **Env + JSON load** — `dotenv`, `cex-wallets.json`, `rpcs.json`, `tokens.json`, `logs/user-watchlist.json`.
2. **Universe.build()** — CoinGecko fetch (top-N + volume-top + pinned + user), cache hydrate.
3. **SubscriberStore** — load `logs/subscribers.json`; seed operator chat on first boot.
4. **Notifier.ready()** — Telegram bot, registers polling for commands.
5. **PriceMonitor.start()** — first CoinGecko poll, then interval (60 s default). `sleep(3s)`.
6. **Funding source probe** — `BinanceFuturesMonitor.probe()`; if reachable use it, else fall through to Coinalyze.
7. **Coinalyze block** (if `COINALYZE_API_KEY`):
   - `buildPerpSymbolMap` → split into liq map + funding map.
   - `FundingMonitor` (only if Binance didn't take it) → `.start()`.
   - `LiquidationMonitor.start()`.
   - `TAService` constructed.
8. **WalletLabelResolver** (unless `WALLET_LABEL_AUTORESOLVE=0`).
9. **TeamWalletDiscovery** (unless `TEAM_WALLET_TRACKING=0`) → `discoverAll(maxTokens)` runs in background, calls `refreshTeamIndex()` on every EVM monitor when done.
10. **On-chain sources** — EvmMonitor for `ethereum`, then `bsc`, then SolanaMonitor — each `await .start()` and pushed to `sources[]`.
11. **LiquidityClusters** (unless `LIQUIDITY_CLUSTERS=0`); `selfTest()` fire-and-forget.
12. **Conductor** constructed with all sources, started.
13. **`flow` listener** on each source — emits the "Observation: solo flow" alert (separate from Conductor observations) for non-stable, non-zero direction flows ≥ `OBSERVE_MIN_FLOW_USD`, non-mega-FDV, with team-flow exempt.
14. **ListingMonitor** (unless `LISTING_MONITOR=0`) with its own alert handler.
15. **`liquidation` listener** for raw liquidation observation alerts.
16. **Activity counters** registered on `surge`/`flow`/`liquidation`.
17. **SheetLogger + SignalTracker.start()** — wired to the conductor via `conductor.setSignalTracker(signalTracker)` so the `hasOpenSignal` lockout works.
18. **AutoTrader** constructed (with paper broker always; live broker only if Bybit keys present), `start()`.
19. **`resolved` listener** on signalTracker → feeds losses back via `conductor.recordLoss(sig)` + broadcasts outcome.
20. **Conductor signal/observation listeners** — `signalTracker.record(signal)` (returns false on duplicate), then `sheetLogger.appendSignal`, `notifier.sendSignal`, `autoTrader.onSignal` (fire-and-forget).
21. **BotCommands** wired if `TELEGRAM_COMMANDS !== '0'`.
22. **10-min stats interval**, **Funding Leaders cadence** (every `FUNDING_LEADERS_MIN`, first call +2 min — rotates through depth 1–20 in 5-entry windows; fires top-3 of current slice through `evaluateFundingTrigger`), **Movers scan cadence** (every `MOVERS_SCAN_MIN`, first call +3 min — `setHotMovers` + sequentially `evaluateTokenAndMaybeEmit` each).
23. **Boot message** sent to operator only.
24. **Signal handlers** — `SIGINT`/`SIGTERM`/`SIGHUP` log uptime + ppid; `uncaughtException` logs stack and exits 1; `unhandledRejection` logged.

## 5. Full Data Flow — from raw input to Telegram alert and Bybit order

### Path A: CoinGecko 1m price update → signal
1. `PriceMonitor.#poll` fetches `/coins/markets?ids=...&price_change_percentage=24h` in 250-id batches.
2. Per-cgId: skip stables, append `{price, ts}` to history, evict > 180 s.
3. Compute `pctChange = (price - past.price)/past.price * 100` against oldest entry ≥ 60 s old.
4. Favored gate: `effectiveSurgePct = max(1.5, surgePct-1)`; non-favored require `vol24h ≥ minVolumeUsd`.
5. On threshold: emit `surge {token, direction, pctChange, ...}` and reset history.
6. Conductor `#onSurge` receives it: `getVolumeRatio(symbol)` from Coinalyze 1m. `ratio<1.5` → suppress. `≥3` → `volumeBoost=+0.5`; `≥2` → `+0.3`. Trigger forwarded as `{type:'surge', value:{...surge, volumeBoost}}`.
7. `#evaluateAndMaybeEmit`: post-loss + cooldown gates → `#gatherContext` (funding, currentPrice, universeInfo, recent flows/surges/liqs) → `#evaluate` raw score → if ≥ 2.0, TA enrichment via `taService.analyze` → re-score → liquidity-cluster bonus if any orderbook wall at 2–8 % → re-score → `getLastPerpPrice` overrides `currentPrice` → `#buildTradePlan` (TF-weighted alignment chooses SCALP/DAY/SWING/POSITION; ATR × wick-aware multiplier → SL; TPs 1.5R/3R/4.5R → snap to real swing structure; counter-trend becomes liquidity-grab LIMIT) → `#applyTradeQualityPenalties` → `ta-confirm.confirmSignal` HARD-VETO gate (independent indicator libs) → tier/threshold/lockout check.
8. If `score ≥ sigThreshold` AND `tier ∈ {MEDIUM, HIGH, VERY HIGH}` AND `planOk` AND `!signalTracker.hasOpenSignal(sym)` → emit `signal`.
9. `index.js`: `signalTracker.record(signal)` — re-reads disk, rejects same-symbol+same-side duplicate. If recorded → `sheetLogger.appendSignal` + `notifier.sendSignal` (broadcast to all non-silenced subscribers) + `autoTrader.onSignal`.
10. `AutoTrader.#handle`: tier check, alignment check, plan-completeness check, `armed` check (live), per-symbol duplicate check, `RiskEngine.canTrade` gate, `RiskEngine.sizePosition` (riskPct of balance ÷ SL distance, capped at `maxPositionUsd`, leverage-clamped), instrument round (qtyStep/tickSize/minQty), `setIsolatedAndLeverage`, `placeMarketOrder` or `placeLimitOrder` (with attached server-side SL/TP).
11. Order traverses Bybit v5 signed REST. Base URL is `BYBIT_BASE_URL` if set → Vercel Singapore relay (`/relay/...` rewrites to `api.bybit.com` preserving the signature) or Cloudflare Worker → Bybit. Otherwise direct.
12. Result journalled to `logs/autotrades.jsonl`; `🤖 Auto-trade ...` Telegram notification sent.
13. 30 s monitor loop detects when the position disappears from the exchange (SL or TP filled). Computes P&L, calls `tradeStore.closeTrade`, `riskEngine.recordRealisedPnl`, sends `✅`/`❌ Auto-trade closed` notification.
14. Meanwhile every 5 min `signalTracker.resolveOpen` ticks: `getRecentBars` from Coinalyze 1m for each open signal; SL-first wick check vs TP1/2/3; or time expiry. On hit → `resolved` event → `index.js` broadcasts outcome AND calls `conductor.recordLoss` if applicable (sets post-loss cooldown).

### Path B: On-chain CEX transfer → observation or signal
1. `EvmMonitor.#poll`: `eth_blockNumber` → `[lastBlock+1, current-2]` → split by `maxBlocksPerCall` → two `eth_getLogs` per chunk (TRANSFER_TOPIC + paddedWallets either as topics[2]=to or topics[1]=from).
2. `#processLog`: universe-address gate → `walletIndex` lookup + `#lookupTeam` (with strict tokenAddress match) for both ends → on-demand `labelResolver.resolve` for unlabelled side → same-exchange same-type skip → classify direction via flow matrix → fetch decimals → emit `flow`.
3. `index.js` solo-flow listener: if `usd ≥ OBSERVE_MIN_FLOW_USD`, FDV ≤ $500M (or team-flow exempt), not stable → send "📊 Observation" Telegram alert with tx link. (This is independent of the Conductor's `observation` event.)
4. Conductor `#onFlow` also receives the flow: stable filter, record history, MIN_TEAM_FLOW_USD=$50k strip, team-sell bypasses FDV+minUSD gates, otherwise FDV ≥ $500M skip and favored gets `minFlowUsd × 0.25` ($125k) else $500k → forward to `#evaluateAndMaybeEmit` with `trigger={type:'flow', usd}` and `side = direction.toUpperCase()`.
5. Same scoring pipeline as Path A. Flow triggers can emit `observation` (when below signal threshold but above 2.0) — Conductor emits `observation` event → `notifier.sendObservation` broadcast.

### Path C: Liquidation, Funding-extreme, Movers, Manual `/analyze`
All four follow the same Conductor pipeline via different entry points: `#onLiquidation` (Coinalyze events), `evaluateFundingTrigger` (called from periodic Leaders scan), `evaluateTokenAndMaybeEmit` (movers scan — emits signals ONLY, no observations), `evaluateForAnalysis` (chat command — full both-side parallel evaluation; returns analysis object directly to BotCommands which formats it as a reply rather than broadcasting).

## 6. External Services

| Service | Used by | Criticality |
|---|---|---|
| **CoinGecko** `/coins/markets`, `/search` | Universe build, PriceMonitor (every 60 s), `/find` command | **Critical** — bot can't start without it; rate-limited (429 → poll skip). |
| **Coinalyze REST** (funding, OI, OHLCV, L/S ratio, liquidations, resolvePerp) | FundingMonitor (fallback), LiquidationMonitor, TAService, SignalTracker resolver | **High** — without it: no TA, no liquidations, no signal resolution wicks (falls back to CG spot). Requires `COINALYZE_API_KEY`. |
| **Binance Futures public API** | FundingMonitor primary | Medium — preferred funding source (no key, no rate limit); falls back to Coinalyze if `probe()` fails. |
| **Bybit v5** `/v5/market/{tickers,orderbook}`, signed trade endpoints | TAService live price, LiquidityClusters, AutoTrader live trades | High for autotrade; medium for TA (has OKX→Coinalyze fallback). |
| **OKX v5** `/api/v5/market/{ticker,books}` | Secondary fallback in TAService + LiquidityClusters | Low — fallback path. |
| **Vercel relay (Singapore)** or **Cloudflare Worker** | AutoTrader Bybit egress | **Critical for live autotrade** when the VPS IP is geo-blocked. Configured via `BYBIT_BASE_URL`. Signature is host-independent so relays are transparent. Vercel pinned to `sin1` for an allowed-region egress. Cloudflare uses rotating edge IPs (key IP-whitelist must be off). |
| **Etherscan / BSCScan** `/address/`, `/token/generic-tokenholders2` | WalletLabelResolver, TeamWalletDiscovery | Medium — degraded labels if scrape fails; cached on disk. |
| **Solscan** `/account/` | WalletLabelResolver (Solana) | Low. |
| **EVM public RPCs** (rotated via `rpcs.json`) | EvmMonitor (`eth_getLogs`, `eth_blockNumber`, `eth_call` for decimals), CexHoldings | High — bot has failover via `#switchRpc` + adaptive bisection. |
| **Solana public RPCs** | SolanaMonitor | High. |
| **Upbit / Binance announcement / Bithumb RSS** | ListingMonitor | Low — feature-additive. |
| **Telegram Bot API** | Notifier (sendMessage long-polling) | **Critical** — only output channel. Optional proxy via `TELEGRAM_API_PROXY`. |
| **Google Apps Script Web App** (`GOOGLE_SHEET_URL`) | SheetLogger | Low — optional mirror. |

## 7. Persistence — files written under `logs/`

| File | Writer | Contents |
|---|---|---|
| `logs/signals.jsonl` | SignalTracker.record / resolveOpen | Append-only JSONL: one line per fired signal `{ts, side, symbol, cgId, chain, score, strength, trigger, reasons, entry, marketEntry, limitEntry, isLiquidityGrab, awaitingLimit, limitFilledAt, sl, tp1, tp2, tp3, horizon, atrTf, alignmentCount, validityHrs, outcome, outcomeAt, maxFavorable, maxAdverse, ...}`. Mutated in place on resolve. |
| `logs/signals.jsonl.<UTCstamp>.jsonl` | SignalTracker.reset (from `/resetstats`) | Archive of the previous open-signal file before the counter restart. |
| `logs/autotrades.jsonl` | autotrade/store.js TradeStore | Append-only JSONL: one line per auto-trade order `{id, ts, mode:paper|live, symbol, side, qty, notionalUsd, leverage, entry, sl, tp, isLiquidityGrab, isolated, score, tier, status, closedAt, exitPrice, pnlUsd, pnlPct, reason}`. Mutated in place on close. |
| `logs/subscribers.json` | SubscriberStore | `{savedAt, entries:[{chatId, username, silencedUntil}]}` — every chat that `/start`'d the bot. |
| `logs/funding-state.json` | FundingMonitor.#save (atomic via .tmp + rename) | Snapshot of `bySymbol` summaries so a restart within STATE_TTL=2h keeps funding/OI live without re-polling. |
| `logs/wallet-labels.json` | WalletLabelResolver.#save | Cached per-address explorer labels `{chain:addr → {result:{exchange,type,name} | null, ts}}` with positive 7-day / negative 1-day TTLs. |
| `logs/team-wallets.json` | TeamWalletDiscovery.#save | Cached `byToken` map of scraped insider top-holders per pinned token `{tokenAddr → {chain, tokenSymbol, ts, holders:[{addr, percent, rank}]}}` — 7-day refresh. |
| `logs/seen-listings.json` | ListingMonitor.#save | Dedup set `{savedAt, seen:[exchangeId, ...]}` so the bot doesn't re-alert listings on restart. |
| `logs/user-watchlist.json` | bot-commands.js `/watchlist add|remove` | `{entries:[cgId,...]}` — runtime-pinned tokens merged with `src/config/tokens.json` on the next boot. |
| `src/config/.universe-cache.json` | Universe.build | Cached CoinGecko universe to speed reboots. |

## 8. Telegram Commands

(Public help available to any subscriber; operator-only commands additionally exposed in `/help` for the operator chat.)

### Public
- `/start` — subscribe to live alerts (signals, observations, funding leaders, top-movers scans).
- `/stop` (alias `/unsubscribe`) — unsubscribe.
- `/help` — command list (reduced text for non-operators).
- `/find NAME` — look up a token's CoinGecko slug (e.g. `/find tagger`).
- `/analyze SYMBOL` — full on-demand analysis with trade plan: multi-TF TA (5m/1h/4h/1d/**1w**), funding, OI, L/S ratio, **orderbook heatmap**, **BTC regime**, CEX cold-wallet holdings, entry/SL/TPs/leverage/horizon. 8 s per-chat cooldown.
- `/open` — currently open signals with live unrealized P&L.
- `/recent [N]` — last N fired signals (default 5).
- `/leaders` — current funding-rate leaders (squeeze candidates).
- `/movers` — top 10 gainers + losers over last 24 h.
- **`/heatmap <SYM>`** — live order-book liquidity walls (support/resistance).
- **`/regime`** — current BTC market regime + its bias on signals.
- `/stats` (alias `/winrate`) — historical win-rate breakdown by tier + trigger.
- `/silence 30m|2h|1d` — mute alerts (cap 7 d).  `/unsilence` — resume.

### Operator only (rejected for non-operator chats)
- `/watchlist` — list pinned tokens (`tokens.json` + runtime additions).
- `/watchlist add <cgId>` — pin a token at runtime; persists to `logs/user-watchlist.json`; calls `taService.registerSymbol`, `funding.registerSymbol`, and `universe.invalidateSymbolCache` so the addition takes effect without restart.
- `/watchlist remove <cgId>` — unpin (runtime additions only).
- `/subscribers` (alias `/subs`) — list every subscribed chat (username, chatId, silence state).
- `/resetstats` — archive `logs/signals.jsonl` to a timestamped sibling and start a fresh win-rate counter.
- `/tunestats [current]` — win-rate by trigger/side/**horizon**/reason-kind + **MFE/MAE excursion** block; `current` = live file only (no old-engine contamination); low-N rows flagged ⚪.
- `/autotrade` — status (mode, armed, sizing, trailing, scalp gate, day P&L, journal).
- `/autotrade paper|live|on|off` — mode/arming control.
- `/autotrade margin <usd>` — fixed margin/trade for the current mode (`off` = risk-based).
- `/autotrade close <sym>` — manual reduce-only close of an open auto-trade.
