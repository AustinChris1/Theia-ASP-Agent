// Persistent multi-user subscriber store.
//
// Saved as JSON to logs/subscribers.json. Each entry:
//   { chatId, username?, addedAt }
//
// chatId is stored as a string (Telegram chat IDs fit in a number but JS
// number precision could bite us with -100xxxxxxxxxxx supergroup IDs).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const DB_NS = 'subscribers', DB_KEY = 'all';

// Per-user notification categories the user can toggle. High-signal EVENT alerts
// (CEX-flow, insider/team sells, liquidation cascades) are ON by default; the
// noisier periodic DIGESTS (funding/movers/listing) are OFF (opt-in). SIGNALS and
// TP/SL outcome updates are NOT in here — they are non-negotiable and always
// delivered (see wantsCategory). Keys are the broadcast `category` tags.
const NOTIFY_DEFAULTS = {
  flow: true,          // 💸 on-chain CEX wallet flow ("Observation … watching")
  insider: true,       // 🕵️ tracked insider sells + CEX distribution (a flagship tell)
  accumulation: true,  // 🟢 large wallets quietly accumulating supply (bullish mirror)
  liquidation: true,   // 💥 liquidation-cascade alerts (a flagship tell)
  funding: false,      // 💰 periodic funding-rate leaders digest
  movers: false,       // 🔥 periodic top-movers digest
  listing: true,       // 🚀 new exchange-listing alerts (a flagship catalyst — Korean listings pump fast)
  unlock: true,        // 🔓 major token-unlock (vesting cliff) heads-up — incoming supply / sell pressure
  macro: true,         // 🏦 FOMC / CPI macro-event heads-up — volatility windows
  news: false,         // 📰 high-impact crypto headlines (hacks, regulation, ETF) — opt-in push, /news always on-demand
};
export const NOTIFY_CATEGORIES = Object.keys(NOTIFY_DEFAULTS);
export const NOTIFY_LABELS = {
  flow: '💸 CEX-flow alerts',
  insider: '🕵️ Insider / seller alerts',
  accumulation: '🟢 Accumulation alerts',
  liquidation: '💥 Liquidation cascades',
  funding: '💰 Funding-rate leaders',
  movers: '🔥 Top-movers digest',
  listing: '🚀 New-listing alerts',
  unlock: '🔓 Token-unlock alerts',
  macro: '🏦 Macro / Fed (FOMC, CPI)',
  news: '📰 High-impact news',
};

export class SubscriberStore {
  constructor({ path }) {
    this.path = path;
    this.entries = new Map();   // chatId(string) → { chatId, username, addedAt }
    if (!dbEnabled()) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadFile();         // file mode loads synchronously (unchanged)
    }
  }

  // Async init for the Postgres path (DB reads can't run in the constructor).
  // No-op in file mode — the constructor already loaded. index.js awaits this.
  async init() {
    if (!dbEnabled()) return this;
    try {
      const arr = await kvGet(DB_NS, DB_KEY);
      if (arr == null) {
        // First boot on Postgres — migrate any existing local file across.
        this.#loadFile();
        if (this.entries.size > 0) { this.#save(); console.log(`[subscribers] migrated ${this.entries.size} from file → Postgres`); }
      } else {
        for (const e of arr) if (e?.chatId) this.entries.set(String(e.chatId), e);
        console.log(`[subscribers] loaded ${this.entries.size} from Postgres`);
      }
    } catch (err) {
      console.warn(`[subscribers] DB load failed: ${err.message}`);
    }
    return this;
  }

  #loadFile() {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const e of data.entries ?? []) {
        if (e?.chatId) this.entries.set(String(e.chatId), e);
      }
      console.log(`[subscribers] loaded ${this.entries.size} from ${this.path}`);
    } catch (err) {
      console.warn(`[subscribers] load failed: ${err.message}`);
    }
  }

  // Persist the full snapshot. DB writes are fire-and-forget (the in-memory Map
  // is the live source of truth; last write wins, matching the file behaviour).
  #save() {
    const entries = [...this.entries.values()];
    if (dbEnabled()) {
      kvSet(DB_NS, DB_KEY, entries).catch(err => console.warn(`[subscribers] DB save failed: ${err.message}`));
      return;
    }
    try {
      writeFileSync(this.path, JSON.stringify({ savedAt: Date.now(), entries }, null, 2));
    } catch (err) {
      console.warn(`[subscribers] save failed: ${err.message}`);
    }
  }

  add({ chatId, username }) {
    const id = String(chatId);
    const existed = this.entries.has(id);
    const prev = this.entries.get(id);
    this.entries.set(id, {
      chatId: id,
      username: username ?? prev?.username ?? null,
      addedAt: prev?.addedAt ?? Date.now(),
      silencedUntil: prev?.silencedUntil ?? null,
      notifyPrefs: prev?.notifyPrefs ?? {}    // category → bool; empty = use defaults
    });
    this.#save();
    return !existed;     // true if newly added
  }

  // Silence broadcasts to this chat until `untilMs` (epoch ms). Pass null to clear.
  setSilence(chatId, untilMs) {
    const id = String(chatId);
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.silencedUntil = untilMs;
    this.#save();
    return true;
  }

  isSilenced(chatId) {
    const e = this.entries.get(String(chatId));
    if (!e?.silencedUntil) return false;
    if (Date.now() >= e.silencedUntil) {
      // Auto-clear expired silence
      e.silencedUntil = null;
      this.#save();
      return false;
    }
    return true;
  }

  silencedUntil(chatId) {
    const e = this.entries.get(String(chatId));
    return e?.silencedUntil ?? null;
  }

  remove(chatId) {
    const id = String(chatId);
    const removed = this.entries.delete(id);
    if (removed) this.#save();
    return removed;
  }

  // ── Per-user notification preferences ──────────────────────────────────────

  // Should `chatId` receive a broadcast of this `category`? Signals + outcome
  // (TP/SL) are non-negotiable → always true. Unknown category / no category →
  // always true (don't suppress untagged broadcasts). An unknown recipient
  // (legacy single-user fallback, not in the store) → always true. Otherwise the
  // user's saved pref, falling back to the category default.
  wantsCategory(chatId, category) {
    if (!category || category === 'signal' || category === 'outcome') return true;
    const e = this.entries.get(String(chatId));
    if (!e) return true;
    const p = e.notifyPrefs?.[category];
    return p === undefined ? (NOTIFY_DEFAULTS[category] ?? true) : !!p;
  }

  // Toggle/set a category for a user. Returns false if they aren't subscribed.
  setNotifyPref(chatId, category, on) {
    if (!NOTIFY_CATEGORIES.includes(category)) return false;
    const e = this.entries.get(String(chatId));
    if (!e) return false;
    if (!e.notifyPrefs) e.notifyPrefs = {};
    e.notifyPrefs[category] = !!on;
    this.#save();
    return true;
  }

  // Resolved prefs (every category → bool, defaults filled in) for the menu UI.
  notifyPrefsFor(chatId) {
    const prefs = this.entries.get(String(chatId))?.notifyPrefs ?? {};
    const out = {};
    for (const c of NOTIFY_CATEGORIES) out[c] = prefs[c] === undefined ? NOTIFY_DEFAULTS[c] : !!prefs[c];
    return out;
  }

  has(chatId) { return this.entries.has(String(chatId)); }
  size() { return this.entries.size; }
  all() { return [...this.entries.values()]; }
  allChatIds() { return [...this.entries.keys()]; }
}
