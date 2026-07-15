

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const FUNDING_DB_NS = 'funding', FUNDING_DB_KEY = 'state';
const NEUTRAL_BAND = 0.0001;
const ELEVATED     = 0.0005;
const EXTREME      = 0.001;

const STATE_TTL_MS = 2 * 60 * 60_000;

const MAX_PLAUSIBLE_FUNDING = 0.05;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class FundingMonitor extends EventEmitter {
  constructor({ coinalyze, perpSymbolMap, universe, pollIntervalMs = 5 * 60_000, batchSize = 20, cachePath = null, okx = null, okxSwapMap = null }) {
    super();
    this.coinalyze = coinalyze;
    this.perpSymbolMap = perpSymbolMap;
    this.universe = universe;

    this.okx = okx;
    this.okxSwapMap = okxSwapMap;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.bySymbol = new Map();
    this.intervalId = null;

    this.cachePath = cachePath;
    if (cachePath) {
      const dir = dirname(cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  async #load() {
    let data = null;
    if (dbEnabled()) {
      try {
        data = await kvGet(FUNDING_DB_NS, FUNDING_DB_KEY);
        if (data == null && this.cachePath && existsSync(this.cachePath)) {
          data = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        }
      } catch (err) { console.warn(`[funding] DB cache load failed: ${err.message}`); return; }
    } else {
      if (!this.cachePath || !existsSync(this.cachePath)) return;
      try { data = JSON.parse(readFileSync(this.cachePath, 'utf8')); }
      catch (err) { console.warn(`[funding] cache load failed: ${err.message}`); return; }
    }
    if (!data) return;
    try {
      const age = Date.now() - (data.savedAt ?? 0);
      if (age > STATE_TTL_MS) {
        console.log(`[funding] cache stale (${(age / 60_000).toFixed(0)}min old > ${STATE_TTL_MS / 60_000}min TTL) — discarding`);
        return;
      }
      let loaded = 0;
      for (const [sym, entry] of Object.entries(data.bySymbol ?? {})) {
        if (entry?.summary) {
          this.bySymbol.set(sym, entry);
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[funding] restored ${loaded} tokens from cache (${(age / 60_000).toFixed(0)}min old) — leaders/signals usable immediately, next poll refreshes`);
      }
    } catch (err) {
      console.warn(`[funding] cache load failed: ${err.message}`);
    }
  }

  #save() {
    const obj = { savedAt: Date.now(), bySymbol: Object.fromEntries(this.bySymbol) };
    if (dbEnabled()) {
      kvSet(FUNDING_DB_NS, FUNDING_DB_KEY, obj).catch(err => console.warn(`[funding] DB cache save failed: ${err.message}`));
      return;
    }
    if (!this.cachePath) return;
    try {
      const tmp = this.cachePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.cachePath);
    } catch (err) {
      console.warn(`[funding] cache save failed: ${err.message}`);
    }
  }

  getByCgId(cgId) {
    const info = this.universe.lookupByCgId(cgId);
    if (!info?.symbol) return null;
    return this.bySymbol.get(info.symbol.toUpperCase()) ?? null;
  }

  async ensureBySymbol(symbol, price = null) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym || !this.okx) return this.bySymbol.get(sym) ?? null;
    const existing = this.bySymbol.get(sym);

    if (existing?.summary?.source === 'okx' && Date.now() - (existing.summary.updatedAt ?? 0) < 60_000) {
      return existing;
    }

    const inst = this.okxSwapMap?.get(sym) || `${sym}-USDT-SWAP`;
    try {
      const [fr, oi] = await Promise.all([this.okx.getFundingRate(inst), this.okx.getOpenInterest(inst)]);
      if (!fr && !oi) return existing ?? null;
      const now = Date.now();
      const totalOi = (oi?.oiCcy != null && price > 0) ? oi.oiCcy * price : (existing?.summary?.totalOi ?? null);
      const summary = {
        avg: fr?.fundingRate ?? existing?.summary?.avg ?? null,
        min: fr?.fundingRate ?? null,
        max: fr?.fundingRate ?? null,
        previousAvg: existing?.summary?.avg ?? null,
        delta: null,
        totalOi,
        previousOi: existing?.summary?.totalOi ?? null,
        oiDelta: null,
        oiDeltaPct: null,
        updatedAt: now,
        source: 'okx',
      };
      const rec = { rates: [{ exchange: inst, rate: summary.avg, oi: totalOi, ts: now }], summary };
      this.bySymbol.set(sym, rec);
      return rec;
    } catch {
      return existing ?? null;
    }
  }

  async registerSymbol(symbol) {
    const sym = (symbol ?? '').toUpperCase();
    if (!sym || !this.coinalyze || !this.perpSymbolMap) return false;
    if (this.perpSymbolMap.has(sym)) return true;
    try {
      const perp = await this.coinalyze.resolvePerp(sym);
      if (!perp) return false;
      this.perpSymbolMap.set(sym, perp);
      console.log(`[funding] registered ${sym} → ${perp} (runtime add)`);
      return true;
    } catch (err) {
      console.warn(`[funding] registerSymbol ${sym} failed: ${err.message}`);
      return false;
    }
  }

  async start() {
    if (!this.coinalyze || this.perpSymbolMap.size === 0) {
      console.warn('[funding] no Coinalyze client / empty perp map — disabled');
      return;
    }

    await this.#load();
    console.log(`[funding] polling Coinalyze every ${this.pollIntervalMs/1000}s for ${this.perpSymbolMap.size} perps`);

    this.#poll().catch(err => console.error('[funding] initial poll err:', err.message));
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.error('[funding] poll err:', err.message));
    }, this.pollIntervalMs);
  }

  async #poll() {
    const perpSymbols = [...this.perpSymbolMap.values()];
    const fundingByPerp = new Map();
    const oiByPerp = new Map();
    const totalBatches = Math.ceil(perpSymbols.length / this.batchSize);
    const startedAt = Date.now();

    let rejected = 0;
    let fundingBatch = 0;
    for (let i = 0; i < perpSymbols.length; i += this.batchSize) {
      const batch = perpSymbols.slice(i, i + this.batchSize);
      fundingBatch++;
      try {
        const data = await this.coinalyze.fundingRate(batch);
        for (const entry of data ?? []) {
          const v = entry.value;
          if (typeof v !== 'number' || !isFinite(v)) continue;
          if (Math.abs(v) > MAX_PLAUSIBLE_FUNDING) { rejected++; continue; }
          fundingByPerp.set(entry.symbol, v);
        }
      } catch (err) {
        console.warn(`[funding] funding batch ${fundingBatch}/${totalBatches} failed: ${err.message}`);
      }

      if (fundingBatch % 5 === 0 || fundingBatch === totalBatches) {
        const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(`[funding] funding fetch ${fundingBatch}/${totalBatches} batches done (${fundingByPerp.size} rates, ${elapsedMin}min)`);
      }
      await sleep(200);
    }
    if (rejected > 0) {
      console.log(`[funding] rejected ${rejected} implausible funding values (>${MAX_PLAUSIBLE_FUNDING*100}% per period)`);
    }

    this.#applyUpdates(fundingByPerp, oiByPerp, true);
    this.#save();
    console.log(`[funding] phase 1 done — ${fundingByPerp.size} funding rates available; fetching OI...`);

    const ratesArr = [...this.bySymbol.entries()].map(([sym, d]) => ({ sym, rate: d.summary.avg }));
    const mostNeg = ratesArr.sort((a, b) => a.rate - b.rate).slice(0, 5);
    const mostPos = ratesArr.slice(-5).reverse();
    const fmt = (e) => `${e.sym}=${(e.rate * 100).toFixed(4)}%`;
    console.log(`[funding] most negative: ${mostNeg.map(fmt).join('  ')}`);
    console.log(`[funding] most positive: ${mostPos.map(fmt).join('  ')}`);

    let oiBatch = 0;
    for (let i = 0; i < perpSymbols.length; i += this.batchSize) {
      const batch = perpSymbols.slice(i, i + this.batchSize);
      oiBatch++;
      try {
        const data = await this.coinalyze.openInterest(batch, 'true');
        for (const entry of data ?? []) {
          if (typeof entry.value === 'number') oiByPerp.set(entry.symbol, entry.value);
        }
      } catch (err) {
        console.warn(`[funding] OI batch ${oiBatch}/${totalBatches} failed: ${err.message}`);
      }
      if (oiBatch % 5 === 0 || oiBatch === totalBatches) {
        const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(`[funding] OI fetch ${oiBatch}/${totalBatches} batches done (${oiByPerp.size} OI, ${elapsedMin}min total)`);
      }
      await sleep(200);
    }

    const updated = this.#applyUpdates(fundingByPerp, oiByPerp, false);
    this.#save();
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`[funding] poll complete in ${elapsedMin}min — ${updated} tokens with funding+OI`);

    await this.#enrichVelocities();
  }

  async #enrichVelocities() {

    const candidates = [];
    for (const [token, data] of this.bySymbol.entries()) {
      const avg = data?.summary?.avg;
      if (typeof avg !== 'number' || Math.abs(avg) < ELEVATED) continue;
      const perp = this.perpSymbolMap.get(token);
      if (perp) candidates.push({ token, perp, avg });
    }
    candidates.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
    const top = candidates.slice(0, 50);
    if (top.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const from = now - 8 * 3600;
    let enriched = 0;
    for (let i = 0; i < top.length; i += this.batchSize) {
      const batch = top.slice(i, i + this.batchSize);
      const perps = batch.map(b => b.perp);
      let data;
      try {
        data = await this.coinalyze.fundingRateHistory(perps, '1hour', from, now);
      } catch (err) {
        console.warn(`[funding] velocity history batch failed: ${err.message}`);
        continue;
      }

      const perpToToken = new Map(batch.map(b => [b.perp, b.token]));
      for (const entry of data ?? []) {
        const token = perpToToken.get(entry.symbol);
        if (!token) continue;
        const hist = Array.isArray(entry.history) ? entry.history : [];
        if (hist.length < 2) continue;

        const bars = hist
          .map(b => ({ t: b.t ?? b.timestamp ?? 0, c: Number(b.c ?? b.close ?? b.value ?? NaN) }))
          .filter(b => isFinite(b.c));
        if (bars.length < 2) continue;

        const latest = bars[bars.length - 1].c;
        const oldest = bars[0].c;

        const oneBack = bars[bars.length - 2]?.c;
        const fourBack = bars[bars.length - 5]?.c ?? oldest;
        const velocity1h = oneBack != null ? latest - oneBack : null;
        const velocity4h = fourBack != null ? latest - fourBack : null;

        const cur = this.bySymbol.get(token);
        if (cur?.summary) {
          cur.summary.velocity1h = velocity1h;
          cur.summary.velocity4h = velocity4h;
          enriched++;
        }
      }
      await sleep(200);
    }
    if (enriched > 0) {
      console.log(`[funding] velocity enriched for ${enriched}/${top.length} top-funding tokens (1h + 4h rolling)`);
      this.#save();
    }
  }

  #applyUpdates(fundingByPerp, oiByPerp, partial) {
    const now = Date.now();
    let updated = 0;
    for (const [token, perp] of this.perpSymbolMap.entries()) {
      const rate = fundingByPerp.get(perp);
      if (rate == null) continue;
      const oi = oiByPerp.get(perp) ?? null;

      const prev = this.bySymbol.get(token)?.summary ?? null;

      const previousOi = prev?.totalOi ?? null;
      const effectiveOi = oi != null ? oi : (partial ? previousOi : null);
      const oiDelta = oi != null && previousOi != null ? oi - previousOi : null;
      const oiDeltaPct = oiDelta != null && previousOi > 0 ? (oiDelta / previousOi) * 100 : null;

      this.bySymbol.set(token, {
        rates: [{ exchange: perp, rate, oi: effectiveOi, ts: now }],
        summary: {
          avg: rate,
          min: rate,
          max: rate,
          previousAvg: prev?.avg ?? null,
          delta: prev?.avg != null ? rate - prev.avg : null,
          totalOi: effectiveOi,
          previousOi,
          oiDelta,
          oiDeltaPct,
          updatedAt: now
        }
      });
      updated++;
    }
    return updated;
  }
}

export function fundingScoreForSide(side, summary) {
  if (!summary || typeof summary.avg !== 'number') return null;
  const avg = summary.avg;

  if (side === 'LONG') {
    if (avg <= -EXTREME)       return 2;
    if (avg <= -ELEVATED)      return 1.5;
    if (avg <= -NEUTRAL_BAND)  return 0.5;
    if (Math.abs(avg) <= NEUTRAL_BAND) return 0;
    if (avg <= ELEVATED)       return 0;

    if (avg <= EXTREME)        return -1;
    return -2;
  }

  if (avg >= EXTREME)          return 2;
  if (avg >= ELEVATED)         return 1.5;
  if (avg >= NEUTRAL_BAND)     return 0.5;
  if (Math.abs(avg) <= NEUTRAL_BAND) return 0;
  if (avg >= -ELEVATED)        return 0;

  if (avg >= -EXTREME)         return -1;
  return -2;
}

export function describeFunding(side, summary, intervalHrs = 1) {
  if (!summary || typeof summary.avg !== 'number') return null;
  const avg = summary.avg;
  const displayed = avg * (intervalHrs / 8);
  const decimals = intervalHrs === 1 ? 4 : 3;
  const pct = (displayed * 100).toFixed(decimals);
  const unit = `%/${intervalHrs}h`;

  if (side === 'LONG') {
    if (avg <= -EXTREME)
      return `${pct}${unit} — *deeply negative*, overcrowded shorts → strong short squeeze potential ✅ *strongly supports LONG*`;
    if (avg <= -ELEVATED)
      return `${pct}${unit} — negative, shorts crowded ✅ *supports LONG via squeeze potential*`;
    if (avg <= -NEUTRAL_BAND)
      return `${pct}${unit} — mildly negative, slight short bias 🟢 *mild LONG support*`;
    if (Math.abs(avg) <= NEUTRAL_BAND)
      return `${pct}${unit} — neutral ⚪`;
    if (avg <= ELEVATED)
      return `${pct}${unit} — mildly positive, healthy bullish positioning 🟢 *mild LONG support (trend continuation)*`;
    if (avg <= EXTREME)
      return `${pct}${unit} — positive, longs getting crowded ⚠️ *caution: late LONG entry*`;
    return `${pct}${unit} — *extremely positive*, overcrowded longs ⚠️ *WARNING: long squeeze risk despite signal*`;
  }

  if (avg >= EXTREME)
    return `${pct}${unit} — *extremely positive*, overcrowded longs → strong long squeeze potential ✅ *strongly supports SHORT*`;
  if (avg >= ELEVATED)
    return `${pct}${unit} — positive, longs crowded ✅ *supports SHORT via squeeze potential*`;
  if (avg >= NEUTRAL_BAND)
    return `${pct}${unit} — mildly positive, slight long bias 🟢 *mild SHORT support*`;
  if (Math.abs(avg) <= NEUTRAL_BAND)
    return `${pct}${unit} — neutral ⚪`;
  if (avg >= -ELEVATED)
    return `${pct}${unit} — mildly negative, healthy bearish positioning 🟢 *mild SHORT support (trend continuation)*`;
  if (avg >= -EXTREME)
    return `${pct}${unit} — negative, shorts getting crowded ⚠️ *caution: late SHORT entry*`;
  return `${pct}${unit} — *extremely negative*, overcrowded shorts ⚠️ *WARNING: short squeeze risk despite signal*`;
}

const OI_FRESH_CREDIT = (() => { const v = Number(process.env.OI_FRESH_CREDIT); return isFinite(v) ? v : 0.5; })();
export function oiScoreForSide(side, summary, surgeDirection) {
  if (!summary || summary.oiDeltaPct == null) return null;
  const oiUp = summary.oiDeltaPct > 1;
  const oiDown = summary.oiDeltaPct < -1;

  if (side === 'LONG' && surgeDirection === 'up') {
    if (oiUp) return OI_FRESH_CREDIT;
    if (oiDown) return -0.25;
  }
  if (side === 'SHORT' && surgeDirection === 'down') {
    if (oiUp) return OI_FRESH_CREDIT;
    if (oiDown) return -0.25;
  }
  return 0;
}

export function describeOI(summary) {
  if (!summary?.totalOi) return null;
  const sizeStr = summary.totalOi >= 1e9
    ? `$${(summary.totalOi / 1e9).toFixed(2)}B`
    : `$${(summary.totalOi / 1e6).toFixed(1)}M`;
  if (summary.oiDeltaPct == null) return `${sizeStr} _(no prior reading)_`;

  const dp = summary.oiDeltaPct;
  const arrow = dp > 0.5 ? '📈' : dp < -0.5 ? '📉' : '➡️';
  const trend = dp >  5 ? ' — *aggressive expansion* (fresh positions piling in)'
              : dp >  1 ? ' — expanding (new positions opening)'
              : dp > -1 ? ' — stable'
              : dp > -5 ? ' — contracting (positions closing)'
                        : ' — *aggressive unwind* (major position closing)';
  return `${sizeStr} ${arrow} ${dp >= 0 ? '+' : ''}${dp.toFixed(2)}%${trend}`;
}

export function fundingLeaders(monitor, topN = 5, minVenues = 1, minOiUsd = 10_000_000, offset = 0) {
  const entries = [];
  for (const [sym, data] of monitor.bySymbol) {
    if (data?.summary?.avg == null) continue;
    if ((data.rates?.length ?? 0) < minVenues) continue;

    const oi = data.summary.totalOi;
    if (oi != null && oi < minOiUsd) continue;
    entries.push({
      symbol: sym,
      avg: data.summary.avg,
      venues: data.rates.length,
      oi: data.summary.totalOi,
      oiDeltaPct: data.summary.oiDeltaPct
    });
  }
  if (entries.length === 0) return null;
  const sortedAsc = [...entries].sort((a, b) => a.avg - b.avg);
  const sortedDesc = [...sortedAsc].reverse();

  const negSlice = sortedAsc.slice(offset, offset + topN);
  const posSlice = sortedDesc.slice(offset, offset + topN);
  return {
    mostNegative: negSlice,
    mostPositive: posSlice,
    eligibleCount: entries.length,
    minOiUsd,
    offset,
    topN
  };
}

export function formatFundingLeaders(leaders, intervalHrs = 1) {
  if (!leaders) return null;
  const decimals = intervalHrs === 1 ? 4 : 3;
  const unit = `%/${intervalHrs}h`;
  const fmt = (e) => {
    const displayed = e.avg * (intervalHrs / 8);
    const pct = (displayed * 100).toFixed(decimals);
    const sign = e.avg >= 0 ? '+' : '';
    const oi = e.oi
      ? (e.oi >= 1e9 ? `$${(e.oi / 1e9).toFixed(2)}B` : `$${(e.oi / 1e6).toFixed(0)}M`)
      : '—';
    const arrow = e.oiDeltaPct == null ? ''
      : e.oiDeltaPct > 1 ? ' 📈'
      : e.oiDeltaPct < -1 ? ' 📉'
      : ' ➡️';
    return `*${e.symbol}* ${sign}${pct}${unit} — OI ${oi}${arrow}`;
  };
  const minOiStr = leaders.minOiUsd >= 1e9
    ? `$${(leaders.minOiUsd/1e9).toFixed(1)}B`
    : `$${(leaders.minOiUsd/1e6).toFixed(0)}M`;
  const rangeStr = leaders.offset > 0
    ? ` _(showing rank ${leaders.offset + 1}–${leaders.offset + leaders.topN})_`
    : '';
  return `📊 *Funding Rate Leaders* _(per ${intervalHrs}h)_${rangeStr}

_📖 How to read:_
_• *Negative* funding → shorts crowded → squeeze pushes price UP → trade *LONG*_
_• *Positive* funding → longs crowded → squeeze pushes price DOWN → trade *SHORT*_
_• OI = leveraged position size; bigger OI = bigger potential squeeze_

🟢 *Most negative* → *LONG bias* (short-squeeze potential):
${leaders.mostNegative.map(fmt).join('\n')}

🔴 *Most positive* → *SHORT bias* (long-squeeze potential):
${leaders.mostPositive.map(fmt).join('\n')}

_${leaders.eligibleCount} markets eligible (OI ≥ ${minOiStr})_`;
}

export function signalStrength(fundingScore, oiScore = 0, liquidationScore = 0) {
  const total = 2 + (fundingScore ?? 0) + (oiScore ?? 0) + (liquidationScore ?? 0);
  if (total >= 4.5)  return { label: 'VERY HIGH', emoji: '🔥', total };
  if (total >= 3)    return { label: 'HIGH',      emoji: '✅', total };
  if (total >= 2)    return { label: 'MEDIUM',    emoji: '🟡', total };
  if (total >= 1)    return { label: 'LOW',       emoji: '🟠', total };
  return                    { label: 'MIXED',     emoji: '⚠️', total };
}
