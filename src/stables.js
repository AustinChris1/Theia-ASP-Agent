

export const KNOWN_STABLES = new Set([

  'USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'USDS', 'USDP', 'GUSD', 'TUSD',
  'BUSD', 'SUSD', 'LUSD', 'FRAX', 'USDA', 'USDD', 'USDX', 'PYUSD', 'USDB',
  'RLUSD', 'CRVUSD', 'USTC', 'GHO', 'MIM', 'CUSD', 'USDM', 'USDY', 'USR',
  'OUSD', 'SUSDE', 'USDL', 'USD1', 'USDF', 'USDG', 'AUSD', 'USDN', 'XUSD',
  'YUSD', 'USD0', 'USDR', 'DOLA', 'USDV', 'USDK',

  'EURC', 'EURS', 'EURT', 'AEUR', 'EURI', 'EURR'

]);

const STABLE_PATTERNS = [
  /^USD[A-Z0-9]{0,4}$/i,
  /^[A-Z]{1,4}USD$/i,
  /^EUR[A-Z]{0,3}$/i,
  /^GBP[A-Z]{0,3}$/i,
  /^[A-Z]{1,3}EUR$/i
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
