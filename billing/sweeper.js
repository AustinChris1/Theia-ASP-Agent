// Sweeper — consolidates a user's deposited USDT into the hot wallet. USDT can't
// move without native gas at the deposit address, so we top it up from the gas
// wallet (HD index 0) first, then transfer. Credit already happened in the watcher;
// a sweep failure NEVER affects access — it just retries next cycle.
import { ethers } from 'ethers';
import { CHAINS, DEFAULT_SWEEP_CHAINS } from './chains.js';
import { getProvider, usdtBalanceRaw, nativeBalance } from './evm.js';

const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const GAS_LIMIT = 100_000n;   // generous for an ERC-20 transfer

export class Sweeper {
  constructor({ hd, hotWallet, sweepChains, verbose = false }) {
    this.hd = hd;
    this.hotWallet = hotWallet;
    this.sweepChains = new Set((sweepChains?.length ? sweepChains : DEFAULT_SWEEP_CHAINS));
    this.verbose = verbose;
    this._onSwept = null;
  }
  onSwept(fn) { this._onSwept = fn; }   // (chatId, chain) => void — reset credit watermark

  async sweep(chatId, chain, index) {
    if (!this.sweepChains.has(chain) || !this.hotWallet) return false;   // e.g. ETH: manual/batch
    try {
      const provider = getProvider(chain);
      const userWallet = this.hd.walletForIndex(index, provider);
      const userAddr = userWallet.address;

      const usdtRaw = await usdtBalanceRaw(chain, userAddr);
      if (usdtRaw <= 0n) return false;

      // 1. Make sure the deposit address has gas for the transfer.
      const fee = await provider.getFeeData();
      const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
      const gasNeeded = (GAS_LIMIT * gasPrice * 12n) / 10n;   // +20% buffer
      const have = await nativeBalance(chain, userAddr);
      if (have < gasNeeded) {
        const topUp = gasNeeded - have;
        const gasWallet = this.hd.gasWallet(provider);
        const gasBal = await provider.getBalance(gasWallet.address);
        if (gasBal < topUp) {
          console.warn(`[billing] sweep ${chain}: gas wallet ${gasWallet.address} low (need ~${ethers.formatEther(topUp)} ${CHAINS[chain].native}) — skipping, retry next cycle`);
          return false;
        }
        const gtx = await gasWallet.sendTransaction({ to: userAddr, value: topUp });
        await gtx.wait();
      }

      // 2. Sweep the full USDT balance → hot wallet.
      const usdt = new ethers.Contract(CHAINS[chain].usdt, ERC20_ABI, userWallet);
      const tx = await usdt.transfer(this.hotWallet, usdtRaw, { gasLimit: GAS_LIMIT });
      await tx.wait();
      console.log(`[billing] swept ${ethers.formatUnits(usdtRaw, CHAINS[chain].decimals)} USDT ${chain} → hot wallet (${tx.hash})`);
      await this._onSwept?.(chatId, chain);
      return true;
    } catch (e) {
      console.warn(`[billing] sweep ${chain} (user ${chatId}) failed: ${e.message} — credit stands, will retry`);
      return false;
    }
  }
}
