import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Universe } from './universe.js';
import { EvmMonitor } from './onchain-evm.js';
import { SolanaMonitor } from './onchain-sol.js';
import { PriceMonitor } from './prices.js';
import { FundingMonitor, fundingLeaders, formatFundingLeaders } from './funding.js';
import { Conductor } from './conductor.js';
import { Notifier } from './telegram.js';
import { CoinalyzeClient, buildPerpSymbolMap } from './coinalyze.js';
import { LiquidationMonitor } from './liquidations.js';
import { BinanceLiquidations } from './binance-liquidations.js';
import { BybitLiquidations } from './bybit-liquidations.js';
import { BinanceFuturesMonitor } from './binance-futures.js';
import { SignalTracker } from './signal-tracker.js';
import { SheetLogger } from './sheet-logger.js';
import { TAService } from './ta.js';
import { LiquidationHeatmap } from './liquidation-heatmap.js';
import { CexHoldings } from './cex-holdings.js';
import { BotCommands } from './bot-commands.js';
import { SubscriberStore } from './subscribers.js';
import { BillingService } from '../billing/index.js';   // subscription/payments (opt-in: BILLING_ENABLED=1)
import { WalletLabelResolver } from './wallet-label-resolver.js';
import { LiquidityClusters } from './liquidity-clusters.js';
import { TeamWalletDiscovery } from './team-wallet-discovery.js';
import { ListingMonitor } from './listing-monitor.js';
import { UnlockMonitor } from './unlock-monitor.js';
import { MacroMonitor, leadPhrase } from './macro-monitor.js';
import { NewsMonitor } from './news-monitor.js';
import { llmStatus } from './llm.js';
import { RegimeMonitor } from './regime.js';
import { isStableSymbol } from './stables.js';
import { explorerTxUrl } from './explorers.js';
import { AutoTrader } from './autotrade/auto-trader.js';
import { BybitExchange } from './autotrade/exchange-bybit.js';
import { PaperBroker } from './autotrade/paper-broker.js';
import { RiskEngine } from './autotrade/risk-engine.js';
import { TradeStore } from './autotrade/store.js';
import { UserAccounts } from './autotrade/user-accounts.js';
import { startHealthServer } from './health-server.js';
import { dbEnabled, initSchema, kvGet, kvSet } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadJson = (rel) => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, rel), 'utf8'));
  } catch (err) {
    // A corrupt/missing required config otherwise dies with a bare SyntaxError and
    // no filename — Render just silent-restart-loops. Name the file, then re-throw
    // so required configs still fail fast (callers wrap optional ones in try/catch).
    console.error(`[boot] failed to load config ${rel}: ${err.message}`);
    throw err;
  }
};

function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  // Bind the HTTP port FIRST so Render detects the web service immediately and
  // an uptime pinger has a /health target. No-op on a VM unless PORT is set.
  await startHealthServer({ port: process.env.PORT ? Number(process.env.PORT) : null });
  // Bring up Postgres (Neon) when configured — durable state for disk-less hosts.
  // If it can't initialise (pg not installed, Neon unreachable), DISABLE the DB
  // so every store cleanly falls back to local files instead of silently
  // dropping writes. (Deleting the env var makes dbEnabled() false everywhere.)
  if (dbEnabled()) {
    try { await initSchema(); }
    catch (err) {
      console.error(`[db] init failed: ${err.message} — falling back to FILE storage (run \`npm install\` for the pg driver, or check DATABASE_URL)`);
      delete process.env.DATABASE_URL;
    }
  }

  const TELEGRAM_BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
  const TELEGRAM_CHAT_ID = requireEnv('TELEGRAM_CHAT_ID');
  const MIN_FLOW_USD = Number(process.env.MIN_FLOW_USD ?? 1_000_000);   // audit §6.8 — flow is the worst trigger; raise the bar
  const SURGE_PCT = Number(process.env.SURGE_PCT ?? 3);
  const WINDOW_MS = Number(process.env.CORRELATION_WINDOW_MIN ?? 15) * 60_000;
  const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE ?? 3.0);
  const MIN_SIGNAL_SCORE_PINNED = Number(process.env.MIN_SIGNAL_SCORE_PINNED ?? (MIN_SIGNAL_SCORE * 0.85));
  const MIN_OBSERVATION_SCORE = Number(process.env.MIN_OBSERVATION_SCORE ?? 1.0);
  const SIGNAL_COOLDOWN_MIN = Number(process.env.SIGNAL_COOLDOWN_MIN ?? 30);
  const UNIVERSE_TOP_N = Number(process.env.UNIVERSE_TOP_N ?? 500);
  const UNIVERSE_VOLUME_TOP_N = Number(process.env.UNIVERSE_VOLUME_TOP_N ?? 300);
  const OBSERVE_MIN_FLOW_USD = Number(process.env.OBSERVE_MIN_FLOW_USD ?? 1_000_000);
  const FUNDING_LEADERS_MIN = Number(process.env.FUNDING_LEADERS_MIN ?? 30);
  const MOVERS_SCAN_MIN = Number(process.env.MOVERS_SCAN_MIN ?? 30);
  const MOVERS_TOP_N = Number(process.env.MOVERS_TOP_N ?? 10);
  // Deeper leaderboard the movers scan ROTATES through (like funding leaders):
  // each scan evaluates a MOVERS_TOP_N window, advancing through the top
  // MOVERS_DEPTH so emerging movers at rank #11–20 (which can climb to #1) get
  // checked too — same per-scan API cost, deeper coverage over time.
  const MOVERS_DEPTH = Number(process.env.MOVERS_DEPTH ?? 20);
  const FUNDING_INTERVAL_HRS = Number(process.env.FUNDING_INTERVAL_HRS ?? 1);
  // Coinalyze is the live liquidation source (Binance WS is geo-blocked on cloud
  // hosts — see below). Calibrated 2026-06-15: Coinalyze's biggest 1-min bucket
  // across 23 majors in a calm hour was ~$160K (BTC), with a long tail of $20-70K.
  // $250K+ NEVER fired. $50K surfaces the genuinely notable cascades (~4-7/hr) and
  // scales up automatically in volatility. Lower to ~$25K for more sensitivity.
  const MIN_LIQUIDATION_USD = Number(process.env.MIN_LIQUIDATION_USD ?? 50_000);
  const FUNDING_LEADERS_MIN_OI = Number(process.env.FUNDING_LEADERS_MIN_OI ?? 10_000_000);
  const VERBOSE = process.env.VERBOSE === '1';

  // Shared Singapore relay base (the "/relay" endpoint) — the SAME relay used
  // for Bybit trading. Lets the bot pull Binance futures DATA (funding, OI,
  // deep order-book heatmap) through a Singapore egress when this VPS's IP is
  // geo-blocked from Binance directly. Prefer a dedicated RELAY_BASE_URL, else
  // reuse the Bybit relay base; auth header is the shared proxy secret.
  const RELAY_BASE_URL = (process.env.RELAY_BASE_URL || process.env.BYBIT_BASE_URL || '').replace(/\/$/, '') || null;
  const RELAY_AUTH_SECRET = process.env.BYBIT_PROXY_SECRET || null;
  if (RELAY_BASE_URL) console.log(`[relay] Singapore relay configured for Binance data → ${RELAY_BASE_URL}/binance/*`);

  const enableEth = process.env.ENABLE_ETH !== '0';
  const enableBsc = process.env.ENABLE_BSC !== '0';
  const enableBase = process.env.ENABLE_BASE !== '0';
  const enableSol = process.env.ENABLE_SOL !== '0';

  const allWallets = loadJson('./config/cex-wallets.json');
  const rpcs = loadJson('./config/rpcs.json');
  const pinned = loadJson('./config/tokens.json');

  // User-added watchlist (operator-mutated via /watchlist add). Merged with
  // pinned for universe.build so additions survive restart.
  const userPinnedPath = resolve(__dirname, '../logs/user-watchlist.json');
  let userPinned = [];
  try {
    if (dbEnabled()) {
      const fromDb = await kvGet('watchlist', 'user-pinned');
      if (fromDb != null) userPinned = Array.isArray(fromDb) ? fromDb : [];
      else if (existsSync(userPinnedPath)) {   // migrate file → DB happens on first save by BotCommands
        const data = JSON.parse(readFileSync(userPinnedPath, 'utf8'));
        userPinned = Array.isArray(data?.entries) ? data.entries : [];
      }
    } else if (existsSync(userPinnedPath)) {
      const data = JSON.parse(readFileSync(userPinnedPath, 'utf8'));
      userPinned = Array.isArray(data?.entries) ? data.entries : [];
    }
    if (userPinned.length > 0) console.log(`[watchlist] loaded ${userPinned.length} user-added tokens`);
  } catch (err) {
    console.warn(`[watchlist] load failed: ${err.message}`);
  }
  const mergedPinned = [...pinned, ...userPinned];

  console.log(
    `[boot] universe=top${UNIVERSE_TOP_N} pinned=${pinned.length} | ` +
    `minFlowUsd=$${MIN_FLOW_USD.toLocaleString()} surgePct=${SURGE_PCT}% window=${WINDOW_MS/60000}min`
  );

  const universe = new Universe({
    topN: UNIVERSE_TOP_N,
    topByVolume: UNIVERSE_VOLUME_TOP_N,
    cachePath: resolve(__dirname, './config/.universe-cache.json'),
    pinnedTokens: mergedPinned
  });
  await universe.build();

  // Periodic hot-volume refresh (opt-in UNIVERSE_HOT_REFRESH_MS): merge tokens that
  // surged into heavy trading after boot, so a fresh listing / parabolic name gets
  // tracked without waiting for a full rebuild. Light: one volume pass + platforms.
  const UNIVERSE_HOT_REFRESH_MS = Number(process.env.UNIVERSE_HOT_REFRESH_MS ?? 0);
  if (UNIVERSE_HOT_REFRESH_MS > 0) {
    const iv = setInterval(() => universe.refreshHotVolume()
      .catch(err => console.warn(`[universe] hot-volume refresh error: ${err.message}`)),
      UNIVERSE_HOT_REFRESH_MS);
    iv.unref?.();
    console.log(`[universe] periodic hot-volume refresh every ${Math.round(UNIVERSE_HOT_REFRESH_MS / 60000)}min`);
  }

  // Subscriber store — every chat that /start's the bot gets added; broadcasts
  // go to all of them. If empty (e.g. first boot), falls back to the operator's
  // TELEGRAM_CHAT_ID so single-user mode keeps working.
  const subscribers = new SubscriberStore({
    path: resolve(__dirname, '../logs/subscribers.json')
  });
  await subscribers.init();   // load from Postgres (or file) before first use
  // Seed the operator chat on first boot so they don't have to /start themselves
  if (subscribers.size() === 0 && TELEGRAM_CHAT_ID) {
    subscribers.add({ chatId: TELEGRAM_CHAT_ID, username: 'operator' });
    console.log(`[subscribers] seeded operator chat ${TELEGRAM_CHAT_ID}`);
  }

  const notifier = new Notifier({
    token: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
    proxy: process.env.TELEGRAM_API_PROXY || undefined,
    fundingIntervalHrs: FUNDING_INTERVAL_HRS,
    enablePolling: process.env.TELEGRAM_COMMANDS !== '0',
    subscribers
  });
  await notifier.ready();

  // Small helper to stagger startup so we don't burst all APIs at once
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const prices = new PriceMonitor({
    universe,
    surgePct: SURGE_PCT,
    pollIntervalMs: Number(process.env.PRICE_POLL_INTERVAL_MS ?? 60_000),
    minVolumeUsd: Number(process.env.MIN_24H_VOLUME_USD ?? 500_000),
    // Binance tickers (via the Singapore relay) become the primary fast price/
    // surge feed for perp tokens; CoinGecko drops to a slow spot-only poll.
    // Set PRICE_BINANCE=0 to force the old CoinGecko-only behaviour.
    relayBaseUrl: process.env.PRICE_BINANCE === '0' ? null : RELAY_BASE_URL,
    relayAuthSecret: RELAY_AUTH_SECRET,
    cgEveryN: Number(process.env.PRICE_CG_EVERY_N ?? 15)
  });
  await prices.start();
  await sleep(3_000);

  // ── Funding + OI: prefer Binance Futures (free, no key, vastly better rate limits) ──
  let funding = null;
  let fundingSource = 'disabled';

  if (process.env.ENABLE_BINANCE_FUTURES !== '0') {
    const binance = new BinanceFuturesMonitor({
      universe,
      pollIntervalMs: Number(process.env.FUNDING_POLL_INTERVAL_MS ?? 5 * 60_000),
      relayBaseUrl: RELAY_BASE_URL,
      relayAuthSecret: RELAY_AUTH_SECRET
    });
    console.log('[funding] probing Binance Futures reachability (direct, then Singapore relay)...');
    const reachable = await binance.probe();
    if (reachable) {
      console.log('[funding] Binance Futures reachable — using as primary source');
      funding = binance;
      fundingSource = 'binance';
      await funding.start();
      await sleep(3_000);
    } else {
      console.warn('[funding] Binance Futures unreachable — will try Coinalyze fallback');
    }
  }

  // ── Liquidations (and funding fallback) via Coinalyze ────────────────────
  let liquidations = null;
  let taService = null;
  let liquidationHeatmap = null;
  let sharedCoinalyze = null;
  const COINALYZE_API_KEY = process.env.COINALYZE_API_KEY;
  if (COINALYZE_API_KEY) {
    try {
      // Coinalyze rate limit is per-KEY (~40/min). TA OHLCV (every token × 5 TFs)
      // + heatmap warmer + funding were starving the time-critical liquidation
      // poll — it covered only ~16/60 symbols and missed the BTC cascade a
      // lighter (perfect-commit) bot caught.
      // BEST fix: a SECOND Coinalyze key (COINALYZE_API_KEY_LIQ) dedicated to
      // liquidations — its OWN full ~40/min budget AND, routed through the relay,
      // a SEPARATE egress IP so a throttled datacenter IP can't blind it. With no
      // 2nd key we fall back to splitting the single key's budget (liquidations
      // still get a reserved slice on a separate gate, so they never wait behind TA).
      const COINALYZE_LIQ_KEY = process.env.COINALYZE_API_KEY_LIQ || null;
      const twoKey = !!COINALYZE_LIQ_KEY;
      const COINALYZE_RATE = Number(process.env.COINALYZE_RATE_LIMIT ?? (twoKey ? 35 : 36));
      const LIQ_RATE = Math.max(6, Number(process.env.COINALYZE_LIQ_RATE_LIMIT ?? (twoKey ? 35 : 16)));
      const SHARED_RATE = twoKey ? COINALYZE_RATE : Math.max(8, COINALYZE_RATE - LIQ_RATE);
      sharedCoinalyze = new CoinalyzeClient({
        apiKey: COINALYZE_API_KEY,
        rateLimit: SHARED_RATE,   // TA / heatmap / funding (NOT liquidations)
        // Direct (your IP) PRIMARY, relay (Singapore) FAILOVER — so if Coinalyze
        // throttles the datacenter IP, this key still gets through via Singapore.
        // The liq key is the MIRROR (relay-primary, direct failover). Net result:
        //   • Normal: the two keys sit on DIFFERENT IPs (your IP + Singapore) →
        //     Coinalyze is less likely to correlate + block both at once.
        //   • If EITHER IP is throttled, BOTH keys still have the other IP to fall
        //     back to → no single point of failure.
        // COINALYZE_RELAY=1 flips the shared key to relay-primary too (use if your
        // datacenter IP is consistently throttled — but then both keys share the
        // relay IP, so prefer leaving it 0).
        relayBaseUrl: RELAY_BASE_URL,
        relayAuthSecret: RELAY_AUTH_SECRET,
        relayPrimary: process.env.COINALYZE_RELAY === '1'
      });
      // Dedicated liquidation client. 2nd key when set (separate budget); routed
      // relay-PRIMARY so its egress IP differs from the datacenter IP, with direct
      // as failover. Single-key fallback stays direct-primary on a reserved slice.
      const liqCoinalyze = new CoinalyzeClient({
        apiKey: COINALYZE_LIQ_KEY || COINALYZE_API_KEY,
        rateLimit: LIQ_RATE,
        relayBaseUrl: RELAY_BASE_URL,
        relayAuthSecret: RELAY_AUTH_SECRET,
        relayPrimary: twoKey && !!RELAY_BASE_URL,
        label: 'liq'
      });
      console.log(twoKey
        ? `[coinalyze] dedicated liquidation KEY — ${LIQ_RATE}/min${RELAY_BASE_URL ? ' via relay (separate IP)' : ''} + shared ${SHARED_RATE}/min direct (separate budgets)`
        : `[coinalyze] single key — shared ${SHARED_RATE}/min + liquidations ${LIQ_RATE}/min (separate gate) = ${SHARED_RATE + LIQ_RATE}/min total`);
      console.log('[coinalyze] mapping universe to perp symbols...');
      const LIQUIDATION_TOP_N = Number(process.env.LIQUIDATION_TOP_N ?? 50);
      const FUNDING_TOP_N = Number(process.env.FUNDING_TOP_N ?? LIQUIDATION_TOP_N);
      const maxTopN = Math.max(FUNDING_TOP_N, LIQUIDATION_TOP_N);

      // Build the perp-symbol map. Coinalyze can be down/slow at boot; that must
      // NOT disable the whole block. Previously buildPerpSymbolMap() threw on a
      // /future-markets timeout BEFORE taService was constructed (below), so a
      // transient Coinalyze outage left /analyze with no TA for ANY token (the
      // "no data coverage" outage, even for majors like HYPE). Now: fall back to
      // an EMPTY map and keep going. TA then uses Bybit klines, funding uses
      // Binance, liquidations use the forwarder. Retry in the background, mutating
      // the SAME map objects the services hold by reference, so Coinalyze coverage
      // returns with no restart once the API recovers.
      const allPerpMap = new Map();
      const liqMap = new Map();
      const refillPerpMaps = async () => {
        const m = await buildPerpSymbolMap(sharedCoinalyze, universe, maxTopN);
        if (m.size === 0) throw new Error('empty perp map');
        allPerpMap.clear();
        for (const [k, v] of m) allPerpMap.set(k, v);
        liqMap.clear();
        for (const [k, v] of [...m.entries()].slice(0, LIQUIDATION_TOP_N)) liqMap.set(k, v);
        return m.size;
      };
      try {
        await refillPerpMaps();
        console.log(`[coinalyze] mapped ${allPerpMap.size} perps, liquidations=${liqMap.size}`);
      } catch (err) {
        console.warn(`[coinalyze] perp-map build failed (${err.message}). TA will use Bybit klines, funding via Binance, liquidations via the forwarder. Retrying every 10min.`);
        const retry = setInterval(() => {
          refillPerpMaps()
            .then((n) => { clearInterval(retry); console.log(`[coinalyze] perp map recovered, ${n} perps mapped (no restart needed)`); })
            .catch(() => { /* still unreachable; keep retrying */ });
        }, 10 * 60_000);
        retry.unref?.();
      }

      // Periodic PERP-MAP refresh (opt-in PERP_MAP_REFRESH_MS): rebuild from the
      // current universe so freshly-FAVORED tokens (new hot movers) pick up perp
      // coverage. ADDITIVE — only adds perps not already mapped, so funding's
      // on-demand additions and in-flight services aren't disrupted. Mutates the
      // SAME map objects the services hold by reference.
      const PERP_MAP_REFRESH_MS = Number(process.env.PERP_MAP_REFRESH_MS ?? 0);
      if (PERP_MAP_REFRESH_MS > 0) {
        const mergeHotPerps = async () => {
          const m = await buildPerpSymbolMap(sharedCoinalyze, universe, maxTopN);
          let added = 0;
          for (const [k, v] of m) if (!allPerpMap.has(k)) { allPerpMap.set(k, v); added++; }
          for (const [k, v] of [...m.entries()].slice(0, LIQUIDATION_TOP_N)) if (!liqMap.has(k)) liqMap.set(k, v);
          return added;
        };
        const iv = setInterval(() => mergeHotPerps()
          .then(n => { if (n) console.log(`[coinalyze] perp map +${n} (hot-mover refresh)`); })
          .catch(err => { if (VERBOSE) console.warn(`[coinalyze] perp refresh failed: ${err.message}`); }),
          PERP_MAP_REFRESH_MS);
        iv.unref?.();
        console.log(`[coinalyze] periodic perp-map refresh every ${Math.round(PERP_MAP_REFRESH_MS / 60000)}min`);
      }

      // Construct TA EARLY, right after the perp map, so nothing downstream
      // (funding / liquidation setup) can skip it on a transient failure. TA runs
      // on Bybit klines via the relay even when the Coinalyze perp map is empty.
      taService = new TAService({
        coinalyze: sharedCoinalyze,
        perpSymbolMap: allPerpMap,
        relayBaseUrl: process.env.BYBIT_BASE_URL || null,     // route Bybit price/klines via relay
        relayAuthSecret: process.env.BYBIT_PROXY_SECRET || null
      });
      console.log('[ta] enabled (multi-TF TA via Coinalyze OHLCV, Bybit-klines fallback)');

      // Coinalyze funding fallback only if Binance isn't already covering it
      if (!funding) {
        const fundingMap = new Map([...allPerpMap.entries()].slice(0, FUNDING_TOP_N));
        funding = new FundingMonitor({
          coinalyze: sharedCoinalyze,
          perpSymbolMap: fundingMap,
          universe,
          pollIntervalMs: Number(process.env.FUNDING_POLL_INTERVAL_MS ?? 30 * 60_000),
          // Persist funding state so a restart within 2h doesn't blind the bot
          // for an hour while it refetches. Saved after each successful poll.
          cachePath: resolve(__dirname, '../logs/funding-state.json')
        });
        fundingSource = 'coinalyze';
        await funding.start();
        await sleep(5_000);
      }

      // Bybit liquidations (polled from the Fly-Tokyo forwarder) are the PRIMARY
      // source when LIQ_FORWARDER_URL is set — real-time, accurate, and the venue the
      // bot actually trades. Binance geo-blocks data to cloud IPs; Coinalyze under-
      // reports ~85%. With the forwarder live, the Coinalyze monitor runs OI-ONLY
      // (feeds the OI-% significance model) instead of emitting its thin liquidations.
      const LIQ_FORWARDER_URL = process.env.LIQ_FORWARDER_URL || null;
      const OI_PCT = Number(process.env.LIQ_OI_PCT ?? 0.0001);          // ≥0.01% of OI = significant
      const LIQ_FLOOR = Number(process.env.LIQ_MIN_FLOOR_USD ?? 25_000); // dust floor
      liquidations = new LiquidationMonitor({
        coinalyze: liqCoinalyze,    // dedicated client — never starved by TA
        perpSymbolMap: liqMap,
        pollIntervalMs: Number(process.env.LIQUIDATION_POLL_INTERVAL_MS ?? 5 * 60_000),
        minLiquidationUsd: MIN_LIQUIDATION_USD,   // absolute always-fire / OI-unknown fallback
        oiPct: OI_PCT,
        minFloorUsd: LIQ_FLOOR,
        oiOnly: !!LIQ_FORWARDER_URL,              // Coinalyze → OI provider; Bybit emits liquidations
      });
      await liquidations.start();

      if (LIQ_FORWARDER_URL) {
        const liqTokenSet = new Set();
        for (const cgId of universe.allCgIds()) {
          const t = universe.lookupByCgId(cgId);
          if (t?.symbol) liqTokenSet.add(String(t.symbol).toUpperCase());
        }
        const bybitLiq = new BybitLiquidations({
          forwarderUrl: LIQ_FORWARDER_URL,
          tokenSet: liqTokenSet,
          getOiUsd: (sym) => liquidations.getOiUsd(sym),   // reuse the Coinalyze OI cache
          pollIntervalMs: Number(process.env.BYBIT_LIQ_POLL_MS ?? 20_000),
          minLiquidationUsd: MIN_LIQUIDATION_USD,
          oiPct: OI_PCT,
          minFloorUsd: LIQ_FLOOR,
          // SLIDING window so a multi-minute cascade accumulates (was a per-minute reset).
          windowMs: Number(process.env.BYBIT_LIQ_WINDOW_MIN ?? 3) * 60_000,
        });
        bybitLiq.on('liquidation', (ev) => liquidations.emit('liquidation', ev));   // shared pipeline
        bybitLiq.start();
        console.log(`[bybit-liq] enabled — forwarder ${LIQ_FORWARDER_URL}, ${liqTokenSet.size}-token universe`);
      }

      // OPT-IN (default OFF): real-time liquidations via Binance's !forceOrder WS.
      // PROVEN 2026-06-15 that Binance silently geo-blocks DATA on every cloud host
      // tried (Render US, Fly Singapore + Tokyo): the socket opens and the SUBSCRIBE
      // is acked, but ZERO market data is pushed (even a btcusdt@aggTrade liveness
      // probe got 0 frames). So this path is dead on Render/Fly/Vercel and Coinalyze
      // above is the live source. Re-enable ONLY by pointing BINANCE_LIQ_WS_URL at a
      // forwarder on a host with a CLEAN dedicated IP (a $5 VPS — NOT Fly/Render),
      // then set BINANCE_LIQ_WS=1.
      if (process.env.BINANCE_LIQ_WS === '1') {
        const liqSymbolToToken = new Map();
        for (const cgId of universe.allCgIds()) {
          const t = universe.lookupByCgId(cgId);
          if (t?.symbol) { const s = String(t.symbol).toUpperCase(); liqSymbolToToken.set(`${s}USDT`, s); }
        }
        const binanceLiq = new BinanceLiquidations({
          symbolToToken: liqSymbolToToken,
          url: process.env.BINANCE_LIQ_WS_URL || undefined,   // set to a non-US WS forwarder if Binance is geo-blocked
          minLiquidationUsd: MIN_LIQUIDATION_USD,
          verbose: VERBOSE
        });
        binanceLiq.on('liquidation', (ev) => liquidations.emit('liquidation', ev));
        binanceLiq.start();
        console.log(`[binance-liq] real-time WS enabled — ${liqSymbolToToken.size} symbols, ≥$${MIN_LIQUIDATION_USD.toLocaleString()}/min`);
      }

      // Liquidation heatmap — estimates leverage-liquidation magnet zones from
      // historical OI + price (the far-out levels order books can't show).
      const LIQMAP_DAYS = Number(process.env.LIQMAP_DAYS ?? 120);
      const LIQMAP_INTERVAL = process.env.LIQMAP_INTERVAL || '4hour';
      liquidationHeatmap = new LiquidationHeatmap({
        coinalyze: liqCoinalyze,    // dedicated liq key (separate ~40/min budget) — fire-time computes don't starve TA
        perpSymbolMap: allPerpMap,
        taService,
        intervalDays: LIQMAP_DAYS,
        interval: LIQMAP_INTERVAL,
        verbose: VERBOSE
      });
      console.log(`[liq-map] enabled (/liqmap) — leverage-liquidation heatmap, ${LIQMAP_INTERVAL} over ${LIQMAP_DAYS} days (±${process.env.LIQMAP_MAX_DIST_PCT || 80}% range)`);
    } catch (err) {
      console.error(`[coinalyze] disabled: ${err.message}`);
      liquidations = null;
    }
  } else {
    console.warn('[coinalyze] no API key — liquidations + TA DISABLED');
  }

  if (!funding) console.warn('[funding] no source available — funding/OI DISABLED');

  // Shared wallet-label resolver — auto-discovers exchange affiliation for
  // any address we see flowing that isn't in our static config. Cached to
  // disk so we hit each explorer once per address (then never again until
  // the TTL expires). Disabled if WALLET_LABEL_AUTORESOLVE=0.
  const labelResolver = process.env.WALLET_LABEL_AUTORESOLVE === '0'
    ? null
    : new WalletLabelResolver({
        cachePath: resolve(__dirname, '../logs/wallet-labels.json'),
        verbose: VERBOSE
      });
  if (labelResolver) console.log('[wallet-labels] auto-resolve enabled (etherscan/bscscan/solscan name tags)');

  // Team-wallet discovery — scrapes top-holders for each universe token,
  // filters out CEX/burn/infrastructure, and watches the rest for outflows
  // to CEX hot/cold wallets (the "team distribution" bearish signal).
  // Disabled via TEAM_WALLET_TRACKING=0. Cached on disk so restarts are
  // free; full universe rescrape happens weekly.
  const teamDiscovery = process.env.TEAM_WALLET_TRACKING === '0'
    ? null
    : new TeamWalletDiscovery({
        universe,
        cexWallets: allWallets,
        cachePath: resolve(__dirname, '../logs/team-wallets.json'),
        moralisApiKey: process.env.MORALIS_API_KEY || null, // PRIMARY holder source — works from Render's datacenter IP
        relayBaseUrl: process.env.BYBIT_BASE_URL || null,   // fallback: route explorer scrape via the relay (cloud IPs are blocked direct)
        relayAuthSecret: process.env.BYBIT_PROXY_SECRET || null,
        verbose: VERBOSE
      });
  if (teamDiscovery) {
    await teamDiscovery.init();   // load cached insiders from Postgres (or file) before rescraping
    const maxTokens = Number(process.env.TEAM_WALLET_MAX_TOKENS ?? 100);
    const holderSrc = process.env.MORALIS_API_KEY ? 'Moralis API' : 'explorer scrape (relay/direct)';
    console.log(`[team-wallets] enabled — discovering insider holders for top ${maxTokens} tokens via ${holderSrc} (cached)`);
    if (!process.env.MORALIS_API_KEY) console.warn('[team-wallets] no MORALIS_API_KEY set — scraping is Cloudflare-blocked on datacenter IPs; set a free Moralis key for reliable discovery');

    // Accumulation alert — a large wallet quietly building a position (bullish
    // mirror of insider distribution). Emitted by discovery when a holder's %
    // of supply jumps between snapshots. Own notify category (defaults ON).
    teamDiscovery.on('accumulation', async ({ text, symbol }) => {
      console.log(`[ACCUMULATION] ${symbol}`);
      try { await notifier.sendInfo(text, 'accumulation'); }
      catch (err) { console.warn(`[accumulation] broadcast failed: ${err.message}`); }
    });

    const runDiscovery = (tag) => teamDiscovery.discoverAll({ maxTokens })
      .then(() => { for (const src of sources) if (typeof src.refreshTeamIndex === 'function') src.refreshTeamIndex(); })
      .catch(err => console.warn(`[team-wallets] ${tag} discovery error: ${err.message}`));
    // Run discovery in background — don't block boot. Monitors refresh after.
    runDiscovery('initial');
    // Periodic re-discovery so newly-hot tokens get snapshotted (and accumulation/
    // distribution deltas computed) without waiting for a restart. Fresh tokens
    // are skipped internally (hot-movers on a short clock, cold ones weekly), so
    // each pass only re-fetches what's actually due.
    const rediscoverHrs = Number(process.env.TEAM_REDISCOVER_HOURS ?? 6);
    if (rediscoverHrs > 0) setInterval(() => runDiscovery('periodic'), rediscoverHrs * 60 * 60_000).unref?.();
  }

  // ── On-chain sources ─────────────────────────────────────────────────────
  const sources = [];
  if (enableEth) {
    const eth = new EvmMonitor({
      chain: 'ethereum',
      rpcs: rpcs.ethereum.rpcs,
      pollIntervalMs: rpcs.ethereum.pollIntervalMs,
      maxBlocksPerCall: rpcs.ethereum.maxBlocksPerCall,
      walletsForChain: allWallets.evm,   // unified EVM CEX set — same wallets watched on ETH/BSC/Base

      universe,
      labelResolver,
      teamDiscovery,
      verbose: VERBOSE
    });
    await eth.start();
    sources.push(eth);
  }
  if (enableBsc) {
    const bsc = new EvmMonitor({
      chain: 'bsc',
      rpcs: rpcs.bsc.rpcs,
      pollIntervalMs: rpcs.bsc.pollIntervalMs,
      maxBlocksPerCall: rpcs.bsc.maxBlocksPerCall,
      walletsForChain: allWallets.evm,   // unified EVM CEX set (BSC-specific hot wallets are in here too)

      universe,
      labelResolver,
      teamDiscovery,
      verbose: VERBOSE
    });
    await bsc.start();
    sources.push(bsc);
  }
  if (enableBase && rpcs.base) {
    // Base (Coinbase L2). Now watches the SAME unified EVM CEX-wallet set as ETH/BSC
    // (the addresses are identical across EVM chains) plus any operator-added
    // insiders. Gated on ENABLE_BASE + a base RPC — set ENABLE_BASE=0 to skip the
    // extra on-chain polling if you don't want Base coverage.
    const base = new EvmMonitor({
      chain: 'base',
      rpcs: rpcs.base.rpcs,
      pollIntervalMs: rpcs.base.pollIntervalMs,
      maxBlocksPerCall: rpcs.base.maxBlocksPerCall,
      walletsForChain: allWallets.evm,   // unified EVM CEX set
      universe,
      labelResolver,
      teamDiscovery,
      verbose: VERBOSE
    });
    // The constructor already seeded paddedWallets from insiders loaded at
    // teamDiscovery.init(); start() boots the poll loop iff that set is non-empty.
    await base.start();
    sources.push(base);
  }
  if (enableSol) {
    // NOTE (audit §4 deferred): team-flow ("insider → CEX distribution")
    // tagging is EVM-ONLY. SolanaMonitor is intentionally NOT given
    // `teamDiscovery` — Solana top-holder discovery isn't implemented yet, so
    // Solana flows fire as ordinary CEX flows without the team-flow boost.
    const sol = new SolanaMonitor({
      rpcs: rpcs.solana.rpcs,
      pollIntervalMs: rpcs.solana.pollIntervalMs,
      walletsForChain: allWallets.solana,
      universe,
      labelResolver,
      verbose: VERBOSE
    });
    await sol.start();
    sources.push(sol);
  }
  if (sources.length === 0) {
    console.error('No on-chain sources enabled. Exiting.');
    process.exit(1);
  }

  // Free liquidity-heatmap equivalent: derive clusters from public L2
  // orderbook depth on Bybit / OKX / Binance perps. Disabled if
  // LIQUIDITY_CLUSTERS=0. Bonus only fires when a magnet sits 2-8% from
  // current price — close enough to be reached within trade horizons.
  const liquidityClusters = process.env.LIQUIDITY_CLUSTERS === '0' || !taService?.perpSymbolMap
    ? null
    : new LiquidityClusters({
        perpSymbolMap: taService.perpSymbolMap,
        verbose: VERBOSE,
        relayBaseUrl: RELAY_BASE_URL,
        relayAuthSecret: RELAY_AUTH_SECRET
      });
  if (liquidityClusters) {
    console.log(`[liq-clusters] orderbook heatmap enabled (${RELAY_BASE_URL ? 'binance+bybit aggregated via relay' : 'binance+bybit'}, cross-venue confirmation; okx fallback)`);
    // Fire and forget — the test logs success or failure inline so boot
    // isn't blocked. If it fails, scoring just silently skips the heatmap.
    liquidityClusters.selfTest().catch(err => console.warn(`[liq-clusters] self-test error: ${err.message}`));
  }

  // Global BTC market-regime detector (item G). Penalises signals that fight
  // BTC's macro trend (the dominant "right setup, wrong market" loss on alts).
  // Disabled with ENABLE_REGIME=0; needs taService (BTC perp OHLCV).
  // Always construct the monitor when TA is available (so /regime on|off can
  // toggle it at runtime). ENABLE_REGIME only sets the INITIAL on/off state —
  // =0 starts it disabled (polls but doesn't bias scoring) rather than absent.
  const regimeMonitor = !taService
    ? null
    : new RegimeMonitor({
        taService,
        pollIntervalMs: Number(process.env.REGIME_POLL_INTERVAL_MS ?? 5 * 60_000),
        highVolPct: Number(process.env.REGIME_HIGH_VOL_PCT ?? 1.2),
        enabled: process.env.ENABLE_REGIME !== '0',
        verbose: VERBOSE
      });
  if (regimeMonitor) await regimeMonitor.start();

  const conductor = new Conductor({
    universe,
    onchainSources: sources,
    prices,
    funding,
    liquidations,
    taService,
    liquidityClusters,
    liquidationHeatmap,
    teamDiscovery,                 // holder-concentration lookup (manipulation risk)
    regimeMonitor,
    regimePenalty: Number(process.env.REGIME_PENALTY ?? 1.0),
    minFlowUsd: MIN_FLOW_USD,
    minSignalScore: MIN_SIGNAL_SCORE,
    minSignalScorePinned: MIN_SIGNAL_SCORE_PINNED,
    minObservationScore: MIN_OBSERVATION_SCORE,
    confirmDropThreshold: Number(process.env.TA_CONFIRM_DROP_THRESHOLD ?? -2.5),
    levRiskBasis: Number(process.env.LEV_RISK_BASIS ?? 2),
    // Top-fade SHORTs are now OPT-IN (=== '1'): live sample = 22% WR. The gate fires a
    // fade on a single 5m flip into an overbought-but-still-ripping move while bypassing
    // the alignment cap, the structural-location guard, AND the ta-confirm veto — the
    // textbook "short the pump, get squeezed". Set ENABLE_EXHAUSTION_REVERSAL=1 to re-enable.
    enableExhaustionReversal: process.env.ENABLE_EXHAUSTION_REVERSAL === '1',          // HIGH-RISK watchlist top-fade shorts (22% WR — off by default)
    enableExhaustionReversalLong: process.env.ENABLE_EXHAUSTION_REVERSAL_LONG !== '0', // watchlist capitulation-bottom longs (buys the higher-WR long side)
    observeFundingExtreme: process.env.FUNDING_EXTREME_OBSERVATIONS === '1',  // default OFF — noisy radar entries
    cooldownMs: SIGNAL_COOLDOWN_MIN * 60_000,
    flowHistoryMs: WINDOW_MS * 4,        // 1h with default 15m WINDOW
    surgeHistoryMs: WINDOW_MS * 2,       // 30m
    liqHistoryMs: WINDOW_MS * 4          // 1h
  });
  conductor.start();

  // ── Observation alerts: solo flows ≥ threshold ───────────────────────────
  for (const src of sources) {
    src.on('flow', async (flow) => {
      if (!flow.direction) return;
      // Stable filter — USDT/USDC team→hot flows on Binance were flooding
      // observations with $5M-class transfers that are pure operational
      // CEX accounting, NOT directional signals. Stables NEVER fire here.
      if (isStableSymbol(flow.token.symbol)) return;

      const price = prices.getPrice(flow.token.coingeckoId);
      const usd = price ? flow.amount * price : null;
      if (!usd || usd < OBSERVE_MIN_FLOW_USD) return;

      // High-FDV gate — same rationale as the conductor's flow trigger:
      // a $1M flow on a $10B-FDV token is order-book noise, not a signal.
      // Team flows are exempt (they're high-signal regardless of FDV).
      if (!flow.teamFlow) {
        const universeInfo = universe.lookupByCgId(flow.token.coingeckoId);
        const fdv = universeInfo?.fdv;
        if (typeof fdv === 'number' && fdv >= 500_000_000) return;
      }

      const sideEmoji = flow.direction === 'long' ? '🟢' : '🔴';
      const usdStr = `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      const amountStr = flow.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
      const txLink = explorerTxUrl(flow.chain, flow.txHash);
      const bias = flow.direction.toUpperCase();
      const teamTag = flow.teamFlow ? '🚨 *Team flow* — ' : '';
      const msg =
`📊 *Observation* ${sideEmoji}  _(not a confirmed signal)_

${teamTag}*${flow.token.symbol}* — ${flow.exchange} *${flow.fromType}→${flow.toType}*
${amountStr} ${flow.token.symbol} (~${usdStr})  → ${bias} bias

Watching for a price surge confirmation… [tx](${txLink})`;
      await notifier.sendInfo(msg, 'flow');
    });
  }

  // ── Exchange-listing alerts ──────────────────────────────────────────────
  // New listings (especially Upbit / Bithumb) pump tokens within minutes.
  // Disabled with LISTING_MONITOR=0. Fires a high-priority LONG-bias alert.
  if (process.env.LISTING_MONITOR !== '0') {
    const listingMonitor = new ListingMonitor({
      pollIntervalMs: Number(process.env.LISTING_POLL_INTERVAL_MS ?? 2 * 60_000),
      cachePath: resolve(__dirname, '../logs/seen-listings.json'),
      universe,
      relayBaseUrl: process.env.BYBIT_BASE_URL || null,   // Upbit via Singapore relay (fallback; its Cloudflare 403s US IPs)
      relayAuthSecret: process.env.BYBIT_PROXY_SECRET || null,
      upbitProxyUrl: process.env.UPBIT_PROXY_URL || null, // Fly Tokyo forwarder /upbit — the only egress that clears Upbit's Cloudflare
      verbose: VERBOSE
    });
    listingMonitor.on('listing', async ({ exchange, symbol, title, url }) => {
      const onWatchlist = (() => {
        const cgId = universe.allCgIds?.().find(id => {
          const t = universe.lookupByCgId(id);
          return t?.symbol?.toUpperCase() === symbol.toUpperCase();
        });
        return cgId ? (universe.isFavored?.(cgId) ? ' _(on your watchlist)_' : '') : '';
      })();
      const msg =
`🚀 *NEW LISTING — ${symbol}*${onWatchlist}
*${exchange}* just announced a listing.

_Korean / major-exchange listings frequently pump within minutes. Consider a LONG, but expect volatility + a possible "sell the news" retrace._

📰 ${title}
[announcement](${url})  •  [chart](https://www.tradingview.com/symbols/${symbol}USDT/)`;
      console.log(`[listings] ALERT ${exchange} → ${symbol}`);
      await notifier.sendInfo(msg, 'listing');

      // Route the listing through the Conductor so it can fire a REAL, tracked,
      // autotrade-eligible signal (not just this heads-up). A listing is a
      // LONG-biased catalyst; the conductor adds TA/structure/heatmap confluence
      // and a trade plan. Exchange data often lags the announcement by a few
      // minutes (Coinalyze indexes the new perp late), so retry a few times —
      // the conductor's cooldown dedupes if an earlier attempt already fired.
      const LISTING_RETRIES = [0, 120_000, 300_000];   // now, +2min, +5min
      for (const delay of LISTING_RETRIES) {
        setTimeout(async () => {
          try {
            const ran = await conductor.evaluateListingTrigger(symbol, { exchange });
            if (VERBOSE) console.log(`[listings] conductor eval ${symbol} (${exchange}) — ${ran ? 'evaluated' : 'no tradeable data yet'}`);
          } catch (err) {
            console.warn(`[listings] conductor eval ${symbol} failed: ${err.message}`);
          }
        }, delay).unref?.();
      }
    });

    // Exchange RISK DESIGNATIONS (Binance Monitoring/Seed, Korean 유의 종목). Caution
    // alert only — a flagged token is high-risk / under review, a fade bias not a pump.
    listingMonitor.on('riskTag', async ({ exchange, symbol, tag, title, url }) => {
      const msg =
`⚠️ *RISK TAG — ${symbol}*
*${exchange}* flagged this token: *${tag}*.

_Exchange risk designations (Monitoring / Seed / 유의 종목) mark a token as high-risk or under review: elevated volatility and delisting risk. Treat as a CAUTION (fade bias), not a pump catalyst._

📰 ${title}
[announcement](${url})  •  [chart](https://www.tradingview.com/symbols/${symbol}USDT/)`;
      console.log(`[listings] RISK-TAG ${exchange} ${tag} → ${symbol}`);
      await notifier.sendInfo(msg, 'listing');
    });
    await listingMonitor.start();
  }

  // ── Token-unlock alerts ──────────────────────────────────────────────────
  // Large vesting cliffs flood circulating supply → typically sell pressure
  // into/around the unlock. Heads-up a week + a day out. Disable with
  // UNLOCK_MONITOR=0. Alerts-only — never touches autotrading. Hoisted so the
  // /unlock + /macro commands can query the live instances.
  let unlockMonitor = null, macroMonitor = null, newsMonitor = null;
  if (process.env.UNLOCK_MONITOR !== '0') {
    const fmtTokens = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.round(n).toLocaleString();
    const fmtUsd = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`;
    unlockMonitor = new UnlockMonitor({
      protocols: process.env.UNLOCK_PROTOCOLS ? process.env.UNLOCK_PROTOCOLS.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      minPct: Number(process.env.UNLOCK_MIN_PCT ?? 0.05),
      minUsd: Number(process.env.UNLOCK_MIN_USD ?? 25_000_000),
      refreshIntervalMs: Number(process.env.UNLOCK_REFRESH_MS ?? 12 * 60 * 60_000),
      pollIntervalMs: Number(process.env.UNLOCK_POLL_MS ?? 30 * 60_000),
      universe, prices, verbose: VERBOSE,
    });
    unlockMonitor.on('unlock', async (u) => {
      const onWatch = (u.geckoId && universe.isFavored?.(u.geckoId)) ? ' _(on your watchlist)_' : '';
      const usdStr = u.usdValue != null ? ` (~${fmtUsd(u.usdValue)})` : '';
      const pctStr = u.pctOfSupply != null ? `\n• *${(u.pctOfSupply * 100).toFixed(1)}% of circulating supply*` : '';
      const recip = (u.recipients ?? []).filter(r => r.amount > 0).map(r => r.recipient).slice(0, 3).join(', ');
      const when = u.daysUntil <= 0 ? 'today' : u.daysUntil === 1 ? 'in ~1 day' : `in ~${u.daysUntil} days`;
      const tokenLabel = u.ticker ? ` ${u.ticker}` : '';
      const chart = u.ticker ? `  •  [chart](https://www.tradingview.com/symbols/${u.ticker}USDT/)` : '';
      const msg =
`🔓 *TOKEN UNLOCK — ${u.symbol}*${onWatch}  _(${when})_
A vesting cliff unlocks soon — fresh supply hits the market.

• Unlocking: *${fmtTokens(u.tokens)}${tokenLabel}*${usdStr}${pctStr}${recip ? `\n• To: ${recip}` : ''}

_Cliff unlocks usually mean sell pressure into/around the date — caution on longs, a SHORT setup may form. (A well-telegraphed unlock can also be "priced in.")_

[unlock schedule](https://defillama.com/unlocks/${u.slug})${chart}`;
      console.log(`[unlocks] ALERT ${u.symbol} ${u.leadLabel} — ${fmtTokens(u.tokens)} (${u.pctOfSupply != null ? (u.pctOfSupply * 100).toFixed(1) + '%' : '?'}${u.usdValue != null ? ', ' + fmtUsd(u.usdValue) : ''})`);
      await notifier.sendInfo(msg, 'unlock');
    });
    await unlockMonitor.start();
  }

  // ── Macro / Fed-news alerts (FOMC, CPI) ──────────────────────────────────
  // Scheduled high-impact prints whip crypto. Heads-up 1 day + 1 hour out, then
  // "it's live now" at release. Disable with MACRO_MONITOR=0. Alerts-only.
  if (process.env.MACRO_MONITOR !== '0') {
    macroMonitor = new MacroMonitor({
      calendarPath: resolve(__dirname, '../config/macro-calendar.json'),
      calendarUrl: process.env.MACRO_CALENDAR_URL || null,
      pollIntervalMs: Number(process.env.MACRO_POLL_MS ?? 5 * 60_000),
      fredApiKey: process.env.FRED_API_KEY || null,
      verbose: VERBOSE,
    });
    macroMonitor.on('macro', async (m) => {
      const emoji = m.type === 'FOMC' ? '🏦' : '📊';
      const phrase = m.isNow ? 'OUT NOW' : leadPhrase(m.lead).replace(/^in /, '').toUpperCase();
      const link = m.type === 'FOMC'
        ? '[Fed statement](https://www.federalreserve.gov/newsevents/pressreleases.htm)  •  [CME FedWatch](https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html)'
        : '[BLS CPI](https://www.bls.gov/cpi/)';
      const rateStr = (m.fedRate && (m.fedRate.lower != null || m.fedRate.upper != null))
        ? `\nFed funds target: *${m.fedRate.lower ?? '?'}%–${m.fedRate.upper ?? '?'}%*` : '';
      const head = m.isNow
        ? `${emoji} *${m.title} — OUT NOW* 🚨`
        : `${emoji} *${m.title}* — ${phrase}`;
      const body = m.isNow
        ? `The decision/print just landed — expect a sharp volatility spike.${rateStr}`
        : `High-impact macro event ${leadPhrase(m.lead)}.`;
      const msg =
`${head}
${body}

_Macro events whip crypto hard (both directions). Open auto-trades + their TP/SL keep running; consider holding off on FRESH entries until the dust settles._

${link}`;
      console.log(`[macro] ALERT ${m.type} ${m.leadLabel} — ${m.title}`);
      await notifier.sendInfo(msg, 'macro');
    });
    await macroMonitor.start();
  }

  // ── Crypto news (free RSS feeds) ─────────────────────────────────────────
  // /news (menu button) always works on-demand. High-impact PUSH alerts are
  // opt-in (NEWS_MONITOR_PUSH=1) so they don't spam and so the A/B stays clean.
  // Always constructed (so the /news command has a source); the monitor itself
  // can be skipped entirely with NEWS_MONITOR=0. Alerts-only — never autotrades.
  if (process.env.NEWS_MONITOR !== '0') {
    newsMonitor = new NewsMonitor({
      feeds: process.env.NEWS_FEEDS ? process.env.NEWS_FEEDS.split(',').map(s => s.trim()).filter(Boolean) : null,
      pollIntervalMs: Number(process.env.NEWS_POLL_MS ?? 5 * 60_000),
      pushHighImpact: process.env.NEWS_MONITOR_PUSH === '1',
      verbose: VERBOSE,
    });
    newsMonitor.on('news', async (n) => {
      const tagStr = (n.tags ?? []).length ? ` _[${n.tags.join(', ')}]_` : '';
      const src = n.source ? ` · ${n.source}` : '';
      const msg =
`📰 *Crypto news*${tagStr}
*${n.title}*${src}

_High-impact headline (hacks, regulation, ETF, listings, macro) can move price fast. Treat as context, not a confirmed signal — open auto-trades keep their TP/SL._

[read more](${n.url})`;
      console.log(`[news] ALERT [${(n.tags ?? []).join(',')}] ${n.title}`);
      await notifier.sendInfo(msg, 'news');
    });
    await newsMonitor.start();
  }

  // ── Liquidation observation alerts ───────────────────────────────────────
  if (liquidations) {
    liquidations.on('liquidation', async (ev) => {
      const sideEmoji = ev.bias === 'long' ? '🟢' : '🔴';
      const dominantStr = `$${ev.dominantUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      const totalStr = `$${ev.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      const sideWord = ev.dominantSide === 'shorts' ? 'shorts wiped' : 'longs wiped';
      const implication = ev.bias === 'long'
        ? 'forced buying → short squeeze (LONG bias)'
        : 'forced selling → may cascade lower (SHORT bias)';
      const chart = `https://www.tradingview.com/symbols/${ev.symbol}USDT/`;
      // Size relative to open interest = the real "did this move price" signal.
      const oiLine = (ev.oiFrac != null && isFinite(ev.oiFrac))
        ? `\n= *${(ev.oiFrac * 100).toFixed(2)}% of open interest*${ev.basis === 'oi%' ? ' ⚡' : ''}`
        : '';
      const msg =
`💥 *Liquidation* ${sideEmoji}  _(not a confirmed signal)_

*${ev.symbol}* — ${dominantStr} ${sideWord} in 1m
Total liquidations: ${totalStr}${oiLine}
Implication: ${implication}

[chart](${chart})`;
      await notifier.sendInfo(msg, 'liquidation');
    });
  }

  // ── Full signals ─────────────────────────────────────────────────────────
  // ── Activity counters for diagnostic stats ─────────────────────────────
  const stats = { surges: 0, flows: 0, liquidations: 0, signals: 0, observations: 0, since: Date.now() };
  prices.on('surge', () => stats.surges++);
  // Futures volume-spike → run a BOTH-SIDES conductor eval (direction from funding /
  // manipulation / L-S confluence, not the spike). Opt-in via ENABLE_VOLUME_SPIKE.
  if (prices.volSpikeEnabled) {
    prices.on('volumeSpike', async ({ token }) => {
      try { await conductor.evaluateTokenAndMaybeEmit({ symbol: token.symbol, source: 'volumeSpike' }); }
      catch (err) { console.warn(`[vol-spike] eval ${token.symbol} failed: ${err.message}`); }
    });
  }
  for (const src of sources) src.on('flow', () => stats.flows++);
  if (liquidations) liquidations.on('liquidation', () => stats.liquidations++);

  // ── Per-signal accuracy tracking ──────────────────────────────────────────
  // Logs each fired signal to logs/signals.jsonl with entry/SL/TP/strength,
  // and mirrors to Google Sheets via Apps Script if GOOGLE_SHEET_URL is set.
  // Background resolver records outcomes (WIN_TP1/2/3, LOSS, expiry).
  const sheetLogger = new SheetLogger({ scriptUrl: process.env.GOOGLE_SHEET_URL });
  if (sheetLogger.enabled) console.log('[sheet] mirroring signals to Google Sheets');

  const signalTracker = new SignalTracker({
    path: resolve(__dirname, '../logs/signals.jsonl'),
    priceMonitor: prices,
    taService,        // enables wick-aware resolution via Coinalyze 1m OHLCV bars
    sheetLogger,
    checkIntervalMs: Number(process.env.SIGNAL_RESOLVE_INTERVAL_MS ?? 5 * 60_000)
  });
  await signalTracker.init();   // load signals from Postgres (or file) before resolving
  signalTracker.start();
  conductor.setSignalTracker(signalTracker);     // enables open-position lockout

  // ── Auto-trading (isolated module) ───────────────────────────────────────
  // The trader is ALWAYS created so it can be controlled live from Telegram
  // (/autotrade paper|live|off|on). AUTOTRADE in .env just sets the INITIAL
  // mode. It holds BOTH a paper broker and (if keys present) a live Bybit
  // broker, and switches between them at runtime. Reads conductor signals
  // only — never affects signal logic.
  let autoTrader = null;
  let userAccounts = null;
  {
    // Symbol→price resolver (price monitor is keyed by cgId): "BTCUSDT" → price.
    const priceBySymbol = (bybitSym) => {
      const base = bybitSym.replace(/USDT$/i, '').toUpperCase();
      for (const cgId of universe.allCgIds?.() ?? []) {
        const t = universe.lookupByCgId(cgId);
        if (t?.symbol?.toUpperCase() === base) return prices.getPrice(cgId);
      }
      return null;
    };

    const paperBroker = new PaperBroker({
      startBalance: Number(process.env.PAPER_BALANCE_USD ?? 1000),
      priceFn: priceBySymbol,
      verbose: VERBOSE,
      statePath: resolve(__dirname, '../logs/paper-positions.json')   // survive restarts
    });

    // Live broker only if keys are configured. Without keys, live mode is
    // simply unavailable (/autotrade live will say so) but paper still works.
    let liveBroker = null;
    if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
      liveBroker = new BybitExchange({
        apiKey: process.env.BYBIT_API_KEY,
        apiSecret: process.env.BYBIT_API_SECRET,
        testnet: process.env.BYBIT_TESTNET === '1',
        proxyUrl: process.env.BYBIT_PROXY || null,
        baseUrl: process.env.BYBIT_BASE_URL || null,
        proxyAuthSecret: process.env.BYBIT_PROXY_SECRET || null,
        verbose: VERBOSE
      });
    }

    const initialMode = (process.env.AUTOTRADE ?? 'off').toLowerCase();
    const riskEngine = new RiskEngine({
      riskPct: Number(process.env.AUTOTRADE_RISK_PCT ?? 2),
      maxPositionUsd: Number(process.env.AUTOTRADE_MAX_POSITION_USD ?? 50),
      maxConcurrent: Number(process.env.AUTOTRADE_MAX_CONCURRENT ?? 5),
      dailyLossLimitPct: Number(process.env.AUTOTRADE_DAILY_LOSS_PCT ?? 10),
      maxLeverage: Number(process.env.AUTOTRADE_MAX_LEVERAGE ?? 20),
      verbose: VERBOSE
    });
    const tradeStore = new TradeStore({ path: resolve(__dirname, '../logs/autotrades.jsonl') });
    await tradeStore.init();    // load journal from Postgres (or file) before the monitor runs
    await paperBroker.init();   // load paper positions from Postgres (or file)
    autoTrader = new AutoTrader({
      mode: initialMode,
      liveBroker,
      paperBroker,
      riskEngine,
      store: tradeStore,
      notifier,
      notifyChatId: TELEGRAM_CHAT_ID,   // autotrade alerts → operator only, not broadcast
      logTag: 'op',                     // tags this account's lines in the shared autotrade log
      shortOnly: process.env.AUTOTRADE_SHORT_ONLY === '1',
      tpTarget: process.env.AUTOTRADE_TP_TARGET ?? 'tp2',
      minAlignment: Number(process.env.AUTOTRADE_MIN_ALIGNMENT ?? 0),
      minAlignmentWeight: Number(process.env.AUTOTRADE_MIN_ALIGNMENT_WEIGHT ?? 0),
      skipScalp: process.env.AUTOTRADE_SKIP_SCALP !== '0',   // default: SCALPs are signals-only
      trailing: process.env.AUTOTRADE_TRAILING !== '0',      // default: hold tp3, ratchet SL after TP1/TP2
      tpPercent: Number(process.env.AUTOTRADE_TP_PERCENT ?? 0),
      paperMarginUsd: Number(process.env.AUTOTRADE_PAPER_MARGIN_USD ?? 0),
      liveMarginUsd: Number(process.env.AUTOTRADE_MARGIN_USD ?? 0),
      configPath: resolve(__dirname, '../logs/autotrade-config.json'),   // persists margins/exit (file mode)
      configKey: 'operator',   // persists margins/exit to Neon so they survive a Render redeploy
      dayStateKey: 'operator', // persists the daily-loss counter so it can't reset on restart
      monitorIntervalMs: Number(process.env.AUTOTRADE_MONITOR_MS ?? 30_000),
      armed: process.env.AUTOTRADE_ARMED === '1',
      verbose: VERBOSE
    });
    await autoTrader.initConfig();   // restore persisted margins/exit from Postgres (or file)
    await autoTrader.initDayState(); // restore today's daily-loss counter (if same UTC day)
    autoTrader.setPriceBySymbol(priceBySymbol);
    autoTrader.start();

    // ── Multi-user auto-trading ────────────────────────────────────────────
    // Any subscriber can /connect their OWN Bybit keys (encrypted at rest) and
    // the bot fans every signal out to their account too — sized off their own
    // balance, alerted in their own DM, self-armed. Disabled (keys not stored)
    // unless KEY_ENCRYPTION_SECRET is set. Reuses the same relay as the operator.
    userAccounts = new UserAccounts({
      notifier,
      priceBySymbol,
      logsDir: resolve(__dirname, '../logs'),
      relayBaseUrl: process.env.BYBIT_BASE_URL || null,
      relayAuthSecret: process.env.BYBIT_PROXY_SECRET || null,
      riskDefaults: {
        riskPct: Number(process.env.AUTOTRADE_RISK_PCT ?? 2),
        maxPositionUsd: Number(process.env.AUTOTRADE_MAX_POSITION_USD ?? 50),
        maxConcurrent: Number(process.env.AUTOTRADE_MAX_CONCURRENT ?? 5),
        dailyLossLimitPct: Number(process.env.AUTOTRADE_DAILY_LOSS_PCT ?? 10),
        maxLeverage: Number(process.env.AUTOTRADE_MAX_LEVERAGE ?? 20)
      },
      // SAME signal-quality gates as the operator's account, so users don't
      // auto-trade lower-alignment setups the operator's gate rejects.
      gates: {
        minAlignment: Number(process.env.AUTOTRADE_MIN_ALIGNMENT ?? 0),
        minAlignmentWeight: Number(process.env.AUTOTRADE_MIN_ALIGNMENT_WEIGHT ?? 0),
        skipScalp: process.env.AUTOTRADE_SKIP_SCALP !== '0',
        shortOnly: process.env.AUTOTRADE_SHORT_ONLY === '1'
      },
      monitorIntervalMs: Number(process.env.AUTOTRADE_MONITOR_MS ?? 30_000),
      verbose: VERBOSE
    });
    await userAccounts.start();
  }

  // Broadcast TP/SL outcomes to subscribers so they hear when a previously-
  // alerted trade resolves (without having to /open). Each event triggers
  // one notifier.sendInfo() — broadcasts through the same channels as
  // signals / observations.
  signalTracker.on('resolved', async (sig) => {
    try {
      // Feed losses back into the Conductor so it can suppress same-side
      // re-entries on tokens that just stopped out.
      conductor.recordLoss(sig);

      const text = notifier.formatOutcome(sig);
      console.log(`[outcome] ${sig.symbol} ${sig.side} → ${sig.outcome}`);
      await notifier.sendInfo(text);
    } catch (err) {
      console.warn(`[outcome] broadcast failed: ${err.message}`);
    }
  });

  // Progressive TP alerts — TP1/TP2 hit while the trade stays open for the next
  // target. Fires as each level is reached (possibly hours apart); the terminal
  // close still comes through 'resolved' above.
  signalTracker.on('tpProgress', async (sig) => {
    try {
      console.log(`[tp] ${sig.symbol} ${sig.side} → TP${sig.tpLevel} hit (open)`);
      await notifier.sendInfo(notifier.formatTpProgress(sig));
    } catch (err) {
      console.warn(`[tp] broadcast failed: ${err.message}`);
    }
  });

  conductor.on('signal', async (signal) => {
    // record() returns false when it's a duplicate of an already-open signal
    // (same symbol+side). In that case DON'T broadcast or mirror — otherwise
    // the user gets the same alert repeatedly and the Sheet fills with dupes.
    const recorded = signalTracker.record(signal);
    if (!recorded) {
      if (process.env.VERBOSE === '1') console.log(`[SIGNAL] suppressed duplicate ${signal.side} ${signal.token.symbol}`);
      return;
    }
    stats.signals++;
    console.log(`[SIGNAL] ${signal.side} ${signal.token.symbol} score=${signal.strength.total.toFixed(2)} (${signal.strength.label}) trigger=${signal.trigger.type}`);
    sheetLogger.appendSignal(signal).catch(() => {});
    await notifier.sendSignal(signal);
    // Auto-trade the same (non-duplicate) signal, if enabled. Fire-and-forget
    // so a slow exchange call never blocks the alert broadcast.
    autoTrader?.onSignal(signal).catch(err => console.warn(`[autotrade] ${err.message}`));
    // Fan the signal out to every connected USER's account too (each gates
    // itself on armed/risk; disarmed users are no-ops).
    userAccounts?.onSignal(signal);
  });

  conductor.on('observation', async (obs) => {
    stats.observations++;
    console.log(`[OBS] ${obs.side} ${obs.token.symbol} score=${obs.strength.total.toFixed(2)} trigger=${obs.trigger.type}`);
    await notifier.sendObservation(obs);
  });

  // Raw insider-sell transfer alert — fires the instant a tracked insider's
  // qualified sell is seen, IN ADDITION to any confluence signal the same flow
  // may produce. Labelled like an on-chain alert bot (amount, USD, network,
  // venue, explorer link).
  conductor.on('insiderSell', async ({ text, flow }) => {
    console.log(`[INSIDER-SELL] ${flow.token?.symbol} ${flow.exchange ?? ''} ${flow.txHash ?? ''}`);
    try { await notifier.sendInfo(text, 'insider'); }
    catch (err) { console.warn(`[insider-sell] broadcast failed: ${err.message}`); }
  });

  // NOTE: there is intentionally NO standalone volume-spike notification. Volume
  // and price work hand-in-hand INSIDE the signal engine: a 1m price surge is
  // suppressed unless volume ≥ 1.5× the 60-bar average and upweighted at ≥2×/≥3×
  // (see conductor #onSurge). Raw volume-only alerts were noise, so they're gone.


  // ── On-demand chat commands (/analyze, /stats, /help) ────────────────────
  if (process.env.TELEGRAM_COMMANDS !== '0') {
    const cexHoldings = new CexHoldings({
      rpcsByChain: { ethereum: rpcs.ethereum.rpcs, bsc: rpcs.bsc.rpcs },
      walletsByChain: allWallets
    });

    // Per-CEX holdings leaderboard — opt-in hourly background job. Multicall3-batched
    // (~a dozen RPC calls, not thousands), cached in Neon so the menu is instant and
    // survives restarts. CEX_HOLDINGS_REFRESH_MS=0 (default) disables the refresh; the
    // menu then shows whatever's cached (or prompts to enable it).
    const HOLDINGS_LB_MS = Number(process.env.CEX_HOLDINGS_REFRESH_MS ?? 0);
    const HOLDINGS_LB_TOPSET = Number(process.env.CEX_HOLDINGS_TOKEN_SET ?? 300);
    try {
      const cached = await kvGet('holdings-lb', 'latest');
      if (cached?.byExchange) {
        cexHoldings.setLeaderboard(cached);
        console.log(`[holdings-lb] restored cached leaderboard (${Object.keys(cached.byExchange).length} exchanges, ${Math.round((Date.now() - (cached.computedAt || 0)) / 60000)}min old)`);
      }
    } catch { /* no cache yet */ }
    const buildHoldingsLbTokenSet = () => {
      const evm = universe.allCgIds()
        .map(cgId => { const t = universe.lookupByCgId(cgId); return (t && (t.chains?.ethereum?.address || t.chains?.bsc?.address)) ? { ...t, cgId, price: prices.getPrice(cgId) } : null; })
        .filter(Boolean);
      const favored = evm.filter(t => universe.isFavored?.(t.cgId));   // pinned + hot — always in (catches cornered microcaps like NOM)
      const byMc = evm.filter(t => !universe.isFavored?.(t.cgId)).sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, HOLDINGS_LB_TOPSET);
      const seen = new Set(), set = [];
      for (const t of [...favored, ...byMc]) { if (!seen.has(t.cgId)) { seen.add(t.cgId); set.push(t); } }
      return set;
    };
    const refreshHoldingsLb = async () => {
      const tokens = buildHoldingsLbTokenSet();
      if (!tokens.length) return;
      const lb = await cexHoldings.computeLeaderboard({ tokens, topN: 20 });
      await kvSet('holdings-lb', 'latest', lb).catch(() => {});
      console.log(`[holdings-lb] refreshed — ${Object.keys(lb.byExchange).length} exchanges over ${tokens.length} tokens`);
    };
    if (HOLDINGS_LB_MS > 0) {
      refreshHoldingsLb().catch(err => console.warn(`[holdings-lb] initial refresh failed: ${err.message}`));
      const iv = setInterval(() => refreshHoldingsLb().catch(err => console.warn(`[holdings-lb] refresh failed: ${err.message}`)), HOLDINGS_LB_MS);
      iv.unref?.();
      console.log(`[holdings-lb] per-CEX leaderboard refreshing every ${Math.round(HOLDINGS_LB_MS / 60000)}min (top ${HOLDINGS_LB_TOPSET} + favored tokens, %-of-supply ranked)`);
    }
    // Subscription/billing — self-gating (does nothing unless BILLING_ENABLED=1).
    // Isolated in /billing so it can't disrupt the trading bot until you flip it on.
    const billing = new BillingService({ notifier, verbose: VERBOSE });
    try { await billing.start(); } catch (err) { console.error(`[billing] failed to start: ${err.message}`); }

    const commands = new BotCommands({
      notifier,
      subscribers,
      billing,
      universe,
      prices,
      funding,
      conductor,
      signalTracker,
      cexHoldings,
      taService,
      pinned,
      userPinnedPath,
      userPinned,
      operatorChatId: TELEGRAM_CHAT_ID,
      fundingIntervalHrs: FUNDING_INTERVAL_HRS,
      fundingLeadersMinOi: FUNDING_LEADERS_MIN_OI,
      autoTrader,
      userAccounts,
      liquidityClusters,
      liquidationHeatmap,
      regimeMonitor,
      teamDiscovery,
      unlockMonitor,
      macroMonitor,
      newsMonitor,
      refreshTeamIndex: () => { for (const s of sources) if (typeof s.refreshTeamIndex === 'function') s.refreshTeamIndex(); }
    });
    notifier.attachCommands(commands);
    const llm = llmStatus();
    if (llm) console.log(`[llm] enabled — ${llm.base} · model ${llm.model} · /brief AI narration ${llm.briefOn ? 'ON' : 'off (LLM_BRIEF=1 to enable)'}`);
    else console.log('[llm] disabled (no HYPERBOLIC_API_KEY) — /brief uses the template');
  }

  // Log activity stats every 10 min so user can see what's being detected
  // even when nothing crosses the alert threshold.
  setInterval(() => {
    const mins = Math.round((Date.now() - stats.since) / 60_000);
    console.log(
      `[stats] last ${mins}min — surges:${stats.surges} flows:${stats.flows} ` +
      `liqs:${stats.liquidations} → observations:${stats.observations} signals:${stats.signals}`
    );
    stats.surges = 0; stats.flows = 0; stats.liquidations = 0;
    stats.signals = 0; stats.observations = 0; stats.since = Date.now();
  }, 10 * 60_000).unref();

  // ── Funding Leaders periodic alert ───────────────────────────────────────
  if (FUNDING_LEADERS_MIN > 0) {
    const LEADERS_WINDOW = 5;       // entries per message
    const LEADERS_MAX_DEPTH = 20;   // cycle 1-5, 6-10, 11-15, 16-20, back to 1-5 (4 calls ~ 2h on 30min cadence)
    let leadersOffset = 0;

    const sendLeaders = async () => {
      if (!funding) {
        console.log('[leaders] skipped — no funding source');
        return;
      }
      const populated = funding.bySymbol?.size ?? 0;
      if (populated === 0) {
        console.log('[leaders] skipped — funding monitor has no data yet (polls in progress)');
        return;
      }
      let leaders = fundingLeaders(funding, LEADERS_WINDOW, 1, FUNDING_LEADERS_MIN_OI, leadersOffset);
      if (!leaders || (leaders.mostNegative.length === 0 && leaders.mostPositive.length === 0)) {
        // Offset exceeded available entries — reset and try again
        leadersOffset = 0;
        leaders = fundingLeaders(funding, LEADERS_WINDOW, 1, FUNDING_LEADERS_MIN_OI, 0);
      }
      if (!leaders) {
        console.log(`[leaders] no markets met threshold (${populated} tokens loaded, OI ≥ $${FUNDING_LEADERS_MIN_OI.toLocaleString()})`);
        return;
      }
      const msg = formatFundingLeaders(leaders, FUNDING_INTERVAL_HRS);
      if (msg) await notifier.sendInfo(msg, 'funding');

      // Fire top-3 of the CURRENT slice through the Conductor — rotates with
      // the window so we explore tokens beyond the persistent top of the
      // leaderboard.
      for (const e of leaders.mostNegative.slice(0, 3)) {
        await conductor.evaluateFundingTrigger(e.symbol, 'LONG', e.avg);
      }
      for (const e of leaders.mostPositive.slice(0, 3)) {
        await conductor.evaluateFundingTrigger(e.symbol, 'SHORT', e.avg);
      }

      // Advance offset for next call. Wrap when we run past the depth or the
      // available eligible set (whichever is smaller).
      const maxOffset = Math.min(LEADERS_MAX_DEPTH, leaders.eligibleCount) - LEADERS_WINDOW;
      leadersOffset += LEADERS_WINDOW;
      if (leadersOffset > maxOffset) leadersOffset = 0;
    };
    // First one ~ 2 min after boot (give funding monitor time to populate)
    setTimeout(sendLeaders, 2 * 60_000);
    setInterval(sendLeaders, FUNDING_LEADERS_MIN * 60_000).unref();
  }

  // ── Periodic top-movers scan ─────────────────────────────────────────────
  // Every MOVERS_SCAN_MIN: take top-N gainers + losers by 24h % change, mark
  // them as "hot movers" (favored thresholds), then evaluate each token via
  // the Conductor. Anything crossing the signal/observation threshold fires
  // as a regular signal/observation through the existing channels.
  //
  // The digest itself is sent as a single info message so subscribers see
  // what's hot even if no token had enough confluence to fire a real signal.
  if (MOVERS_SCAN_MIN > 0) {
    // Rotating window into the deeper leaderboard. Advances MOVERS_TOP_N each
    // scan and wraps at MOVERS_DEPTH, so over a couple of scans the whole
    // top-MOVERS_DEPTH is covered without raising the per-scan API cost.
    let moversOffset = 0;
    const sendMoversScan = async () => {
      const deep = prices.getTopMovers(MOVERS_DEPTH);
      if (deep.gainers.length === 0 && deep.losers.length === 0) {
        console.log('[movers] skipped — no 24h % data yet');
        return;
      }
      // Slice the current rotating window from each side; wrap when past the end.
      const maxLen = Math.max(deep.gainers.length, deep.losers.length);
      if (moversOffset >= maxLen) moversOffset = 0;
      const win = (arr) => arr.slice(moversOffset, moversOffset + MOVERS_TOP_N);
      const gainers = win(deep.gainers);
      const losers  = win(deep.losers);
      const all = [...gainers, ...losers];
      if (all.length === 0) { moversOffset = 0; return; }

      // Mark hot — favored thresholds apply for the next cycle
      universe.setHotMovers(all.map(e => e.cgId));

      const fmtRow = (e, i) => {
        const sign = e.pct >= 0 ? '+' : '';
        const price = prices.getPrice(e.cgId);
        const priceStr = price != null
          ? `$${price.toLocaleString(undefined, { maximumSignificantDigits: 6 })}`
          : '—';
        return `#${moversOffset + i + 1} *${e.symbol}* ${sign}${e.pct.toFixed(2)}% — ${priceStr}`;
      };
      const rangeStr = moversOffset > 0 ? ` _(rank ${moversOffset + 1}–${moversOffset + MOVERS_TOP_N})_` : '';
      const digest =
`🔥 *Top movers — last 24h*${rangeStr}
_Hot-mover status applied: lower surge/flow thresholds for these tokens until next scan._

🟢 *Gainers:*
${gainers.map(fmtRow).join('\n') || '_none_'}

🔴 *Losers:*
${losers.map(fmtRow).join('\n') || '_none_'}

_Evaluating each for confluence…_`;
      await notifier.sendInfo(digest, 'movers');

      // Evaluate each mover — emits signal/observation through normal channels
      // if confluence is strong enough. Sequential with brief pacing to avoid
      // bursting Coinalyze API.
      for (const e of all) {
        try {
          await conductor.evaluateTokenAndMaybeEmit({ symbol: e.symbol, source: 'movers' });
        } catch (err) {
          console.warn(`[movers] eval ${e.symbol} failed: ${err.message}`);
        }
        await sleep(500);
      }
      console.log(`[movers] scan done — ${gainers.length}↑ / ${losers.length}↓ (rank ${moversOffset + 1}–${moversOffset + MOVERS_TOP_N}) marked hot`);
      // Warm the leverage-liquidation heatmap for these hot tokens (bounded) so
      // the Conductor's peek() has fresh magnet data without any hot-path fetch.
      // The recompute also runs liquidity-SWEEP detection vs the prior snapshot; any
      // token that just swept one side is re-evaluated as a fade-reversal candidate
      // (the "take liquidity both sides" pattern → fade toward the opposite cluster).
      if (liquidationHeatmap?.warm) {
        liquidationHeatmap.warm(all.map(e => e.symbol), 8)
          .then(async (n) => {
            if (n) console.log(`[liq-map] warmed ${n} hot-mover heatmap(s) for conductor scoring`);
            if (process.env.LIQ_SWEEP_DETECT === '0' || !liquidationHeatmap.recentSweep) return;
            for (const e of all) {
              const sweep = liquidationHeatmap.recentSweep(e.symbol, 10 * 60_000);   // only act on FRESH sweeps
              if (!sweep) continue;
              console.log(`[liq-sweep] ${e.symbol} ${sweep.side} swept ($${(sweep.sweptUsd / 1e6).toFixed(1)}M) → checking ${sweep.fadeSide} reversal`);
              try { await conductor.evaluateTokenAndMaybeEmit({ symbol: e.symbol, source: 'liqSweep' }); }
              catch (err) { console.warn(`[liq-sweep] eval ${e.symbol} failed: ${err.message}`); }
              await sleep(500);
            }
          })
          .catch(() => {});
      }
      // Advance the rotating window for the next scan; wrap at the deep pool end.
      moversOffset += MOVERS_TOP_N;
      if (moversOffset >= MOVERS_DEPTH) moversOffset = 0;
    };
    // First scan ~3 min after boot (let prices populate one cycle)
    setTimeout(sendMoversScan, 3 * 60_000);
    setInterval(sendMoversScan, MOVERS_SCAN_MIN * 60_000).unref();
  }

  // ── Periodic top-MC majors scan ──────────────────────────────────────────
  // Trigger-driven analysis only touches a coin when it surges/gets flow, so the
  // liquid MAJORS (top by market cap) — where TA is most reliable, vs the
  // manipulated low-cap floats where it's noise — go unanalysed unless they pop.
  // This proactively runs the FULL confluence engine over the top-MC names at
  // NORMAL thresholds (not hot-marked, so only genuine score fires), rotating a
  // window through MAJORS_DEPTH to bound API cost. No digest (the list is static).
  // MAJORS_SCAN_MIN=0 disables.
  const MAJORS_SCAN_MIN = Number(process.env.MAJORS_SCAN_MIN ?? 60);
  const MAJORS_TOP_N = Number(process.env.MAJORS_TOP_N ?? 20);
  const MAJORS_DEPTH = Number(process.env.MAJORS_DEPTH ?? 60);
  if (MAJORS_SCAN_MIN > 0) {
    let majorsOffset = 0;
    const sendMajorsScan = async () => {
      const ranked = universe.allCgIds()
        .map(cgId => universe.lookupByCgId(cgId))
        .filter(t => t && typeof t.marketCapRank === 'number' && t.marketCapRank > 0)
        .sort((a, b) => a.marketCapRank - b.marketCapRank)
        .slice(0, MAJORS_DEPTH);
      if (ranked.length === 0) { console.log('[majors] skipped — no market-cap-ranked tokens yet'); return; }
      if (majorsOffset >= ranked.length) majorsOffset = 0;
      const window = ranked.slice(majorsOffset, majorsOffset + MAJORS_TOP_N);
      let evaluated = 0;
      for (const t of window) {
        try { await conductor.evaluateTokenAndMaybeEmit({ symbol: t.symbol, source: 'majors' }); evaluated++; }
        catch (err) { console.warn(`[majors] eval ${t.symbol} failed: ${err.message}`); }
        await sleep(500);
      }
      console.log(`[majors] scan done — evaluated ${evaluated} top-MC names (rank ${majorsOffset + 1}–${majorsOffset + window.length})`);
      majorsOffset += MAJORS_TOP_N;
      if (majorsOffset >= MAJORS_DEPTH) majorsOffset = 0;
    };
    setTimeout(sendMajorsScan, 4 * 60_000);
    setInterval(sendMajorsScan, MAJORS_SCAN_MIN * 60_000).unref();
    console.log(`[majors] top-MC scan enabled — ${MAJORS_TOP_N}/scan through top ${MAJORS_DEPTH} every ${MAJORS_SCAN_MIN}min`);
  }

  // ── Proactive WATCHLIST scan ─────────────────────────────────────────────
  // Reactive triggers (surge/flow/liquidation) only fire AFTER a token moves, so
  // a watchlist token coiling into a setup gets no signal until it blows off (the
  // WCT case: no early long, then a surge LONG at the +20% top → SL). This scan
  // evaluates EVERY pinned/watchlist token on its own merits every
  // WATCHLIST_SCAN_MIN, so a building setup (structure + flow + funding) can fire
  // EARLY at the favored (lower) threshold instead of waiting for a momentum
  // spike. Set WATCHLIST_SCAN_MIN=0 to disable.
  const WATCHLIST_SCAN_MIN = Number(process.env.WATCHLIST_SCAN_MIN ?? 15);
  if (WATCHLIST_SCAN_MIN > 0) {
    const sendWatchlistScan = async () => {
      const pinned = universe.allCgIds()
        .filter(cgId => universe.isPinned?.(cgId))
        .map(cgId => universe.lookupByCgId(cgId))
        .filter(t => t?.symbol);
      if (pinned.length === 0) return;
      let evaluated = 0;
      for (const t of pinned) {
        try { await conductor.evaluateTokenAndMaybeEmit({ symbol: t.symbol, source: 'watchlist' }); evaluated++; }
        catch (err) { console.warn(`[watchlist] eval ${t.symbol} failed: ${err.message}`); }
        await sleep(800);   // pace the per-token TA fetches
      }
      console.log(`[watchlist] scan done, evaluated ${evaluated} pinned token(s) for forming setups`);
    };
    setTimeout(sendWatchlistScan, 6 * 60_000);   // first scan at +6min, after boot settles
    setInterval(sendWatchlistScan, WATCHLIST_SCAN_MIN * 60_000).unref();
    console.log(`[watchlist] proactive setup scan enabled, every ${WATCHLIST_SCAN_MIN}min`);
  }

  // ── Boot message ─────────────────────────────────────────────────────────
  const chainList = sources.map(s => s.chain ?? 'solana').join(', ');
  const bootMsg =
`🤖 *Trade Alert Bot started*

Universe: *${universe.size()}* tokens (top by market cap)
Chains: ${chainList}
Min flow: $${MIN_FLOW_USD.toLocaleString()}
Surge: ${SURGE_PCT}% (~1m)
Window: ${WINDOW_MS/60000} min
Correlation: bidirectional (flow⇄surge)
Funding + OI: ${funding ? `✓ (${fundingSource})` : '— disabled'}
Liquidations: ${liquidations ? '✓ (Coinalyze)' : '— disabled'}
Observations: ≥ $${OBSERVE_MIN_FLOW_USD.toLocaleString()} solo flows
Funding leaders: every ${FUNDING_LEADERS_MIN} min
Signal threshold: score ≥ ${MIN_SIGNAL_SCORE} (observation ≥ ${MIN_OBSERVATION_SCORE}, cooldown ${SIGNAL_COOLDOWN_MIN}min/token)
Engine: Conductor (multi-trigger scoring${taService ? ' + TA' : ''})
Commands: ${process.env.TELEGRAM_COMMANDS !== '0' ? '/analyze, /open, /recent, /leaders, /movers, /heatmap, /regime, /stats, /help' : 'disabled'}
Subscribers: ${subscribers.size()} chat(s)

Watching live.`;
  // Boot status goes to operator only — other subscribers don't need to see
  // every restart / config dump
  if (TELEGRAM_CHAT_ID) {
    await notifier.sendToChat(TELEGRAM_CHAT_ID, bootMsg);
  }

  // Diagnostic: capture WHO and WHEN sent the kill signal. Without this,
  // a stray pm2/cron/script kill looks the same as a clean shutdown.
  const logExit = (sig) => {
    const uptime = Math.round(process.uptime());
    const ts = new Date().toISOString();
    console.log(`[exit] ${sig} received @ ${ts} after ${uptime}s uptime — ppid=${process.ppid} pid=${process.pid}`);
  };
  process.on('SIGINT',  () => { logExit('SIGINT');  process.exit(0); });
  process.on('SIGTERM', () => { logExit('SIGTERM'); process.exit(0); });
  process.on('SIGHUP',  () => { logExit('SIGHUP');  process.exit(0); });
  // Uncaught exception → log full stack BEFORE pm2 restarts us, so the cause
  // is visible in the previous boot's log (currently the next boot overwrites
  // attention and the original throw can get lost in scroll-back).
  process.on('uncaughtException', (err) => {
    console.error(`[uncaught] @ ${new Date().toISOString()} after ${Math.round(process.uptime())}s:`, err?.stack ?? err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.stack ?? err));
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
