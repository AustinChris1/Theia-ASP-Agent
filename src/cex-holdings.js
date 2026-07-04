// Snapshot ERC20 balances held by labeled CEX cold wallets for a given token.
//
// Why "cold-only": hot wallets are constantly churning user deposits/withdrawals
// — their balance is noise. A cold-wallet balance reflects what the exchange
// is *deliberately holding off-market*. A rising cold balance over time is
// distribution pressure latent in the system; a draining cold balance often
// precedes a price move.
//
// Strategy:
//   • For each chain (ETH, BSC), call ERC20.balanceOf(coldWallet) for every
//     labeled cold address via eth_call → aggregated per exchange.
//   • Multi-RPC failover (same pool as on-chain monitor).
//   • Short TTL cache (5 min) so repeated /analyze calls don't hammer RPCs.

const BALANCE_OF_SELECTOR = '0x70a08231';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Multicall3 (same address on ETH/BSC/Base) ───────────────────────────────
// Batches hundreds of balanceOf/decimals reads into ONE eth_call, so the per-CEX
// holdings leaderboard costs ~a dozen RPC calls instead of thousands. Hand-rolled
// ABI codec (no ethers dependency) — verified against live mainnet balances.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BAL_SEL = '70a08231';        // balanceOf(address)
const DEC_SEL = '313ce567';        // decimals()
const pad64 = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// aggregate3((address target,bool allowFailure,bytes callData)[]) — selector 82ad56cb.
// `calls`: [{ target, callData }] (callData = hex, no 0x). Variable-length callData ok.
function encodeAggregate3(calls) {
  const N = calls.length;
  const tuples = calls.map(c => {
    const cd = c.callData;
    const padded = cd.padEnd(Math.ceil(cd.length / 64) * 64, '0');
    return pad64(c.target) + word(1) + word(0x60) + word(cd.length / 2) + padded;
  });
  let heads = '', tails = '', cursor = 32 * N;   // element-head region is N words
  for (const t of tuples) { heads += word(cursor); cursor += t.length / 2; tails += t; }
  return '0x82ad56cb' + word(0x20) + word(N) + heads + tails;
}

// Decode aggregate3 return (bool success, bytes returnData)[] → [{ success, value:BigInt }].
function decodeAggregate3(hex) {
  const d = (hex ?? '').replace(/^0x/, '');
  if (d.length < 128) return [];
  const rw = (b) => d.slice(b * 2, b * 2 + 64);
  const arrOff = Number(BigInt('0x' + rw(0)));
  const N = Number(BigInt('0x' + rw(arrOff)));
  const headBase = arrOff + 32, out = [];
  for (let i = 0; i < N; i++) {
    const t = headBase + Number(BigInt('0x' + rw(headBase + i * 32)));
    const success = BigInt('0x' + rw(t)) !== 0n;
    const len = Number(BigInt('0x' + rw(t + 64)));
    out.push({ success, value: (success && len >= 32) ? BigInt('0x' + rw(t + 96)) : 0n });
  }
  return out;
}

export class CexHoldings {
  constructor({ rpcsByChain, walletsByChain, cacheTtlMs = 5 * 60_000 }) {
    this.rpcsByChain = rpcsByChain;             // { ethereum: [...], bsc: [...] }
    this.rpcIndexByChain = { ethereum: 0, bsc: 0 };
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();                     // `${chain}|${tokenAddr}` → { ts, result }

    // Cold wallets now come from the unified `evm` set (same addresses across all
    // EVM chains). We still query per chain, using the token's per-chain contract
    // address, so a cold wallet's balance is read on whichever chain the token lives.
    this.coldByChain = { ethereum: [], bsc: [] };
    const evmWallets = walletsByChain?.evm ?? {};
    for (const [exchange, sides] of Object.entries(evmWallets)) {
      for (const addr of (sides.cold ?? [])) {
        const entry = { exchange, address: addr.toLowerCase() };
        this.coldByChain.ethereum.push(entry);
        this.coldByChain.bsc.push(entry);
      }
    }

    // Per-CEX top-holdings leaderboard (computed by a background job, cached here +
    // in Neon). decimalsCache avoids re-reading a token's decimals every refresh.
    this.leaderboard = null;                    // { computedAt, byExchange: { binance:[{symbol,cgId,amount,usd,pctSupply}], ... } }
    this.decimalsCache = new Map();             // `${chain}|${addr}` → decimals
  }

  getLeaderboard() { return this.leaderboard; }
  setLeaderboard(lb) { if (lb && lb.byExchange) this.leaderboard = lb; }

  #rpcUrl(chain) {
    const pool = this.rpcsByChain[chain] ?? [];
    return pool[this.rpcIndexByChain[chain] % pool.length];
  }

  #rotate(chain) {
    this.rpcIndexByChain[chain]++;
  }

  async #ethCall(chain, to, data) {
    const pool = this.rpcsByChain[chain] ?? [];
    let lastErr;
    for (let i = 0; i < pool.length * 2; i++) {
      try {
        const res = await fetch(this.#rpcUrl(chain), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to, data }, 'latest'], id: 1
          }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message ?? 'rpc error');
        return json.result;
      } catch (err) {
        lastErr = err;
        this.#rotate(chain);
        await sleep(200);
      }
    }
    throw lastErr ?? new Error('all RPCs failed');
  }

  // Aggregate cold-wallet balances per exchange for a token on a given chain.
  // Returns: [{ exchange, balance, walletCount }, ...] sorted by balance desc.
  async #balancesForChain(chain, tokenAddr, decimals) {
    const wallets = this.coldByChain[chain] ?? [];
    if (wallets.length === 0) return [];

    const paramData = (wallet) =>
      BALANCE_OF_SELECTOR + '0'.repeat(24) + wallet.slice(2).toLowerCase();

    const perExchange = new Map();
    for (const w of wallets) {
      let raw;
      try {
        raw = await this.#ethCall(chain, tokenAddr, paramData(w.address));
      } catch {
        continue;
      }
      if (!raw || raw === '0x') continue;
      let value;
      try { value = BigInt(raw); } catch { continue; }
      if (value === 0n) continue;

      const amount = Number(value) / Number(10n ** BigInt(decimals));
      const entry = perExchange.get(w.exchange) ?? { exchange: w.exchange, balance: 0, walletCount: 0 };
      entry.balance += amount;
      entry.walletCount++;
      perExchange.set(w.exchange, entry);
    }

    return [...perExchange.values()].sort((a, b) => b.balance - a.balance);
  }

  // Snapshot every chain we know about for a token. Returns:
  //   {
  //     ethereum: [{exchange, balance, walletCount}, ...],
  //     bsc:      [...],
  //     totalUsd: number,
  //     totalBalance: number,
  //     pctOfSupply: number|null
  //   }
  async snapshot({ tokenInfo, price, circulatingSupply }) {
    const cacheKey = `${tokenInfo.coingeckoId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.result;

    const out = { ethereum: [], bsc: [], totalUsd: 0, totalBalance: 0, pctOfSupply: null };

    for (const chain of ['ethereum', 'bsc']) {
      const chainInfo = tokenInfo.chains?.[chain];
      if (!chainInfo?.address) continue;
      const decimals = chainInfo.decimals ?? 18;
      try {
        out[chain] = await this.#balancesForChain(chain, chainInfo.address.toLowerCase(), decimals);
      } catch (err) {
        console.warn(`[holdings] ${chain} ${tokenInfo.symbol} failed: ${err.message}`);
      }
    }

    for (const chain of ['ethereum', 'bsc']) {
      for (const e of out[chain]) {
        out.totalBalance += e.balance;
        if (price) out.totalUsd += e.balance * price;
      }
    }
    if (circulatingSupply && out.totalBalance > 0) {
      out.pctOfSupply = (out.totalBalance / circulatingSupply) * 100;
    }

    this.cache.set(cacheKey, { ts: Date.now(), result: out });
    return out;
  }

  // Batch balanceOf/decimals reads via Multicall3 → array of BigInt values aligned
  // with `calls` ({target, callData}). Chunked so one huge eth_call can't time out.
  async #multicall(chain, calls, chunkSize = 300) {
    const out = new Array(calls.length).fill(0n);
    for (let i = 0; i < calls.length; i += chunkSize) {
      const chunk = calls.slice(i, i + chunkSize);
      let raw;
      try { raw = await this.#ethCall(chain, MULTICALL3, encodeAggregate3(chunk)); }
      catch (err) { console.warn(`[holdings-lb] ${chain} multicall chunk failed: ${err.message}`); continue; }
      const dec = decodeAggregate3(raw);
      for (let j = 0; j < chunk.length; j++) out[i + j] = dec[j]?.value ?? 0n;
    }
    return out;
  }

  // Resolve decimals for a set of token contracts on a chain (cache-first, then a
  // single multicall for the unknowns). Correct decimals matter for %-of-supply.
  async #resolveDecimals(chain, tokens) {
    const need = [];
    for (const t of tokens) {
      const addr = t.chains?.[chain]?.address?.toLowerCase();
      if (!addr) continue;
      const key = `${chain}|${addr}`;
      if (this.decimalsCache.has(key)) continue;
      const known = t.chains?.[chain]?.decimals;
      if (Number.isInteger(known)) { this.decimalsCache.set(key, known); continue; }
      need.push({ key, target: addr });
    }
    if (need.length) {
      const vals = await this.#multicall(chain, need.map(n => ({ target: n.target, callData: DEC_SEL })));
      for (let i = 0; i < need.length; i++) {
        const d = Number(vals[i]);
        this.decimalsCache.set(need[i].key, (d >= 0 && d <= 36) ? d : 18);   // sane fallback
      }
    }
  }

  // Compute the per-CEX holdings leaderboard over a bounded token set. Ranks each
  // exchange's tokens by % of circulating supply held (the actionable "cornered
  // float" view, not USD which is just BTC/ETH/stables). Returns { computedAt,
  // byExchange }. tokens: [{ cgId, symbol, chains, circulatingSupply, price }].
  async computeLeaderboard({ tokens, topN = 20, chunkSize = 300 }) {
    const perEx = new Map();                    // exchange → Map(cgId → { amount, token })
    for (const chain of ['ethereum', 'bsc']) {
      const cold = this.coldByChain[chain] ?? [];
      if (!cold.length) continue;
      const onChain = tokens.filter(t => t.chains?.[chain]?.address);
      if (!onChain.length) continue;
      await this.#resolveDecimals(chain, onChain);
      const pairs = [];
      for (const t of onChain) {
        const addr = t.chains[chain].address.toLowerCase();
        const decimals = this.decimalsCache.get(`${chain}|${addr}`) ?? 18;
        for (const w of cold) pairs.push({ target: addr, callData: BAL_SEL + pad64(w.address), exchange: w.exchange, token: t, decimals });
      }
      const balances = await this.#multicall(chain, pairs.map(p => ({ target: p.target, callData: p.callData })), chunkSize);
      for (let i = 0; i < pairs.length; i++) {
        const bal = balances[i];
        if (!bal || bal === 0n) continue;
        const p = pairs[i];
        const amount = Number(bal) / Number(10n ** BigInt(p.decimals));
        if (!(amount > 0)) continue;
        let exMap = perEx.get(p.exchange);
        if (!exMap) { exMap = new Map(); perEx.set(p.exchange, exMap); }
        const cur = exMap.get(p.token.cgId) ?? { amount: 0, token: p.token };
        cur.amount += amount;
        exMap.set(p.token.cgId, cur);
      }
    }
    const byExchange = {};
    for (const [exchange, exMap] of perEx) {
      const rows = [];
      for (const { amount, token } of exMap.values()) {
        const circ = token.circulatingSupply;
        const pctSupply = circ > 0 ? (amount / circ) * 100 : null;
        const usd = token.price ? amount * token.price : null;
        // Drop obvious bad reads (a wrong-decimals token can show >100% of supply).
        if (pctSupply != null && pctSupply > 100.5) continue;
        rows.push({ symbol: token.symbol, cgId: token.cgId, amount, usd, pctSupply });
      }
      rows.sort((a, b) => (b.pctSupply ?? -1) - (a.pctSupply ?? -1));
      byExchange[exchange] = rows.slice(0, topN);
    }
    const lb = { computedAt: Date.now(), byExchange };
    this.leaderboard = lb;
    return lb;
  }
}
