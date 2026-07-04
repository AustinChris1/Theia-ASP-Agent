// asp/skills/common.js — shared helpers for the A2MCP skill adapters.
//
// Adapters are THIN: they resolve the token, call the engine, and shape the
// result into schema-validated JSON. No scoring lives here.
import { config } from '../config.js';

const DISCLAIMER =
  'Analytical data only, not financial advice. Theia scoring is deterministic and auditable; ' +
  'no LLM decides trades. Verify on-chain facts independently before acting.';

export { DISCLAIMER };

/** Round to n decimals, returning a Number (or null for non-finite). */
export function round(x, n = 2) {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return null;
  const f = 10 ** n;
  return Math.round(Number(x) * f) / f;
}

/** A monotonic-ish ISO timestamp. (Date.now is fine in the server runtime.) */
export function nowIso() { return new Date().toISOString(); }

/**
 * Resolve a user-supplied token symbol to a full universe entry.
 * Handles on-demand tokens outside the tracked set via universe.ensureBySymbol.
 * @returns {Promise<object|null>} universe entry, or null if unrecognized.
 */
export async function resolveToken(engine, symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const u = engine.universe;
  if (!u) return null;
  // Fast path: symbol already in the tracked universe.
  try {
    for (const cgId of u.allCgIds?.() || []) {
      const info = u.lookupByCgId(cgId);
      if (info && String(info.symbol || '').toUpperCase() === sym) return info;
    }
  } catch { /* fall through to on-demand */ }
  // On-demand: resolve any recognized token one-time (not pinned/persisted).
  try {
    const t = await u.ensureBySymbol?.(sym);
    if (t?.coingeckoId) return u.lookupByCgId(t.coingeckoId) || t;
  } catch { /* unrecognized */ }
  return null;
}

/**
 * Minimal input validator against a tiny JSON-schema subset ({type, properties,
 * required}). Avoids an external dependency. Returns { ok, value, errors }.
 * Coerces the canonical `token` param from several aliases.
 */
export function validateInput(schema, params) {
  const errors = [];
  const value = { ...(params || {}) };
  // Accept common aliases for the primary token argument.
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

/** Standard success envelope shared by every skill. */
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

/** Standard error envelope (used for bad input or unavailable data). */
export function err(skill, code, message, meta = {}) {
  return { ok: false, skill, provider: config.server.name, generatedAt: nowIso(), error: { code, message }, meta };
}

/** Compact a universe entry to the public token stub. */
export function tokenStub(info) {
  if (!info) return null;
  return {
    symbol: info.symbol,
    name: info.name ?? null,
    coingeckoId: info.coingeckoId ?? null,
    marketCap: round(info.marketCap, 0),
  };
}
