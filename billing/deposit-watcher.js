// Deposit watcher — polls each watched user's USDT balance on every chain, credits
// new funds idempotently (via SubscriptionStore), notifies, and fires an async
// sweep. Balance-poll (one eth_call per address/chain) is plenty for subscriptions
// — far lighter than full log-scanning — and the store's per-chain watermark makes
// it idempotent without tracking tx hashes.
import { CHAIN_KEYS, CHAINS } from './chains.js';
import { usdtBalance } from './evm.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class DepositWatcher {
  constructor({ store, sweeper = null, notify = null, pollMs = 90_000, perCallDelayMs = 350 }) {
    this.store = store;
    this.sweeper = sweeper;
    this.notify = notify;             // (chatId, text) => void
    this.pollMs = pollMs;
    this.perCallDelayMs = perCallDelayMs;
    this.stopped = false;
    this._timer = null;
    this._inCycle = false;
  }

  start() {
    this.stopped = false;
    console.log(`[billing] deposit watcher polling every ${this.pollMs / 1000}s across ${CHAIN_KEYS.join('/')}`);
    this.#loop();
  }
  stop() { this.stopped = true; clearTimeout(this._timer); }

  async #loop() {
    if (this.stopped) return;
    try { await this.#cycle(); } catch (e) { console.warn(`[billing] watch cycle error: ${e.message}`); }
    if (!this.stopped) { this._timer = setTimeout(() => this.#loop(), this.pollMs); this._timer.unref?.(); }
  }

  async #cycle() {
    if (this._inCycle) return;        // re-entrancy guard (a slow cycle won't stack)
    this._inCycle = true;
    try {
      const users = this.store.usersToWatch();
      let credited = 0;
      for (const { chatId, rec } of users) {
        for (const chain of CHAIN_KEYS) {
          let balance;
          try { balance = await usdtBalance(chain, rec.address); }
          catch { continue; }                       // RPC hiccup → next chain/cycle
          await sleep(this.perCallDelayMs);          // gentle on public RPCs
          if (!(balance > 0)) continue;

          const r = await this.store.applyBalance(chatId, chain, balance);
          if (r.credited) {
            credited++;
            const until = new Date(r.newPaidUntil).toISOString().slice(0, 10);
            this.notify?.(chatId,
              `✅ *Payment received* — $${r.newFundsUsd.toFixed(2)} USDT on ${CHAINS[chain].name}.\n` +
              `Subscription active until *${until}* (+${r.months} month${r.months > 1 ? 's' : ''}). Thank you! 🚀`);
            this.sweeper?.sweep(chatId, chain, rec.index).catch(() => {});   // async; never blocks access
          } else if (r.underpay && !rec.underpayNotified?.[chain]) {
            this.store.markUnderpayNotified(chatId, chain);
            this.notify?.(chatId,
              `⚠️ Received $${r.underpay.toFixed(2)} USDT on ${CHAINS[chain].name}, but the plan is $${this.store.priceUsd}. ` +
              `Send the remaining ~$${r.need.toFixed(2)} to the *same address* to activate.`);
          }
        }
      }
      if (credited > 0) console.log(`[billing] credited ${credited} payment(s) this cycle`);
    } finally {
      this._inCycle = false;
    }
  }
}
