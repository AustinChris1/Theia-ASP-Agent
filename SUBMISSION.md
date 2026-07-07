# Theia ASP — hackathon submission checklist

OKX AI Genesis Hackathon. Build an ASP for OKX.AI. Prize pool $100,000.

Two hard deadlines:
1. Submit the Google form BEFORE **Jul 17, 00:00 UTC**: https://forms.gle/mddEUagmDbyV37ws8
2. Post a demo (at most 90 seconds) on X with **#okxai**.

You must be listed on OKX.AI before the form submission counts.

## Order of operations

1. [ ] Deploy the endpoint (Render), `GET /health` = 200. See [README](README.md).
2. [ ] Log in to the Agentic Wallet, set `X402_PAY_TO`. See [identity/REGISTRATION.md](identity/REGISTRATION.md).
3. [ ] Wire live x402: X Layer USDT address + facilitator, `x402-check` passes, `X402_ENFORCE=1`.
4. [ ] Register the ASP + 6 A2MCP services + the A2A Deep Desk service. Save the Agent ID.
5. [ ] List it on OKX.AI ("Help me list my ASP on OKX.AI using Onchain OS"). Review is ~24h.
6. [ ] Anchor the reputation ledger once so the win-rate has an on-chain tx.
7. [ ] Record the <=90s demo (see [DEMO.md](DEMO.md)). Post on X with #okxai.
8. [ ] Submit the Google form before Jul 17 00:00 UTC. Include the Agent ID, the X
       post link, and the endpoint URL.

## Category positioning

Home category: **Finance Copilot**. Primary pushes: **Best Product**, **Business
Potential**, **Revenue Rocket**.

- **Best Product (quality + reliability):** deterministic, auditable scoring; a real
  engine, not a prompt wrapper; graceful degradation; a passing test suite; six
  well-specified skills with clean JSON schemas.
- **Business Potential:** two revenue lines (per-call A2MCP + high-value A2A escrow
  audits), a defensible moat (insider / CEX-flow / manipulation reads competitors do
  not have), and an on-chain track record that compounds trust.
- **Revenue Rocket:** cheap per-call pricing ($0.02 to $0.10) built for volume, six
  distinct paid endpoints, and an agent-to-agent demo that shows real settlement.

## The pitch (for the form's description field)

> Theia is an Agent Service Provider that sells crypto market intelligence other
> agents cannot get elsewhere: manipulation and wash-trade risk, insider holder
> distribution, exchange cold-wallet flow, cornered float, liquidation heatmaps, and
> a full confluence-scored trade plan. Six skills are pay-per-call over x402 on X
> Layer ($0.02 to $0.10). A premium A2A service, Theia Deep Desk, delivers
> escrow-backed multi-token audits released on sign-off. Every signal Theia fires is
> resolved to a real outcome and hashed onto X Layer, so its win rate is auditable
> on-chain, not claimed. Built on a production engine; scoring is deterministic and
> auditable, an LLM never decides a trade.

## What makes it credible to the judges

- **Reliability:** `npm run test:all` is green (engine + ASP). The engine boots and
  returns valid JSON against real tokens; skills degrade honestly when a data source
  is missing rather than fabricating.
- **Marketplace fit:** native A2MCP (x402) + A2A (escrow) + MCP tools; a working
  executor agent that pays and acts; optional use of OKX Onchain OS skills for
  discovery and execution while Theia keeps its insider/flow moat.
- **Long-term potential:** the on-chain reputation ledger turns a track record into a
  compounding asset; more resolved signals means a stronger, provable win rate.

## Links to have ready

- OKX.AI listing / Agent ID: ______
- Endpoint URL: ______
- X post (#okxai): ______
- Reputation anchor tx (X Layer): ______
- Repo (if public): ______

## Reminder on secrets before going public

If this repo is made public, re-verify `.gitignore` covers `.env`,
`logs/`, and all key material, and that no secret is in the git history. Theia's bot
secrets are never used by the ASP.
