# Registering Theia as an OKX.AI ASP (human-in-the-loop)

Registration, listing, and every on-chain action run through YOUR Agentic Wallet
and the `onchainos` CLI. These steps need you (the wallet owner) in the loop.
Nothing here reads or needs Theia's bot secrets. On-chain actions are gas-free
(OKX paymaster) on X Layer (chainId 196).

Ground truth for all of this is in [NOTES-okx.md](../NOTES-okx.md).

## 0. Prerequisites (once)

1. Install the CLI + skills (already done in this repo, re-runnable):
   ```
   npx skills add okx/onchainos-skills --yes -g
   ```
   Install the `onchainos` binary on your PATH:
   ```
   irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex   # Windows
   # or: curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
   ```
2. Deploy the ASP endpoint FIRST (see [README.md](../README.md) -> Deploy). The
   A2MCP endpoint URL is PERMANENT on-chain once registered, so it must be a real,
   public `https://` URL before you register. Use your Render URL, e.g.
   `https://theia-asp.onrender.com`. Confirm `GET /health` returns 200.
3. Fund the wallet with a little USDT on X Layer so the endpoint can receive
   x402 payments and you can pay from the demo executor. (Gas is free on X Layer.)

## 1. Log in to the Agentic Wallet

In an agent session (Claude Code / Codex / etc. with the skills installed), say:

> Log in to Agentic Wallet on Onchain OS with my email

Then get your receiving address (this is the x402 `payTo`):
```
onchainos wallet addresses --format json
```
Put that address in `.env` as `X402_PAY_TO`, and set `ASP_PUBLIC_URL` to your
deployed URL. Redeploy so the manifest and 402 challenges use the right values.

## 2. Confirm the X Layer settlement assets + facilitator (open items)

Fill these in `.env` before enforcing x402:
```
onchainos wallet chains            # find the X Layer (196) USDT / USDG token addresses
```
Set `X402_ASSET_USDT_ADDRESS`. For the facilitator URL,
validate your live endpoint and let OKX tell you what it expects:
```
onchainos agent x402-check --endpoint https://theia-asp.onrender.com/skills/theia_signal
```
Set `X402_FACILITATOR_URL` to the facilitator OKX validates against, then set
`X402_ENFORCE=1` and redeploy. Re-run `x402-check` until it passes.

## 3. Register the ASP identity + A2MCP services

Generate the exact service array (kept in sync with the code):
```
ASP_PUBLIC_URL=https://theia-asp.onrender.com node identity/build-manifest.js
```
That prints the 6 A2MCP services + the A2A Deep Desk service (also saved to
`identity/service-manifest.json`). Then, in your agent session:

> Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS

The agent will walk you through it. Answers to give it:
- Role: ASP
- Name: `Theia` (brand; the CLI checks 3-25 chars, no celebrity names)
- Description: `Institutional-grade crypto confluence, manipulation, insider, CEX-flow, and liquidation intelligence for agents.`
- Avatar: send `identity/avatar.png` (add a 1:1 square image here; the ASP avatar is required)
- Services: add each of the 6 A2MCP services from the manifest (name, description,
  type A2MCP, fee, endpoint). After EACH one the CLI asks "add another / done" —
  keep adding until all 6 are in, then choose Done.

It runs `validate-listing` once, shows a card, and on your confirm runs
`agent create`. Note the returned `#<agentId>` for your records (used in A2A CLI
commands and your submission; it is not read by the server).

## 4. Register the A2A service (Deep Desk)

Either add the "Theia Deep Desk" service in the same `agent create` above, or add it
after with:

> Help me register an A2A ASP on OKX.AI using OKX Agent Identity from Onchain OS

Type A2A, fee negotiated (may be left empty), no endpoint (A2A is escrow, not an
HTTP endpoint). Description is in the manifest.

## 5. List it

> Help me list my ASP on OKX.AI using Onchain OS

This activates the identity and submits it for review (result within ~24h, emailed
to your Agentic Wallet address and shown in the agent window). Before it is approved
it is still usable by Agent ID directly. Remember: the A2MCP endpoint must pass
`x402-check` before it can go live.

## 6. Take orders

- A2MCP: fully automatic. When a caller's agent hits `POST /skills/<name>`, they get
  a 402, pay via x402, and receive the JSON. Billing + delivery are real-time.
- A2A: stay online; browse tasks or wait for offers. When a task is `job_accepted`
  (escrow funded), run the Deep Desk audit and deliver. The exact CLI hooks are in
  [a2a/deep-desk.js](../a2a/deep-desk.js) (`cli.apply`, `cli.deliver`,
  `cli.rateUser`). Never deliver before `job_accepted`.

## Checklist

- [ ] Endpoint deployed, `GET /health` = 200, `X402_PAY_TO` set
- [ ] X Layer USDT address + facilitator set, `x402-check` passes, `X402_ENFORCE=1`
- [ ] 6 A2MCP services + Deep Desk registered, `#agentId` saved
- [ ] Listed and submitted for review
- [ ] Demo executor pays and reads a signal end to end
