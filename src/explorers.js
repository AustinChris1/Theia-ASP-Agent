// Centralized block-explorer transaction links.
//
// Was duplicated in telegram.js (as functions) and index.js (as string
// prefixes) with divergent shapes (audit §4). Single source of truth here.

const TX_BASE = {
  ethereum: 'https://etherscan.io/tx/',
  bsc:      'https://bscscan.com/tx/',
  base:     'https://basescan.org/tx/',
  solana:   'https://solscan.io/tx/'
};

// Build a transaction explorer URL for `chain` (falls back to Etherscan for
// unknown chains, matching the prior behaviour in both call sites).
export function explorerTxUrl(chain, hash) {
  return `${TX_BASE[chain] ?? TX_BASE.ethereum}${hash}`;
}
