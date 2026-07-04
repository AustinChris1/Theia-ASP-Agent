// Shared CoinGecko helpers. Centralises the API key handling so all three
// monitors (universe, prices, funding) authenticate consistently.
//
// To use, sign up for a free Demo API key at https://www.coingecko.com/en/api/pricing
// (Demo tier: 30 calls/min, 10k/month). Set COINGECKO_API_KEY in .env.

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export function cgHeaders() {
  const headers = { accept: 'application/json' };
  const key = process.env.COINGECKO_API_KEY;
  if (key) headers['x-cg-demo-api-key'] = key;
  return headers;
}

// Search the public CoinGecko index by free-form query (symbol or name).
// Returns up to `limit` coins, lightly normalized: { id, symbol, name, rank }.
// `rank` is market_cap_rank (lower = bigger); used to sort multiple matches.
export async function cgSearch(query, limit = 6) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, {
      headers: cgHeaders(),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      console.warn(`[cg-search] HTTP ${res.status} for "${q}"`);
      return [];
    }
    const json = await res.json();
    const coins = Array.isArray(json?.coins) ? json.coins : [];
    return coins
      .map(c => ({
        id: c.id,
        symbol: (c.symbol ?? '').toUpperCase(),
        name: c.name,
        rank: c.market_cap_rank ?? null
      }))
      .sort((a, b) => {
        // Rank-aware sort: ranked tokens first (lowest rank wins), then unranked
        if (a.rank == null && b.rank == null) return 0;
        if (a.rank == null) return 1;
        if (b.rank == null) return -1;
        return a.rank - b.rank;
      })
      .slice(0, limit);
  } catch (err) {
    console.warn(`[cg-search] failed for "${q}": ${err.message}`);
    return [];
  }
}
