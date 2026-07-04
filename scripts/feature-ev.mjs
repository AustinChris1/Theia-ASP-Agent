// Per-feature expectancy report — the "does each scoring factor actually have edge"
// validation. Reads resolved signals from Neon (kv ns='signals', live 'all' + every
// 'archive-*' reset snapshot) and breaks win-rate + idea-R expectancy down by
// trigger, reason-kind, side and tier.
//
// READ-ONLY. Run anytime:   node scripts/feature-ev.mjs [days]
//   days defaults to 20. Needs DATABASE_URL in .env (the Neon connection string).
//
// "idea-R" = how far each signal's own plan ran in its favor (to the highest TP it
// reached) vs its own stop: WIN → +R of the reached TP, LOSS → -1, BREAKEVEN → 0.
// It measures SETUP quality; your live tp1/trailing exit captures less, so treat it
// as the ceiling, not realized P&L. AMBIGUOUS / NO_PLAN / still-open are excluded.
//
// After deploying changes + /resetstats, re-run in ~2 weeks for a clean post-fix
// baseline. Factors consistently below baseline EV are the ones to cut or demote.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dir = dirname(fileURLToPath(import.meta.url));
const DAYS = Number(process.argv[2]) || 20;

const env = readFileSync(join(__dir, '..', '.env'), 'utf8');
const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
if (!m) { console.error('No DATABASE_URL in .env'); process.exit(1); }

const pool = new pg.Pool({ connectionString: m[1], max: 2 });
const res = await pool.query("SELECT key, val FROM kv WHERE ns='signals'");
await pool.end();

const seen = new Set(), recs = [];
for (const row of res.rows) {
  for (const r of (Array.isArray(row.val) ? row.val : [])) {
    const k = `${r.ts}|${r.symbol}|${r.side}|${r.score}`;
    if (!seen.has(k)) { seen.add(k); recs.push(r); }
  }
}

const win = (o) => typeof o === 'string' && o.startsWith('WIN');
const isResolved = (r) => win(r.outcome) || r.outcome === 'LOSS' || r.outcome === 'BREAKEVEN';
const cutoff = Date.now() - DAYS * 86400 * 1000;
const inWindow = recs.filter(r => (r.ts || 0) >= cutoff);
const resolved = inWindow.filter(isResolved);

function ideaR(r) {
  if (r.outcome === 'LOSS') return -1;
  if (r.outcome === 'BREAKEVEN') return 0;
  if (!win(r.outcome)) return null;
  const e = +r.entry, s = +r.sl, d = Math.abs(e - s);
  if (!(d > 0) || !isFinite(e)) return null;
  let lvl = r.outcome === 'WIN_TRAIL' ? (r.tpHit || 1) : (+(r.outcome.replace('WIN_TP', '')) || r.tpHit || 1);
  lvl = Math.max(1, Math.min(3, lvl));
  const tp = +r[`tp${lvl}`];
  return isFinite(tp) ? Math.abs(tp - e) / d : null;
}

function agg(list) {
  let w = 0, l = 0, be = 0; const rs = [];
  for (const r of list) {
    if (win(r.outcome)) w++; else if (r.outcome === 'LOSS') l++; else if (r.outcome === 'BREAKEVEN') be++;
    const R = ideaR(r); if (R !== null) rs.push(R);
  }
  return {
    n: list.length, w, l, be,
    wr: (w + l) > 0 ? (w / (w + l)) * 100 : null,
    ev: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
  };
}
const fmt = (a) => `n=${String(a.n).padStart(3)}  W/L/BE ${a.w}/${a.l}/${a.be}  WR ${a.wr == null ? ' -- ' : String(a.wr.toFixed(0)).padStart(3) + '%'}  EV ${a.ev == null ? ' -- ' : (a.ev >= 0 ? '+' : '') + a.ev.toFixed(2) + 'R'}`;
const groupBy = (list, keyFn) => { const g = {}; for (const r of list) { for (const k of [].concat(keyFn(r))) (g[k] || (g[k] = [])).push(r); } return g; };
const printGroup = (title, groups, { minN = 1, sortByEv = true } = {}) => {
  console.log(`\n── ${title} ──`);
  let rows = Object.entries(groups).map(([k, v]) => [k, agg(v)]).filter(([, a]) => a.n >= minN);
  if (sortByEv) rows.sort((a, b) => (b[1].ev ?? -9) - (a[1].ev ?? -9));
  const base = agg(resolved).ev ?? 0;
  for (const [k, a] of rows) {
    const tag = a.ev == null ? '' : a.ev >= base + 0.12 ? '  ✅ EDGE' : a.ev <= 0 ? '  🔴 ANTI' : '';
    console.log(`  ${String(k).padEnd(18)} ${fmt(a)}${tag}`);
  }
};

console.log(`\n===== LAST ${DAYS} DAYS  (${inWindow.length} signals, ${resolved.length} resolved) =====`);
console.log(`OVERALL  ${fmt(agg(resolved))}`);
printGroup('BY TRIGGER', groupBy(resolved, r => r.trigger));
printGroup('BY REASON-KIND (signal counts toward every factor present)', groupBy(resolved, r => [...new Set((r.reasons || []).map(x => x.kind))]), { minN: 4 });
printGroup('BY SIDE', groupBy(resolved, r => r.side), { sortByEv: false });
printGroup('BY TIER', groupBy(resolved, r => r.strength), { sortByEv: false });
