

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

export function cgHeaders() {
  const headers = { accept: 'application/json' };
  const key = process.env.COINGECKO_API_KEY;
  if (key) headers['x-cg-demo-api-key'] = key;
  return headers;
}

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
