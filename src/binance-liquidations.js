// Real-time liquidation source — Binance USDⓈ-M futures `!forceOrder@arr` stream.
//
// WHY THIS EXISTS: the Coinalyze `/liquidation-history` feed the bot used reports
// a tiny fraction of reality — during a 63k→66k BTC squeeze its biggest 1-minute
// BTC bucket was ~$33K, while Binance liquidated millions. So liquidation alerts
// never fired. Binance's only public all-market liquidation feed is this WS
// (there is NO REST endpoint for it), reporting every individual forced order the
// instant it fills. We bucket per symbol over a short window and emit the SAME
// `liquidation` event shape the existing notifier + conductor already consume.
//
// GEO NOTE: the host is geo-blocked from Binance (REST goes via the Singapore
// relay), and the relay is REST-only — it can't carry a WS. So this connects
// DIRECT. If the host can't reach fstream.binance.com it will log the failure and
// keep retrying (harmless) — that's the signal that a non-US WS forwarder/proxy
// is needed. Toggle with BINANCE_LIQ_WS=0.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const DEFAULT_WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const CONNECT_TIMEOUT_MS = 15_000;   // no 'open' within this → treat as geo-blocked, log + retry

// Pure + testable. Binance forceOrder `o`: { s:symbol, S:side, q:qty, p:price,
// ap:avgPrice, ... }. side SELL = a LONG was force-closed (long liquidation);
// side BUY = a SHORT was force-closed. Maps the Binance symbol to the bot's token
// (handles 1000×/1e6× meme prefixes). Returns { token, usd, side } | null.
export function parseForceOrder(o, symbolToToken) {
  if (!o || !o.s) return null;
  let token = symbolToToken.get(o.s);
  if (!token) {
    const stripped = o.s.replace(/^1000000|^1000/, '');   // 1000PEPEUSDT → PEPEUSDT
    token = symbolToToken.get(stripped);
  }
  if (!token) return null;                                  // not a tracked symbol
  const price = Number(o.ap ?? o.p);
  const qty = Number(o.q);
  if (!(price > 0) || !(qty > 0)) return null;
  return { token, usd: price * qty, side: o.S === 'SELL' ? 'long' : 'short' };
}

export class BinanceLiquidations extends EventEmitter {
  constructor({ symbolToToken, url = DEFAULT_WS_URL, minLiquidationUsd = 250_000, windowMs = 60_000, cooldownMs = 60_000, verbose = false }) {
    super();
    this.url = url;                         // Binance direct (geo-blocked) OR a non-US WS forwarder
    this.symbolToToken = symbolToToken;     // Map: 'BTCUSDT' → 'BTC'
    this.minLiquidationUsd = minLiquidationUsd;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.verbose = verbose;
    this.buckets = new Map();                // token → { long, short, ts }
    this.lastAlert = new Map();              // token → ts (de-spam a sustained cascade)
    this.ws = null;
    this.reconnectMs = 1000;
    this.stopped = false;
    this._count = 0;
    // Observability: the stream is otherwise silent between "connected" and a
    // ≥threshold alert, so you can't tell it's alive. A heartbeat logs frame +
    // tracked-liquidation counts each interval; BINANCE_LIQ_DEBUG=1 logs every one.
    this.debug = process.env.BINANCE_LIQ_DEBUG === '1';
    this.heartbeatMs = (Number(process.env.BINANCE_LIQ_HEARTBEAT_MIN) || 10) * 60_000;
    this._hb = { frames: 0, liqs: 0, maxUsd: 0, maxSym: null };
    this._hbTimer = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
    this._hbTimer = setInterval(() => this.#heartbeat(), this.heartbeatMs);
    this._hbTimer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this._hbTimer); clearTimeout(this._noDataTimer); try { this.ws?.close(); } catch { /* ignore */ } }

  // Periodic proof-of-life so "are liquidations working?" is answerable from the
  // logs even when nothing crosses the alert threshold.
  #heartbeat() {
    const { frames, liqs, maxUsd, maxSym } = this._hb;
    if (frames === 0) {
      console.warn(`[binance-liq] ⚠️ 0 frames in ${Math.round(this.heartbeatMs / 60000)}min — WS stalled/disconnected?`);
    } else {
      const largest = maxSym ? `${maxSym} $${Math.round(maxUsd).toLocaleString()}` : 'none on tracked symbols';
      console.log(`[binance-liq] alive — ${frames} liquidations streamed, ${liqs} on tracked symbols (largest ${largest}) in ${Math.round(this.heartbeatMs / 60000)}min · alerts fire ≥ $${this.minLiquidationUsd.toLocaleString()}/min/symbol`);
    }
    this._hb = { frames: 0, liqs: 0, maxUsd: 0, maxSym: null };
  }

  #connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) { return this.#scheduleReconnect(`construct: ${e.message}`); }
    this.ws = ws;
    // A geo-blocked host doesn't get a clean error — Binance blackholes the
    // connection and it hangs in CONNECTING forever. Force the issue with a timer.
    const connectTimer = setTimeout(() => {
      console.warn('[binance-liq] connect TIMEOUT — host likely geo-blocked from Binance. Point BINANCE_LIQ_WS_URL at a non-US WS forwarder, or set BINANCE_LIQ_WS=0.');
      try { ws.terminate(); } catch { /* ignore */ }
    }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => {
      clearTimeout(connectTimer);
      this.reconnectMs = 1000;
      this._gotFrame = false;
      console.log(`[binance-liq] connected (${this.url})`);
      // "connected" ≠ "receiving". A geo-restricted host can OPEN the socket but
      // get zero data pushed. If no frame arrives in 30s, say so loudly — that's
      // the cue the WS needs a non-US egress (the forwarder), not just a connection.
      this._noDataTimer = setTimeout(() => {
        if (!this._gotFrame) console.warn('[binance-liq] ⚠️ connected but 0 frames in 30s — Binance accepts the socket but sends NO data to this IP (geo-restricted). Deploy tools/binance-liq-forwarder.js on a non-US host + set BINANCE_LIQ_WS_URL.');
      }, 30_000);
    });
    ws.on('message', (data) => {
      this._hb.frames++;
      if (!this._gotFrame) { this._gotFrame = true; clearTimeout(this._noDataTimer); console.log('[binance-liq] receiving data ✓ — liquidation stream is LIVE'); }
      try { this.#onMessage(JSON.parse(data.toString())); } catch { /* ignore bad frame */ }
    });
    ws.on('error', (err) => { clearTimeout(connectTimer); clearTimeout(this._noDataTimer); console.warn(`[binance-liq] ws error: ${err.message}`); });
    ws.on('close', (code) => { clearTimeout(connectTimer); clearTimeout(this._noDataTimer); this.#scheduleReconnect(`closed ${code}`); });
  }

  #scheduleReconnect(why) {
    if (this.stopped) return;
    console.warn(`[binance-liq] reconnecting in ${this.reconnectMs}ms (${why})`);
    setTimeout(() => this.#connect(), this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);   // exp backoff, cap 30s
  }

  #onMessage(msg) {
    const parsed = parseForceOrder(msg?.o, this.symbolToToken);
    if (!parsed) return;
    const { token, usd, side } = parsed;
    this._hb.liqs++;
    if (usd > this._hb.maxUsd) { this._hb.maxUsd = usd; this._hb.maxSym = token; }
    if (this.debug) console.log(`[binance-liq] ${token} ${side} liq $${Math.round(usd).toLocaleString()}`);
    const now = Date.now();
    let b = this.buckets.get(token);
    if (!b || now - b.ts > this.windowMs) b = { long: 0, short: 0, ts: now };
    b[side] += usd;
    this.buckets.set(token, b);

    const total = b.long + b.short;
    if (total < this.minLiquidationUsd) return;
    const last = this.lastAlert.get(token) ?? 0;
    if (now - last < this.cooldownMs) return;          // one alert per cooldown per symbol
    this.lastAlert.set(token, now);
    this.buckets.delete(token);                         // reset window after alerting

    const dominantSide = b.long > b.short ? 'longs' : 'shorts';
    this.emit('liquidation', {
      symbol: token,
      source: 'binance-ws',
      timestamp: now,
      longLiq: Math.round(b.long),
      shortLiq: Math.round(b.short),
      total: Math.round(total),
      dominantSide,
      dominantUsd: Math.round(Math.max(b.long, b.short)),
      // shorts wiped → forced BUYING → upward pressure → LONG bias (mirrors the
      // Coinalyze path so the conductor + notifier treat both sources identically).
      bias: dominantSide === 'shorts' ? 'long' : 'short',
    });
  }
}
