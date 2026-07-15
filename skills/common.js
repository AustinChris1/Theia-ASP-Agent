
import { config } from '../config.js';

const DISCLAIMER =
  'Analytical data only, not financial advice. Theia scoring is deterministic and auditable; ' +
  'no LLM decides trades. Verify on-chain facts independently before acting.';

export { DISCLAIMER };

export function round(x, n = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return null;
  const f = 10 ** n;
  return Math.round(Number(x) * f) / f;
}

export function nowIso() { return new Date().toISOString(); }

export async function resolveToken(engine, symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const u = engine.universe;
  if (!u) return null;
  try {
    for (const cgId of u.allCgIds?.() || []) {
      const info = u.lookupByCgId(cgId);
      if (info && String(info.symbol || '').toUpperCase() === sym) return info;
    }
  } catch {  }
  try {
    const t = await u.ensureBySymbol?.(sym);
    if (t?.coingeckoId) return u.lookupByCgId(t.coingeckoId) || t;
  } catch {  }
  return null;
}

export function validateInput(schema, params) {
  const errors = [];
  const value = { ...(params || {}) };
  if (value.token == null) {
    value.token = value.symbol ?? value.ticker ?? value.token_or_exchange ?? value.query ?? null;
  }
  const props = schema?.properties || {};
  const required = schema?.required || [];
  for (const key of required) {
    if (value[key] === null || value[key] === undefined || value[key] === '') {
      errors.push(`missing required field: ${key}`);
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = value[key];
    if (v === null || v === undefined || v === '') continue;
    if (spec.type === 'string' && typeof v !== 'string') errors.push(`${key} must be a string`);
    if (spec.type === 'number' && !Number.isFinite(Number(v))) errors.push(`${key} must be a number`);
    if (spec.enum && !spec.enum.includes(v)) errors.push(`${key} must be one of: ${spec.enum.join(', ')}`);
  }
  return { ok: errors.length === 0, value, errors };
}

export function ok(skill, data, meta = {}) {
  return {
    ok: true,
    skill,
    provider: config.server.name,
    generatedAt: nowIso(),
    data,
    meta: { deterministic: true, ...meta },
    disclaimer: DISCLAIMER,
  };
}

export function err(skill, code, message, meta = {}) {
  return { ok: false, skill, provider: config.server.name, generatedAt: nowIso(), error: { code, message }, meta };
}

export function tokenStub(info) {
  if (!info) return null;
  return {
    symbol: info.symbol,
    name: info.name ?? null,
    coingeckoId: info.coingeckoId ?? null,
    marketCap: round(info.marketCap, 0),
  };
}
