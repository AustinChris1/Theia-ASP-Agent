// One-time migration: push existing logs/*.json(l) state into Neon Postgres.
//
// Run this ONCE on the machine that has your real data (your VPS), with
// DATABASE_URL set in .env and `pg` installed:
//
//   node scripts/migrate-to-neon.js
//
// It reads each local store file and writes it to the SAME Neon ns/key the bot
// reads from — so after this, a fresh Render deploy loads your subscribers,
// signal history, connected users' encrypted keys, the team-wallet cache, etc.
// It OVERWRITES the matching Neon keys (run it while the bot is stopped).
// Idempotent: safe to re-run.

import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load the project-root .env regardless of where this is run from (e.g. from
// inside scripts/) — plain `dotenv/config` only looks in the current directory.
dotenv.config({ path: resolve(__dirname, '../.env') });

const { dbEnabled, initSchema, kvSet, journalUpsert } = await import('../src/db.js');
const LOGS = resolve(__dirname, '../logs');
const p = (f) => resolve(LOGS, f);

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.warn(`  ! ${file}: ${e.message}`); return null; }
}
function readJsonl(file) {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { console.warn(`  ! ${file}: ${e.message}`); return null; }
}

async function main() {
  if (!dbEnabled()) { console.error('DATABASE_URL not set — nothing to migrate to.'); process.exit(1); }
  await initSchema();
  console.log('Migrating logs/ → Neon …\n');

  // ── KV-doc stores ──────────────────────────────────────────────────────────
  const subs = readJson(p('subscribers.json'));
  if (subs?.entries) { await kvSet('subscribers', 'all', subs.entries); console.log(`✓ subscribers: ${subs.entries.length}`); }

  const accts = readJson(p('user-accounts.json'));
  if (accts?.accounts) { await kvSet('user-accounts', 'all', accts.accounts); console.log(`✓ user-accounts (encrypted keys): ${accts.accounts.length}`); }

  const sigs = readJsonl(p('signals.jsonl'));
  if (sigs) { await kvSet('signals', 'all', sigs); console.log(`✓ signals: ${sigs.length}`); }

  const seen = readJson(p('seen-listings.json'));
  if (seen?.seen) { await kvSet('listings', 'seen', seen.seen); console.log(`✓ seen-listings: ${seen.seen.length}`); }

  const funding = readJson(p('funding-state.json'));
  if (funding) { await kvSet('funding', 'state', funding); console.log(`✓ funding cache: ${Object.keys(funding.bySymbol ?? {}).length} symbols`); }

  const watch = readJson(p('user-watchlist.json'));
  if (watch?.entries) { await kvSet('watchlist', 'user-pinned', watch.entries); console.log(`✓ watchlist: ${watch.entries.length}`); }

  const team = readJson(p('team-wallets.json'));
  if (team) { await kvSet('team-wallets', 'cache', team); console.log(`✓ team-wallets: ${Object.keys(team.byToken ?? {}).length} tokens`); }

  const paper = readJson(p('paper-positions.json'));
  if (paper) { await kvSet('paper', 'paper-positions', paper); console.log(`✓ paper positions (operator): ${(paper.positions ?? []).length}`); }

  // ── Journal-table store (trade journal, per-row) ───────────────────────────
  const trades = readJsonl(p('autotrades.jsonl'));
  if (trades) { for (const r of trades) if (r.id) await journalUpsert('autotrades', r.id, r); console.log(`✓ autotrades journal: ${trades.length}`); }

  console.log('\nDone. A fresh deploy will now load this data from Neon.');
  process.exit(0);
}

main().catch(err => { console.error('migration failed:', err); process.exit(1); });
