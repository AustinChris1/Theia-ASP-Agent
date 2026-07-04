// Exchange-listing monitor.
//
// New listings — especially on Korean exchanges (Upbit, Bithumb) — reliably
// pump a token within minutes of the announcement. This monitor polls each
// exchange's public announcement feed, detects NEW listing posts, extracts
// the token symbol(s), and emits a 'listing' event so the bot can fire an
// immediate LONG-biased alert.
//
// Sources (all public, no API key):
//   • Upbit    — api-manager.upbit.com/api/v1/announcements (category=trade)
//   • Binance  — binance.com/bapi/.../cms/article/list/query (catalogId=48)
//   • Bithumb  — feed.bithumb.com / notice endpoint
//
// Dedup: seen announcement IDs persisted to logs/seen-listings.json so a
// restart doesn't re-alert old listings. On first-ever boot we mark all
// current announcements as seen WITHOUT alerting (no backlog spam).

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const LISTING_DB_NS = 'listings', LISTING_DB_KEY = 'seen';

const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Keywords that mark a post as a NEW LISTING (vs. a delisting, maintenance,
// event, etc.). Matched case-insensitively against the post title.
const LISTING_KEYWORDS = [
  'will list', 'will add', 'lists ', 'listing of', 'new listing',
  'digital asset', 'market support', 'market addition', 'added to',
  // Korean: new-trade / trading-support / market-addition / KRW-market / digital
  // asset / listing — broadened after the OPG(Upbit) miss, where the Korean title
  // didn't contain any of the original phrases.
  '신규 거래', '거래 지원', '거래지원', '마켓 추가', '마켓추가', '원화 마켓', 'krw 마켓',
  '디지털 자산', '디지털자산', '상장', '신규 상장', '거래 개시',
  'will open trading', 'opens trading', 'perpetual', 'futures will'
];
// Negative keywords — skip posts that are about removals / warnings.
// NOTE: the positive keyword '거래지원' (trading support) ALSO appears in a DELISTING
// title "거래지원 종료 안내" (trading-support TERMINATION) — and the old negative
// '거래 종료' never matched it because '지원' sits between '거래' and '종료'. So
// delistings (DENT/NOM/LRC) fired as NEW LISTINGS. '종료' (termination/end) is the
// reliable delisting marker — a real new-listing title never contains it.
const NEGATIVE_KEYWORDS = [
  'delist', 'will remove', 'removal', 'terminat', 'suspend', 'maintenance',
  '상장 폐지', '거래 종료', '거래지원 종료', '종료', '유의 종목', 'warning', 'deposit and withdrawal'
];
// Feed categories that DEFINITIVELY mark a new listing (Bithumb tags posts with
// a category; "마켓 추가" = market addition). When a feed provides categories we
// trust them over title keywords — an airdrop "이벤트" (event) post that also
// mentions the new ticker won't match a listing category, so it's excluded.
const LISTING_CATEGORIES = ['마켓 추가', '마켓추가', 'market addition', 'new listing', '신규'];

// A genuine new-listing announcement surfaces within minutes. Anything older than this
// that the de-dup somehow missed (a stale proxy page, a lost seen-set, an edited
// re-publish) is a RE-SURFACED old post and must never alert — the backstop against
// the "14 old Upbit listings fired at once" spam. LISTING_MAX_AGE_HRS to tune.
const LISTING_MAX_AGE_MS = Number(process.env.LISTING_MAX_AGE_HRS ?? 12) * 3600_000;

// Parse an announcement timestamp (ISO string, epoch seconds, or epoch ms) → ms, or
// null if absent/unparseable (null = no age info → fall back to de-dup, never veto).
export function parseAnnouncementTs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const QUOTE_NOISE = new Set(['KRW', 'USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'USD', 'BUSD', 'FDUSD', 'EUR', 'TRY']);

// Pure: pull candidate tickers from an announcement title. Parenthesised
// uppercase tokens ONLY — the canonical "(MOVE)" format every exchange uses,
// reliable across English and Korean ("무브먼트(MOVE)"). Quote symbols (KRW,
// USDT…) are filtered out. We deliberately avoid loose word-matching.
export function extractTickers(title) {
  const found = new Set();
  for (const p of (title ?? '').match(/\(([A-Z0-9]{2,10})\)/g) ?? []) found.add(p.replace(/[()]/g, ''));
  return [...found].filter(s => !QUOTE_NOISE.has(s));
}

// Pure: is this announcement a NEW LISTING? When the feed tags categories
// (Bithumb) trust them — only a market-addition category counts, which excludes
// airdrop/event posts that also name the ticker. Otherwise (Upbit/Binance) use
// title keywords. Negative keywords (delist/suspend/…) always veto.
export function classifyListing(post) {
  if (post?.categories?.length) {
    const cats = post.categories.map(c => String(c).toLowerCase());
    if (cats.some(c => NEGATIVE_KEYWORDS.some(k => c.includes(k)))) return false;
    return cats.some(c => LISTING_CATEGORIES.some(k => c.includes(k.toLowerCase())));
  }
  const t = (post?.title ?? '').toLowerCase();
  if (NEGATIVE_KEYWORDS.some(k => t.includes(k))) return false;
  return LISTING_KEYWORDS.some(k => t.includes(k));
}

// RISK-DESIGNATION classifier (not a listing — a caution). Exchanges flag risky
// tokens: Binance "Monitoring"/"Seed" tags, Upbit/Bithumb "유의 종목" (investment
// caution / designated-warning). These are a heads-up to be careful (or fade), not a
// pump catalyst. Pure + exported. Returns { tag } or null.
const RISK_TAG_MARKERS = [
  { tag: 'Monitoring', re: /monitoring tag|monitoring 태그|모니터링/i },
  { tag: 'Seed',       re: /seed tag|seed 태그|시드 태그/i },
  { tag: 'Caution',    re: /유의\s?종목|투자유의|investment caution|caution warning/i },
];
export function classifyRiskTag(post) {
  const t = post?.title ?? '';
  if (post?.categories?.length) {
    const cats = post.categories.map(c => String(c).toLowerCase());
    for (const m of RISK_TAG_MARKERS) if (cats.some(c => m.re.test(c))) return { tag: m.tag };
  }
  for (const m of RISK_TAG_MARKERS) if (m.re.test(t)) return { tag: m.tag };
  return null;
}

export class ListingMonitor extends EventEmitter {
  constructor({ pollIntervalMs = 2 * 60_000, cachePath, universe = null, relayBaseUrl = null, relayAuthSecret = null, upbitProxyUrl = null, verbose = false }) {
    super();
    this.pollIntervalMs = pollIntervalMs;
    this.cachePath = cachePath;
    this.universe = universe;       // optional — to confirm the symbol is tradeable
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;   // Singapore egress for Upbit (Cloudflare-403s US IPs)
    this.relayAuthSecret = relayAuthSecret || null;
    // PROVEN 2026-06-15: Upbit's Cloudflare 403s US AND Singapore datacenter IPs,
    // but a Fly TOKYO IP clears it. This is the forwarder's /upbit/<path> route
    // (server-side-fetches api-manager.upbit.com). Preferred over relay/direct.
    this.upbitProxyUrl = upbitProxyUrl ? upbitProxyUrl.replace(/\/$/, '') : null;
    this.verbose = verbose;
    this.seen = new Set();          // `${exchange}:${id}` of already-processed posts
    this.intervalId = null;
    this.primed = false;            // becomes true after the first poll (backlog suppressed)

    if (cachePath && !dbEnabled()) {
      const dir = dirname(cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadFile();
    }
  }

  #loadFile() {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      for (const k of data.seen ?? []) this.seen.add(k);
      this.primed = this.seen.size > 0;     // if we have history, don't re-prime
      console.log(`[listings] loaded ${this.seen.size} seen announcements`);
    } catch (err) {
      console.warn(`[listings] cache load failed: ${err.message}`);
    }
  }

  // Postgres seen-set load (+ migrate a file on first DB boot). Awaited in start().
  async #loadDb() {
    try {
      const arr = await kvGet(LISTING_DB_NS, LISTING_DB_KEY);
      if (arr == null) {
        this.#loadFile();
        if (this.seen.size > 0) this.#save();
      } else {
        for (const k of arr) this.seen.add(k);
        this.primed = this.seen.size > 0;
        console.log(`[listings] loaded ${this.seen.size} seen announcements from Postgres`);
      }
    } catch (err) {
      console.warn(`[listings] DB cache load failed: ${err.message}`);
    }
  }

  #save() {
    const arr = [...this.seen].slice(-2000);   // bound growth to recent ~2000 ids
    if (dbEnabled()) {
      kvSet(LISTING_DB_NS, LISTING_DB_KEY, arr).catch(err => console.warn(`[listings] DB cache save failed: ${err.message}`));
      return;
    }
    if (!this.cachePath) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify({ savedAt: Date.now(), seen: arr }, null, 2));
    } catch (err) {
      console.warn(`[listings] cache save failed: ${err.message}`);
    }
  }

  async start() {
    if (dbEnabled()) await this.#loadDb();   // load seen-set before the first poll
    await this.#poll();             // first poll primes the seen-set (no alerts if fresh)
    this.primed = true;
    this.intervalId = setInterval(() => {
      this.#poll().catch(err => console.warn(`[listings] poll error: ${err.message}`));
    }, this.pollIntervalMs);
    this.intervalId.unref?.();
    console.log(`[listings] monitoring Upbit + Binance + Bithumb every ${this.pollIntervalMs / 60000}min`);
  }

  async #poll() {
    const posts = [];
    const [upbit, binance, bithumb] = await Promise.all([
      this.#fetchUpbit().catch(e => { console.warn(`[listings] Upbit fetch failed: ${e.message}`); return []; }),
      this.#fetchBinance().catch(e => { console.warn(`[listings] Binance fetch failed: ${e.message}`); return []; }),
      this.#fetchBithumb().catch(e => { console.warn(`[listings] Bithumb fetch failed: ${e.message}`); return []; })
    ]);
    posts.push(...upbit, ...binance, ...bithumb);
    // VISIBILITY: a feed silently returning 0 was the OPG miss (geo-block or an API
    // shape change, hidden by the old swallow-everything catch). Log the per-feed
    // counts whenever ANY feed is empty (or verbose), so a broken feed is obvious
    // in the logs instead of failing silently.
    if (this.verbose || upbit.length === 0 || binance.length === 0 || bithumb.length === 0) {
      console.log(`[listings] poll: Upbit=${upbit.length} Binance=${binance.length} Bithumb=${bithumb.length}`);
    }

    let newCount = 0;
    for (const post of posts) {
      const key = `${post.exchange}:${post.id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      newCount++;
      // On the very first poll (no prior history) we suppress alerts — we
      // just record the current backlog as "seen" so we only alert on posts
      // that appear AFTER the bot started.
      if (!this.primed) continue;
      // FRESHNESS veto — a real listing surfaces within minutes. If the post carries a
      // timestamp older than LISTING_MAX_AGE_MS, it's a re-surfaced OLD announcement
      // (stale proxy page / lost seen-set / edited re-publish) → record as seen, never
      // alert. The backstop that prevents the "14 old Upbit listings at once" spam,
      // independent of why de-dup missed it. No timestamp → fall through to de-dup.
      if (post.ts && (Date.now() - post.ts) > LISTING_MAX_AGE_MS) {
        if (this.verbose) console.log(`[listings] skip STALE ${post.exchange} "${post.title}" — ${Math.round((Date.now() - post.ts) / 3600_000)}h old`);
        continue;
      }
      // Risk DESIGNATION (Binance Monitoring/Seed, Korean 유의 종목) — emit a caution,
      // not a listing. A flagged token is a "be careful / fade" heads-up, not a pump.
      const risk = classifyRiskTag(post);
      if (risk) {
        for (const sym of this.#extractSymbols(post.title)) {
          if (this.verbose) console.log(`[listings] ${post.exchange} ⚠️ ${risk.tag} tag: ${sym} — "${post.title}"`);
          this.emit('riskTag', { exchange: post.exchange, symbol: sym, tag: risk.tag, title: post.title, url: post.url });
        }
        continue;
      }
      if (!this.#isListingPost(post)) continue;
      const symbols = this.#extractSymbols(post.title);
      if (symbols.length === 0) continue;
      for (const sym of symbols) {
        if (this.verbose) console.log(`[listings] ${post.exchange} listing: ${sym} — "${post.title}"`);
        this.emit('listing', { exchange: post.exchange, symbol: sym, title: post.title, url: post.url });
      }
    }
    if (newCount > 0) this.#save();
  }

  // Decide if a post is a NEW LISTING. When the feed tags categories (Bithumb)
  // we trust the category — only a market-addition category counts, which
  // excludes airdrop/event posts that also name the new ticker. Otherwise
  // (Upbit/Binance) fall back to title-keyword matching.
  #isListingPost(post) { return classifyListing(post); }

  // Pull candidate token symbols out of an announcement title, then (if a
  // universe is available) keep only symbols we actually track — a SOFT
  // preference: a brand-new listing is often a token we don't track yet (the
  // highest-value pump), so if none match we still return the raw tickers.
  #extractSymbols(title) {
    const all = extractTickers(title);
    if (all.length === 0) return [];
    if (this.universe?.allCgIds) {
      const known = all.filter(s => this.#symbolInUniverse(s));
      if (known.length > 0) return known;
    }
    return all;
  }

  #symbolInUniverse(symbol) {
    if (!this._symSet) {
      this._symSet = new Set();
      for (const cgId of this.universe.allCgIds()) {
        const t = this.universe.lookupByCgId(cgId);
        if (t?.symbol) this._symSet.add(t.symbol.toUpperCase());
      }
    }
    return this._symSet.has(symbol.toUpperCase());
  }

  // ── Provider fetchers ────────────────────────────────────────────────

  async #fetchUpbit() {
    const path = '/api/v1/announcements?os=web&page=1&per_page=20&category=trade';
    // Fuller browser headers — Upbit's Cloudflare 403s the bare UA from a
    // datacenter IP (the OPG miss). And because it's IP-based, prefer the
    // Singapore RELAY (a Korean-friendlier egress) when configured, falling back
    // to direct. Needs the relay's /upbit route (vercel-relay/api/proxy.js).
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
      'Referer': 'https://upbit.com/service_center/notice',
      'Origin': 'https://upbit.com'
    };
    const attempts = [];
    if (this.upbitProxyUrl) attempts.push({ url: `${this.upbitProxyUrl}${path}`, label: ' (proxy)' });
    if (this.relayBaseUrl) attempts.push({ url: `${this.relayBaseUrl}/upbit${path}`, relay: true, label: ' (relay)' });
    attempts.push({ url: `https://api-manager.upbit.com${path}`, relay: false, label: ' (direct)' });

    let j = null; const tries = [];
    for (const a of attempts) {
      const h = { ...headers };
      if (a.relay && this.relayAuthSecret) h['X-Proxy-Auth'] = this.relayAuthSecret;
      // Retry NETWORK failures (Render↔Fly blips surface as "fetch failed") before
      // falling through to the next egress. Bumped 2→4 with backoff: the Tokyo
      // forwarder itself returns 200, so the failures are the flaky free-tier
      // Render↔Fly hop — 2 tries kept losing whole Upbit polls while it was up.
      let res = null, lastErr = null;
      for (let i = 1; i <= 4 && !res; i++) {
        try { res = await fetch(a.url, { headers: h, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
        catch (e) { lastErr = e; if (i < 4) await new Promise(r => setTimeout(r, 500 * i)); }
      }
      if (!res) { tries.push(`${a.label.trim()}=${lastErr?.message ?? 'fetch failed'}`); continue; }
      if (!res.ok) { tries.push(`${a.label.trim()}=HTTP ${res.status}`); continue; }
      try { j = await res.json(); break; } catch { tries.push(`${a.label.trim()}=bad-json`); }
    }
    // Log EVERY attempt (not just the last) + whether the proxy is even configured —
    // "(direct)" alone hid whether the Fly proxy was tried or just absent.
    if (!j) { console.warn(`[listings] Upbit fetch failed — ${tries.join(', ')} (proxy ${this.upbitProxyUrl ? 'configured' : 'UNSET'})`); return []; }
    // Defensive against Upbit reshaping the payload — try the known keys, a
    // bare data array, and a top-level notices array before giving up.
    const list = j?.data?.notices ?? j?.data?.list ?? (Array.isArray(j?.data) ? j.data : null) ?? j?.notices ?? [];
    return list.map(n => ({
      exchange: 'Upbit',
      id: String(n.id ?? n.title),
      title: n.title ?? '',
      url: `https://upbit.com/service_center/notice?id=${n.id ?? ''}`,
      // Upbit notices carry a publish time under one of these keys — capture it so a
      // re-surfaced old announcement is vetoed by age (see the freshness check in #poll).
      ts: parseAnnouncementTs(n.listed_at ?? n.first_listed_at ?? n.created_at ?? n.published_at ?? n.updated_at)
    }));
  }

  async #fetchBinance() {
    // catalogId 48 = "New Cryptocurrency Listing"
    const url = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=20';
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return [];
    const j = await res.json();
    // Response shape varies — articles may be under data.articles or
    // data.catalogs[].articles. Handle both.
    let articles = j?.data?.articles ?? [];
    if (articles.length === 0 && Array.isArray(j?.data?.catalogs)) {
      for (const c of j.data.catalogs) articles.push(...(c.articles ?? []));
    }
    return articles.map(a => ({
      exchange: 'Binance',
      id: String(a.id ?? a.code ?? a.title),
      title: a.title ?? '',
      url: `https://www.binance.com/en/support/announcement/${a.code ?? ''}`,
      ts: parseAnnouncementTs(a.releaseDate ?? a.publishDate ?? a.createTime)
    }));
  }

  async #fetchBithumb() {
    // Bithumb's modern public notices API. `api.bithumb.com/v1/notices`
    // 302-redirects here; the old `feed.bithumb.com/notice` RSS now returns 403
    // (Cloudflare) so it silently stopped detecting listings (the SLX miss).
    // Returns JSON: [{ categories:[..], title, pc_url, published_at }]. The
    // "마켓 추가" (market addition) category marks a listing directly — far more
    // reliable than title keywords (an airdrop "이벤트" post for the same ticker
    // would otherwise false-fire).
    const url = 'https://feed-api.bithumb.com/v1/notices?count=20';
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list.map(n => ({
      exchange: 'Bithumb',
      id: String(n.pc_url ?? n.title),
      title: n.title ?? '',
      categories: Array.isArray(n.categories) ? n.categories : [],
      url: n.pc_url ?? 'https://feed.bithumb.com/notice'
    }));
  }
}
