// Balance locator. Run on the VPS:  node src/autotrade/test-balance.js
// Shows where your Bybit money actually is — Unified Trading vs Funding —
// so we know whether a transfer is needed before live trading.

import 'dotenv/config';
import { BybitExchange } from './exchange-bybit.js';

const ex = new BybitExchange({
  apiKey: process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
  testnet: process.env.BYBIT_TESTNET === '1',
  baseUrl: process.env.BYBIT_BASE_URL || null,
  proxyUrl: process.env.BYBIT_PROXY || null,
  proxyAuthSecret: process.env.BYBIT_PROXY_SECRET || null
});

const show = (label, fn) => fn()
  .then(r => console.log(`\n=== ${label} ===\n${JSON.stringify(r, null, 2).slice(0, 1500)}`))
  .catch(e => console.log(`\n=== ${label} ===\n❌ ${e.message}`));

console.log('Locating funds across Bybit wallets…');
await show('UNIFIED (trading account — bot uses this)', () => ex.rawWallet('UNIFIED'));
await show('FUND (funding account — deposits often land here)', () => ex.fundingBalance());

console.log('\nIf the money shows under FUND but UNIFIED is empty:');
console.log('  Bybit → Assets → Transfer → move USDT from Funding → Unified Trading.');
console.log('If it shows under UNIFIED as a non-USDT coin, convert/keep USDT for trading.');
