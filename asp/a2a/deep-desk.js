// asp/a2a/deep-desk.js — the A2A premium service, "Theia Deep Desk".
//
// A2A (escrow) work: a User Agent publishes a task ("audit these tokens for
// manipulation, insider distribution, and liquidation risk"), Theia negotiates,
// the funds go into escrow on X Layer, Theia runs a full multi-skill audit across
// the token set, delivers a structured report, and is paid on sign-off.
//
// This module is the ASP-side WORK BRAIN. The task lifecycle itself (negotiation,
// escrow, XMTP, arbitration, rating) is driven by the `onchainos agent` CLI +
// next-action state machine (see NOTES-okx §5). Here we implement:
//   1. an autonomous conviction filter (accept only jobs we can serve well),
//   2. the audit run (reuse the six skills across the token set),
//   3. the deliverable (structured JSON + a readable markdown report),
//   4. the exact CLI hooks for apply / deliver / rating.
//
// Deterministic by construction: token scoping and accept/decline are rule-based;
// no LLM decides. An LLM may only narrate the finished report.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILLS_BY_NAME } from '../skills/index.js';
import { config } from '../config.js';
import { isStableSymbol } from '../../src/stables.js';

// Task statuses from NOTES-okx §5 (paymentMode 1=escrow, 3=x402).
export const TASK_STATUS = {
  DRAFT: -1, CREATED: 0, ACCEPTED: 1, SUBMITTED: 2, REJECTED: 3, DISPUTED: 4,
  ADMIN_STOPPED: 5, COMPLETE: 6, CLOSE: 7, EXPIRED: 8, FAILED: 9,
};

// Per-token audit floor (USDT). Below this we cannot justify a full multi-skill
// audit at quality, so we decline rather than overpromise.
const PER_TOKEN_FLOOR_USDT = Number(process.env.DEEPDESK_PER_TOKEN_USDT ?? 2);
const MAX_TOKENS = Number(process.env.DEEPDESK_MAX_TOKENS ?? 15);

/** Extract candidate tickers from free-text (deterministic; no LLM). */
export function extractTokens(text) {
  if (!text) return [];
  const raw = String(text).toUpperCase().match(/\$?[A-Z0-9]{2,10}\b/g) || [];
  const stop = new Set(['THE', 'AND', 'FOR', 'USD', 'USDT', 'USDC', 'AUDIT', 'TOKEN', 'TOKENS', 'RISK', 'CHECK', 'REPORT', 'PORTFOLIO', 'ANALYSIS', 'PLEASE', 'WITH', 'THIS', 'THAT', 'INTO', 'OVER', 'DEEP', 'DESK', 'THEIA']);
  const seen = new Set();
  const out = [];
  for (let t of raw) {
    t = t.replace(/^\$/, '');
    if (t.length < 2 || t.length > 10) continue;
    if (stop.has(t) || isStableSymbol(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

/**
 * Autonomous conviction filter. Given the task text + agreed budget, decide
 * whether Theia should accept, and scope the token set it can actually serve.
 * @returns {Promise<{accept:boolean, reason:string, tokens:string[], unrecognized:string[], scope:object}>}
 */
export async function assessJob({ description, budgetUsdt = null }, engine) {
  const candidates = extractTokens(description).slice(0, MAX_TOKENS * 2);
  const tokens = [];
  const unrecognized = [];
  for (const sym of candidates) {
    if (tokens.length >= MAX_TOKENS) break;
    let known = false;
    try {
      const t = await engine.universe?.ensureBySymbol?.(sym);
      known = !!t?.coingeckoId;
    } catch { known = false; }
    if (known) tokens.push(sym); else unrecognized.push(sym);
  }

  if (tokens.length === 0) {
    return { accept: false, reason: 'No recognized tokens in the task. Theia audits listed crypto assets by symbol.', tokens, unrecognized, scope: null };
  }
  const minBudget = tokens.length * PER_TOKEN_FLOOR_USDT;
  if (budgetUsdt != null && Number(budgetUsdt) < minBudget) {
    return {
      accept: false,
      reason: `Budget ${budgetUsdt} USDT is below the quality floor for ${tokens.length} tokens (>= ${minBudget} USDT). Reduce scope or raise budget.`,
      tokens, unrecognized, scope: { minBudgetUsdt: minBudget, perTokenFloorUsdt: PER_TOKEN_FLOOR_USDT },
    };
  }
  return {
    accept: true,
    reason: `Theia can deliver a full manipulation + insider + liquidation + CEX-flow audit across ${tokens.length} token(s).`,
    tokens, unrecognized,
    scope: { tokens: tokens.length, perTokenFloorUsdt: PER_TOKEN_FLOOR_USDT, minBudgetUsdt: minBudget, skills: ['theia_signal', 'theia_manipulation_check', 'theia_insider_scan', 'theia_liqmap', 'theia_cex_holdings', 'theia_cex_flow'] },
  };
}

/** Run the full multi-skill audit for one token. */
async function auditToken(sym, engine) {
  const call = async (name, params) => {
    try { return await SKILLS_BY_NAME[name].run({ token: sym, ...params }, engine); }
    catch (e) { return { ok: false, error: { code: 'internal', message: e.message } }; }
  };
  const [signal, manip, insider, liqmap, holdings, flow] = await Promise.all([
    call('theia_signal'),
    call('theia_manipulation_check'),
    call('theia_insider_scan'),
    call('theia_liqmap'),
    call('theia_cex_holdings'),
    call('theia_cex_flow'),
  ]);
  return {
    token: sym,
    signal: signal.ok ? signal.data : { unavailable: signal.error },
    manipulation: manip.ok ? manip.data : { unavailable: manip.error },
    insider: insider.ok ? insider.data : { unavailable: insider.error },
    liquidation: liqmap.ok ? liqmap.data : { unavailable: liqmap.error },
    cexHoldings: holdings.ok ? holdings.data : { unavailable: holdings.error },
    cexFlow: flow.ok ? flow.data : { unavailable: flow.error },
  };
}

/**
 * Run the Deep Desk audit across a token set and assemble the deliverable.
 * @returns {Promise<{report:object, markdown:string}>}
 */
export async function runDeepDesk({ tokens, jobId = null, title = 'Theia Deep Desk Audit' }, engine) {
  const perToken = [];
  for (const sym of tokens) perToken.push(await auditToken(sym, engine)); // sequential = kind to rate limits
  const report = {
    provider: config.server.name,
    service: 'Theia Deep Desk',
    title,
    jobId,
    generatedAt: new Date().toISOString(),
    tokenCount: perToken.length,
    tokens: perToken,
    methodology: 'Deterministic multi-timeframe confluence + NOX manipulation model + on-chain insider/CEX-flow + leverage-liquidation heatmap. No LLM decides; scoring is auditable.',
    disclaimer: 'Analytical data only, not financial advice.',
  };
  return { report, markdown: toMarkdown(report) };
}

/** Render the structured report as a readable markdown deliverable. */
export function toMarkdown(report) {
  const L = [];
  L.push(`# ${report.title}`);
  L.push('');
  L.push(`Provider: ${report.provider} (Theia Deep Desk) | Generated: ${report.generatedAt}`);
  if (report.jobId) L.push(`Job: ${report.jobId}`);
  L.push('');
  for (const t of report.tokens) {
    L.push(`## ${t.token}`);
    const s = t.signal;
    if (s && !s.unavailable) {
      L.push(`- Read: **${s.side} ${s.tier ?? ''}** (confidence ${s.confidence ?? 'n/a'}%, score ${s.score ?? 'n/a'})`);
      if (s.tradePlan) L.push(`- Plan: entry ${s.tradePlan.entry}, SL ${s.tradePlan.stopLoss} (${s.tradePlan.stopLossPct}%), TP1/2/3 ${s.tradePlan.tp1}/${s.tradePlan.tp2}/${s.tradePlan.tp3}, lev ${s.tradePlan.suggestedLeverage}x, ${s.tradePlan.horizon}`);
    } else L.push('- Read: signal unavailable');
    const m = t.manipulation;
    if (m && !m.unavailable) L.push(`- Manipulation risk: **${m.riskPct}% (${m.riskLevel})**${m.flags?.length ? ' — ' + m.flags.join('; ') : ''}`);
    const i = t.insider;
    if (i && !i.unavailable) L.push(`- Insider concentration: top-10 ${i.concentrationTop10Pct ?? 'n/a'}%, ${i.insiderHolders?.length ?? 0} tracked insider holders`);
    const h = t.cexHoldings;
    if (h && !h.unavailable && h.mode === 'token') L.push(`- CEX cold custody: ${h.pctOfSupplyInColdStorage ?? 'n/a'}% of supply`);
    const f = t.cexFlow;
    if (f && !f.unavailable && f.flow) L.push(`- CEX flow: ${f.flow.direction} (${f.flow.bias})`);
    const lq = t.liquidation;
    if (lq && !lq.unavailable) L.push(`- Liquidity magnets: nearest above ${lq.nearestAbove?.price ?? 'n/a'}, below ${lq.nearestBelow?.price ?? 'n/a'}`);
    L.push('');
  }
  L.push('---');
  L.push(report.methodology);
  L.push('');
  L.push(`_${report.disclaimer}_`);
  return L.join('\n');
}

/** Persist the deliverable (markdown + json) and return the file paths. */
export function writeDeliverable(report, markdown, dir = resolve(process.cwd(), 'asp/.cache/deliverables')) {
  mkdirSync(dir, { recursive: true });
  const stamp = String(report.jobId || 'audit').replace(/[^a-z0-9_-]/gi, '_');
  const mdPath = resolve(dir, `${stamp}.md`);
  const jsonPath = resolve(dir, `${stamp}.json`);
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  return { mdPath, jsonPath };
}

// ── onchainos CLI hooks (human/agent-in-the-loop; gas-free on X Layer) ────────
// These return the exact commands the ASP session runs at each lifecycle step.
// Real work + deliver are gated on `job_accepted` (escrow funded); never deliver
// before that (see NOTES-okx §5).
export const cli = {
  apply: (jobId, priceUsdt, agentId) =>
    `onchainos agent apply ${jobId} --token-amount ${priceUsdt} --token-symbol USDT --agent-id ${agentId}`,
  canDeliver: (statusCode) => Number(statusCode) === TASK_STATUS.ACCEPTED,
  deliver: (jobId, filePath, agentId) =>
    `onchainos agent deliver ${jobId} --file "${filePath}" --message "Theia Deep Desk audit attached." --agent-id ${agentId}`,
  rateUser: (userAgentId, myAgentId, jobId, score = 100) =>
    `onchainos agent feedback-submit --agent-id ${userAgentId} --creator-id ${myAgentId} --score ${score} --task-id ${jobId} --description "Clear scope, prompt sign-off."`,
};

export default { assessJob, extractTokens, runDeepDesk, toMarkdown, writeDeliverable, cli, TASK_STATUS };
