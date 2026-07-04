// theia_cex_flow — direction and materiality of supply moving in/out of CEX cold
// custody for a token. On-demand: snapshots current cold-wallet custody and diffs
// it against the last snapshot this ASP took, so repeated calls reveal net
// deposit (bearish, supply staged to sell) vs withdrawal (bullish, supply leaving
// exchanges). Materiality is measured against market cap.
//
// Backed by CexHoldings. The first call establishes a baseline; the direction
// field is populated from the second call onward. Continuous, sub-minute net-flow
// streaming is delivered by the A2A "Deep Desk" managed tier.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { ok, err, round, tokenStub, resolveToken, validateInput } from './common.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../.cache/cexflow');

export const name = 'theia_cex_flow';
export const title = 'Theia CEX Flow';
export const description =
  'Direction and materiality of supply moving into or out of exchange cold custody ' +
  'for a token. Net deposits flag pre-distribution staging (bearish); net withdrawals ' +
  'flag supply leaving exchanges (bullish). Materiality is scored against market cap.';
export const priceUsdt = config.x402.prices.theia_cex_flow;

export const inputSchema = {
  type: 'object',
  properties: { token: { type: 'string', description: 'Token symbol, e.g. ARB, LINK' } },
  required: ['token'],
};

function priorPath(cgId) { return resolve(CACHE_DIR, `${String(cgId).replace(/[^a-z0-9_-]/gi, '_')}.json`); }
function readPrior(cgId) {
  try { return JSON.parse(readFileSync(priorPath(cgId), 'utf8')); } catch { return null; }
}
function writePrior(cgId, snap) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(priorPath(cgId), JSON.stringify(snap));
  } catch { /* cache is best-effort */ }
}

export async function run(params, engine) {
  const { ok: valid, value, errors } = validateInput(inputSchema, params);
  if (!valid) return err(name, 'bad_request', errors.join('; '));
  if (!engine.cexHoldings) {
    return err(name, 'data_unavailable', 'CEX holdings module is not available on this instance.');
  }

  const u = await resolveToken(engine, value.token);
  if (!u) return err(name, 'unresolved_token', `Could not resolve "${value.token}".`);

  const price = engine.prices?.getPrice?.(u.coingeckoId) ?? null;
  let snap;
  try {
    snap = await engine.cexHoldings.snapshot({ tokenInfo: u, price, circulatingSupply: u.circulatingSupply });
  } catch (e) {
    return err(name, 'engine_error', `snapshot failed: ${e.message}`);
  }
  if (!(snap.totalBalance > 0)) {
    return err(name, 'no_cex_custody',
      `No measurable ETH/BSC cold-wallet custody for ${u.symbol} (no contract mapping or zero balance).`);
  }

  const nowTs = Date.now();
  const prior = readPrior(u.coingeckoId);
  writePrior(u.coingeckoId, { ts: nowTs, totalBalance: snap.totalBalance, price });

  let flow = null;
  if (prior && Number.isFinite(prior.totalBalance)) {
    const deltaBalance = snap.totalBalance - prior.totalBalance;
    const deltaUsd = price ? deltaBalance * price : null;
    const mcap = u.marketCap ?? null;
    const materialityPct = (deltaUsd != null && mcap > 0) ? Math.abs(deltaUsd) / mcap * 100 : null;
    let direction = 'flat';
    // 0.05% of custody = noise floor to avoid flapping on read jitter.
    const noise = Math.max(1, prior.totalBalance * 0.0005);
    if (deltaBalance > noise) direction = 'deposit';        // supply INTO exchanges (bearish staging)
    else if (deltaBalance < -noise) direction = 'withdrawal'; // supply OUT of exchanges (bullish)
    flow = {
      sincePriorAt: new Date(prior.ts).toISOString(),
      windowMinutes: round((nowTs - prior.ts) / 60000, 1),
      direction,
      bias: direction === 'deposit' ? 'bearish' : direction === 'withdrawal' ? 'bullish' : 'neutral',
      deltaBalance: round(deltaBalance, 4),
      deltaUsd: round(deltaUsd, 0),
      materialityPctOfMcap: round(materialityPct, 4),
    };
  }

  const data = {
    token: tokenStub(u),
    custody: {
      totalInColdStorage: round(snap.totalBalance, 4),
      totalUsd: round(snap.totalUsd, 0),
      pctOfSupply: round(snap.pctOfSupply, 3),
    },
    flow,
    note: flow
      ? 'Direction is the net change in exchange cold custody since this ASP last measured this token.'
      : 'Baseline snapshot recorded. Call again to measure net flow direction. Streaming net-flow is available via the A2A Deep Desk tier.',
  };
  return ok(name, data);
}

export default { name, title, description, priceUsdt, inputSchema, run };
