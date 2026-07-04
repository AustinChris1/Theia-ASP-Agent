// Auto-trade journal — every order the autotrader places and its outcome.
//
// Backed by Neon Postgres (the `journal` table, one namespace per store) when
// DATABASE_URL is set, else an append-only JSONL file. EITHER WAY the rows are
// held in memory so the (synchronous) reads the AutoTrader relies on
// — openTrades(), hasOpen(), stats(), breakdown() — stay sync. Mutations update
// memory immediately and persist asynchronously (fire-and-forget) to the DB, or
// synchronously to the file.
//
// Record shape:
//   { id, ts, mode, symbol, side, qty, notionalUsd, leverage, entry, sl,
//     tp, status: 'open'|'closed', closedAt, exitPrice, pnlUsd, pnlPct, reason }

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { dbEnabled, journalAll, journalUpsert, journalDelete } from '../db.js';

export class TradeStore {
  constructor({ path, ns = null }) {
    this.path = path;
    // Namespace for the DB journal table — unique per store (operator vs each
    // user). Derived from the file name when not given, e.g.
    // "autotrades.jsonl" → "autotrades", "autotrades-user-123.jsonl" → that.
    this.ns = ns ?? basename(path).replace(/\.jsonl?$/i, '');
    this.rows = [];
    if (!dbEnabled()) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadFile();                 // file mode loads synchronously
    }
  }

  // Async init for the Postgres path — load rows (and migrate an existing file
  // on first DB boot). No-op in file mode. Must be awaited before the trader's
  // monitor runs so open trades resolve correctly after a restart.
  async init() {
    if (!dbEnabled()) return this;
    try {
      const rows = await journalAll(this.ns);
      if (rows.length === 0 && existsSync(this.path)) {
        this.#loadFile();               // migrate file → DB
        for (const r of this.rows) if (r.id) journalUpsert(this.ns, r.id, r).catch(() => {});
        if (this.rows.length) console.log(`[autotrade] migrated ${this.rows.length} ${this.ns} rows → Postgres`);
      } else {
        this.rows = rows;
      }
    } catch (err) {
      console.warn(`[autotrade] ${this.ns} DB load failed: ${err.message}`);
    }
    return this;
  }

  #loadFile() {
    if (!existsSync(this.path)) return;
    try {
      this.rows = readFileSync(this.path, 'utf8')
        .split('\n').filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { this.rows = []; }
  }

  #appendPersist(row) {
    if (dbEnabled()) {
      journalUpsert(this.ns, row.id, row).catch(err => console.warn(`[autotrade] ${this.ns} DB write failed: ${err.message}`));
      return;
    }
    try { appendFileSync(this.path, JSON.stringify(row) + '\n'); }
    catch (err) { console.warn(`[autotrade] journal append failed: ${err.message}`); }
  }

  #updatePersist(row) {
    if (dbEnabled()) {
      journalUpsert(this.ns, row.id, row).catch(err => console.warn(`[autotrade] ${this.ns} DB write failed: ${err.message}`));
      return;
    }
    try { writeFileSync(this.path, this.rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
    catch (err) { console.warn(`[autotrade] journal rewrite failed: ${err.message}`); }
  }

  append(record) {
    this.rows.push(record);
    this.#appendPersist(record);
    return true;
  }

  // Mark an open trade closed and fill in the outcome.
  closeTrade(id, { exitPrice, pnlUsd, pnlPct, reason }) {
    const r = this.rows.find(x => x.id === id && x.status === 'open');
    if (!r) return false;
    Object.assign(r, { status: 'closed', closedAt: Date.now(), exitPrice, pnlUsd, pnlPct, reason });
    this.#updatePersist(r);
    return true;
  }

  // Patch fields on an OPEN trade (trailing-stop manager records trail stage + SL).
  updateTrade(id, patch) {
    const r = this.rows.find(x => x.id === id && x.status === 'open');
    if (!r) return false;
    Object.assign(r, patch);
    this.#updatePersist(r);
    return true;
  }

  // Wipe this account's CLOSED trade history — resets the user's /pnl + win-rate.
  // OPEN trades are KEPT (deleting them would orphan a live/paper position the
  // monitor still needs to resolve). Returns the number of closed rows removed.
  clearClosed() {
    const closed = this.rows.filter(r => r.status === 'closed');
    if (closed.length === 0) return 0;
    this.rows = this.rows.filter(r => r.status !== 'closed');
    if (dbEnabled()) {
      for (const r of closed) if (r.id) journalDelete(this.ns, r.id).catch(err => console.warn(`[autotrade] ${this.ns} clear failed: ${err.message}`));
    } else {
      try { writeFileSync(this.path, this.rows.map(r => JSON.stringify(r)).join('\n') + (this.rows.length ? '\n' : '')); }
      catch (err) { console.warn(`[autotrade] journal clear rewrite failed: ${err.message}`); }
    }
    return closed.length;
  }

  openTrades() { return this.rows.filter(r => r.status === 'open'); }

  hasOpen(symbol, mode = null) {
    return this.rows.some(r => r.status === 'open' && r.symbol === symbol && (mode == null || (r.mode ?? mode) === mode));
  }

  // Rich PnL breakdown for the /pnl view: totals + per-mode + per-symbol +
  // recent closes + still-open trades. `mode` optionally scopes to paper|live.
  breakdown(mode = null) {
    const rows = this.rows.filter(r => mode == null || (r.mode ?? 'live') === mode);
    // EXPIRED_UNFILLED = a limit entry that never filled — not a real trade, so
    // it's excluded from win-rate and PnL.
    const closed = rows.filter(r => r.status === 'closed' && r.reason !== 'EXPIRED_UNFILLED');
    const open = rows.filter(r => r.status === 'open');
    const sum = (arr) => arr.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);

    const byMode = {};
    for (const r of closed) {
      const m = r.mode ?? 'live';
      (byMode[m] ??= { closed: 0, wins: 0, pnlUsd: 0 });
      byMode[m].closed++; byMode[m].pnlUsd += (r.pnlUsd ?? 0);
      if ((r.pnlUsd ?? 0) > 0) byMode[m].wins++;
    }
    for (const m of Object.values(byMode)) m.pnlUsd = Number(m.pnlUsd.toFixed(2));

    const bySymbolMap = new Map();
    for (const r of closed) {
      const e = bySymbolMap.get(r.symbol) ?? { symbol: r.symbol, trades: 0, wins: 0, pnlUsd: 0 };
      e.trades++; e.pnlUsd += (r.pnlUsd ?? 0); if ((r.pnlUsd ?? 0) > 0) e.wins++;
      bySymbolMap.set(r.symbol, e);
    }
    const bySymbol = [...bySymbolMap.values()]
      .map(e => ({ ...e, pnlUsd: Number(e.pnlUsd.toFixed(2)) }))
      .sort((a, b) => b.pnlUsd - a.pnlUsd);

    const recent = closed
      .slice(-8).reverse()
      .map(r => ({ symbol: r.symbol, side: r.side, mode: r.mode ?? 'live', pnlUsd: Number((r.pnlUsd ?? 0).toFixed(2)), pnlPct: Number((r.pnlPct ?? 0).toFixed(1)), reason: r.reason }));

    return {
      closed: closed.length,
      open: open.length,
      wins: closed.filter(r => (r.pnlUsd ?? 0) > 0).length,
      realisedUsd: Number(sum(closed).toFixed(2)),
      byMode, bySymbol, recent,
      openTrades: open.map(r => ({ symbol: r.symbol, side: r.side, mode: r.mode ?? 'live', entry: r.entry, qty: r.qty, sl: r.sl, tp: r.tp, notionalUsd: r.notionalUsd }))
    };
  }

  stats() {
    const rows = this.rows;
    const closed = rows.filter(r => r.status === 'closed' && r.reason !== 'EXPIRED_UNFILLED');
    const wins = closed.filter(r => (r.pnlUsd ?? 0) > 0);
    const totalPnl = closed.reduce((s, r) => s + (r.pnlUsd ?? 0), 0);
    return {
      total: rows.length,
      open: rows.filter(r => r.status === 'open').length,
      closed: closed.length,
      wins: wins.length,
      losses: closed.length - wins.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      totalPnlUsd: Number(totalPnl.toFixed(2))
    };
  }
}
