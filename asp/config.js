// asp/config.js — FRESH configuration for the Theia ASP layer.
//
// This reads ONLY from asp/.env (never the bot's root .env), so the ASP runtime
// never touches the Telegram bot's secrets, the autotrade vault, or its billing
// seed. Market-data keys here are read-only data keys (Coinalyze / Moralis / the
// Singapore relay) that the intelligence engine needs to produce real reads.
//
// The wallet that receives x402 payments and signs on-chain reputation writes is
// held by the `onchainos` CLI / TEE, NOT here. We only need its public address as
// the x402 `payTo`.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load asp/.env explicitly. `override:false` means a value already exported in
// the real environment (e.g. on Render) wins over the file, which is what we want
// in production. We deliberately do NOT call dotenv on the repo-root .env.
loadEnv({ path: resolve(__dirname, '.env'), override: false });

const num = (key, dflt) => {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const str = (key, dflt = null) => {
  const v = process.env[key];
  return v === undefined || v === '' ? dflt : v;
};
const bool = (key, dflt = false) => {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  return v === '1' || v.toLowerCase() === 'true';
};

// X Layer is OKX's settlement chain for both x402 and ERC-8004 identity/escrow.
export const X_LAYER = {
  chainId: 196,
  network: 'eip155:196', // CAIP-2, used in x402 `accepts[].network`
  name: 'X Layer',
  rpcUrl: str('X_LAYER_RPC_URL', 'https://rpc.xlayer.tech'),
};

// The six A2MCP skills and their fixed per-call price in USDT. Cheap flat pricing
// ($0.02 to $0.10) to encourage volume (Revenue Rocket). These are the human,
// decimal prices; the x402 layer converts to base units using the asset decimals.
export const SKILL_PRICES_USDT = {
  theia_signal: str('PRICE_SIGNAL', '0.10'),
  theia_manipulation_check: str('PRICE_MANIPULATION', '0.05'),
  theia_cex_flow: str('PRICE_CEX_FLOW', '0.05'),
  theia_insider_scan: str('PRICE_INSIDER', '0.05'),
  theia_liqmap: str('PRICE_LIQMAP', '0.05'),
  theia_cex_holdings: str('PRICE_CEX_HOLDINGS', '0.02'),
};

export const config = {
  // ── Server ────────────────────────────────────────────────────────────────
  server: {
    port: num('PORT', 8402),
    // Public HTTPS base URL, permanent on-chain once registered as the A2MCP
    // endpoint. Set this to the Render URL before registering. Used to build the
    // service manifest and x402 `resource` fields.
    publicUrl: str('ASP_PUBLIC_URL', 'http://localhost:8402'),
    name: str('ASP_NAME', 'Theia'),
  },

  // ── x402 (seller side) ──────────────────────────────────────────────────────
  x402: {
    // Wallet that receives per-call payments (our Agentic Wallet address on X Layer).
    payTo: str('X402_PAY_TO', null),
    // Scheme: `exact` is the simple settle-now default (EIP-3009). See NOTES-okx §3.
    scheme: str('X402_SCHEME', 'exact'),
    network: X_LAYER.network,
    chainId: X_LAYER.chainId,
    // Settlement assets on X Layer. [OPEN] confirm the canonical contract
    // addresses via `onchainos wallet chains` / an okx-dex-token lookup before
    // go-live; both USDT and USDG are supported by OKX's own x402 endpoints.
    assets: {
      USDT: {
        address: str('X402_ASSET_USDT_ADDRESS', null),
        decimals: num('X402_ASSET_USDT_DECIMALS', 6),
        symbol: 'USDT',
        name: 'Tether USD',
        eip712Name: str('X402_ASSET_USDT_EIP712_NAME', 'USDT'),
        eip712Version: str('X402_ASSET_USDT_EIP712_VERSION', '1'),
      },
      USDG: {
        address: str('X402_ASSET_USDG_ADDRESS', null),
        decimals: num('X402_ASSET_USDG_DECIMALS', 6),
        symbol: 'USDG',
        name: 'Global Dollar',
        eip712Name: str('X402_ASSET_USDG_EIP712_NAME', 'USDG'),
        eip712Version: str('X402_ASSET_USDG_EIP712_VERSION', '1'),
      },
    },
    // Default asset a caller pays in unless we expose a picker.
    defaultAsset: str('X402_DEFAULT_ASSET', 'USDT'),
    // Facilitator that verifies + settles the signed authorization on-chain.
    // [OPEN] the exact OKX facilitator base URL for X Layer resource servers.
    // Config-driven so we can point it at OKX's facilitator once confirmed via
    // `onchainos agent x402-check`. Empty => x402-express uses its default.
    facilitatorUrl: str('X402_FACILITATOR_URL', null),
    prices: SKILL_PRICES_USDT,
    // Master switch. When off (no payTo/facilitator yet), routes serve free so we
    // can develop and demo the engine before wiring live settlement.
    enforce: bool('X402_ENFORCE', false),
  },

  // ── OKX identity / listing (informational; the onchainos CLI owns the writes) ──
  okx: {
    agentId: str('OKX_ASP_AGENT_ID', null), // filled after registration
    ownerEmail: str('OKX_OWNER_EMAIL', null),
  },

  // ── Engine data sources (read-only market-data keys; fresh, never the bot's) ──
  engine: {
    // Coinalyze powers multi-TF TA, funding/OI fallback, and liquidation data.
    // Without it, signal quality degrades to price-only (skills say so explicitly).
    coinalyzeApiKey: str('COINALYZE_API_KEY', null),
    coinalyzeApiKeyLiq: str('COINALYZE_API_KEY_LIQ', null),
    // Moralis powers insider/holder discovery (works from datacenter IPs).
    moralisApiKey: str('MORALIS_API_KEY', null),
    // Singapore relay for Binance/Bybit data + klines when the host IP is
    // geo-blocked (same convention as the bot). Optional but recommended.
    relayBaseUrl: (str('RELAY_BASE_URL') || str('BYBIT_BASE_URL') || '').replace(/\/$/, '') || null,
    relayAuthSecret: str('BYBIT_PROXY_SECRET', null),
    // Universe sizing — smaller than the bot's since the ASP is on-demand.
    universeTopN: num('ASP_UNIVERSE_TOP_N', 300),
    universeVolumeTopN: num('ASP_UNIVERSE_VOLUME_TOP_N', 200),
    // Toggles for heavy subsystems (all degrade gracefully when off/missing).
    enableBinanceFutures: bool('ASP_ENABLE_BINANCE_FUTURES', true),
    enableTeamDiscovery: bool('ASP_ENABLE_TEAM_DISCOVERY', true),
    teamDiscoveryMaxTokens: num('ASP_TEAM_MAX_TOKENS', 100),
    verbose: bool('ASP_VERBOSE', false),
  },

  // ── Reputation ledger (publish REAL resolved outcomes to X Layer) ─────────────
  reputation: {
    enabled: bool('REPUTATION_LEDGER_ENABLED', false),
    // Where resolved-signal hashes are anchored. `calldata` = self-send tx memo;
    // `contract` = a tiny append-only log contract. Decided at build/deploy.
    sink: str('REPUTATION_SINK', 'calldata'),
    contractAddress: str('REPUTATION_CONTRACT', null),
    // Path to the signal-tracker journal the ledger reads real outcomes from.
    signalsPath: str('REPUTATION_SIGNALS_PATH', resolve(__dirname, '../logs/signals.jsonl')),
  },
};

// Resolve the active x402 asset config (the one callers pay in by default).
export function activeAsset() {
  const a = config.x402.assets[config.x402.defaultAsset];
  if (!a) throw new Error(`Unknown X402_DEFAULT_ASSET: ${config.x402.defaultAsset}`);
  return a;
}

// True when the x402 layer has everything it needs to actually settle payments.
export function x402Ready() {
  const a = config.x402.assets[config.x402.defaultAsset];
  return Boolean(config.x402.enforce && config.x402.payTo && a?.address);
}

export default config;
