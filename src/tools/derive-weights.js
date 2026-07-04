// Offline weight-derivation + calibration tool (Rank 6).
//
// Turns the bot's OWN resolved-signal history into DATA-DERIVED scoring weights,
// instead of the hand-tuned constants that made anti-predictive factors (surge/
// TA/OI) outrank the real edge (flow/funding/distribution). It computes, per
// reason-kind, a shrunk Weight-of-Evidence (log-odds) and a calibrated
// score→P(win) reliability table, and reports an HONEST out-of-sample (walk-
// forward) check so you don't trust in-sample noise.
//
//   Run:  node -r dotenv/config src/tools/derive-weights.js
//   Out:  console report + logs/derived-weights.json (machine-readable)
//
// Method (deliberately simple + overfitting-resistant at small N):
//   • WoE(kind) = ln( P(kind | win) / P(kind | loss) ), Laplace-smoothed.
//   • Empirical-Bayes shrinkage toward 0 by n/(n+K) (K=SHRINK_K) so a kind seen
//     3× can't swing the score like one seen 200×.
//   • Correlated TA/SMC indicator kinds are collapsed into ONE bucket before
//     WoE (summing per-indicator points double-counts the same momentum read).
//   • Walk-forward: train on the oldest 70% (time-ordered), score the newest
//     30%, report decile lift + WR of the top half. OOS is the only number to
//     trust; in-sample always looks good.
//
// This script READS ONLY (kvAll). It writes a JSON artifact but never mutates
// the live signal store. Treat the weights as DIRECTIONAL until you have
// n >= ~400 resolved signals and OOS lift is positive across re-runs.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbEnabled, kvAll } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../../logs/derived-weights.json');

const SHRINK_K = 25;                 // shrinkage strength (higher = more conservative)
const TERMINAL_SKIP = new Set(['NO_PLAN', 'EXPIRED_UNFILLED', 'AMBIGUOUS']);
// Correlated indicator kinds collapsed into a single 'ta_bucket' before WoE.
const TA_CLUSTER = new Set(['ta', 'smc', 'oi', 'fdv', 'liqHeatmap', 'liqGrab', 'wick', 'simultaneous']);

const isWin = (r) => String(r.outcome).startsWith('WIN') || r.outcome === 'EXPIRED_PROFIT';
const isLoss = (r) => r.outcome === 'LOSS' || r.outcome === 'EXPIRED_LOSS';
const ln = Math.log;
const f = (x, p = 3) => (x == null || !isFinite(x)) ? '—' : Number(x).toFixed(p);
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';

// Collapse a record's reason-kinds to a presence Set (TA cluster → one token).
function kindSet(r) {
  const s = new Set();
  for (const rk of (r.reasons ?? [])) {
    const k = rk?.kind;
    if (!k) continue;
    s.add(TA_CLUSTER.has(k) ? 'ta_bucket' : k);
  }
  return s;
}

// Shrunk WoE for one binary feature given presence counts in wins/losses.
function shrunkWoe(winsWith, lossWith, W, L) {
  // Laplace-smoothed conditional presence probabilities.
  const pWin = (winsWith + 0.5) / (W + 1);
  const pLoss = (lossWith + 0.5) / (L + 1);
  const raw = ln(pWin / pLoss);
  const n = winsWith + lossWith;
  const shrink = n / (n + SHRINK_K);
  return { woe: raw * shrink, raw, n, shrink };
}

function deriveWeights(records) {
  const wins = records.filter(isWin), losses = records.filter(isLoss);
  const W = wins.length, L = losses.length;
  const kinds = new Set();
  for (const r of records) for (const k of kindSet(r)) kinds.add(k);

  const weights = {};
  for (const k of kinds) {
    const winsWith = wins.filter(r => kindSet(r).has(k)).length;
    const lossWith = losses.filter(r => kindSet(r).has(k)).length;
    const s = shrunkWoe(winsWith, lossWith, W, L);
    weights[k] = { ...s, winsWith, lossWith, wrWhenPresent: (winsWith + lossWith) ? winsWith / (winsWith + lossWith) : null };
  }
  const priorLogOdds = ln((W + 0.5) / (L + 0.5));
  return { weights, priorLogOdds, W, L };
}

// Additive WoE score for one record under a derived model.
function scoreRecord(r, model) {
  let s = model.priorLogOdds;
  for (const k of kindSet(r)) if (model.weights[k]) s += model.weights[k].woe;
  return s;
}

// Reliability table: bucket by predicted log-odds, show realized WR per bin.
function reliability(records, model, bins = 6) {
  const scored = records.map(r => ({ s: scoreRecord(r, model), win: isWin(r) ? 1 : isLoss(r) ? 0 : null }))
    .filter(x => x.win != null)
    .sort((a, b) => a.s - b.s);
  if (!scored.length) return [];
  const per = Math.ceil(scored.length / bins);
  const rows = [];
  for (let i = 0; i < scored.length; i += per) {
    const chunk = scored.slice(i, i + per);
    const w = chunk.filter(c => c.win).length;
    rows.push({ n: chunk.length, lo: chunk[0].s, hi: chunk[chunk.length - 1].s, wr: w / chunk.length });
  }
  return rows;
}

// Walk-forward OOS: train on oldest 70%, evaluate newest 30%.
function walkForward(records) {
  const ord = [...records].filter(r => r.ts).sort((a, b) => a.ts - b.ts);
  const evalOnly = ord.filter(r => isWin(r) || isLoss(r));
  if (evalOnly.length < 40) return { ok: false, reason: `only ${evalOnly.length} resolved — need ~40+ for a walk-forward read` };
  const cut = Math.floor(evalOnly.length * 0.7);
  const train = evalOnly.slice(0, cut), test = evalOnly.slice(cut);
  const model = deriveWeights(train);
  const scored = test.map(r => ({ s: scoreRecord(r, model), win: isWin(r) })).sort((a, b) => b.s - a.s);
  const half = Math.floor(scored.length / 2);
  const topWR = half ? scored.slice(0, half).filter(x => x.win).length / half : null;
  const botWR = half ? scored.slice(-half).filter(x => x.win).length / half : null;
  const baseWR = scored.filter(x => x.win).length / scored.length;
  return { ok: true, trainN: train.length, testN: test.length, baseWR, topHalfWR: topWR, bottomHalfWR: botWR, lift: (topWR != null && botWR != null) ? topWR - botWR : null };
}

async function main() {
  if (!dbEnabled()) { console.error('No DATABASE_URL — cannot read history.'); process.exit(1); }
  const rows = await kvAll('signals');
  let recs = [];
  for (const r of rows) if (Array.isArray(r.val)) recs.push(...r.val);
  const resolved = recs.filter(r => r.outcome && !TERMINAL_SKIP.has(r.outcome));
  console.log(`\nDerive-weights — ${recs.length} records, ${resolved.length} resolved (wins ${resolved.filter(isWin).length} / losses ${resolved.filter(isLoss).length})`);
  if (resolved.length < 30) { console.error('Too few resolved signals to derive weights (need 30+).'); process.exit(1); }

  const model = deriveWeights(resolved);
  console.log(`\nPrior log-odds: ${f(model.priorLogOdds)}  (base WR ${pct(model.W, model.W + model.L)})`);
  console.log(`\n── Reason-kind WEIGHTS (shrunk WoE; + favours WIN, − favours LOSS) ──`);
  const sorted = Object.entries(model.weights).sort((a, b) => b[1].woe - a[1].woe);
  for (const [k, v] of sorted)
    console.log(`   ${k.padEnd(18)} woe ${(v.woe >= 0 ? '+' : '') + f(v.woe)}  (raw ${f(v.raw)}, n=${String(v.n).padStart(4)}, shrink ${f(v.shrink, 2)}, WR ${v.wrWhenPresent != null ? pct(Math.round(v.wrWhenPresent * v.n), v.n) : '—'})`);

  console.log(`\n── Per-trigger win rate ──`);
  const trig = {};
  for (const r of resolved) { const t = r.trigger ?? '?'; (trig[t] ??= { w: 0, n: 0 }); trig[t].n++; if (isWin(r)) trig[t].w++; }
  for (const [t, v] of Object.entries(trig).sort((a, b) => b[1].n - a[1].n))
    console.log(`   ${t.padEnd(18)} WR ${pct(v.w, v.n).padStart(6)}  (n=${v.n})`);

  console.log(`\n── In-sample reliability (score bin → realized WR; should be monotone) ──`);
  for (const row of reliability(resolved, model))
    console.log(`   logodds ${f(row.lo, 1).padStart(6)}…${f(row.hi, 1).padStart(6)}  WR ${pct(Math.round(row.wr * row.n), row.n).padStart(6)}  (n=${row.n})`);

  console.log(`\n── WALK-FORWARD (out-of-sample — the only number to trust) ──`);
  const wf = walkForward(resolved);
  if (!wf.ok) console.log(`   ${wf.reason}`);
  else {
    console.log(`   train ${wf.trainN} → test ${wf.testN} | base WR ${pct(Math.round(wf.baseWR * wf.testN), wf.testN)}`);
    console.log(`   top-half-by-score WR ${pct(Math.round(wf.topHalfWR * Math.floor(wf.testN / 2)), Math.floor(wf.testN / 2))} vs bottom-half ${pct(Math.round(wf.bottomHalfWR * Math.floor(wf.testN / 2)), Math.floor(wf.testN / 2))}  →  OOS lift ${wf.lift != null ? (wf.lift * 100 >= 0 ? '+' : '') + (wf.lift * 100).toFixed(1) + ' pts' : '—'}`);
    console.log(`   ${wf.lift > 0.05 ? '✅ model ranks winners above losers out-of-sample' : wf.lift > 0 ? '🟡 weak positive — directional only, keep gathering data' : '🔴 no OOS edge yet — DO NOT ship these as live weights; keep the gates (ranks 1-3) doing the work'}`);
  }

  const artifact = {
    generatedFromN: resolved.length, wins: model.W, losses: model.L,
    priorLogOdds: model.priorLogOdds, shrinkK: SHRINK_K, taCluster: [...TA_CLUSTER],
    weights: Object.fromEntries(sorted.map(([k, v]) => [k, Number(v.woe.toFixed(4))])),
    triggerWinRate: Object.fromEntries(Object.entries(trig).map(([t, v]) => [t, Number((v.w / v.n).toFixed(3))])),
    walkForward: wf,
    note: 'DIRECTIONAL until n>=400 and OOS lift is consistently positive. Do not wire as live weights without walk-forward confirmation.',
  };
  try {
    if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));
    console.log(`\nWrote ${OUT_PATH}\n`);
  } catch (err) { console.warn(`Could not write artifact: ${err.message}`); }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
