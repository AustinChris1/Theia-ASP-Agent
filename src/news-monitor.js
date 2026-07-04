// Crypto news monitor (free RSS feeds — no key, no rate cap).
//
// Two jobs from one source:
//   1. /news  — on-demand: the latest headlines, fetched live when the user taps
//               the menu button. No API key, no monthly quota.
//   2. push   — OPT-IN background alerts: poll the feeds and emit a 'news' event
//               only for HIGH-IMPACT items (hacks, SEC/regulation, ETF, major
//               listings, macro). Off by default so it doesn't spam.
//
// Sources are publisher RSS feeds (CoinDesk, Cointelegraph, Decrypt by default,
// override with NEWS_FEEDS). RSS is plain XML over HTTP, parsed here with a small
// regex reader so there's no XML dependency. It does NOT touch autotrading
// (alerts-only, like the macro/unlock monitors).
//
// History: this used the CryptoCompare/CoinDesk JSON API, but that moved to a
// 100-call/month free tier (unusable for a bot that restarts often). RSS is the
// sustainable free path and keeps /news, the menu button and the push filter
// working unchanged.

import { EventEmitter } from 'node:events';
import { dbEnabled, kvGet, kvSet } from './db.js';

const NEWS_DB_NS = 'news', NEWS_DB_KEY = 'seen';
const FETCH_TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (compatible; TheiaBot/1.0; +https://t.me/TheiaTradeBot)';

// Default RSS feeds. Each: { url, source }. Override via NEWS_FEEDS (comma-separated URLs).
export const DEFAULT_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss',                   source: 'Cointelegraph' },
  { url: 'https://decrypt.co/feed',                         source: 'Decrypt' },
];

// High-impact keyword buckets — title/category matches that historically move
// price. A hit on ANY tags the item as push-worthy; the tag also labels the alert.
const IMPACT_KEYWORDS = [
  ['hack',        /\b(hack(ed|ing)?|exploit(ed)?|breach|drained?|stolen|attack|rug ?pull)\b/i],
  ['regulation',  /\b(SEC|CFTC|DOJ|lawsuit|sued?|ban(ned)?|regulat\w*|court|charged?|fraud|investigat\w*|subpoena|sanction)\b/i],
  ['etf',         /\b(ETF|spot ETF)\b/i],
  ['listing',     /\b(listing|will list|gets? listed|delist\w*)\b/i],
  ['liquidation', /\b(liquidat\w*|cascade)\b/i],
  ['macro',       /\b(Fed|FOMC|CPI|inflation|rate (cut|hike|decision)|interest rate)\b/i],
  ['unlock',      /\b(token unlock|cliff unlock|vesting)\b/i],
];

// ── pure XML helpers ────────────────────────────────────────────────────────
function stripCdata(s) { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }

function safeCp(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');                 // amp LAST so &amp;lt; → &lt; not <
}

// CDATA → entities → strip leftover tags → collapse whitespace.
function cleanText(s) {
  if (!s) return '';
  let t = stripCdata(s);
  t = decodeEntities(t);
  t = t.replace(/<[^>]+>/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

// Pure: parse an RSS/Atom XML string into our compact item shape. Tolerant of
// CDATA, entity-encoding, atom <link href>, and namespaced date tags. Exported
// for unit testing without a network call.
export function parseRssItems(xml, source = '') {
  if (!xml || typeof xml !== 'string') return [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const block of blocks) {
    const title = cleanText(pickTag(block, 'title'));
    let url = cleanText(pickTag(block, 'link'));
    if (!url) {                                       // atom-style <link href="..."/>
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) url = m[1];
    }
    const guid = cleanText(pickTag(block, 'guid'));
    const pubRaw = pickTag(block, 'pubDate') || pickTag(block, 'dc:date')
                || pickTag(block, 'published') || pickTag(block, 'updated');
    const publishedMs = pubRaw ? (Date.parse(stripCdata(pubRaw).trim()) || 0) : 0;
    const cats = [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
      .map(m => cleanText(m[1])).filter(Boolean);
    if (!title || !url) continue;
    out.push({ id: guid || url || title, title, url, source, categories: cats.join('|'), publishedMs });
  }
  return out;
}

// Pure: a stable id for a news item.
export function newsItemId(it) { return String(it?.id ?? it?.guid ?? it?.url ?? ''); }

// Pure: classify a news item's market impact → { high, tags }. Tags drive both
// the push gate (high = at least one tag) and the alert label.
export function classifyNewsImpact(it) {
  const hay = `${it?.title ?? ''} ${it?.categories ?? ''}`;
  const tags = [];
  for (const [tag, re] of IMPACT_KEYWORDS) if (re.test(hay)) tags.push(tag);
  return { high: tags.length > 0, tags };
}

// Normalise a feed entry (string URL or {url,source}) to {url,source}.
function feedFrom(f) {
  if (f && typeof f === 'object' && f.url) return { url: f.url, source: f.source || hostLabel(f.url) };
  const url = String(f || '').trim();
  return url ? { url, source: hostLabel(url) } : null;
}
function hostLabel(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').split('.')[0];
    return h ? h.charAt(0).toUpperCase() + h.slice(1) : u;
  } catch { return u; }
}

export class NewsMonitor extends EventEmitter {
  constructor({ feeds = null, pollIntervalMs = 5 * 60_000, pushHighImpact = false, verbose = false } = {}) {
    super();
    this.feeds = (Array.isArray(feeds) && feeds.length)
      ? feeds.map(feedFrom).filter(Boolean)
      : DEFAULT_FEEDS;
    this.pollIntervalMs = pollIntervalMs;
    this.pushHighImpact = pushHighImpact;   // emit 'news' for high-impact items (opt-in)
    this.verbose = verbose;
    this.seen = new Set();                  // already-pushed news ids
    this.lastItems = [];                    // cache of the most recent merge (warms /news)
    this.intervalId = null;
  }

  async #fetchFeed(feed) {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${feed.source} HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssItems(xml, feed.source);
  }

  // Fetch every feed in parallel, merge, dedup by id, newest first. One feed
  // being down never fails the others (allSettled).
  async #fetchAll() {
    const results = await Promise.allSettled(this.feeds.map(f => this.#fetchFeed(f)));
    const seen = new Set();
    const merged = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') { if (this.verbose) console.warn(`[news] feed failed: ${r.reason?.message}`); continue; }
      for (const it of r.value) {
        const k = newsItemId(it);
        if (!k || seen.has(k)) continue;
        seen.add(k); merged.push(it);
      }
    }
    merged.sort((a, b) => (b.publishedMs || 0) - (a.publishedMs || 0));
    return merged;
  }

  // On-demand latest headlines for the /news command. Newest first, up to `limit`.
  // Fail-soft → the cached items so a transient feed blip doesn't error the UI.
  async latest(limit = 8) {
    try {
      const items = await this.#fetchAll();
      if (items.length) this.lastItems = items;
      return (items.length ? items : this.lastItems).slice(0, limit);
    } catch (err) {
      console.warn(`[news] latest() failed: ${err.message}`);
      return this.lastItems.slice(0, limit);
    }
  }

  async #loadSeen() {
    if (!dbEnabled()) return;
    try {
      const arr = await kvGet(NEWS_DB_NS, NEWS_DB_KEY);
      if (Array.isArray(arr)) for (const id of arr) this.seen.add(String(id));
    } catch (err) { console.warn(`[news] seen-set load failed: ${err.message}`); }
  }

  #saveSeen() {
    const arr = [...this.seen].slice(-800);
    if (dbEnabled()) kvSet(NEWS_DB_NS, NEWS_DB_KEY, arr).catch(err => console.warn(`[news] seen-set save failed: ${err.message}`));
  }

  async start() {
    await this.#loadSeen();
    // Prime: fetch once and mark everything currently in the feeds as seen, so a
    // boot doesn't blast a backlog of old headlines as "new". Also warms /news.
    try {
      const items = await this.#fetchAll();
      this.lastItems = items;
      for (const it of items) this.seen.add(newsItemId(it));
      this.#saveSeen();
      console.log(`[news] primed ${items.length} headlines from ${this.feeds.length} feed(s) (push ${this.pushHighImpact ? 'ON' : 'off'})`);
    } catch (err) {
      console.warn(`[news] prime failed: ${err.message}`);
    }
    if (!this.pushHighImpact) {
      console.log('[news] push alerts off — /news on-demand only');
      return;
    }
    await this.#poll();
    this.intervalId = setInterval(() => this.#poll().catch(err => console.warn(`[news] poll error: ${err.message}`)), this.pollIntervalMs);
    this.intervalId.unref?.();
    console.log(`[news] monitoring ${this.feeds.length} RSS feeds for high-impact headlines every ${Math.round(this.pollIntervalMs / 60000)}min`);
  }

  async #poll() {
    const items = await this.#fetchAll();
    if (items.length) this.lastItems = items;
    const fresh = items.filter(it => !this.seen.has(newsItemId(it)));
    if (!fresh.length) return;
    for (const it of fresh) this.seen.add(newsItemId(it));
    let emitted = 0;
    for (const it of fresh) {
      const impact = classifyNewsImpact(it);
      if (!impact.high) continue;
      if (this.verbose) console.log(`[news] fire [${impact.tags.join(',')}] ${it.title}`);
      this.emit('news', { ...it, tags: impact.tags });
      emitted++;
    }
    this.#saveSeen();
    if (this.verbose && emitted) console.log(`[news] ${emitted}/${fresh.length} fresh headlines were high-impact`);
  }

  stop() { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } }
}
