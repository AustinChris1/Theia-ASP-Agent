// Multi-user auto-trading.
//
// Each subscriber can /connect their OWN Bybit API keys; the bot then fans every
// signal out to their account, sized off their own balance and alerted in their
// own DM. Design goals: SAFE and ISOLATED.
//
//   • Keys are validated against Bybit BEFORE storage (a test getBalance call).
//   • Keys are AES-256-GCM encrypted at rest (see ../crypto-vault.js) and never
//     logged. If KEY_ENCRYPTION_SECRET is unset the feature stays disabled.
//   • Each user gets a dedicated AutoTrader (their broker + risk engine + journal
//     + monitor loop) — the SAME battle-tested execution path the operator uses,
//     so one user's failure never touches another's, and the money logic isn't
//     re-implemented.
//   • Live-only and SELF-ARMED: connecting keys does NOT start trading. The user
//     must /autotrade on. On restart, accounts come back in their saved armed
//     state.
//   • Per-user sizing: global risk % off THEIR balance, capped at a per-user
//     maxPositionUsd they control (defaults to the global cap).

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BybitExchange } from './exchange-bybit.js';
import { AutoTrader } from './auto-trader.js';
import { RiskEngine } from './risk-engine.js';
import { TradeStore } from './store.js';
import { PaperBroker } from './paper-broker.js';
import { encryptSecret, decryptSecret, vaultAvailable } from '../crypto-vault.js';
import { dbEnabled, kvGet, kvSet } from '../db.js';

const DB_NS = 'user-accounts', DB_KEY = 'all';

export class UserAccounts extends EventEmitter {
  constructor({
    notifier,
    priceBySymbol = null,
    logsDir,
    relayBaseUrl = null,
    relayAuthSecret = null,
    riskDefaults = {},            // { riskPct, maxPositionUsd, maxConcurrent, dailyLossLimitPct, maxLeverage }
    gates = {},                   // SIGNAL-quality gates shared with the operator:
                                  // { minAlignment, minAlignmentWeight, skipScalp, shortOnly }
    monitorIntervalMs = 30_000,
    verbose = false
  }) {
    super();
    this.notifier = notifier;
    this.priceBySymbol = priceBySymbol;
    this.logsDir = logsDir;
    this.relayBaseUrl = relayBaseUrl;
    this.relayAuthSecret = relayAuthSecret;
    this.riskDefaults = riskDefaults;
    this.gates = gates;
    this.monitorIntervalMs = monitorIntervalMs;
    this.verbose = verbose;
    this.path = join(logsDir, 'user-accounts.json');
    this.accounts = new Map();    // chatId(string) → { chatId, encApiKey, encApiSecret, createdAt, settings, trader }
  }

  enabled() { return vaultAvailable(); }
  has(chatId) { return this.accounts.has(String(chatId)); }
  get(chatId) { return this.accounts.get(String(chatId)); }
  count() { return this.accounts.size; }

  // Load persisted accounts and rebuild each user's trader. Called at boot.
  async start() {
    if (!vaultAvailable()) {
      console.warn('[user-accounts] KEY_ENCRYPTION_SECRET not set — per-user auto-trading DISABLED (refusing to store keys without encryption)');
      return;
    }
    await this.#load();
    let restored = 0, failed = 0;
    const brokenIds = [];
    for (const acct of this.accounts.values()) {
      try { await this.#buildTrader(acct); restored++; }
      catch (err) {
        failed++; brokenIds.push(acct.chatId);
        console.warn(`[user-accounts] restore ${acct.chatId} failed: ${err.message}`);
      }
    }
    // Notify each user whose account couldn't be restored — almost always a rotated
    // KEY_ENCRYPTION_SECRET making their stored keys undecryptable. Without this the
    // account silently looks connected but never trades. Tell them to reconnect.
    for (const chatId of brokenIds) {
      try {
        await this.notifier?.sendToChat?.(chatId,
          `⚠️ *Auto-trade disconnected* — I couldn't restore your saved API keys (they may no longer be decryptable after a server key change). Your account is *not* trading. Please re-link your Bybit keys with /connect.`);
      } catch { /* best-effort */ }
    }
    if (brokenIds.length) {
      try { await this.notifier?.sendInfo?.(`⚠️ ${brokenIds.length} user auto-trade account(s) failed to restore (likely KEY_ENCRYPTION_SECRET rotation) — affected users were notified to reconnect.`); } catch { /* ignore */ }
    }
    const active = [...this.accounts.values()].filter(a => a.settings?.mode && a.settings.mode !== 'off').length;
    console.log(`[user-accounts] enabled — ${restored} account(s) restored (${active} trading)${failed ? `, ${failed} failed` : ''}`);
  }

  // ── Connect / disconnect ───────────────────────────────────────────────────

  // Validate keys against Bybit, then encrypt + persist + build the (disarmed)
  // trader. Returns { ok, balance } or { ok:false, reason }.
  async connect(chatId, apiKey, apiSecret) {
    if (!vaultAvailable()) return { ok: false, reason: 'key storage is not enabled on this bot (operator must set KEY_ENCRYPTION_SECRET)' };
    const id = String(chatId);
    const k = (apiKey ?? '').trim(), s = (apiSecret ?? '').trim();
    if (!k || !s) return { ok: false, reason: 'missing api key or secret' };

    // Validate BEFORE persisting — a key Bybit rejects is never stored.
    const probe = new BybitExchange({
      apiKey: k, apiSecret: s,
      baseUrl: this.relayBaseUrl, proxyAuthSecret: this.relayAuthSecret, verbose: false
    });
    let balance;
    try { balance = await probe.getBalance(); }
    catch (err) { return { ok: false, reason: `Bybit rejected the keys (${err.message}). Use a trade-enabled key, and check it's not IP-restricted away from this server.` }; }

    const existing = this.accounts.get(id);
    const acct = existing ?? {
      chatId: id,
      createdAt: Date.now(),
      settings: {
        mode: 'off',                                              // off | paper | live (self-armed)
        marginUsd: 0,                                              // 0 = risk-based sizing
        maxPositionUsd: this.riskDefaults.maxPositionUsd ?? 50,    // user-settable cap
        dailyLossLimitPct: this.riskDefaults.dailyLossLimitPct ?? 10, // user-settable daily breaker (0 = off)
        trailing: true,
        tpTarget: 'tp2',
        tpPercent: 0                                              // >0 = fixed ROI take-profit
      }
    };
    acct.encApiKey = encryptSecret(k);
    acct.encApiSecret = encryptSecret(s);
    this.accounts.set(id, acct);
    this.#save();
    await this.#buildTrader(acct);
    console.log(`[user-accounts] ${id} connected (balance $${Number(balance).toFixed(2)}) — disarmed until they /autotrade on`);
    return { ok: true, balance };
  }

  // Update ONE credential (key or secret) while keeping the other, then
  // re-validate + re-store. Lets a user fix a mistyped secret without
  // re-pasting both. Missing field is read from the stored (decrypted) value.
  async updateCredentials(chatId, { apiKey = null, apiSecret = null }) {
    const acct = this.accounts.get(String(chatId));
    if (!acct) return { ok: false, reason: 'not connected — use /connect first' };
    let k = apiKey, s = apiSecret;
    try {
      if (k == null) k = decryptSecret(acct.encApiKey);
      if (s == null) s = decryptSecret(acct.encApiSecret);
    } catch (err) {
      return { ok: false, reason: `couldn't read stored keys (${err.message}) — re-enter both` };
    }
    return this.connect(chatId, k, s);   // re-validates, re-encrypts, rebuilds trader
  }

  // Wipe a user's keys + stop their trader. Returns { ok }.
  disconnect(chatId) {
    const id = String(chatId);
    const acct = this.accounts.get(id);
    if (!acct) return { ok: false, reason: 'no connected account' };
    try { acct.trader?.stop(); } catch { /* ignore */ }
    this.accounts.delete(id);
    this.#save();
    console.log(`[user-accounts] ${id} disconnected — keys wiped`);
    return { ok: true };
  }

  // ── Per-user settings (called by /autotrade for a connected non-operator) ───

  // Set a user's trading mode: 'off' | 'paper' (simulated) | 'live' (real).
  setMode(chatId, mode) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected — use /connect first' };
    const m = String(mode).toLowerCase();
    if (m === 'off') { acct.trader.disarm(); acct.trader.setMode('off', { silent: true }); }
    else if (m === 'paper') { const r = acct.trader.setMode('paper'); if (!r.ok) return r; }
    else if (m === 'live') { const r = acct.trader.setMode('live'); if (!r.ok) return r; acct.trader.arm(); }
    else return { ok: false, reason: `unknown mode "${mode}" (off|paper|live)` };
    acct.settings.mode = m;
    delete acct.settings.armed;            // superseded by mode
    this.#save();
    return { ok: true, mode: m };
  }

  // Back-compat wrapper for /autotrade on|off.
  setArmed(chatId, on) { return this.setMode(chatId, on ? 'live' : 'off'); }

  // The user's trade journal (for the /pnl view).
  storeFor(chatId) { return this.get(chatId)?.trader?.store ?? null; }

  setMargin(chatId, usd) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const m = Math.max(0, Number(usd) || 0);
    acct.trader.liveMarginUsd = m;          // live-only traders read liveMarginUsd
    acct.settings.marginUsd = m;
    this.#save();
    return { ok: true, marginUsd: m };
  }

  // Per-user trade-horizon allowlist (array of SCALP/DAY/SWING/POSITION). Empty
  // array = nothing trades (we keep it but warn in the UI); null clears override.
  setHorizons(chatId, horizons) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const norm = Array.isArray(horizons) ? horizons.map(h => String(h).toUpperCase()) : null;
    acct.trader.setAllowedHorizons(norm);
    acct.settings.horizons = norm;
    this.#save();
    return { ok: true, horizons: norm };
  }

  // Per-user trigger allowlist override (on/off/null=default). Persisted in the
  // account settings so it survives a trader rebuild on restart.
  setTriggerAllowed(chatId, trig, on) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setTriggerAllowed(trig, on);
    acct.settings.allowTriggers = acct.trader.allowTriggers;   // mirror the trader's resolved map (may be null)
    this.#save();
    return r;
  }

  setMinAlignment(chatId, n) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setMinAlignment(n);
    acct.settings.minAlignment = r.minAlignment;
    this.#save();
    return r;
  }

  // Per-user daily-loss circuit breaker (% of the day's opening balance; 0 = off).
  setDailyLimit(chatId, pct) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setDailyLimit(pct);
    acct.settings.dailyLossLimitPct = r.dailyLossLimitPct;
    this.#save();
    return r;
  }

  setMaxPosition(chatId, usd) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const m = Math.max(1, Number(usd) || 0);
    if (!(m >= 1)) return { ok: false, reason: 'give a positive USD cap' };
    acct.trader.risk.maxPositionUsd = m;
    acct.settings.maxPositionUsd = m;
    this.#save();
    return { ok: true, maxPositionUsd: m };
  }

  setTpMode(chatId, mode) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setTpMode(mode);
    if (!r.ok) return r;
    acct.settings.trailing = r.trailing;
    acct.settings.tpTarget = r.tpTarget;
    acct.settings.tpPercent = 0;          // setTpMode clears any fixed-% TP
    this.#save();
    return r;
  }

  setTpPercent(chatId, pct) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setTpPercent(pct);
    acct.settings.tpPercent = r.tpPercent;
    acct.settings.trailing = acct.trader.trailing;
    this.#save();
    return r;
  }

  setProfitTrail(chatId, on) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setProfitTrail(on);
    acct.settings.trailGapPct = acct.trader.trailGapPct;
    this.#save();
    return r;
  }

  // Per-user breakeven toggle (OFF = trade rides to TP or full SL, no entry scratch).
  setBreakeven(chatId, on) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    const r = acct.trader.setBreakeven(on);
    acct.settings.beTriggerPct = acct.trader.beTriggerPct;
    this.#save();
    return r;
  }

  // Manually close one of a user's open auto-trades.
  async closeSymbol(chatId, symbol) {
    const acct = this.get(chatId);
    if (!acct?.trader) return { ok: false, reason: 'not connected' };
    return acct.trader.closeSymbol(symbol);
  }

  status(chatId) {
    const acct = this.get(chatId);
    if (!acct?.trader) return null;
    return acct.trader.status();
  }

  // ── Signal fan-out ──────────────────────────────────────────────────────────

  // Fan a signal out to every connected user's trader. Each AutoTrader gates
  // itself (armed/mode/risk/dup), so disarmed users are no-ops. Isolated:
  // fire-and-forget per user; one failure never blocks the others.
  onSignal(signal) {
    for (const acct of this.accounts.values()) {
      if (!acct.trader) continue;
      acct.trader.onSignal(signal).catch(err =>
        console.warn(`[user-accounts] ${acct.chatId} signal ${signal?.token?.symbol}: ${err.message}`));
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  // Build (or rebuild) a user's isolated AutoTrader from their stored keys +
  // settings. Live-only; mode follows their saved armed state.
  async #buildTrader(acct) {
    try { acct.trader?.stop(); } catch { /* ignore */ }
    const apiKey = decryptSecret(acct.encApiKey);
    const apiSecret = decryptSecret(acct.encApiSecret);
    const broker = new BybitExchange({
      apiKey, apiSecret,
      baseUrl: this.relayBaseUrl, proxyAuthSecret: this.relayAuthSecret, verbose: this.verbose
    });
    const risk = new RiskEngine({
      riskPct: this.riskDefaults.riskPct ?? 2,
      maxPositionUsd: acct.settings.maxPositionUsd ?? this.riskDefaults.maxPositionUsd ?? 50,
      maxConcurrent: this.riskDefaults.maxConcurrent ?? 5,
      dailyLossLimitPct: acct.settings.dailyLossLimitPct ?? this.riskDefaults.dailyLossLimitPct ?? 10,
      maxLeverage: this.riskDefaults.maxLeverage ?? 20,
      verbose: this.verbose
    });
    const store = new TradeStore({ path: join(this.logsDir, `autotrades-user-${acct.chatId}.jsonl`) });
    const paperBroker = new PaperBroker({
      startBalance: 1000,
      priceFn: this.priceBySymbol ?? (() => null),
      statePath: join(this.logsDir, `paper-user-${acct.chatId}.json`),
      verbose: this.verbose
    });
    await store.init();          // load this user's journal + paper state (Postgres or file)
    await paperBroker.init();
    // Migrate the old armed-bool to the mode string.
    const mode = acct.settings.mode ?? (acct.settings.armed ? 'live' : 'off');
    const trader = new AutoTrader({
      mode,
      liveBroker: broker,
      paperBroker,
      riskEngine: risk,
      store,
      notifier: this.notifier,
      notifyChatId: acct.chatId,                 // alerts → the user's own DM
      logTag: `u${acct.chatId}`,                 // tags this user's lines in the shared autotrade log
      liveMarginUsd: acct.settings.marginUsd ?? 0,
      trailing: acct.settings.trailing ?? true,
      trailGapPct: acct.settings.trailGapPct,   // per-user profit-trail (undefined → env default)
      beTriggerPct: acct.settings.beTriggerPct, // per-user breakeven arm (undefined → env default; 0 = BE off)
      tpTarget: acct.settings.tpTarget ?? 'tp2',
      tpPercent: acct.settings.tpPercent ?? 0,
      // Signal-quality gates. Defaults SHARED with the operator (so a user who
      // hasn't customised trades the same alignment/scalp/short rules), but each
      // user can override their HORIZON allowlist + min-alignment via the menu —
      // their saved settings win when present.
      minAlignment: acct.settings.minAlignment ?? this.gates.minAlignment ?? 0,
      minAlignmentWeight: this.gates.minAlignmentWeight ?? 0,
      skipScalp: this.gates.skipScalp ?? true,                 // legacy fallback when no horizon allowlist
      allowedHorizons: acct.settings.horizons ?? null,        // per-user horizon allowlist (null = use skipScalp)
      allowTriggers: acct.settings.allowTriggers ?? null,     // per-user trigger overrides (null = operator env/defaults)
      shortOnly: this.gates.shortOnly ?? false,
      configPath: null,                          // settings persist via this manager, not a per-trader file
      dayStateKey: `user-${acct.chatId}`,         // Neon kv key — persist this user's daily-loss counter across restarts
      dayStateFile: join(this.logsDir, `autotrade-daystate-user-${acct.chatId}.json`), // file fallback when there's no DB
      monitorIntervalMs: this.monitorIntervalMs,
      armed: mode === 'live',
      verbose: this.verbose
    });
    if (this.priceBySymbol) trader.setPriceBySymbol(this.priceBySymbol);
    await trader.initDayState();                  // restore today's daily-loss counter before trading
    trader.start();
    acct.trader = trader;
    return trader;
  }

  // Load persisted accounts from Postgres (when DATABASE_URL is set) or the
  // local file. Encrypted blobs are stored as-is; decryption happens per-trader.
  async #load() {
    let accounts = [];
    let migrateToDb = false;
    if (dbEnabled()) {
      try {
        const fromDb = await kvGet(DB_NS, DB_KEY);
        if (fromDb == null) {
          // First boot on Postgres — migrate the encrypted file across (if any).
          migrateToDb = true;
          if (existsSync(this.path)) {
            try { accounts = JSON.parse(readFileSync(this.path, 'utf8')).accounts ?? []; } catch { accounts = []; }
          }
        } else {
          accounts = fromDb;
        }
      } catch (err) { console.warn(`[user-accounts] DB load failed: ${err.message}`); }
    } else {
      if (!existsSync(this.path)) return;
      try { accounts = JSON.parse(readFileSync(this.path, 'utf8')).accounts ?? []; }
      catch (err) { console.warn(`[user-accounts] load failed: ${err.message}`); return; }
    }
    for (const a of accounts) {
      if (!a?.chatId || !a.encApiKey || !a.encApiSecret) continue;
      this.accounts.set(String(a.chatId), {
        chatId: String(a.chatId),
        encApiKey: a.encApiKey,
        encApiSecret: a.encApiSecret,
        createdAt: a.createdAt ?? Date.now(),
        settings: {
          // Spread FIRST so EVERY saved setting survives a restart — the old
          // whitelist silently dropped trailGapPct (bank-pops), horizons, and
          // minAlignment, resetting them on every redeploy. The validated fields
          // below then sanitise the critical ones.
          ...(a.settings || {}),
          mode: ['off', 'paper', 'live'].includes(a.settings?.mode) ? a.settings.mode : (a.settings?.armed ? 'live' : 'off'),
          marginUsd: Number(a.settings?.marginUsd ?? 0),
          maxPositionUsd: Number(a.settings?.maxPositionUsd ?? this.riskDefaults.maxPositionUsd ?? 50),
          dailyLossLimitPct: Number(a.settings?.dailyLossLimitPct ?? this.riskDefaults.dailyLossLimitPct ?? 10),
          trailing: a.settings?.trailing !== false,
          tpTarget: ['tp1', 'tp2', 'tp3'].includes(a.settings?.tpTarget) ? a.settings.tpTarget : 'tp2',
          tpPercent: Number(a.settings?.tpPercent ?? 0),
          horizons: Array.isArray(a.settings?.horizons) ? a.settings.horizons : null,
        }
      });
    }
    if (migrateToDb && this.accounts.size > 0) {
      this.#save();
      console.log(`[user-accounts] migrated ${this.accounts.size} account(s) from file → Postgres`);
    }
  }

  // Persist accounts (encrypted keys + settings only — NEVER the live trader,
  // broker, or any plaintext key). DB writes are fire-and-forget.
  #save() {
    const accounts = [...this.accounts.values()].map(a => ({
      chatId: a.chatId,
      encApiKey: a.encApiKey,
      encApiSecret: a.encApiSecret,
      createdAt: a.createdAt,
      settings: a.settings
    }));
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, accounts).catch(err => console.warn(`[user-accounts] DB save failed: ${err.message}`));
      return;
    }
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify({ savedAt: Date.now(), accounts }, null, 2));
    } catch (err) {
      console.warn(`[user-accounts] save failed: ${err.message}`);
    }
  }
}
