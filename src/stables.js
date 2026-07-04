// Stablecoin detection — single source of truth, used by PriceMonitor (skip
// surges), Conductor (skip flow / funding / movers signals), and anywhere
// else that should not be trading USD/EUR-pegged tokens.
//
// USD1 was the trigger: it kept firing signals on 0.03% peg wobbles. The
// helper combines an explicit list (high-confidence) with regex patterns
// that catch newly-launched stable variants automatically (USD2, USDX, etc.).

export const KNOWN_STABLES = new Set([
  // USD-pegged
  'USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'USDS', 'USDP', 'GUSD', 'TUSD',
  'BUSD', 'SUSD', 'LUSD', 'FRAX', 'USDA', 'USDD', 'USDX', 'PYUSD', 'USDB',
  'RLUSD', 'CRVUSD', 'USTC', 'GHO', 'MIM', 'CUSD', 'USDM', 'USDY', 'USR',
  'OUSD', 'SUSDE', 'USDL', 'USD1', 'USDF', 'USDG', 'AUSD', 'USDN', 'XUSD',
  'YUSD', 'USD0', 'USDR', 'DOLA', 'USDV', 'USDK',
  // EUR / GBP / other-fiat pegged
  'EURC', 'EURS', 'EURT', 'AEUR', 'EURI', 'EURR'
  // Note: XAUT and PAXG are gold-pegged and CAN move 5%+ daily — do NOT add.
  // Note: stETH/wstETH/cbETH etc. track ETH price, not a peg — do NOT add.
]);

// Pattern fallback for stables not in the explicit list above. Combined with
// the list, this catches both well-known and newly-launched USD/EUR variants.
const STABLE_PATTERNS = [
  /^USD[A-Z0-9]{0,4}$/i,        // USDT, USDC, USDe, USD1, USDC.e short forms
  /^[A-Z]{1,4}USD$/i,            // dUSD, sUSD, GHOUSD, etc.
  /^EUR[A-Z]{0,3}$/i,            // EURC, EURT, EURI
  /^GBP[A-Z]{0,3}$/i,            // GBP-pegged variants
  /^[A-Z]{1,3}EUR$/i             // wrapped EUR variants
];

export function isStableSymbol(symbol) {
  if (!symbol) return false;
  const s = String(symbol).toUpperCase();
  if (KNOWN_STABLES.has(s)) return true;
  for (const rx of STABLE_PATTERNS) {
    if (rx.test(s)) return true;
  }
  return false;
}
