// Bybit liquidation source — POLLS the Fly-Tokyo forwarder's /liquidations buffer
// (the forwarder holds the Bybit `allLiquidation` WS; see binance-liq-forwarder/).
//
// WHY POLL, NOT WS: Binance geo-blocks DATA to cloud IPs (Fly Tokyo got 0 frames),
// so Binance's WS is dead for us. Bybit serves data globally AND is the venue the bot
// actually trades — but the bot's Render↔Fly path is flaky (intermittent "fetch
// failed"), so a persistent WS would keep dropping. Polling an incremental REST
// endpoint (?sinceId=N) is resilient: each poll is independent + retried, and the
// forwarder's 10-min buffer means a missed poll loses nothing.
//
// We bucket per token per minute, apply the SAME OI-% significance model as the
// Coinalyze monitor, and emit the SAME `liquidation` event shape so the notifier +
// conductor + stats consume it unchanged.
import { EventEmitter } from 'node:events';
import { liquidationSignificance } from './liquidations.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pure + testable. Rolling SLIDING-window rollup of recent liquidation entries.
// The old per-calendar-minute bucket reset to zero every minute, so a cascade that
// bleeds (say) $50k/min for 5 min never accumulated past the floor — the exact
// "building cascade" we most want to catch was thrown away at each minute boundary.
// This keeps all entries within the last windowMs and sums them, so a sustained
// cascade adds up. Drops entries older than the window. Returns the kept list +
// long/short/total sums (USD).
export function rollupLiquidationWindow(entries, now, windowMs) {
  const cutoff = now - windowMs;
  const kept = [];
  let long = 0, short = 0;
  for (const x of entries ?? []) {
    if (!x || x.ts < cutoff) continue;
    kept.push(x);
    if (x.side === 'long') long += x.usd; else short += x.usd;
  }
  return { kept, long, short, total: long + short };
}

// Pure + testable. Bybit perp 'BTCUSDT' → bot token 'BTC'; handles 1000×/1e6× meme
// prefixes (1000PEPEUSDT → PEPE). Returns the token symbol or null if not tracked.
export function bybitSymbolToToken(symbol, tokenSet) {
  let s = String(symbol || '').toUpperCase();
  if (!s.endsWith('USDT')) return null;
  s = s.slice(0, -4);                                  // strip USDT
  if (tokenSet.has(s)) return s;
  const stripped = s.replace(/^1000000|^1000/, '');    // 1000PEPE → PEPE
  if (stripped !== s && tokenSet.has(stripped)) return stripped;
  return null;
}

export class BybitLiquidations extends EventEmitter {
  constructor({ forwarderUrl, tokenSet, getOiUsd = null, pollIntervalMs = 20_000, minLiquidationUsd = 75_000, oiPct = 0.0002, minFloorUsd = 30_000, windowMs = 180_000, cooldownMs = 60_000 }) {
    super();
    this.url = String(forwarderUrl).replace(/\/$/, '');
    this.tokenSet = tokenSet;                 // Set<string> of known token symbols (uppercase)
    this.getOiUsd = getOiUsd || (() => null); // token → OI USD (reuse the Coinalyze OI cache)
    this.pollIntervalMs = pollIntervalMs;
    this.minLiquidationUsd = minLiquidationUsd;
    this.oiPct = oiPct;
    this.minFloorUsd = minFloorUsd;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.lastId = 0;
    this.primed = false;
    this.buckets = new Map();                 // token → { long, short, minuteKey }
    this.lastAlert = new Map();               // token → ts (de-spam a sustained cascade)
    this.stopped = false;
    this._timer = null;
    this._polls = 0; this._emitted = 0;
  }

  start() {
    this.stopped = false;
    console.log(`[bybit-liq] polling ${this.url}/liquidations every ${this.pollIntervalMs / 1000}s — significance over a ${(this.windowMs / 60_000)}min sliding window: ≥${(this.oiPct * 100).toFixed(3)}% of OI OR ≥$${this.minLiquidationUsd.toLocaleString()} abs (dust floor $${this.minFloorUsd.toLocaleString()})`);
    this.#loop();
  }
  stop() { this.stopped = true; clearTimeout(this._timer); }

  async #loop() {
    if (this.stopped) return;
    try { await this.#poll(); }
    catch (e) { console.warn(`[bybit-liq] poll failed: ${e.message}`); }
    if (!this.stopped) { this._timer = setTimeout(() => this.#loop(), this.pollIntervalMs); this._timer.unref?.(); }
  }

  // Retry transient Render↔Fly blips ("fetch failed") before giving up the tick.
  async #fetchNew() {
    let lastErr;
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(`${this.url}/liquidations?sinceId=${this.lastId}`, { signal: AbortSignal.timeout(12_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) { lastErr = e; if (i < 3) await sleep(700 * i); }
    }
    throw lastErr;
  }

  async #poll() {
    const data = await this.#fetchNew();
    this._polls++;
    const serverLastId = Number.isFinite(data?.lastId) ? data.lastId : this.lastId;
    // On boot, skip the buffered backlog (up to 10 min old) — only alert on NEW
    // liquidations after we start, never stale ones from before a restart.
    if (!this.primed) {
      this.primed = true;
      this.lastId = serverLastId;
      console.log(`[bybit-liq] primed at id ${this.lastId} (forwarder bybit up=${data?.up}) — backlog skipped`);
      return;
    }
    this.lastId = Math.max(this.lastId, serverLastId);
    const rows = data?.liquidations || [];
    for (const e of rows) this.#ingest(e);
    if (this._polls % 15 === 0) {
      console.log(`[bybit-liq] alive — lastId=${this.lastId}, ${this._emitted} alerts emitted total, ${rows.length} new this poll`);
    }
  }

  #ingest(e) {
    const token = bybitSymbolToToken(e?.symbol, this.tokenSet);
    if (!token) return;
    const usd = Number(e.usd);
    if (!(usd > 0)) return;
    const ts = Number(e.ts) || Date.now();
    const now = Date.now();

    // SLIDING window: append this liquidation, drop anything older than windowMs,
    // sum the rest. A multi-minute cascade accumulates instead of resetting each
    // minute (the old per-calendar-minute bucket lost building cascades).
    const arr = this.buckets.get(token) ?? [];
    arr.push({ ts, usd, side: e.side });
    const { kept, long, short, total } = rollupLiquidationWindow(arr, now, this.windowMs);
    this.buckets.set(token, kept);

    const oiUsd = this.getOiUsd(token) ?? 0;
    const sig = liquidationSignificance({ totalUsd: total, oiUsd, minFloorUsd: this.minFloorUsd, oiPct: this.oiPct, absUsd: this.minLiquidationUsd });
    if (!sig.fire) return;

    const last = this.lastAlert.get(token) ?? 0;
    if (now - last < this.cooldownMs) return;     // one alert per cooldown per symbol
    this.lastAlert.set(token, now);

    const dominantSide = long > short ? 'longs' : 'shorts';
    this._emitted++;
    this.emit('liquidation', {
      symbol: token,
      source: 'bybit-ws',
      timestamp: now,
      longLiq: Math.round(long),
      shortLiq: Math.round(short),
      total: Math.round(total),
      oiUsd, oiFrac: sig.oiFrac, basis: sig.basis,
      dominantSide,
      dominantUsd: Math.round(Math.max(long, short)),
      // shorts wiped → forced BUYING → upward pressure → LONG bias (mirrors the
      // Coinalyze + Binance paths so the conductor treats all sources identically).
      bias: dominantSide === 'shorts' ? 'long' : 'short',
    });
  }
}
