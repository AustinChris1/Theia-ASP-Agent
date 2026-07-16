

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbEnabled, kvGet, kvSet } from './db.js';

const TEAM_DB_NS = 'team-wallets', TEAM_DB_KEY = 'cache';
const FETCH_TIMEOUT_MS = 12_000;
const TEAM_REFRESH_DAYS = 7;
const TEAM_REFRESH_MS = TEAM_REFRESH_DAYS * 24 * 60 * 60_000;
const numEnvTW = (k, d) => { const v = Number(process.env[k]); return isFinite(v) ? v : d; };
const MAX_HOLDERS_KEPT = numEnvTW('TEAM_MAX_HOLDERS', 25);

const MIN_PERCENT_KEEP = numEnvTW('TEAM_MIN_HOLDER_PCT', 0.5);
const MAX_PERCENT_KEEP = numEnvTW('TEAM_MAX_HOLDER_PCT', 50);
const SCRAPE_CONCURRENCY = 3;
const DELAY_BETWEEN_FETCHES_MS = 1500;

const ACCUM_MIN_DELTA_PCT = numEnvTW('ACCUM_MIN_DELTA_PCT', 2.0);
const ACCUM_WINDOW_DAYS   = numEnvTW('ACCUM_WINDOW_DAYS', 14);
const ACCUM_MIN_WINDOW_HRS = numEnvTW('ACCUM_MIN_WINDOW_HRS', 2);
const ACCUM_MAX_NEW_PCT = numEnvTW('ACCUM_MAX_NEW_PCT', 10);
const HOT_REFRESH_MS = numEnvTW('TEAM_HOT_REFRESH_HOURS', 6) * 60 * 60_000;

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

    if (before === 0 && now > maxNewPct) continue;
    out.push({ address: h.address, name: h.name ?? null, prevPct: before, curPct: now, delta: Number(delta.toFixed(2)) });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? '');
const EXPLORER_ADDR = { ethereum: 'https://etherscan.io/address/', bsc: 'https://bscscan.com/address/' };

function accumulationText(symbol, chain, a, ageDays) {
  const who = a.name ? `*${a.name}*` : `\`${shortAddr(a.address)}\``;
  const link = EXPLORER_ADDR[chain] ? `[${shortAddr(a.address)}](${EXPLORER_ADDR[chain]}${a.address})` : `\`${shortAddr(a.address)}\``;
  const win = ageDays >= 1 ? `${ageDays.toFixed(1)}d` : `${Math.round(ageDays * 24)}h`;
  return `🟢 *Accumulation* — *${symbol}*\n`
       + `A holder grew *${a.prevPct.toFixed(2)}% → ${a.curPct.toFixed(2)}%* of supply (*+${a.delta.toFixed(2)}%*) over ${win}.\n`
       + `${who} ${link} _(${chain})_\n`
       + `_A large wallet quietly building a position — the bullish mirror of insider distribution._`;
}

const INFRASTRUCTURE = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',

  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',

  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',

  '0x3ee18b2214aff97000d974cf647e7c347e8fa585',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
]);

const DEX_LABEL_PATTERNS = [
  'uniswap', 'sushiswap', 'pancakeswap', 'curve', 'balancer', 'biswap',
  'apeswap', 'spookyswap', '1inch', 'pool', 'amm', 'lp:', 'lp token',
  'liquidity pool'
];

const INFRA_LABEL_PATTERNS = [
  ...DEX_LABEL_PATTERNS,
  'exchange', 'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'kucoin', 'gate',
  'huobi', 'bitget', 'mexc', 'bridge', 'wormhole', 'layerzero', 'stargate',
  'gateway', 'wrapped', 'staking', 'staked', 'reward', 'gnosis safe', 'multisig',
  'null', 'burn', 'dead', 'genesis', 'relayer', 'hot wallet', 'cold wallet', 'custody'
];

const EXPLORER_PATH = (addr) => `/token/generic-tokenholders2?a=${addr}&p=1`;
const EXPLORER_HOST = { ethereum: 'https://etherscan.io', bsc: 'https://bscscan.com' };
const EXPLORER_RELAY_SEG = { ethereum: 'etherscan', bsc: 'bscscan' };

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';
const MORALIS_CHAIN = { ethereum: 'eth', bsc: 'bsc' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class TeamWalletDiscovery extends EventEmitter {
  constructor({ universe, cexWallets, cachePath, relayBaseUrl = null, relayAuthSecret = null, moralisApiKey = null, verbose = false }) {
    super();
    this.universe = universe;
    this.cexWallets = cexWallets;
    this.cachePath = cachePath;

    this.moralisApiKey = moralisApiKey || null;

    this.relayBaseUrl = relayBaseUrl ? relayBaseUrl.replace(/\/$/, '') : null;
    this.relayAuthSecret = relayAuthSecret || null;
    this.verbose = verbose;

    this.cexAddressSet = this.#buildCexSet(cexWallets);

    this.teamByAddress = new Map();

    this.byToken = new Map();

    this.concentrationBySymbol = new Map();

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
    } catch {  }
  }

  #saveManual() {
    const insiders = [...this.manualInsiders.values()];
    if (dbEnabled()) { kvSet(TEAM_DB_NS, 'manual', insiders).catch(err => console.warn(`[team-wallets] manual DB save failed: ${err.message}`)); return; }
    const f = this.#manualFile();
    if (!f) return;
    try { writeFileSync(f, JSON.stringify({ savedAt: Date.now(), insiders }, null, 2)); } catch {  }
  }

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

  async init() {
    if (!dbEnabled()) return this;
    try {
      let data = await kvGet(TEAM_DB_NS, TEAM_DB_KEY);
      if (data == null && this.cachePath && existsSync(this.cachePath)) {
        data = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      }
      if (data) { this.#applyCache(data); this.#save(); }

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

  #applyCache(data) {

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

  getAddressIndex() {
    if (this.manualInsiders.size === 0) return this.teamByAddress;

    const merged = new Map(this.teamByAddress);
    for (const [addr, e] of this.manualInsiders) merged.set(addr, e);
    return merged;
  }

  lookupAddress(address) {
    return this.teamByAddress.get(address.toLowerCase()) ?? null;
  }

  getConcentration(symbol) {
    const e = this.concentrationBySymbol.get((symbol ?? '').toUpperCase());
    if (!e) return null;
    if (Date.now() - (e.ts ?? 0) > 30 * 24 * 60 * 60_000) return null;
    return { top10Pct: e.top10Pct, holderCount: e.holderCount };
  }

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

  // On-demand discovery for ANY token with an ETH/BSC contract (discoverAll only
  // covers favored tokens). Returns the holdersForSymbol shape, or null if the
  // token has no scannable contract.
  async discoverSymbol(symbol) {
    const want = String(symbol || '').toUpperCase();
    if (!want) return null;
    const cached = this.holdersForSymbol(want);
    if (cached) return cached;

    let cand = null;
    for (const cgId of this.universe.allCgIds()) {
      const t = this.universe.lookupByCgId(cgId);
      if (!t || String(t.symbol || '').toUpperCase() !== want) continue;
      for (const chain of ['ethereum', 'bsc']) {
        const info = t.chains?.[chain];
        if (!info?.address) continue;
        cand = { chain, tokenAddress: info.address.toLowerCase(), symbol: t.symbol, cgId };
        break;
      }
      if (cand) break;
    }
    if (!cand) return null;

    try {
      await this.#discoverOne(cand);
    } catch (err) {
      if (this.verbose) console.warn(`[team-wallets] on-demand ${want} failed: ${err.message}`);
      return null;
    }
    return this.holdersForSymbol(want);
  }

  async discoverAll({ maxTokens = 100 } = {}) {
    const candidates = [];
    for (const cgId of this.universe.allCgIds()) {
      if (candidates.length >= maxTokens) break;

      if (!this.universe.isFavored?.(cgId)) continue;
      const t = this.universe.lookupByCgId(cgId);
      if (!t) continue;

      for (const chain of ['ethereum', 'bsc']) {
        const info = t.chains?.[chain];
        if (!info?.address) continue;
        candidates.push({ chain, tokenAddress: info.address.toLowerCase(), symbol: t.symbol, cgId });
        break;
      }
    }
    console.log(`[team-wallets] discovering across ${candidates.length} favored tokens (watchlist + hot movers, cap=${maxTokens})...`);

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

      if (/just a moment|attention required|cf-browser-verification|cf-chl|enable javascript and cookies/i.test(html)) return null;
      return html;
    } catch { return null; }
  }

  async #discoverOne({ chain, tokenAddress, symbol, cgId }) {

    const cached = this.byToken.get(tokenAddress);
    const refreshMs = this.universe?.isHotMover?.(cgId) ? HOT_REFRESH_MS : TEAM_REFRESH_MS;
    if (cached && Date.now() - (cached.ts ?? 0) < refreshMs) {
      return { newHolders: 0 };
    }

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

    const insiders = [];
    for (const h of holders) {
      const lower = h.address.toLowerCase();
      if (lower === tokenAddress.toLowerCase()) continue;
      if (h.isContract) continue;
      if (INFRASTRUCTURE.has(lower)) continue;
      if (this.cexAddressSet.has(lower)) continue;
      if (h.name) {
        const lowName = h.name.toLowerCase();
        const fromApi = ('isContract' in h);
        if (fromApi) {

          if (INFRA_LABEL_PATTERNS.some(p => lowName.includes(p))) continue;
        } else {

          if (DEX_LABEL_PATTERNS.some(p => lowName.includes(p))) continue;
          continue;
        }
      }
      if (h.percent < MIN_PERCENT_KEEP) continue;
      if (h.percent > MAX_PERCENT_KEEP) continue;
      insiders.push(h);
      if (insiders.length >= MAX_HOLDERS_KEPT) break;
    }

    if (cached?.addresses?.length) {
      const ageMs = Date.now() - (cached.ts ?? 0);
      const ageDays = ageMs / 86_400_000;
      if (ageMs >= ACCUM_MIN_WINDOW_HRS * 3_600_000 && ageDays <= ACCUM_WINDOW_DAYS) {
        const accs = detectAccumulation(cached.addresses, insiders);
        for (const a of accs.slice(0, 2)) {
          const text = accumulationText(symbol, chain, a, ageDays);
          console.log(`[team-wallets] ACCUMULATION ${symbol} ${shortAddr(a.address)} ${a.prevPct}%→${a.curPct}% (+${a.delta}) over ${ageDays.toFixed(1)}d`);
          this.emit('accumulation', { symbol, chain, tokenAddress, windowDays: Number(ageDays.toFixed(1)), ...a, text });
        }
      }
    }

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

  #extractHolders(html, tokenAddress) {
    const results = [];
    const seen = new Set();
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const addrFromClipboard = /data-clipboard-text=['"](0x[a-fA-F0-9]{40})['"]/i;
    const addrFromHref = /href=['"]\/token\/0x[a-fA-F0-9]{40}\?a=(0x[a-fA-F0-9]{40})/i;

    const percentPattern = /<td[^>]*>\s*(\d{1,3}(?:\.\d{1,8})?)\s*%/i;

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

      if (addr === tokenAddress.toLowerCase()) continue;
      const pct = Number(pctM[1]);
      if (!isFinite(pct) || pct < 0 || pct > 100) continue;
      seen.add(addr);
      rank++;
      const labelM = row.match(labelPattern);
      let name = labelM?.[1]?.trim() ?? null;

      if (name && /^0x[a-fA-F0-9]{8,}/.test(name)) name = null;
      if (name && /^copy address$/i.test(name)) name = null;
      results.push({ rank, address: addr, percent: pct, name });
      if (results.length >= 50) break;
    }
    return results;
  }
}
