import { EventEmitter } from 'node:events';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DECIMALS_SELECTOR = '0x313ce567';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const padAddress = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();

// Known DEX router/pool-manager contracts → friendly label, so an insider→DEX
// dump reads "dumped on Uniswap" not just "a DEX". Lowercased. Generic contract
// destinations fall back to "a DEX/on-chain pool".
const DEX_CONTRACTS = {
  ethereum: {
    '0x000000000004444c5dc75cb358380d2e3de08a90': 'Uniswap (V4 PoolManager)',
    '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap (UniversalRouter)',
    '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap (UniversalRouter)',
    '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap (UniversalRouter)',
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap (V2 Router)',
    '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap (V3 Router)',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap (V3 Router2)',
    '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap (Router)',
  },
  bsc: {
    '0x10ed43c718714eb63d5aa57b78b54704e256024e': 'PancakeSwap (V2 Router)',
    '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeSwap (V3 Router)',
    '0x1b81d678ffb9c0263b24a97847620c99d213eb14': 'PancakeSwap (SmartRouter)',
  },
  base: {
    '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap (V3 SwapRouter02)',
    '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap (UniversalRouter)',
    '0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap (V4 PoolManager)',
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome (Router)',
    '0x6cb442acf35158d5eda88fe602221b67b400be3e': 'Aerodrome (UniversalRouter)',
  },
};

// Wallet-centric EVM monitor:
//   - Polls eth_getLogs filtered by indexed addresses (CEX wallets), not by token contract.
//   - Catches every token any CEX wallet touches, then cross-references against the
//     CoinGecko-built universe to decide if it's CEX-tradeable.
//   - Lazy-fetches decimals via eth_call for tokens we haven't seen before.
export class EvmMonitor extends EventEmitter {
  constructor({ chain, rpcs, pollIntervalMs, maxBlocksPerCall, walletsForChain, universe, labelResolver = null, teamDiscovery = null, verbose = false }) {
    super();
    this.chain = chain;
    this.rpcs = rpcs;
    this.rpcIndex = 0;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBlocksPerCall = maxBlocksPerCall;
    // CATCH-UP cap: on a restart or after downtime, lastBlock can be far behind the
    // head. Scanning that whole backlog replays OLD transfers — and they're stamped
    // Date.now() (detection time, not block time), so a 2pm flow alerts at 9pm. Cap the
    // lookback to ~ONCHAIN_MAX_CATCHUP_MIN of recent history (converted to blocks per
    // chain); skip the rest — those flows are stale and untradeable anyway.
    const BLOCK_SEC = { ethereum: 12, bsc: 3, base: 2 };
    this.maxCatchupBlocks = Math.ceil((Number(process.env.ONCHAIN_MAX_CATCHUP_MIN ?? 15) * 60) / (BLOCK_SEC[chain] ?? 12));
    this.universe = universe;
    this.labelResolver = labelResolver;        // optional WalletLabelResolver
    this.teamDiscovery = teamDiscovery;        // optional TeamWalletDiscovery
    this.verbose = verbose;

    // On-demand resolution of UNTRACKED tokens seen in tracked-wallet flows. Every
    // eth_getLogs hit already has a CEX/team wallet on one end (that's the filter),
    // so an unknown TOKEN here is a real flow on a name outside the universe. Resolve
    // it via CoinGecko's contract endpoint so it gets covered. OFF by default
    // (ONCHAIN_RESOLVE_PER_MIN=0); rate-limited per minute; failures neg-cached so a
    // contract CoinGecko doesn't index isn't re-hammered every poll.
    this.resolvePerMin = Number(process.env.ONCHAIN_RESOLVE_PER_MIN ?? 0);
    this.unknownTokenNeg = new Map();          // tokenAddr → neg-cache expiry (ms)
    this.unknownTokenNegMs = Number(process.env.ONCHAIN_RESOLVE_NEG_HRS ?? 6) * 60 * 60_000;
    this.resolveTimes = [];                     // rolling 1-min window of attempt timestamps

    this.walletIndex = this.#buildWalletIndex(walletsForChain);
    // Team wallet index — address (lower) → { tokenSymbol, tokenAddress, ... }
    // Included in the topic filter alongside CEX wallets so we catch any
    // transfer touching either set in a single eth_getLogs call. Team
    // wallets discovered AFTER startup are picked up at the next call to
    // refreshTeamIndex().
    this.teamIndex = teamDiscovery?.getAddressIndex() ?? new Map();
    this.paddedWallets = this.#rebuildPaddedWallets();

    // Derived (multi-hop) team wallets. When a known insider sends tokens to
    // a FRESH unlabeled wallet, we remember that wallet here — so if it then
    // forwards to a CEX (the GUA "team → fresh wallet → exchange" laundering
    // pattern) we still recognise it as team distribution. We do NOT need to
    // add these to the eth_getLogs filter: the final →CEX hop is always
    // caught because the CEX address is already in the filter. Entries
    // expire after DERIVED_TTL_MS (the active distribution window).
    this.derivedTeam = new Map();    // address → { tokenSymbol, tokenAddress, chain, originRank, hops, ts }
    this.derivedTeamGcAt = 0;
    this.DERIVED_TTL_MS = 48 * 60 * 60_000;   // 48h active-distribution window
    this.DERIVED_MAX = 300;                    // cap to bound memory

    this.lastBlock = null;
    this.intervalId = null;
    this.decimalsCache = new Map();
    // Cross-poll log dedup. Keyed by `${tx}-${logIndex}` → epoch ms processed.
    // Public RPCs can return the same log on overlapping polls when one
    // poll runs slow; this guarantees each on-chain transfer fires exactly
    // once regardless of how the polls interleave.
    this.processedLogs = new Map();
    this.processedLogsGcAt = 0;
    // Guard against overlapping #poll() invocations — setInterval fires
    // independent of whether the previous call finished. Without this
    // guard, a slow RPC causes 5+ concurrent polls all reading the same
    // lastBlock and re-emitting the same flows.
    this.pollInFlight = false;
  }

  #buildWalletIndex(walletsForChain) {
    const index = new Map();
    if (!walletsForChain) return index;
    for (const [exchange, sides] of Object.entries(walletsForChain)) {
      // Per-exchange optional names map: lowercase-address → friendly sub-label.
      // Keys are pre-lowercased in the config so no normalisation needed at read.
      const names = sides.names ?? {};
      for (const type of ['hot', 'cold']) {
        for (const addr of sides[type] ?? []) {
          const lower = addr.toLowerCase();
          index.set(lower, { exchange, type, name: names[lower] ?? null });
        }
      }
    }
    return index;
  }

  // Combine CEX wallets + team wallets into the topic filter. eth_getLogs
  // result-size limits on public RPCs blow up ("limit exceeded") when the
  // indexed-address set is large AND we don't constrain by token address.
  // CEX wallets are always included (they're the core signal). Team wallets
  // are capped — only the first MAX_TEAM_FILTER_ADDRESSES (by insertion /
  // holder rank) make it into the filter — so adding team tracking can't
  // overflow the RPC. Team wallets only watch THIS chain's addresses.
  #rebuildPaddedWallets() {
    const MAX_TEAM_FILTER_ADDRESSES = Number(process.env.TEAM_FILTER_MAX_ADDR ?? 80);
    const cexAddrs = [...this.walletIndex.keys()];
    // Only include team addresses that belong to THIS chain (the team index
    // is global across chains) — avoids padding the BSC filter with ETH-only
    // insider addresses that can never appear in a BSC log.
    const teamAddrs = [];
    for (const [addr, info] of this.teamIndex.entries()) {
      if (info?.chain && info.chain !== this.chain) continue;
      teamAddrs.push(addr);
      if (teamAddrs.length >= MAX_TEAM_FILTER_ADDRESSES) break;
    }
    const all = new Set([...cexAddrs, ...teamAddrs]);
    return [...all].map(padAddress);
  }

  // Look up an address in BOTH the discovered insider index and the derived
  // (multi-hop) index. Returns the entry only if the token matches the one
  // being transferred (prevents cross-token false positives). Derived
  // entries carry a `hops` count so the alert can say "2 hops from insider".
  #lookupTeam(addr, tokenAddr) {
    const direct = this.teamIndex.get(addr);
    if (direct && direct.tokenAddress?.toLowerCase() === tokenAddr) return direct;
    const derived = this.derivedTeam.get(addr);
    if (derived && derived.tokenAddress?.toLowerCase() === tokenAddr) {
      // Expired derived entries are ignored (and lazily dropped).
      if (Date.now() - derived.ts > this.DERIVED_TTL_MS) { this.derivedTeam.delete(addr); return null; }
      return derived;
    }
    return null;
  }

  // Register a fresh wallet that just received tokens from a known/derived
  // insider. Capped + TTL'd so it can't grow unbounded. Stops at 2 hops —
  // beyond that the link to the original insider is too tenuous to trust.
  #registerDerivedTeam(addr, origin) {
    const hops = (origin.hops ?? 0) + 1;
    if (hops > 2) return;
    if (this.derivedTeam.size >= this.DERIVED_MAX && !this.derivedTeam.has(addr)) return;
    this.derivedTeam.set(addr, {
      tokenSymbol: origin.tokenSymbol,
      tokenAddress: origin.tokenAddress,
      chain: this.chain,
      originRank: origin.originRank ?? origin.rank ?? null,
      rank: origin.originRank ?? origin.rank ?? null,
      hops,
      ts: Date.now()
    });
    if (this.verbose) console.log(`[${this.chain}] derived team wallet ${addr} (${origin.tokenSymbol}, hop ${hops}) — watching for →CEX`);
  }

  #gcDerivedTeam() {
    const now = Date.now();
    if (now - this.derivedTeamGcAt < 60_000) return;
    for (const [addr, e] of this.derivedTeam) {
      if (now - e.ts > this.DERIVED_TTL_MS) this.derivedTeam.delete(addr);
    }
    this.derivedTeamGcAt = now;
  }

  // Called by index.js after team-wallet discovery refreshes its index.
  // We rebuild paddedWallets so subsequent eth_getLogs include the new set.
  refreshTeamIndex() {
    if (!this.teamDiscovery) return 0;
    this.teamIndex = this.teamDiscovery.getAddressIndex();
    this.paddedWallets = this.#rebuildPaddedWallets();
    if (this.verbose) console.log(`[${this.chain}] refreshed team index → ${this.teamIndex.size} team addrs, total filter size ${this.paddedWallets.length}`);
    // A chain with no CEX wallets (e.g. Base) skips start() at boot when it has
    // nothing to watch. If an operator just added the FIRST insider for this
    // chain, the poll loop isn't running yet — boot it now so the watch takes
    // effect without a restart. (No-op once intervalId is set.)
    if (!this.intervalId && this.paddedWallets.length > 0) {
      this.start().catch(err => console.error(`[${this.chain}] lazy start failed: ${err.message}`));
    }
    return this.teamIndex.size;
  }

  get rpcUrl() { return this.rpcs[this.rpcIndex % this.rpcs.length]; }
  #switchRpc(reason) {
    this.rpcIndex++;
    if (this.verbose) console.warn(`[${this.chain}] switching RPC → ${this.rpcUrl} (${reason})`);
  }

  async #rpcCall(method, params) {
    const total = this.rpcs.length * 2;
    let lastErr;
    for (let i = 0; i < total; i++) {
      try {
        const res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
          signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) {
          const err = new Error(data.error.message ?? JSON.stringify(data.error));
          err.code = data.error.code;
          err.isRpcError = true;
          throw err;
        }
        return data.result;
      } catch (err) {
        lastErr = err;
        const msg = err.message?.toLowerCase() ?? '';
        // ONLY treat unambiguous block-range errors as "split needed". A bare
        // "limit exceeded" is usually an RPC quota issue and should failover
        // to a different RPC, not split a (possibly single-block) range and
        // loop forever.
        const isBlockRange = (
          msg.includes('block range') ||
          msg.includes('too many blocks') ||
          msg.includes('query returned more than') ||
          msg.includes('too many results') ||
          (msg.includes('range') && msg.includes('too large')) ||
          (msg.includes('exceed') && msg.includes('range')) ||
          (msg.includes('exceed') && msg.includes('block'))
        );
        if (isBlockRange) {
          throw err; // let caller split
        }
        this.#switchRpc(err.message);
        await sleep(300);
      }
    }
    throw lastErr ?? new Error('all RPCs failed');
  }

  async start() {
    if (this.intervalId) return;   // idempotent — already polling (lazy-start may race the boot call)
    // Start when there's ANYTHING to watch: CEX wallets OR team/manual insider
    // addresses for this chain. A chain like Base may ship with no CEX-wallet
    // list yet still need to run for an operator-added insider (its outgoing
    // DEX dumps) — gating purely on CEX wallets would silently skip it.
    const teamAddrs = Math.max(0, this.paddedWallets.length - this.walletIndex.size);
    if (this.walletIndex.size === 0 && this.paddedWallets.length === 0) {
      console.warn(`[${this.chain}] no labeled or team wallets — skipping chain (add CEX wallets or an insider with \`/insider add … ${this.chain}\`)`);
      return;
    }
    try {
      const hex = await this.#rpcCall('eth_blockNumber', []);
      this.lastBlock = parseInt(hex, 16);
      console.log(`[${this.chain}] polling started at block ${this.lastBlock} via ${this.rpcUrl} (watching ${this.walletIndex.size} CEX + ${teamAddrs} team wallets)`);
    } catch (err) {
      console.error(`[${this.chain}] init failed: ${err.message}`);
      return;
    }
    this.intervalId = setInterval(() => {
      if (this.pollInFlight) {
        if (this.verbose) console.warn(`[${this.chain}] previous poll still running, skipping tick`);
        return;
      }
      this.pollInFlight = true;
      this.#poll()
        .catch(err => console.error(`[${this.chain}] poll error: ${err.message}`))
        .finally(() => { this.pollInFlight = false; });
    }, this.pollIntervalMs);
  }

  // Garbage-collect processedLogs every minute (entries older than 10 minutes
  // can't be re-emitted by future polls — lastBlock has advanced way past).
  #gcProcessedLogs() {
    const now = Date.now();
    if (now - this.processedLogsGcAt < 60_000) return;
    const cutoff = now - 10 * 60_000;
    for (const [k, ts] of this.processedLogs) {
      if (ts < cutoff) this.processedLogs.delete(k);
    }
    this.processedLogsGcAt = now;
  }

  async #poll() {
    let current;
    try {
      current = parseInt(await this.#rpcCall('eth_blockNumber', []), 16);
    } catch (err) {
      console.warn(`[${this.chain}] blockNumber failed: ${err.message}`);
      return;
    }

    // Confirmation margin: public RPCs can be 1-2 blocks apart. Asking for
    // logs at the very tip causes "block range extends beyond current head"
    // when we hit an RPC that's behind ours. Stay 2 blocks back.
    const safeTo = current - 2;
    if (safeTo <= this.lastBlock) return;

    const to = safeTo;
    let from = this.lastBlock + 1;
    // Skip a stale backlog (restart/downtime) so we never replay hours-old transfers as
    // fresh flows. Only ever scan the most recent ~maxCatchupBlocks.
    if (to - from > this.maxCatchupBlocks) {
      const jumpTo = to - this.maxCatchupBlocks;
      console.log(`[${this.chain}] catch-up: skipping ${jumpTo - from} stale blocks (lastBlock ${this.lastBlock} → ${jumpTo}); scanning recent ${this.maxCatchupBlocks} only`);
      from = jumpTo;
    }
    const seen = new Set(); // dedupe events that appear in both to/from queries

    let maxFetched = from - 1;
    const advanced = async (chunkEnd) => { if (chunkEnd > maxFetched) maxFetched = chunkEnd; };

    await this.#fetchRange(from, to, 'to', seen, advanced);
    await this.#fetchRange(from, to, 'from', seen, advanced);

    // Only advance to the highest block we actually managed to fetch
    if (maxFetched >= from) this.lastBlock = maxFetched;

    // Periodic GC of the cross-poll dedup cache (cheap; runs at most once/min)
    this.#gcProcessedLogs();
    this.#gcDerivedTeam();
  }

  async #fetchRange(from, to, direction, seen, onChunkOk) {
    let cursor = from;
    while (cursor <= to) {
      const end = Math.min(cursor + this.maxBlocksPerCall - 1, to);
      const ok = await this.#fetchChunk(cursor, end, direction, seen);
      if (ok && onChunkOk) await onChunkOk(end);
      cursor = end + 1;
    }
  }

  async #fetchChunk(from, to, direction, seen) {
    const filter = {
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics: direction === 'to'
        ? [TRANSFER_TOPIC, null, this.paddedWallets]
        : [TRANSFER_TOPIC, this.paddedWallets, null]
    };

    let logs;
    try {
      logs = await this.#rpcCall('eth_getLogs', [filter]);
    } catch (err) {
      const msg = err.message?.toLowerCase() ?? '';
      const isBeyondHead = msg.includes('beyond') || msg.includes('not found') ||
                           msg.includes('unknown block') || msg.includes('not available');
      if (isBeyondHead) {
        if (this.verbose) console.warn(`[${this.chain}] block ${from}→${to} not yet on RPC; will retry`);
        return false;
      }
      // Real block-range errors (data volume) — same precise match as #rpcCall.
      const isBlockRange = (
        msg.includes('block range') ||
        msg.includes('too many blocks') ||
        msg.includes('query returned more than') ||
        msg.includes('too many results') ||
        (msg.includes('range') && msg.includes('too large')) ||
        (msg.includes('exceed') && msg.includes('range')) ||
        (msg.includes('exceed') && msg.includes('block'))
      );
      if (isBlockRange && to > from) {
        const mid = Math.floor((from + to) / 2);
        if (this.verbose) console.warn(`[${this.chain}] split ${from}→${to} at ${mid}`);
        const a = await this.#fetchChunk(from, mid, direction, seen);
        const b = await this.#fetchChunk(mid + 1, to, direction, seen);
        return a && b;
      }
      if (isBlockRange && to === from) {
        // Already a single block and still a "range" error → some RPCs cap on
        // result count even for one block. Skip it rather than loop forever.
        console.warn(`[${this.chain}] block ${from} unsplittable, skipping: ${err.message}`);
        return true; // treat as processed so lastBlock advances past it
      }
      console.warn(`[${this.chain}] getLogs ${direction} ${from}→${to} failed: ${err.message}`);
      return false;
    }

    // A flaky RPC can return a non-array (error object / string / null) even on a
    // 200 — `?? []` only catches null/undefined, so a truthy non-array crashed
    // the whole poll with "(logs ?? []) is not iterable", silently killing ETH
    // CEX-flow detection until restart. Coerce anything non-array to empty.
    if (!Array.isArray(logs)) {
      if (this.verbose) console.warn(`[${this.chain}] getLogs returned non-array (${typeof logs}) — skipping range`);
      return true;   // treat as processed so lastBlock advances; next poll retries fresh
    }
    for (const log of logs) {
      const key = `${log.transactionHash}-${log.logIndex}`;
      // Within-poll dedup (same log returned by both to/from queries)
      if (seen.has(key)) continue;
      seen.add(key);
      // Cross-poll dedup (slow RPC + overlapping polls returning same logs)
      if (this.processedLogs.has(key)) continue;
      this.processedLogs.set(key, Date.now());
      await this.#processLog(log);
    }
    return true;
  }

  // Resolve an untracked token by contract address → universe entry. Returns the
  // token or null. Gated OFF unless ONCHAIN_RESOLVE_PER_MIN > 0. Rate-limited to
  // resolvePerMin attempts/min; misses are negative-cached for ONCHAIN_RESOLVE_NEG_HRS
  // so a contract CoinGecko can't resolve isn't retried on every poll.
  async #resolveUnknownToken(tokenAddr) {
    if (this.resolvePerMin <= 0) return null;
    const now = Date.now();
    const negTill = this.unknownTokenNeg.get(tokenAddr);
    if (negTill && negTill > now) return null;
    this.resolveTimes = this.resolveTimes.filter(t => now - t < 60_000);
    if (this.resolveTimes.length >= this.resolvePerMin) return null;   // budget spent this minute
    this.resolveTimes.push(now);
    let token = null;
    try { token = await this.universe.ensureByAddress(this.chain, tokenAddr, { persist: true }); }
    catch { token = null; }
    if (!token) {
      this.unknownTokenNeg.set(tokenAddr, now + this.unknownTokenNegMs);
      if (this.unknownTokenNeg.size > 5000) {            // bound memory — sweep expired
        for (const [k, exp] of this.unknownTokenNeg) if (exp < now) this.unknownTokenNeg.delete(k);
      }
      return null;
    }
    if (this.verbose) console.log(`[${this.chain}] resolved untracked token ${tokenAddr} → ${token.symbol}`);
    return token;
  }

  async #processLog(log) {
    if (!log || log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) return;

    const tokenAddr = log.address.toLowerCase();
    let tokenInfo = this.universe.lookupByAddress(this.chain, tokenAddr);
    if (!tokenInfo) {
      // A tracked wallet is on one end (the eth_getLogs filter guarantees it), but
      // the TOKEN isn't in the universe. Resolve on demand (rate-limited + neg-cached)
      // so flows on freshly-listed / untracked names still get covered. Off by default.
      tokenInfo = await this.#resolveUnknownToken(tokenAddr);
      if (!tokenInfo) {
        if (this.verbose) console.log(`[${this.chain}] skip non-universe token ${tokenAddr}`);
        return;
      }
    }

    const from = '0x' + log.topics[1].slice(-40).toLowerCase();
    const to = '0x' + log.topics[2].slice(-40).toLowerCase();

    let fromLabel = this.walletIndex.get(from);
    let toLabel = this.walletIndex.get(to);

    // Team-wallet check — separate from CEX label. We look up either end
    // against the team-discovery index AND the derived (multi-hop) index.
    // CRITICAL: an address can be a known insider of TOKEN_A while
    // incidentally receiving an unrelated TOKEN_B (airdrop, refund). Only
    // treat the address as a "team wallet" if the TOKEN BEING TRANSFERRED
    // matches the token they're an insider of.
    const fromTeam = this.#lookupTeam(from, tokenAddr);
    const toTeam   = this.#lookupTeam(to, tokenAddr);

    // Multi-hop registration: a known/derived insider sending to a FRESH
    // unlabeled wallet means the supply is being staged for distribution
    // (the classic "move to a fresh wallet, then sell" laundering). Register
    // the recipient as a derived team wallet so its later →CEX hop is caught.
    if (fromTeam && !toLabel && !toTeam) {
      this.#registerDerivedTeam(to, fromTeam);
    }

    // A transfer is relevant if EITHER end is a CEX wallet OR EITHER end
    // is a verified team wallet (token-matched) sending to/from a CEX.
    if (!fromLabel && !toLabel && !fromTeam && !toTeam) return;

    // Auto-label discovery: ask the explorer for a public name tag on the
    // unlabeled side. Catches CEX wallets we haven't curated yet (the
    // recurring Gate.io rotation case). Resolver is cached on disk so
    // each address is fetched at most once. If discovery succeeds, treat
    // the address like a fully-labeled CEX wallet from this point on
    // (including the same-exchange same-type skip just below).
    if (this.labelResolver) {
      try {
        if (!fromLabel) {
          const r = await this.labelResolver.resolve(this.chain, from);
          if (r) fromLabel = r;
        }
        if (!toLabel) {
          const r = await this.labelResolver.resolve(this.chain, to);
          if (r) toLabel = r;
        }
      } catch (err) {
        if (this.verbose) console.warn(`[${this.chain}] label resolve error: ${err.message}`);
      }
    }

    // Skip same-exchange same-type internal shuffles (cold→cold, hot→hot rotation)
    if (fromLabel && toLabel &&
        fromLabel.exchange === toLabel.exchange &&
        fromLabel.type === toLabel.type) {
      if (this.verbose) console.log(`[${this.chain}] skip ${tokenInfo.symbol} ${fromLabel.exchange} ${fromLabel.type}→${toLabel.type} internal rotation`);
      return;
    }

    // ── Classification: which COLD-wallet edge are we looking at? ───────
    // Same-exchange internal flows are unambiguous; flows involving an
    // external (unlabeled) counterparty need careful interpretation.
    //
    //   hot→cold  same exchange: exchange ACCUMULATING off market ......... LONG
    //   cold→hot  same exchange: exchange DISTRIBUTING                      SHORT
    //   external→cold:            unknown party DEPOSITING into cold —
    //                             typically token-team/OTC pre-distribution.
    //                             (Real-world calibration: TAG 4.2B external→cold
    //                             on Gate.io coincided with the short squeeze,
    //                             NOT a pump. Treating this as LONG was wrong.) SHORT
    //   cold→external:            cold wallet withdrawing supply OFF the
    //                             exchange — counterparty taking custody,
    //                             reducing sellable float ...................... LONG
    //   anything else (hot↔hot, hot↔external, cold↔cold cross-exchange) skipped.
    let direction = null;
    let exchange = null;
    // teamFlow detection — when a tracked insider sends to ANY CEX wallet
    // (hot or cold), that's the high-confidence "team distribution" signal.
    // We flag it explicitly so the conductor can apply a heavy bearish boost.
    let teamFlow = null;
    // Distribution CANDIDATE — a single hot→external/other-exchange transfer is
    // mostly normal customer-withdrawal noise, so it must NOT fire a per-transfer
    // signal. But a CONCENTRATED, continuous stream of them for ONE token is the
    // distribution pattern an on-chain analyst reads as a dump (the SKYAI case:
    // Bitget hot → MEV bots / MEXC deposit). Flagged here; the conductor
    // AGGREGATES per-token over a window and only alerts when abnormal.
    let isDistribution = false;

    const sameExchange = fromLabel && toLabel && fromLabel.exchange === toLabel.exchange;

    if (sameExchange && fromLabel.type === 'hot' && toLabel.type === 'cold') {
      // Exchange-INTERNAL hot→cold is custody/treasury rebalancing (an exchange
      // sweeping deposits into its OWN cold storage) — NOT accumulation. It has no
      // directional edge and was the bulk of the 22%-WR flow noise (the "Binance 14
      // → Binance Cold 14 = LONG" misread). Non-directional: informational only, never
      // a tradeable signal. A directional flow needs a NON-exchange (team/insider/
      // whale) counterparty — the team branches below.
      direction = null;
      exchange = toLabel.exchange;
    } else if (sameExchange && fromLabel.type === 'cold' && toLabel.type === 'hot') {
      direction = null;   // exchange-internal cold→hot = custody rebalancing, no edge
      exchange = fromLabel.exchange;
    } else if (fromTeam && toLabel) {
      // Tracked insider → CEX (hot OR cold) = team distribution. Strongest
      // bearish on-chain signal we have. Direction = SHORT regardless of
      // hot/cold endpoint, because the supply is leaving the team's
      // private control and entering exchange custody.
      direction = 'short';
      exchange = toLabel.exchange;
      teamFlow = {
        side: 'sell',
        tokenSymbol: fromTeam.tokenSymbol,
        holderRank: fromTeam.rank,
        holderPercent: fromTeam.percent,
        hops: fromTeam.hops ?? 0          // >0 = laundered through fresh wallet(s)
      };
    } else if (fromLabel && toTeam) {
      // CEX → tracked insider — unusual but happens when a team buys back or
      // OTC desk transfers to a known holder. Lean bullish (supply leaving
      // exchange custody into known accumulator). Lighter conviction than
      // team→CEX since the buyer's intent isn't visible.
      direction = 'long';
      exchange = fromLabel.exchange;
      teamFlow = {
        side: 'buy',
        tokenSymbol: toTeam.tokenSymbol,
        holderRank: toTeam.rank,
        holderPercent: toTeam.percent
      };
    } else if (!fromLabel && toLabel?.type === 'cold') {
      // Unlabeled wallet → exchange cold. Almost always the exchange consolidating its
      // OWN (unlabeled) operational wallets into custody — not a real distribution.
      // The single anecdote it was built on (TAG) doesn't survive a 30%-WR sample.
      // Non-directional unless the SENDER is a tracked insider (handled above).
      direction = null;
      exchange = toLabel.exchange;
    } else if (fromLabel?.type === 'cold' && !toLabel) {
      direction = null;                       // cold → unlabeled: usually custody rotation, not "supply leaving market"
      exchange = fromLabel.exchange;
    } else if (fromLabel?.type === 'hot' && (!toLabel || toLabel.exchange !== fromLabel.exchange)) {
      // Hot wallet → external EOA / MEV bot / OTHER exchange's deposit. Bearish
      // LEAN, but only as an aggregated distribution candidate (see flag above) —
      // never an individual signal.
      direction = 'short';
      exchange = fromLabel.exchange;
      isDistribution = true;
    } else if (fromTeam && !toLabel) {
      // Tracked insider → NON-CEX destination. If that destination is a CONTRACT
      // (a DEX pair/router, bridge, staking) the insider is DUMPING ON-CHAIN —
      // the case we used to miss entirely (the $H/PancakeSwap dump). A fresh EOA
      // is staging, already handled above as a derived-team wallet (watched for
      // its own later sell), so we don't fire on that here to avoid wallet-shuffle
      // noise.
      const dexLabel = DEX_CONTRACTS[this.chain]?.[to];
      if (dexLabel || await this.#isContract(to)) {
        direction = 'short';
        exchange = dexLabel ?? 'a DEX/on-chain pool';
        teamFlow = {
          side: 'sell',
          venue: 'dex',
          venueLabel: dexLabel ?? 'a DEX',
          tokenSymbol: fromTeam.tokenSymbol,
          holderRank: fromTeam.rank,
          holderPercent: fromTeam.percent,
          hops: fromTeam.hops ?? 0
        };
      } else {
        return;     // insider → fresh EOA: staging only (derived-team registered above)
      }
    } else {
      return;
    }

    let rawValue;
    try { rawValue = BigInt(log.data); } catch { return; }

    const decimals = await this.#getDecimals(tokenAddr);
    const amount = Number(rawValue) / Number(10n ** BigInt(decimals));

    this.emit('flow', {
      chain: this.chain,
      token: {
        symbol: tokenInfo.symbol,
        coingeckoId: tokenInfo.coingeckoId,
        chain: this.chain,
        address: tokenAddr,
        decimals
      },
      exchange,
      direction,
      fromType: fromLabel?.type ?? (fromTeam ? 'team' : 'external'),
      toType:   toLabel?.type   ?? (toTeam   ? 'team' : 'external'),
      fromName: fromLabel?.name ?? (fromTeam ? `Insider #${fromTeam.rank}` : null),
      toName:   toLabel?.name   ?? (toTeam   ? `Insider #${toTeam.rank}`   : null),
      fromAddress: from,
      toAddress: to,
      teamFlow,
      distribution: isDistribution,    // aggregate-only candidate (hot→external stream)
      amount,
      txHash: log.transactionHash,
      timestamp: Date.now()
    });
  }

  // Is `addr` a contract (has bytecode)? Used to tell a DEX pair/router (insider
  // is dumping on-chain) from a fresh EOA (just staging). Cached per address.
  async #isContract(addr) {
    if (!this._codeCache) this._codeCache = new Map();
    if (this._codeCache.has(addr)) return this._codeCache.get(addr);
    let isC = false;
    try {
      const code = await this.#rpcCall('eth_getCode', [addr, 'latest']);
      isC = typeof code === 'string' && code.length > 4 && code !== '0x' && code !== '0x0';
    } catch { isC = false; }
    if (this._codeCache.size > 5000) this._codeCache.clear();   // bound memory
    this._codeCache.set(addr, isC);
    return isC;
  }

  async #getDecimals(tokenAddr) {
    if (this.decimalsCache.has(tokenAddr)) return this.decimalsCache.get(tokenAddr);

    const cached = this.universe.lookupByAddress(this.chain, tokenAddr)?.chains[this.chain]?.decimals;
    if (cached != null) {
      this.decimalsCache.set(tokenAddr, cached);
      return cached;
    }

    try {
      const result = await this.#rpcCall('eth_call', [{ to: tokenAddr, data: DECIMALS_SELECTOR }, 'latest']);
      const dec = parseInt(result, 16);
      const safe = (!isNaN(dec) && dec >= 0 && dec <= 30) ? dec : 18;
      this.decimalsCache.set(tokenAddr, safe);
      this.universe.setDecimals(this.chain, tokenAddr, safe);
      return safe;
    } catch {
      this.decimalsCache.set(tokenAddr, 18);
      return 18;
    }
  }
}
