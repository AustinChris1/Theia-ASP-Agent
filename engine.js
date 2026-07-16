

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Universe } from './src/universe.js';
import { PriceMonitor } from './src/prices.js';
import { FundingMonitor } from './src/funding.js';
import { CoinalyzeClient, buildPerpSymbolMap } from './src/coinalyze.js';
import { TAService } from './src/ta.js';
import { LiquidationHeatmap } from './src/liquidation-heatmap.js';
import { LiquidityClusters } from './src/liquidity-clusters.js';
import { TeamWalletDiscovery } from './src/team-wallet-discovery.js';
import { RegimeMonitor } from './src/regime.js';
import { CexHoldings } from './src/cex-holdings.js';
import { Conductor } from './src/conductor.js';
import { SignalTracker } from './src/signal-tracker.js';
import { OkxClient } from './src/okx.js';

import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, 'src');
const loadJson = (rel) => JSON.parse(readFileSync(resolve(srcDir, rel), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[asp-engine] ${msg}`);
const warn = (msg) => console.warn(`[asp-engine] ${msg}`);

let _engine = null;

export async function bootEngine() {
  if (_engine) return _engine;
  if (bootEngine._inflight) return bootEngine._inflight;
  bootEngine._inflight = _boot().then((e) => { _engine = e; return e; });
  return bootEngine._inflight;
}

async function _boot() {
  const ec = config.engine;
  const status = {
    universe: false, prices: false, funding: null, ta: false,
    heatmap: false, clusters: false, teamDiscovery: false, cexHoldings: false,
    startedAt: Date.now(),
  };

  const allWallets = loadJson('./config/cex-wallets.json');
  const rpcs = loadJson('./config/rpcs.json');
  const pinned = loadJson('./config/tokens.json');

  const universe = new Universe({
    topN: ec.universeTopN,
    topByVolume: ec.universeVolumeTopN,
    cachePath: resolve(__dirname, './.cache/universe-cache.json'),
    pinnedTokens: pinned,
  });
  await universe.build();
  status.universe = true;
  log(`universe built (top ${ec.universeTopN}, ${pinned.length} pinned)`);

  const okx = ec.enableOkxMarketData
    ? new OkxClient({ baseUrl: ec.okxBaseUrl, relayBaseUrl: ec.relayBaseUrl, relayAuthSecret: ec.relayAuthSecret })
    : null;

  const prices = new PriceMonitor({
    universe,
    surgePct: 100,
    pollIntervalMs: Number(process.env.PRICE_POLL_INTERVAL_MS ?? 60_000),
    minVolumeUsd: Number(process.env.MIN_24H_VOLUME_USD ?? 500_000),
    okx,
    cgEveryN: Number(process.env.PRICE_CG_EVERY_N ?? 15),
  });
  await prices.start();
  status.prices = true;
  log('prices started');

  let okxSwapMap = new Map();
  if (okx) {
    try {
      okxSwapMap = await okx.buildSwapMap();
      log(`okx: ${okxSwapMap.size} USDT-SWAP instruments mapped`);
      status.okx = okxSwapMap.size > 0;
    } catch (err) {
      warn(`okx instrument map failed (${err.message}); TA uses BASE-USDT-SWAP fallback`);
    }
  } else {
    status.okx = false;
    log('okx market data disabled (ASP_ENABLE_OKX_MARKET_DATA=0)');
  }

  let funding = null;
  let taService = null;
  let liquidationHeatmap = null;
  let sharedCoinalyze = null;

  if (ec.coinalyzeApiKey) {
    try {
      sharedCoinalyze = new CoinalyzeClient({
        apiKey: ec.coinalyzeApiKey,
        rateLimit: Number(process.env.COINALYZE_RATE_LIMIT ?? 36),
        relayBaseUrl: ec.relayBaseUrl,
        relayAuthSecret: ec.relayAuthSecret,
        relayPrimary: process.env.COINALYZE_RELAY === '1',
      });
      const liqCoinalyze = ec.coinalyzeApiKeyLiq
        ? new CoinalyzeClient({
            apiKey: ec.coinalyzeApiKeyLiq,
            rateLimit: Number(process.env.COINALYZE_LIQ_RATE_LIMIT ?? 35),
            relayBaseUrl: ec.relayBaseUrl,
            relayAuthSecret: ec.relayAuthSecret,
            relayPrimary: !!ec.relayBaseUrl,
            label: 'liq',
          })
        : sharedCoinalyze;

      const perpMap = new Map();
      const topN = Number(process.env.ASP_PERP_TOP_N ?? 200);
      try {
        const m = await buildPerpSymbolMap(sharedCoinalyze, universe, topN);
        for (const [k, v] of m) perpMap.set(k, v);
        log(`coinalyze mapped ${perpMap.size} perps`);
      } catch (err) {
        warn(`perp-map build failed (${err.message}); TA falls back to OKX candles. Retrying in 10min.`);
        const retry = setInterval(() => {
          buildPerpSymbolMap(sharedCoinalyze, universe, topN)
            .then((m) => { if (m.size) { for (const [k, v] of m) perpMap.set(k, v); clearInterval(retry); log(`perp map recovered (${m.size})`); } })
            .catch(() => {});
        }, 10 * 60_000);
        retry.unref?.();
      }

      taService = new TAService({
        coinalyze: sharedCoinalyze,
        perpSymbolMap: perpMap,
        okx,
        okxSwapMap,
      });
      status.ta = true;
      log(okx
        ? 'TA enabled (Coinalyze OHLCV + OKX candles fallback)'
        : 'TA enabled (Coinalyze OHLCV only; OKX disabled)');

      if (!funding) {
        funding = new FundingMonitor({
          coinalyze: sharedCoinalyze,
          perpSymbolMap: new Map([...perpMap.entries()].slice(0, Number(process.env.FUNDING_TOP_N ?? 100))),
          universe,
          pollIntervalMs: Number(process.env.FUNDING_POLL_INTERVAL_MS ?? 30 * 60_000),
          cachePath: resolve(__dirname, './.cache/funding-state.json'),
          okx,
          okxSwapMap,
        });
        status.funding = 'coinalyze';
        await funding.start();
        log('funding via Coinalyze');
        await sleep(1_500);
      }

      liquidationHeatmap = new LiquidationHeatmap({
        coinalyze: liqCoinalyze,
        perpSymbolMap: perpMap,
        taService,
        intervalDays: Number(process.env.LIQMAP_DAYS ?? 120),
        interval: process.env.LIQMAP_INTERVAL || '4hour',
        verbose: ec.verbose,
      });
      status.heatmap = true;
      log('liquidation heatmap enabled');
    } catch (err) {
      warn(`Coinalyze block disabled: ${err.message}`);
    }
  } else {
    warn('no COINALYZE_API_KEY — TA + funding(fallback) + heatmap limited (signal quality degrades to price-only)');
  }

  let liquidityClusters = null;
  if (taService?.perpSymbolMap && process.env.LIQUIDITY_CLUSTERS !== '0') {
    try {
      liquidityClusters = new LiquidityClusters({
        perpSymbolMap: taService.perpSymbolMap,
        verbose: ec.verbose,
        okx,
      });
      status.clusters = true;
      liquidityClusters.selfTest?.().catch(() => {});
    } catch (err) { warn(`liquidity clusters disabled: ${err.message}`); }
  }

  let regimeMonitor = null;
  if (taService) {
    try {
      regimeMonitor = new RegimeMonitor({
        taService,
        pollIntervalMs: Number(process.env.REGIME_POLL_INTERVAL_MS ?? 5 * 60_000),
        highVolPct: Number(process.env.REGIME_HIGH_VOL_PCT ?? 1.2),
        enabled: process.env.ENABLE_REGIME !== '0',
        verbose: ec.verbose,
      });
      await regimeMonitor.start();
    } catch (err) { warn(`regime monitor disabled: ${err.message}`); }
  }

  let teamDiscovery = null;
  if (ec.enableTeamDiscovery) {
    try {
      teamDiscovery = new TeamWalletDiscovery({
        universe,
        cexWallets: allWallets,
        cachePath: resolve(__dirname, './.cache/team-wallets.json'),
        moralisApiKey: ec.moralisApiKey,
        relayBaseUrl: ec.relayBaseUrl,
        relayAuthSecret: ec.relayAuthSecret,
        verbose: ec.verbose,
      });
      await teamDiscovery.init();
      status.teamDiscovery = true;
      if (!ec.moralisApiKey) warn('no MORALIS_API_KEY — insider discovery may be Cloudflare-blocked on datacenter IPs');
      teamDiscovery.discoverAll({ maxTokens: ec.teamDiscoveryMaxTokens })
        .then(() => log('team-wallet discovery warmed'))
        .catch((err) => warn(`team discovery warm error: ${err.message}`));
    } catch (err) { warn(`team discovery disabled: ${err.message}`); }
  }

  let cexHoldings = null;
  try {
    cexHoldings = new CexHoldings({
      rpcsByChain: { ethereum: rpcs.ethereum?.rpcs, bsc: rpcs.bsc?.rpcs },
      walletsByChain: allWallets,
    });
    status.cexHoldings = true;
    // Cornered-float leaderboard (powers cex_holdings exchange mode). Background:
    // it multicalls cold-wallet balances across many tokens.
    const lbTokens = universe.allCgIds()
      .map((id) => universe.lookupByCgId(id))
      .filter((t) => t?.chains?.ethereum?.address || t?.chains?.bsc?.address)
      .slice(0, Number(process.env.ASP_LEADERBOARD_TOKENS ?? 120));
    cexHoldings.computeLeaderboard({ tokens: lbTokens })
      .then((lb) => log(`cex leaderboard ready (${Object.keys(lb?.byExchange ?? {}).length} exchanges, ${lbTokens.length} tokens)`))
      .catch((err) => warn(`cex leaderboard failed: ${err.message}`));
  } catch (err) { warn(`cex holdings disabled: ${err.message}`); }

  const conductor = new Conductor({
    universe,
    onchainSources: [],
    prices,
    funding,
    liquidations: null,
    taService,
    liquidityClusters,
    liquidationHeatmap,
    teamDiscovery,
    regimeMonitor,
    regimePenalty: Number(process.env.REGIME_PENALTY ?? 1.0),
    minSignalScore: Number(process.env.MIN_SIGNAL_SCORE ?? 3.0),
    confirmDropThreshold: Number(process.env.TA_CONFIRM_DROP_THRESHOLD ?? -2.5),
    levRiskBasis: Number(process.env.LEV_RISK_BASIS ?? 2),
    verbose: ec.verbose,
  });

  let signalTracker = null;
  try {
    signalTracker = new SignalTracker({
      path: config.reputation.signalsPath,
      priceMonitor: prices,
      taService,
      checkIntervalMs: Number(process.env.SIGNAL_CHECK_INTERVAL_MS ?? 5 * 60_000),
    });
    await signalTracker.init();
    conductor.setSignalTracker(signalTracker);
  } catch (err) { warn(`signal tracker unavailable: ${err.message}`); }

  log(`ready — ${JSON.stringify(status)}`);

  _engine = {
    conductor, universe, prices, funding, taService,
    liquidationHeatmap, liquidityClusters, teamDiscovery, cexHoldings, signalTracker,
    status,
    analyze: async (symbol, opts = {}) => {

      if (funding?.ensureBySymbol) {
        try {
          const t = await universe.ensureBySymbol?.(symbol);
          const price = t?.coingeckoId ? (prices.getPrice?.(t.coingeckoId) ?? null) : null;
          await funding.ensureBySymbol(symbol, price);
        } catch {  }
      }
      return conductor.evaluateForAnalysis({ symbol, allowFetch: true, ...opts });
    },
  };
  return _engine;
}

export function getEngine() { return _engine; }

export default bootEngine;
