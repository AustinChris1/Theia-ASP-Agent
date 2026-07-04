# NOTES-okx.md — OKX.AI ASP integration ground truth

Source of truth for the OKX integration. Everything here is drawn from the **installed
`okx/onchainos-skills` package** (the skill markdown + the Rust CLI source) and OKX docs,
not from memory. Where a fact is inferred or unconfirmed it is marked **[OPEN]**.

Package installed via `npx skills add okx/onchainos-skills --yes -g`. The clone (preserved
copy) lives at `<scratchpad>/onchainos-skills/`. The runtime binary is the Rust CLI
`onchainos` (installed separately by `install.ps1` / `install.sh`); the skills are markdown
playbooks that drive that CLI.

---

## 0. The mental model (how the pieces fit)

- **OKX.AI** is an agent marketplace. You register an **ASP (Agent Service Provider)**
  identity, then attach one or more **services** to it. Two service types:
  - **A2MCP** — pay-per-call over HTTP, settled **instantly via x402**. This is the core of
    our six skills. Registered service carries a **public HTTPS endpoint** that must return
    an x402 `402` challenge. `service-type A2MCP -> x402`.
  - **A2A** — negotiated task, funds held in **escrow on X Layer**, released on user
    sign-off, disputes go to **Evaluator** arbitration. This is "Theia Deep Desk".
    `service-type A2A -> escrow`.
- **Identity** is **ERC-8004 on-chain, on X Layer only** (chainIndex/chainId **196**).
  Created/managed through the `onchainos agent` CLI, signed by the **Agentic Wallet**.
- **All agent on-chain actions are gas-free** (OKX paymaster). The user's wallet never needs
  native gas.
- Agents talk to each other over **XMTP** (end-to-end encrypted) via `okx-agent-chat`.
- The `onchainos` CLI is the **buyer/agent/identity** side. It does NOT provide a
  seller-side x402 server. **We build the seller/resource-server ourselves** to the
  standard x402 V2 spec (which OKX explicitly follows).

---

## 1. Installed skills (17) — what each is for

Registration / commerce (what we use):
- **okx-agent-identity** — register/update/activate/deactivate ASP + service identities;
  view ratings; `agent search`. ERC-8004 on X Layer. (`agent create/pre-check/validate-listing/upload/activate`)
- **okx-agent-task** — the A2A task lifecycle state machine (publish, apply, accept,
  deliver, complete, reject, dispute, rate). Driven by `onchainos agent next-action`.
- **okx-agent-payments-protocol** — the **buyer-side** x402 / MPP / a2a-pay dispatcher
  (`onchainos payment pay | charge | session | a2a-pay`). Used by a paying agent, incl. our
  demo executor agent.
- **okx-agentic-wallet** — wallet login, balance, send, swap, bridge, contract-call,
  security scan. Login is the first human step.
- **okx-agent-chat** — XMTP comms bootstrap (required subflow after identity create and in
  every task flow).

Market data / discovery (usable inside our engine or the demo, but Theia's own moat stays ours):
- **okx-dex-market** (prices, K-line, PnL), **okx-dex-token** (search, holders, clusters),
  **okx-dex-signal** (smart money), **okx-dex-trenches** (memes), **okx-dex-social** (news/
  sentiment), **okx-dex-ws** (websocket), **okx-defi-invest**, **okx-defi-portfolio**,
  **okx-dapp-discovery**, **okx-growth-competition**, **okx-guide**, **okx-task-watch**.

These DEX data skills are themselves **x402-monetized** (see §4) — a live, real-world example
of the exact seller pattern we implement.

---

## 2. Agent Identity + ASP registration (okx-agent-identity)

CLI is authoritative; the skill is a routing/QA/confirm wrapper. Chain is fixed to X Layer
(never pass `--chain`). Human-in-the-loop is required (wallet signs).

Registration flow (per `references/register.md`):
1. `onchainos agent pre-check --role asp` — folds first-time consent + per-wallet uniqueness.
   Returns `{ canCreate, role, reason?, consent?, existingSameRole, aspCount }`.
   **One ASP identity per wallet address per role.**
2. Collect **identity**: name (EN 3-25 chars, brand, no celebrity substrings), description
   (<=500 chars), **avatar (required)** — upload an image with `agent upload --file <tmp>`,
   use the returned CDN URL as `--picture`.
3. Collect **service(s)** — repeatable, all ship in ONE `agent create`:
   - **name** (5-30 char noun phrase, not = agent name, no price in name)
   - **description** — 2 parts on separate lines: (1) core capability + who it's for,
     (2) what the user must provide. <=400 CJK chars total. No links, no tech stack, no disclaimers.
   - **type** — `A2MCP` (API) or `A2A` (agent-to-agent).
   - **fee** — a **plain number as a string** e.g. `"5"`. Currency is **always USDT**,
     digits only, <=6 decimals. Required for A2MCP; optional for A2A.
   - **endpoint** (A2MCP only) — **public `https://`, really deployed, <=512 chars,
     PERMANENT on-chain** (changing it later needs another update). Rejects http/localhost/
     private IPs/placeholders.
4. `onchainos agent validate-listing --role asp --name .. --description .. --service '[..]'`
   → `{ pass, findings[] }` (QA gate, runs once).
5. `onchainos agent create --role asp --name .. --description .. --picture <cdnUrl> --service '<json array>'`
   → returns `newAgentId`.
6. Post-create **required**: run the `okx-agent-chat` comms-init subflow.
7. `onchainos agent activate <id>` to publish. Listing review within 24h (result emailed +
   in-agent). Until approved it's usable by Agent ID directly.

Service JSON array element shape (inferred from register.md fields + task `set-asp`):
```json
{ "name": "...", "description": "...", "type": "A2MCP", "fee": "5", "endpoint": "https://..." }
```

Cost: on-chain create/update/activate cost the user nothing (OKX covers fees).

---

## 3. x402 — the payment standard (SELLER side is ours to build)

OKX A2MCP uses **standard x402 V2**. From the CLI source (`cli/src/client.rs`,
`cli/src/chains.rs`, `commands/payment/*`):
- 402 response carries **`PAYMENT-REQUIRED`** header = base64 JSON `{ x402Version, resource, accepts }`
  (v2). Legacy v1 puts `x402Version` in the body. `WWW-Authenticate: Payment` is the
  alternative "MPP charge/session" family.
- Buyer signs and **replays** with the **`PAYMENT-SIGNATURE`** header (v2). Server returns
  200 + a `PAYMENT-RESPONSE` header (base64 JSON: `status`/`transaction`/`amount`/`payer`).
- `accepts[]` entry (what the **seller declares** — this is what our middleware emits):
  - `scheme`: `exact` (settle now, EIP-3009), `aggr_deferred` (async settle), or `upto`
    (metered, settle <= cap). `exact` is the simple default.
  - `network`: CAIP-2 `eip155:196` (X Layer).
  - `asset`: ERC-20 contract (USDT or USDG on X Layer).
  - `amount` / `maxAmountRequired`: base units.
  - `payTo`: our ASP wallet address.
  - optional `extra` (EIP-712 domain `name`/`version`, `assetTransferMethod`,
    `facilitatorAddress` for upto), `outputSchema.input` (declares replay params).
- Settlement is on-chain via a **facilitator** using canonical Permit2 proxies (same on all
  EVM chains): exact = `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`,
  upto = `0x4020e7393B728A3939659E5732F87fdd8e680002`.

### Seller SDK decision (updated during build)
- **`x402-express` v1.2.0** exports `paymentMiddleware(payTo, routes, facilitator?, paywall?)`.
  BUT its `Network` enum (in the `x402` package) is base / avalanche / sei / polygon / peaq /
  story / educhain / iotex / abstract / solana. **X Layer (196) is NOT in it**, and its
  default facilitator is x402.org (testnet) / Coinbase, not OKX. So vanilla `x402-express`
  cannot express an X Layer payment out of the box.
- There is **no `@okx/x402` npm package** (404). OKX's X Layer x402 stack is server-side
  (its own DEX endpoints settle on X Layer via OKX's facilitator, confirmed in §4).
- **Decision taken:** we hand-rolled `asp/payments/x402.js` to the standard x402 V2 wire
  format (which OKX follows) but with **network + facilitator fully configurable** so it
  emits the exact X Layer `accepts` shape and delegates verify/settle to a configurable
  facilitator (standard `/verify` + `/settle`). Modes: `off` (dev/free), `declare` (valid
  402, no settlement until a facilitator is set), `facilitator` (real verify+settle). We do
  NOT reimplement crypto; the facilitator does. `x402-express` stays a dependency and can be
  swapped in for a Base/testnet demo. Unit-tested against a mocked facilitator.

### [OPEN] The one genuine blocking unknown
The exact **facilitator base URL** OKX's resource servers use for `verify`/`settle` on X
Layer, and whether "OKX Payment SDK integration" means anything beyond standard x402 V2 with
that facilitator. The DEX skills confirm the wire format (USDT/USDG on X Layer 196, decimal
`amount`, `payTo`, standard x402 V2 `PAYMENT-SIGNATURE`) but not the facilitator endpoint a
seller calls. Resolution path: make the facilitator URL a **config value**; confirm it via
(a) the OKX dev portal / OnchainOS docs, and (b) `onchainos agent x402-check --endpoint <url>`
and `x402-validate` (CLI commands that validate a live x402 endpoint + extract pricing) once
our endpoint is deployed. This does not block building the endpoint — only going live.

---

## 4. Real seller example — DEX Market API x402 (confirms the pattern)

`okx-dex-market/_shared/payment-notifications.md` shows OKX's own paid data endpoints
charging via x402 after a free quota:
- Settlement `payment[]` entry: `{ amount:"0.0005", asset:"0x..", symbol:"USDT"|"USDG",
  network:"X Layer", chainId:196, payTo:"0x..", isDefault }`. Amounts are **decimal strings**.
- Supported assets: **USDT and USDG on X Layer (196)**. Prices are tiny (Basic $0.0001/call,
  Premium $0.005/call) — confirms "price cheap calls low to drive volume".
- Buyer picks asset once (`payment default set`), then the CLI auto-signs. Confirms our
  service just declares `accepts` for USDT (+ optionally USDG) on X Layer at a fixed price.

---

## 5. A2A task lifecycle (okx-agent-task) — "Theia Deep Desk"

Decentralized task protocol on X Layer. Roles: **User Agent** (publishes/reviews), **ASP**
(accepts/delivers), **Evaluator** (arbitrates via commit-reveal vote). All CLI-driven; the
state machine lives in `onchainos agent next-action` (we execute its emitted script).

Task statuses: `-1` draft, `0` created, `1` accepted, `2` submitted, `3` rejected,
`4` disputed, `5` admin_stopped, `6` complete (funds -> ASP), `7` close (funds -> user),
`8` expired, `9` failed (arbitration refunds user). paymentMode: `1`=escrow, `3`=x402.

Happy path (escrow):
1. User `create-task` (budget in USDT/USDG, visibility, optional designated `--provider`).
2. ASP `recommend-task`/`find-jobs` -> `contact-user <jobId>` -> negotiate over XMTP ->
   `apply <jobId> --token-amount <price> --token-symbol USDT`.
3. User `confirm-accept <jobId>` — **funds escrowed**, emits `job_accepted`.
4. **Only after `job_accepted`** ASP does the real work + `deliver <jobId> --file <report> --message ..`.
5. User `complete <jobId>` (release funds) or `reject --reason ..`.
6. Dispute: `dispute raise`/`dispute confirm` -> Evaluators `vote-commit`/`vote-reveal`.
   Evaluator stakes OKB; arbitration fee bps from `staking-config`.
7. Rating: `agent feedback-submit --agent-id <ratee> --creator-id <rater> --score <0-100>
   --task-id <jobId> [--description ..]` — **on-chain**, rendered 0.00-5.00 stars via
   `agent feedback-list --agent-id <N>`.

Gate: never `deliver` before `job_accepted` (CLI rejects `status != accepted`, and delivering
pre-escrow = working for free). Our A2A handler must gate real engine work on `job_accepted`.

---

## 6. Agentic Wallet login (okx-agentic-wallet) — first human step

- `onchainos wallet login <email>` (email OTP) or AK login (`OKX_API_KEY/SECRET_KEY/PASSPHRASE`).
- `onchainos wallet status` — check session. `onchainos wallet addresses --format json` — get
  our ASP payTo address (X Layer). X Layer (196) is **gas-free**.
- Credentials (`accessToken`, `sessionKey`, `sessionCert`, private keys) are TEE-held; never
  logged/printed. Our server never handles the wallet key — the CLI/TEE does.

---

## 7. On-chain reputation (two distinct things — don't conflate)

1. **OKX task ratings** (ERC-8004): `feedback-submit`/`feedback-list`, 0-5 stars, written by
   counterparties after A2A tasks. We get these for free by doing good A2A work.
2. **Theia's own verifiable-alpha ledger** (our winning feature): take **real resolved
   outcomes** from `signal-tracker.getStats()` / `allRecords()` and publish a hash of each
   (signal + outcome) to **X Layer** so the win-rate/P&L is independently auditable. Options:
   emit as tx calldata or a tiny append-only contract, signed via the Agentic Wallet
   (`onchainos wallet send`/`contract-call`) or a dedicated key. **Only real outcomes; never
   fabricate.** [OPEN] exact on-chain sink (calldata memo vs. contract) — decide at build.

---

## 8. Constraints captured

- **Security**: OkxHack is currently **NOT a git repo** and has **no `.gitignore`**, but a real
  `.env` and `logs/` exist. Before any `git init`/commit, a `.gitignore` excluding
  `.env`, `.env.*` (keep `.env.example`), `asp/.env`, `logs/`, `node_modules/`, and any key
  material is **mandatory**. No secret has been read or copied. ASP uses its own fresh
  `asp/.env` (never the bot's Telegram/autotrade/vault secrets).
- The wallet key is never in our env — it lives in the `onchainos` CLI / TEE.
- Every external `fetch` keeps an `AbortSignal.timeout(...)` (existing Theia convention).
- No em-dashes in user-facing copy/docs. LLM may narrate only, never decide.

---

## 9. Human-in-the-loop steps (run through the user's Agentic Wallet)

Exact prompts (from okx.ai/tutorial/asp), to hand to the user's agent session:
1. `npx skills add okx/onchainos-skills --yes -g` (done) + install the `onchainos` CLI
   (`irm https://raw.githubusercontent.com/okx/onchainos-skills/main/install.ps1 | iex`).
2. "Log in to Agentic Wallet on Onchain OS with my email" -> `onchainos wallet login <email>`.
3. Deploy our A2MCP endpoint to a public HTTPS URL FIRST (endpoint is permanent on-chain).
4. "Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS".
5. "Help me register an A2A ASP on OKX.AI ..." (adds the Deep Desk service).
6. "Help me list my ASP on OKX.AI using Onchain OS" -> activate + submit for review.
   Note: the A2MCP endpoint must pass x402 (`agent x402-check`) before it can go live.

---

## 10. Open questions to resolve before go-live (not before building)

1. **[OPEN]** OKX facilitator base URL for seller-side verify/settle on X Layer (§3). Config-driven.
2. **[OPEN]** Whether `x402-express`'s default facilitator interface matches OKX's, or if a
   thin custom facilitator client is needed. Validate with `agent x402-check` on the deployed endpoint.
3. **[OPEN]** USDT / USDG contract addresses on X Layer (196) for the `accepts.asset` field
   (read from a `wallet chains` / dex-token lookup at build; the DEX skill confirms both are supported).
4. **[OPEN]** Reputation-ledger on-chain sink: tx calldata memo vs. minimal contract (§7).
5. **[OPEN]** Public host for the endpoint (Render, as Theia uses today, vs. other) + stable domain.
