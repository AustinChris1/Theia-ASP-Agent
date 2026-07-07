# Theia ASP — 90 second demo script

Goal: show a real agent paying Theia via x402 and acting on the result, plus the
verifiable track record. Keep it under 90 seconds. Post on X with `#okxai`.

Record at 1080p. Terminal + browser side by side. Pre-warm the server so nothing
buffers on camera (`npm run asp` running, universe already built).

---

## Beat 1 — The hook (0:00 to 0:10)

On screen: the OKX.AI marketplace page showing the listed "Theia" ASP with its six
skills and prices.

Say:
> "Agents can trade, but they are flying blind. Theia is an Agent Service Provider
> on OKX.AI that sells the intelligence: is this token being manipulated, are
> insiders dumping, where are the liquidations. Pay per call."

## Beat 2 — A signal, paid with x402 (0:10 to 0:35)

On screen: the executor agent terminal. Run:
```
node demo/executor.js --token SOL --live
```
Let the four steps scroll: call theia_signal, get a 402, pay via
`onchainos payment pay`, replay, receive the signal.

Say:
> "Another agent calls Theia's signal skill. It gets a 402, pays a few cents of
> USDT on X Layer through the OKX Agentic Wallet, and instantly gets back a full
> read: side, confidence, and a trade plan with entry, stop, and targets. No human
> touched this."

Hold on the final line: `THEIA SIGNAL: SOL LONG HIGH (confidence 78%)` and the plan.

## Beat 3 — It acts (0:35 to 0:45)

On screen: the executor's `[4] Executing via the OKX Agentic Wallet` step.

Say:
> "It does not just read the signal. It acts on it, routing the trade through the
> Agentic Wallet. Call, pay, decide, execute. One agent hiring another."

## Beat 4 — The moat and the audit (0:45 to 1:05)

On screen: quick calls (pre-recorded or live) to two more skills:
```
curl -s -XPOST localhost:8402/skills/theia_manipulation_check -d '{"token":"<memecoin>"}' | jq
curl -s -XPOST localhost:8402/a2a/quote -d '{"description":"audit my BTC ETH SOL bag","budgetUsdt":30}' | jq
```

Say:
> "The edge is the on-chain read others do not have: manipulation risk, insider
> holders, cornered float, liquidation magnets. And for bigger jobs, Theia Deep
> Desk takes an escrow task and delivers a full portfolio audit, paid only when you
> sign off."

## Beat 5 — Proof, not promises (1:05 to 1:25)

On screen: `curl -s localhost:8402/reputation | jq` showing the real win-rate and
the Merkle root; then the X Layer explorer showing the anchor transaction.

Say:
> "And every signal Theia fires is resolved to a real outcome and hashed onto X
> Layer. The win rate is not a claim, it is on-chain and auditable. That is an
> agent you can actually trust with money."

## Beat 6 — Close (1:25 to 1:30)

On screen: the OKX.AI listing with the Agent ID.

Say:
> "Theia, live on OKX.AI. #okxai"

---

## Shot list / prep

- [ ] Server running with real keys so signals show real tiers and plans
- [ ] A memecoin with genuine high manipulation risk chosen for Beat 4
- [ ] `X402_ENFORCE=1` + funded wallet so Beat 2 shows a real payment (or narrate
      the dry-run if the facilitator is not live yet)
- [ ] The reputation ledger anchored once so Beat 5 has a real tx to show
- [ ] OKX.AI listing page open with the Theia Agent ID visible

## Fallback (if x402 is not live yet on demo day)

Run the executor in dry-run (`node demo/executor.js --token SOL`). It decodes
the real 402 challenge and prints the exact `onchainos payment pay` command, then
fetches the signal from the free endpoint. Narrate: "in production this cent is
settled on X Layer; here is the exact payment step." Keep Beats 4 and 5 unchanged,
they need no wallet.
