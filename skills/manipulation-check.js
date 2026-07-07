// theia_manipulation_check — NOX manipulation risk %. Mirrors conductor.#assessManipulation's
// live-data gathering, then calls the pure assessManipulation + assessPumpRegime exports.
import { assessManipulation, assessPumpRegime } from '../src/conductor.js';
import { config } from '../config.js';
import { ok, err, round, tokenStub, resolveToken, validateInput } from './common.js';

export const name = 'theia_manipulation_check';
export const title = 'Theia Manipulation Check';
export const description =
  'Low-cap pump-and-dump / wash-trade risk read for a token. Scores four tells ' +
  '(futures>>spot leverage, 24h volume vs market cap, thin circulating float, ' +
  'top-holder concentration) into a 0-100% manipulation-risk figure with flags.';
export const priceUsdt = config.x402.prices.theia_manipulation_check;

export const inputSchema = {
  type: 'object',
  properties: { token: { type: 'string', description: 'Token symbol, e.g. PEPE, WIF' } },
  required: ['token'],
};

function riskLevel(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'elevated';
  if (score >= 0.2) return 'moderate';
  return 'low';
}

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));

  const u = await resolveToken(engine, value.token);
  if (!u) return err(name, 'unresolved_token', `Could not resolve "${value.token}".`);

  const cgId = u.coingeckoId;
  const circ = u.circulatingSupply;
  const total = u.totalSupply;
  const floatPct = (circ > 0 && total > 0) ? circ / total : null;

  const inputs = {
    futuresVol: engine.prices?.getFuturesVolume?.(cgId) ?? null,
    spotVol: engine.prices?.getSpotVolume?.(cgId) ?? null,
    volume: engine.prices?.get24hVolume?.(cgId) ?? null,
    marketCap: u.marketCap ?? null,
    floatPct,
    concentrationPct: engine.teamDiscovery?.getConcentration?.(u.symbol)?.top10Pct ?? null,
  };

  const manip = assessManipulation(inputs);
  const pump = assessPumpRegime({ manipFlags: manip.flags }, config.engine.pumpRegimeMinLegs ?? 3);

  const data = {
    token: tokenStub(u),
    riskScore: manip.score,
    riskPct: round(manip.score * 100, 0),
    riskLevel: riskLevel(manip.score),
    flags: manip.flags,
    pumpRegime: pump.isRegime,
    pumpLegs: pump.legs,
    measured: {
      futuresToSpotRatio: (inputs.futuresVol > 0 && inputs.spotVol > 0) ? round(inputs.futuresVol / inputs.spotVol, 2) : null,
      volumeToMarketCap: (inputs.volume > 0 && inputs.marketCap > 0) ? round(inputs.volume / inputs.marketCap, 2) : null,
      circulatingFloatPct: floatPct != null ? round(floatPct * 100, 1) : null,
      top10ConcentrationPct: inputs.concentrationPct != null ? round(inputs.concentrationPct, 1) : null,
    },
    coverage: coverageNote(inputs),
  };
  return ok(name, data);
}

// Missing inputs simply do not score; report which legs had data.
function coverageNote(inputs) {
  const have = [];
  const missing = [];
  (inputs.futuresVol > 0 && inputs.spotVol > 0 ? have : missing).push('futures/spot volume');
  (inputs.volume > 0 && inputs.marketCap > 0 ? have : missing).push('volume/market-cap');
  (inputs.floatPct != null ? have : missing).push('float');
  (inputs.concentrationPct != null ? have : missing).push('holder concentration');
  return { measured: have, unavailable: missing };
}

export default { name, title, description, priceUsdt, inputSchema, run };
