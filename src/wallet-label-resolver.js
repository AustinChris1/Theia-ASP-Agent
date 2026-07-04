// Wallet-label resolver: discovers exchange affiliation for an arbitrary
// address by reading the public name tag from the chain explorer.
//
// Solves the recurring "unknown CEX wallet" problem — we ship a static
// `cex-wallets.json`, but exchanges rotate wallets faster than we can
// curate. When an on-chain transfer touches an address we *don't* have
// in the static config, this resolver:
//   1. Reads the explorer page (etherscan / bscscan / solscan) HTML
//   2. Parses the title / public name tag
//   3. Pattern-matches the label to an exchange + hot|cold type
//
// Results are cached on disk (logs/wallet-labels.json) keyed by
// `chain:address-lowercased` so each address is scraped at most once.
// Negative results (no label found) are also cached — with a shorter TTL —
// so we don't hammer explorers on the same external counterparty repeatedly.
//
// Why this matters concretely: a Gate.io 5 → Gate.io 1 internal rotation
// looks like `gateio cold → external` if Gate.io 5 isn't in the static
// config. That misclassification fired a false SHORT on Q (1m FDV ish)
// that promptly stopped out. With auto-labels, both sides resolve to
// gateio.cold → same-exchange / same-type internal flow → SKIPPED.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FETCH_TIMEOUT_MS = 8000;
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60_000;   // 7d — exchanges occasionally reuse/rotate
const NEGATIVE_TTL_MS = 24 * 60 * 60_000;       // 1d — recheck unknown counterparties daily
const MAX_INFLIGHT = 6;                          // global concurrency cap

// Maps explorer host → ISO chain key used by our universe / EVM monitor.
const EXPLORER = {
  ethereum: 'https://etherscan.io/address/',
  bsc:      'https://bscscan.com/address/',
  solana:   'https://solscan.io/account/'
};

// Lowercase substring → canonical exchange slug used in cex-wallets.json.
// Order matters: longer / more specific matches first.
const EXCHANGE_PATTERNS = [
  ['binance.us',     'binance_us'],
  ['binance',        'binance'],
  ['bybit',          'bybit'],
  ['okx',            'okx'],
  ['okex',           'okx'],
  ['kraken',         'kraken'],
  ['bitget',         'bitget'],
  ['gate.io',        'gateio'],
  ['gateio',         'gateio'],
  ['gate ',          'gateio'],
  ['mexc',           'mexc'],
  ['bingx',          'bingx'],
  ['upbit',          'upbit'],
  ['bithumb',        'bithumb'],
  ['coinbase',       'coinbase'],
  ['htx',            'htx'],
  ['huobi',          'htx'],
  ['kucoin',         'kucoin'],
  ['bitfinex',       'bitfinex'],
  ['crypto.com',     'cryptocom'],
  ['bitstamp',       'bitstamp'],
  ['gemini',         'gemini']
];

const COLD_HINTS = ['cold', 'custody', 'reserve', 'treasury', 'vault'];
const HOT_HINTS  = ['hot', 'deposit', 'withdrawal', 'gas', 'sweeper'];

export class WalletLabelResolver {
  constructor({ cachePath, verbose = false }) {
    this.cachePath = cachePath;
    this.verbose = verbose;
    this.cache = new Map();      // key → { result, ts }
    this.pending = new Map();    // key → Promise (in-flight dedup)
    this.inflight = 0;
    this.queue = [];             // pending tasks while we wait for a slot

    if (cachePath) {
      const dir = dirname(cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.#load();
    }
  }

  #load() {
    if (!existsSync(this.cachePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.cachePath, 'utf8'));
      for (const [k, v] of Object.entries(data.entries ?? {})) {
        this.cache.set(k, v);
      }
      if (this.verbose) console.log(`[wallet-labels] loaded ${this.cache.size} cached entries`);
    } catch (err) {
      console.warn(`[wallet-labels] cache load failed: ${err.message}`);
    }
  }

  #save() {
    if (!this.cachePath) return;
    try {
      const obj = { savedAt: Date.now(), entries: Object.fromEntries(this.cache) };
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.warn(`[wallet-labels] cache save failed: ${err.message}`);
    }
  }

  #key(chain, address) {
    return `${chain}:${address.toLowerCase()}`;
  }

  // Returns { exchange, type, name } or null. Never throws. Reads cache
  // immediately when fresh; otherwise schedules a scrape (bounded by
  // MAX_INFLIGHT). Concurrent calls for the same address share the same
  // in-flight promise.
  async resolve(chain, address) {
    if (!chain || !address) return null;
    if (!EXPLORER[chain]) return null;
    const key = this.#key(chain, address);

    const cached = this.cache.get(key);
    if (cached) {
      const age = Date.now() - cached.ts;
      const ttl = cached.result ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      if (age < ttl) return cached.result ?? null;
    }
    if (this.pending.has(key)) return this.pending.get(key);

    const promise = this.#acquireAndFetch(chain, address, key);
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }

  async #acquireAndFetch(chain, address, key) {
    if (this.inflight >= MAX_INFLIGHT) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.inflight++;
    try {
      const result = await this.#fetchLabel(chain, address);
      this.cache.set(key, { result, ts: Date.now() });
      this.#save();
      return result;
    } finally {
      this.inflight--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async #fetchLabel(chain, address) {
    const url = EXPLORER[chain] + address;
    let html;
    try {
      const res = await fetch(url, {
        headers: {
          // Some explorers reject default fetch UA. A vanilla browser UA
          // is the safe default and matches what the Etherscan team explicitly
          // tolerates for non-API HTML access.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        if (this.verbose) console.warn(`[wallet-labels] ${chain} ${address} → HTTP ${res.status}`);
        return null;
      }
      html = await res.text();
    } catch (err) {
      if (this.verbose) console.warn(`[wallet-labels] ${chain} ${address} fetch err: ${err.message}`);
      return null;
    }

    const rawLabel = this.#extractLabel(chain, html);
    if (!rawLabel) return null;
    const classified = this.#classifyLabel(rawLabel);
    if (!classified) {
      if (this.verbose) console.log(`[wallet-labels] ${chain} ${address} label "${rawLabel}" — no matching exchange`);
      return null;
    }
    if (this.verbose) {
      console.log(`[wallet-labels] ${chain} ${address} → ${classified.exchange} ${classified.type} (${classified.name})`);
    }
    return classified;
  }

  // Per-explorer HTML parsing. Defensive: try multiple patterns, the
  // explorers change their markup periodically.
  #extractLabel(chain, html) {
    // Etherscan-family (etherscan, bscscan). Reliable signal: the <title>
    // tag is pre-rendered server-side and contains the public name tag.
    //
    // Labelled address title:
    //   "Binance 14 | Address: 0x28C6c062...43bf21d60 | Etherscan"
    // Unlabelled address title:
    //   "Address 0x... | Etherscan"   (no leading label)
    // ENS / contract title:
    //   "vitalik.eth | Address: 0xd8dA6BF2...37aA96045 | Etherscan"
    //
    // We extract the part before " | Address: 0x...". That part can still be
    // junk (ENS name, contract name), but #classifyLabel filters anything
    // that doesn't pattern-match a known exchange.
    if (chain === 'ethereum' || chain === 'bsc') {
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        const t = titleMatch[1].replace(/\s+/g, ' ').trim();
        // " | Address: 0xPREFIX...SUFFIX | Etherscan"  → split on " | Address:"
        const m = t.match(/^(.+?)\s*\|\s*Address:\s*0x[a-fA-F0-9]+\.\.\.[a-fA-F0-9]+\s*\|/i);
        if (m) {
          const label = m[1].trim();
          // The "no-label" path renders title as "Address 0x.. | Etherscan"
          // which won't match the above regex (no leading label segment),
          // so a successful match here means a real public name tag.
          return label;
        }
      }
      // Secondary pattern: the tooltip embedded on the heading also carries
      // the name tag. Useful when the title format changes again.
      //   title='Public Name Tag (viewable by anyone) <br/> Binance 14&#10;(0x...)'
      const tipMatch = html.match(/Public Name Tag[^']*?<br\/>\s*([^&<]+)&#10;/i);
      if (tipMatch) return tipMatch[1].trim();
      return null;
    }

    // Solscan: uses og:title meta tag or labels via Next.js page data.
    //   <meta property="og:title" content="X | Solscan" />
    //   <meta name="description" content="Account: 5tz... Binance Hot Wallet ..."/>
    if (chain === 'solana') {
      const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
      if (og) {
        const t = og[1].trim();
        // Strip trailing "| Solscan" if present
        const cleaned = t.replace(/\s*\|\s*solscan.*$/i, '').trim();
        if (cleaned && !cleaned.toLowerCase().startsWith('account')) return cleaned;
      }
      // Some pages embed labels in a `<div class="card-header">Label</div>` block
      const dm = html.match(/data-name="([^"]{1,80})"/i);
      if (dm) return dm[1].trim();
      return null;
    }

    return null;
  }

  // Map free-form name tag → { exchange, type, name }. Returns null when
  // no exchange pattern matches — we don't want to fabricate affiliations.
  #classifyLabel(rawLabel) {
    const lower = rawLabel.toLowerCase();
    let exchange = null;
    for (const [substr, slug] of EXCHANGE_PATTERNS) {
      if (lower.includes(substr)) { exchange = slug; break; }
    }
    if (!exchange) return null;

    // type inference: cold hints > hot hints > default "hot"
    // (deposit / numbered operational wallets are effectively hot)
    let type = 'hot';
    if (COLD_HINTS.some(h => lower.includes(h))) type = 'cold';
    else if (HOT_HINTS.some(h => lower.includes(h))) type = 'hot';

    return { exchange, type, name: rawLabel };
  }
}
