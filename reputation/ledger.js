// Verifiable-alpha ledger: hash REAL resolved signals into a Merkle root anchored on
// X Layer, so the win-rate is auditable, not claimed. Only real resolved outcomes; never fabricated.
import { createHash } from 'node:crypto';
import { config } from '../config.js';

// Canonical JSON (sorted keys) so a leaf hash is reproducible.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function sha256Hex(s) { return createHash('sha256').update(s).digest('hex'); }

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
  return { ...leaf, hash: sha256Hex(canonical(leaf)) };
}

// Order-independent binary Merkle root over leaf hashes.
export function merkleRoot(hexLeaves) {
  if (!hexLeaves.length) return null;
  let level = hexLeaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? level[i];
      next.push(sha256Hex(a < b ? a + b : b + a));
    }
    level = next;
  }
  return level[0];
}

const RESOLVED = new Set([
  'WIN_TP1', 'WIN_TP2', 'WIN_TP3', 'WIN_TRAIL', 'LOSS',
  'EXPIRED_PROFIT', 'EXPIRED_LOSS', 'BREAKEVEN',
]);

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

// Prepare the on-chain anchor command; the write runs through the operator's Agentic Wallet.
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
