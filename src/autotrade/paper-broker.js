// Paper broker — simulates order fills against LIVE prices without placing a
// single real order. Same interface shape as BybitExchange so the AutoTrader
// can use either interchangeably (mode: 'paper' | 'live').
//
// Fill model:
//   • Entry fills immediately at the provided market price (we ignore slippage
//     for v1 — it's small for liquid perps at tiny size).
//   • SL / TP are tracked in-memory; the AutoTrader's monitor loop polls live
//     prices and resolves them. (The real Bybit adapter offloads this to the
//     exchange server-side; the paper broker resolves it client-side.)
//
// Balance is a virtual number seeded from PAPER_BALANCE_USD; realised PnL
// adjusts it so the simulated equity curve is meaningful.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { dbEnabled, kvGet, kvSet } from '../db.js';

const DB_NS = 'paper';

export class PaperBroker {
  constructor({ startBalance = 1000, priceFn, verbose = false, statePath = null }) {
    this.balance = startBalance;
    this.priceFn = priceFn;            // (symbol) => current price | null
    this.verbose = verbose;
    this.positions = new Map();        // symbol → { side, size, entryPrice, sl, tp, leverage }
    this.pendingLimits = new Map();    // orderId → { symbol, side, qty, limitPrice, sl, tp, ts } — resting limits
    // Persist balance + open positions so PAPER survives a restart. Backed by
    // Neon Postgres (when DATABASE_URL is set) or a local file. Live positions
    // persist on Bybit via their server-side SL/TP; this brings paper to parity.
    this.statePath = statePath;
    this.dbKey = statePath ? basename(statePath).replace(/\.json$/i, '') : 'paper-positions';
    if (statePath && !dbEnabled()) {
      const dir = dirname(statePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadFile();                // file mode loads synchronously
    }
  }

  // Async init for the Postgres path (load + migrate an existing file). No-op in
  // file mode. Awaited before the trader starts.
  async init() {
    if (!dbEnabled()) return this;
    try {
      const data = await kvGet(DB_NS, this.dbKey);
      if (data == null) {
        this.#loadFile();              // migrate file → DB
        if (this.positions.size > 0 || this.balance !== 1000) this.#save();
      } else {
        this.#apply(data);
        if (this.positions.size > 0) console.log(`[paper] restored ${this.positions.size} ${this.dbKey} position(s) from Postgres`);
      }
    } catch (err) {
      console.warn(`[paper] DB load failed: ${err.message}`);
    }
    return this;
  }

  #apply(data) {
    if (typeof data.balance === 'number') this.balance = data.balance;
    for (const [sym, p] of data.positions ?? []) this.positions.set(sym, p);
    for (const [id, o] of data.pendingLimits ?? []) this.pendingLimits.set(id, o);
  }

  #loadFile() {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      this.#apply(JSON.parse(readFileSync(this.statePath, 'utf8')));
      if (this.positions.size > 0) console.log(`[paper] restored ${this.positions.size} open position(s), balance $${this.balance.toFixed(2)}`);
    } catch (err) {
      console.warn(`[paper] state load failed: ${err.message}`);
    }
  }

  #save() {
    const snapshot = { balance: this.balance, positions: [...this.positions.entries()], pendingLimits: [...this.pendingLimits.entries()], savedAt: Date.now() };
    if (dbEnabled()) {
      kvSet(DB_NS, this.dbKey, snapshot).catch(err => { if (this.verbose) console.warn(`[paper] DB save failed: ${err.message}`); });
      return;
    }
    if (!this.statePath) return;
    try {
      const tmp = this.statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(snapshot));
      renameSync(tmp, this.statePath);
    } catch (err) {
      if (this.verbose) console.warn(`[paper] state save failed: ${err.message}`);
    }
  }

  async getBalance() { return this.balance; }

  // Paper instruments: assume fine granularity (real rounding doesn't matter
  // for simulation). Return permissive metadata.
  async getInstrument() {
    return { qtyStep: 0.0001, minQty: 0, tickSize: 0.0000001, maxLeverage: 25 };
  }

  async setLeverage() { /* no-op in paper */ }
  async setIsolatedAndLeverage() { return { isolated: true }; }   // paper: always "isolated"

  // Trailing-stop support: move an open position's SL (and optionally TP).
  setStop(symbol, { stopLoss = null, takeProfit = null } = {}) {
    const p = this.positions.get(symbol);
    if (!p) return false;
    if (stopLoss   != null) p.sl = Number(stopLoss);
    if (takeProfit != null) p.tp = Number(takeProfit);
    this.#save();
    return true;
  }

  async placeMarketOrder({ symbol, side, qty, stopLoss, takeProfit }) {
    const px = this.priceFn?.(symbol);
    if (!px || !isFinite(px)) throw new Error(`paper: no price for ${symbol}`);
    this.positions.set(symbol, {
      side, size: qty, entryPrice: px,
      sl: stopLoss ? Number(stopLoss) : null,
      tp: takeProfit ? Number(takeProfit) : null
    });
    this.#save();
    if (this.verbose) console.log(`[paper] OPEN ${side} ${symbol} ${qty} @ ${px}`);
    return { orderId: `paper-${symbol}-${Date.now()}`, avgPrice: px };
  }

  // REST a limit order until live price tags it (matching real Bybit), instead of
  // the old instant market fill — which filled every liquidity-grab entry at the
  // ideal price even when reality never reached it, so paper looked far rosier than
  // live (and "limit orders didn't work"). #fillPendingLimits (run each
  // resolveTouches tick) converts a touched limit into a position; the AutoTrader
  // then detects the fill, manages SL/TP, and cancels it via cancelOrder on expiry.
  async placeLimitOrder({ symbol, side, qty, price, stopLoss, takeProfit }) {
    const limitPrice = Number(price);
    if (!isFinite(limitPrice) || limitPrice <= 0) throw new Error(`paper: bad limit price for ${symbol}`);
    const orderId = `paper-limit-${symbol}-${Date.now()}`;
    this.pendingLimits.set(orderId, {
      symbol, side, qty: Number(qty), limitPrice,
      sl: stopLoss ? Number(stopLoss) : null,
      tp: takeProfit ? Number(takeProfit) : null,
      ts: Date.now(),
    });
    this.#save();
    if (this.verbose) console.log(`[paper] LIMIT rest ${side} ${symbol} ${qty} @ ${limitPrice} (awaiting touch)`);
    return { orderId, avgPrice: limitPrice };   // NOT filled yet — rests until touched
  }

  // Convert resting limits to positions once live price tags them. LONG (Buy) fills
  // when price falls to ≤ limit; SHORT (Sell) when price rises to ≥ limit. Fills at
  // the limit price. Run at the END of resolveTouches so a just-filled position is
  // first DETECTED as filled by the AutoTrader before any SL/TP check next tick.
  #fillPendingLimits() {
    for (const [orderId, o] of [...this.pendingLimits.entries()]) {
      const px = this.priceFn?.(o.symbol);
      if (!px || !isFinite(px)) continue;
      const touched = o.side === 'Buy' ? px <= o.limitPrice : px >= o.limitPrice;
      if (!touched) continue;
      this.pendingLimits.delete(orderId);
      this.positions.set(o.symbol, { side: o.side, size: o.qty, entryPrice: o.limitPrice, sl: o.sl, tp: o.tp });
      this.#save();
      if (this.verbose) console.log(`[paper] LIMIT FILLED ${o.side} ${o.symbol} @ ${o.limitPrice} (price touched ${px})`);
    }
  }

  // Cancel a resting limit (AutoTrader calls this when an unfilled limit expires).
  cancelOrder(symbol, orderId = null) {
    if (orderId && this.pendingLimits.delete(orderId)) { this.#save(); return { ok: true }; }
    let cancelled = 0;
    for (const [id, o] of [...this.pendingLimits.entries()]) if (o.symbol === symbol) { this.pendingLimits.delete(id); cancelled++; }
    if (cancelled) this.#save();
    return { ok: true, cancelled };
  }

  async getPositions() {
    return [...this.positions.entries()].map(([symbol, p]) => {
      const px = this.priceFn?.(symbol) ?? p.entryPrice;
      const dir = p.side === 'Buy' ? 1 : -1;
      const unrealisedPnl = (px - p.entryPrice) * dir * p.size;
      return { symbol, side: p.side, size: p.size, entryPrice: p.entryPrice, unrealisedPnl, leverage: p.leverage ?? 1 };
    });
  }

  async closePosition(symbol) {
    const p = this.positions.get(symbol);
    if (!p) return { orderId: null };
    const px = this.priceFn?.(symbol) ?? p.entryPrice;
    const dir = p.side === 'Buy' ? 1 : -1;
    const pnl = (px - p.entryPrice) * dir * p.size;
    this.balance += pnl;
    this.positions.delete(symbol);
    this.#save();
    if (this.verbose) console.log(`[paper] CLOSE ${symbol} @ ${px} pnl $${pnl.toFixed(2)}`);
    return { orderId: `paper-close-${Date.now()}`, exitPrice: px, pnlUsd: pnl };
  }

  // Paper-only: check each open position against live price for SL/TP touch.
  // Returns array of { symbol, exitPrice, pnlUsd, reason } for resolved ones.
  //
  // DIVERGENCE FROM LIVE (audit §3.21): this resolves on the SPOT TICK from
  // priceFn (~30s poll), not on 1m OHLCV high/low like SignalTracker. It misses
  // intra-poll wicks, so paper P&L is systematically slightly OVER-reported vs
  // live (a wick that hit SL then recovered is missed). For ground-truth
  // outcomes use SignalTracker (/stats) or live autotrade (closed-PnL §2.4);
  // treat paper as a fast-feedback approximation, not an accurate backtest.
  resolveTouches() {
    const resolved = [];
    for (const [symbol, p] of [...this.positions.entries()]) {
      const px = this.priceFn?.(symbol);
      if (!px || !isFinite(px)) continue;
      let hit = null;
      if (p.side === 'Buy') {
        if (p.sl && px <= p.sl) hit = 'SL';
        else if (p.tp && px >= p.tp) hit = 'TP';
      } else {
        if (p.sl && px >= p.sl) hit = 'SL';
        else if (p.tp && px <= p.tp) hit = 'TP';
      }
      if (hit) {
        const dir = p.side === 'Buy' ? 1 : -1;
        const exitPrice = hit === 'SL' ? p.sl : p.tp;
        const pnl = (exitPrice - p.entryPrice) * dir * p.size;
        this.balance += pnl;
        this.positions.delete(symbol);
        resolved.push({ symbol, exitPrice, pnlUsd: pnl, reason: hit });
        if (this.verbose) console.log(`[paper] ${hit} ${symbol} @ ${exitPrice} pnl $${pnl.toFixed(2)}`);
      }
    }
    if (resolved.length > 0) this.#save();
    // Fill resting limits AFTER the SL/TP sweep so a freshly-filled position is
    // surfaced to the AutoTrader (as a fill) before it's eligible for SL/TP.
    this.#fillPendingLimits();
    return resolved;
  }

  static roundQtyDown(qty) { return qty; }
  static roundPrice(price) { return price; }
}
