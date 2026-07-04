// Bybit API-key smoke test. Run on the VPS (where Bybit is reachable):
//   node src/autotrade/test-key.js
//
// Verifies the key/secret in .env can authenticate and READ balance. Does NOT
// place any order. Interprets the common Bybit error codes so a failure tells
// you exactly what's wrong (bad key, bad secret, IP not whitelisted, etc.).

import 'dotenv/config';
import { BybitExchange } from './exchange-bybit.js';

const key = process.env.BYBIT_API_KEY;
const secret = process.env.BYBIT_API_SECRET;

if (!key || !secret) {
  console.error('❌ BYBIT_API_KEY / BYBIT_API_SECRET not set in .env');
  process.exit(1);
}
const proxyUrl = process.env.BYBIT_PROXY || null;
const baseUrl = process.env.BYBIT_BASE_URL || null;
const proxyAuthSecret = process.env.BYBIT_PROXY_SECRET || null;
console.log(`Testing key ${key.slice(0, 4)}…${key.slice(-2)} (len ${key.length}), secret len ${secret.length}, testnet=${process.env.BYBIT_TESTNET === '1'}, proxy=${proxyUrl ? 'yes' : 'no'}, relay=${baseUrl ? baseUrl : 'no'}`);

const ex = new BybitExchange({ apiKey: key, apiSecret: secret, testnet: process.env.BYBIT_TESTNET === '1', proxyUrl, baseUrl, proxyAuthSecret, verbose: true });

try {
  const bal = await ex.getBalance();
  console.log(`✅ AUTH OK — account reachable. Available USDT balance: $${bal}`);
  // Also confirm we can read instrument metadata (needed for order sizing).
  const inst = await ex.getInstrument('BTCUSDT');
  console.log(`✅ Instrument read OK — BTCUSDT qtyStep=${inst?.qtyStep} minQty=${inst?.minQty} maxLev=${inst?.maxLeverage}`);
  console.log('\nKey is valid and has trade-data read access. You can set AUTOTRADE=live and /autotrade on when ready.');
} catch (err) {
  const msg = err.message ?? String(err);
  console.error(`❌ FAILED: ${msg}`);
  // Interpret common Bybit retCodes
  if (err.retCode === 10003 || /invalid api key|api key is invalid/i.test(msg)) {
    console.error('   → The API KEY is wrong or was revoked. Re-copy it from Bybit.');
  } else if (err.retCode === 10004 || /sign|signature/i.test(msg)) {
    console.error('   → The API SECRET is wrong (signature mismatch). Re-copy the secret.');
  } else if (err.retCode === 10010 || /unmatched ip|ip ?address/i.test(msg)) {
    console.error('   → IP whitelist mismatch. You are relaying through Vercel/Cloudflare whose egress IPs rotate, so a fixed whitelist can\'t match.');
    console.error('     FIX: on the Bybit key, set "No IP restriction" (unrestricted). Trade-only perm + the relay PROXY_SECRET keep it safe.');
    console.error('     Note: unrestricted Bybit keys auto-expire every 90 days — regenerate when that happens.');
  } else if (err.retCode === 10005 || /permission/i.test(msg)) {
    console.error('   → Key lacks permission. Enable "Unified Trading → Trade" on the key.');
  } else if (/timeout|fetch failed|network/i.test(msg)) {
    console.error('   → Network: could not reach api.bybit.com from this host (firewall/region). Bybit must be reachable from the VPS.');
  }
  process.exit(1);
}
