// HD wallet — derives deterministic per-user EVM deposit addresses from ONE seed.
// An EVM address is identical across BSC/ETH/BASE, so each user gets ONE address
// that receives USDT on all three. Index 0 is RESERVED for the gas wallet (which
// funds sweeps); user deposit indices start at 1.
//
// SECURITY: the seed can derive every deposit address's private key, so the host
// holding it is effectively hot. Mitigations live elsewhere (sweep promptly; the
// hot/cold destination wallet's key is NOT on this host). NEVER log the seed/keys.
import { ethers } from 'ethers';

export const GAS_INDEX = 0;          // reserved: the gas-funding wallet
export const FIRST_USER_INDEX = 1;   // user deposit addresses start here

export class HdWallet {
  constructor(seedPhrase) {
    // Validate up front — an invalid/missing seed must fail LOUD, never derive from
    // garbage (which would hand users un-creditable, unrecoverable addresses).
    try { ethers.Mnemonic.fromPhrase(seedPhrase); }
    catch { throw new Error('billing: BILLING_SEED is missing or not a valid BIP-39 mnemonic'); }
    this.mnemonic = seedPhrase;
  }

  #at(index) {
    return ethers.HDNodeWallet.fromPhrase(this.mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
  }

  // Public address for a derivation index (no key exposed).
  addressForIndex(index) { return this.#at(index).address; }

  // A signing wallet for an index, optionally connected to a provider (for sweeps).
  walletForIndex(index, provider = null) {
    const w = this.#at(index);
    return provider ? w.connect(provider) : w;
  }

  gasAddress() { return this.addressForIndex(GAS_INDEX); }
  gasWallet(provider = null) { return this.walletForIndex(GAS_INDEX, provider); }
}
