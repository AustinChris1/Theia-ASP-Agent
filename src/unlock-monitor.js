// Token-unlock monitor.
//
// Large scheduled token unlocks (vesting cliffs) flood circulating supply and
// usually mean sell pressure — a dump into / around the unlock date. This
// monitor watches a curated set of high-vesting protocols on DeFiLlama's free
// emissions dataset, finds upcoming CLIFF unlocks (discrete dumps, not the slow
// linear drip), and emits an 'unlock' event a week out and a day out for any
// that clear the "major" bar (≥5% of circulating supply OR ≥$25M by default).
//
// Data: https://defillama-datasets.llama.fi/emissions/<slug>  (public, keyless,
// not geo-blocked from Render). The slug list is validated against
// .../emissionsProtocolsList on each refresh so a stale/renamed slug is logged,
// not silently dropped. Schedules change rarely, so we refetch every 12h and
// just re-scan the cached schedule against the lead windows each poll.

import { EventEmitter } from 'node:events';
import { dbEnabled, kvGet, kvSet } from './db.js';

const UNLOCK_DB_NS = 'unlocks', UNLOCK_DB_KEY = 'fired';
const DATASET_BASE = 'https://defillama-datasets.llama.fi/emissions';
const PROTOCOL_LIST_URL = 'https://defillama-datasets.llama.fi/emissionsProtocolsList';
const FETCH_TIMEOUT_MS = 15_000;
const HOUR = 60 * 60_000, DAY = 24 * HOUR;

// Curated default set — vesting-heavy 2023+ tokens (the manipulable cohort).
// Every slug here was validated to exist in emissionsProtocolsList. Override
// with UNLOCK_PROTOCOLS (comma-separated DeFiLlama slugs).
export const DEFAULT_UNLOCK_PROTOCOLS = [
  'arbitrum', 'optimism-foundation', 'aptos', 'sui-foundation', 'sei', 'celestia',
  'jito', 'jupiter', 'pyth', 'ethena', 'immutablex', 'dydx', 'blur', 'worldcoin',
  'aethir', 'ens', 'altlayer', 'manta-pacific', 'zksync-era', 'layerzero',
  'ondo-finance', 'grass', 'movement', 'saga', 'omni-network', 'renzo', 'kamino', 'tensor',
];

// Warn a week out and a day out. (No "now" fire — a cliff timestamp isn't a
// to-the-minute market event the way an FOMC print is; the heads-up is the value.)
export const DEFAULT_UNLOCK_LEADS = [
  { label: '7d', ms: 7 * DAY },
  { label: '1d', ms: DAY },
];

// Pure: circulating (total unlocked) supply at time `tsSec`, summed across all
// documented categories. Each category's `unlocked` is cumulative, so we take
// the latest point at or before tsSec. null if no documented data.
export function circulatingAt(documentedData, tsSec) {
  const cats = documentedData?.data;
  if (!Array.isArray(cats) || !cats.length) return null;
  let sum = 0, any = false;
  for (const c of cats) {
    const pts = c?.data;
    if (!Array.isArray(pts) || !pts.length) continue;
    let val = 0;
    for (const p of pts) { if (p.timestamp <= tsSec) val = p.unlocked; else break; }
    sum += (val || 0); any = true;
  }
  return any ? sum : null;
}

// Pure: parse a DeFiLlama emission doc into upcoming CLIFF unlock events within
// [now, now+horizon]. Returns { symbol, geckoId, name, maxSupply, events:[...] }
// where each event has tsMs, tokens, circAtEvent, pctOfCirc, pctOfMax, recipients.
export function parseUnlockSchedule(j, { nowMs, horizonMs }) {
  if (!j || typeof j !== 'object') return null;
  const meta = j.metadata || {};
  // NOTE: meta.token is a CHAIN:address / COINGECKO:id identifier (e.g.
  // "ARBITRUM:0x912…", "COINGECKO:APTOS"), NOT a display ticker. Only accept it
  // as a symbol when it's a bare ticker; otherwise leave null and let the
  // monitor resolve the real ticker via gecko_id → universe.
  const raw = meta.token || j.token || null;
  let symbol = null;
  if (raw && !String(raw).includes(':')) {
    const cand = String(raw).toUpperCase().replace(/^\$/, '');
    if (/^[A-Z0-9]{2,12}$/.test(cand)) symbol = cand;
  }
  const geckoId = j.gecko_id || null;
  const maxSupply = (typeof j.supplyMetrics?.maxSupply === 'number') ? j.supplyMetrics.maxSupply : null;
  const out = { symbol, tokenRaw: raw, geckoId, name: j.name || null, maxSupply, events: [] };
  const evs = Array.isArray(meta.unlockEvents) ? meta.unlockEvents : [];
  const nowSec = nowMs / 1000, horizonSec = (nowMs + horizonMs) / 1000;
  for (const e of evs) {
    const tsSec = e.timestamp;
    if (typeof tsSec !== 'number' || tsSec < nowSec || tsSec > horizonSec) continue;
    const cliffs = Array.isArray(e.cliffAllocations) ? e.cliffAllocations : [];
    if (!cliffs.length) continue;                                   // cliffs only — ignore linear drip
    const tokens = (typeof e.summary?.totalTokensCliff === 'number')
      ? e.summary.totalTokensCliff
      : cliffs.reduce((s, c) => s + (c.amount || 0), 0);
    if (!(tokens > 0)) continue;
    const circ = circulatingAt(j.documentedData, tsSec);
    const recipients = cliffs.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, 3).map(c => ({ recipient: c.recipient, category: c.category, amount: c.amount }));
    out.events.push({
      tsMs: tsSec * 1000, tokens, circAtEvent: circ,
      pctOfCirc: (circ && circ > 0) ? tokens / circ : null,
      pctOfMax: (maxSupply && maxSupply > 0) ? tokens / maxSupply : null,
      recipients,
    });
  }
  out.events.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

// Pure: is an unlock "major"? USD = tokens × price (if price known). Big-% of
// circulating OR big-$ qualifies. Returns the computed usd/pct for display too.
export function isMajorUnlock(ev, price, { minPct, minUsd }) {
  const usd = (typeof price === 'number' && price > 0) ? ev.tokens * price : null;
  const pct = ev.pctOfCirc ?? ev.pctOfMax ?? null;
  return { major: (pct != null && pct >= minPct) || (usd != null && usd >= minUsd), usd, pct };
}

// Pure: lead-window fires (mirror of dueMacroFires — pre-event windows only).
export function dueUnlockFires(items, nowMs, leads, fired) {
  const out = [];
  for (const it of items) {
    for (const lead of leads) {
      const key = `${it.id}:${lead.label}`;
      if (fired.has(key)) continue;
      if (nowMs >= it.tsMs - lead.ms && nowMs < it.tsMs) out.push({ item: it, lead, key });
    }
  }
  return out;
}

export class UnlockMonitor extends EventEmitter {
  constructor({ protocols = DEFAULT_UNLOCK_PROTOCOLS, refreshIntervalMs = 12 * HOUR,
                pollIntervalMs = 30 * 60_000, horizonMs = 14 * DAY, leads = DEFAULT_UNLOCK_LEADS,
                minPct = 0.05, minUsd = 25_000_000, universe = null, prices = null, verbose = false } = {}) {
    super();
    this.protocols = protocols;
    this.refreshIntervalMs = refreshIntervalMs;
    this.pollIntervalMs = pollIntervalMs;
    this.horizonMs = horizonMs;
    this.leads = leads;
    this.minPct = minPct;
    this.minUsd = minUsd;
    this.universe = universe;     // to map geckoId → tracked token (symbol, marketCap, circ)
    this.prices = prices;         // PriceMonitor — live price for the USD figure
    this.verbose = verbose;
    this.schedules = [];          // [{ symbol, geckoId, events:[...] }]
    this.fired = new Set();       // `${geckoId|slug}:${tsMs}:${label}`
    this.pollId = null; this.refreshId = null;
  }

  async #loadFired() {
    if (!dbEnabled()) return;
    try {
      const arr = await kvGet(UNLOCK_DB_NS, UNLOCK_DB_KEY);
      if (Array.isArray(arr)) for (const k of arr) this.fired.add(k);
    } catch (err) { console.warn(`[unlocks] fired-set load failed: ${err.message}`); }
  }

  #saveFired() {
    const arr = [...this.fired].slice(-1000);
    if (dbEnabled()) kvSet(UNLOCK_DB_NS, UNLOCK_DB_KEY, arr).catch(err => console.warn(`[unlocks] fired-set save failed: ${err.message}`));
  }

  // Resolve the display ticker for a parsed schedule: gecko_id → universe symbol
  // (the real ARB/APT/SUI), else a bare-ticker symbol, else the protocol name.
  // `ticker` is null when no tradeable symbol is known (→ no broken chart link).
  #resolve(sched) {
    const tok = sched.geckoId ? this.universe?.lookupByCgId?.(sched.geckoId) : null;
    const ticker = tok?.symbol || sched.symbol || null;
    return { ticker: ticker ? String(ticker).toUpperCase() : null, display: ticker || sched.name || sched.geckoId || sched.slug };
  }

  // The next `limit` cliff unlocks across all tracked protocols (for `/unlock`
  // with no symbol), soonest first, each annotated with ticker + usd/pct + major.
  nextUnlocks(limit = 8) {
    const rows = [];
    for (const sched of this.schedules) {
      const price = this.#priceOf(sched);
      const { ticker, display } = this.#resolve(sched);
      for (const ev of sched.events) {
        const { major, usd } = isMajorUnlock(ev, price, { minPct: this.minPct, minUsd: this.minUsd });
        rows.push({ ticker, display, slug: sched.slug, tsMs: ev.tsMs, tokens: ev.tokens, usd, pct: ev.pctOfCirc ?? ev.pctOfMax, major, recipients: ev.recipients });
      }
    }
    rows.sort((a, b) => a.tsMs - b.tsMs);
    // ONE row per token (its soonest unlock), so a token with frequent small
    // cliffs (the TIA-every-day case) doesn't flood the digest. Major unlocks
    // still surface because the soonest is shown; /unlock SYM gives the full list.
    const seen = new Set();
    const deduped = [];
    for (const r of rows) {
      const key = (r.ticker || r.display || r.slug || '').toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    return deduped.slice(0, limit);
  }

  // Full upcoming cliff schedule for ONE token (for `/unlock SYM`). Wide horizon
  // so it shows the next unlock even months out. Resolves a DeFiLlama slug from
  // the cached schedules first, then guesses (lowercased symbol, coingecko id),
  // and fetches that slug on demand. null = not found among tracked/guessable.
  async forSymbol(sym, { cgId = null, horizonMs = 365 * DAY, limit = 6 } = {}) {
    const want = String(sym).toUpperCase();
    const slugs = [];
    for (const s of this.schedules) {
      const { ticker } = this.#resolve(s);
      if ((ticker === want || String(s.geckoId).toUpperCase() === want || String(s.slug).toUpperCase() === want) && s.slug) slugs.push(s.slug);
    }
    for (const cand of [want.toLowerCase(), cgId].filter(Boolean)) if (!slugs.includes(cand)) slugs.push(cand);
    for (const slug of slugs) {
      try {
        const res = await fetch(`${DATASET_BASE}/${slug}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) continue;
        const parsed = parseUnlockSchedule(await res.json(), { nowMs: Date.now(), horizonMs });
        if (!parsed) continue;
        parsed.slug = slug;
        const price = this.#priceOf(parsed);
        const { ticker, display } = this.#resolve(parsed);
        const events = parsed.events.slice(0, limit).map(ev => {
          const { major, usd } = isMajorUnlock(ev, price, { minPct: this.minPct, minUsd: this.minUsd });
          return { tsMs: ev.tsMs, tokens: ev.tokens, usd, pct: ev.pctOfCirc ?? ev.pctOfMax, major, recipients: ev.recipients };
        });
        return { ticker, display, slug, geckoId: parsed.geckoId, name: parsed.name, events };
      } catch { /* try next candidate slug */ }
    }
    return null;
  }

  // Resolve a USD price for a parsed schedule: live price first, then derive
  // from the universe (marketCap / circulatingSupply). null if unknown.
  #priceOf(sched) {
    const cgId = sched.geckoId;
    if (cgId && this.prices?.getPrice) {
      const p = this.prices.getPrice(cgId);
      if (typeof p === 'number' && p > 0) return p;
    }
    const tok = cgId ? this.universe?.lookupByCgId?.(cgId) : null;
    if (tok?.marketCap > 0 && tok?.circulatingSupply > 0) return tok.marketCap / tok.circulatingSupply;
    return null;
  }

  // True when configured to watch EVERY token DeFiLlama tracks (UNLOCK_PROTOCOLS=all).
  get allMode() { return this.protocols.length === 1 && String(this.protocols[0]).toLowerCase() === 'all'; }

  async #refresh() {
    // Validate slugs against the live protocol list so a renamed/dead slug is
    // visible in the logs rather than a silent 404 → missed unlock. In all-mode,
    // this list IS the watch set (every protocol DeFiLlama has emission data for).
    let validArr = null;
    try {
      const res = await fetch(PROTOCOL_LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) validArr = await res.json();
    } catch { /* non-fatal — fetch each anyway */ }
    const valid = validArr ? new Set(validArr) : null;
    let slugs;
    if (this.allMode) {
      if (!validArr?.length) { console.warn('[unlocks] all-mode: DeFiLlama protocol list unavailable — keeping previous schedules'); return; }
      slugs = validArr;
    } else {
      if (valid) {
        const unknown = this.protocols.filter(s => !valid.has(s));
        if (unknown.length) console.warn(`[unlocks] ${unknown.length} configured slug(s) not in DeFiLlama list (skipped): ${unknown.join(', ')}`);
      }
      slugs = valid ? this.protocols.filter(s => valid.has(s)) : this.protocols;
    }
    const now = Date.now();
    const schedules = [];
    for (const slug of slugs) {
      try {
        const res = await fetch(`${DATASET_BASE}/${slug}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) { if (this.verbose) console.warn(`[unlocks] ${slug} HTTP ${res.status}`); continue; }
        const j = await res.json();
        const parsed = parseUnlockSchedule(j, { nowMs: now, horizonMs: this.horizonMs });
        if (parsed) { parsed.slug = slug; schedules.push(parsed); }
      } catch (err) { if (this.verbose) console.warn(`[unlocks] ${slug} fetch failed: ${err.message}`); }
    }
    this.schedules = schedules;
    const upcoming = schedules.reduce((n, s) => n + s.events.length, 0);
    console.log(`[unlocks] refreshed ${schedules.length}/${slugs.length} protocols${this.allMode ? ' (ALL DeFiLlama)' : ''} — ${upcoming} cliff unlock(s) in next ${Math.round(this.horizonMs / DAY)}d`);
  }

  async start() {
    await this.#loadFired();
    await this.#refresh();
    this.#poll();   // synchronous scan of the just-fetched schedules
    this.refreshId = setInterval(() => this.#refresh().catch(err => console.warn(`[unlocks] refresh error: ${err.message}`)), this.refreshIntervalMs);
    this.pollId = setInterval(() => this.#poll(), this.pollIntervalMs);
    this.refreshId.unref?.(); this.pollId.unref?.();
    console.log(`[unlocks] monitoring ${this.allMode ? 'ALL DeFiLlama' : this.protocols.length} protocols — major bar: ≥${(this.minPct * 100).toFixed(0)}% of circ or ≥$${(this.minUsd / 1e6).toFixed(0)}M`);
  }

  #poll() {
    const now = Date.now();
    // Flatten schedules → items carrying their parent for price lookup at fire time.
    const items = [];
    for (const sched of this.schedules) {
      const price = this.#priceOf(sched);
      for (const ev of sched.events) {
        const { major, usd, pct } = isMajorUnlock(ev, price, { minPct: this.minPct, minUsd: this.minUsd });
        if (!major) continue;
        items.push({ id: `${sched.geckoId || sched.slug}:${ev.tsMs}`, tsMs: ev.tsMs, sched, ev, usd, pct });
      }
    }
    const fires = dueUnlockFires(items, now, this.leads, this.fired);
    if (!fires.length) return;
    for (const f of fires) {
      this.fired.add(f.key);
      const { sched, ev, usd, pct } = f.item;
      const { ticker, display } = this.#resolve(sched);
      if (this.verbose) console.log(`[unlocks] fire ${display} ${f.lead.label} — ${ev.tokens} tokens`);
      this.emit('unlock', {
        symbol: display, ticker: ticker ? String(ticker).toUpperCase() : null,
        geckoId: sched.geckoId, slug: sched.slug, name: sched.name,
        tsMs: ev.tsMs, daysUntil: Math.max(0, Math.round((ev.tsMs - now) / DAY)),
        tokens: ev.tokens, usdValue: usd, pctOfCirc: ev.pctOfCirc, pctOfSupply: pct,
        recipients: ev.recipients, leadLabel: f.lead.label,
      });
    }
    this.#saveFired();
  }
}
