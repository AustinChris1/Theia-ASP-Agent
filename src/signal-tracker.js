

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dbEnabled, kvGet, kvSet, kvAll } from './db.js';

const DB_NS = 'signals', DB_KEY = 'all';

const isBankedWinRunner = (r) => !r?.outcome && (Number(r?.tpHit) || 0) >= 1;

const BE_TRIGGER_PCT = Number(process.env.BE_TRIGGER_PCT ?? 2.0);
const BE_OFFSET_PCT  = Number(process.env.BE_OFFSET_PCT ?? 0.1);

const BE_SL_FRAC     = Number(process.env.BE_SL_FRAC ?? 0.35);

const TRAIL_GAP_PCT  = Number(process.env.TRAIL_GAP_PCT ?? 2.0);
const TRAIL_SL_FRAC  = Number(process.env.TRAIL_SL_FRAC ?? 0.30);

const RESOLVE_DIVERGENCE_PCT = Number(process.env.RESOLVE_DIVERGENCE_PCT ?? 12);

const RESOLVE_FRESH_MS = Number(process.env.RESOLVE_FRESH_MIN ?? 12) * 60_000;

export class SignalTracker extends EventEmitter {
  constructor({ path, priceMonitor, taService = null, sheetLogger = null, checkIntervalMs = 5 * 60_000, validityMs = 24 * 60 * 60_000 }) {
    super();
    this.path = path;
    this.priceMonitor = priceMonitor;
    this.taService = taService;
    this.sheetLogger = sheetLogger;
    this.checkIntervalMs = checkIntervalMs;
    this.defaultValidityMs = validityMs;

    this.priceTrails = new Map();
    this.intervalId = null;

    this.resetGen = 0;

    this.openKeys = new Set();

    this.records = [];
    if (!dbEnabled()) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadRecords();
      this.#syncOpenKeys();
    }
  }

  async init() {
    if (!dbEnabled()) return this;
    try {
      const rows = await kvGet(DB_NS, DB_KEY);
      if (rows == null) {
        this.#loadRecords();
        if (this.records.length) { this.#persistAll(); console.log(`[signal-tracker] migrated ${this.records.length} from file → Postgres`); }
      } else {
        this.records = rows;
      }
    } catch (err) {
      console.warn(`[signal-tracker] DB load failed: ${err.message}`);
    }
    this.#syncOpenKeys();
    return this;
  }

  #loadRecords() {
    if (!existsSync(this.path)) { this.records = []; return; }
    try {
      this.records = readFileSync(this.path, 'utf8')
        .split('\n').filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch (err) {
      console.warn(`[signal-tracker] read failed: ${err.message}`);
      this.records = [];
    }
  }

  #syncOpenKeys() {
    this.openKeys = new Set();
    for (const r of this.records) {
      if (!r.outcome && r.symbol && r.side) this.openKeys.add(`${String(r.symbol).toUpperCase()}|${r.side}`);
    }
  }

  #openKey(symbol, side) { return `${String(symbol ?? '').toUpperCase()}|${side}`; }

  record(signal) {

    const sym = signal.token?.symbol;
    const side = signal.side;

    const key = sym && side ? this.#openKey(sym, side) : null;
    if (key && this.openKeys.has(key)) {
      console.log(`[signal-tracker] skip duplicate ${side} ${sym} — open signal already exists`);
      return false;
    }

    const plan = signal.tradePlan ?? {};
    const isLG = plan.isLiquidityGrab === true && plan.limitEntry != null;
    const effectiveEntry = isLG ? plan.limitEntry : plan.entry;

    const record = {
      ts: Date.now(),
      side: signal.side,
      symbol: signal.token.symbol,
      cgId: signal.token.coingeckoId,
      chain: signal.token.chain ?? null,
      score: Number(signal.strength.total.toFixed(3)),
      strength: signal.strength.label,
      trigger: signal.trigger.type,
      reasons: (signal.reasons ?? []).map(r => ({ kind: r.kind, points: r.points })),
      entry: effectiveEntry ?? null,
      marketEntry: plan.entry ?? null,
      limitEntry:  plan.limitEntry ?? null,
      isLiquidityGrab: isLG,
      awaitingLimit: isLG,
      limitFilledAt: null,
      sl:    plan.sl ?? null,
      tp1:   plan.tp1 ?? null,
      tp2:   plan.tp2 ?? null,
      tp3:   plan.tp3 ?? null,
      horizon: plan.horizon ?? null,
      atrTf:   plan.atrTf ?? null,
      alignmentCount: plan.alignmentCount ?? null,
      alignedTfs: Array.isArray(plan.alignedTfs) ? plan.alignedTfs : null,
      validityHrs: plan.validityHrs ?? null,

      tpHit: 0,
      tpHitAt: null,

      outcome: null,
      outcomeAt: null,
      maxFavorable: null,
      maxAdverse: null
    };
    try {
      this.records.push(record);
      this.#appendPersist(record);
      if (key) this.openKeys.add(key);
      return true;
    } catch (err) {
      console.warn(`[signal-tracker] append failed: ${err.message}`);
      return false;
    }
  }

  start() {
    this.intervalId = setInterval(() => {
      this.resolveOpen().catch(err => console.error('[signal-tracker]', err.message));
    }, this.checkIntervalMs).unref();
    console.log(`[signal-tracker] resolving open signals every ${this.checkIntervalMs/60000}min → ${this.path}`);
  }

  #readAll() { return [...this.records]; }

  currentRecords() { return [...this.records]; }

  async allRecords() {
    if (dbEnabled()) {
      try {
        const rows = await kvAll(DB_NS);
        const out = [];
        for (const { val } of rows) if (Array.isArray(val)) out.push(...val);
        return out;
      } catch (err) {
        console.warn(`[signal-tracker] allRecords DB read failed: ${err.message}`);
        return [...this.records];
      }
    }

    const out = [];
    try {
      const dir = dirname(this.path);
      const files = readdirSync(dir)
        .filter(f => /^signals(\.\d+T\d+)?\.jsonl$/i.test(f))
        .map(f => join(dir, f));
      for (const f of files) {
        let lines;
        try { lines = readFileSync(f, 'utf8').split('\n').filter(l => l.trim()); }
        catch { continue; }
        for (const line of lines) {
          try { out.push(JSON.parse(line)); } catch {  }
        }
      }
    } catch {  }
    return out;
  }

  #appendPersist(record) {
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, this.records).catch(err => console.warn(`[signal-tracker] DB write failed: ${err.message}`));
      return;
    }
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  #persistAll() {
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, this.records).catch(err => console.warn(`[signal-tracker] DB write failed: ${err.message}`));
      return;
    }
    writeFileSync(this.path, this.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  #scan(sig, bars, alreadyTp = 0) {
    const isLong = sig.side === 'LONG';
    const finalLevel = sig.tp3 ? 3 : sig.tp2 ? 2 : 1;
    const tpPriceOf = { 1: sig.tp1, 2: sig.tp2, 3: sig.tp3 };

    const ordered = [...bars].sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    let hi = -Infinity, lo = Infinity;
    let reached = alreadyTp;
    let beArmed = false;
    let trailLockPct = 0;
    const beStop = isLong ? sig.entry * (1 + BE_OFFSET_PCT / 100)
                          : sig.entry * (1 - BE_OFFSET_PCT / 100);

    const riskPct = (sig.entry > 0 && sig.sl > 0) ? Math.abs((sig.sl - sig.entry) / sig.entry) * 100 : 0;
    const beArmPct = Math.max(BE_TRIGGER_PCT, BE_SL_FRAC * riskPct);
    const beTrigger = isLong ? sig.entry * (1 + beArmPct / 100)
                             : sig.entry * (1 - beArmPct / 100);
    const trailGap = Math.max(TRAIL_GAP_PCT, TRAIL_SL_FRAC * riskPct);
    const newTps = [];
    for (const b of ordered) {

      if (Number.isFinite(Number(b.t)) && Number(b.t) < sig.ts) continue;
      const h = Number(b.h), l = Number(b.l);
      if (!isFinite(h) || !isFinite(l)) continue;
      hi = Math.max(hi, h); lo = Math.min(lo, l);

      let barTp = 0;
      if (isLong) {
        if (sig.tp3 && h >= sig.tp3)      barTp = 3;
        else if (sig.tp2 && h >= sig.tp2) barTp = 2;
        else if (sig.tp1 && h >= sig.tp1) barTp = 1;
      } else {
        if (sig.tp3 && l <= sig.tp3)      barTp = 3;
        else if (sig.tp2 && l <= sig.tp2) barTp = 2;
        else if (sig.tp1 && l <= sig.tp1) barTp = 1;
      }
      const newTpThisBar = barTp > reached;

      const trailStop = isLong ? sig.entry * (1 + trailLockPct / 100)
                               : sig.entry * (1 - trailLockPct / 100);
      const protectiveStop = beArmed ? (trailLockPct > BE_OFFSET_PCT ? trailStop : beStop) : sig.sl;
      const stopLevel = reached >= 2 ? sig.tp1 : reached >= 1 ? sig.entry : protectiveStop;
      const hitStop = isLong ? l <= stopLevel : h >= stopLevel;

      if (hitStop && newTpThisBar) {

        if (reached >= 1) {
          return { newTps, terminal: { outcome: `WIN_TP${reached}`, exitPrice: stopLevel, breakeven: true }, hi, lo, reached };
        }

        return { newTps, terminal: { outcome: 'AMBIGUOUS', exitPrice: null, ambiguous: true }, hi, lo, reached };
      }
      if (hitStop) {
        if (reached >= 1) {

          return { newTps, terminal: { outcome: `WIN_TP${reached}`, exitPrice: stopLevel, breakeven: true }, hi, lo, reached };
        }
        if (beArmed) {
          if (trailLockPct > BE_OFFSET_PCT) {

            return { newTps, terminal: { outcome: 'WIN_TRAIL', exitPrice: stopLevel, breakeven: false }, hi, lo, reached };
          }

          return { newTps, terminal: { outcome: 'BREAKEVEN', exitPrice: beStop, breakeven: true }, hi, lo, reached };
        }
        return { newTps, terminal: { outcome: 'LOSS', exitPrice: sig.sl }, hi, lo, reached };
      }
      if (newTpThisBar) {
        for (let lvl = reached + 1; lvl <= barTp; lvl++) newTps.push(lvl);
        reached = barTp;
        if (reached >= finalLevel) {
          return { newTps, terminal: { outcome: `WIN_TP${reached}`, exitPrice: tpPriceOf[reached] }, hi, lo, reached };
        }
      }

      if (BE_TRIGGER_PCT > 0 && !beArmed && reached === 0) {
        if (isLong ? h >= beTrigger : l <= beTrigger) beArmed = true;
      }

      if (TRAIL_GAP_PCT >= 0 && beArmed && reached === 0) {
        const peakPct = isLong ? (hi - sig.entry) / sig.entry * 100
                               : (sig.entry - lo) / sig.entry * 100;
        const lockPct = peakPct - trailGap;
        if (lockPct > trailLockPct) trailLockPct = lockPct;
      }
    }
    return { newTps, terminal: null, hi, lo, reached };
  }

  async resolveOpen() {
    const startGen = this.resetGen;
    const all = this.#readAll();
    if (all.length === 0) return;
    const open = all.filter(r => !r.outcome);
    if (open.length === 0) {
      this.#logSummary(all);
      return;
    }

    let resolvedCount = 0;
    let progressCount = 0;
    const now = Date.now();

    for (const sig of open) {
      if (!sig.entry || !sig.sl || !sig.tp1) {

        sig.outcome = 'NO_PLAN';
        sig.outcomeAt = now;
        this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
        resolvedCount++;
        continue;
      }

      const existing = this.priceTrails.get(sig.ts);

      const fromMs = Math.max(sig.ts, existing?.lastChecked ?? sig.ts) - 60_000;
      const fromTs = Math.floor(fromMs / 1000);
      const toTs = Math.floor(now / 1000);

      let barHigh = -Infinity, barLow = Infinity, barClose = null;
      let bars = null;
      if (this.taService?.getRecentBars) {
        try { bars = await this.taService.getRecentBars(sig.symbol, fromTs, toTs); } catch {}
      }
      if (Array.isArray(bars) && bars.length > 0) {
        for (const b of bars) {
          if (isFinite(b.h)) barHigh = Math.max(barHigh, b.h);
          if (isFinite(b.l)) barLow  = Math.min(barLow,  b.l);
        }
        barClose = bars[bars.length - 1].c;
      } else {

        const px = this.priceMonitor?.getPrice(sig.cgId);
        if (px == null) continue;
        barHigh = px;
        barLow = px;
        barClose = px;
      }

      const trail = existing ?? { high: barHigh, low: barLow, lastChecked: sig.ts };

      const price = barClose;

      let justFilled = false;
      if (sig.awaitingLimit) {

        const validityMs = sig.validityHrs ? sig.validityHrs * 60 * 60_000 : this.defaultValidityMs;
        if (now - sig.ts >= validityMs) {
          sig.outcome = 'EXPIRED_UNFILLED';
          sig.outcomeAt = now;
          this.priceTrails.delete(sig.ts);
          this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
          resolvedCount++;
          if (this.sheetLogger) {
            this.sheetLogger.updateOutcome({
              ts: sig.ts, outcome: sig.outcome, outcomeAt: now,
              maxFavorable: null, maxAdverse: null, finalPnlPct: null
            }).catch(() => {});
          }
          this.emit('resolved', { ...sig, resolvedPrice: price });
          continue;
        }
        const limit = sig.limitEntry ?? sig.entry;
        const filled = sig.side === 'SHORT'
          ? barHigh >= limit
          : barLow  <= limit;

        if (filled) {
          sig.awaitingLimit = false;
          sig.limitFilledAt = now;

          trail.high = limit;
          trail.low  = limit;
          trail.lastChecked = now;
          this.priceTrails.set(sig.ts, trail);
          justFilled = true;
          console.log(`[signal-tracker] ${sig.symbol} ${sig.side} limit filled @ ${limit}`);

        } else {
          this.priceTrails.set(sig.ts, trail);
          continue;
        }
      }

      const scanBars = (Array.isArray(bars) && bars.length)
        ? bars
        : [{ o: barClose, h: barHigh, l: barLow, c: barClose, t: sig.ts }];
      const scan = justFilled ? null : this.#scan(sig, scanBars, sig.tpHit ?? 0);
      const touch = scan?.terminal ?? null;

      if (!justFilled) {
        const hi = scan && isFinite(scan.hi) ? scan.hi : barHigh;
        const lo = scan && isFinite(scan.lo) ? scan.lo : barLow;
        trail.high = Math.max(trail.high, hi);
        trail.low  = Math.min(trail.low,  lo);
        trail.lastChecked = now;
        this.priceTrails.set(sig.ts, trail);
      }

      if (scan && !touch && scan.reached > (sig.tpHit ?? 0)) {
        const prev = sig.tpHit ?? 0;
        sig.tpHit = scan.reached;
        sig.tpHitAt = now;
        for (const lvl of scan.newTps) {
          if (lvl <= prev) continue;
          const tpPrice = lvl === 1 ? sig.tp1 : lvl === 2 ? sig.tp2 : sig.tp3;
          this.emit('tpProgress', { ...sig, tpLevel: lvl, tpPrice, reachedPrice: barClose });
          progressCount++;
          console.log(`[signal-tracker] ${sig.symbol} ${sig.side} TP${lvl} hit @ ${tpPrice} — trade stays open${lvl >= 1 ? ' (SL → breakeven)' : ''}`);
        }
        this.priceTrails.set(sig.ts, trail);
      }

      sig.maxFavorable = sig.side === 'LONG'
        ? ((trail.high - sig.entry) / sig.entry) * 100
        : ((sig.entry - trail.low) / sig.entry) * 100;
      sig.maxAdverse = sig.side === 'LONG'
        ? ((trail.low - sig.entry) / sig.entry) * 100
        : ((sig.entry - trail.high) / sig.entry) * 100;

      if (touch) {
        let outcome = touch.outcome;

        const windowFresh = (now - fromMs) <= RESOLVE_FRESH_MS;
        if (windowFresh && (String(outcome).startsWith('WIN') || outcome === 'LOSS') && isFinite(touch.exitPrice)) {
          const ref = this.priceMonitor?.getPrice?.(sig.cgId);
          if (isFinite(ref) && ref > 0) {
            const divPct = Math.abs(ref - touch.exitPrice) / touch.exitPrice * 100;
            if (divPct > RESOLVE_DIVERGENCE_PCT) {
              console.warn(`[signal-tracker] ${sig.symbol} ${sig.side} ${outcome} REJECTED as data-suspect — exit ${touch.exitPrice} diverges ${divPct.toFixed(0)}% from live ${ref} (phantom kline wick); excluded from win-rate`);
              outcome = 'AMBIGUOUS';
              touch.exitPrice = null;
              touch.ambiguous = true;
              touch.breakeven = false;
            }
          }
        }
        sig.outcome = outcome;
        sig.outcomeAt = now;
        sig.ambiguous = touch.ambiguous ?? false;
        sig.breakeven = touch.breakeven ?? false;
        if (scan && scan.reached > (sig.tpHit ?? 0)) { sig.tpHit = scan.reached; sig.tpHitAt = now; }

        let exitPrice = touch.exitPrice;
        if (outcome === 'LOSS' && isFinite(exitPrice)) {
          const SLIP = 0.001;
          exitPrice = sig.side === 'LONG' ? exitPrice * (1 - SLIP) : exitPrice * (1 + SLIP);
        }
        sig.finalPnlPct = (outcome === 'AMBIGUOUS' || !isFinite(exitPrice)) ? null : Number((sig.side === 'LONG'
          ? ((exitPrice - sig.entry) / sig.entry) * 100
          : ((sig.entry - exitPrice) / sig.entry) * 100
        ).toFixed(3));
        this.priceTrails.delete(sig.ts);
        this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
        resolvedCount++;
        if (outcome === 'AMBIGUOUS') {
          console.log(`[signal-tracker] ${sig.symbol} ${sig.side} AMBIGUOUS — SL and TP both wicked in one 1m bar; excluded from win-rate`);
        }

        if (this.sheetLogger) {
          this.sheetLogger.updateOutcome({
            ts: sig.ts, outcome, outcomeAt: now,
            maxFavorable: sig.maxFavorable, maxAdverse: sig.maxAdverse,
            finalPnlPct: sig.finalPnlPct
          }).catch(() => {});
        }

        this.emit('resolved', { ...sig, resolvedPrice: isFinite(exitPrice) ? exitPrice : price });
        continue;
      }

      const validityMs = sig.validityHrs ? sig.validityHrs * 60 * 60_000 : this.defaultValidityMs;
      const holdStart = sig.limitFilledAt ?? sig.ts;
      if (now - holdStart >= validityMs) {
        const banked = sig.tpHit ?? 0;
        if (banked >= 1) {

          const tpPrice = banked === 1 ? sig.tp1 : banked === 2 ? sig.tp2 : sig.tp3;
          sig.outcome = `WIN_TP${banked}`;
          sig.finalPnlPct = Number((sig.side === 'LONG'
            ? ((tpPrice - sig.entry) / sig.entry) * 100
            : ((sig.entry - tpPrice) / sig.entry) * 100).toFixed(3));
          sig.outcomeAt = now;
          sig.expiredRunner = true;
          this.priceTrails.delete(sig.ts);
          this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
          resolvedCount++;
          if (this.sheetLogger) {
            this.sheetLogger.updateOutcome({
              ts: sig.ts, outcome: sig.outcome, outcomeAt: now,
              maxFavorable: sig.maxFavorable, maxAdverse: sig.maxAdverse, finalPnlPct: sig.finalPnlPct
            }).catch(() => {});
          }
          this.emit('resolved', { ...sig, resolvedPrice: tpPrice });
          continue;
        }
        const finalPnl = sig.side === 'LONG'
          ? ((price - sig.entry) / sig.entry) * 100
          : ((sig.entry - price) / sig.entry) * 100;
        sig.outcome = finalPnl > 0 ? 'EXPIRED_PROFIT' : 'EXPIRED_LOSS';
        sig.finalPnlPct = Number(finalPnl.toFixed(3));
        sig.outcomeAt = now;
        this.priceTrails.delete(sig.ts);
        this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
        resolvedCount++;
        if (this.sheetLogger) {
          this.sheetLogger.updateOutcome({
            ts: sig.ts, outcome: sig.outcome, outcomeAt: now,
            maxFavorable: sig.maxFavorable, maxAdverse: sig.maxAdverse,
            finalPnlPct: sig.finalPnlPct
          }).catch(() => {});
        }
        this.emit('resolved', { ...sig, resolvedPrice: price });
      }
    }

    if (this.resetGen !== startGen) {
      console.log(`[signal-tracker] reset ran during resolve tick — discarding ${resolvedCount} resolutions to avoid resurrecting archived signals`);
      return;
    }
    if (resolvedCount > 0 || progressCount > 0) {

      this.#persistAll();
    }
    this.#logSummary(all, resolvedCount);
  }

  reset() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
    let archivedCount = 0, archivedAs;

    if (dbEnabled()) {
      archivedCount = this.records.length;
      if (archivedCount === 0) return null;
      const archiveKey = `archive-${stamp}`;

      const snapshot = this.records;
      this.records = [];
      this.resetGen++;
      kvSet(DB_NS, archiveKey, snapshot).catch(err => console.warn(`[signal-tracker] archive failed: ${err.message}`));
      kvSet(DB_NS, DB_KEY, []).catch(() => {});
      archivedAs = `${DB_NS}/${archiveKey}`;
    } else {
      if (!existsSync(this.path)) return null;
      try {
        const content = readFileSync(this.path, 'utf8');
        archivedCount = content.split('\n').filter(l => l.trim()).length;
      } catch {  }
      const archivePath = this.path.replace(/\.jsonl$/i, '') + `.${stamp}.jsonl`;
      try {
        renameSync(this.path, archivePath);
      } catch (err) {
        console.warn(`[signal-tracker] reset failed: ${err.message}`);
        return null;
      }
      this.records = [];
      this.resetGen++;
      archivedAs = basename(archivePath);
    }

    this.priceTrails.clear();
    this.openKeys = new Set();
    console.log(`[signal-tracker] archived ${archivedCount} signals to ${archivedAs}`);
    return { archivedAs, archivedCount };
  }

  getOpenSignals(limit = 20) {
    const all = this.#readAll();
    return all.filter(r => !r.outcome && !isBankedWinRunner(r)).sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  hasOpenSignal(symbol, side = null) {
    const sym = (symbol ?? '').toUpperCase();

    if (side != null) return this.openKeys.has(`${sym}|${side}`);
    for (const k of this.openKeys) if (k.startsWith(`${sym}|`)) return true;
    return false;
  }

  getRecentSignals(limit = 10) {
    const all = this.#readAll();
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  getStats() {
    const all = this.#readAll();
    const unresolved = all.filter(r => !r.outcome);

    const bankedRunners = unresolved.filter(isBankedWinRunner);
    const open = unresolved.filter(r => !isBankedWinRunner(r));

    const terminal = all.filter(r => r.outcome && r.outcome !== 'NO_PLAN' && r.outcome !== 'EXPIRED_UNFILLED' && r.outcome !== 'AMBIGUOUS' && r.outcome !== 'BREAKEVEN');
    const breakevens = all.filter(r => r.outcome === 'BREAKEVEN').length;
    const resolved = [...terminal, ...bankedRunners];
    if (resolved.length === 0) {
      return { total: all.length, open: open.length, resolved: 0, breakevens, byStrength: {}, byTrigger: {} };
    }
    const isWin = (r) => (r.outcome ?? '').startsWith('WIN') || isBankedWinRunner(r);
    const wins  = resolved.filter(isWin).length;
    const losses = resolved.filter(r => r.outcome === 'LOSS').length;
    const expiredProfit = resolved.filter(r => r.outcome === 'EXPIRED_PROFIT').length;
    const expiredLoss   = resolved.filter(r => r.outcome === 'EXPIRED_LOSS').length;

    const grouper = (keyFn) => {
      const map = {};
      for (const r of resolved) {
        const k = keyFn(r) ?? '?';
        if (!map[k]) map[k] = { wins: 0, losses: 0, total: 0 };
        map[k].total++;
        const won = isWin(r) || r.outcome === 'EXPIRED_PROFIT';
        if (won) map[k].wins++; else map[k].losses++;
      }
      return map;
    };

    const ttrHours = resolved
      .filter(r => r.outcomeAt && r.ts)
      .map(r => (r.outcomeAt - r.ts) / 3_600_000);
    const avgTtrHrs = ttrHours.length
      ? ttrHours.reduce((a, b) => a + b, 0) / ttrHours.length
      : null;

    return {
      total: all.length,
      open: open.length,
      resolved: resolved.length,
      breakevens,
      wins, losses, expiredProfit, expiredLoss,
      winPct: ((wins + expiredProfit) / resolved.length) * 100,
      avgTtrHrs,
      byStrength: grouper(r => r.strength),
      byTrigger:  grouper(r => r.trigger)
    };
  }

  #logSummary(all, justResolved = 0) {

    const bankedRunners = all.filter(isBankedWinRunner);
    const terminal = all.filter(r => r.outcome && r.outcome !== 'NO_PLAN' && r.outcome !== 'EXPIRED_UNFILLED' && r.outcome !== 'AMBIGUOUS' && r.outcome !== 'BREAKEVEN');
    const resolved = [...terminal, ...bankedRunners];
    const trueOpen = all.filter(r => !r.outcome && !isBankedWinRunner(r)).length;
    if (resolved.length === 0) {
      console.log(`[signal-tracker] ${all.length} total, ${trueOpen} open, 0 resolved`);
      return;
    }
    const isWin = (r) => (r.outcome ?? '').startsWith('WIN') || isBankedWinRunner(r);
    const wins  = resolved.filter(isWin).length;
    const losses = resolved.filter(r => r.outcome === 'LOSS').length;
    const expiredProfit = resolved.filter(r => r.outcome === 'EXPIRED_PROFIT').length;
    const expiredLoss   = resolved.filter(r => r.outcome === 'EXPIRED_LOSS').length;
    const winPct  = ((wins + expiredProfit) / resolved.length) * 100;
    const lossPct = ((losses + expiredLoss) / resolved.length) * 100;

    const byStrength = {};
    for (const r of resolved) {
      const s = r.strength ?? '?';
      if (!byStrength[s]) byStrength[s] = { wins: 0, losses: 0, total: 0 };
      byStrength[s].total++;
      const won = isWin(r) || r.outcome === 'EXPIRED_PROFIT';
      if (won) byStrength[s].wins++;
      else byStrength[s].losses++;
    }
    const breakdown = Object.entries(byStrength)
      .map(([k, v]) => `${k}=${((v.wins / v.total) * 100).toFixed(0)}%(${v.total})`)
      .join('  ');

    console.log(`[signal-tracker] total=${all.length} open=${trueOpen} resolved=${resolved.length} ` +
                `wins=${wins+expiredProfit}(${winPct.toFixed(1)}%) losses=${losses+expiredLoss}(${lossPct.toFixed(1)}%) ` +
                `tier-winrates: ${breakdown}` +
                (justResolved > 0 ? ` [+${justResolved} just resolved]` : ''));
  }
}
