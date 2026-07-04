# billing/ — subscription & on-chain payments

Self-contained subscription system. **Off by default** — the trading bot is
completely unaffected until you set `BILLING_ENABLED=1`. Even then, access is only
*tracked* (not enforced) until `BILLING_ENFORCE=1`.

## How it works
- **One seed → one permanent address per user.** A BIP-39 mnemonic (`BILLING_SEED`)
  derives `m/44'/60'/0'/0/{index}`. Index 0 = the gas wallet; users get index 1+.
  An EVM address is identical on BSC/ETH/BASE, so each user has **one** address that
  accepts USDT on all three.
- **7-day free trial** from first `/subscribe` (or first touch). Then **$30/month**
  (`BILLING_PRICE_USD`).
- **Payment detection.** A watcher polls each watched user's USDT balance on
  BSC/ETH/BASE every ~90s. A new deposit ≥ price credits months (idempotent via a
  per-chain "already credited" watermark). Over-pay → multiple months; under-pay →
  held + the user is asked to top up.
- **Sweeping.** On a credited BSC/Base deposit, the gas wallet tops up the deposit
  address with a cent of native gas, then the USDT is swept to `BILLING_HOT_WALLET`.
  ETH is left for manual/batch sweeping (gas can exceed a small sub). **Credit is
  decoupled from sweep** — a stuck sweep never blocks a paying user.

## Setup
1. **Generate a brand-new, dedicated mnemonic** (NOT one tied to other funds):
   ```bash
   node -e "console.log(require('ethers').Wallet.createRandom().mnemonic.phrase)"
   ```
   Store it as `BILLING_SEED` (Render env). **Never commit/log it.**
2. **Fund the gas wallet.** Print its address and send a few dollars of **BNB** (BSC)
   and **ETH** (Base) to it — it pays for sweeps:
   ```bash
   node -e "import('./billing/hd-wallet.js').then(({HdWallet})=>console.log(new HdWallet(process.env.BILLING_SEED).gasAddress()))"
   ```
   (Same address on both chains.)
3. **Set `BILLING_HOT_WALLET`** to an address you control whose key is **NOT** on the
   server (e.g. a hardware/exchange wallet) — swept funds land there.
4. Flip `BILLING_ENABLED=1`. Watch logs for `[billing] ENABLED …`. Users can now
   `/subscribe`. Leave `BILLING_ENFORCE=0` for a while (tracks trials/payments without
   blocking anyone), then set `BILLING_ENFORCE=1` to start gating premium features.

## Security
- The seed can derive every deposit address's key, so the host is effectively hot.
  Keep the **hot wallet** (bulk of funds) off-server; **sweep promptly**; move hot →
  cold periodically. Boot **fails loud** if `BILLING_SEED` is missing/invalid.
- Gas wallet holds only enough native for sweeps; refill as needed.

## Env vars
`BILLING_ENABLED` `BILLING_ENFORCE` `BILLING_PRICE_USD` `BILLING_TRIAL_DAYS`
`BILLING_MONTH_DAYS` `BILLING_SEED` `BILLING_HOT_WALLET` `BILLING_SWEEP_CHAINS`
`BILLING_POLL_MS` — see `.env.example`.
