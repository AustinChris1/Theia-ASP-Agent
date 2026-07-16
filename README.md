# Theia: crypto intelligence for agents, on OKX.AI

**Theia is an Agent Service Provider (ASP) on OKX.AI.** Agents can trade, but they
trade blind. Theia sells the intelligence: is this token being manipulated, are
insiders distributing, where is exchange flow heading, where are the liquidations, and
what is the confluence-scored trade plan. Priced per call, paid in USDT on X Layer.

- **Live on OKX.AI:** agent `#6004` (X Layer, chainId 196)
- **Endpoint:** `https://theia-asp.onrender.com`
- **OKX-native:** all market data from OKX v5 · payments via x402 on X Layer · exposed as MCP tools
- **Deterministic + auditable:** an LLM may narrate output, it never decides a trade

---

## Why I built this

I did the work. Multi-timeframe technical analysis, structure, confluence. The chart
said long, so I went long.

I got liquidated.

What stung was not being wrong. It was finding out afterwards *why* I was wrong. The
float was concentrated in a handful of wallets. The volume that looked like conviction
was largely wash. Supply had already been moving into exchange custody while I was
drawing levels. None of that was in the chart. By the time it reached the chart, I was
exit liquidity.

That was the lesson: **technical analysis answers what price is doing. It cannot
answer who is doing it.** The chart is downstream. It is the last place the move shows
up, and it is the only place most people are looking.

So I built the legs I was missing, and every skill here is one of the questions I
could not answer that day:

| The question TA could not answer | The skill |
|---|---|
| Is this volume even real, or is it wash? | `theia_manipulation_check` |
| Who actually holds the float? | `theia_insider_scan` |
| Is supply quietly moving into exchange custody? | `theia_cex_flow` |
| How cornered is the float across exchanges? | `theia_cex_holdings` |
| Where exactly does my leverage die? | `theia_liqmap` |
| Given all of the above, what is the honest read? | `theia_signal` |

Then agents started trading. They inherited the same blindness I had, except they will
act on it in milliseconds, around the clock, with no instinct that something feels off.
An agent with a wallet and no visibility into float, flow, or manipulation is not a
trader. It is exit liquidity with an API key.

Theia is the layer I wish I had, sold to the agents that need it most. It is
deterministic on purpose: it will tell you conviction is **LOW** rather than
manufacture a number, because the confident-sounding call is exactly what cost me.

## What it offers

**Six pay-per-call skills (A2MCP, x402):**

| Skill | Returns | Price |
|---|---|---|
| `theia_signal` | Confluence side, strength tier, confidence, scored reasons, full trade plan (entry, SL, TP1-3, R, leverage, horizon) | 0.05 USDT |
| `theia_manipulation_check` | Pump-and-dump / wash-trade risk 0-100% with flags | 0.05 USDT |
| `theia_cex_flow` | Direction + materiality of supply into/out of exchange custody | 0.05 USDT |
| `theia_insider_scan` | Largest non-exchange insider holders + top-10 concentration | 0.05 USDT |
| `theia_liqmap` | Leverage-liquidation clusters above/below price | 0.05 USDT |
| `theia_cex_holdings` | Cornered float: cold-wallet concentration by token or exchange | 0.02 USDT |

**One premium escrow service (A2A):** *Theia Deep Desk*, a full multi-token
manipulation + insider + liquidation + flow audit, delivered as a structured report,
escrow-backed, released on your sign-off.

**Plus a verifiable-alpha ledger:** Theia resolves every signal it fires to a real
outcome and hashes it into a Merkle root anchored on X Layer. The win-rate is
auditable on-chain, not claimed.

## Try it

The service is live. Free discovery routes need no payment:

```bash
curl https://theia-asp.onrender.com/health         # engine status
curl https://theia-asp.onrender.com/               # service manifest (skills + pricing)
curl https://theia-asp.onrender.com/reputation     # verifiable win-rate scoreboard
```

A skill call returns clean structured JSON:

```bash
curl -X POST https://theia-asp.onrender.com/skills/theia_signal \
  -H 'content-type: application/json' -d '{"token":"BTC"}'
```

The same six skills are exposed as **MCP tools** over Streamable HTTP at
`POST /mcp` (stateless: `initialize`, then `tools/list`).

## How it works

A caller pays a few cents of USDT through the OKX Agentic Wallet (x402 on X Layer),
and instantly gets back a structured, confluence-scored read. Under the hood, a
deterministic intelligence engine pulls **OKX v5** market data (tickers, candles,
funding, open interest, order book, taker volume) and on-chain insider/CEX-flow
signals, then scores side, tier, confidence, reasons, and a trade plan.

Full technical design, data flow, and the x402 sequence are in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Run locally

```bash
npm install
cp .env.example .env     # add market-data keys (see .env.example)
npm start                # boots the engine, serves on :8402
npm test                 # unit suite, no live network
```

A healthy boot logs `okx: N instruments mapped`, `liq-clusters self-test OK via okx`,
and multi-timeframe TA findings.

## Why OKX-native matters

- **Market data:** OKX v5 for prices, funding, OI, candles, order book, and taker
  volume (CVD). No competitor-exchange dependency.
- **Payments:** x402 V2, `exact` scheme, USDT settlement on X Layer (196).
- **Identity:** ERC-8004 on-chain agent (`#6004`).
- **Discovery:** exposed as MCP tools so any MCP-native agent can call it.

## Repository

```
server.js            HTTP + MCP host, x402-gated
engine.js            headless boot of the intelligence engine
config.js            environment configuration
skills/              six A2MCP skill adapters
payments/x402.js     seller-side x402 V2 middleware
a2a/deep-desk.js     escrow audit service
reputation/ledger.js on-chain win-rate ledger
src/                 the imported intelligence engine
relay/               optional Singapore data relay
test/                unit suite
```

Requires Node >= 20. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
