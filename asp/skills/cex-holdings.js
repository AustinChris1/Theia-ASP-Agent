// theia_cex_holdings — exchange cold-wallet concentration ("cornered float").
// Two modes: a TOKEN (how much of its supply sits in CEX cold storage, per
// exchange) or an EXCHANGE (its most-cornered tokens by % of supply held).
// Backed by CexHoldings (on-chain Multicall reads of known cold wallets).
import { config } from '../config.js';
import { ok, err, round, tokenStub, resolveToken, validateInput } from './common.js';

export const name = 'theia_cex_holdings';
export const title = 'Theia CEX Holdings';
export const description =
  'Exchange cold-wallet concentration (cornered float). Pass a token symbol to see ' +
  'how much of its circulating supply sits in CEX cold storage; pass an exchange ' +
  'name to see the tokens it holds the largest share of. On-chain, ETH + BSC.';
export const priceUsdt = config.x402.prices.theia_cex_holdings;

export const inputSchema = {
  type: 'object',
  properties: { token: { type: 'string', description: 'A token symbol (e.g. ARB) OR an exchange name (e.g. binance, okx)' } },
  required: ['token'],
};

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));
  if (!engine.cexHoldings) {
    return err(name, 'data_unavailable', 'CEX holdings module is not available on this instance.');
  }
  const query = String(value.token).trim();

  // Exchange mode: does the query match an exchange in the cornered-float leaderboard?
  const lb = engine.cexHoldings.getLeaderboard?.();
  if (lb?.byExchange) {
    const match = Object.keys(lb.byExchange).find((ex) => ex.toLowerCase() === query.toLowerCase());
    if (match) {
      const rows = (lb.byExchange[match] || []).map((r) => ({
        symbol: r.symbol,
        pctOfSupply: round(r.pctSupply, 2),
        amount: round(r.amount, 2),
        usd: round(r.usd, 0),
      }));
      return ok(name, {
        mode: 'exchange',
        exchange: match,
        computedAt: lb.computedAt ? new Date(lb.computedAt).toISOString() : null,
        corneredTokens: rows,
      });
    }
  }

  // Token mode: snapshot cold-wallet custody for the token.
  const u = await resolveToken(engine, query);
  if (!u) {
    return err(name, 'unresolved_token',
      `"${query}" is neither a recognized token nor a known exchange in the current leaderboard.`);
  }
  const price = engine.prices?.getPrice?.(u.coingeckoId) ?? null;
  let snap;
  try {
    snap = await engine.cexHoldings.snapshot({
      tokenInfo: u,
      price,
      circulatingSupply: u.circulatingSupply,
    });
  } catch (e) {
    return err(name, 'engine_error', `snapshot failed: ${e.message}`);
  }

  const perWallet = [...(snap.ethereum || []).map((e) => ({ ...e, chain: 'ethereum' })),
                     ...(snap.bsc || []).map((e) => ({ ...e, chain: 'bsc' }))]
    .map((e) => ({ exchange: e.exchange ?? e.name ?? null, chain: e.chain, address: e.address ?? null, balance: round(e.balance, 4) }))
    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

  const data = {
    mode: 'token',
    token: tokenStub(u),
    totalInColdStorage: round(snap.totalBalance, 4),
    totalUsd: round(snap.totalUsd, 0),
    pctOfSupplyInColdStorage: round(snap.pctOfSupply, 3),
    coldWallets: perWallet.slice(0, 25),
    coverage: perWallet.length ? 'eth+bsc cold wallets' : 'no ETH/BSC contract mapping for this token',
  };
  return ok(name, data);
}

export default { name, title, description, priceUsdt, inputSchema, run };
