import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { COINGECKO_BASE as CG_BASE, cgHeaders, cgSearch } from './coingecko.js';
import { dbEnabled, kvGet, kvSet } from './db.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UNIVERSE_DB_NS = 'universe', UNIVERSE_DB_KEY = 'cache';

const PLATFORM_KEYS = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  base: 'base',
  solana: 'solana'
};

export class Universe {
  constructor({ topN = 500, topByVolume = 300, cachePath, pinnedTokens = [] } = {}) {
    this.topN = topN;
    this.topByVolume = topByVolume;

    this.cachePath = cachePath;
    this.pinnedTokens = pinnedTokens;

    this.tokensByCgId = new Map();
    this.tokensByChainAddr = new Map();
    this.pinnedCgIds = new Set();
    this.hotMoverCgIds = new Set();
  }

  size() { return this.tokensByCgId.size; }
  allCgIds() { return [...this.tokensByCgId.keys()]; }
  lookupByCgId(id) { return this.tokensByCgId.get(id); }
  lookupByAddress(chain, address) {
    return this.tokensByChainAddr.get(`${chain}|${address.toLowerCase()}`);
  }
  isPinned(cgId) { return this.pinnedCgIds.has(cgId); }
  isHotMover(cgId) { return this.hotMoverCgIds.has(cgId); }

  isFavored(cgId) { return this.pinnedCgIds.has(cgId) || this.hotMoverCgIds.has(cgId); }
  setHotMovers(cgIds) { this.hotMoverCgIds = new Set(cgIds); }
  setDecimals(chain, address, decimals) {
    const t = this.lookupByAddress(chain, address);
    if (t?.chains[chain]) t.chains[chain].decimals = decimals;
  }

  async #cgFetch(path, retries = 4) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(CG_BASE + path, {
          headers: cgHeaders(),
          signal: AbortSignal.timeout(20_000)
        });
        if (!res.ok) {
          if (res.status === 429) {
            await sleep(3000 * (i + 1));
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        await sleep(1500);
      }
    }
    throw lastErr ?? new Error('cg fetch failed');
  }

  async build() {

    const REBUILD_TTL_MS = Number(process.env.UNIVERSE_CACHE_TTL_HRS ?? 24) * 3600_000;
    const fresh = await this.#loadCacheDoc();
    if (fresh && (fresh.schema ?? 1) >= 2 && (fresh.tokens?.length ?? 0) >= 100
        && (Date.now() - (fresh.builtAt ?? 0)) < REBUILD_TTL_MS) {
      this.#applyCacheTokens(fresh.tokens);
      await this.#applyPinned();
      const ageH = ((Date.now() - fresh.builtAt) / 3600_000).toFixed(1);
      console.log(`[universe] loaded ${this.tokensByCgId.size} tokens from ${fresh.source} cache (${ageH}h old) — skipped CoinGecko rebuild`);
      return;
    }

    console.log(`[universe] building from CoinGecko (top ${this.topN} by MC + top ${this.topByVolume} by volume)...`);

    let liveOk = true;
    const seen = new Map();
    let mcCount = 0, volAdded = 0;

    try {
      const mcPages = Math.ceil(this.topN / 250);
      for (let page = 1; page <= mcPages; page++) {
        const data = await this.#cgFetch(
          `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`
        );
        for (const m of data) {
          if (!seen.has(m.id)) { seen.set(m.id, m); mcCount++; }
        }
        if (page < mcPages) await sleep(1500);
      }
    } catch (err) {
      console.warn(`[universe] MC markets fetch failed: ${err.message}`);
      liveOk = false;
    }

    if (liveOk && this.topByVolume > 0) {
      try {
        const volPages = Math.ceil(this.topByVolume / 250);
        for (let page = 1; page <= volPages; page++) {
          const data = await this.#cgFetch(
            `/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}&sparkline=false`
          );
          for (const m of data) {
            if (!seen.has(m.id)) { seen.set(m.id, m); volAdded++; }
          }
          if (page < volPages) await sleep(1500);
        }
        console.log(`[universe] volume pass added ${volAdded} tokens not present in MC top-${this.topN}`);
      } catch (err) {
        console.warn(`[universe] volume markets fetch failed: ${err.message} — continuing with MC-only`);
      }
    }
    const markets = [...seen.values()];

    let platformsByCgId = new Map();
    if (liveOk) {
      try {
        const list = await this.#cgFetch('/coins/list?include_platform=true');
        platformsByCgId = new Map(list.map(c => [c.id, c.platforms ?? {}]));
      } catch (err) {
        console.warn(`[universe] platforms fetch failed: ${err.message} — using markets-only (no chain mapping)`);
      }
    }

    if (!liveOk) {

      const doc = await this.#loadCacheDoc();
      if (doc?.tokens?.length) {
        this.#applyCacheTokens(doc.tokens);
        await this.#applyPinned();
        console.warn(`[universe] DEGRADED — loaded ${this.tokensByCgId.size} tokens from ${doc.source} cache (CoinGecko unreachable)`);
        return;
      }
      throw new Error('Could not fetch universe and no usable cache');
    }

    for (const m of markets) this.#upsertMarketRecord(m, platformsByCgId.get(m.id) ?? {});

    await this.#applyPinned();
    this.#saveCache();

    const ethCount = [...this.tokensByCgId.values()].filter(t => t.chains.ethereum).length;
    const bscCount = [...this.tokensByCgId.values()].filter(t => t.chains.bsc).length;
    const baseCount = [...this.tokensByCgId.values()].filter(t => t.chains.base).length;
    const solCount = [...this.tokensByCgId.values()].filter(t => t.chains.solana).length;
    console.log(`[universe] built ${this.tokensByCgId.size} tokens — eth:${ethCount} bsc:${bscCount} base:${baseCount} sol:${solCount}`);
  }

  async #applyPinned() {
    let fetched = 0;
    for (const pinned of this.pinnedTokens) {

      if (typeof pinned === 'string') {
        const cgId = pinned.trim();
        if (!cgId) continue;
        this.pinnedCgIds.add(cgId);
        if (this.tokensByCgId.has(cgId)) continue;
        const token = await this.#fetchPinnedByCgId(cgId);
        if (!token) continue;
        this.tokensByCgId.set(cgId, token);
        for (const [chain, info] of Object.entries(token.chains)) {
          if (info?.address) {
            this.tokensByChainAddr.set(`${chain}|${info.address.toLowerCase()}`, token);
          }
        }
        fetched++;
        await sleep(1500);
        continue;
      }

      if (!pinned.coingeckoId || !pinned.chain || !pinned.address) continue;
      this.pinnedCgIds.add(pinned.coingeckoId);
      const normalizedAddr = pinned.chain === 'solana' ? pinned.address : pinned.address.toLowerCase();
      let token = this.tokensByCgId.get(pinned.coingeckoId);
      if (!token) {
        token = {
          coingeckoId: pinned.coingeckoId,
          symbol: pinned.symbol ?? pinned.coingeckoId.toUpperCase(),
          name: pinned.symbol ?? pinned.coingeckoId,
          marketCapRank: null,
          circulatingSupply: null,
          totalSupply: null,
          chains: {}
        };
        this.tokensByCgId.set(pinned.coingeckoId, token);
      }
      if (!token.chains[pinned.chain]) {
        token.chains[pinned.chain] = { address: normalizedAddr, decimals: pinned.decimals ?? null };
      }
      this.tokensByChainAddr.set(`${pinned.chain}|${normalizedAddr.toLowerCase()}`, token);
    }

    const pinnedFound = this.pinnedTokens.filter(p =>
      typeof p === 'string' ? this.tokensByCgId.has(p) : (p.coingeckoId && this.tokensByCgId.has(p.coingeckoId))
    ).length;
    console.log(`[universe] pinned tokens: ${pinnedFound}/${this.pinnedTokens.length} loaded (${fetched} newly fetched)`);
  }

  async addPinnedToken(cgId) {
    const id = cgId?.trim().toLowerCase();
    if (!id) return null;
    this.pinnedCgIds.add(id);
    return this.ensureToken(id);
  }

  async ensureToken(cgId, { persist = true } = {}) {
    const id = cgId?.trim().toLowerCase();
    if (!id) return null;
    const existing = this.tokensByCgId.get(id);
    if (existing) return existing;
    const token = await this.#fetchPinnedByCgId(id);
    if (!token) return null;
    this.tokensByCgId.set(id, token);
    for (const [chain, info] of Object.entries(token.chains)) {
      if (info?.address) {
        this.tokensByChainAddr.set(`${chain}|${info.address.toLowerCase()}`, token);
      }
    }
    if (persist) this.#saveCache();
    return token;
  }

  async ensureBySymbol(symbol, { persist = false } = {}) {
    const want = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!want) return null;
    for (const t of this.tokensByCgId.values()) {
      if (t?.symbol?.toUpperCase() === want) return t;
    }
    let matches = [];
    try { matches = await cgSearch(want, 8); } catch { return null; }
    const pick = matches.find(m => m.symbol === want);
    if (!pick?.id) return null;
    return this.ensureToken(pick.id, { persist });
  }

  async refreshHotVolume(limit = this.topByVolume) {
    if (!(limit > 0)) return 0;
    let markets = [];
    try {
      const pages = Math.ceil(limit / 250);
      for (let page = 1; page <= pages; page++) {
        const data = await this.#cgFetch(`/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}&sparkline=false`);
        markets.push(...data);
        if (page < pages) await sleep(1500);
      }
    } catch (err) {
      console.warn(`[universe] hot-volume refresh failed: ${err.message}`);
      return 0;
    }
    const fresh = markets.filter(m => m?.id && !this.tokensByCgId.has(m.id));
    if (!fresh.length) return 0;

    let platformsByCgId = new Map();
    try {
      const list = await this.#cgFetch('/coins/list?include_platform=true');
      platformsByCgId = new Map(list.map(c => [c.id, c.platforms ?? {}]));
    } catch (err) {
      console.warn(`[universe] hot-volume platforms fetch failed: ${err.message} — adding without chain mapping`);
    }
    let added = 0;
    for (const m of fresh) {
      if (this.#upsertMarketRecord(m, platformsByCgId.get(m.id) ?? {})) added++;
    }
    if (added) { this.#saveCache(); console.log(`[universe] hot-volume refresh added ${added} newly-active token(s)`); }
    return added;
  }

  async ensureByAddress(chain, address, { persist = false } = {}) {
    const platform = PLATFORM_KEYS[chain];
    if (!platform || !address) return null;
    const addr = chain === 'solana' ? address : String(address).toLowerCase();
    const existing = this.lookupByAddress(chain, addr);
    if (existing) return existing;
    let data;
    try { data = await this.#cgFetch(`/coins/${platform}/contract/${addr}`); }
    catch { return null; }
    if (!data?.id) return null;
    return this.ensureToken(data.id, { persist });
  }

  #upsertMarketRecord(m, platforms = {}) {
    if (!m?.id || this.tokensByCgId.has(m.id)) return false;
    const marketCap = typeof m.market_cap === 'number' ? m.market_cap : null;
    const fdv = typeof m.fully_diluted_valuation === 'number' ? m.fully_diluted_valuation : null;
    const token = {
      coingeckoId: m.id,
      symbol: (m.symbol ?? '').toUpperCase(),
      name: m.name,
      marketCapRank: m.market_cap_rank,
      marketCap,
      fdv,
      fdvRatio: (marketCap && fdv && marketCap > 0) ? (fdv / marketCap) : null,
      circulatingSupply: typeof m.circulating_supply === 'number' ? m.circulating_supply : null,
      totalSupply:      typeof m.total_supply       === 'number' ? m.total_supply       : null,
      chains: {}
    };
    for (const [chain, cgKey] of Object.entries(PLATFORM_KEYS)) {
      const addr = platforms[cgKey];
      if (!addr) continue;
      token.chains[chain] = { address: chain === 'solana' ? addr : addr.toLowerCase(), decimals: null };
    }
    this.tokensByCgId.set(m.id, token);
    for (const [chain, info] of Object.entries(token.chains)) {
      this.tokensByChainAddr.set(`${chain}|${info.address.toLowerCase()}`, token);
    }
    return true;
  }

  removePinnedToken(cgId) {
    const id = cgId?.trim().toLowerCase();
    if (!id) return false;
    this.pinnedCgIds.delete(id);
    const token = this.tokensByCgId.get(id);
    if (!token) return false;
    this.tokensByCgId.delete(id);
    for (const [chain, info] of Object.entries(token.chains ?? {})) {
      if (info?.address) {
        this.tokensByChainAddr.delete(`${chain}|${info.address.toLowerCase()}`);
      }
    }
    this.#saveCache();
    return true;
  }

  async #fetchPinnedByCgId(cgId) {
    try {
      const data = await this.#cgFetch(
        `/coins/${cgId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`
      );
      const platforms = data?.platforms ?? {};
      const marketCap = typeof data?.market_data?.market_cap?.usd === 'number'
        ? data.market_data.market_cap.usd : null;
      const fdv = typeof data?.market_data?.fully_diluted_valuation?.usd === 'number'
        ? data.market_data.fully_diluted_valuation.usd : null;
      const token = {
        coingeckoId: cgId,
        symbol: (data?.symbol ?? cgId).toUpperCase(),
        name: data?.name ?? cgId,
        marketCapRank: data?.market_cap_rank ?? null,
        marketCap,
        fdv,
        fdvRatio: (marketCap && fdv && marketCap > 0) ? (fdv / marketCap) : null,
        circulatingSupply: data?.market_data?.circulating_supply ?? null,
        totalSupply: data?.market_data?.total_supply ?? null,
        chains: {}
      };
      for (const [chain, cgKey] of Object.entries(PLATFORM_KEYS)) {
        const addr = platforms[cgKey];
        if (!addr) continue;
        token.chains[chain] = {
          address: chain === 'solana' ? addr : addr.toLowerCase(),
          decimals: null
        };
      }
      return token;
    } catch (err) {
      console.warn(`[universe] pinned token "${cgId}" fetch failed: ${err.message}`);
      return null;
    }
  }

  #saveCache() {
    const doc = { builtAt: Date.now(), schema: 2, tokens: [...this.tokensByCgId.values()] };

    if (dbEnabled()) kvSet(UNIVERSE_DB_NS, UNIVERSE_DB_KEY, doc).catch(err => console.warn(`[universe] DB cache save failed: ${err.message}`));
    if (!this.cachePath) return;
    try { writeFileSync(this.cachePath, JSON.stringify(doc)); }
    catch (err) { console.warn(`[universe] cache save failed: ${err.message}`); }
  }

  async #loadCacheDoc() {
    if (dbEnabled()) {
      try {
        const doc = await kvGet(UNIVERSE_DB_NS, UNIVERSE_DB_KEY);
        if (doc?.tokens?.length) return { ...doc, source: 'Neon' };
      } catch (err) { console.warn(`[universe] DB cache load failed: ${err.message}`); }
    }
    if (this.cachePath && existsSync(this.cachePath)) {
      try {
        const doc = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        if (doc?.tokens?.length) return { ...doc, source: 'disk' };
      } catch {  }
    }
    return null;
  }

  #applyCacheTokens(tokens) {
    for (const token of tokens ?? []) {
      if (!token?.coingeckoId) continue;
      this.tokensByCgId.set(token.coingeckoId, token);
      for (const [chain, info] of Object.entries(token.chains ?? {})) {
        if (info?.address) this.tokensByChainAddr.set(`${chain}|${info.address.toLowerCase()}`, token);
      }
    }
  }
}
