// theia_insider_scan — largest non-exchange (insider/team) holders and recent
// distribution for a token. Backed by TeamWalletDiscovery (Moralis + scrape),
// which infra-filters CEX / burn / bridge addresses.
import { config } from '../config.js';
import { ok, err, round, tokenStub, resolveToken, validateInput } from './common.js';

export const name = 'theia_insider_scan';
export const title = 'Theia Insider Scan';
export const description =
  'Largest non-exchange (insider / team) holders of a token across ETH and BSC, ' +
  'ranked by percent of supply, plus top-10 holder concentration. Exchange, burn, ' +
  'and bridge addresses are filtered out so only real insider custody is shown.';
export const priceUsdt = config.x402.prices.theia_insider_scan;

export const inputSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'Token symbol, e.g. ARB, ENA' },
    limit: { type: 'number', description: 'Max holders to return (default 15)' },
  },
  required: ['token'],
};

function holderStub(h, chain) {
  return {
    address: h.address ?? h.wallet ?? null,
    chain: h.chain ?? chain ?? null,
    percentOfSupply: round(h.percent ?? h.pct ?? h.percentOfSupply, 3),
    label: h.label ?? h.name ?? null,
    balance: round(h.balance ?? h.amount, 4),
  };
}

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));
  if (!engine.teamDiscovery) {
    return err(name, 'data_unavailable', 'Insider discovery is not enabled on this instance (no Moralis key / disabled).');
  }

  const u = await resolveToken(engine, value.token);
  if (!u) return err(name, 'unresolved_token', `Could not resolve "${value.token}".`);

  const res = engine.teamDiscovery.holdersForSymbol(u.symbol);
  if (!res) {
    return err(name, 'not_discovered',
      `No insider-holder data for ${u.symbol} yet. Discovery targets favored/hot tokens; it may not be covered or is still warming.`);
  }

  const limit = Number(value.limit) > 0 ? Math.min(Number(value.limit), 50) : 15;
  const holders = [];
  for (const t of res.tokens || []) {
    for (const h of t.holders || []) holders.push(holderStub(h, t.chain));
  }
  holders.sort((a, b) => (b.percentOfSupply ?? 0) - (a.percentOfSupply ?? 0));

  const data = {
    token: tokenStub(u),
    concentrationTop10Pct: round(res.concentration?.top10Pct, 1),
    holderCount: res.concentration?.holderCount ?? null,
    insiderHolders: holders.slice(0, limit),
    chainsCovered: (res.tokens || []).map((t) => t.chain),
    lastDiscoveredAt: (res.tokens || [])[0]?.ts ? new Date((res.tokens || [])[0].ts).toISOString() : null,
  };
  return ok(name, data);
}

export default { name, title, description, priceUsdt, inputSchema, run };
