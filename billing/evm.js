// Shared EVM layer — provider failover + USDT/native reads + transfer primitives.
// Used by both the deposit watcher (reads) and the sweeper (writes).
import { ethers } from 'ethers';
import { CHAINS } from './chains.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const state = {};   // chain → { idx, provider }

function make(chain, idx) {
  const { rpcs, chainId } = CHAINS[chain];
  const url = rpcs[idx % rpcs.length];
  // Pass an EXPLICIT static network so ethers NEVER runs eth_chainId detection.
  // With `staticNetwork: true` (or no network) ethers still does the FIRST detect,
  // and when an RPC is slow/unreachable it falls into a perpetual "failed to detect
  // network, retry in 1s" background loop — and rotateProvider() spawns a fresh
  // looping provider on each failure, so the log flood compounds. Giving it the
  // known chainId up front removes the detection step entirely: a dead RPC now just
  // throws on the call (caught by withProvider → rotate), with no retry storm.
  const net = ethers.Network.from(chainId);
  return new ethers.JsonRpcProvider(url, net, { staticNetwork: net, batchMaxCount: 1 });
}

export function getProvider(chain) {
  if (!CHAINS[chain]) throw new Error(`billing: unknown chain ${chain}`);
  if (!state[chain]) state[chain] = { idx: 0, provider: make(chain, 0) };
  return state[chain].provider;
}

export function rotateProvider(chain) {
  const st = state[chain] ?? { idx: 0 };
  st.idx = (st.idx + 1) % CHAINS[chain].rpcs.length;
  st.provider = make(chain, st.idx);
  state[chain] = st;
  return st.provider;
}

// Run fn against a chain's provider; on failure rotate RPC and retry.
export async function withProvider(chain, fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(getProvider(chain)); }
    catch (e) { lastErr = e; rotateProvider(chain); }
  }
  throw lastErr;
}

// USDT balance in HUMAN units (Number) using the chain's HARDCODED decimals.
export async function usdtBalance(chain, address) {
  const { usdt, decimals } = CHAINS[chain];
  return withProvider(chain, async (p) => {
    const raw = await new ethers.Contract(usdt, ERC20_ABI, p).balanceOf(address);
    return Number(ethers.formatUnits(raw, decimals));
  });
}

// Raw USDT balance (bigint) — for exact full-balance sweeps.
export async function usdtBalanceRaw(chain, address) {
  const { usdt } = CHAINS[chain];
  return withProvider(chain, (p) => new ethers.Contract(usdt, ERC20_ABI, p).balanceOf(address));
}

export async function nativeBalance(chain, address) {
  return withProvider(chain, (p) => p.getBalance(address));
}
