// Billing admin CLI — operator tooling. Needs BILLING_SEED (+ DATABASE_URL to look
// users up by chatId, + BILLING_HOT_WALLET for `sweep`). Run from a SECURE machine.
//
//   node billing/admin.js gas                       # gas-wallet address
//   node billing/admin.js status  <chatId>          # subscription status
//   node billing/admin.js address <chatId>          # deposit address
//   node billing/admin.js grant   <chatId> <days>   # comp free access (a friend)
//   node billing/admin.js sweep   <chatId> <chain>  # MANUAL retry of a stuck sweep
//   node billing/admin.js key     <chatId>          # export the private key (LAST RESORT)
//   node billing/admin.js key --index <n>           # export by raw HD index
import 'dotenv/config';
import { HdWallet } from './hd-wallet.js';
import { SubscriptionStore, statusOf, accessUntil } from './subscriptions.js';
import { Sweeper } from './sweeper.js';

const seed = process.env.BILLING_SEED;
if (!seed) { console.error('Set BILLING_SEED first.'); process.exit(1); }
const hd = new HdWallet(seed);

const [cmd, ...args] = process.argv.slice(2);
const fmt = (ms) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';

// `key --index N` derives directly without the store (no DB needed).
if (cmd === 'key' && args[0] === '--index') {
  const idx = Number(args[1]);
  const w = hd.walletForIndex(idx);
  console.log(`⚠️  PRIVATE KEY (idx ${idx}, ${w.address}) — keep secret, import to MetaMask to move funds:\n${w.privateKey}`);
  process.exit(0);
}
if (cmd === 'gas') { console.log('⛽ Gas wallet:', hd.gasAddress()); process.exit(0); }

// Everything else needs the store (chatId → index/address). Loads from Neon kv.
const store = new SubscriptionStore({
  hd,
  priceUsd: Number(process.env.BILLING_PRICE_USD) || 30,
  trialDays: Number(process.env.BILLING_TRIAL_DAYS) || 7,
  monthDays: Number(process.env.BILLING_MONTH_DAYS) || 30,
});
await store.load();

const need = (id) => {
  const r = store.get(id);
  if (!r) { console.error(`No subscriber "${id}". They must have run /subscribe at least once.`); process.exit(1); }
  return r;
};

switch (cmd) {
  case 'status': {
    const r = need(args[0]);
    console.log(`user ${args[0]} · idx ${r.index} · ${r.address}`);
    console.log(`  status:      ${statusOf(r, Date.now(), store.trialMs)}`);
    console.log(`  access until: ${fmt(accessUntil(r, store.trialMs))}`);
    console.log(`  paid until:   ${fmt(r.paidUntil)}`);
    console.log(`  total paid:   $${r.totalPaidUsd}`);
    break;
  }
  case 'address': { const r = need(args[0]); console.log(`${args[0]} (idx ${r.index}):`, r.address); break; }
  case 'grant': {
    const days = Number(args[1]);
    if (!(days > 0)) { console.error('Usage: grant <chatId> <days>'); process.exit(1); }
    const until = await store.grantDays(args[0], days);
    console.log(`✅ Granted ${days} day(s) to ${args[0]} → access until ${fmt(until)}`);
    break;
  }
  case 'key': {
    const r = need(args[0]);
    const w = hd.walletForIndex(r.index);
    console.log(`⚠️  PRIVATE KEY for ${args[0]} (idx ${r.index}, ${r.address}) — keep secret:\n${w.privateKey}`);
    break;
  }
  case 'sweep': {
    const r = need(args[0]);
    const chain = args[1];
    const hot = process.env.BILLING_HOT_WALLET;
    if (!chain) { console.error('Usage: sweep <chatId> <bsc|base|ethereum>'); process.exit(1); }
    if (!hot) { console.error('Set BILLING_HOT_WALLET first.'); process.exit(1); }
    const sweeper = new Sweeper({ hd, hotWallet: hot, sweepChains: [chain], verbose: true });
    sweeper.onSwept((id, c) => store.resetCreditedUpTo(id, c));
    const ok = await sweeper.sweep(args[0], chain, r.index);
    console.log(ok ? '✅ swept to hot wallet' : '❌ nothing swept (no balance, gas wallet low, or RPC error — see logs)');
    break;
  }
  default:
    console.log('commands: gas | status <chatId> | address <chatId> | grant <chatId> <days> | sweep <chatId> <chain> | key <chatId> | key --index <n>');
}
process.exit(0);
