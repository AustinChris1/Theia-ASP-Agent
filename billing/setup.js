// One-time setup helper. Run: node billing/setup.js
//   • No BILLING_SEED set  → generates a NEW mnemonic + shows the gas address.
//   • BILLING_SEED set      → shows the gas address + a few user addresses.
// Pass a seed explicitly to derive from it:  node billing/setup.js "word1 word2 ..."
import 'dotenv/config';
import { ethers } from 'ethers';
import { HdWallet } from './hd-wallet.js';

const argSeed = process.argv.slice(2).join(' ').trim();
let seed = argSeed || process.env.BILLING_SEED;
let generated = false;

if (!seed) {
  seed = ethers.Wallet.createRandom().mnemonic.phrase;
  generated = true;
}

const hd = new HdWallet(seed);   // validates; throws loud if invalid

if (generated) {
  console.log('\n🔑 Generated a NEW dedicated seed. SAVE THIS as BILLING_SEED in Render.');
  console.log('   Never commit it, never reuse a seed tied to other funds.\n');
  console.log('   ' + seed + '\n');
}
console.log('⛽ Gas wallet (fund with BNB on BSC + ETH on Base):');
console.log('   ' + hd.gasAddress() + '\n');
console.log('👤 First user deposit addresses (same address on BSC/ETH/Base):');
for (const i of [1, 2, 3]) console.log(`   idx ${i}: ${hd.addressForIndex(i)}`);
console.log('');
process.exit(0);
