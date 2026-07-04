// theia_liqmap — leverage-liquidation heatmap: estimated liquidation clusters
// above and below current price. Backed by LiquidationHeatmap (Coinalyze OI +
// price history), the far-out magnet zones an order book cannot show.
import { config } from '../config.js';
import { ok, err, round, tokenStub, resolveToken, validateInput } from './common.js';

export const name = 'theia_liqmap';
export const title = 'Theia Liquidation Map';
export const description =
  'Estimated liquidation heatmap for a perp: clusters of long liquidations below ' +
  'price and short liquidations above, each with distance %, notional USD, and the ' +
  'dominant leverage tier. Highlights the nearest magnet the price tends to hunt.';
export const priceUsdt = config.x402.prices.theia_liqmap;

export const inputSchema = {
  type: 'object',
  properties: { token: { type: 'string', description: 'Token symbol with a perp market, e.g. BTC, ETH, SOL' } },
  required: ['token'],
};

function clusterStub(c) {
  return {
    price: round(c.price, 8),
    distancePct: round(c.distancePct, 2),
    notionalUsd: round(c.notionalUsd, 0),
    dominantLeverage: c.dominantLev ?? null,
  };
}

function nearest(list) {
  let best = null;
  for (const c of list || []) {
    if (best === null || Math.abs(c.distancePct) < Math.abs(best.distancePct)) best = c;
  }
  return best ? clusterStub(best) : null;
}

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));
  if (!engine.liquidationHeatmap) {
    return err(name, 'data_unavailable', 'Liquidation heatmap is not enabled on this instance (no Coinalyze key).');
  }

  const u = await resolveToken(engine, value.token);
  if (!u) return err(name, 'unresolved_token', `Could not resolve "${value.token}".`);

  let map;
  try {
    map = await engine.liquidationHeatmap.compute(u.symbol);
  } catch (e) {
    return err(name, 'engine_error', `heatmap compute failed: ${e.message}`);
  }
  if (!map) {
    return err(name, 'no_perp_coverage', `No perp/OI coverage for ${u.symbol} to build a liquidation map.`);
  }

  // longLiqs sit BELOW price (longs get liquidated as price drops); shortLiqs ABOVE.
  const below = (map.longLiqs || []).map(clusterStub).sort((a, b) => b.notionalUsd - a.notionalUsd);
  const above = (map.shortLiqs || []).map(clusterStub).sort((a, b) => b.notionalUsd - a.notionalUsd);

  const data = {
    token: tokenStub(u),
    currentPrice: round(map.currentPrice, 8),
    clustersAbove: above,      // short liquidations (upside magnets)
    clustersBelow: below,      // long liquidations (downside magnets)
    totalAboveUsd: round(map.totalShortUsd, 0),
    totalBelowUsd: round(map.totalLongUsd, 0),
    nearestAbove: nearest(map.shortLiqs),
    nearestBelow: nearest(map.longLiqs),
  };
  return ok(name, data);
}

export default { name, title, description, priceUsdt, inputSchema, run };
