// AutoTrader — turns the bot's signals into real (or paper) Bybit orders.
//
// FULLY ISOLATED from the signal engine: it only SUBSCRIBES to the conductor's
// 'signal' events (read-only). Nothing in src/ changes behaviour based on
// whether the autotrader is on.
//
// Flow per signal:
//   1. Filter — MEDIUM+ tier, has a valid trade plan, (optionally) SHORT-only,
//      not a duplicate, passes the risk gate.
//   2. Size — RiskEngine computes qty from riskPct + SL distance, capped at
//      maxPositionUsd.
//   3. Execute — set leverage, place a market order with server-side SL + TP.
//      (Liquidity-grab signals use a limit order at the plan's limit entry.)
//   4. Journal + notify.
//   5. Monitor loop — poll positions; when one disappears (SL/TP filled by the
//      exchange) or a paper touch resolves, journal the outcome + realised PnL
//      and feed it to the risk engine's daily-loss breaker.
//
// SAFETY INTERLOCK: live orders are placed ONLY when mode === 'live' AND
// `armed` is true. `armed` starts false and is flipped on by /autotrade on
// (or AUTOTRADE_ARMED=1). This prevents a deploy from instantly trading before
// you've reviewed config / set keys.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from '../db.js';

const CONFIG_DB_NS = 'autotrade-config';
const DAYSTATE_DB_NS = 'autotrade-daystate';   // persisted daily-loss-breaker counters (survive restart)

export class AutoTrader extends EventEmitter {
  constructor({
    mode = 'off',              // 'off' | 'paper' | 'live'
    liveBroker = null,         // BybitExchange (null if no keys)
    paperBroker = null,        // PaperBroker
    riskEngine,
    store,
    notifier,
    notifyChatId = null,       // operator chat — autotrade alerts go ONLY here, never broadcast
    logTag = 'op',             // account label in logs (operator = 'op', users = 'u<chatId>') so the
                               //   operator can tell whose fills/skips are whose in a shared log stream
    shortOnly = false,
    tpTarget = 'tp2',          // which plan TP to use as the exit ('tp1'|'tp2'|'tp3')
    tpPercent = 0,             // >0 = fixed ROI take-profit (% on margin), overrides tpTarget/trailing
    configKey = null,          // Neon kv key for persisted config (e.g. 'operator'); null = file-only
    dayStateKey = null,        // Neon kv key for the daily-loss counter (e.g. 'operator', 'user-<id>')
    dayStateFile = null,       // explicit file path for the daily-loss counter in file-only mode (users have no configPath)
    minAlignment = 0,          // legacy: require trade plan alignmentCount ≥ this (0 = off)
    minAlignmentWeight = 0,    // preferred: require plan.weightedAlignment ≥ this (0 = off)
    skipScalp = true,          // don't autotrade SCALP-horizon setups (signals-only)
    allowedHorizons = null,    // null = use skipScalp legacy gate; array (e.g. ['DAY','SWING','POSITION']) = explicit per-account allowlist of trade horizons
    allowTriggers = null,      // per-account trigger allowlist: { surge:true/false, flow:..., ... }. null/missing key = fall back to the operator AUTOTRADE_ALLOW_<TRIGGER> env + defaults
    trailing = true,           // hold for tp3 and ratchet SL → breakeven after TP1, → TP1 after TP2
    trailGapPct = Number(process.env.TRAIL_GAP_PCT ?? 2.0),   // per-account profit-trail gap (0 = breakeven-only)
    beTriggerPct = Number(process.env.BE_TRIGGER_PCT ?? 1.5), // per-account early-breakeven arm (0 = breakeven OFF)
    paperMarginUsd = 0,        // PAPER mode: fixed margin (collateral) per trade. 0 = use risk-based sizing.
    liveMarginUsd = 0,         // LIVE mode: fixed margin per trade. 0 = risk-based + maxPositionUsd cap (safer).
    configPath = null,         // persists /autotrade margin across restarts (overrides the .env defaults)
    monitorIntervalMs = 30_000,
    armed = false,
    verbose = false
  }) {
    super();
    this.liveBroker = liveBroker;
    this.paperBroker = paperBroker;
    this.risk = riskEngine;
    this.store = store;
    this.notifier = notifier;
    this.notifyChatId = notifyChatId ? String(notifyChatId) : null;
    this.logTag = logTag || 'op';
    this.shortOnly = shortOnly;
    this.tpTarget = tpTarget;
    this.tpPercent = tpPercent;
    this.minAlignment = minAlignment;
    this.minAlignmentWeight = minAlignmentWeight;
    this.skipScalp = skipScalp;
    // Per-account horizon allowlist (UPPERCASE: SCALP/DAY/SWING/POSITION). When
    // set it REPLACES the skipScalp gate — only listed horizons auto-trade.
    this.allowedHorizons = Array.isArray(allowedHorizons) && allowedHorizons.length
      ? allowedHorizons.map(h => String(h).toUpperCase())
      : null;
    this.allowTriggers = (allowTriggers && typeof allowTriggers === 'object') ? allowTriggers : null;
    this.trailing = trailing;
    // EARLY breakeven: the TP1-gated ratchet (below) never fires for the trades
    // that peak BELOW TP1 then reverse — the dominant loser shape. Once an open
    // trade shows +beTriggerPct in favour, move the stop to (just past) entry so
    // a green-then-red trade SCRATCHES instead of taking the full stop. 0 disables.
    // Default 1.5% (was 2.0%): the live excursion data shows LOSERS peak only
    // +1.6% before bleeding to −5.4%, while WINNERS dip just −1.5% before running
    // to +9.4%. Arming at 1.5% catches those +1.6%-peak losers at breakeven
    // without whipsawing winners (it only ever arms once you're already in
    // profit — so it can't stop a trade that never went your way). Offset covers
    // round-trip fees.
    this.beTriggerPct = beTriggerPct;
    this.beOffsetPct  = Number(process.env.BE_OFFSET_PCT ?? 0.1);
    // PROFIT-TRAIL: after breakeven, ratchet the stop to TRAIL_GAP_PCT below the
    // high-water mark so a pop that reverses BANKS profit instead of scratching at
    // breakeven (the "+2.3% peak then die" losers — your excursion data). Locks
    // (favourable% − gap) and only ever moves up. 0 disables (breakeven-only).
    this.trailGapPct = trailGapPct;
    // VOLATILITY-SCALED breakeven + trail. Flat 1.5%/2% sit INSIDE a high-ATR
    // token's noise band (a 7%-SL token wiggles 3-4%), so a normal pullback
    // scratches a good entry before it reaches a real target (the VELVET case).
    // Scale the arm + gap to the trade's own SL distance: a 7%-SL trade arms BE
    // ~+2.5% and trails ~2.1%, while a calm 2%-SL trade keeps the tight flat
    // floors. effective = max(flat floor, frac × slPct).
    this.beSlFrac = Number(process.env.BE_SL_FRAC ?? 0.35);
    this.trailSlFrac = Number(process.env.TRAIL_SL_FRAC ?? 0.30);
    // R:R floor for deploying capital: skip a trade whose EXIT target pays less
    // than the stop risks (VELVET's TP1 was 0.81R — risk 7% to make 5.7%). Gates
    // on the actual exit target's R:R (tp3 when trailing, else the configured TP).
    this.minRr = Number(process.env.AUTOTRADE_MIN_RR ?? 1.0);
    this.paperMarginUsd = paperMarginUsd;
    this.liveMarginUsd = liveMarginUsd;
    this.configPath = configPath;
    this.configKey = configKey;
    this.dayStateKey = dayStateKey;
    this.dayStateFile = dayStateFile;
    // File config loads synchronously here; Neon config loads via initConfig()
    // (awaited in index.js) so operator settings survive a Render redeploy.
    if (!dbEnabled() || !configKey) this.#loadConfigFile();
    this.monitorIntervalMs = monitorIntervalMs;
    this.armed = armed;
    this.verbose = verbose;
    this._seq = 0;
    this._reserved = new Set();   // symbols with an order in-flight — blocks same-tick double-fill
    this._alertedOrphans = new Set();   // exchange positions we've already warned are untracked
    this.monitorId = null;
    // Initial mode — downgraded to off if the chosen mode has no broker.
    this.mode = 'off';
    this.setMode(mode, { silent: true });
  }

  // The broker for the CURRENT mode. paper→paperBroker, live→liveBroker.
  get broker() {
    if (this.mode === 'live') return this.liveBroker;
    if (this.mode === 'paper') return this.paperBroker;
    return null;
  }
  get isLive() { return this.mode === 'live'; }
  get active() { return this.mode !== 'off' && !!this.broker; }

  // Switch mode at runtime (from /autotrade paper|live|off). Returns
  // { ok, reason }. Validates that the target mode has a usable broker.
  setMode(mode, { silent = false } = {}) {
    const m = (mode || 'off').toLowerCase();
    if (!['off', 'paper', 'live'].includes(m)) {
      return { ok: false, reason: `unknown mode "${mode}" (use off|paper|live)` };
    }
    if (m === 'live' && !this.liveBroker) {
      return { ok: false, reason: 'live mode needs BYBIT_API_KEY/SECRET in .env (none configured)' };
    }
    if (m === 'paper' && !this.paperBroker) {
      return { ok: false, reason: 'paper broker unavailable' };
    }
    this.mode = m;
    if (!silent) console.log(`[autotrade] mode → ${m}${m === 'live' ? ` (armed=${this.armed})` : ''}`);
    return { ok: true };
  }

  start() {
    // The monitor ALWAYS runs (it no-ops when mode=off), so a runtime
    // /autotrade paper|live takes effect without a restart.
    this.monitorId = setInterval(() => {
      this.#monitor().catch(err => console.warn(`[autotrade] monitor error: ${err.message}`));
    }, this.monitorIntervalMs);
    this.monitorId.unref?.();
    console.log(`[autotrade ${this.logTag}] ready — mode=${this.mode} armed=${this.armed} live=${this.liveBroker ? 'keys-ok' : 'no-keys'} shortOnly=${this.shortOnly} skipScalp=${this.skipScalp} trailing=${this.trailing} minAlignment=${this.minAlignment}/6 risk=${this.risk.riskPct}% maxPos=$${this.risk.maxPositionUsd} tp=${this.trailing ? 'tp3+trail' : this.tpTarget}`);
    console.log(`[autotrade] control from Telegram: /autotrade paper | live | off | on | status`);
  }

  // Stop the monitor loop (used when a per-user trader is disconnected or
  // rebuilt with new keys). Idempotent.
  stop() {
    if (this.monitorId) { clearInterval(this.monitorId); this.monitorId = null; }
  }

  // Operator controls (wired to /autotrade command).
  arm()    { this.armed = true;  console.log('[autotrade] ARMED — live orders enabled'); }
  disarm() { this.armed = false; console.log('[autotrade] DISARMED — no new orders'); }

  // Fixed margin (collateral) per trade for the CURRENT mode. 0 / null reverts
  // to risk-based sizing. Returns { mode, marginUsd }.
  setMargin(usd) {
    const m = Math.max(0, Number(usd) || 0);
    if (this.mode === 'paper') this.paperMarginUsd = m;
    else this.liveMarginUsd = m;
    this.#saveConfig();   // persist so it survives a restart (the bug you hit)
    console.log(`[autotrade] ${this.mode} fixed margin → ${m > 0 ? `$${m}/trade` : 'off (risk-based)'} (persisted)`);
    return { mode: this.mode, marginUsd: m };
  }

  // ── Persisted runtime config (margins + exit style) ──────────────────────
  // Backed by Neon (key = configKey) when DATABASE_URL is set — so operator
  // settings survive a Render redeploy — else a local file (configPath).
  #applyConfig(c) {
    if (!c) return;
    if (typeof c.paperMarginUsd === 'number') this.paperMarginUsd = c.paperMarginUsd;
    if (typeof c.liveMarginUsd  === 'number') this.liveMarginUsd  = c.liveMarginUsd;
    if (typeof c.trailing === 'boolean') this.trailing = c.trailing;
    if (typeof c.trailGapPct === 'number') this.trailGapPct = c.trailGapPct;
    if (typeof c.beTriggerPct === 'number') this.beTriggerPct = c.beTriggerPct;
    if (['tp1', 'tp2', 'tp3'].includes(c.tpTarget)) this.tpTarget = c.tpTarget;
    if (typeof c.tpPercent === 'number' && c.tpPercent >= 0) this.tpPercent = c.tpPercent;
    if (Array.isArray(c.allowedHorizons)) this.allowedHorizons = c.allowedHorizons.length ? c.allowedHorizons.map(h => String(h).toUpperCase()) : null;
    else if (c.allowedHorizons === null) this.allowedHorizons = null;
    if (typeof c.minAlignment === 'number') this.minAlignment = Math.max(0, Math.min(6, c.minAlignment));
    if (c.allowTriggers && typeof c.allowTriggers === 'object') this.allowTriggers = c.allowTriggers;
    else if (c.allowTriggers === null) this.allowTriggers = null;
    if (typeof c.dailyLossLimitPct === 'number') this.risk.setDailyLossLimitPct(c.dailyLossLimitPct);
  }

  #loadConfigFile() {
    if (!this.configPath || !existsSync(this.configPath)) return;
    try {
      this.#applyConfig(JSON.parse(readFileSync(this.configPath, 'utf8')));
      console.log(`[autotrade] restored config — paper $${this.paperMarginUsd} / live $${this.liveMarginUsd}, exit ${this.#exitLabel()}`);
    } catch (err) {
      console.warn(`[autotrade] config load failed: ${err.message}`);
    }
  }

  // Async config load for the Neon path (awaited at boot). No-op in file mode.
  async initConfig() {
    if (!dbEnabled() || !this.configKey) return this;
    try {
      this.#applyConfig(await kvGet(CONFIG_DB_NS, this.configKey));
      console.log(`[autotrade] restored config from Postgres — paper $${this.paperMarginUsd} / live $${this.liveMarginUsd}, exit ${this.#exitLabel()}`);
    } catch (err) {
      console.warn(`[autotrade] DB config load failed: ${err.message}`);
    }
    return this;
  }

  // ── Daily-loss breaker persistence (survives restart) ────────────────────
  #dayStateFile() {
    // Explicit override first (per-user traders have configPath=null but still
    // need a file fallback when there's no DB, else their breaker silently
    // resets every restart — the very gap this closes). Else sibling of config.
    if (this.dayStateFile) return this.dayStateFile;
    return this.configPath ? this.configPath.replace(/\.json$/i, '') + '.daystate.json' : null;
  }

  // Restore the daily-loss counter at boot (Neon, else a config-sibling file).
  // restoreDay() ignores a stale (previous-day) snapshot, so this is safe to call
  // unconditionally. Awaited in index.js (operator) and #buildTrader (users).
  async initDayState() {
    let snap = null;
    try {
      if (dbEnabled() && this.dayStateKey) snap = await kvGet(DAYSTATE_DB_NS, this.dayStateKey);
      else { const f = this.#dayStateFile(); if (f && existsSync(f)) snap = JSON.parse(readFileSync(f, 'utf8')); }
    } catch (err) { if (this.verbose) console.warn(`[autotrade] day-state load failed: ${err.message}`); }
    if (snap) this.risk.restoreDay(snap);
    return this;
  }

  #saveDayState() {
    const snap = this.risk.daySnapshot();
    if (dbEnabled() && this.dayStateKey) {
      kvSet(DAYSTATE_DB_NS, this.dayStateKey, snap).catch(err => console.warn(`[autotrade] day-state save failed: ${err.message}`));
      return;
    }
    const f = this.#dayStateFile();
    if (!f) return;
    try {
      const dir = dirname(f);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(f, JSON.stringify(snap));
    } catch (err) { if (this.verbose) console.warn(`[autotrade] day-state write failed: ${err.message}`); }
  }

  #saveConfig() {
    const c = {
      paperMarginUsd: this.paperMarginUsd, liveMarginUsd: this.liveMarginUsd,
      trailing: this.trailing, trailGapPct: this.trailGapPct, beTriggerPct: this.beTriggerPct, tpTarget: this.tpTarget, tpPercent: this.tpPercent,
      allowedHorizons: this.allowedHorizons, minAlignment: this.minAlignment,
      allowTriggers: this.allowTriggers,
      dailyLossLimitPct: this.risk.dailyLossLimitPct, savedAt: Date.now()
    };
    if (dbEnabled() && this.configKey) {
      kvSet(CONFIG_DB_NS, this.configKey, c).catch(err => console.warn(`[autotrade] DB config save failed: ${err.message}`));
      return;
    }
    if (!this.configPath) return;
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(c, null, 2));
    } catch (err) {
      console.warn(`[autotrade] config save failed: ${err.message}`);
    }
  }

  #exitLabel() {
    if (this.tpPercent > 0) return `+${this.tpPercent}% ROI`;
    return this.trailing ? 'trailing' : `fixed ${this.tpTarget}`;
  }

  // Switch the exit style at runtime and persist it:
  //   'trail'|'trailing' → hold toward TP3, ratchet SL → breakeven/TP1
  //   'tp1'|'tp2'|'tp3'  → fixed: close at that plan TP
  // Clears any fixed-% TP. Returns { ok, trailing, tpTarget } or { ok:false }.
  setTpMode(mode) {
    const m = String(mode || '').toLowerCase();
    if (m === 'trail' || m === 'trailing') {
      this.trailing = true; this.tpPercent = 0;
    } else if (['tp1', 'tp2', 'tp3'].includes(m)) {
      this.trailing = false; this.tpTarget = m; this.tpPercent = 0;
    } else {
      return { ok: false, reason: `unknown exit "${mode}" — use tp1 | tp2 | tp3 | trail` };
    }
    this.#saveConfig();
    console.log(`[autotrade] exit style → ${this.#exitLabel()} (persisted)`);
    return { ok: true, trailing: this.trailing, tpTarget: this.tpTarget };
  }

  // Fixed take-profit at +pct% ROI on margin (overrides trailing/tpTarget). The
  // actual TP price is computed per-trade from entry + leverage. 0 clears it.
  setTpPercent(pct) {
    const p = Math.max(0, Number(pct) || 0);
    this.tpPercent = p;
    if (p > 0) this.trailing = false;        // fixed % and trailing are mutually exclusive
    this.#saveConfig();
    console.log(`[autotrade] exit style → ${this.#exitLabel()} (persisted)`);
    return { ok: true, tpPercent: p };
  }
  // Per-account profit-trail toggle. ON → after breakeven, trail the stop
  // TRAIL_GAP_PCT below the high-water mark so a pop banks profit. OFF → the trade
  // only ever locks breakeven (the old behaviour). Persisted.
  setProfitTrail(on) {
    this.trailGapPct = on ? (Number(process.env.TRAIL_GAP_PCT) || 2.0) : 0;
    this.#saveConfig();
    console.log(`[autotrade] profit-trail → ${this.trailGapPct > 0 ? `on (gap ${this.trailGapPct}%)` : 'off'} (persisted)`);
    return { ok: true, on: this.trailGapPct > 0 };
  }
  // Per-account breakeven toggle. OFF (beTriggerPct=0) lets a trade ride to its
  // TP or full SL instead of scratching at entry — for traders who find the
  // early-BE banks too many would-be winners (the "hits BE then goes well" case).
  setBreakeven(on) {
    this.beTriggerPct = on ? (Number(process.env.BE_TRIGGER_PCT) || 1.5) : 0;
    this.#saveConfig();
    console.log(`[autotrade ${this.logTag}] breakeven → ${this.beTriggerPct > 0 ? `on (+${this.beTriggerPct}%)` : 'off'} (persisted)`);
    return { ok: true, on: this.beTriggerPct > 0 };
  }
  get marginUsd() { return this.mode === 'paper' ? this.paperMarginUsd : this.liveMarginUsd; }

  // Triggers that are OFF unless explicitly enabled (low-WR momentum buckets +
  // distribution, per the Neon stats: surge/movers ~34-41% WR, distribution the
  // anti-edge). Everything else (flow, liquidation, funding, watchlist, majors,
  // volumeSpike, liqSweep, prePump…) defaults ON. 'listing' is NOT here — it has
  // its own AUTOTRADE_LISTING gate and is exempt from #triggerAllowed.
  static #TRIGGERS_OFF_BY_DEFAULT = new Set(['surge', 'movers', 'distribution']);

  // Per-trigger allowlist. Resolution order, first hit wins:
  //   1. per-account toggle  (this.allowTriggers[trig] === true/false)
  //   2. operator env        (AUTOTRADE_ALLOW_<TRIG> === '1' / '0')
  //   3. default             (OFF set above → false, else true)
  #triggerAllowed(trig) {
    if (!trig) return true;                       // untyped signal → not gated here
    const key = String(trig).toLowerCase();
    const acct = this.allowTriggers ? this.allowTriggers[key] : undefined;
    if (acct === true) return true;
    if (acct === false) return false;
    const env = process.env[`AUTOTRADE_ALLOW_${key.toUpperCase()}`];
    if (env === '1') return true;
    if (env === '0') return false;
    return !AutoTrader.#TRIGGERS_OFF_BY_DEFAULT.has(key);
  }

  // Per-account UI: flip one trigger on/off (or clear back to the env/default
  // with `null`). Persisted via #saveConfig so it survives restarts.
  setTriggerAllowed(trig, on) {
    const key = String(trig || '').toLowerCase();
    if (!key) return { ok: false };
    if (!this.allowTriggers) this.allowTriggers = {};
    if (on === null) delete this.allowTriggers[key];
    else this.allowTriggers[key] = !!on;
    if (!Object.keys(this.allowTriggers).length) this.allowTriggers = null;
    this.#saveConfig();
    console.log(`[autotrade ${this.logTag}] trigger '${key}' → ${on === null ? 'default' : (on ? 'on' : 'off')} (persisted)`);
    return { ok: true, trig: key, state: on === null ? 'default' : (on ? 'on' : 'off') };
  }

  status() {
    return {
      mode: this.mode,
      armed: this.armed,
      hasLiveKeys: !!this.liveBroker,
      shortOnly: this.shortOnly,
      minAlignment: this.minAlignment,
      minAlignmentWeight: this.minAlignmentWeight,
      skipScalp: this.skipScalp,
      allowedHorizons: this.allowedHorizons,   // null = legacy skipScalp; else explicit allowlist
      allowTriggers: this.allowTriggers,       // per-account trigger overrides; null = env/defaults
      trailing: this.trailing,
      trailGapPct: this.trailGapPct,
      beTriggerPct: this.beTriggerPct,
      marginUsd: this.marginUsd,
      tpTarget: this.tpTarget,
      tpPercent: this.tpPercent,
      ...this.risk.status(),
      journal: this.#scopedJournal()
    };
  }

  // Journal scoped to the ACTIVE mode — paper mode shows paper stats, live shows
  // live — so the status P&L isn't a confusing paper+live blend (live can be green
  // while paper experiments drag the combined number red). OFF → combined overview.
  #scopedJournal() {
    if (typeof this.store?.breakdown !== 'function') return this.store?.stats?.() ?? {};
    const mode = this.mode === 'off' ? null : this.mode;
    const b = this.store.breakdown(mode);
    return {
      mode: this.mode,
      closed: b.closed,
      open: b.open,
      wins: b.wins,
      winRate: b.closed ? (b.wins / b.closed) * 100 : 0,
      totalPnlUsd: b.realisedUsd,
    };
  }

  // ── Per-account signal filters (horizons + alignment) ───────────────────────
  // Set the trade-horizon allowlist (array of SCALP/DAY/SWING/POSITION). Empty/
  // null clears it back to the legacy skipScalp behaviour. Returns the normalised
  // list (or null). Callers persist via their own settings store.
  setAllowedHorizons(horizons) {
    if (!horizons || (Array.isArray(horizons) && horizons.length === 0)) {
      this.allowedHorizons = null;
    } else {
      this.allowedHorizons = horizons.map(h => String(h).toUpperCase());
    }
    this.#saveConfig();
    return { ok: true, allowedHorizons: this.allowedHorizons };
  }
  // Set the minimum multi-TF alignment count (0–6; 0 = off).
  setMinAlignment(n) {
    const v = Math.max(0, Math.min(6, Math.round(Number(n) || 0)));
    this.minAlignment = v;
    this.#saveConfig();
    return { ok: true, minAlignment: v };
  }

  // Set the daily-loss circuit breaker (% of the day's opening balance; 0 = off)
  // and persist it. The breaker stops NEW trades for the rest of the UTC day
  // once cumulative realised loss crosses the limit (open positions keep their
  // exchange SL/TP). Raising the limit lifts an already-tripped halt.
  setDailyLimit(pct) {
    const v = this.risk.setDailyLossLimitPct(pct);
    this.#saveConfig();      // the limit % lives in config
    this.#saveDayState();    // the limit can flip `halted` — persist that too
    console.log(`[autotrade] daily-loss limit → ${v > 0 ? `${v}%` : 'off'} (persisted)`);
    return { ok: true, dailyLossLimitPct: v, halted: this.risk.halted };
  }

  // Subscribe this to conductor.on('signal', sig => trader.onSignal(sig)).
  async onSignal(signal) {
    if (!this.active) return;
    try {
      await this.#handle(signal);
    } catch (err) {
      console.warn(`[autotrade] onSignal ${signal?.token?.symbol} error: ${err.message}`);
    }
  }

  async #handle(signal) {
    const sym = signal.token?.symbol;
    const side = signal.side;                 // 'LONG' | 'SHORT'
    const plan = signal.tradePlan;
    if (!sym || !side || !plan) return;

    // CEX-distribution signals are on-chain market intel for the OPERATOR to act
    // on by JUDGMENT — never auto-traded (the SKYAI/LAB lesson: concentrated
    // outflow can be a real dump OR a fake-out / non-selling sub-wallet / OTC).
    // Signals-only by design, regardless of tier.
    if (signal.trigger?.type === 'distribution') {
      if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — distribution signal (signals-only, your call)`);
      return;
    }

    // Momentum-bucket capital gate (live-data audit 2026-06-10, 345 resolved
    // signals): the on-chain/funding triggers win 60-70% but the MOMENTUM
    // buckets lose money on live capital — movers 33.8% WR (~-0.22R/trade) and
    // surge 41% (~breakeven after Bybit fees). So the autotrader does NOT deploy
    // capital on momentum-only triggers by default; they still fire as ALERTS
    // for operator judgment. This leaves autotrade running on the +EV set
    // (flow / funding_extreme / liquidation). Re-enable surge with
    // AUTOTRADE_ALLOW_SURGE=1; re-enable movers with AUTOTRADE_ALLOW_MOVERS=1.
    // PER-TRIGGER allowlist — a generic gate covering EVERY trigger (was two hardcoded
    // surge/movers checks). Listing has its own AUTOTRADE_LISTING gate below, so it's
    // exempt here. This runs ALONGSIDE the TF-alignment / horizon gates, not instead of
    // them. Resolution order: per-account toggle → operator AUTOTRADE_ALLOW_<TRIG> env →
    // default (surge/movers/distribution OFF, everything else ON).
    const trig = signal.trigger?.type;
    if (trig !== 'listing' && !this.#triggerAllowed(trig)) {
      if (this.verbose) console.log(`[autotrade ${this.logTag}] skip ${side} ${sym} — trigger '${trig}' not allowed (toggle in Signal filters / AUTOTRADE_ALLOW_${String(trig).toUpperCase()}=1)`);
      return;
    }

    // A+ high-conviction filter (opt-in). With AUTOTRADE_HIGH_CONVICTION_ONLY=1
    // the autotrader deploys capital ONLY on the elite multi-edge "fat pitch"
    // signals the Conductor graded A+ (highConviction) — the highest-win-rate
    // subset. Everything else still ALERTS for your own judgement. (Listings are
    // exempt — they're a pre-structure catalyst, handled just below.)
    if (process.env.AUTOTRADE_HIGH_CONVICTION_ONLY === '1' && !signal.highConviction && trig !== 'listing') {
      if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — not A+ high-conviction (AUTOTRADE_HIGH_CONVICTION_ONLY)`);
      return;
    }

    // New-listing catalyst (Upbit/Bithumb/Binance). These pump on the
    // ANNOUNCEMENT, before any multi-TF structure exists — so we deliberately
    // SKIP the horizon + alignment gates below and trade the signal straight
    // (it still must be MEDIUM+ tier, LONG, have a valid plan, and clear the
    // risk/sizing/daily-loss/concurrency gates). Disable with AUTOTRADE_LISTING=0.
    const isListing = trig === 'listing';
    if (isListing && process.env.AUTOTRADE_LISTING === '0') {
      if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — listing autotrade disabled (AUTOTRADE_LISTING=0)`);
      return;
    }

    // Filters
    if (this.shortOnly && side !== 'SHORT') {
      if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — shortOnly mode`);
      return;
    }
    const tier = signal.strength?.label;
    if (!['MEDIUM', 'HIGH', 'VERY HIGH'].includes(tier)) return;

    // Fast-scalp gate — SCALP-horizon setups are the weakest (low multi-TF
    // alignment, tight 5m stops). By default the autotrader SKIPS them so they
    // ride as signals/alerts only and can be evaluated in isolation before
    // risking capital. Toggle with AUTOTRADE_SKIP_SCALP=0.
    // Horizon allowlist takes precedence when configured (per-account): only the
    // listed trade horizons auto-trade. Falls back to the legacy skipScalp gate.
    if (!isListing && this.allowedHorizons) {
      const h = String(plan.horizon ?? '').toUpperCase();
      if (h && !this.allowedHorizons.includes(h)) {
        if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — ${h} horizon not in allowlist [${this.allowedHorizons.join(',')}]`);
        return;
      }
    } else if (!isListing && this.skipScalp && plan.horizon === 'SCALP') {
      if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — SCALP horizon (signals-only)`);
      return;
    }

    // Trend-alignment gate. PREFER the WEIGHTED metric (audit §3.26): a raw
    // count biases toward easy 1m+5m agreement (noise), while a single weekly/
    // daily TF carries real conviction at count=1. minAlignmentWeight gates on
    // plan.weightedAlignment; the legacy count gate stays as a fallback when no
    // weight threshold is configured.
    // Listings skip the TF-alignment gate entirely (a fresh listing has no TF
    // structure to align — that is the whole point of the catalyst trade).
    if (isListing) {
      if (this.verbose) console.log(`[autotrade] ${side} ${sym} — listing catalyst, bypassing horizon + alignment gates`);
    } else if (this.minAlignmentWeight > 0) {
      const wa = plan.weightedAlignment ?? 0;
      if (wa < this.minAlignmentWeight) {
        if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — weighted alignment ${wa.toFixed(2)} < required ${this.minAlignmentWeight}`);
        return;
      }
    } else if (this.minAlignment > 0) {
      const aligned = plan.alignmentCount ?? 0;
      if (aligned < this.minAlignment) {
        if (this.verbose) console.log(`[autotrade] skip ${side} ${sym} — alignment ${aligned}/6 < required ${this.minAlignment}/6`);
        return;
      }
    }

    const entry = plan.limitEntry && plan.isLiquidityGrab ? plan.limitEntry : plan.entry;
    const sl = plan.sl;
    // When trailing, the order's TP is the FURTHEST target (tp3) so the runner
    // can reach it; the SL ratchets up to breakeven/TP1 after TP1/TP2 (see
    // #trailLive). Otherwise it's the single configured tpTarget.
    const tp = this.trailing
      ? (plan.tp3 ?? plan.tp2 ?? plan.tp1)
      : (plan[this.tpTarget] ?? plan.tp2 ?? plan.tp1);
    if (![entry, sl, tp].every(v => typeof v === 'number' && isFinite(v) && v > 0)) {
      if (this.verbose) console.log(`[autotrade] skip ${sym} — incomplete plan levels`);
      return;
    }

    // DON'T CHASE A MATURE / EXHAUSTED MOVE with capital. A surge/movers entry
    // into multi-TF exhaustion (overbought for a LONG, oversold for a SHORT) is
    // the blow-off, not the move: the WCT case (no early signal, then a surge
    // LONG at +20% into overbought → SL). The signal still ALERTS for your
    // judgment; this only blocks the auto-fill. Re-enable with AUTOTRADE_CHASE_EXHAUSTED=1.
    const mtrig = signal.trigger?.type;
    // Scan / momentum paths have no leading on-chain trigger, so an entry into a
    // stretched move there is a chase. The on-chain event triggers (flow /
    // distribution / liquidation / funding_extreme) are exempt: the exhaustion is
    // part of their thesis and they carry a real edge.
    const scanLike = mtrig === 'surge' || mtrig === 'movers' || mtrig === 'majors' || mtrig === 'watchlist';
    const exTfs = plan.exhaustionTfs ?? 0;
    if (scanLike && !isListing && (plan.entryTfExhausted || exTfs >= 2) && process.env.AUTOTRADE_CHASE_EXHAUSTED !== '1') {
      console.log(`[autotrade ${this.logTag}] skip ${side} ${sym}: ${mtrig} into exhaustion (${exTfs} HTF overextended${plan.entryTfExhausted ? ' + entry-TF extreme' : ''}); not chasing the blow-off`);
      return;
    }

    // R:R floor — don't deploy capital when the EXIT target pays less than the
    // stop risks (the VELVET 0.81R case: risk 7% to make 5.7%). Gates on the
    // ACTUAL exit target's R:R: tp3 when trailing (the runner), else the
    // configured fixed target. Signals still ALERT; this only blocks the fill.
    const exitRr = this.trailing
      ? (plan.rr3 ?? plan.rr2 ?? plan.rr1 ?? 0)
      : (plan[`rr${String(this.tpTarget || 'tp1').slice(2)}`] ?? plan.rr1 ?? 0);
    if (this.minRr > 0 && exitRr > 0 && exitRr < this.minRr) {
      console.log(`[autotrade ${this.logTag}] skip ${side} ${sym} — R:R ${exitRr.toFixed(2)} < ${this.minRr} (exit target pays less than the stop risks)`);
      return;
    }

    // Live interlock
    if (this.isLive && !this.armed) {
      console.log(`[autotrade ${this.logTag}] would trade ${side} ${sym} but NOT ARMED — run /autotrade on (or AUTOTRADE_ARMED=1)`);
      return;
    }

    const bybitSym = `${sym}USDT`;

    // Duplicate guard (per-symbol, current mode). NOTE: the journal stores the
    // symbol as `${sym}USDT`, so this MUST check bybitSym — the old code checked
    // the bare `sym` ("STG") which never matched a "STGUSDT" record, so the
    // guard never fired and multiple positions could stack on one symbol.
    if (this.store.hasOpen(bybitSym, this.mode)) {
      if (this.verbose) console.log(`[autotrade] skip ${sym} — already have an open ${this.mode} auto-trade`);
      return;
    }
    // SYNCHRONOUS same-symbol reservation. hasOpen() above and store.append()
    // below straddle several awaits, so two signals for the SAME symbol in one
    // tick could both pass hasOpen and double-fill (CLAUDE.md known gap). JS is
    // single-threaded, so a check-then-add with no await between is atomic. The
    // finally clears it so a FAILED attempt never locks the symbol forever.
    if (this._reserved.has(bybitSym)) {
      if (this.verbose) console.log(`[autotrade] skip ${sym} — an order is already in-flight for ${bybitSym}`);
      return;
    }
    this._reserved.add(bybitSym);
    try {

    // Fetch balance, open positions, and instrument metadata IN PARALLEL — they
    // don't depend on each other, so doing them concurrently (instead of three
    // sequential relay round-trips) shaves a big chunk off entry latency. The
    // instrument is cached after the first trade per symbol, so it's usually free.
    let balance, openPositions, inst;
    try {
      [balance, openPositions, inst] = await Promise.all([
        this.broker.getBalance(),
        this.broker.getPositions().catch(() => []),
        this.broker.getInstrument(bybitSym).catch(() => null)
      ]);
    } catch (err) { console.warn(`[autotrade] pre-order fetch failed ${sym}: ${err.message}`); return; }

    // Risk gate
    const gate = this.risk.canTrade({ balance, symbol: bybitSym, openPositions, mode: this.mode });
    if (!gate.ok) {
      console.log(`[autotrade ${this.logTag}] gate blocked ${side} ${sym}: ${gate.reason}`);
      return;
    }

    // Sizing. When a fixed margin is configured for the active mode, commit
    // exactly that collateral per trade (notional = margin × leverage). With no
    // fixed margin, sizing is risk-based + maxPositionUsd-capped (the safe live
    // default). Set per mode via env or `/autotrade margin <usd>`.
    const modeMargin = this.mode === 'paper' ? this.paperMarginUsd : this.liveMarginUsd;
    const marginUsd = modeMargin > 0 ? modeMargin : null;
    const sizing = this.risk.sizePosition({ balance, entry, sl, suggestedLeverage: plan.suggestedLeverage, marginUsd, instrumentMaxLev: inst?.maxLeverage });
    if (!sizing) { console.log(`[autotrade] skip ${sym} — sizing failed`); return; }

    // Fixed-ROI take-profit: when tpPercent is set, the order's TP becomes the
    // price that yields +tpPercent% return ON MARGIN at this leverage (overrides
    // the plan TP). A 30% ROI at 20x = a 1.5% price move. SL stays the plan's.
    let tpForOrder = tp;
    if (this.tpPercent > 0 && sizing.leverage > 0) {
      const move = (this.tpPercent / 100) / sizing.leverage;   // price-move fraction for that ROI
      tpForOrder = side === 'LONG' ? entry * (1 + move) : entry * (1 - move);
    }

    // Round qty / prices to the instrument grid (real exchange only). `inst` was
    // fetched in the parallel batch above.
    const BrokerClass = this.broker.constructor;
    let qty = sizing.qty;
    let slPx = sl, tpPx = tpForOrder, limitPx = entry;
    if (inst) {
      qty = BrokerClass.roundQtyDown(sizing.qty, inst.qtyStep);
      slPx = BrokerClass.roundPrice(sl, inst.tickSize);
      tpPx = BrokerClass.roundPrice(tpForOrder, inst.tickSize);
      limitPx = BrokerClass.roundPrice(entry, inst.tickSize);
      if (inst.minQty && qty < inst.minQty) {
        console.log(`[autotrade] skip ${sym} — qty ${qty} below min ${inst.minQty} (notional too small at $${this.risk.maxPositionUsd} cap)`);
        return;
      }
    }
    if (!(qty > 0)) { console.log(`[autotrade] skip ${sym} — zero qty`); return; }

    // Rounded ladder levels — the trailing manager ratchets the SL to these.
    const roundPx = (v) => (inst && v != null) ? BrokerClass.roundPrice(v, inst.tickSize) : (v ?? null);
    const tp1Px = roundPx(plan.tp1), tp2Px = roundPx(plan.tp2), tp3Px = roundPx(plan.tp3);

    // SAFETY: never open a LIVE position without a stop. The plan levels were valid
    // (checked above), so an SL/TP of 0 here means rounding failed (e.g. a sub-1e-6
    // tick). Refuse the order rather than sit unprotected. Paper is exempt.
    if (this.isLive && (!(slPx > 0) || !(tpPx > 0))) {
      console.error(`[autotrade ${this.logTag}] ABORT ${side} ${sym} — SL/TP rounded invalid (sl=${slPx} tp=${tpPx}, tick=${inst?.tickSize}); refusing a stopless live order`);
      await this.#notify(`⚠️ *Auto-trade aborted* — ${side} ${sym}\nSL/TP rounded to an invalid price (sl=${slPx}, tp=${tpPx}). No stopless order was placed.`).catch(() => {});
      return;
    }

    const bybitSide = side === 'LONG' ? 'Buy' : 'Sell';

    // Force ISOLATED margin + set leverage in one call. If Bybit refuses
    // per-symbol isolation (UTA cross/portfolio account mode), it falls back
    // to leverage-only and we warn so the user knows to flip the account
    // margin mode (or use a subaccount) for true isolation.
    let isolated = true;
    try {
      const r = await this.broker.setIsolatedAndLeverage(bybitSym, sizing.leverage);
      isolated = r?.isolated !== false;
      if (!isolated) {
        console.warn(`[autotrade] ⚠️ ${sym} NOT isolated — your Bybit UTA is in cross/portfolio account mode. Set the account to Isolated Margin in the UI (or use a subaccount) for per-position isolation. Trading anyway with leverage ${sizing.leverage}x.`);
      }
    } catch (err) {
      console.warn(`[autotrade] setIsolatedAndLeverage ${sym} failed: ${err.message}`);
    }

    // Execute
    const isLG = plan.isLiquidityGrab && plan.limitEntry;
    let order;
    try {
      order = isLG
        ? await this.broker.placeLimitOrder({ symbol: bybitSym, side: bybitSide, qty, price: limitPx, stopLoss: slPx, takeProfit: tpPx })
        : await this.broker.placeMarketOrder({ symbol: bybitSym, side: bybitSide, qty, stopLoss: slPx, takeProfit: tpPx });
    } catch (err) {
      console.warn(`[autotrade ${this.logTag}] ORDER FAILED ${side} ${sym}: ${err.message}`);
      await this.#notify(`⚠️ *Auto-trade failed* — ${side} ${sym}\n${err.message}`);
      return;
    }

    const id = `${this.mode}-${sym}-${Date.now()}-${++this._seq}`;
    const fillPrice = Number(order?.avgPrice ?? entry);
    const record = {
      id, ts: Date.now(), mode: this.mode, symbol: bybitSym, side: bybitSide,
      qty, notionalUsd: Number(sizing.notionalUsd.toFixed(2)), leverage: sizing.leverage,
      entry: fillPrice, sl: slPx, tp: tpPx, isLiquidityGrab: !!isLG, isolated,
      // ORIGINAL SL distance (%) — frozen at entry so the volatility-scaled BE/
      // trail keys off the real risk, not the SL after it's been ratcheted up.
      riskPct: Math.abs((slPx - fillPrice) / fillPrice) * 100,
      // A market order is filled instantly; a LIMIT entry rests until price hits
      // it. `filled` gates resolution — a pending limit that has no position yet
      // must NOT be mis-resolved as a TP/SL close (the phantom-win bug).
      filled: !isLG,
      orderId: order?.orderId ?? null,
      limitPrice: isLG ? limitPx : null,
      validityHrs: plan.validityHrs ?? 24,
      // Trailing ladder: the SL ratchets to breakeven after TP1, to TP1 after TP2.
      trailing: !!this.trailing, trailStage: 0, tp1: tp1Px, tp2: tp2Px, tp3: tp3Px,
      score: signal.strength?.total ?? null, tier,
      status: 'open', closedAt: null, exitPrice: null, pnlUsd: null, pnlPct: null, reason: null
    };
    this.store.append(record);
    const trailNote = this.trailing ? ` (trailing: TP→tp3, SL ratchets after TP1/TP2)` : '';
    console.log(`[autotrade ${this.logTag}] ${this.mode.toUpperCase()} ${bybitSide} ${bybitSym} qty=${qty} notional=$${record.notionalUsd} lev=${sizing.leverage}x ${isolated ? 'ISOLATED' : 'CROSS'} entry=${fillPrice} SL=${slPx} TP=${tpPx}${trailNote}`);
    await this.#notify(
`🤖 *Auto-trade ${this.mode === 'paper' ? '(paper)' : 'LIVE'}* — ${side} ${sym}${isLG ? ' _(limit resting)_' : ''}
Size: ${qty} (~$${record.notionalUsd} notional • $${sizing.marginUsedUsd} margin) • ${sizing.leverage}x • ${isolated ? 'isolated' : '⚠️ cross'}
${isLG ? 'Limit' : 'Entry'}: ${fillPrice}${isLG ? `  _(fills only if price reaches it)_` : ''}
SL: ${slPx}  •  TP: ${tpPx}${this.trailing ? `  _(trailing → ${tp3Px})_` : ''}
_From ${tier} signal (score ${(signal.strength?.total ?? 0).toFixed(2)})_`);
    } finally {
      this._reserved.delete(bybitSym);   // clear reservation (append guards future ticks via hasOpen)
    }
  }

  // Poll for closed positions and resolve outcomes.
  async #monitor() {
    if (!this.active) return;

    // Only ever manage trades opened in the CURRENT mode — otherwise switching
    // paper↔live makes the live monitor resolve leftover PAPER trades through
    // the Bybit/last-price path (and feed their P&L into the LIVE daily-loss
    // breaker), or vice-versa. (Legacy records with no mode default to 'live'.)
    const mineOpen = this.store.openTrades().filter(t => (t.mode ?? 'live') === this.mode);

    // Paper: ratchet trailing stops, then resolve SL/TP touches client-side.
    if (this.mode === 'paper' && typeof this.broker.resolveTouches === 'function') {
      // Run stop management whenever ANY of breakeven / profit-trail / TP-ladder is
      // active — NOT only in trailing mode. (Fixed-TP1 users with bank-pops on still
      // want auto-breakeven + the profit-trail; the old `if (this.trailing)` gate
      // silently disabled both for them.)
      if (this.trailing || this.beTriggerPct > 0 || this.trailGapPct > 0) await this.#trail(mineOpen, (sym) => this.#lastPrice(sym));
      for (const t of this.broker.resolveTouches()) {
        await this.#resolveBySymbol(t.symbol, t.exitPrice, t.pnlUsd, t.reason);
      }
      return;
    }

    // Live: compare our open journal against the exchange's open positions.
    // Anything in the journal but NOT on the exchange = closed (SL/TP filled).
    const open = mineOpen;
    let exchangePositions;
    try { exchangePositions = await this.broker.getPositions(); }
    catch { return; }
    const posBySym = new Map(exchangePositions.map(p => [p.symbol, p]));
    const liveSymbols = new Set(posBySym.keys());

    // ORPHAN WATCH (alert-only). A position open on the exchange that this bot is
    // NOT tracking — a journal entry lost after a crash, or the user's own manual
    // trade. We do NOT touch it (force-closing someone's manual position is worse
    // than the problem), but we ALERT ONCE so an unmanaged, SL-unsupervised
    // position is visible. Skip symbols with an order in-flight (the append just
    // hasn't landed) and ones already alerted. Checked BEFORE the no-journal early
    // return so a fully-lost journal still surfaces its orphans.
    const journalSyms = new Set(open.map(t => t.symbol));
    for (const sym of liveSymbols) {
      if (journalSyms.has(sym) || this._reserved.has(sym)) { this._alertedOrphans.delete(sym); continue; }
      if (this._alertedOrphans.has(sym)) continue;
      this._alertedOrphans.add(sym);
      const p = posBySym.get(sym);
      console.warn(`[autotrade] ORPHAN ${sym} (size ${p?.size}, entry ${p?.entryPrice}) — on exchange, not in journal; NOT managed`);
      await this.#notify(`⚠️ *Untracked position* — ${sym.replace(/USDT$/, '')} (size ${p?.size ?? '?'}, entry ${p?.entryPrice ?? '?'}) is open on your account but the bot is *not* tracking it, so its SL/TP is *not* managed.\nIf the bot opened it and lost track on a restart, close it manually; if it's your own trade, ignore this.`);
    }
    for (const sym of this._alertedOrphans) if (!liveSymbols.has(sym)) this._alertedOrphans.delete(sym);

    if (open.length === 0) return;

    // Ratchet stops on still-open positions before resolving closes. Runs for
    // breakeven / profit-trail / TP-ladder — not only trailing mode (see paper path).
    if (this.trailing || this.beTriggerPct > 0 || this.trailGapPct > 0) {
      await this.#trail(open.filter(t => liveSymbols.has(t.symbol)),
        (sym) => posBySym.get(sym)?.markPrice ?? this.#lastPrice(sym));
    }

    for (const t of open) {
      if (liveSymbols.has(t.symbol)) {
        // A position exists. If this trade was a resting LIMIT that hadn't
        // filled, it just FILLED — record that + the real entry price, then let
        // the trailing manager take over. (Without this the trade would later be
        // mis-resolved.)
        if (t.filled === false) {
          const realEntry = Number(posBySym.get(t.symbol)?.entryPrice);
          const patch = isFinite(realEntry) && realEntry > 0 ? { filled: true, entry: realEntry } : { filled: true };
          this.store.updateTrade(t.id, patch);
          console.log(`[autotrade] limit FILLED ${t.symbol} @ ${patch.entry ?? t.entry}`);
          await this.#notify(`✅ *Limit filled* — ${t.side === 'Buy' ? 'LONG' : 'SHORT'} ${t.symbol.replace(/USDT$/, '')} @ ${patch.entry ?? t.entry}. Now managing SL/TP.`);
        }
        continue;                                    // still open on the exchange
      }

      // No position. Try the AUTHORITATIVE closed-PnL ledger first — handles a
      // filled market order AND a filled-then-closed limit. Match THIS bot's
      // position (qty ±2% / entry ±1%, updated at/after open) so a manual trade
      // on the same symbol can't get misattributed.
      let resolved = false;
      if (typeof this.broker.getClosedPnl === 'function') {
        try {
          const records = await this.broker.getClosedPnl(t.symbol, 50);
          const qtyTol = Math.abs(t.qty) * 0.02 + 1e-9;
          const rec = records.find(r =>
            (r.updatedTime ?? 0) >= t.ts - 60_000 &&
            isFinite(r.qty) && Math.abs(r.qty - t.qty) <= qtyTol &&
            (!isFinite(r.avgEntryPrice) || !(t.entry > 0) || Math.abs(r.avgEntryPrice - t.entry) / t.entry <= 0.01)
          );
          if (rec && isFinite(rec.avgExitPrice) && isFinite(rec.closedPnl)) {
            await this.#resolveBySymbol(t.symbol, rec.avgExitPrice, rec.closedPnl, this.#classifyExit(t, rec.avgExitPrice), t);
            resolved = true;
          }
        } catch (err) {
          if (this.verbose) console.warn(`[autotrade] closed-pnl lookup ${t.symbol} failed: ${err.message}`);
        }
      }
      if (resolved) continue;

      // A LIMIT entry that has NOT filled (no position, no close) must NOT be
      // resolved as a TP/SL — that was the phantom-win bug. Leave it resting
      // until it fills, and cancel + expire it once its validity window passes.
      if (t.filled === false) {
        const validityMs = (t.validityHrs ?? 24) * 3600_000;
        if (Date.now() - t.ts > validityMs) {
          try { await this.broker.cancelOrder?.(t.symbol, t.orderId); }
          catch (err) { if (this.verbose) console.warn(`[autotrade] cancel ${t.symbol}: ${err.message}`); }
          this.store.closeTrade(t.id, { exitPrice: null, pnlUsd: 0, pnlPct: 0, reason: 'EXPIRED_UNFILLED' });
          console.log(`[autotrade] limit ${t.symbol} expired unfilled after ${t.validityHrs}h — order cancelled`);
          await this.#notify(`⏳ *Limit expired* — ${t.symbol.replace(/USDT$/, '')} never reached ${t.limitPrice ?? t.entry}; order cancelled, no trade taken.`);
        }
        continue;                                    // still within validity → keep waiting
      }

      // Filled trade, no position, no matching closed-pnl: last-price estimate
      // (paper, or closed-pnl unavailable). Classify by the NEAREST of TP/SL.
      // Fall back to TP, then ENTRY (breakeven) if no live price — never leave px
      // null/undefined, which would make pnlUsd NaN and silently corrupt the
      // daily-loss counter (defeating the breaker).
      const px = this.#lastPrice(t.symbol) ?? t.tp ?? t.entry;
      const dir = t.side === 'Buy' ? 1 : -1;
      const pnlUsd = (px - t.entry) * dir * t.qty;
      await this.#resolveBySymbol(t.symbol, px, pnlUsd, this.#classifyExit(t, px), t);
    }
  }

  // Classify an exit as a TP or SL fill by whichever level it landed closest to
  // — robust to a TP fill that retraced slightly before the next poll.
  #classifyExit(t, exitPx) {
    const dTp = t.tp != null ? Math.abs(exitPx - t.tp) : Infinity;
    const dSl = t.sl != null ? Math.abs(exitPx - t.sl) : Infinity;
    return dTp <= dSl ? 'TP' : 'SL';
  }

  // How far up the TP ladder has price travelled (0 = none, 1 = TP1, 2 = TP2).
  #reachedStage(t, price) {
    const long = t.side === 'Buy';
    if (long) {
      if (t.tp2 && price >= t.tp2) return 2;
      if (t.tp1 && price >= t.tp1) return 1;
    } else {
      if (t.tp2 && price <= t.tp2) return 2;
      if (t.tp1 && price <= t.tp1) return 1;
    }
    return 0;
  }

  // Ratchet the SL on open trailing trades: once price reaches TP1 → SL to
  // breakeven (entry); once TP2 → SL to TP1. Amends the live exchange stop (or
  // the paper position) and records the new stage. Idempotent — only fires when
  // the reached stage exceeds the recorded one, so the stop only ever moves UP
  // (never loosens). This is item E: a runner that tags TP1 then reverses can no
  // longer become a loss.
  async #trail(openTrades, priceFn) {
    for (const t of openTrades) {
      // Early-BE + profit-trail run for ALL exit modes (fixed-TP included); only the
      // TP-ladder ratchet at the bottom is trailing-specific. The old `!t.trailing`
      // gate here disabled breakeven + bank-pops for every fixed-TP1 trade.
      if (!(t.tp1 > 0)) continue;
      const price = priceFn(t.symbol);
      if (!price || !isFinite(price)) continue;
      const long = t.side === 'Buy';

      // FAVOURABLE HIGH-WATER MARK — the best price the trade has reached in our
      // favour across polls. Breakeven / profit-trail / TP-ladder are all keyed off
      // THIS peak, not the instantaneous price. A move that spiked +2% then pulled
      // back between 30s polls still arms breakeven — the exact gap that left MAGMA
      // running to its full stop while the signal-tracker logged a +2% MFE. Only
      // moves further in-favour; persisted so a restart keeps the peak.
      // Mutate the live row in memory (cheap); it's persisted opportunistically with
      // the next breakeven/trail updateTrade — no kv write every poll. A restart
      // before that just re-seeds the peak from the current price (minor).
      const favPrice = long ? Math.max(t.peakFavPrice ?? 0, price)
                            : Math.min(t.peakFavPrice ?? Infinity, price);
      t.peakFavPrice = favPrice;
      const favPct = long ? (favPrice - t.entry) / t.entry * 100
                          : (t.entry - favPrice) / t.entry * 100;

      // VOLATILITY-SCALED arm + gap: a flat 1.5%/2% sits inside a high-ATR token's
      // noise (a 7%-SL token wiggles 3-4%), scratching good entries before any real
      // target. Scale to THIS trade's original SL distance, floored at the flat
      // values so calm tokens stay tight. (riskPct frozen at entry; legacy rows
      // fall back to the live SL distance.)
      const riskPct = t.riskPct ?? (t.sl > 0 ? Math.abs((t.sl - t.entry) / t.entry) * 100 : 0);
      const beArm = Math.max(this.beTriggerPct, this.beSlFrac * riskPct);
      const trailGap = Math.max(this.trailGapPct, this.trailSlFrac * riskPct);

      // EARLY breakeven (pre-TP1). Once the PEAK shows +beArm in favour and the
      // TP1 ratchet hasn't engaged yet, lift the stop to entry(+fee buffer).
      // Idempotent via t.beMoved; only moves the stop UP. Converts the "+2.8% then
      // −6.9%" losers into scratches.
      if (this.beTriggerPct > 0 && !t.beMoved && (t.trailStage ?? 0) < 1) {
        if (favPct >= beArm) {
          const be = long ? t.entry * (1 + this.beOffsetPct / 100)
                          : t.entry * (1 - this.beOffsetPct / 100);
          try {
            if (this.mode === 'paper') this.broker.setStop?.(t.symbol, { stopLoss: be });
            else await this.broker.setTradingStop(t.symbol, { stopLoss: be });
            this.store.updateTrade(t.id, { beMoved: true, sl: be });
            console.log(`[autotrade] early-BE ${t.symbol} → peak +${favPct.toFixed(1)}%, SL → breakeven (${be})`);
            await this.#notify(`🛡️ *Breakeven* — ${t.symbol} reached +${favPct.toFixed(1)}%; stop moved to *breakeven*. Worst case is now a scratch, not a loss.`);
          } catch (err) {
            console.warn(`[autotrade] early-BE ${t.symbol} failed: ${err.message}`);
          }
          continue;   // done with this trade this tick
        }
      }

      // PROFIT-TRAIL (after breakeven). Ratchet the stop to lock (PEAK% − gap) of
      // profit, only ever moving UP. So a pop to +4% that reverses exits around +2%
      // instead of scratching at breakeven — banking the pop even if it retraced
      // between polls. The far TP3 + stage ratchet still ride underneath.
      if (this.trailGapPct > 0 && t.beMoved) {
        const lockPct = favPct - trailGap;
        if (lockPct > (t.lockedPct ?? 0) + 0.1) {        // only ratchet up meaningfully
          const newSl = long ? t.entry * (1 + lockPct / 100) : t.entry * (1 - lockPct / 100);
          try {
            if (this.mode === 'paper') this.broker.setStop?.(t.symbol, { stopLoss: newSl });
            else await this.broker.setTradingStop(t.symbol, { stopLoss: newSl });
            this.store.updateTrade(t.id, { lockedPct: Number(lockPct.toFixed(2)), sl: newSl });
            console.log(`[autotrade] profit-trail ${t.symbol} → peak +${favPct.toFixed(1)}%, SL locks +${lockPct.toFixed(1)}%`);
          } catch (err) {
            console.warn(`[autotrade] profit-trail ${t.symbol} failed: ${err.message}`);
          }
          continue;
        }
      }

      // TP-LADDER ratchet (hold toward TP3, SL→breakeven after TP1, →TP1 after TP2):
      // trailing-exit only. A TP counts as "reached" at the favourable EXTREME (peak).
      if (!t.trailing) continue;
      const stage = this.#reachedStage(t, favPrice);
      if (stage <= (t.trailStage ?? 0)) continue;
      const newSl = stage >= 2 ? t.tp1 : t.entry;          // TP2→TP1, TP1→breakeven
      try {
        if (this.mode === 'paper') this.broker.setStop?.(t.symbol, { stopLoss: newSl });
        else await this.broker.setTradingStop(t.symbol, { stopLoss: newSl });
        this.store.updateTrade(t.id, { trailStage: stage, sl: newSl });
        const word = stage >= 2 ? 'TP1 (+1R locked)' : 'breakeven';
        console.log(`[autotrade] trail ${t.symbol} → reached TP${stage}, SL → ${word} (${newSl})`);
        await this.#notify(`🪜 *Trail* — ${t.symbol} reached TP${stage}; stop moved to *${word}*. Runner now targets TP3, can't turn into a loss.`);
      } catch (err) {
        console.warn(`[autotrade] trail ${t.symbol} failed: ${err.message}`);
      }
    }
  }

  // Operator manual close (/autotrade close <symbol>). Sends a reduce-only
  // market close to the exchange (or closes the paper position), then resolves
  // the journal entry. Returns { ok, reason }.
  async closeSymbol(symbol) {
    const bybitSym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    const trade = this.store.openTrades().find(t => t.symbol === bybitSym && (t.mode ?? this.mode) === this.mode);
    if (!trade) return { ok: false, reason: `no open ${this.mode} auto-trade for ${bybitSym}` };
    if (typeof this.broker?.closePosition !== 'function') return { ok: false, reason: 'broker has no closePosition' };
    try {
      const r = await this.broker.closePosition(bybitSym, trade.side, trade.qty);
      // Prefer the broker's reported exit (paper returns it); else last price.
      const exitPx = Number(r?.exitPrice ?? this.#lastPrice(bybitSym) ?? trade.entry);
      const dir = trade.side === 'Buy' ? 1 : -1;
      const pnlUsd = Number(r?.pnlUsd ?? (exitPx - trade.entry) * dir * trade.qty);
      await this.#resolveBySymbol(bybitSym, exitPx, pnlUsd, 'MANUAL', trade);
      return { ok: true, reason: `closed ${bybitSym} @ ${exitPx} (P&L $${pnlUsd.toFixed(2)})` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async #resolveBySymbol(bybitSym, exitPrice, pnlUsd, reason, knownTrade = null) {
    // Scope the lookup to the CURRENT mode so a paper resolve can't grab a live
    // trade's journal row (or vice-versa) when both share a symbol.
    const trade = knownTrade ?? this.store.openTrades().find(t => t.symbol === bybitSym && (t.mode ?? this.mode) === this.mode);
    if (!trade) return;
    const pnlPct = trade.notionalUsd > 0 ? (pnlUsd / trade.notionalUsd) * 100 : 0;
    this.store.closeTrade(trade.id, { exitPrice, pnlUsd, pnlPct, reason });
    this.risk.recordRealisedPnl(pnlUsd, this.mode);   // paper PnL is exempt from the live breaker
    this.#saveDayState();   // persist the daily-loss counter so a restart can't reset it
    const emoji = pnlUsd >= 0 ? '✅' : '❌';
    console.log(`[autotrade ${this.logTag}] CLOSE ${trade.side} ${bybitSym} ${reason} @ ${exitPrice} pnl $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
    await this.#notify(
`${emoji} *Auto-trade closed* — ${bybitSym} ${reason}
Exit: ${exitPrice}
P&L: *${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}* (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)
_Day realised: $${this.risk.dayRealisedPnl.toFixed(2)}${this.risk.halted ? ' • 🛑 daily limit hit' : ''}_`);
  }

  // Map a Bybit symbol (BTCUSDT) → last price via the price monitor. The
  // price monitor is keyed by cgId, so we can't look up directly by symbol;
  // the AutoTrader is given a resolver at construction if available.
  #lastPrice(bybitSym) {
    if (!this._priceBySymbol) return null;
    return this._priceBySymbol(bybitSym);
  }

  setPriceBySymbol(fn) { this._priceBySymbol = fn; }

  // Auto-trade alerts go ONLY to the operator chat (the owner of the Bybit key
  // who actually runs the autotrader) — NOT broadcast to every subscriber. Other
  // users can't act on someone else's live trades, so it'd just be noise to them.
  async #notify(text) {
    try {
      if (this.notifyChatId && this.notifier?.sendToChat) {
        await this.notifier.sendToChat(this.notifyChatId, text);
      } else {
        await this.notifier?.sendInfo?.(text);   // fallback (no operator chat configured)
      }
    } catch { /* non-fatal */ }
  }
}
