// Team-wallet discovery.
//
// Most token "manipulation" — coordinated sells, exit liquidity dumps — is
// telegraphed by movement from a small set of large early holders: team
// allocations, OTC desks, VC unlocks. Those wallets are NOT labelled by
// any exchange, so we can't query them by name. But the TOP HOLDERS of
// each token *as a set* almost always contain them.
//
// What we do:
//   1. For each token in the universe (Ethereum + BSC), scrape the
//      block-explorer's top-holders page (HTML, no API key needed).
//   2. Exclude obvious infrastructure: zero/burn addresses, the token
//      contract itself, known DEX pools, known bridges, anything we
//      already labelled as a CEX wallet.
//   3. Persist what remains as "candidate insider wallets" per token.
//
// Output: Map<lowercased-address, { tokenSymbol, tokenAddress, chain,
// rank, percent }> — fed to the EVM monitor so any transfer from one
// of these addresses gets flagged with `teamFlow: true`. The conductor
// reads that flag and applies a heavy bearish score boost when the
// destination is a CEX hot wallet (team distribution into the order book
// is one of the most reliable bearish signals in crypto).
//
// Cost: one HTTP fetch per token, one-time at startup, then refresh
// every TEAM_REFRESH_DAYS days. Cached on disk so restarts are free.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const TEAM_DB_NS = 'team-wallets', TEAM_DB_KEY = 'cache';
const FETCH_TIMEOUT_MS = 12_000;
const TEAM_REFRESH_DAYS = 7;
const TEAM_REFRESH_MS = TEAM_REFRESH_DAYS * 24 * 60 * 60_000;
const numEnvTW = (k, d) => { const v = Number(process.env[k]); return isFinite(v) ? v : d; };
const MAX_HOLDERS_KEPT = numEnvTW('TEAM_MAX_HOLDERS', 25);   // cap candidate insiders per token (largest first)
// Percent floor — now a real filter, not just top-N rank. The user's spec:
// "track ANY wallet holding > 0.5% of supply". Holders are sorted DESC, so we
// keep every holder ≥ TEAM_MIN_HOLDER_PCT up to the MAX_HOLDERS_KEPT cap. Set
// TEAM_MIN_HOLDER_PCT=0 to revert to pure top-N rank (old behaviour).
const MIN_PERCENT_KEEP = numEnvTW('TEAM_MIN_HOLDER_PCT', 0.5);
const MAX_PERCENT_KEEP = numEnvTW('TEAM_MAX_HOLDER_PCT', 50);   // > this % ≈ contract / burn / staking pool
const SCRAPE_CONCURRENCY = 3;       // be polite to etherscan/bscscan
const DELAY_BETWEEN_FETCHES_MS = 1500;

// ── Accumulation detection ──────────────────────────────────────────────────
// The bullish MIRROR of insider distribution: a (non-infra, non-CEX) wallet that
// quietly grows its share of a token's supply. Detected by comparing each
// discovery snapshot to the PRIOR one — if a wallet's % of supply jumps by
// ≥ ACCUM_MIN_DELTA_PCT between snapshots taken within ACCUM_WINDOW_DAYS, it's
// accumulating. Hot-movers re-snapshot on a short clock (HOT_REFRESH_MS) so a
// fast accumulation on a surging coin is caught in hours, not the weekly cycle.
const ACCUM_MIN_DELTA_PCT = numEnvTW('ACCUM_MIN_DELTA_PCT', 2.0);   // ≥ this supply-% gain = accumulation
const ACCUM_WINDOW_DAYS   = numEnvTW('ACCUM_WINDOW_DAYS', 14);      // ignore prior snapshots older than this
const ACCUM_MIN_WINDOW_HRS = numEnvTW('ACCUM_MIN_WINDOW_HRS', 2);   // ignore snapshots closer than this (noise)
const ACCUM_MAX_NEW_PCT = numEnvTW('ACCUM_MAX_NEW_PCT', 10);        // a holder appearing "from zero" at > this % is a newly-TRACKED whale, not accumulation
const HOT_REFRESH_MS = numEnvTW('TEAM_HOT_REFRESH_HOURS', 6) * 60 * 60_000;  // hot-mover re-snapshot cadence

// Pure + testable. prev/cur are arrays of { address, percent, name? }. Returns
// the wallets whose share grew by ≥ minDelta, largest gain first.
export function detectAccumulation(prev, cur, { minDelta = ACCUM_MIN_DELTA_PCT, maxNewPct = ACCUM_MAX_NEW_PCT } = {}) {
  const prevPct = new Map((prev ?? []).map(h => [h.address?.toLowerCase(), Number(h.percent) || 0]));
  const out = [];
  for (const h of cur ?? []) {
    const addr = h.address?.toLowerCase();
    if (!addr) continue;
    const before = prevPct.get(addr) ?? 0;
    const now = Number(h.percent) || 0;
    const delta = now - before;
    if (delta < minDelta) continue;
    // A holder appearing "from zero" already controlling a big share is almost
    // always a pre-existing whale ENTERING TRACKING (e.g. after a holder-set or
    // threshold change), not someone who bought it in the window — the 0%→34%
    // false alarms. Real gradual accumulation lands in a modest range.
    if (before === 0 && now > maxNewPct) continue;
    out.push({ address: h.address, name: h.name ?? null, prevPct: before, curPct: now, delta: Number(delta.toFixed(2)) });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '');
const EXPLORER_ADDR = { ethereum: 'https://etherscan.io/address/', bsc: 'https://bscscan.com/address/' };

// Telegram alert text for an accumulation event (Markdown).
function accumulationText(symbol, chain, a, ageDays) {
  const who = a.name ? `*${a.name}*` : `\`${shortAddr(a.address)}\``;
  const link = EXPLORER_ADDR[chain] ? `[${shortAddr(a.address)}](${EXPLORER_ADDR[chain]}${a.address})` : `\`${shortAddr(a.address)}\``;
  const win = ageDays >= 1 ? `${ageDays.toFixed(1)}d` : `${Math.round(ageDays * 24)}h`;
  return `🟢 *Accumulation* — *${symbol}*\n`
       + `A holder grew *${a.prevPct.toFixed(2)}% → ${a.curPct.toFixed(2)}%* of supply (*+${a.delta.toFixed(2)}%*) over ${win}.\n`
       + `${who} ${link} _(${chain})_\n`
       + `_A large wallet quietly building a position — the bullish mirror of insider distribution._`;
}

// Hard-coded infrastructure addresses that frequently appear in top-holders
// but are NOT insiders: burn, zero, well-known bridges, large staking
// contracts. Lowercased for direct .has() lookups.
const INFRASTRUCTURE = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
  // Lido staking
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
  // Wrapped ETH / BNB
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  // Common bridges
  '0x3ee18b2214aff97000d974cf647e7c347e8fa585',  // Wormhole
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',  // USDC (sometimes in holder lists due to airdrops)
]);

// DEX/AMM patterns — pool addresses often appear in top holders. We can't
// hard-code every pool, but we can spot them by checking the explorer label.
const DEX_LABEL_PATTERNS = [
  'uniswap', 'sushiswap', 'pancakeswap', 'curve', 'balancer', 'biswap',
  'apeswap', 'spookyswap', '1inch', 'pool', 'amm', 'lp:', 'lp token',
  'liquidity pool'
];

// Infrastructure label patterns — publicly-known NON-insider holders. The HTML
// scraper only ever sets a label on a true public name tag (almost always infra),
// so it skips ALL labelled rows. The Moralis API, by contrast, labels MANY
// addresses (owner_address_label/entity), so a blanket "labelled → skip" zeroes
// out the insider set. Instead we skip a labelled holder only when the label
// looks like infrastructure/exchange/bridge — NOT for a team/treasury/deployer/
// fund/unknown tag, which are exactly the insiders we want to track.
const INFRA_LABEL_PATTERNS = [
  ...DEX_LABEL_PATTERNS,
  'exchange', 'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'kucoin', 'gate',
  'huobi', 'bitget', 'mexc', 'bridge', 'wormhole', 'layerzero', 'stargate',
  'gateway', 'wrapped', 'staking', 'staked', 'reward', 'gnosis safe', 'multisig',
  'null', 'burn', 'dead', 'genesis', 'relayer', 'hot wallet', 'cold wallet', 'custody'
];

// Use the dedicated holders-table endpoint. The main /token/{addr} page no
// longer renders the top holders inline (loads via AJAX), but
// /token/generic-tokenholders2 returns full server-side HTML with the
// rank, address, label, balance, and percentage all in one table.
// Path under each explorer (host filled in per egress — direct or via relay).
const EXPLORER_PATH = (addr) => `/token/generic-tokenholders2?a=${addr}&p=1`;
const EXPLORER_HOST = { ethereum: 'https://etherscan.io', bsc: 'https://bscscan.com' };
const EXPLORER_RELAY_SEG = { ethereum: 'etherscan', bsc: 'bscscan' };

// Moralis token-owners API — primary holder source (works from datacenter IPs).
const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';
const MORALIS_CHAIN = { ethereum: 'eth', bsc: 'bsc' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class TeamWalletDiscovery extends EventEmitter {
  constructor({ universe, cexWallets, cachePath, relayBaseUrl = null, relayAuthSecret = null, moralisApiKey = null, verbose = false }) {
    super();
    this.universe = universe;
    this.cexWallets = cexWallets;           // raw loaded JSON from cex-wallets.json
    this.cachePath = cachePath;
    // PRIMARY holder source: Moralis token-owners API. It serves JSON to any IP
    // (datacenter included), so it works on Render where HTML scraping of
    // etherscan/bscscan is Cloudflare-blocked. It also returns is_contract and
    // address labels, so we can filter out pools/contracts precisely. When no
    // key is set we fall back to scraping (relay, then direct).
    this.moralisApiKey = moralisApiKey || null;
    // FALLBACK source: block explorers (etherscan/bscscan) Cloudflare-block
    // datacenter IPs, so scraping fails from cloud hosts (Render). Route through
    // the Singapore relay when configured to present a different egress IP. (May
    // still be blocked if the relay IP is also flagged — falls back to direct.)
    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.verbose = verbose;

    // Set of all CEX addresses across chains — used to filter top holders
    // (we never want a CEX wallet to count as an "insider").
    this.cexAddressSet = this.#buildCexSet(cexWallets);

    // address → { tokenSymbol, tokenAddress, chain, rank, percent, name }
    this.teamByAddress = new Map();
    // tokenAddress → { chain, addresses: [...], ts }
    this.byToken = new Map();
    // SYMBOL → { top10Pct, holderCount, ts } — top-10 NON-infrastructure holder
    // concentration (manipulation-risk metric; the "top 10 control 90%" signal).
    this.concentrationBySymbol = new Map();
    // Operator-added insiders (address → entry). Kept SEPARATE so re-discovery
    // never evicts them — merged into the address index. Reliable even when
    // explorer scraping is IP-blocked (Render).
    this.manualInsiders = new Map();

    if (cachePath && !dbEnabled()) {
      const dir = dirname(cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#loadCache();
      this.#loadManual();
    }
  }

  #manualFile() { return this.cachePath ? this.cachePath.replace(/team-wallets\.json$/, 'team-insiders-manual.json') : null; }

  #loadManual() {
    const f = this.#manualFile();
    if (!f || !existsSync(f)) return;
    try {
      for (const e of (JSON.parse(readFileSync(f, 'utf8')).insiders ?? [])) {
        if (e?.address) this.manualInsiders.set(e.address.toLowerCase(), e);
      }
    } catch { /* ignore */ }
  }

  #saveManual() {
    const insiders = [...this.manualInsiders.values()];
    if (dbEnabled()) { kvSet(TEAM_DB_NS, 'manual', insiders).catch(err => console.warn(`[team-wallets] manual DB save failed: ${err.message}`)); return; }
    const f = this.#manualFile();
    if (!f) return;
    try { writeFileSync(f, JSON.stringify({ savedAt: Date.now(), insiders }, null, 2)); } catch { /* ignore */ }
  }

  // Operator-add an insider wallet to track (token-matched). Returns { ok }.
  addManualInsider({ tokenSymbol, tokenAddress, chain, address }) {
    if (!tokenAddress || !address || !chain) return { ok: false, reason: 'need token address, chain, and wallet address' };
    const addr = address.toLowerCase();
    this.manualInsiders.set(addr, {
      tokenSymbol: (tokenSymbol ?? '').toUpperCase(),
      tokenAddress: tokenAddress.toLowerCase(),
      chain, address: addr, rank: 'manual', percent: null, name: 'operator-added'
    });
    this.#saveManual();
    return { ok: true };
  }

  removeManualInsider(address) {
    const removed = this.manualInsiders.delete((address ?? '').toLowerCase());
    if (removed) this.#saveManual();
    return removed;
  }

  listManualInsiders() { return [...this.manualInsiders.values()]; }

  // Async cache load for the Postgres path (+ migrate a file on first DB boot).
  // No-op in file mode (constructor already loaded). Awaited in index.js.
  async init() {
    if (!dbEnabled()) return this;
    try {
      let data = await kvGet(TEAM_DB_NS, TEAM_DB_KEY);
      if (data == null && this.cachePath && existsSync(this.cachePath)) {
        data = JSON.parse(readFileSync(this.cachePath, 'utf8'));   // migrate file → DB
      }
      if (data) { this.#applyCache(data); this.#save(); }
      // Load operator-added insiders (always merged into the address index).
      const manual = await kvGet(TEAM_DB_NS, 'manual');
      for (const e of (manual ?? [])) if (e?.address) this.manualInsiders.set(e.address.toLowerCase(), e);
      if (this.manualInsiders.size) console.log(`[team-wallets] ${this.manualInsiders.size} operator-added insider(s) loaded`);
    } catch (err) {
      console.warn(`[team-wallets] DB cache load failed: ${err.message}`);
    }
    return this;
  }

  #buildCexSet(cexWallets) {
    const out = new Set();
    if (!cexWallets) return out;
    for (const chain of Object.keys(cexWallets)) {
      if (chain === '_meta') continue;
      const sides = cexWallets[chain];
      for (const exch of Object.keys(sides ?? {})) {
        const slot = sides[exch];
        for (const type of ['hot', 'cold', 'main']) {
          for (const addr of slot?.[type] ?? []) {
            out.add(addr.toLowerCase());
          }
        }
      }
    }
    return out;
  }

  #loadCache() {
    if (!existsSync(this.cachePath)) return;
    try {
      this.#applyCache(JSON.parse(readFileSync(this.cachePath, 'utf8')));
    } catch (err) {
      console.warn(`[team-wallets] cache load failed: ${err.message}`);
    }
  }

  // Apply a loaded cache object ({ byToken }) into memory, pruning entries for
  // tokens no longer pinned. Shared by file + Postgres load paths.
  #applyCache(data) {
      // Build a set of token-addresses that are currently pinned so we can
      // prune stale cache entries. Previous deploys may have cached top-100-
      // by-MC tokens; we now restrict to pinned-only, but those old cached
      // tokens (e.g. MNT) would otherwise keep firing teamFlow alerts forever.
      const pinnedTokenAddrs = new Set();
      for (const cgId of this.universe.allCgIds()) {
        if (!this.universe.isPinned?.(cgId)) continue;
        const t = this.universe.lookupByCgId(cgId);
        if (!t) continue;
        for (const chain of ['ethereum', 'bsc']) {
          const a = t.chains?.[chain]?.address;
          if (a) pinnedTokenAddrs.add(a.toLowerCase());
        }
      }

      let kept = 0, evicted = 0;
      for (const [tokenAddr, info] of Object.entries(data.byToken ?? {})) {
        // Evict if the token is no longer in the pinned set (e.g. user removed
        // it from /watchlist, or the discovery scope changed from top-100 to
        // pinned-only). Don't keep ghosts.
        if (!pinnedTokenAddrs.has(tokenAddr.toLowerCase())) { evicted++; continue; }
        this.byToken.set(tokenAddr, info);
        for (const holder of info.addresses ?? []) {
          this.teamByAddress.set(holder.address, {
            tokenSymbol: info.tokenSymbol,
            tokenAddress: tokenAddr,
            chain: info.chain,
            rank: holder.rank,
            percent: holder.percent,
            name: holder.name ?? null
          });
        }
        kept++;
      }
      console.log(`[team-wallets] loaded ${kept} pinned tokens (${this.teamByAddress.size} candidate insider addresses; evicted ${evicted} stale non-pinned tokens)`);
      // Persist the pruned view so we don't re-evict on every restart.
      if (evicted > 0) this.#save();
  }

  #save() {
    const obj = { savedAt: Date.now(), byToken: Object.fromEntries(this.byToken) };
    if (dbEnabled()) {
      kvSet(TEAM_DB_NS, TEAM_DB_KEY, obj).catch(err => console.warn(`[team-wallets] DB cache save failed: ${err.message}`));
      return;
    }
    if (!this.cachePath) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn(`[team-wallets] cache save failed: ${err.message}`);
    }
  }

  // Public accessor — returns the map of team address → info, used by the
  // EVM monitor to extend its wallet index.
  getAddressIndex() {
    if (this.manualInsiders.size === 0) return this.teamByAddress;
    // Merge discovered + operator-added (manual wins). A fresh map so the
    // monitor's refreshTeamIndex() picks up manual additions immediately.
    const merged = new Map(this.teamByAddress);
    for (const [addr, e] of this.manualInsiders) merged.set(addr, e);
    return merged;
  }

  // Public: lookup a specific address. Returns { tokenSymbol, ... } or null.
  lookupAddress(address) {
    return this.teamByAddress.get(address.toLowerCase()) ?? null;
  }

  // Top-10 NON-infrastructure holder concentration (%) for a symbol, or null if
  // not discovered/stale. The manipulation-risk metric (few hands = pump/dump-
  // prone). 30-day TTL — holder distributions move slowly.
  getConcentration(symbol) {
    const e = this.concentrationBySymbol.get((symbol ?? '').toUpperCase());
    if (!e) return null;
    if (Date.now() - (e.ts ?? 0) > 30 * 24 * 60 * 60_000) return null;
    return { top10Pct: e.top10Pct, holderCount: e.holderCount };
  }

  // Public read for the `/holders` command: the tracked insider/team holders for
  // a symbol (across chains, largest first) + the top-10 concentration metric.
  // Reads the discovery cache — no network. null if the token hasn't been
  // discovered (i.e. it isn't pinned / a hot-mover, or has no insider-class holders).
  holdersForSymbol(symbol) {
    const want = String(symbol || '').toUpperCase();
    if (!want) return null;
    const tokens = [];
    for (const info of this.byToken.values()) {
      if (String(info.tokenSymbol || '').toUpperCase() !== want) continue;
      tokens.push({
        chain: info.chain, tokenAddress: info.tokenAddress, ts: info.ts,
        holders: (info.addresses || []).slice().sort((a, b) => (b.percent || 0) - (a.percent || 0)),
      });
    }
    const concentration = this.getConcentration(want);
    if (!tokens.length && !concentration) return null;
    return { symbol: want, concentration, tokens };
  }

  // Discover team wallets across FAVORED tokens = pinned watchlist + current
  // hot-movers (24h gainers/losers). Broader than the manual watchlist (so a
  // surging coin's insiders get tracked automatically) but still bounded.
  //
  // Rationale: when the discovery was open to the top-100 by MC, the bot
  // started firing "team flow" alerts on USDT, ETH, and other high-volume
  // tokens that have no meaningful "team" (their top holders are just
  // mega-CEX cold wallets, market makers, ETF custodians — none of which
  // are insiders signalling distribution intent). Plus, cross-token false
  // positives: a person who's a top holder of TOKEN_A might receive a
  // transfer of TOKEN_B and trigger a bogus "TOKEN_A team flow" alert.
  //
  // Restricting to the user's pinned watchlist (small-cap / low-FDV tokens
  // they actually want to trade) eliminates both problems and keeps the
  // signal genuinely high-conviction.
  async discoverAll({ maxTokens = 100 } = {}) {
    const candidates = [];
    for (const cgId of this.universe.allCgIds()) {
      if (candidates.length >= maxTokens) break;
      // FAVORED = pinned watchlist OR a current hot-mover (24h gainers/losers,
      // refreshed by the movers scan via universe.setHotMovers). This is the
      // "watchlist + auto-add hot tokens" scope: broader than the manual
      // watchlist but still bounded, so it won't re-introduce the USDT/ETH
      // mega-CEX noise that an all-tokens scan caused (those don't go hot, and
      // their top holders are infra-filtered anyway).
      if (!this.universe.isFavored?.(cgId)) continue;
      const t = this.universe.lookupByCgId(cgId);
      if (!t) continue;
      // We only do EVM chains — Solscan blocks scraping and the SPL token
      // model differs structurally enough to warrant separate work later.
      for (const chain of ['ethereum', 'bsc']) {
        const info = t.chains?.[chain];
        if (!info?.address) continue;
        candidates.push({ chain, tokenAddress: info.address.toLowerCase(), symbol: t.symbol, cgId });
        break;     // one chain per token is enough — pick the first available
      }
    }
    console.log(`[team-wallets] discovering across ${candidates.length} favored tokens (watchlist + hot movers, cap=${maxTokens})...`);

    // Process in small concurrent batches to be polite to the explorers.
    let processed = 0;
    let added = 0;
    for (let i = 0; i < candidates.length; i += SCRAPE_CONCURRENCY) {
      const batch = candidates.slice(i, i + SCRAPE_CONCURRENCY);
      const results = await Promise.all(batch.map(c => this.#discoverOne(c).catch(err => {
        if (this.verbose) console.warn(`[team-wallets] ${c.symbol} ${c.chain} err: ${err.message}`);
        return null;
      })));
      for (const r of results) {
        processed++;
        if (r?.newHolders > 0) added += r.newHolders;
      }
      if (i + SCRAPE_CONCURRENCY < candidates.length) await sleep(DELAY_BETWEEN_FETCHES_MS);
    }
    this.#save();
    console.log(`[team-wallets] discovery complete — ${processed} tokens scraped, ${added} new candidate insider wallets, ${this.teamByAddress.size} total tracked`);
  }

  // Fetch a token's top holders from the Moralis owners API. Returns the same
  // shape as the HTML scraper ({ rank, address, percent, name, isContract }) or
  // null on any failure so the caller can fall back to scraping.
  async #fetchHoldersApi(chain, tokenAddress, symbol) {
    const mChain = MORALIS_CHAIN[chain];
    if (!mChain) return null;
    const url = `${MORALIS_BASE}/erc20/${tokenAddress}/owners?chain=${mChain}&order=DESC&limit=${MAX_HOLDERS_KEPT + 25}`;
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-API-Key': this.moralisApiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        if (this.verbose) console.warn(`[team-wallets] ${symbol} ${chain} Moralis HTTP ${res.status} — falling back to scrape`);
        return null;
      }
      const json = await res.json();
      const rows = Array.isArray(json?.result) ? json.result : [];
      if (rows.length === 0) return null;
      const holders = [];
      let rank = 0;
      for (const r of rows) {
        const address = String(r.owner_address ?? '').toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
        const percent = Number(r.percentage_relative_to_total_supply);
        rank++;
        holders.push({
          rank,
          address,
          percent: isFinite(percent) ? percent : 0,
          name: r.owner_address_label || r.entity || null,
          isContract: r.is_contract === true
        });
        if (holders.length >= MAX_HOLDERS_KEPT + 25) break;
      }
      if (this.verbose) console.log(`[team-wallets] ${symbol} ${chain}: Moralis returned ${holders.length} holders`);
      return holders;
    } catch (err) {
      if (this.verbose) console.warn(`[team-wallets] ${symbol} ${chain} Moralis err: ${err.message} — falling back to scrape`);
      return null;
    }
  }

  // Fetch a token's top-holders HTML. Prefers the Singapore relay (different
  // egress IP than a cloud host) when configured, falling back to direct. Returns
  // the HTML, or null if blocked/empty (a Cloudflare challenge counts as null so
  // we can fail over).
  async #fetchHolderHtml(chain, addr, symbol) {
    const path = EXPLORER_PATH(addr);
    if (this.relayBaseUrl) {
      const html = await this.#fetchExplorer(`${this.relayBaseUrl}/${EXPLORER_RELAY_SEG[chain]}${path}`, this.relayAuthSecret);
      if (html) return html;
      if (this.verbose) console.warn(`[team-wallets] ${symbol} ${chain} relay blocked/empty — trying direct`);
    }
    const html = await this.#fetchExplorer(`${EXPLORER_HOST[chain]}${path}`, null);
    if (!html && this.verbose) console.warn(`[team-wallets] ${symbol} ${chain} holder fetch blocked/empty`);
    return html;
  }

  async #fetchExplorer(url, authSecret) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      };
      if (authSecret) headers['X-Proxy-Auth'] = authSecret;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const html = await res.text();
      // Cloudflare challenge / block page → treat as a miss so we can fail over.
      if (/just a moment|attention required|cf-browser-verification|cf-chl|enable javascript and cookies/i.test(html)) return null;
      return html;
    } catch { return null; }
  }

  async #discoverOne({ chain, tokenAddress, symbol, cgId }) {
    // Skip if cached & fresh. Hot-movers re-snapshot on a SHORTER clock so a fast
    // accumulation/distribution on a surging coin is caught in hours, not weekly.
    const cached = this.byToken.get(tokenAddress);
    const refreshMs = this.universe?.isHotMover?.(cgId) ? HOT_REFRESH_MS : TEAM_REFRESH_MS;
    if (cached && Date.now() - (cached.ts ?? 0) < refreshMs) {
      return { newHolders: 0 };
    }

    // Holder source: prefer the Moralis API (datacenter-friendly), fall back to
    // scraping. Either path returns the same { rank, address, percent, name,
    // isContract? } shape.
    let holders = null;
    if (this.moralisApiKey && MORALIS_CHAIN[chain]) {
      holders = await this.#fetchHoldersApi(chain, tokenAddress, symbol);
    }
    if (!holders) {
      if (!EXPLORER_HOST[chain]) return { newHolders: 0 };
      const html = await this.#fetchHolderHtml(chain, tokenAddress, symbol);
      if (!html) return { newHolders: 0 };
      holders = this.#extractHolders(html, tokenAddress);
    }
    if (!holders || holders.length === 0) return { newHolders: 0 };

    // ── Holder concentration (manipulation-risk metric — the trader's "top 10
    // control 90%" tell). Sum the % held by the top-10 NON-infrastructure
    // holders: exclude the token contract, burns, DEX pools, and CEX wallets
    // (those aren't single controllers who can coordinate a pump/dump). A high
    // number = the float is in very few hands → prone to the BEAT/VELVET/H
    // pump-then-distribute pattern. Computed from the RAW top holders, before
    // the insider filter narrows the set.
    const realHolders = holders
      .filter(h => {
        const lower = h.address.toLowerCase();
        if (lower === tokenAddress.toLowerCase()) return false;
        if (h.isContract) return false;
        if (INFRASTRUCTURE.has(lower)) return false;
        if (this.cexAddressSet.has(lower)) return false;
        return isFinite(h.percent) && h.percent > 0 && h.percent <= 100;
      })
      .sort((a, b) => b.percent - a.percent);
    const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + h.percent, 0);
    this.concentrationBySymbol.set((symbol ?? '').toUpperCase(), {
      top10Pct: Number(top10Pct.toFixed(2)), holderCount: realHolders.length, ts: Date.now()
    });

    // Filter: keep only candidate insiders (not CEX, not contract-self,
    // not burn / infrastructure, not a labelled DEX pool).
    const insiders = [];
    for (const h of holders) {
      const lower = h.address.toLowerCase();
      if (lower === tokenAddress.toLowerCase()) continue;
      if (h.isContract) continue;                        // pools/staking/contracts are not insider EOAs (API only)
      if (INFRASTRUCTURE.has(lower)) continue;
      if (this.cexAddressSet.has(lower)) continue;
      if (h.name) {
        const lowName = h.name.toLowerCase();
        const fromApi = ('isContract' in h);   // Moralis path sets isContract; scraper does not
        if (fromApi) {
          // API labels are broad — skip only clear infrastructure/exchange/DEX,
          // KEEP team/treasury/deployer/fund/unknown tags (those are insiders).
          if (INFRA_LABEL_PATTERNS.some(p => lowName.includes(p))) continue;
        } else {
          // Scraper only labels true public name tags → almost always infra. Skip
          // DEX pools explicitly; treat any other public tag as known infra too.
          if (DEX_LABEL_PATTERNS.some(p => lowName.includes(p))) continue;
          continue;
        }
      }
      if (h.percent < MIN_PERCENT_KEEP) continue;
      if (h.percent > MAX_PERCENT_KEEP) continue;      // > 30% is almost always a contract
      insiders.push(h);
      if (insiders.length >= MAX_HOLDERS_KEPT) break;
    }

    // ── Accumulation detection (bullish mirror of insider distribution) ──────
    // Compare this snapshot to the PRIOR one: a wallet whose share of supply
    // jumped ≥ ACCUM_MIN_DELTA_PCT (and isn't infra/CEX — `insiders` is already
    // filtered) is quietly accumulating. Only compare against a snapshot that's
    // recent enough to be meaningful (not the first-ever, not ancient, not noise).
    if (cached?.addresses?.length) {
      const ageMs = Date.now() - (cached.ts ?? 0);
      const ageDays = ageMs / 86_400_000;
      if (ageMs >= ACCUM_MIN_WINDOW_HRS * 3_600_000 && ageDays <= ACCUM_WINDOW_DAYS) {
        const accs = detectAccumulation(cached.addresses, insiders);
        for (const a of accs.slice(0, 2)) {   // top 2 accumulators per token — avoid spam
          const text = accumulationText(symbol, chain, a, ageDays);
          console.log(`[team-wallets] ACCUMULATION ${symbol} ${shortAddr(a.address)} ${a.prevPct}%→${a.curPct}% (+${a.delta}) over ${ageDays.toFixed(1)}d`);
          this.emit('accumulation', { symbol, chain, tokenAddress, windowDays: Number(ageDays.toFixed(1)), ...a, text });
        }
      }
    }

    // Replace any prior entry for this token wholesale (top-holders set
    // drifts between scrapes; old entries that aren't holders any more
    // should stop being watched).
    if (cached?.addresses) {
      for (const old of cached.addresses) {
        this.teamByAddress.delete(old.address);
      }
    }
    const stored = {
      chain,
      tokenSymbol: symbol,
      tokenAddress,
      addresses: insiders,
      ts: Date.now()
    };
    this.byToken.set(tokenAddress, stored);
    for (const h of insiders) {
      this.teamByAddress.set(h.address, {
        tokenSymbol: symbol,
        tokenAddress,
        chain,
        rank: h.rank,
        percent: h.percent,
        name: h.name ?? null
      });
    }
    if (this.verbose && insiders.length > 0) {
      console.log(`[team-wallets] ${symbol} ${chain}: ${insiders.length} insider candidates`);
    }
    return { newHolders: insiders.length };
  }

  // Parse the holders table from /token/generic-tokenholders2 HTML.
  //
  // Each row is structured like:
  //   <tr>
  //     <td>{rank}</td>
  //     <td>...
  //         <span ... title='Label Name&#10;(0xHEX)'>...</span>  [optional]
  //         <a href='/token/{token}?a={holder}'>...</a>
  //         <a ... data-clipboard-text='0xHEX' ...></a>
  //     </td>
  //     <td>{tag like 'Exchange' / 'Contract' / blank}</td>
  //     <td>{balance}</td>
  //     <td>{percent}% <progress>...</progress></td>
  //   </tr>
  //
  // The address comes most reliably from `data-clipboard-text='0x...'`
  // (always present); the label from the leading tooltip title or the
  // link text; the percent from a "<td>X.YZ%" pattern.
  #extractHolders(html, tokenAddress) {
    const results = [];
    const seen = new Set();
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const addrFromClipboard = /data-clipboard-text=['"](0x[a-fA-F0-9]{40})['"]/i;
    const addrFromHref = /href=['"]\/token\/0x[a-fA-F0-9]{40}\?a=(0x[a-fA-F0-9]{40})/i;
    // Percent: a TD whose text is "X.YZ%" (possibly preceded by whitespace).
    // The pattern is locked to a TD boundary to avoid matching a balance
    // figure that happens to contain a percent-shaped substring elsewhere.
    const percentPattern = /<td[^>]*>\s*(\d{1,3}(?:\.\d{1,8})?)\s*%/i;
    // Label sits in the *first* tooltip on the row when present. We strip
    // any HTML and stop at the embedded "(0x..." that the explorers append.
    const labelPattern = /title=['"]([^'"]{1,120}?)(?:&#10;\(0x|\(0x|['"])/i;

    let rowMatch;
    let rank = 0;
    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const row = rowMatch[1];
      const addrM = row.match(addrFromClipboard) ?? row.match(addrFromHref);
      if (!addrM) continue;
      const pctM = row.match(percentPattern);
      if (!pctM) continue;
      const addr = addrM[1].toLowerCase();
      if (seen.has(addr)) continue;
      // Token address itself appears as one row on its own page — skip
      if (addr === tokenAddress.toLowerCase()) continue;
      const pct = Number(pctM[1]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      seen.add(addr);
      rank++;
      const labelM = row.match(labelPattern);
      let name = labelM?.[1]?.trim() ?? null;
      // Reject false-positive "labels" — when there's no real public name
      // tag, the page often shows the raw address in the tooltip, which my
      // regex picks up as a "label". Also reject the generic Copy tooltip.
      if (name && /^0x[a-fA-F0-9]{8,}/.test(name)) name = null;
      if (name && /^copy address$/i.test(name)) name = null;
      results.push({ rank, address: addr, percent: pct, name });
      if (results.length >= 50) break;
    }
    return results;
  }
}
