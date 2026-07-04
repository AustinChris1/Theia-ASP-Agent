// asp/reputation/ledger.js — verifiable-alpha ledger.
//
// Publishes Theia's REAL resolved-signal track record so any agent can audit the
// win-rate and P&L instead of trusting a claim. Every resolved signal (entry +
// outcome) is hashed; the hashes fold into a Merkle root that is anchored on X
// Layer. Anyone can recompute a leaf from the public signal record and prove it is
// under the anchored root.
//
// HARD RULE: only REAL resolved outcomes from signal-tracker are used. Nothing is
// fabricated. If there are no resolved signals yet, the ledger says so.
import { createHash } from 'node:crypto';
import { config } from '../config.js';

/** Stable, canonical JSON (sorted keys) so a leaf hash is reproducible. */
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }

/** The minimal, auditable fields of a resolved signal -> its leaf hash. */
export function leafFor(rec) {
  const leaf = {
    symbol: rec.symbol ?? rec.token?.symbol ?? null,
    side: rec.side ?? null,
    strength: rec.strength ?? rec.tier ?? null,
    trigger: rec.trigger ?? rec.trigger?.type ?? null,
    entry: rec.entry ?? rec.tradePlan?.entry ?? null,
    sl: rec.sl ?? rec.tradePlan?.sl ?? null,
    tp1: rec.tp1 ?? rec.tradePlan?.tp1 ?? null,
    outcome: rec.outcome ?? null,
    finalPnlPct: rec.finalPnlPct ?? null,
    openedAt: rec.createdAt ?? rec.ts ?? rec.openedAt ?? null,
    resolvedAt: rec.resolvedAt ?? rec.closedAt ?? null,
  };
  const c = canonical(leaf);
  return { ...leaf, hash: sha256Hex(c) };
}

/** A simple, deterministic binary Merkle root over ordered leaf hashes. */
export function merkleRoot(hexLeaves) {
  if (!hexLeaves.length) return null;
  let level = hexLeaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i]; // duplicate the last if odd
      next.push(sha256Hex(a < b ? a + b : b + a)); // order-independent pairing
    }
    level = next;
  }
  return level[0];
}

const RESOLVED = new Set([
  'WIN_TP1', 'WIN_TP2', 'WIN_TP3', 'WIN_TRAIL', 'LOSS',
  'EXPIRED_PROFIT', 'EXPIRED_LOSS', 'BREAKEVEN',
]);

/**
 * Compute the full ledger from a SignalTracker (real resolved outcomes only).
 * @param {object} signalTracker  the engine's SignalTracker (getStats + allRecords)
 * @returns {Promise<object>} { available, stats, count, merkleRoot, leaves }
 */
export async function computeLedger(signalTracker) {
  if (!signalTracker) return { available: false, reason: 'signal tracker not available', stats: null, count: 0, merkleRoot: null, leaves: [] };

  let records = [];
  try {
    records = typeof signalTracker.allRecords === 'function'
      ? await signalTracker.allRecords()
      : (signalTracker.currentRecords?.() ?? []);
  } catch { records = []; }

  const resolved = (records || []).filter((r) => RESOLVED.has(r.outcome));
  const leaves = resolved.map(leafFor);
  const root = merkleRoot(leaves.map((l) => l.hash));

  let stats = null;
  try { stats = signalTracker.getStats?.() ?? null; } catch { stats = null; }

  return {
    available: resolved.length > 0,
    provider: config.server.name,
    stats,
    count: resolved.length,
    merkleRoot: root,
    leaves,
    note: resolved.length === 0
      ? 'No resolved signals yet. The ledger publishes only real, resolved outcomes.'
      : 'Every leaf is a real resolved signal. Recompute any leaf hash from the public record and prove it is under the root.',
  };
}

/**
 * A compact, human-facing scoreboard for the demo / the /reputation route.
 */
export async function scoreboard(signalTracker) {
  const l = await computeLedger(signalTracker);
  const s = l.stats || {};
  return {
    provider: config.server.name,
    available: l.available,
    resolvedSignals: l.count,
    winRatePct: s.winPct != null ? Math.round(s.winPct) : null,
    wins: (s.wins ?? 0) + (s.expiredProfit ?? 0),
    losses: (s.losses ?? 0) + (s.expiredLoss ?? 0),
    breakevens: s.breakevens ?? 0,
    avgTimeToResolveHrs: s.avgTtrHrs != null ? Math.round(s.avgTtrHrs * 10) / 10 : null,
    byStrength: s.byStrength ?? null,
    merkleRoot: l.merkleRoot,
    anchoredOnChain: config.reputation.enabled ? 'see anchor tx' : 'not yet anchored (REPUTATION_LEDGER_ENABLED=0)',
    note: l.note,
  };
}

/**
 * The exact onchainos command to anchor a Merkle root on X Layer. We prepare the
 * command; the actual on-chain write runs through the operator's Agentic Wallet
 * (human-in-the-loop, gas-free on X Layer 196). Two sinks:
 *   calldata - a zero-value self-send whose data field carries `theia:<root>`
 *   contract - a call to an append-only log contract's `anchor(bytes32)`
 */
export function anchorCommand(root, { payTo = config.x402.payTo } = {}) {
  if (!root) return null;
  if (config.reputation.sink === 'contract' && config.reputation.contractAddress) {
    return {
      sink: 'contract',
      description: 'Append the root to the on-chain reputation log via the Agentic Wallet.',
      command: `onchainos wallet contract-call --chain 196 --to ${config.reputation.contractAddress} --function "anchor(bytes32)" --args "0x${root}"`,
    };
  }
  const memo = Buffer.from(`theia:${root}`, 'utf8').toString('hex');
  return {
    sink: 'calldata',
    description: 'Anchor the root as a zero-value self-send memo on X Layer (196), gas-free via the paymaster.',
    command: `onchainos wallet send --chain 196 --to ${payTo || '<your-wallet>'} --amount 0 --data 0x${memo}`,
    memoHex: `0x${memo}`,
  };
}

export default { computeLedger, scoreboard, leafFor, merkleRoot, anchorCommand };
