// BillingService — the single entry point the main bot wires in. Self-contained and
// OPT-IN: nothing runs unless BILLING_ENABLED=1 with a valid BILLING_SEED. Even when
// enabled, gating is OFF until BILLING_ENFORCE=1 (so turning billing on can never
// lock anyone out by surprise — it tracks first, enforces when you're ready).
//
// Public API for the main bot:
//   billing.isActive(chatId)        → true if allowed premium access (always true if enforce off)
//   billing.status(chatId)          → 'trial' | 'active' | 'expired' | 'none'
//   await billing.depositAddress(chatId)  → permanent EVM address (creates + starts trial)
//   billing.startTrial(chatId)      → ensure the user exists + trial clock started
//   billing.accessUntil(chatId)     → ms timestamp access ends
import { HdWallet } from './hd-wallet.js';
import { SubscriptionStore } from './subscriptions.js';
import { DepositWatcher } from './deposit-watcher.js';
import { Sweeper } from './sweeper.js';
import { DEFAULT_SWEEP_CHAINS } from './chains.js';

export class BillingService {
  constructor({ notifier = null, verbose = false } = {}) {
    this.enabled = process.env.BILLING_ENABLED === '1';
    this.enforce = process.env.BILLING_ENFORCE === '1';
    this.priceUsd = Number(process.env.BILLING_PRICE_USD) || 30;
    this.notifier = notifier;
    this.verbose = verbose;
    this.ready = false;
    this.store = null;
    this.watcher = null;
  }

  async start() {
    if (!this.enabled) { console.log('[billing] disabled (set BILLING_ENABLED=1 to turn on)'); return; }
    const hd = new HdWallet(process.env.BILLING_SEED);        // throws loud on bad/missing seed
    const hotWallet = process.env.BILLING_HOT_WALLET || null;

    this.store = new SubscriptionStore({
      hd, priceUsd: this.priceUsd,
      trialDays: Number(process.env.BILLING_TRIAL_DAYS) || 7,
      monthDays: Number(process.env.BILLING_MONTH_DAYS) || 30,
    });
    await this.store.load();

    const sweepChains = (process.env.BILLING_SWEEP_CHAINS || DEFAULT_SWEEP_CHAINS.join(','))
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let sweeper = null;
    if (hotWallet) {
      sweeper = new Sweeper({ hd, hotWallet, sweepChains, verbose: this.verbose });
      sweeper.onSwept((chatId, chain) => this.store.resetCreditedUpTo(chatId, chain));
    } else {
      console.warn('[billing] BILLING_HOT_WALLET not set — deposits will be credited but NOT swept');
    }

    const notify = (chatId, text) => { try { this.notifier?.sendToChat?.(chatId, text); } catch { /* ignore */ } };
    this.watcher = new DepositWatcher({ store: this.store, sweeper, notify, pollMs: Number(process.env.BILLING_POLL_MS) || 90_000 });
    this.watcher.start();
    this.ready = true;
    console.log(`[billing] ENABLED — $${this.priceUsd}/mo · ${this.store.trialMs / 86_400_000}d trial · enforce=${this.enforce} · sweep=[${sweepChains.join(',')}] · gas wallet ${hd.gasAddress()}`);
  }

  stop() { this.watcher?.stop(); }

  // Premium-access gate. Returns true (allow) when not ready OR enforcement is off,
  // so the bot behaves exactly as before until you flip BILLING_ENFORCE=1.
  isActive(chatId) {
    if (!this.ready || !this.enforce) return true;
    return this.store.isActive(chatId);
  }
  status(chatId) { return this.ready ? this.store.status(chatId) : 'none'; }
  accessUntil(chatId) { return this.ready ? this.store.accessUntil(chatId) : 0; }
  async depositAddress(chatId) { return this.ready ? this.store.addressFor(chatId) : null; }
  startTrial(chatId) { if (this.ready) this.store.ensureUser(chatId).catch(() => {}); }
  // Admin: comp a user N days of free access (e.g. a friend). Returns paidUntil ms.
  async grantDays(chatId, days) { return this.ready ? this.store.grantDays(chatId, days) : 0; }
}
