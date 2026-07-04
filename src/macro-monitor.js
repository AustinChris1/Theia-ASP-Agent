// Macro / Fed-news monitor.
//
// High-impact US macro events — FOMC rate decisions and CPI inflation prints —
// reliably whip crypto (the ETH FOMC dump that motivated this). They're
// scheduled a year ahead, so this is a CALENDAR monitor, not a poller of live
// data: it reads a static event list (config/macro-calendar.json, overridable
// via MACRO_CALENDAR_URL) and emits a 'macro' event as each lead-time window is
// crossed — a heads-up 1 day out, again 1 hour out, and "it's live now" at the
// release. The "now" FOMC alert can include the actual Fed-funds target range
// when FRED_API_KEY is set (free key from fred.stlouisfed.org).
//
// It does NOT touch autotrading (the user chose alerts-only). Existing trades +
// their TP/SL keep running; the alert just warns the human not to enter fresh
// into the volatility candle.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const MACRO_DB_NS = 'macro', MACRO_DB_KEY = 'fired';
const FETCH_TIMEOUT_MS = 12_000;
const HOUR = 60 * 60_000, DAY = 24 * HOUR;

// Lead windows: warn this far before each event (plus an at-release "now" fire).
// label is used for dedup + display ("in ~1 day" / "in ~1 hour" / "now").
export const DEFAULT_MACRO_LEADS = [
  { label: '1d', ms: DAY },
  { label: '1h', ms: HOUR },
  { label: 'now', ms: 0 },
];

// Pure: stable id for an event (type + ISO time never change for a given event).
export function macroEventId(ev) { return `${ev.type}:${ev.time}`; }

// Pure: given the event list, current time, lead windows, and the set of
// already-fired `${id}:${label}` keys, return the (event, lead) pairs that have
// just become due. Pre-event leads fire in [eventTs - lead, eventTs); the "now"
// lead (ms 0) fires in [eventTs, eventTs + grace). Anything already fired or
// fully past its window is skipped — so a restart mid-window catches up exactly
// once, and an event we slept through is silently dropped (never a stale alert).
export function dueMacroFires(events, nowMs, leads, fired, graceMs = 30 * 60_000) {
  const out = [];
  for (const ev of events) {
    const ts = Date.parse(ev.time);
    if (!Number.isFinite(ts)) continue;
    const id = macroEventId(ev);
    for (const lead of leads) {
      const key = `${id}:${lead.label}`;
      if (fired.has(key)) continue;
      if (lead.ms === 0) {
        if (nowMs >= ts && nowMs < ts + graceMs) out.push({ ev, lead, key, ts });
      } else if (nowMs >= ts - lead.ms && nowMs < ts) {
        out.push({ ev, lead, key, ts });
      }
    }
  }
  return out;
}

// Pure: human "in ~1 day" / "in ~3 hours" / "in ~25 minutes" from a lead window.
export function leadPhrase(lead) {
  if (lead.ms === 0) return 'now';
  if (lead.ms >= DAY) return `in ~${Math.round(lead.ms / DAY)} day${lead.ms >= 2 * DAY ? 's' : ''}`;
  if (lead.ms >= HOUR) return `in ~${Math.round(lead.ms / HOUR)} hour${lead.ms >= 2 * HOUR ? 's' : ''}`;
  return `in ~${Math.round(lead.ms / 60_000)} minutes`;
}

export class MacroMonitor extends EventEmitter {
  constructor({ calendarPath = null, calendarUrl = null, pollIntervalMs = 5 * 60_000,
                leads = DEFAULT_MACRO_LEADS, fredApiKey = null, verbose = false } = {}) {
    super();
    this.calendarPath = calendarPath;
    this.calendarUrl = calendarUrl || null;        // optional remote JSON (same shape) — lets the user update the calendar without a redeploy
    this.pollIntervalMs = pollIntervalMs;
    this.leads = leads;
    this.fredApiKey = fredApiKey || null;
    this.verbose = verbose;
    this.events = [];
    this.fired = new Set();                         // `${id}:${label}` already-alerted
    this.intervalId = null;
  }

  async #loadFired() {
    if (!dbEnabled()) return;
    try {
      const arr = await kvGet(MACRO_DB_NS, MACRO_DB_KEY);
      if (Array.isArray(arr)) for (const k of arr) this.fired.add(k);
    } catch (err) { console.warn(`[macro] fired-set load failed: ${err.message}`); }
  }

  #saveFired() {
    const arr = [...this.fired].slice(-500);
    if (dbEnabled()) {
      kvSet(MACRO_DB_NS, MACRO_DB_KEY, arr).catch(err => console.warn(`[macro] fired-set save failed: ${err.message}`));
    }
  }

  async #loadCalendar() {
    let parsed = null;
    if (this.calendarUrl) {
      try {
        const res = await fetch(this.calendarUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) parsed = await res.json();
        else console.warn(`[macro] calendar URL HTTP ${res.status} — falling back to file`);
      } catch (err) { console.warn(`[macro] calendar URL fetch failed (${err.message}) — falling back to file`); }
    }
    if (!parsed && this.calendarPath && existsSync(this.calendarPath)) {
      try { parsed = JSON.parse(readFileSync(this.calendarPath, 'utf8')); }
      catch (err) { console.warn(`[macro] calendar file parse failed: ${err.message}`); }
    }
    const events = Array.isArray(parsed?.events) ? parsed.events
                 : (Array.isArray(parsed) ? parsed : []);
    this.events = events.filter(e => e?.type && e?.time && Number.isFinite(Date.parse(e.time)));
    const future = this.events.filter(e => Date.parse(e.time) > Date.now()).length;
    console.log(`[macro] loaded ${this.events.length} events (${future} upcoming)`);
    // Loud warning if the calendar has run dry — the year rolled over and nobody
    // refreshed it. Better a log line than silently never alerting again.
    if (future === 0) console.warn('[macro] ⚠️ NO upcoming events — calendar is stale, update config/macro-calendar.json (or MACRO_CALENDAR_URL) for the new year.');
  }

  async start() {
    await this.#loadFired();
    await this.#loadCalendar();
    // Prime the fired-set: mark every lead window that is ALREADY past as fired,
    // so a fresh boot doesn't spam "1 day before" for an event happening in 10
    // minutes. We only want to fire windows we cross while running.
    const now = Date.now();
    for (const ev of this.events) {
      const ts = Date.parse(ev.time);
      const id = macroEventId(ev);
      for (const lead of this.leads) {
        // already-past windows (we're past the fire-start but, for pre-event
        // leads, we still allow the current window — handled by dueMacroFires).
        if (lead.ms === 0) { if (now >= ts + 30 * 60_000) this.fired.add(`${id}:${lead.label}`); }
        else if (now >= ts) this.fired.add(`${id}:${lead.label}`);
      }
    }
    await this.#poll();
    this.intervalId = setInterval(() => this.#poll().catch(err => console.warn(`[macro] poll error: ${err.message}`)), this.pollIntervalMs);
    this.intervalId.unref?.();
    console.log(`[macro] monitoring FOMC/CPI calendar every ${Math.round(this.pollIntervalMs / 60000)}min`);
  }

  // Upcoming events (future only), soonest first — for the `/macro` command.
  upcoming(limit = 8) {
    const now = Date.now();
    return this.events
      .map(e => ({ ...e, tsMs: Date.parse(e.time) }))
      .filter(e => Number.isFinite(e.tsMs) && e.tsMs > now)
      .sort((a, b) => a.tsMs - b.tsMs)
      .slice(0, limit);
  }

  async #poll() {
    const fires = dueMacroFires(this.events, Date.now(), this.leads, this.fired);
    if (!fires.length) return;
    for (const f of fires) {
      this.fired.add(f.key);
      let rate = null;
      if (f.ev.type === 'FOMC' && f.lead.ms === 0 && this.fredApiKey) {
        rate = await this.#fedRate().catch(() => null);
      }
      if (this.verbose) console.log(`[macro] fire ${f.ev.type} ${f.lead.label} — ${f.ev.title}`);
      this.emit('macro', {
        type: f.ev.type, title: f.ev.title, ref: f.ev.ref ?? null,
        time: f.ev.time, tsMs: f.ts, lead: f.lead, leadLabel: f.lead.label,
        isNow: f.lead.ms === 0, fedRate: rate,
      });
    }
    this.#saveFired();
  }

  // Current Fed-funds target range from FRED (DFEDTARU = upper, DFEDTARL = lower).
  // Optional — only called when FRED_API_KEY is set. Fail-soft → null.
  async #fedRate() {
    const get = async (series) => {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${this.fredApiKey}&file_type=json&sort_order=desc&limit=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const j = await res.json();
      const v = Number(j?.observations?.[0]?.value);
      return Number.isFinite(v) ? v : null;
    };
    const [upper, lower] = await Promise.all([get('DFEDTARU'), get('DFEDTARL')]);
    if (upper == null && lower == null) return null;
    return { upper, lower };
  }
}
