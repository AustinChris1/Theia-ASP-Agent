// Append-only JSONL signal tracker + outcome resolver.
//
// Every fired signal is appended as one JSON line to logs/signals.jsonl with
// its entry / SL / TPs / strength / reasons. A background resolver checks
// each open signal against live prices and records the outcome (WIN_TP1/2/3,
// LOSS, EXPIRED_PROFIT, EXPIRED_LOSS).
//
// After ~200 resolved signals you can grep the file for win-rate per:
//   • strength tier (LOW vs MEDIUM vs HIGH vs VERY HIGH)
//   • trigger type (flow vs surge vs liquidation vs funding_extreme)
//   • TF alignment count
//   • specific reason kinds
// and recalibrate the scoring weights.
//
// JSONL is just one JSON object per line — easy to grep, no dependency,
// rewritable in place. SQLite was overkill for this use case.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { dbEnabled, kvGet, kvSet, kvAll } from './db.js';

const DB_NS = 'signals', DB_KEY = 'all';

// SignalTracker emits 'resolved' whenever an open signal closes — either via
// SL/TP touch (resolved at exchange price) or time expiry. index.js subscribes
// and broadcasts the outcome to subscribers so they get TP/SL hit alerts
// instead of having to /open manually.

// A still-open signal that has already banked TP1+ : once TP1 is hit the stop
// ratchets to entry (then TP1), so the eventual terminal outcome is GUARANTEED
// to be a WIN (worst case breakeven, never a loss). We therefore treat it as a
// win for stats THE MOMENT TP1 lands — instead of waiting for the final TP3/stop
// hours later — and drop it from the live OPEN list (it's no longer a risk
// trade). The resolver keeps trailing its stop until it actually closes.
const isBankedWinRunner = (r) => !r?.outcome && (Number(r?.tpHit) || 0) >= 1;

// EARLY breakeven — mirrors the autotrader (#trail). Once a trade shows
// +BE_TRIGGER_PCT in favour, its stop lifts to entry(+fee buffer), so a
// green-then-red trade resolves as a BREAKEVEN scratch (excluded from W/L)
// instead of a LOSS. Keeps the reported win-rate consistent with what the
// autotrader actually fills. 0 disables. Shared env with auto-trader.js.
const BE_TRIGGER_PCT = Number(process.env.BE_TRIGGER_PCT ?? 2.0);
const BE_OFFSET_PCT  = Number(process.env.BE_OFFSET_PCT ?? 0.1);
// Volatility-scaled breakeven arm — MUST mirror the autotrader (auto-trader.js
// #trail): a high-ATR token whose stop sits 9% away shouldn't scratch at a flat
// +1.5% (inside its noise) when the live position needs +3.15% to arm. Keeping the
// same formula here means the SIGNAL's BREAKEVEN outcome matches what the autotrade
// actually does (the RESOLV "signal said breakeven but my position kept running"
// mismatch). arm% = max(BE_TRIGGER_PCT, BE_SL_FRAC × stop-distance%).
const BE_SL_FRAC     = Number(process.env.BE_SL_FRAC ?? 0.35);
// Profit-trail (bank pops) — also mirrors the autotrader. After breakeven arms, the
// stop trails (peak − gap) of profit and only ratchets UP, so a pop that reverses
// BANKS profit instead of scratching at entry. This closes the gap that made a
// +7.26% SAGA move resolve as a flat BREAKEVEN: the tracker modelled the post-TP1
// ratchet but not the pre-TP1 trail. gap% = max(TRAIL_GAP_PCT, TRAIL_SL_FRAC × stop%).
// TRAIL_GAP_PCT=0 disables the trail (revert to breakeven-only, like the old stats).
const TRAIL_GAP_PCT  = Number(process.env.TRAIL_GAP_PCT ?? 2.0);
const TRAIL_SL_FRAC  = Number(process.env.TRAIL_SL_FRAC ?? 0.30);

// Data-integrity guard. SL/TP touches come from exchange 1m klines (Bybit, and
// for thin/illiquid perps occasionally a PHANTOM wick — "BEAT said TP3 hit but
// didn't move an inch"). Before booking a terminal win/loss, cross-check the exit
// against the INDEPENDENT CoinGecko cross-venue price: if they disagree by more
// than this %, the wick wasn't real market-wide → mark the resolution data-suspect
// (AMBIGUOUS, excluded from win-rate) instead of fabricating a win OR a loss.
const RESOLVE_DIVERGENCE_PCT = Number(process.env.RESOLVE_DIVERGENCE_PCT ?? 12);
// The live-price phantom-wick cross-check only makes sense for a RECENT exit. If the
// scan window spans longer than this (a restart gap, or the first scan of a signal
// created hours ago), the exit could be long past and the live price is NOT a valid
// reference — so a genuine far-TP win that has since retraced would be wrongly voided
// as AMBIGUOUS, deflating the measured win rate. Skip the check for stale windows.
const RESOLVE_FRESH_MS = Number(process.env.RESOLVE_FRESH_MIN ?? 12) * 60_000;

export class SignalTracker extends EventEmitter {
  constructor({ path, priceMonitor, taService = null, sheetLogger = null, checkIntervalMs = 5 * 60_000, validityMs = 24 * 60 * 60_000 }) {
    super();
    this.path = path;
    this.priceMonitor = priceMonitor;
    this.taService = taService;       // for wick-aware OHLCV resolution
    this.sheetLogger = sheetLogger;
    this.checkIntervalMs = checkIntervalMs;
    this.defaultValidityMs = validityMs;

    // For each open signal, track the min/max price seen since it was logged
    // PLUS the unix-ms timestamp we last fetched bars up to. This lets us
    // pull 1m OHLCV bars (via TAService) ONLY for the gap since last check —
    // catching every wick that touched SL or TP between resolver ticks.
    this.priceTrails = new Map();   // ts → { high, low, lastChecked }
    this.intervalId = null;

    // Reset generation counter — bumped by reset(). resolveOpen() captures
    // the value at start; if it changes during the tick (reset ran mid-resolve),
    // the tick abandons its #writeAll so it doesn't recreate the just-
    // archived file from its in-memory copy. Fixes the bug where /resetstats
    // archived 221 signals, then a concurrent resolver tick wrote them back.
    this.resetGen = 0;

    // Authoritative in-memory open-signal set (audit §2.2). Keyed by
    // `SYMBOL|SIDE`. Checked + mutated SYNCHRONOUSLY in record() before any
    // appendFileSync, so a burst of signals fired across interleaved async
    // evaluations (the EDEN-×4 duplicate) can't all pass the guard. Seeded
    // from disk on boot so it survives restarts.
    this.openKeys = new Set();

    // In-memory record set — the source of truth for all (synchronous) reads.
    // Persisted to Neon (a single KV doc) when DATABASE_URL is set, else the
    // JSONL file. File mode loads synchronously here; DB mode loads in init().
    this.records = [];
    if (!dbEnabled()) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadRecords();
      this.#syncOpenKeys();
    }
  }

  // Async init for the Postgres path (load + migrate an existing file). No-op in
  // file mode (the constructor already loaded). index.js awaits this.
  async init() {
    if (!dbEnabled()) return this;
    try {
      const rows = await kvGet(DB_NS, DB_KEY);
      if (rows == null) {
        this.#loadRecords();                 // migrate file → DB
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

  // Rebuild the in-memory open-set (boot + after reset).
  #syncOpenKeys() {
    this.openKeys = new Set();
    for (const r of this.records) {
      if (!r.outcome && r.symbol && r.side) this.openKeys.add(`${String(r.symbol).toUpperCase()}|${r.side}`);
    }
  }

  #openKey(symbol, side) { return `${String(symbol ?? '').toUpperCase()}|${side}`; }

  // Append a signal record. Called from index.js on every conductor 'signal'.
  record(signal) {
    // Authoritative duplicate guard. The conductor's open-position lockout
    // reads from disk, but a burst of signals fired in the same tick (before
    // any write completes) can all pass that check — that's how EDEN LONG
    // got recorded 4× with an identical entry/score and then resolved as 4
    // separate SL hits. Here we re-check synchronously against the on-disk
    // open set immediately before appending, so only the first of a burst
    // is persisted. Same symbol + same side + still-open = reject.
    const sym = signal.token?.symbol;
    const side = signal.side;
    // Atomic duplicate guard (audit §2.2): check the IN-MEMORY open-set
    // synchronously. record() is synchronous, but the *decisions* to emit are
    // made across interleaved async evaluations that each read disk before any
    // write lands — so a disk-only guard let bursts through (EDEN ×4). The
    // in-memory set is mutated here, before the append, closing that window.
    const key = sym && side ? this.#openKey(sym, side) : null;
    if (key && this.openKeys.has(key)) {
      console.log(`[signal-tracker] skip duplicate ${side} ${sym} — open signal already exists`);
      return false;
    }

    // Liquidity-grab setups need two-phase tracking:
    //   Phase 1 — awaiting fill: price needs to touch limitEntry before the
    //             trade is "open". SL/TP checks suppressed during this phase.
    //   Phase 2 — fill confirmed: tracking starts FROM the limit zone, with
    //             SL/TP measured against limitEntry (which IS the real entry).
    // For non-liquidity-grab signals (market entry), it's single-phase as
    // before — entry is the market price and tracking starts immediately.
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
      marketEntry: plan.entry ?? null,        // reference: where the bot saw market price when signal fired
      limitEntry:  plan.limitEntry ?? null,
      isLiquidityGrab: isLG,
      awaitingLimit: isLG,                    // true until price touches limitEntry
      limitFilledAt: null,
      sl:    plan.sl ?? null,
      tp1:   plan.tp1 ?? null,
      tp2:   plan.tp2 ?? null,
      tp3:   plan.tp3 ?? null,
      horizon: plan.horizon ?? null,
      atrTf:   plan.atrTf ?? null,
      alignmentCount: plan.alignmentCount ?? null,
      alignedTfs: Array.isArray(plan.alignedTfs) ? plan.alignedTfs : null,   // which TFs were aligned (for /tunestats TF analysis)
      validityHrs: plan.validityHrs ?? null,
      // Progressive TP tracking — highest TP level already notified (0 = none).
      // Lets TP1/TP2/TP3 each fire their own alert as price reaches them over
      // time, instead of the trade resolving terminally on the first TP touched.
      tpHit: 0,
      tpHitAt: null,
      // Outcome filled later by resolver
      outcome: null,
      outcomeAt: null,
      maxFavorable: null,
      maxAdverse: null
    };
    try {
      this.records.push(record);
      this.#appendPersist(record);
      if (key) this.openKeys.add(key);     // mark open AFTER the write lands
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

  // All signals (a shallow copy, so callers can sort without reordering the
  // stored array — the record objects are shared, so in-place outcome edits in
  // resolveOpen() still persist via #persistAll()).
  #readAll() { return [...this.records]; }

  // ── Stats sources for /tunestats ────────────────────────────────────────────
  // CURRENT engine only (since last /resetstats). Neon-backed in DB mode — the
  // in-memory `records` IS the live signals doc that's persisted to Postgres, so
  // this survives Render redeploys (the ephemeral signals.jsonl does NOT). On
  // local disk it mirrors the live jsonl. Returns a flat array of record objects.
  currentRecords() { return [...this.records]; }

  // ALL-TIME incl. archived resets. DB mode: pulls every doc in the `signals`
  // namespace (the live `all` + each `archive-*` snapshot from past resets) and
  // flattens them. Disk mode: reads every signals*.jsonl in the log dir. Async
  // because the DB read is async; callers await it.
  async allRecords() {
    if (dbEnabled()) {
      try {
        const rows = await kvAll(DB_NS);                 // [{ key, val }] — 'all' + 'archive-*'
        const out = [];
        for (const { val } of rows) if (Array.isArray(val)) out.push(...val);
        return out;
      } catch (err) {
        console.warn(`[signal-tracker] allRecords DB read failed: ${err.message}`);
        return [...this.records];                        // fall back to live set
      }
    }
    // Disk mode — read every signals*.jsonl (live + archived resets).
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
          try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      }
    } catch { /* dir unreadable — return whatever we have */ }
    return out;
  }

  // Persist one newly-appended record. DB has no append primitive, so it writes
  // the whole set (signals are infrequent); the file appends a single line.
  #appendPersist(record) {
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, this.records).catch(err => console.warn(`[signal-tracker] DB write failed: ${err.message}`));
      return;
    }
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  // Persist the full set (after resolveOpen mutates outcomes).
  #persistAll() {
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, this.records).catch(err => console.warn(`[signal-tracker] DB write failed: ${err.message}`));
      return;
    }
    writeFileSync(this.path, this.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  // Walk bars OLDEST→NEWEST tracking PROGRESSIVE TP hits + the terminal close
  // (audit §2.3). The trade no longer resolves on the first TP touched: TP1, TP2
  // and TP3 each register as price reaches them over time, so the bot can alert
  // "TP1 hit" now and "TP2 hit" three hours later.
  //
  // Risk-free runner: once TP1 is reached the stop moves to BREAKEVEN (entry) —
  // the original SL can no longer produce a LOSS. A retrace to entry closes the
  // trade as a locked WIN_TP{reached}; otherwise it stays open through TP2/TP3.
  // The final TP (highest defined), a pre-TP1 SL, or a one-bar SL+TP overlap
  // (AMBIGUOUS) are terminal.
  //
  // `alreadyTp` = highest TP level reached on a prior tick (sig.tpHit). Returns
  // { newTps:[levels newly reached this tick], terminal:{outcome,exitPrice,
  //   ambiguous?,breakeven?}|null, hi, lo, reached }.
  #scan(sig, bars, alreadyTp = 0) {
    const isLong = sig.side === 'LONG';
    const finalLevel = sig.tp3 ? 3 : sig.tp2 ? 2 : 1;
    const tpPriceOf = { 1: sig.tp1, 2: sig.tp2, 3: sig.tp3 };
    // Sort by open-time so touch order can't be corrupted by out-of-order /
    // concatenated pages from the provider (the whole resolver depends on it).
    const ordered = [...bars].sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    let hi = -Infinity, lo = Infinity;   // running extremes UP TO the resolving bar (for MFE/MAE)
    let reached = alreadyTp;
    let beArmed = false;                 // early breakeven engaged (price showed +BE_TRIGGER_PCT)
    let trailLockPct = 0;                // profit% locked by the bank-pops trail (0 = at entry); ratchets UP only
    const beStop = isLong ? sig.entry * (1 + BE_OFFSET_PCT / 100)
                          : sig.entry * (1 - BE_OFFSET_PCT / 100);
    // Vol-scaled arm: max(flat trigger, fraction of the stop distance) — identical
    // to the autotrader, so the SIGNAL only scratches at breakeven when the live
    // position would too. A 9%-SL token arms at ~3.15%, a tight 2%-SL token at 1.5%.
    const riskPct = (sig.entry > 0 && sig.sl > 0) ? Math.abs((sig.sl - sig.entry) / sig.entry) * 100 : 0;
    const beArmPct = Math.max(BE_TRIGGER_PCT, BE_SL_FRAC * riskPct);
    const beTrigger = isLong ? sig.entry * (1 + beArmPct / 100)
                             : sig.entry * (1 - beArmPct / 100);
    const trailGap = Math.max(TRAIL_GAP_PCT, TRAIL_SL_FRAC * riskPct);   // bank-pops gap below the peak
    const newTps = [];
    for (const b of ordered) {
      // Skip bars that OPENED before the signal fired. fromMs fetches one bar of
      // overlap (−60s) so the entry minute is covered, but a wick in that
      // pre-signal minute must NOT resolve the trade (it would fabricate a
      // phantom SL/TP touch). t is ms (ta.js getRecentBars ×1000), same unit as sig.ts.
      if (Number.isFinite(Number(b.t)) && Number(b.t) < sig.ts) continue;
      const h = Number(b.h), l = Number(b.l);
      if (!isFinite(h) || !isFinite(l)) continue;
      hi = Math.max(hi, h); lo = Math.min(lo, l);   // include THIS bar before the hit-check

      // Highest TP level this bar reached in the profit direction.
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

      // Stop ratchet — mirrors the autotrader's trailing SL so booked PnL matches
      // what actually fills: real SL before TP1, BREAKEVEN (entry) after TP1, then
      // locked at TP1 after TP2. Once reached≥1 the stop can only lock profit, so
      // a stop touch exits at that locked level (not the TP target — exiting at
      // the TP would over-report a runner that round-tripped).
      // PRE-TP1: once breakeven arms, the bank-pops trail lifts the stop to
      // (peak − gap) of profit (trailLockPct, set at the END of prior bars), so a
      // pop that reverses banks profit instead of scratching at entry. Falls back to
      // the flat breakeven stop until the trail has locked more than the fee buffer.
      const trailStop = isLong ? sig.entry * (1 + trailLockPct / 100)
                               : sig.entry * (1 - trailLockPct / 100);
      const protectiveStop = beArmed ? (trailLockPct > BE_OFFSET_PCT ? trailStop : beStop) : sig.sl;
      const stopLevel = reached >= 2 ? sig.tp1 : reached >= 1 ? sig.entry : protectiveStop;
      const hitStop = isLong ? l <= stopLevel : h >= stopLevel;

      if (hitStop && newTpThisBar) {
        // After a banked TP the downside is locked, so a same-bar stop+higher-TP
        // is win-vs-win (not the genuine win/loss ambiguity). Resolve to the
        // locked level conservatively — never discard the banked TP as AMBIGUOUS.
        if (reached >= 1) {
          return { newTps, terminal: { outcome: `WIN_TP${reached}`, exitPrice: stopLevel, breakeven: true }, hi, lo, reached };
        }
        // Pre-TP1: SL and TP both wicked in one bar → genuinely unorderable.
        return { newTps, terminal: { outcome: 'AMBIGUOUS', exitPrice: null, ambiguous: true }, hi, lo, reached };
      }
      if (hitStop) {
        if (reached >= 1) {
          // Runner stopped after locking profit — exit at the locked stop level.
          return { newTps, terminal: { outcome: `WIN_TP${reached}`, exitPrice: stopLevel, breakeven: true }, hi, lo, reached };
        }
        if (beArmed) {
          if (trailLockPct > BE_OFFSET_PCT) {
            // The bank-pops trail had lifted the stop into profit — a pop that
            // reversed BANKS the locked gain (the SAGA +7% case), a small WIN, not a
            // breakeven scratch. Exit at the locked level.
            return { newTps, terminal: { outcome: 'WIN_TRAIL', exitPrice: stopLevel, breakeven: false }, hi, lo, reached };
          }
          // Reached the arm threshold then retraced before the trail locked profit —
          // a SCRATCH at breakeven, not a loss. Excluded from W/L counting.
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

      // Arm early breakeven for SUBSEQUENT bars — done at the END (after this
      // bar's hit-checks) so the bar that FIRST reaches +BE_TRIGGER_PCT isn't
      // itself BE-protected. Intrabar order is unknown, so a single bar that
      // spikes +2% AND wicks the original SL must stay a LOSS, not a scratch.
      if (BE_TRIGGER_PCT > 0 && !beArmed && reached === 0) {
        if (isLong ? h >= beTrigger : l <= beTrigger) beArmed = true;
      }
      // Ratchet the bank-pops trail from the peak SO FAR (this bar included), for
      // the NEXT bar's stop — same reason as arming BE at the end: a single bar that
      // spikes then dumps must not be rescued by its own intrabar high.
      if (TRAIL_GAP_PCT >= 0 && beArmed && reached === 0) {
        const peakPct = isLong ? (hi - sig.entry) / sig.entry * 100
                               : (sig.entry - lo) / sig.entry * 100;
        const lockPct = peakPct - trailGap;
        if (lockPct > trailLockPct) trailLockPct = lockPct;   // ratchets UP only
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
    let progressCount = 0;        // intermediate TP-hit notifications fired this tick
    const now = Date.now();

    for (const sig of open) {
      if (!sig.entry || !sig.sl || !sig.tp1) {
        // Signal had no trade plan — skip
        sig.outcome = 'NO_PLAN';
        sig.outcomeAt = now;
        this.openKeys.delete(this.#openKey(sig.symbol, sig.side));
        resolvedCount++;
        continue;
      }
      // Fetch the actual exchange high/low between last check and now via
      // Coinalyze 1m OHLCV bars. This is what's been missing — CoinGecko's
      // smoothed cross-venue price never wicks as far as the exchange does,
      // so SL/TP touches were silently lost.
      const existing = this.priceTrails.get(sig.ts);
      // Never fetch bars from BEFORE the signal was created (audit §5,
      // signal-tracker.js:179). On a restart the in-memory trail is gone, so
      // without this clamp fromTs could reach back to a stale lastChecked and
      // let pre-signal wicks register as SL/TP hits. max(sig.ts, lastChecked)
      // pins the floor to signal creation; the −60s is a boundary-bar overlap.
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
        // Fallback: CoinGecko spot price (less accurate, no wick info)
        const px = this.priceMonitor?.getPrice(sig.cgId);
        if (px == null) continue;
        barHigh = px;
        barLow = px;
        barClose = px;
      }

      const trail = existing ?? { high: barHigh, low: barLow, lastChecked: sig.ts };
      // For the time-expiry branch below — `price` = latest known close
      const price = barClose;

      // ── PHASE 1: liquidity-grab awaiting limit fill ─────────────────
      // For LG signals, SL/TP only become meaningful once price has
      // actually touched the limit. Until then we just check fill +
      // validity (no SL/TP detection, no MFE/MAE tracking on the unfilled
      // setup — those numbers would be misleading).
      let justFilled = false;
      if (sig.awaitingLimit) {
        // VALIDITY CHECKED FIRST. The fill-wait window MATCHES the plan validity —
        // the SAME window the autotrader uses to cancel an unfilled limit
        // (auto-trader.js ~823). This previously floored at 12h AND ran after the
        // fill check, so a limit the autotrader had ALREADY cancelled could still
        // tag and resolve as an SL here — the "FIDA: limit expired but SL hit"
        // contradiction. Expiring BEFORE the fill check means a bar window that
        // straddles the validity boundary can't sneak a late fill: once the live
        // order is gone, a later tag is moot. A published entry zone has a shelf
        // life; no fill within validity → EXPIRED_UNFILLED (not a loss), for the
        // win-rate stats AND execution alike. If a counter-trend sweep genuinely
        // needs longer to tag, widen validityHrs on the PLAN (the conductor) so BOTH
        // systems extend together.
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
          continue;  // expired before fill — done
        }
        const limit = sig.limitEntry ?? sig.entry;
        const filled = sig.side === 'SHORT'
          ? barHigh >= limit            // price rose to short-limit
          : barLow  <= limit;           // price fell to long-limit

        if (filled) {
          sig.awaitingLimit = false;
          sig.limitFilledAt = now;
          // Reset trail to start tracking from the fill point — earlier
          // wicks (before fill) shouldn't count toward SL/TP detection
          trail.high = limit;
          trail.low  = limit;
          trail.lastChecked = now;
          this.priceTrails.set(sig.ts, trail);
          justFilled = true;       // skip the trail-update on this tick — bars span pre+post fill
          console.log(`[signal-tracker] ${sig.symbol} ${sig.side} limit filled @ ${limit}`);
          // fall through to SL/TP check this same tick (trail still at limit)
        } else {
          this.priceTrails.set(sig.ts, trail);
          continue;  // still within validity, not yet filled — keep waiting
        }
      }

      // ── PHASE 2: open trade — track SL/TP against the trail ─────────
      // CHRONOLOGICAL hit-check (audit §2.3): walk bars OLDEST→NEWEST and emit
      // the FIRST level touched (a series that hit TP1 at min #2 and SL at min #4
      // is a WIN, not the SL-first LOSS the old max/min approach reported). A bar
      // wicking through BOTH SL and a TP → AMBIGUOUS (excluded downstream). On
      // the just-filled LG tick the bars span pre+post fill, so resolution waits
      // one tick. Computed BEFORE the trail update so MFE/MAE can stop at exit.
      const scanBars = (Array.isArray(bars) && bars.length)
        ? bars
        : [{ o: barClose, h: barHigh, l: barLow, c: barClose, t: sig.ts }];
      const scan = justFilled ? null : this.#scan(sig, scanBars, sig.tpHit ?? 0);
      const touch = scan?.terminal ?? null;

      // Extend the trail. On the just-filled tick, don't (bars span pre+post
      // fill). Otherwise: if the trade RESOLVED this tick, cap the trail at the
      // resolving bar (scan.hi/lo = running extremes up to and incl. the touch)
      // so bars AFTER exit don't pollute MFE/MAE (accuracy audit D/§2); if still
      // open, the whole window counts.
      if (!justFilled) {
        const hi = scan && isFinite(scan.hi) ? scan.hi : barHigh;
        const lo = scan && isFinite(scan.lo) ? scan.lo : barLow;
        trail.high = Math.max(trail.high, hi);
        trail.low  = Math.min(trail.low,  lo);
        trail.lastChecked = now;
        this.priceTrails.set(sig.ts, trail);
      }

      // ── Progressive TP alerts ───────────────────────────────────────
      // Fire a "TP{n} hit" notification for each NEW intermediate TP level
      // reached this tick while the trade stays OPEN (the final TP / SL is
      // handled as a terminal 'resolved' below). When the trade also closes
      // terminally this same tick (e.g. price gapped TP1→TP3), we skip these —
      // the terminal alert covers it — but still advance sig.tpHit there.
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
        this.priceTrails.set(sig.ts, trail);   // keep tracking; not resolved
      }

      // Track max favorable / adverse excursion as % from entry
      sig.maxFavorable = sig.side === 'LONG'
        ? ((trail.high - sig.entry) / sig.entry) * 100
        : ((sig.entry - trail.low) / sig.entry) * 100;
      sig.maxAdverse = sig.side === 'LONG'
        ? ((trail.low - sig.entry) / sig.entry) * 100
        : ((sig.entry - trail.high) / sig.entry) * 100;

      if (touch) {
        let outcome = touch.outcome;
        // DATA-INTEGRITY cross-check (the "BEAT TP3 hit but didn't move" bug).
        // A TP/SL exit from a thin perp's klines can be a phantom wick. Validate
        // it against the INDEPENDENT CoinGecko price: if the exit disagrees with
        // the live broad-market price by > RESOLVE_DIVERGENCE_PCT, the wick wasn't
        // corroborated → don't book a phantom win/loss; mark AMBIGUOUS (excluded
        // from stats) and log. Fail-open when no reference price is available.
        const windowFresh = (now - fromMs) <= RESOLVE_FRESH_MS;   // exit recent enough that live price corroborates
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
        sig.breakeven = touch.breakeven ?? false;   // risk-free runner stopped at entry after a TP
        if (scan && scan.reached > (sig.tpHit ?? 0)) { sig.tpHit = scan.reached; sig.tpHitAt = now; }
        // Exit at the SL/TP LEVEL touched (not the bar close — the HEI bug:
        // WIN_TP1 reported with negative P&L because price bounced back past
        // TP1 by check time). For a LOSS, apply a small slippage haircut
        // (audit §3.24) — a stop usually fills slightly worse than the level.
        let exitPrice = touch.exitPrice;
        if (outcome === 'LOSS' && isFinite(exitPrice)) {
          const SLIP = 0.001;   // 0.1% adverse slippage on stop fills
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
        // Mirror outcome to Google Sheets (fire-and-forget)
        if (this.sheetLogger) {
          this.sheetLogger.updateOutcome({
            ts: sig.ts, outcome, outcomeAt: now,
            maxFavorable: sig.maxFavorable, maxAdverse: sig.maxAdverse,
            finalPnlPct: sig.finalPnlPct
          }).catch(() => {});
        }
        // Broadcast outcome to subscribers via index.js
        this.emit('resolved', { ...sig, resolvedPrice: isFinite(exitPrice) ? exitPrice : price });
        continue;
      }

      // Time-based expiry. The HOLD clock starts when the trade actually
      // opens: for a liquidity-grab that means the moment the limit filled
      // (limitFilledAt), NOT signal creation — otherwise a setup that takes 1.5h
      // to fill only gets 0.5h of a 2h window to work. Market-entry signals have
      // no limitFilledAt, so the clock starts at sig.ts as before.
      const validityMs = sig.validityHrs ? sig.validityHrs * 60 * 60_000 : this.defaultValidityMs;
      const holdStart = sig.limitFilledAt ?? sig.ts;
      if (now - holdStart >= validityMs) {
        const banked = sig.tpHit ?? 0;
        if (banked >= 1) {
          // A TP was already banked → the runner expired risk-free. Resolve as a
          // locked WIN at the highest TP reached (exit at that TP level).
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

    // Abandon writes if a reset ran during this tick — `all` is stale data
    // (the JSONL has just been renamed away). Writing it back would resurrect
    // the archived signals as if reset never happened.
    if (this.resetGen !== startGen) {
      console.log(`[signal-tracker] reset ran during resolve tick — discarding ${resolvedCount} resolutions to avoid resurrecting archived signals`);
      return;
    }
    if (resolvedCount > 0 || progressCount > 0) {
      // Persist the live set (resolveOpen mutated the shared record objects in
      // this.records — outcomes AND progressive tpHit advances; persisting the
      // live array also keeps any concurrent append).
      this.#persistAll();
    }
    this.#logSummary(all, resolvedCount);
  }

  // Archive the current JSONL with a timestamp suffix and start a fresh tracker.
  // Returns { archivedAs, archivedCount } or null if nothing to reset.
  reset() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
    let archivedCount = 0, archivedAs;

    if (dbEnabled()) {
      archivedCount = this.records.length;
      if (archivedCount === 0) return null;
      const archiveKey = `archive-${stamp}`;
      // Snapshot + bump generation + clear BEFORE persisting, so an in-flight
      // resolveOpen() tick sees the new resetGen at its guard and ABANDONS its
      // persist rather than writing its (now stale) full records over the cleared
      // set — the "/resetstats then archived signals reappear" race. (resetGen was
      // bumped at the very end, leaving that window open.)
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
      } catch { /* ignore — we'll still rename */ }
      const archivePath = this.path.replace(/\.jsonl$/i, '') + `.${stamp}.jsonl`;
      try {
        renameSync(this.path, archivePath);
      } catch (err) {
        console.warn(`[signal-tracker] reset failed: ${err.message}`);
        return null;
      }
      this.records = [];
      this.resetGen++;                // (rename is atomic, but keep the gen in sync)
      archivedAs = basename(archivePath);
    }

    this.priceTrails.clear();
    this.openKeys = new Set();        // archived → no open signals
    console.log(`[signal-tracker] archived ${archivedCount} signals to ${archivedAs}`);
    return { archivedAs, archivedCount };
  }

  // Open signals (not yet resolved), most recent first. Used by /open command.
  // Excludes runners that have already banked TP1+ — those are locked-in wins
  // riding a trailing stop, not live-risk trades, so they don't belong in the
  // "open positions" view (the resolver still trails their stop in the
  // background; they reappear only as a final TP/stop alert).
  getOpenSignals(limit = 20) {
    const all = this.#readAll();
    return all.filter(r => !r.outcome && !isBankedWinRunner(r)).sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // Does `symbol` currently have an unresolved signal? Used by the conductor
  // to suppress duplicate signals on tokens already in the open-position book —
  // prevents firing TIA LONG three times in two hours just because the same
  // setup re-appears every 30 minutes. The signal can re-fire only AFTER the
  // open one resolves (TP or SL).
  hasOpenSignal(symbol, side = null) {
    const sym = (symbol ?? '').toUpperCase();
    // Served from the authoritative in-memory open-set (audit §2.2) — synchronous
    // and consistent with record()'s duplicate guard, instead of a per-call disk
    // read that could lag a just-written append.
    if (side != null) return this.openKeys.has(`${sym}|${side}`);
    for (const k of this.openKeys) if (k.startsWith(`${sym}|`)) return true;
    return false;
  }

  // Most recent N signals (resolved or open), most recent first.
  getRecentSignals(limit = 10) {
    const all = this.#readAll();
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // Returns the same breakdown the resolver logs to console, but as a structured
  // object (used by the Telegram /stats command).
  getStats() {
    const all = this.#readAll();
    const unresolved = all.filter(r => !r.outcome);
    // A banked TP1+ runner is already a guaranteed win — count it NOW (not when
    // it finally hits TP3/stop hours later) and drop it from the "open" tally so
    // /stats agrees with /open.
    const bankedRunners = unresolved.filter(isBankedWinRunner);
    const open = unresolved.filter(r => !isBankedWinRunner(r));
    // EXPIRED_UNFILLED = liquidity-grab setup whose limit never triggered.
    // AMBIGUOUS  = SL and TP both wicked in one 1m bar (can't be ordered).
    // BREAKEVEN  = reached +BE_TRIGGER_PCT then scratched at entry (early-BE) —
    //   a non-loss, non-win. Excluding it from the denominator means a loss that
    //   the early-BE rescues correctly RAISES the win-rate (the whole point).
    // None is a win/loss outcome — exclude from win-rate.
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

    // Avg time-to-resolution in hours (resolved only)
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
    // Match getStats() — exclude NO_PLAN, EXPIRED_UNFILLED and AMBIGUOUS from
    // the win-rate denominator. Otherwise the TG /stats output and the
    // console log diverge.
    const bankedRunners = all.filter(isBankedWinRunner);   // TP1+ banked = already a win
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

    // Group by strength
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
