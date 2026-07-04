// asp/engine.js — headless boot of Theia's intelligence engine for the ASP.
//
// This IMPORTS the existing engine (src/*) and wires ONLY the intelligence
// subsystems needed to serve the A2MCP skills on demand. It deliberately leaves
// out the Telegram transport, bot-commands, autotrade, billing, and the noisy
// event monitors (news/macro/unlock/listing) and the live on-chain flow feed.
//
// Design goals:
//   - Reuse, do not reimplement. Scoring lives in src/conductor.js; we only
//     construct and inject its dependencies.
//   - Graceful degradation. Every optional subsystem is wrapped so a missing key
//     or a transient outage degrades one skill's data, never the whole server.
//   - On-demand. We do NOT call conductor.start() (no live pipeline). We warm the
//     data services (prices/funding/TA) and let evaluateForAnalysis fetch per call
//     with allowFetch:true so any recognized token works, not just the tracked set.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Universe } from '../src/universe.js';
import { PriceMonitor } from '../src/prices.js';
import { FundingMonitor } from '../src/funding.js';
import { BinanceFuturesMonitor } from '../src/binance-futures.js';
import { CoinalyzeClient, buildPerpSymbolMap } from '../src/coinalyze.js';
import { TAService } from '../src/ta.js';
import { LiquidationHeatmap } from '../src/liquidation-heatmap.js';
import { LiquidityClusters } from '../src/liquidity-clusters.js';
import { TeamWalletDiscovery } from '../src/team-wallet-discovery.js';
import { RegimeMonitor } from '../src/regime.js';
import { CexHoldings } from '../src/cex-holdings.js';
import { Conductor } from '../src/conductor.js';
import { SignalTracker } from '../src/signal-tracker.js';

import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '../src');
const loadJson = (rel) => JSON.parse(readFileSync(resolve(srcDir, rel), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[asp-engine] ${msg}`);
const warn = (msg) => console.warn(`[asp-engine] ${msg}`);

let _engine = null; // memoized singleton so multiple imports share one boot

/**
 * Boot (or return the already-booted) headless engine.
 * @returns {Promise<Engine>}
 */
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

  // ── Universe (required — resolves symbol -> cgId, metadata) ────────────────
  const universe = new Universe({
    topN: ec.universeTopN,
    topByVolume: ec.universeVolumeTopN,
    cachePath: resolve(__dirname, './.cache/universe-cache.json'),
    pinnedTokens: pinned,
  });
  await universe.build();
  status.universe = true;
  log(`universe built (top ${ec.universeTopN}, ${pinned.length} pinned)`);

  // ── Prices (required — PriceMonitor.getPrice is dereferenced unguarded) ────
  const prices = new PriceMonitor({
    universe,
    surgePct: 100, // effectively disable surge emits; we never call conductor.start()
    pollIntervalMs: Number(process.env.PRICE_POLL_INTERVAL_MS ?? 60_000),
    minVolumeUsd: Number(process.env.MIN_24H_VOLUME_USD ?? 500_000),
    relayBaseUrl: ec.relayBaseUrl,
    relayAuthSecret: ec.relayAuthSecret,
    cgEveryN: Number(process.env.PRICE_CG_EVERY_N ?? 15),
  });
  await prices.start();
  status.prices = true;
  log('prices started');

  // ── Coinalyze -> TA / funding / heatmap block ─────────────────────────────
  let funding = null;
  let taService = null;
  let liquidationHeatmap = null;
  let sharedCoinalyze = null;

  // Funding: prefer Binance Futures (free, no key) when reachable.
  if (ec.enableBinanceFutures) {
    try {
      const binance = new BinanceFuturesMonitor({
        universe,
        pollIntervalMs: Number(process.env.FUNDING_POLL_INTERVAL_MS ?? 5 * 60_000),
        relayBaseUrl: ec.relayBaseUrl,
        relayAuthSecret: ec.relayAuthSecret,
      });
      if (await binance.probe()) {
        funding = binance;
        status.funding = 'binance';
        await funding.start();
        log('funding via Binance Futures');
        await sleep(1_500);
      }
    } catch (err) { warn(`Binance Futures probe failed: ${err.message}`); }
  }

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

      // Build the perp map (tolerant: an empty map still lets TA use Bybit klines).
      const perpMap = new Map();
      const topN = Number(process.env.ASP_PERP_TOP_N ?? 200);
      try {
        const m = await buildPerpSymbolMap(sharedCoinalyze, universe, topN);
        for (const [k, v] of m) perpMap.set(k, v);
        log(`coinalyze mapped ${perpMap.size} perps`);
      } catch (err) {
        warn(`perp-map build failed (${err.message}); TA falls back to Bybit klines. Retrying in 10min.`);
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
        relayBaseUrl: ec.relayBaseUrl,          // route Bybit price/klines via relay
        relayAuthSecret: ec.relayAuthSecret,
      });
      status.ta = true;
      log('TA enabled (multi-TF via Coinalyze OHLCV, Bybit-klines fallback)');

      // Coinalyze funding fallback only if Binance did not cover it.
      if (!funding) {
        funding = new FundingMonitor({
          coinalyze: sharedCoinalyze,
          perpSymbolMap: new Map([...perpMap.entries()].slice(0, Number(process.env.FUNDING_TOP_N ?? 100))),
          universe,
          pollIntervalMs: Number(process.env.FUNDING_POLL_INTERVAL_MS ?? 30 * 60_000),
          cachePath: resolve(__dirname, './.cache/funding-state.json'),
        });
        status.funding = 'coinalyze';
        await funding.start();
        log('funding via Coinalyze');
        await sleep(1_500);
      }

      // Liquidation heatmap (leverage-liquidation magnet zones) — powers /liqmap
      // and TP placement.
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

  // ── Liquidity clusters (orderbook heatmap) — optional ─────────────────────
  let liquidityClusters = null;
  if (taService?.perpSymbolMap && process.env.LIQUIDITY_CLUSTERS !== '0') {
    try {
      liquidityClusters = new LiquidityClusters({
        perpSymbolMap: taService.perpSymbolMap,
        verbose: ec.verbose,
        relayBaseUrl: ec.relayBaseUrl,
        relayAuthSecret: ec.relayAuthSecret,
      });
      status.clusters = true;
      liquidityClusters.selfTest?.().catch(() => {});
    } catch (err) { warn(`liquidity clusters disabled: ${err.message}`); }
  }

  // ── Regime monitor (BTC macro trend) — optional, needs TA ─────────────────
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

  // ── Team-wallet discovery (insider holders / concentration) — optional ────
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
      // Warm discovery in the background so insider_scan has data; never blocks boot.
      teamDiscovery.discoverAll({ maxTokens: ec.teamDiscoveryMaxTokens })
        .then(() => log('team-wallet discovery warmed'))
        .catch((err) => warn(`team discovery warm error: ${err.message}`));
    } catch (err) { warn(`team discovery disabled: ${err.message}`); }
  }

  // ── CEX cold-wallet holdings (cornered float) — optional ──────────────────
  let cexHoldings = null;
  try {
    cexHoldings = new CexHoldings({
      rpcsByChain: { ethereum: rpcs.ethereum?.rpcs, bsc: rpcs.bsc?.rpcs },
      walletsByChain: allWallets,
    });
    status.cexHoldings = true;
  } catch (err) { warn(`cex holdings disabled: ${err.message}`); }

  // ── Conductor (the scoring brain) — onchainSources=[] (on-demand skills use
  //    teamDiscovery/cexHoldings directly; the live flow feed is not needed) ──
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
  // NOTE: we intentionally do NOT call conductor.start() — no live event pipeline.

  // ── Signal tracker (real resolved outcomes -> reputation ledger) ──────────
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
    /** Convenience: full scored read for a token (any recognized symbol). */
    analyze: (symbol, opts = {}) => conductor.evaluateForAnalysis({ symbol, allowFetch: true, ...opts }),
  };
  return _engine;
}

/** Return the booted engine or null if boot has not completed. */
export function getEngine() { return _engine; }

export default bootEngine;
