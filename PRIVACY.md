# Privacy Policy

_Last updated: 2026-06-17_

This Telegram bot ("the Bot") provides crypto trading signals, optional automated
trading on your own exchange account, and an optional paid subscription. This policy
explains what we collect, why, and your choices. By using the Bot you agree to it.

## What we collect

- **Telegram identity** — your Telegram user ID and username/first name (to deliver
  alerts, identify your account, and remember your settings).
- **Your preferences** — notification toggles, silence windows, watchlist, auto-trade
  configuration.
- **Exchange API keys (only if you `/connect`)** — your Bybit API key + secret, stored
  **encrypted** (AES-256-GCM). We require **trade-only** keys; **never enable
  withdrawal**. We cannot move funds off your exchange.
- **Trading activity** — signals you were sent and the trades the Bot placed/managed on
  your account (entry, exit, P&L) for your stats and the `/pnl` view.
- **Subscription & payments (only if billing is enabled)** — a deposit address derived
  for you, payment amounts/dates, and your subscription expiry. On-chain payments are,
  by nature, **public** on the blockchain you use.

We do **not** collect your name, email, phone, KYC documents, or Telegram message
content beyond the commands you send to the Bot.

## How we use it

To deliver alerts, run your auto-trades, compute your stats, process subscription
payments, gate access (trial/paid), and operate/secure the service. We do **not** sell
your data or use it for advertising.

## Storage & security

Data is stored in a managed Postgres database (Neon) or local files, on the server that
runs the Bot. API secrets are encrypted at rest; the Bot only decrypts them in memory to
place your trades. We take reasonable measures to protect your data but no system is
perfectly secure — use trade-only, IP-restricted keys.

## Third parties

The Bot interacts with these services to function; your data may transit them as needed:
Telegram (messaging), Bybit (your trades), Neon (storage), public blockchain RPC nodes
and CoinGecko / Coinalyze / Moralis (market + on-chain data), and infrastructure relays.
Each has its own policies. Blockchain transactions for subscription payments are public.

## Retention & your rights

- **`/disconnect`** — permanently wipes your stored exchange keys.
- **`/stop`** — unsubscribes you from alerts.
- **Deletion** — to have your stored data removed, contact the operator (below). We keep
  minimal records needed for an active subscription/legal reasons; the rest is deleted on
  request.

## Not financial advice

Signals and auto-trades are **probabilistic and for information only** — not financial
advice. Crypto trading is high-risk and you can lose money. You are solely responsible
for your trades and API-key permissions. Subscription fees are for access to the tool,
not a promise of profit, and are **non-refundable** once a period begins.

## Changes & contact

We may update this policy; material changes will be announced in the Bot. Questions or
data requests: contact the operator via the Telegram account that runs this Bot.
