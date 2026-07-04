import { EventEmitter } from 'node:events';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Polling-based Solana monitor using raw fetch + public RPC failover.
// Token info is resolved against the CoinGecko-built universe (mint → tokenInfo).
// Decimals come for free from preTokenBalances/postTokenBalances.
export class SolanaMonitor extends EventEmitter {
  constructor({ rpcs, pollIntervalMs = 25_000, walletsForChain, universe, labelResolver = null, verbose = false }) {
    super();
    this.rpcs = rpcs;
    this.rpcIndex = 0;
    this.pollIntervalMs = pollIntervalMs;
    this.universe = universe;
    this.labelResolver = labelResolver;
    this.verbose = verbose;
    this.walletIndex = this.#buildWalletIndex(walletsForChain);
    this.lastSigByWallet = new Map();
    this.intervalId = null;
    // Cross-poll dedup of processed signatures (10 min TTL). Same rationale
    // as EVM monitor — overlapping polls or RPC quirks can hand us the same
    // signature twice; this guarantees one emission per tx.
    this.processedSigs = new Map();
    this.processedSigsGcAt = 0;
    this.pollInFlight = false;
  }

  #buildWalletIndex(walletsForChain) {
    const index = new Map();
    if (!walletsForChain) return index;
    for (const [exchange, sides] of Object.entries(walletsForChain)) {
      const names = sides.names ?? {};
      for (const [type, addrs] of Object.entries(sides)) {
        if (type === 'names') continue;            // names is metadata, not a wallet type
        if (!Array.isArray(addrs)) continue;
        for (const addr of addrs) {
          // Solana addresses are case-sensitive (base58), so the lookup key in
          // `names` must be the address as-written. Use addr directly.
          index.set(addr, { exchange, type, name: names[addr] ?? null });
        }
      }
    }
    return index;
  }

  get chain() { return 'solana'; }
  get rpcUrl() { return this.rpcs[this.rpcIndex % this.rpcs.length]; }
  #switchRpc(reason) {
    this.rpcIndex++;
    if (this.verbose) console.warn(`[solana] switching RPC → ${this.rpcUrl} (${reason})`);
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
        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            this.#switchRpc(`HTTP ${res.status}`);
            await sleep(300);
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
        return data.result;
      } catch (err) {
        lastErr = err;
        this.#switchRpc(err.message);
        await sleep(300);
      }
    }
    throw lastErr ?? new Error('all Solana RPCs failed');
  }

  async start() {
    if (this.walletIndex.size === 0) {
      console.warn(`[solana] no labeled wallets — skipping`);
      return;
    }
    for (const wallet of this.walletIndex.keys()) {
      try {
        // Fetch the recent history (not just the latest) and mark ALL of
        // these signatures as "already processed". publicnode's Solana RPC
        // sometimes ignores the `until` param on subsequent polls and re-
        // hands us the same window — without preload we'd emit historical
        // flows on the first real #poll(). Preload guarantees only NEW
        // signatures past startup get processed.
        const sigs = await this.#rpcCall('getSignaturesForAddress', [wallet, { limit: 25 }]);
        if (sigs?.length) {
          this.lastSigByWallet.set(wallet, sigs[0].signature);
          const now = Date.now();
          for (const { signature } of sigs) this.processedSigs.set(signature, now);
        }
      } catch (err) {
        console.warn(`[solana] init ${wallet.slice(0, 8)} failed: ${err.message}`);
      }
      await sleep(300);
    }
    console.log(`[solana] polling ${this.walletIndex.size} wallets every ${this.pollIntervalMs/1000}s via ${this.rpcUrl}`);

    this.intervalId = setInterval(() => {
      if (this.pollInFlight) {
        if (this.verbose) console.warn(`[solana] previous poll still running, skipping tick`);
        return;
      }
      this.pollInFlight = true;
      this.#poll()
        .catch(err => console.error('[solana] poll cycle error:', err.message))
        .finally(() => { this.pollInFlight = false; });
    }, this.pollIntervalMs);
  }

  #gcProcessedSigs() {
    const now = Date.now();
    if (now - this.processedSigsGcAt < 60_000) return;
    // 1-hour TTL — much longer than poll interval, prevents re-emission of
    // sigs that RPC keeps re-handing us. Map size stays bounded because
    // Solana sig count per wallet is small (we fetch up to 25 per poll).
    const cutoff = now - 60 * 60_000;
    for (const [k, ts] of this.processedSigs) {
      if (ts < cutoff) this.processedSigs.delete(k);
    }
    this.processedSigsGcAt = now;
  }

  async #poll() {
    for (const wallet of this.walletIndex.keys()) {
      try {
        const until = this.lastSigByWallet.get(wallet);
        const sigs = await this.#rpcCall('getSignaturesForAddress', [wallet, { limit: 25, until }]);
        if (!sigs?.length) continue;
        this.lastSigByWallet.set(wallet, sigs[0].signature);
        for (const { signature } of [...sigs].reverse()) {
          if (this.processedSigs.has(signature)) continue;
          this.processedSigs.set(signature, Date.now());
          await this.#processTx(signature);
        }
      } catch (err) {
        if (this.verbose) console.warn(`[solana] poll ${wallet.slice(0, 8)}: ${err.message}`);
      }
      await sleep(150);
    }
    this.#gcProcessedSigs();
  }

  async #processTx(signature) {
    let tx;
    try {
      tx = await this.#rpcCall('getTransaction', [signature, {
        maxSupportedTransactionVersion: 0,
        encoding: 'jsonParsed',
        commitment: 'confirmed'
      }]);
    } catch (err) {
      if (this.verbose) console.warn(`[solana] tx ${signature.slice(0, 10)}: ${err.message}`);
      return;
    }
    if (!tx?.meta || tx.meta.err) return;

    // Age filter — refuse to emit flows for transactions older than 10
    // minutes. Solana RPCs (especially publicnode.com) sometimes hand back
    // signatures from much further back; the blockTime check guarantees we
    // only emit truly fresh on-chain activity regardless of RPC quirks.
    if (tx.blockTime) {
      const ageSec = (Date.now() / 1000) - tx.blockTime;
      if (ageSec > 600) {
        if (this.verbose) console.log(`[solana] skip stale ${signature.slice(0, 8)} (${Math.round(ageSec / 60)}m old)`);
        return;
      }
    }

    const pre = tx.meta.preTokenBalances ?? [];
    const post = tx.meta.postTokenBalances ?? [];
    const balances = new Map();
    const keyOf = (owner, mint) => `${owner}|${mint}`;

    for (const b of pre) {
      if (!b.owner || !b.mint) continue;
      const k = keyOf(b.owner, b.mint);
      const e = balances.get(k) ?? { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount.decimals, preAmt: 0, postAmt: 0 };
      e.preAmt = Number(b.uiTokenAmount.uiAmountString ?? 0);
      balances.set(k, e);
    }
    for (const b of post) {
      if (!b.owner || !b.mint) continue;
      const k = keyOf(b.owner, b.mint);
      const e = balances.get(k) ?? { owner: b.owner, mint: b.mint, decimals: b.uiTokenAmount.decimals, preAmt: 0, postAmt: 0 };
      e.postAmt = Number(b.uiTokenAmount.uiAmountString ?? 0);
      balances.set(k, e);
    }

    const deltas = [];
    for (const e of balances.values()) {
      const delta = e.postAmt - e.preAmt;
      if (Math.abs(delta) < 0.000001) continue;
      const tokenInfo = this.universe.lookupByAddress('solana', e.mint);
      if (!tokenInfo) continue;
      const label = this.walletIndex.get(e.owner);
      deltas.push({ owner: e.owner, mint: e.mint, delta, label, tokenInfo, decimals: e.decimals });
    }
    if (deltas.length === 0) return;

    for (const send of deltas.filter(d => d.delta < 0 && d.label)) {
      for (const recv of deltas.filter(d => d.delta > 0 && d.label && d.mint === send.mint && d.owner !== send.owner)) {
        if (send.label.exchange !== recv.label.exchange) continue;
        // Same-exchange hot↔cold is custody/treasury rebalancing, NOT accumulation/
        // distribution — no directional edge (same fix as the EVM path). The Solana
        // monitor has no insider/team labels, so every flow here is exchange-internal:
        // emit it as non-directional (informational), never a tradeable LONG/SHORT.
        const direction = null;
        const amount = Math.min(Math.abs(send.delta), recv.delta);
        this.emit('flow', {
          chain: 'solana',
          token: {
            symbol: send.tokenInfo.symbol,
            coingeckoId: send.tokenInfo.coingeckoId,
            chain: 'solana',
            address: send.mint,
            decimals: send.decimals
          },
          exchange: send.label.exchange,
          direction,
          fromType: send.label.type,
          toType: recv.label.type,
          fromName: send.label.name ?? null,
          toName: recv.label.name ?? null,
          amount,
          txHash: signature,
          timestamp: Date.now()
        });
      }
    }
  }
}
