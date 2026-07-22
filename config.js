
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

export const X_LAYER = {
  chainId: 196,
  network: 'eip155:196',
  name: 'X Layer',
  rpcUrl: str('X_LAYER_RPC_URL', 'https://rpc.xlayer.tech'),
};

export const SKILL_PRICES_USDT = {
  theia_signal: str('PRICE_SIGNAL', '0.05'),
  theia_manipulation_check: str('PRICE_MANIPULATION', '0.05'),
  theia_cex_flow: str('PRICE_CEX_FLOW', '0.05'),
  theia_insider_scan: str('PRICE_INSIDER', '0.05'),
  theia_liqmap: str('PRICE_LIQMAP', '0.05'),
  theia_cex_holdings: str('PRICE_CEX_HOLDINGS', '0.02'),
};

export const config = {
  server: {
    port: num('PORT', 8402),
    publicUrl: str('ASP_PUBLIC_URL', 'http://localhost:8402'),
    name: str('ASP_NAME', 'Theia'),
  },

  x402: {
    payTo: str('X402_PAY_TO', null),
    scheme: str('X402_SCHEME', 'exact'),
    network: X_LAYER.network,
    chainId: X_LAYER.chainId,

    assets: {
      USDT: {
        address: str('X402_ASSET_USDT_ADDRESS', null),
        decimals: num('X402_ASSET_USDT_DECIMALS', 6),
        symbol: 'USDT',
        name: 'Tether USD',
        eip712Name: str('X402_ASSET_USDT_EIP712_NAME', 'USDT'),
        eip712Version: str('X402_ASSET_USDT_EIP712_VERSION', '1'),
      },
    },
    defaultAsset: str('X402_DEFAULT_ASSET', 'USDT'),

    facilitatorUrl: str('X402_FACILITATOR_URL', null),
    facilitatorAuth: {
      apiKey: str('X402_FACILITATOR_API_KEY', null),
      secretKey: str('X402_FACILITATOR_API_SECRET', null),
      passphrase: str('X402_FACILITATOR_API_PASSPHRASE', null),
      projectId: str('X402_FACILITATOR_PROJECT_ID', null),
    },
    prices: SKILL_PRICES_USDT,
    enforce: bool('X402_ENFORCE', false),
  },

  engine: {

    enableOkxMarketData: bool('ASP_ENABLE_OKX_MARKET_DATA', true),
    okxBaseUrl: str('OKX_BASE_URL', null),
    coinalyzeApiKey: str('COINALYZE_API_KEY', null),
    coinalyzeApiKeyLiq: str('COINALYZE_API_KEY_LIQ', null),
    moralisApiKey: str('MORALIS_API_KEY', null),
    relayBaseUrl: (str('RELAY_BASE_URL') || '').replace(/\/$/, '') || null,
    relayAuthSecret: str('RELAY_AUTH_SECRET', null),
    universeTopN: num('ASP_UNIVERSE_TOP_N', 300),
    universeVolumeTopN: num('ASP_UNIVERSE_VOLUME_TOP_N', 200),
    enableTeamDiscovery: bool('ASP_ENABLE_TEAM_DISCOVERY', true),
    teamDiscoveryMaxTokens: num('ASP_TEAM_MAX_TOKENS', 100),
    verbose: bool('ASP_VERBOSE', false),
  },

  reputation: {
    enabled: bool('REPUTATION_LEDGER_ENABLED', false),
    sink: str('REPUTATION_SINK', 'calldata'),
    contractAddress: str('REPUTATION_CONTRACT', null),
    signalsPath: str('REPUTATION_SIGNALS_PATH', resolve(__dirname, 'logs/signals.jsonl')),
  },
};

export function activeAsset() {
  const a = config.x402.assets[config.x402.defaultAsset];
  if (!a) throw new Error(`Unknown X402_DEFAULT_ASSET: ${config.x402.defaultAsset}`);
  return a;
}

export function x402Ready() {
  const a = config.x402.assets[config.x402.defaultAsset];
  return Boolean(config.x402.enforce && config.x402.payTo && a?.address);
}

export default config;
