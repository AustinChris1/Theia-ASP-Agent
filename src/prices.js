import { EventEmitter } from 'node:events';
import { COINGECKO_BASE, cgHeaders } from './coingecko.js';
import { isStableSymbol } from './stables.js';

const COINGECKO_MARKETS = `${COINGECKO_BASE}/coins/markets`;
const SURGE_WINDOW_MS = 60_000;
const HISTORY_TTL_MS = 180_000;
const BATCH = 250; // /coins/markets max
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Universe-aware price monitor.
//
// PRIMARY (when a Singapore relay is configured): Bybit linear perps
// `/v5/market/tickers?category=linear` returns last price + 24h% + 24h turnover
// for ALL perps in ONE call. This is the SAME venue the bot trades and prices
// live on (getLastPerpPrice), so surge/movers/getPrice can never disagree with
// the entry/SL/TP price the user actually sees (the $H bug). Polled every
// `pollIntervalMs`, it's well inside Bybit's rate limits, free and unmetered.
//
// FALLBACK / SPOT-ONLY: CoinGecko `/coins/markets` covers the tokens Bybit
// doesn't list (low-cap spot-only names — which can't fire full signals anyway,
// they only need a price for flow USD-sizing). It runs on a SLOW cadence (every
// `cgEveryN` ticks ≈ 15min) for just those tokens, so a single free Demo key
// lasts indefinitely instead of being exhausted by a full all-universe poll. If
// the relay is absent or Bybit fails, CoinGecko transparently covers the FULL
// universe every tick — zero behavioural regression.
//
// (Universe MC / FDV / circulating-supply still come from universe.js on a 7-day
// cadence — the ticker feed doesn't provide those.)
export class PriceMonitor extends EventEmitter {
  constructor({ universe, surgePct = 3, pollIntervalMs = 60_000, minVolumeUsd = 500_000,
                relayBaseUrl = null, relayAuthSecret = null, cgEveryN = 15 }) {
    super();
    this.universe = universe;
    this.surgePct = surgePct;
    this.pollIntervalMs = pollIntervalMs;
    this.minVolumeUsd = minVolumeUsd;
    // Binance-via-relay price source (same relay used for Bybit + Binance funding).
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.cgEveryN = Math.max(1, cgEveryN);   // run CoinGecko every Nth tick when Binance is active

    this.lastPrice = new Map();   // cgId → price
    this.volume24h = new Map();   // cgId → 24h USD volume (combined — Bybit perp OR CoinGecko)
    this.futuresVol24h = new Map(); // cgId → Bybit perp 24h turnover (futures volume)
    this.spotVol24h = new Map();    // cgId → CoinGecko 24h volume (spot baseline) — for the futures/spot manipulation ratio
    this.priceChange24h = new Map();  // cgId → 24h % change
    this.history = new Map();     // cgId → [{ price, ts }]
    this.intervalId = null;
    this._tick = 0;
    this.binanceCovered = new Set();   // cgIds priced by Binance on the latest tick

    // ── Futures VOLUME-SPIKE trigger (opt-in) — the "futures volume +1300%" scam-pump
    // tell. Fire a both-sides eval when a token's perp 24h turnover jumps ≥ MULT × its
    // SLOW EMA baseline (so a sustained pump doesn't absorb its own spike) above an
    // absolute floor. Direction is the conductor's call (funding / manip / L-S), not the
    // spike itself. Per-token cooldown. Heuristic — tune against live data.
    this.volSpikeEnabled    = process.env.ENABLE_VOLUME_SPIKE === '1';
    this.volSpikeMult       = Number(process.env.VOL_SPIKE_MULT) || 3;
    this.volSpikeMinUsd     = Number(process.env.VOL_SPIKE_MIN_USD) || 5_000_000;
    this.volSpikeCooldownMs = (Number(process.env.VOL_SPIKE_COOLDOWN_MIN) || 60) * 60_000;
    this.volSpikeAlpha      = Number(process.env.VOL_SPIKE_BASELINE_ALPHA) || 0.02;
    this.volBaseline  = new Map();   // cgId → slow-EMA baseline of futures 24h turnover
    this.lastVolSpike = new Map();   // cgId → ts of last spike (cooldown)
  }

  // Sweep the tokens whose perp turnover refreshed this tick: update each slow-EMA
  // baseline and emit 'volumeSpike' when the current reading jumps past the multiple.
  // The spike is checked BEFORE the EMA absorbs it. First reading just seeds (no fire).
  #checkVolumeSpikes(now, covered) {
    if (!this.volSpikeEnabled) return;
    for (const cgId of covered) {
      const cur = this.futuresVol24h.get(cgId);
      if (!(cur > 0)) continue;
      const base = this.volBaseline.get(cgId);
      if (base === undefined) { this.volBaseline.set(cgId, cur); continue; }   // seed only
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
      this.volBaseline.set(cgId, this.volSpikeAlpha * cur + (1 - this.volSpikeAlpha) * base);   // slow EMA
    }
  }

  getPrice(cgId) { return this.lastPrice.get(cgId) ?? null; }
  get24hVolume(cgId) { return this.volume24h.get(cgId) ?? null; }
  getFuturesVolume(cgId) { return this.futuresVol24h.get(cgId) ?? null; }   // Bybit perp turnover
  getSpotVolume(cgId) { return this.spotVol24h.get(cgId) ?? null; }         // CoinGecko spot volume

  // Run a single poll cycle on demand (used by tests + any manual refresh).
  async pollOnce() { return this.#poll(); }

  // Top N gainers + losers over the last 24h. Filters stablecoins and
  // (by default) anything below the configured volume floor so we don't
  // pick up illiquid noise as a "mover".
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
    // Cap each side at half the pool so gainers and losers never OVERLAP when
    // the eligible set is small (audit §5, prices.js:51) — a token could
    // otherwise appear in BOTH lists.
    const half = Math.min(n, Math.floor(sorted.length / 2));
    return {
      gainers: sorted.slice(0, half),
      losers:  sorted.slice(sorted.length - half).reverse()
    };
  }

  async start() {
    const ids = this.universe.allCgIds();
    const mode = this.relayBaseUrl
      ? `Bybit tickers (relay, every ${this.pollIntervalMs/1000}s) + CoinGecko spot-only (every ${this.cgEveryN * this.pollIntervalMs/60000}min)`
      : `CoinGecko /coins/markets every ${this.pollIntervalMs/1000}s`;
    console.log(`[prices] price feed: ${mode} for ${ids.length} tokens`);
    await this.#poll();
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.error('[prices] poll error:', err.message));
    }, this.pollIntervalMs);
  }

  // Fetch Bybit linear-perp tickers (ALL USDT-perps, one call) via the relay.
  // Bybit is the venue the bot trades + prices live (getLastPerpPrice), so the
  // surge/movers/getPrice feed MUST come from the same place — otherwise movers
  // showed one exchange's "H" while the trade lived on Bybit's "H" (wildly
  // different prices). Returns Map<TOKEN_SYMBOL, { price, pct, vol }> or null.
  async #fetchBybitTickers() {
    if (!this.relayBaseUrl) return null;
    const path = `/v5/market/tickers?category=linear`;
    const url = this.relayBaseUrl ? `${this.relayBaseUrl}${path}` : `https://api.bybit.com${path}`;
    const opts = { signal: AbortSignal.timeout(20_000) };
    if (this.relayAuthSecret) opts.headers = { 'X-Proxy-Auth': this.relayAuthSecret };
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      const j = await res.json();
      const list = j?.result?.list;
      if (!Array.isArray(list)) return null;   // relay/error object → null
      const out = new Map();
      for (const t of list) {
        const s = t.symbol;
        // Linear USDT perps only — skip USDC-margined (…PERP) + odd symbols.
        if (typeof s !== 'string' || !/^[A-Z0-9]+USDT$/.test(s)) continue;
        const base = s.slice(0, -4).toUpperCase();
        const price = Number(t.lastPrice);
        if (!isFinite(price) || price <= 0) continue;
        const pct = Number(t.price24hPcnt) * 100;   // Bybit gives a fraction ("0.05" = 5%)
        const vol = Number(t.turnover24h);          // 24h turnover ≈ USD volume
        out.set(base, { price, pct: isFinite(pct) ? pct : null, vol: isFinite(vol) ? vol : null });
      }
      return out.size > 0 ? out : null;
    } catch (err) {
      console.warn(`[prices] Bybit tickers via relay failed: ${err.message}`);
      return null;
    }
  }

  async #poll() {
    this._tick++;
    const now = Date.now();

    // 1. Bybit fast feed (perp tokens) — one relay call covers all linear perps.
    const covered = new Set();
    if (this.relayBaseUrl) {
      const bn = await this.#fetchBybitTickers();
      if (bn) {
        for (const cgId of this.universe.allCgIds()) {
          const sym = this.universe.lookupByCgId(cgId)?.symbol?.toUpperCase();
          // EXACT symbol match only. Bybit prices some memes per-1000
          // ("1000PEPEUSDT") which won't match "PEPE" — we deliberately let
          // those fall through to CoinGecko rather than risk a 1000×-scaled
          // price on a live trade. Most tokens match directly.
          const t = sym ? bn.get(sym) : null;
          if (!t) continue;
          covered.add(cgId);
          if (t.vol != null) { this.volume24h.set(cgId, t.vol); this.futuresVol24h.set(cgId, t.vol); }
          if (t.pct != null) this.priceChange24h.set(cgId, t.pct);
          this.#applyPrice(cgId, t.price, now);
        }
        this.binanceCovered = covered;
        this.#checkVolumeSpikes(now, covered);   // perp turnover-spike sweep on the fresh readings
      }
    }

    // 2. CoinGecko — covers the tokens Binance can't. Full universe when Binance
    //    is inactive (relay off / fetch failed); otherwise just the UNCOVERED
    //    (spot-only) tokens on a slow cadence to preserve the free-tier quota.
    const binanceActive = covered.size > 0;
    // Run CoinGecko on the FIRST tick and every cgEveryN ticks thereafter.
    // ((tick-1) % N === 0) is correct for all N including 1 (% N === 1 would
    // never fire for N=1).
    const cgDue = !binanceActive || ((this._tick - 1) % this.cgEveryN === 0);
    if (cgDue) {
      const targetIds = binanceActive
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

  // Update last price + rolling history for one token and emit a 'surge' when
  // the 1-minute move clears the threshold. Shared by both price sources so the
  // surge semantics are identical regardless of where the price came from.
  #applyPrice(cgId, price, now) {
    this.lastPrice.set(cgId, price);
    const tokenInfo = this.universe.lookupByCgId(cgId);
    if (!tokenInfo) return;
    if (isStableSymbol(tokenInfo.symbol)) return; // never surge on stables

    const hist = this.history.get(cgId) ?? [];
    hist.push({ price, ts: now });
    while (hist.length && now - hist[0].ts > HISTORY_TTL_MS) hist.shift();
    this.history.set(cgId, hist);

    const past = hist.find(h => now - h.ts >= SURGE_WINDOW_MS);
    if (!past) return;
    const pctChange = ((price - past.price) / past.price) * 100;
    // Favored tokens (pinned + current hot movers) get a lower surge threshold
    // and bypass the volume floor.
    const favored = this.universe.isFavored?.(cgId);
    const effectiveSurgePct = favored ? Math.max(1.5, this.surgePct - 1) : this.surgePct;
    if (Math.abs(pctChange) >= effectiveSurgePct) {
      const vol24h = this.volume24h.get(cgId);
      if (!favored && this.minVolumeUsd > 0 && vol24h != null && vol24h < this.minVolumeUsd) {
        this.history.set(cgId, [{ price, ts: now }]); // reset history anyway
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
      this.history.set(cgId, [{ price, ts: now }]); // reset to avoid re-firing
    }
  }
}
