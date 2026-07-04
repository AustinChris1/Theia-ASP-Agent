// EVM chain config for the subscription deposit system — USDT only, BSC/ETH/BASE.
// Decimals are HARDCODED (known + reliable): BSC-USD is 18, ETH/BASE USDT are 6.
// Getting these wrong = 10^12× credit errors, so we never trust a remote decimals().
export const CHAINS = {
  bsc: {
    name: 'BSC',
    chainId: 56,
    usdt: '0x55d398326f99059fF775485246999027B3197955',   // BSC-USD (Binance-Peg USDT)
    decimals: 18,
    native: 'BNB',
    rpcs: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed1.bnbchain.org',
      'https://rpc.ankr.com/bsc',
    ],
  },
  base: {
    name: 'Base',
    chainId: 8453,
    usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',   // Tether USD₮ on Base
    decimals: 6,
    native: 'ETH',
    rpcs: [
      'https://base-rpc.publicnode.com',
      'https://mainnet.base.org',
    ],
  },
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',   // Tether USDT (ERC-20)
    decimals: 6,
    native: 'ETH',
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://rpc.ankr.com/eth',
    ],
  },
};

export const CHAIN_KEYS = Object.keys(CHAINS);

// Chains the sweeper auto-consolidates by default. BSC + Base gas is ~$0.01, so
// sweeping is always worth it; ETH gas can exceed a small sub, so ETH is excluded
// (deposits sit until a manual/batch sweep). Override with BILLING_SWEEP_CHAINS.
export const DEFAULT_SWEEP_CHAINS = ['bsc', 'base'];
