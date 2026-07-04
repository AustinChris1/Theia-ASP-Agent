# Trade Alert Bot

A Node.js (ESM) Telegram bot that fuses **on-chain CEX/insider wallet flows**, **1-minute price surges**, and **perp-market data** (funding, open interest, real-time liquidations, orderbook walls) into a weighted confluence engine. It fires ranked trade signals with full plans — entry, stop-loss, take-profits, leverage, time horizon — and can optionally **auto-trade** them on Bybit (paper or live), per-user. An optional **subscription layer** (`billing/`) gates access with a free trial + on-chain USDT payments.

## Quick start

```bash
npm install
cp .env.example .env        # fill TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (minimum)
npm start                   # node src/index.js   (npm run dev for --watch)
node test/sanity.js         # unit suite (223 passing, no live API calls)
```

Requires Node ≥ 20.

## How it works (one signal's life)

1. **Monitors** watch many feeds in parallel — on-chain CEX/insider transfers (ETH/BSC/Solana), 1m price surges, funding/OI, **Bybit liquidations** (real-time), orderbook + liquidation heatmaps, new listings.
2. The **Conductor** scores confluence across them (the "analyze loose, fire strict" philosophy) and builds a trade plan.
3. The **SignalTracker** resolves outcomes (progressive TP, breakeven, win/loss stats).
4. The **Notifier** broadcasts to Telegram; the **AutoTrader** optionally executes on Bybit.

## What you get

- **Signals** — LOW / MEDIUM / HIGH / VERY HIGH tiers with a confluence score, multi-timeframe TA, and an executable trade plan.
- **Observations** — lighter alerts (flow / liquidation / distribution) below the signal bar.
- **Progressive TP** — TP1/TP2/TP3 alert as price reaches them; early-breakeven + profit-trail ("bank pops") ratchet the stop so a winner can't bleed back to a loss.
- **Real liquidation feed** — Bybit `allLiquidation` via a Tokyo forwarder; significance scored by **% of open interest**, not flat $ (a violent cascade can reach signal grade).
- **Raw insider-sell alerts** — labelled on-chain dumps (amount, USD, network, venue, explorer link).
- **Multi-user auto-trade** — each user `/connect`s their own Bybit trade-only keys (encrypted); per-user filters + isolated, mode-scoped PnL.
- **Subscription (optional)** — 7-day free trial → monthly USDT payment to a per-user address (BSC/ETH/Base). Off by default.

## Key commands

`/start` `/stop` · `/menu` `/guide` · `/analyze <token>` · `/open` `/pnl` `/recent` `/stats` · `/heatmap` `/liqmap` `/regime` `/movers` `/leaders` · `/autotrade` `/connect` `/subscribe` · operator: `/find` `/insider` `/watchlist` `/subscribers` `/resetstats` `/grant`

## Data sources

| Source | Used for |
|--------|----------|
| CoinGecko | prices, 24h volume, market caps (spot-only fallback) |
| Binance Futures (via relay) | primary price feed, funding, deep orderbook heatmap |
| Bybit (via relay + Tokyo forwarder) | autotrade venue, price match, **real-time liquidations** |
| Coinalyze | perp OHLCV (TA), open interest (liquidation significance), L/S ratio |
| Public RPCs (ETH/BSC/Base/Solana) | on-chain CEX & insider transfers; subscription deposits |
| Moralis | token top-holder discovery (insider wallets) |

External calls geo-blocked from the host (Bybit/Binance REST) route through a Singapore relay (`BYBIT_BASE_URL`); the Bybit liquidation WS + Upbit listings route through a Fly **Tokyo forwarder** (`LIQ_FORWARDER_URL`, `UPBIT_PROXY_URL`).

## Configuration

`.env.example` is the source of truth (~80 tunables). Most-used: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `COINALYZE_API_KEY`(+`_LIQ`), `MORALIS_API_KEY`, `DATABASE_URL` (Neon — durable state; falls back to JSONL files in `logs/` if unset), `BYBIT_BASE_URL` (relay), `KEY_ENCRYPTION_SECRET` (multi-user keys), `AUTOTRADE` (`off`/`paper`/`live`), `MIN_SIGNAL_SCORE`, `MIN_LIQUIDATION_USD`/`LIQ_OI_PCT`.

> Adding a var to `.env.example` means adding it to the real `.env` too.

## Documentation

- **[docs/CHANGELOG.md](docs/CHANGELOG.md)** — authoritative current state (read this first).
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** · **[docs/SIGNAL_PIPELINE.md](docs/SIGNAL_PIPELINE.md)** · **[docs/TRADE_PLAN.md](docs/TRADE_PLAN.md)** — subsystems, signal flow, trade-plan math.
- **[billing/README.md](billing/README.md)** — the subscription/payments module (setup + security).
- **[PRIVACY.md](PRIVACY.md)** — privacy policy (also in-bot via `/privacy`).
- **[CLAUDE.md](CLAUDE.md)** — guide for working in this codebase.

## Limitations & disclaimer

Single Node process; you provide all API keys; no ML/sentiment. **Not financial advice** — signals are probabilistic, crypto is volatile, you trade at your own risk. See "Known gaps" in CHANGELOG §0d.
