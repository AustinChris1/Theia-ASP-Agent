import { EventEmitter } from 'node:events';
import { COINGECKO_BASE, cgHeaders } from './coingecko.js';
import { isStableSymbol } from './stables.js';

const COINGECKO_MARKETS = `${COINGECKO_BASE}/coins/markets`;
const SURGE_WINDOW_MS = 60_000;
const HISTORY_TTL_MS = 180_000;
const BATCH = 250;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class PriceMonitor extends EventEmitter {
  constructor({ universe, surgePct = 3, pollIntervalMs = 60_000, minVolumeUsd = 500_000,
                okx = null, cgEveryN = 15 }) {
    super();
    this.universe = universe;
    this.surgePct = surgePct;
    this.pollIntervalMs = pollIntervalMs;
    this.minVolumeUsd = minVolumeUsd;

    this.okx = okx;
    this.cgEveryN = Math.max(1, cgEveryN);

    this.lastPrice = new Map();
    this.volume24h = new Map();
    this.futuresVol24h = new Map();
    this.spotVol24h = new Map();
    this.priceChange24h = new Map();
    this.history = new Map();
    this.intervalId = null;
    this._tick = 0;
    this.okxCovered = new Set();

    this.volSpikeEnabled    = process.env.ENABLE_VOLUME_SPIKE === '1';
    this.volSpikeMult       = Number(process.env.VOL_SPIKE_MULT) || 3;
    this.volSpikeMinUsd     = Number(process.env.VOL_SPIKE_MIN_USD) || 5_000_000;
    this.volSpikeCooldownMs = (Number(process.env.VOL_SPIKE_COOLDOWN_MIN) || 60) * 60_000;
    this.volSpikeAlpha      = Number(process.env.VOL_SPIKE_BASELINE_ALPHA) || 0.02;
    this.volBaseline  = new Map();
    this.lastVolSpike = new Map();
  }

  #checkVolumeSpikes(now, covered) {
    if (!this.volSpikeEnabled) return;
    for (const cgId of covered) {
      const cur = this.futuresVol24h.get(cgId);
      if (!(cur > 0)) continue;
      const base = this.volBaseline.get(cgId);
      if (base === undefined) { this.volBaseline.set(cgId, cur); continue; }
      if (cur >= base * this.volSpikeMult && cur >= this.volSpikeMinUsd) {
        const last = this.lastVolSpike.get(cgId) ?? 0;
        if (now - last >= this.volSpikeCooldownMs) {
          this.lastVolSpike.set(cgId, now);
          const t = this.universe.lookupByCgId(cgId);
          if (t?.symbol) {
            console.log(`[vol-spike] ${t.symbol} perp turnover $${(cur / 1e6).toFixed(1)}M = ${(cur / base).toFixed(1)}× baseline → evaluating`);
            this.emit('volumeSpike', { token: { symbol: t.symbol, coingeckoId: cgId }, turnover: cur, baseline: base, ratio: cur / base, timestamp: now });
          }
        }
      }
      this.volBaseline.set(cgId, this.volSpikeAlpha * cur + (1 - this.volSpikeAlpha) * base);
    }
  }

  getPrice(cgId) { return this.lastPrice.get(cgId) ?? null; }
  get24hVolume(cgId) { return this.volume24h.get(cgId) ?? null; }
  getFuturesVolume(cgId) { return this.futuresVol24h.get(cgId) ?? null; }
  getSpotVolume(cgId) { return this.spotVol24h.get(cgId) ?? null; }

  async pollOnce() { return this.#poll(); }

  getTopMovers(n = 10) {
    const eligible = [];
    for (const [cgId, pct] of this.priceChange24h.entries()) {
      if (!isFinite(pct)) continue;
      const t = this.universe.lookupByCgId(cgId);
      if (!t) continue;
      if (isStableSymbol(t.symbol)) continue;
      const vol = this.volume24h.get(cgId);
      if (this.minVolumeUsd > 0 && vol != null && vol < this.minVolumeUsd) continue;
      eligible.push({ cgId, symbol: t.symbol, pct, vol });
    }
    const sorted = [...eligible].sort((a, b) => b.pct - a.pct);

    const half = Math.min(n, Math.floor(sorted.length / 2));
    return {
      gainers: sorted.slice(0, half),
      losers:  sorted.slice(sorted.length - half).reverse()
    };
  }

  async start() {
    const ids = this.universe.allCgIds();
    const mode = this.okx
      ? `OKX SWAP tickers (every ${this.pollIntervalMs/1000}s) + CoinGecko spot-only (every ${this.cgEveryN * this.pollIntervalMs/60000}min)`
      : `CoinGecko /coins/markets every ${this.pollIntervalMs/1000}s`;
    console.log(`[prices] price feed: ${mode} for ${ids.length} tokens`);
    await this.#poll();
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.error('[prices] poll error:', err.message));
    }, this.pollIntervalMs);
  }

  async #fetchOkxTickers() {
    if (!this.okx) return null;
    try {
      return await this.okx.getSwapTickers();
    } catch (err) {
      console.warn(`[prices] OKX tickers failed: ${err.message}`);
      return null;
    }
  }

  async #poll() {
    this._tick++;
    const now = Date.now();

    const covered = new Set();
    if (this.okx) {
      const bn = await this.#fetchOkxTickers();
      if (bn) {
        for (const cgId of this.universe.allCgIds()) {
          const sym = this.universe.lookupByCgId(cgId)?.symbol?.toUpperCase();

          const t = sym ? bn.get(sym) : null;
          if (!t) continue;
          covered.add(cgId);
          if (t.vol != null) { this.volume24h.set(cgId, t.vol); this.futuresVol24h.set(cgId, t.vol); }
          if (t.pct != null) this.priceChange24h.set(cgId, t.pct);
          this.#applyPrice(cgId, t.price, now);
        }
        this.okxCovered = covered;
        this.#checkVolumeSpikes(now, covered);
      }
    }

    const okxActive = covered.size > 0;

    const cgDue = !okxActive || ((this._tick - 1) % this.cgEveryN === 0);
    if (cgDue) {
      const targetIds = okxActive
        ? this.universe.allCgIds().filter(id => !covered.has(id))
        : this.universe.allCgIds();
      await this.#pollCoinGecko(targetIds, now);
    }
  }

  async #pollCoinGecko(ids, now) {
    if (!ids || ids.length === 0) return;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const url = `${COINGECKO_MARKETS}?vs_currency=usd&ids=${batch.join(',')}&per_page=${BATCH}&page=1&sparkline=false&price_change_percentage=24h`;
      try {
        const res = await fetch(url, { headers: cgHeaders(), signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          if (res.status === 429) { console.warn(`[prices] CoinGecko 429 — backing off`); return; }
          console.warn(`[prices] CoinGecko HTTP ${res.status}`);
          continue;
        }
        const data = await res.json();
        for (const m of data) {
          if (typeof m.total_volume === 'number') { this.volume24h.set(m.id, m.total_volume); this.spotVol24h.set(m.id, m.total_volume); }
          const pct = m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h;
          if (typeof pct === 'number') this.priceChange24h.set(m.id, pct);
          if (typeof m.current_price === 'number') this.#applyPrice(m.id, m.current_price, now);
        }
      } catch (err) {
        console.warn(`[prices] CoinGecko batch ${i/BATCH + 1} failed: ${err.message}`);
      }
      if (i + BATCH < ids.length) await sleep(1500);
    }
  }

  #applyPrice(cgId, price, now) {
    this.lastPrice.set(cgId, price);
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return;
    if (isStableSymbol(tokenInfo.symbol)) return;

    const hist = this.history.get(cgId) ?? [];
    hist.push({ price, ts: now });
    while (hist.length && now - hist[0].ts > HISTORY_TTL_MS) hist.shift();
    this.history.set(cgId, hist);

    const past = hist.find(h => now - h.ts >= SURGE_WINDOW_MS);
    if (!past) return;
    const pctChange = ((price - past.price) / past.price) * 100;

    const favored = this.universe.isFavored?.(cgId);
    const effectiveSurgePct = favored ? Math.max(1.5, this.surgePct - 1) : this.surgePct;
    if (Math.abs(pctChange) >= effectiveSurgePct) {
      const vol24h = this.volume24h.get(cgId);
      if (!favored && this.minVolumeUsd > 0 && vol24h != null && vol24h < this.minVolumeUsd) {
        this.history.set(cgId, [{ price, ts: now }]);
        return;
      }
      this.emit('surge', {
        token: { symbol: tokenInfo.symbol, coingeckoId: cgId },
        direction: pctChange > 0 ? 'up' : 'down',
        pctChange,
        open: past.price,
        close: price,
        high: Math.max(past.price, price),
        low: Math.min(past.price, price),
        timestamp: now
      });
      this.history.set(cgId, [{ price, ts: now }]);
    }
  }
}
