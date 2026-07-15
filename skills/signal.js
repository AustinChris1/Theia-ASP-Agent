
import { config } from '../config.js';
import { ok, err, round, tokenStub, validateInput } from './common.js';

export const name = 'theia_signal';
export const title = 'Theia Signal';
export const description =
  'Full confluence-scored trade read for a token: directional side, strength tier, ' +
  'confidence, the scored reasons behind it, and a complete trade plan (entry, stop, ' +
  'TP1-3 with R multiples, suggested leverage, horizon). Deterministic; no LLM decides.';
export const priceUsdt = config.x402.prices.theia_signal;

export const inputSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'Token symbol, e.g. BTC, SOL, PEPE' },
    side: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Optional bias; Theia still returns its highest-conviction side and both side scores' },
  },
  required: ['token'],
};

function planStub(p) {
  if (!p) return null;
  return {
    entry: round(p.entry, 8),
    stopLoss: round(p.sl, 8),
    tp1: round(p.tp1, 8),
    tp2: round(p.tp2, 8),
    tp3: round(p.tp3, 8),
    stopLossPct: round(p.slPct, 2),
    rr1: round(p.rr1, 2),
    rr2: round(p.rr2, 2),
    rr3: round(p.rr3, 2),
    suggestedLeverage: round(p.suggestedLeverage, 1),
    maxLeverage: round(p.maxLeverage, 1),
    horizon: p.horizon ?? null,
    validityHours: round(p.validityHrs, 1),
    isLiquidityGrab: !!p.isLiquidityGrab,
    limitEntry: round(p.limitEntry, 8),
  };
}

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));

  let analysis;
  try {
    analysis = await engine.analyze(value.token, { holdings: null });
  } catch (e) {
    return err(name, 'engine_error', `analysis failed: ${e.message}`);
  }
  if (!analysis) {
    return err(name, 'unresolved_token', `Could not resolve or analyze "${value.token}". Stablecoins and unlisted tokens are not analyzed.`);
  }

  const strength = analysis.strength || {};
  const data = {
    token: tokenStub(analysis.token),
    side: analysis.side,
    tier: strength.label ?? null,
    confidence: round(strength.confidence, 0),
    score: round(analysis.score, 2),
    lowConviction: !!analysis.lowConviction,
    sideScores: analysis.sideScores ?? null,
    manipulationRegime: !!analysis.manipulationRegime,
    currentPrice: round(analysis.currentPrice, 8),
    reasons: (analysis.reasons || []).map((r) => ({ kind: r.kind, text: r.text, points: round(r.points, 2) })),
    tradePlan: planStub(analysis.tradePlan),
    requestedSide: value.side ?? null,
  };
  return ok(name, data, { dataSources: dataSourceTags(engine) });
}

function dataSourceTags(engine) {
  const s = engine.status || {};
  const tags = [];
  if (s.ta) tags.push('multi-tf-ta');
  if (s.funding) tags.push(`funding:${s.funding}`);
  if (s.heatmap) tags.push('liq-heatmap');
  if (s.clusters) tags.push('orderbook-clusters');
  if (s.teamDiscovery) tags.push('insider-holders');
  return tags;
}

export default { name, title, description, priceUsdt, inputSchema, run };
