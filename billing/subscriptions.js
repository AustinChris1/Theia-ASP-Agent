// Subscription state + the trial/credit/gating brain. Persisted via the bot's
// Neon kv (namespace 'billing'); falls back to JSON files like the rest of db.js.
import { kvGet, kvSet } from '../src/db.js';
import { FIRST_USER_INDEX } from './hd-wallet.js';

const NS = 'billing';
const KEY = 'subscriptions';
const DAY = 86_400_000;

// ── Pure helpers (exported for tests) ───────────────────────────────────────
export function creditMonths(amountUsd, priceUsd) {
  if (!(priceUsd > 0) || !(amountUsd > 0)) return 0;
  return Math.floor(amountUsd / priceUsd + 1e-9);   // epsilon: $30.0000001 still = 1mo
}
export function extendedPaidUntil(currentPaidUntil, months, now, monthMs) {
  if (months <= 0) return currentPaidUntil || 0;
  return Math.max(now, currentPaidUntil || 0) + months * monthMs;   // stacks onto unused time
}
export function accessUntil(rec, trialMs) {
  if (!rec) return 0;
  const trialEnd = rec.trialStartedAt ? rec.trialStartedAt + trialMs : 0;
  return Math.max(trialEnd, rec.paidUntil || 0);
}
export function statusOf(rec, now, trialMs) {
  if (!rec) return 'none';
  if ((rec.paidUntil || 0) > now) return 'active';
  const trialEnd = rec.trialStartedAt ? rec.trialStartedAt + trialMs : 0;
  return trialEnd > now ? 'trial' : 'expired';
}

export class SubscriptionStore {
  constructor({ hd, priceUsd, trialDays = 7, monthDays = 30 }) {
    this.hd = hd;
    this.priceUsd = priceUsd;
    this.trialMs = trialDays * DAY;
    this.monthMs = monthDays * DAY;
    this.state = { nextIndex: FIRST_USER_INDEX, users: {} };
  }

  async load() {
    const s = await kvGet(NS, KEY).catch(() => null);
    if (s && typeof s === 'object') {
      this.state.nextIndex = Number(s.nextIndex) || FIRST_USER_INDEX;
      this.state.users = s.users || {};
    }
    return this;
  }
  async #save() { try { await kvSet(NS, KEY, this.state); } catch (e) { console.warn(`[billing] save failed: ${e.message}`); } }

  // Create a user's record (permanent address) + start the free trial on first touch.
  async ensureUser(chatId) {
    const id = String(chatId);
    let rec = this.state.users[id];
    if (!rec) {
      const index = this.state.nextIndex++;
      rec = {
        index,
        address: this.hd.addressForIndex(index),
        trialStartedAt: Date.now(),
        paidUntil: 0,
        totalPaidUsd: 0,
        creditedUpTo: {},        // chain → USDT balance already credited (idempotency)
        underpayNotified: {},
        credits: [],
      };
      this.state.users[id] = rec;
      await this.#save();
      console.log(`[billing] new subscriber ${id} → index ${index} ${rec.address}`);
    }
    return rec;
  }

  get(chatId) { return this.state.users[String(chatId)] || null; }
  isActive(chatId, now = Date.now()) { return accessUntil(this.get(chatId), this.trialMs) > now; }
  status(chatId, now = Date.now()) { return statusOf(this.get(chatId), now, this.trialMs); }
  accessUntil(chatId) { return accessUntil(this.get(chatId), this.trialMs); }
  async addressFor(chatId) { return (await this.ensureUser(chatId)).address; }

  // Idempotent credit. `balance` = CURRENT USDT balance on `chain`; we credit only
  // the portion above what's already been credited for that chain.
  async applyBalance(chatId, chain, balance, now = Date.now()) {
    const rec = this.get(chatId);
    if (!rec) return { credited: false };
    const already = rec.creditedUpTo[chain] || 0;
    const newFunds = balance - already;
    if (newFunds < this.priceUsd) {
      return { credited: false, underpay: newFunds > 0.5 ? newFunds : 0, need: Math.max(0, this.priceUsd - newFunds) };
    }
    const months = creditMonths(newFunds, this.priceUsd);
    rec.paidUntil = extendedPaidUntil(rec.paidUntil, months, now, this.monthMs);
    rec.totalPaidUsd = Number((rec.totalPaidUsd + newFunds).toFixed(2));
    rec.creditedUpTo[chain] = balance;
    rec.underpayNotified[chain] = false;
    rec.credits.push({ chain, usd: Number(newFunds.toFixed(2)), months, ts: now });
    await this.#save();
    return { credited: true, months, newPaidUntil: rec.paidUntil, newFundsUsd: newFunds };
  }

  // Admin: grant N days of FREE access (comp a friend, refund, etc.). Stacks onto
  // any remaining paid time. Returns the new paidUntil.
  async grantDays(chatId, days, now = Date.now()) {
    const rec = await this.ensureUser(chatId);
    rec.paidUntil = Math.max(now, rec.paidUntil || 0) + days * DAY;
    rec.credits.push({ chain: 'grant', usd: 0, days, ts: now });
    await this.#save();
    console.log(`[billing] granted ${days}d free access to ${chatId} → ${new Date(rec.paidUntil).toISOString()}`);
    return rec.paidUntil;
  }

  // After a successful sweep the on-chain balance is ~0, so reset the watermark —
  // the next deposit (0→X) is then correctly seen as fresh funds.
  async resetCreditedUpTo(chatId, chain) {
    const rec = this.get(chatId);
    if (rec && rec.creditedUpTo[chain]) { rec.creditedUpTo[chain] = 0; await this.#save(); }
  }
  markUnderpayNotified(chatId, chain) {
    const rec = this.get(chatId);
    if (rec) { (rec.underpayNotified ??= {})[chain] = true; this.#save(); }
  }

  // Users worth polling: skip far-prepaid ones (> now+45d) to bound RPC load.
  usersToWatch(now = Date.now()) {
    const out = [];
    for (const [chatId, rec] of Object.entries(this.state.users)) {
      if (accessUntil(rec, this.trialMs) > now + 45 * DAY) continue;
      out.push({ chatId, rec });
    }
    return out;
  }
}
