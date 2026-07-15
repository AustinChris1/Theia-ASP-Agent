import { EventEmitter } from 'node:events';
import { dbEnabled, kvGet, kvSet } from './db.js';

const REGIME_DB_NS = 'regime', REGIME_DB_KEY = 'enabled';

export class RegimeMonitor extends EventEmitter {
  constructor({ taService, symbol = 'BTC', pollIntervalMs = 5 * 60_000, highVolPct = 1.2, enabled = true, verbose = false }) {
    super();
    this.taService = taService;
    this.symbol = symbol;
    this.pollIntervalMs = pollIntervalMs;
    this.highVolPct = highVolPct;
    this.verbose = verbose;
    this.enabled = enabled;
    this.regime = null;
    this.intervalId = null;
  }

  get() { return this.regime; }

  isEnabled() { return this.enabled; }
  setEnabled(on) {
    this.enabled = !!on;

    if (dbEnabled()) kvSet(REGIME_DB_NS, REGIME_DB_KEY, this.enabled).catch(err => console.warn(`[regime] DB save failed: ${err.message}`));
    return this.enabled;
  }

  async start() {
    if (!this.taService) { console.warn('[regime] no taService — disabled'); return; }

    if (dbEnabled()) {
      try { const v = await kvGet(REGIME_DB_NS, REGIME_DB_KEY); if (typeof v === 'boolean') this.enabled = v; }
      catch (err) { console.warn(`[regime] DB load failed: ${err.message}`); }
    }
    console.log(`[regime] BTC market-regime detector every ${this.pollIntervalMs/60000}min (high-vol > ${this.highVolPct}% 1h ATR) — bias ${this.enabled ? 'ON' : 'OFF (detect-only, toggle with /regime on)'}`);

    this.#poll().catch(err => console.warn(`[regime] initial poll: ${err.message}`));
    const warmup = setInterval(() => {
      if (this.regime) { clearInterval(warmup); return; }
      this.#poll().catch(err => console.warn(`[regime] warmup poll: ${err.message}`));
    }, 15_000);
    warmup.unref?.();
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.warn(`[regime] poll: ${err.message}`));
    }, this.pollIntervalMs);
    this.intervalId.unref?.();
  }

  async refresh() {
    for (let i = 0; i < 3 && !this.regime; i++) {
      try { await this.#poll(); } catch (err) { console.warn(`[regime] refresh attempt ${i + 1}: ${err.message}`); }
      if (!this.regime && i < 2) await new Promise(r => setTimeout(r, 1500));
    }
    if (!this.regime) {
      const has = this.taService?.perpSymbolMap?.has?.(this.symbol);
      console.warn(`[regime] refresh FAILED — ${this.symbol} TA unavailable (perpMap has ${this.symbol}: ${has}, coinalyze: ${!!this.taService?.coinalyze}) — likely a transient Coinalyze OHLCV failure; the 15s warm-up will keep retrying.`);
    }
    return this.regime;
  }

  async #poll() {
    const ta = await this.taService.analyze(this.symbol, 'LONG');
    const m = ta?.metadata;
    if (!m) return;
    const t1 = m['1hour']?.trend, t4 = m['4hour']?.trend, td = m['daily']?.trend;
    const downs = [t1, t4, td].filter(t => t === 'down').length;
    const ups   = [t1, t4, td].filter(t => t === 'up').length;

    let regime;
    if (t4 === 'down' && td === 'down') regime = 'BTC_DOWN';
    else if (t4 === 'up' && td === 'up') regime = 'BTC_UP';
    else if (downs >= 2 && ups === 0)   regime = 'BTC_DOWN';
    else if (ups >= 2 && downs === 0)   regime = 'BTC_UP';
    else                                regime = 'CHOP';

    const acute = (regime === 'BTC_DOWN' && t1 === 'down' && t4 === 'down')
               || (regime === 'BTC_UP'   && t1 === 'up'   && t4 === 'up');

    const atr1h = m['1hour']?.atr, px = m['1hour']?.lastClose;
    const volPct = (atr1h && px) ? (atr1h / px) * 100 : null;
    const highVol = volPct != null && volPct > this.highVolPct;

    const prev = this.regime?.regime;
    this.regime = { regime, acute, highVol, volPct, trends: { '1hour': t1, '4hour': t4, daily: td }, updatedAt: Date.now() };
    if (regime !== prev) {
      console.log(`[regime] BTC → ${regime}${acute ? ' (acute)' : ''}${highVol ? ' high-vol' : ''} | 1h=${t1} 4h=${t4} 1d=${td} vol=${volPct?.toFixed(2)}%`);
      this.emit('regime', this.regime);
    }
  }
}

export function regimeScoreForSide(side, regime, { penalty = 1.0, tailwind = 0.3 } = {}) {
  if (!regime) return null;
  const fightsDown = side === 'LONG'  && regime.regime === 'BTC_DOWN';
  const fightsUp   = side === 'SHORT' && regime.regime === 'BTC_UP';
  const alignsDown = side === 'SHORT' && regime.regime === 'BTC_DOWN';
  const alignsUp   = side === 'LONG'  && regime.regime === 'BTC_UP';

  if (fightsDown || fightsUp) {
    const pts = -(regime.acute ? penalty * 1.5 : penalty);
    const word = regime.regime === 'BTC_DOWN' ? 'downtrend' : 'uptrend';
    const acuteWord = regime.acute ? (regime.regime === 'BTC_DOWN' ? ' (actively dumping)' : ' (actively ripping)') : '';
    return { points: Number(pts.toFixed(2)), kind: 'regime',
      text: `🌍 BTC in ${word}${acuteWord} — ${side} fights the macro (most ${side}s get invalidated when BTC leads)` };
  }
  if (alignsDown || alignsUp) {
    const word = regime.regime === 'BTC_DOWN' ? 'downtrend' : 'uptrend';
    return { points: tailwind, kind: 'regime', text: `🌍 BTC ${word} — macro tailwind for ${side}` };
  }
  return null;
}
