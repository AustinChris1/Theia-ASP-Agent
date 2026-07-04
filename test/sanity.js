// Sanity tests — exercises the pure / pure-ish logic across modules to
// verify the recent changes didn't break anything. Doesn't hit any external
// APIs (CoinGecko / Coinalyze / RPCs) — that's covered by the live bot.
//
// Run: node test/sanity.js
//
// Exits 0 on full pass, 1 if any test fails.

import { isStableSymbol, KNOWN_STABLES } from '../src/stables.js';
import {
  fundingScoreForSide,
  oiScoreForSide,
  signalStrength,
  fundingLeaders,
  formatFundingLeaders
} from '../src/funding.js';
import { SubscriberStore } from '../src/subscribers.js';
import { Universe } from '../src/universe.js';
import { Conductor, isExhaustionReversalShort, isExhaustionReversalLong, momentumLacksEdge, assessConviction, enforceTpLadder, structuralRoom, assessManipulation, assessPumpRegime, assessPrePumpSetup, pumpRegimeBias, liquidationOiBonus, liquidationBaseScore, liquidationCascadeBase, liquidationSignalBase, isMomentumLive, teamSellMaterialFloorUsd, independentFlowCount } from '../src/conductor.js';
import { cvdDecision } from '../src/cvd.js';
import { aggregateWeekly, TF_ALIGNMENT_WEIGHTS, TF_ORDER } from '../src/timeframes.js';
import { RiskEngine } from '../src/autotrade/risk-engine.js';
import { BybitExchange } from '../src/autotrade/exchange-bybit.js';
import { confirmSignal } from '../src/ta-confirm.js';
import { PriceMonitor } from '../src/prices.js';
import { regimeScoreForSide, RegimeMonitor } from '../src/regime.js';
import { aggregateOrderbookClusters } from '../src/liquidity-clusters.js';
import { classifyListing, extractTickers, parseAnnouncementTs, classifyRiskTag } from '../src/listing-monitor.js';
import { classifyNewsImpact, parseRssItems, newsItemId } from '../src/news-monitor.js';
import { llmEnabled, escapeTgMarkdown } from '../src/llm.js';
import { buildPerpSymbolMap } from '../src/coinalyze.js';
import { MacroMonitor, dueMacroFires, macroEventId, leadPhrase } from '../src/macro-monitor.js';
import { UnlockMonitor, circulatingAt, parseUnlockSchedule, isMajorUnlock, dueUnlockFires } from '../src/unlock-monitor.js';
import { encryptSecret, decryptSecret, vaultAvailable, maskSecret } from '../src/crypto-vault.js';
import { computeLiquidationHeatmap, adaptiveLeverages, realizedVolPct, detectLiquiditySweep, LiquidationHeatmap } from '../src/liquidation-heatmap.js';
import { TeamWalletDiscovery, detectAccumulation } from '../src/team-wallet-discovery.js';
import { analyzeSmc } from '../src/smc.js';
import { detectRsiDivergence } from '../src/ta.js';
import { parseForceOrder } from '../src/binance-liquidations.js';
import { liquidationSignificance } from '../src/liquidations.js';
import { bybitSymbolToToken, rollupLiquidationWindow } from '../src/bybit-liquidations.js';
import { HdWallet } from '../billing/hd-wallet.js';
import { creditMonths, extendedPaidUntil, statusOf, accessUntil } from '../billing/subscriptions.js';
import { assessDistribution } from '../src/distribution.js';
import { PaperBroker } from '../src/autotrade/paper-broker.js';
import { TradeStore } from '../src/autotrade/store.js';
import { AutoTrader } from '../src/autotrade/auto-trader.js';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { SignalTracker } from '../src/signal-tracker.js';

let passed = 0, failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
};
const aTest = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
};
const eq = (a, b, msg = '') => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}\n      expected: ${B}\n      got:      ${A}`);
};
const truthy = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg); };
const falsy  = (v, msg = 'expected falsy')  => { if (v)  throw new Error(msg); };
const close  = (a, b, eps = 1e-6, msg = '') => { if (Math.abs(a - b) > eps) throw new Error(`${msg} ${a} vs ${b}`); };

// ── 1. Stable detection ────────────────────────────────────────────────────
console.log('\n[1] Stable detection');
test('USDT detected via explicit list',     () => truthy(isStableSymbol('USDT')));
test('USDC detected via explicit list',     () => truthy(isStableSymbol('USDC')));
test('USD1 detected via explicit list',     () => truthy(isStableSymbol('USD1')));
test('USD2 detected via regex (new variant)', () => truthy(isStableSymbol('USD2')));
test('USD42 detected via regex',            () => truthy(isStableSymbol('USD42')));
test('USDe detected (case-insensitive)',    () => truthy(isStableSymbol('usde')));
test('EURC detected',                       () => truthy(isStableSymbol('EURC')));
test('cUSD detected via suffix regex',      () => truthy(isStableSymbol('cUSD')));
test('BTC NOT a stable',                    () => falsy(isStableSymbol('BTC')));
test('ETH NOT a stable',                    () => falsy(isStableSymbol('ETH')));
test('stETH NOT a stable (LST, not pegged)', () => falsy(isStableSymbol('stETH')));
test('XAUT NOT a stable (gold moves)',      () => falsy(isStableSymbol('XAUT')));
test('PAXG NOT a stable (gold moves)',      () => falsy(isStableSymbol('PAXG')));
test('null safe',                           () => falsy(isStableSymbol(null)));
test('empty string safe',                   () => falsy(isStableSymbol('')));
test('KNOWN_STABLES size sane (≥30)',       () => truthy(KNOWN_STABLES.size >= 30));

// ── 2. Funding alignment scoring ───────────────────────────────────────────
console.log('\n[2] Funding alignment scoring');
test('LONG + funding −0.20% per 8h = +2 (squeeze fuel)', () => {
  eq(fundingScoreForSide('LONG', { avg: -0.002 }), 2);
});
test('LONG + funding +0.15% per 8h = −2 (crowded longs)', () => {
  eq(fundingScoreForSide('LONG', { avg: 0.002 }), -2);
});
test('LONG + funding neutral 0.005% per 8h = 0', () => {
  eq(fundingScoreForSide('LONG', { avg: 0.00005 }), 0);
});
test('SHORT + funding +0.20% per 8h = +2', () => {
  eq(fundingScoreForSide('SHORT', { avg: 0.002 }), 2);
});
test('SHORT + funding −0.20% per 8h = −2', () => {
  eq(fundingScoreForSide('SHORT', { avg: -0.002 }), -2);
});
test('null summary → null score', () => {
  eq(fundingScoreForSide('LONG', null), null);
});

// ── 3. OI direction scoring ────────────────────────────────────────────────
console.log('\n[3] OI direction scoring');
test('LONG + OI rising + price up = +0.5 (healthy)', () => {
  eq(oiScoreForSide('LONG', { oiDeltaPct: 5 }, 'up'), 0.5);
});
test('LONG + OI falling + price up = −0.25 (short cover)', () => {
  eq(oiScoreForSide('LONG', { oiDeltaPct: -5 }, 'up'), -0.25);
});
test('SHORT + OI rising + price down = +0.5', () => {
  eq(oiScoreForSide('SHORT', { oiDeltaPct: 5 }, 'down'), 0.5);
});
test('OI null delta → null', () => {
  eq(oiScoreForSide('LONG', { oiDeltaPct: null }, 'up'), null);
});

// ── 4. Signal strength tiers ───────────────────────────────────────────────
console.log('\n[4] Signal-strength tiers (funding+oi+liq sum + base 2)');
test('Total 5.5 → VERY HIGH', () => eq(signalStrength(2, 0.5, 1).label, 'VERY HIGH'));
test('Total 3.0 → HIGH',      () => eq(signalStrength(1, 0, 0).label, 'HIGH'));
test('Total 2.0 → MEDIUM',    () => eq(signalStrength(0, 0, 0).label, 'MEDIUM'));
test('Total 1.0 → LOW',       () => eq(signalStrength(-1, 0, 0).label, 'LOW'));
test('Total 0.5 → MIXED',     () => eq(signalStrength(-2, 0.5, 0).label, 'MIXED'));

// ── 5. Funding leaders ─────────────────────────────────────────────────────
console.log('\n[5] Funding leaders');
const mockFundingMonitor = {
  bySymbol: new Map([
    ['BTC',  { rates: [{}], summary: { avg: -0.005, totalOi: 5_000_000_000, oiDeltaPct: 1 } }],
    ['ETH',  { rates: [{}], summary: { avg:  0.003, totalOi: 3_000_000_000, oiDeltaPct: -0.5 } }],
    ['BEAT', { rates: [{}], summary: { avg:  0.04,  totalOi: 50_000_000,    oiDeltaPct: 10 } }],
    ['CHIP', { rates: [{}], summary: { avg: -0.04,  totalOi: 30_000_000,    oiDeltaPct: -2 } }],
    ['DOGE', { rates: [{}], summary: { avg: -0.001, totalOi: 1_000_000_000, oiDeltaPct: 0.1 } }],
    ['THIN', { rates: [{}], summary: { avg:  0.01,  totalOi:    500_000,    oiDeltaPct: 0 } }]
  ])
};
test('Leaders: filters tokens below OI threshold', () => {
  const l = fundingLeaders(mockFundingMonitor, 5, 1, 10_000_000);
  truthy(!l.mostNegative.some(e => e.symbol === 'THIN'), 'THIN should be excluded (OI < 10M)');
});
test('Leaders: mostNegative includes CHIP at top', () => {
  const l = fundingLeaders(mockFundingMonitor, 5, 1, 10_000_000);
  eq(l.mostNegative[0].symbol, 'CHIP');
});
test('Leaders: mostPositive includes BEAT at top', () => {
  const l = fundingLeaders(mockFundingMonitor, 5, 1, 10_000_000);
  eq(l.mostPositive[0].symbol, 'BEAT');
});
test('Leaders: rotation offset slices correctly', () => {
  const l = fundingLeaders(mockFundingMonitor, 2, 1, 10_000_000, 2);
  // 5 eligible (sortedAsc by avg): CHIP, BTC, DOGE, ETH, BEAT
  // offset=2, topN=2 → mostNegative slice = [DOGE, ETH]
  eq(l.mostNegative[0]?.symbol, 'DOGE', 'offset=2 should start at 3rd most-negative');
});
test('formatFundingLeaders returns string with markdown', () => {
  const l = fundingLeaders(mockFundingMonitor, 3, 1, 10_000_000);
  const out = formatFundingLeaders(l, 1);
  truthy(typeof out === 'string' && out.includes('Funding Rate Leaders'));
});

// ── 6. SubscriberStore (persistence) ───────────────────────────────────────
console.log('\n[6] SubscriberStore');
const subPath = join(tmpdir(), `subs-test-${Date.now()}.json`);
test('Add new subscriber returns true', () => {
  const s = new SubscriberStore({ path: subPath });
  eq(s.add({ chatId: 123, username: 'alice' }), true);
});
test('Re-adding same subscriber returns false', () => {
  const s = new SubscriberStore({ path: subPath });
  eq(s.add({ chatId: 123, username: 'alice' }), false);
});
test('Subscriber persists across instances', () => {
  const s = new SubscriberStore({ path: subPath });
  truthy(s.has(123));
  eq(s.size(), 1);
});
test('Silence + unsilence roundtrip', () => {
  const s = new SubscriberStore({ path: subPath });
  s.setSilence(123, Date.now() + 60_000);
  truthy(s.isSilenced(123));
  s.setSilence(123, null);
  falsy(s.isSilenced(123));
});
test('Auto-expire silence past deadline', () => {
  const s = new SubscriberStore({ path: subPath });
  s.setSilence(123, Date.now() - 1000);   // already expired
  falsy(s.isSilenced(123));
});
test('Notify prefs: defaults (event alerts ON, digests OFF)', () => {
  const s = new SubscriberStore({ path: subPath });
  const p = s.notifyPrefsFor(123);
  eq(p.flow, true, 'CEX-flow on by default');
  eq(p.insider, true, 'insider/team sells on by default (flagship tell)');
  eq(p.liquidation, true, 'liquidation cascades on by default (flagship tell)');
  eq(p.funding, false, 'funding digest off by default');
  eq(p.movers, false, 'movers digest off by default');
  eq(p.listing, true, 'listing alerts on by default (flagship catalyst)');
});
test('Notify prefs: signals + TP/SL are non-negotiable (always delivered)', () => {
  const s = new SubscriberStore({ path: subPath });
  eq(s.wantsCategory(123, 'signal'), true);
  eq(s.wantsCategory(123, 'outcome'), true);
  eq(s.wantsCategory(123, null), true);        // untagged broadcast → always
});
test('Notify prefs: wantsCategory follows defaults then overrides', () => {
  const s = new SubscriberStore({ path: subPath });
  eq(s.wantsCategory(123, 'flow'), true);      // default on
  eq(s.wantsCategory(123, 'funding'), false);  // default off
  s.setNotifyPref(123, 'funding', true);       // user turns funding ON
  eq(s.wantsCategory(123, 'funding'), true);
  s.setNotifyPref(123, 'flow', false);         // user turns CEX-flow OFF
  eq(s.wantsCategory(123, 'flow'), false);
});
test('Notify prefs persist across instances', () => {
  const s = new SubscriberStore({ path: subPath });   // reload from disk
  eq(s.wantsCategory(123, 'funding'), true, 'funding override survived reload');
  eq(s.wantsCategory(123, 'flow'), false, 'flow override survived reload');
});
test('Notify prefs: unknown recipient is never suppressed', () => {
  const s = new SubscriberStore({ path: subPath });
  eq(s.wantsCategory(999999, 'funding'), true, 'non-subscriber → deliver (legacy fallback)');
  eq(s.setNotifyPref(999999, 'funding', false), false, 'cannot set prefs for a non-subscriber');
});
test('Remove subscriber', () => {
  const s = new SubscriberStore({ path: subPath });
  s.remove(123);
  falsy(s.has(123));
  eq(s.size(), 0);
});
if (existsSync(subPath)) unlinkSync(subPath);

// ── 7. Universe.isPinned / isHotMover / isFavored ──────────────────────────
console.log('\n[7] Universe favored-token semantics');
test('isPinned on empty universe', () => {
  const u = new Universe({});
  falsy(u.isPinned('btc'));
});
test('isHotMover + isFavored after setHotMovers', () => {
  const u = new Universe({});
  u.setHotMovers(['btc', 'eth']);
  truthy(u.isHotMover('btc'));
  truthy(u.isFavored('btc'));
  falsy(u.isPinned('btc'));
});
test('Pinned token also favored', () => {
  const u = new Universe({});
  u.pinnedCgIds.add('hyperliquid');
  truthy(u.isPinned('hyperliquid'));
  truthy(u.isFavored('hyperliquid'));
});
test('Adding & removing hot movers', () => {
  const u = new Universe({});
  u.setHotMovers(['a', 'b', 'c']);
  eq(u.isFavored('a'), true);
  u.setHotMovers([]);    // clear
  eq(u.isFavored('a'), false);
});
// Listing onboarding: a freshly-listed token must load into the universe at
// NORMAL thresholds (ensureToken), not as a favored watchlist name (addPinned).
await aTest('ensureToken loads a token WITHOUT pinning/favoring it', async () => {
  const u = new Universe({});
  u.tokensByCgId.set('foocoin', { coingeckoId: 'foocoin', symbol: 'FOO', chains: {} });
  const t = await u.ensureToken('foocoin');   // existing → no network fetch
  truthy(t);
  eq(u.isPinned('foocoin'), false);
  eq(u.isFavored('foocoin'), false);
});
await aTest('addPinnedToken pins (favors) the token', async () => {
  const u = new Universe({});
  u.tokensByCgId.set('barcoin', { coingeckoId: 'barcoin', symbol: 'BAR', chains: {} });
  await u.addPinnedToken('barcoin');
  truthy(u.isPinned('barcoin'));
  truthy(u.isFavored('barcoin'));
});

// ── 8. Conductor: post-loss cooldown logic ─────────────────────────────────
console.log('\n[8] Conductor post-loss cooldown');
test('Conductor instantiates with mocked deps', () => {
  const universe = new Universe({});
  const prices = new EventEmitter();
  prices.getPrice = () => null;
  const c = new Conductor({
    universe,
    prices,
    onchainSources: [],
    minSignalScore: 3.0
  });
  truthy(c.recentLosses instanceof Map);
  eq(c.postLossMinCooldownMs, 30 * 60_000);
  eq(c.postLossPriceDistPct, 3);
});
test('recordLoss only stores LOSS / EXPIRED_LOSS outcomes', () => {
  const universe = new Universe({});
  const prices = new EventEmitter();
  prices.getPrice = () => null;
  const c = new Conductor({ universe, prices, onchainSources: [] });

  c.recordLoss({ symbol: 'IN', side: 'SHORT', outcome: 'WIN_TP1', entry: 0.10 });
  falsy(c.recentLosses.has('IN'), 'wins should not be recorded');

  c.recordLoss({ symbol: 'IN', side: 'SHORT', outcome: 'LOSS', entry: 0.105 });
  truthy(c.recentLosses.has('IN'));
  eq(c.recentLosses.get('IN').side, 'SHORT');
  eq(c.recentLosses.get('IN').entry, 0.105);

  c.recordLoss({ symbol: 'XYZ', side: 'LONG', outcome: 'EXPIRED_LOSS', entry: 1.5 });
  truthy(c.recentLosses.has('XYZ'));
});
test('recordLoss ignores malformed inputs', () => {
  const universe = new Universe({});
  const prices = new EventEmitter();
  prices.getPrice = () => null;
  const c = new Conductor({ universe, prices, onchainSources: [] });
  c.recordLoss(null);
  c.recordLoss({ symbol: 'A' });   // no side
  c.recordLoss({ side: 'LONG' });  // no symbol
  eq(c.recentLosses.size, 0);
});

// Strong-momentum override: a ≥3× volume surge must run the deep TA even when
// its bare trigger score (1.5) is below the 2.0 observation floor — otherwise
// explosive moves with no simultaneous flow/funding/liq confluence (the LABUSDT
// case) are ignored without the chart ever being analysed. Firing stays gated.
await aTest('strong surge (≥3× vol) forces TA below the observation floor', async () => {
  const universe = new Universe({});
  universe.lookupByCgId = () => ({ symbol: 'LAB' });
  universe.isFavored = () => true;
  const prices = new EventEmitter();
  prices.getPrice = () => 9.0;
  let analyzeCalls = 0;
  const taService = {
    getVolumeRatio: async () => ({ ratio: 25 }),      // ≥3× → +0.5 boost → strong momentum
    analyze: async () => { analyzeCalls++; return { findings: [], metadata: {} }; }
  };
  const c = new Conductor({ universe, prices, onchainSources: [], taService,
                            minSignalScore: 3.0, minObservationScore: 2.0 });
  c.start();
  prices.emit('surge', { token: { symbol: 'LAB', coingeckoId: 'lab' },
                         direction: 'up', pctChange: 6, open: 8.5, close: 9.0 });
  await new Promise(r => setTimeout(r, 30));
  truthy(analyzeCalls === 1, `TA should run on a 25× surge despite a low base score (got ${analyzeCalls})`);
});

// Contrast: a weak surge (no volume boost) stays gated — we did NOT open the
// floodgates for every surge, only the high-conviction ≥3× ones.
await aTest('weak surge (no vol boost) stays gated — TA not run below the floor', async () => {
  const universe = new Universe({});
  universe.lookupByCgId = () => ({ symbol: 'LAB' });
  universe.isFavored = () => true;
  const prices = new EventEmitter();
  prices.getPrice = () => 9.0;
  let analyzeCalls = 0;
  const taService = {
    getVolumeRatio: async () => ({ ratio: 1.6 }),     // ≥1.5 (not suppressed) but no boost
    analyze: async () => { analyzeCalls++; return { findings: [], metadata: {} }; }
  };
  const c = new Conductor({ universe, prices, onchainSources: [], taService,
                            minSignalScore: 3.0, minObservationScore: 2.0 });
  c.start();
  prices.emit('surge', { token: { symbol: 'LAB', coingeckoId: 'lab' },
                         direction: 'up', pctChange: 6, open: 8.5, close: 9.0 });
  await new Promise(r => setTimeout(r, 30));
  truthy(analyzeCalls === 0, `weak surge must NOT run TA below the floor (got ${analyzeCalls})`);
});

// ── 9. Weekly timeframe aggregation ─────────────────────────────────────────
console.log('\n[9] Weekly TF aggregation + weight vector');
test('TF_ORDER includes 1week as the highest TF', () => {
  truthy(TF_ORDER.includes('1week'));
  eq(TF_ORDER[TF_ORDER.length - 1], '1week');
});
test('TF_ALIGNMENT_WEIGHTS has all 6 TFs and sums ≈ 1.0', () => {
  const keys = Object.keys(TF_ALIGNMENT_WEIGHTS);
  truthy(keys.includes('1week') && keys.includes('daily') && keys.length === 6);
  const sum = Object.values(TF_ALIGNMENT_WEIGHTS).reduce((a, b) => a + b, 0);
  close(sum, 1.0, 1e-9, 'alignment weights should sum to 1.0');
});
test('daily+weekly carry the most alignment weight', () => {
  const w = TF_ALIGNMENT_WEIGHTS;
  truthy(w['1week'] >= w['4hour'] && w['daily'] >= w['4hour'] && w['4hour'] > w['1hour'] && w['1hour'] > w['5min'] && w['5min'] > w['1min']);
});
test('aggregateWeekly groups 14 daily bars into 2 weekly bars', () => {
  // 14 consecutive UTC days starting at a MONDAY-aligned week boundary (weekly
  // candles anchor to Monday 00:00 UTC — see aggregateWeekly).
  const DAY = 86400;
  const base = 1000 * 7 * 86400 + 4 * 86400;   // week-index 1000 Monday start (epoch Thu + 4d)
  const bars = [];
  for (let i = 0; i < 14; i++) {
    bars.push({ t: base + i * DAY, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: 1 });
  }
  const weekly = aggregateWeekly(bars);
  eq(weekly.length, 2, 'should be exactly 2 weekly buckets');
  // First weekly: open = first day's open, high = max of days 0-6, low = min, close = last day's close
  eq(weekly[0].o, 100);
  eq(weekly[0].h, 116);          // 110 + 6
  eq(weekly[0].l, 90);           // 90 + 0
  eq(weekly[0].c, 111);          // 105 + 6
  eq(weekly[0].v, 7);            // 7 days summed
  eq(weekly[1].o, 107);          // day 7 open
});
test('aggregateWeekly handles empty / malformed input', () => {
  eq(aggregateWeekly([]).length, 0);
  eq(aggregateWeekly(null).length, 0);
});

// ── 10. Funding mild-positive reduced to +0.2 (§3.15) ───────────────────────
console.log('\n[10] Funding mild same-direction neutralized to 0');
test('LONG + mild positive funding (+0.03%/8h) = 0 (neutral; was +0.2 — crowded/late)', () => {
  eq(fundingScoreForSide('LONG', { avg: 0.0003 }), 0);
});
test('SHORT + mild negative funding (−0.03%/8h) = 0 (neutral; was +0.2 — crowded/late)', () => {
  eq(fundingScoreForSide('SHORT', { avg: -0.0003 }), 0);
});
test('LONG + mild NEGATIVE funding (squeeze support) still +0.5', () => {
  eq(fundingScoreForSide('LONG', { avg: -0.0003 }), 0.5);
});

// ── 11. RiskEngine sizing — effective risk + margin buffer (§2.5/§5) ─────────
console.log('\n[11] RiskEngine sizing: caps + effective risk + margin buffer');
test('notional cap binds on a small account → capBound, low effective risk', () => {
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 50, maxLeverage: 20 });
  // balance 1000, 2% risk = $20 risk; SL 1% away → notional 20/0.01 = $2000,
  // capped to maxPositionUsd $50. Effective risk = 50 * 0.01 = $0.50 = 0.05%.
  const s = re.sizePosition({ balance: 1000, entry: 100, sl: 99, suggestedLeverage: 10 });
  truthy(s.capBound, 'cap should bind');
  close(s.notionalUsd, 50, 1e-9);
  close(s.effectiveRiskPct, 0.05, 1e-9, 'effective risk far below configured 2%');
});
test('margin buffer caps notional so margin ≤ 90% of balance', () => {
  // Tiny balance, low leverage, big maxPositionUsd → margin buffer must bind.
  const re = new RiskEngine({ riskPct: 50, maxPositionUsd: 100000, maxLeverage: 2 });
  const s = re.sizePosition({ balance: 100, entry: 100, sl: 90, suggestedLeverage: 2 });
  // maxAffordableNotional = 100 * 0.9 * 2 = 180.
  truthy(s.notionalUsd <= 180 + 1e-6, `notional ${s.notionalUsd} should be ≤ 180`);
  truthy(s.capBound);
});
test('invalid SL distance → null', () => {
  const re = new RiskEngine({});
  eq(re.sizePosition({ balance: 100, entry: 100, sl: 100, suggestedLeverage: 5 }), null);
});
test('per-mode breaker: paper PnL never trips it; paper can trade after a live halt', () => {
  const re = new RiskEngine({ dailyLossLimitPct: 10 });
  re.canTrade({ balance: 1000, symbol: 'X', openPositions: [] });   // roll the day, set dayStartBalance
  // A paper loss bigger than the limit must NOT halt.
  re.recordRealisedPnl(-200, 'paper');
  truthy(!re.halted, 'paper loss does not trip the live breaker');
  truthy(re.canTrade({ balance: 1000, symbol: 'X', openPositions: [], mode: 'paper' }).ok, 'paper still trades');
  // A live loss past the 10% limit DOES halt, and blocks LIVE...
  re.recordRealisedPnl(-150, 'live');
  truthy(re.halted, 'live loss past the limit halts');
  truthy(!re.canTrade({ balance: 1000, symbol: 'X', openPositions: [], mode: 'live' }).ok, 'live blocked when halted');
  // ...but PAPER is exempt and keeps trading.
  truthy(re.canTrade({ balance: 1000, symbol: 'X', openPositions: [], mode: 'paper' }).ok, 'paper exempt from the live halt');
});
test('fixed-margin sizing: notional = margin × leverage (paper $100/trade)', () => {
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 50, maxLeverage: 20 });
  // $100 margin at 10× → $1000 notional, ignoring the $50 risk-cap.
  const s = re.sizePosition({ balance: 1000, entry: 100, sl: 95, suggestedLeverage: 10, marginUsd: 100 });
  close(s.notionalUsd, 1000, 1e-9, 'notional = 100 × 10');
  close(s.marginUsedUsd, 100, 1e-9, 'margin used = $100');
  eq(s.leverage, 10);
});
test('fixed-margin clamps to 90% of balance', () => {
  const re = new RiskEngine({ maxLeverage: 5 });
  // Ask $100 margin but balance is only $50 → clamp margin to $45 (0.9×50).
  const s = re.sizePosition({ balance: 50, entry: 10, sl: 9, suggestedLeverage: 5, marginUsd: 100 });
  close(s.marginUsedUsd, 45, 1e-9, 'margin clamped to 0.9 × balance');
  truthy(s.capBound, 'capBound flagged when margin clamped');
});
test('liquidation safety: leverage capped so liq sits beyond the SL', () => {
  // SL 7% away. At 50× the liq is ~2% from entry → INSIDE the stop (liquidated
  // first). maxSafeLev = floor(1/(0.07+0.015)) = 11, so leverage must be ≤ 11.
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 1e9, maxLeverage: 50 });
  const s = re.sizePosition({ balance: 100000, entry: 100, sl: 93, suggestedLeverage: 50 });
  truthy(s.leverage <= 11, `leverage ${s.leverage} capped so liq (~1/${s.leverage}) is beyond the 7% SL`);
});
test('liquidation safety: a tight SL still allows high leverage', () => {
  // SL 1% away → maxSafeLev = floor(1/0.025) = 40, so a 20× request is untouched.
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 1e9, maxLeverage: 50 });
  const s = re.sizePosition({ balance: 100000, entry: 100, sl: 99, suggestedLeverage: 20 });
  eq(s.leverage, 20);
});
test('leverage clamped to the instrument per-symbol max (USELESS 110007 bug)', () => {
  // Account allows 20×, the plan asked 15×, but Bybit caps USELESS at 12.5×.
  // Sizing must floor to 12× so the set-leverage sticks and the margin we size
  // for is what the exchange actually demands (else: 110007 "ab not enough").
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 1e9, maxLeverage: 20 });
  const s = re.sizePosition({ balance: 100000, entry: 0.09227, sl: 0.088454, suggestedLeverage: 15, instrumentMaxLev: 12.5 });
  eq(s.leverage, 12);
});
test('no instrument max provided falls back to the engine cap (unchanged)', () => {
  const re = new RiskEngine({ riskPct: 2, maxPositionUsd: 1e9, maxLeverage: 20 });
  const s = re.sizePosition({ balance: 100000, entry: 100, sl: 99, suggestedLeverage: 15 });
  eq(s.leverage, 15);
});

// ── 11b. Daily-loss circuit breaker — per-user settable limit ────────────────
console.log('\n[11b] RiskEngine daily-loss breaker');
test('breaker trips when realised loss crosses the limit, halting new trades', () => {
  const re = new RiskEngine({ dailyLossLimitPct: 10 });
  re.canTrade({ balance: 1000, symbol: 'BTC', openPositions: [] });   // seeds dayStartBalance
  re.recordRealisedPnl(-50);
  falsy(re.halted, '5% down — under the 10% limit, still trading');
  re.recordRealisedPnl(-60);                                          // cumulative -110 = 11%
  truthy(re.halted, '11% down — breaker tripped');
  eq(re.canTrade({ balance: 890, symbol: 'BTC', openPositions: [] }).ok, false, 'halted → canTrade denies');
});
test('limit of 0 DISABLES the breaker (never halts on loss)', () => {
  const re = new RiskEngine({ dailyLossLimitPct: 0 });
  re.canTrade({ balance: 1000, symbol: 'BTC', openPositions: [] });
  re.recordRealisedPnl(-500);                                         // 50% down
  falsy(re.halted, '0% limit = off, no halt');
});
test('raising the limit above today\'s loss lifts an active halt', () => {
  const re = new RiskEngine({ dailyLossLimitPct: 5 });
  re.canTrade({ balance: 1000, symbol: 'BTC', openPositions: [] });
  re.recordRealisedPnl(-80);                                          // 8% > 5% → halt
  truthy(re.halted, 'tripped at 8% vs 5% limit');
  eq(re.setDailyLossLimitPct(10), 10, 'limit raised to 10%');
  falsy(re.halted, '8% loss is now under the 10% limit → halt lifted');
  eq(re.setDailyLossLimitPct(3), 3, 'limit lowered to 3%');
  truthy(re.halted, '8% loss exceeds the new 3% limit → halt re-applies');
});
test('daily counter survives a "restart" via snapshot/restore (same UTC day)', () => {
  const a = new RiskEngine({ dailyLossLimitPct: 10 });
  a.canTrade({ balance: 1000, symbol: 'BTC', openPositions: [] });
  a.recordRealisedPnl(-120);                                          // 12% → halt
  truthy(a.halted, 'first engine halted');
  const snap = a.daySnapshot();
  const b = new RiskEngine({ dailyLossLimitPct: 10 });                // fresh engine = "after restart"
  truthy(b.restoreDay(snap), 'restore accepted (same UTC day)');
  truthy(b.halted, 'restored engine is still halted — restart did NOT reset the breaker');
  eq(b.canTrade({ balance: 880, symbol: 'ETH', openPositions: [] }).ok, false, 'still blocking new trades post-restart');
});
test('a stale (previous-day) snapshot is ignored — counters roll fresh', () => {
  const b = new RiskEngine({ dailyLossLimitPct: 10 });
  eq(b.restoreDay({ dayKey: '2000-01-01', dayStartBalance: 1000, dayRealisedPnl: -500, halted: true }), false, 'stale snapshot rejected');
  falsy(b.halted, 'not halted from a stale day');
});
await aTest('AutoTrader persists the daily breaker to FILE in no-DB mode (the per-user gap)', async () => {
  const f = join(tmpdir(), `daystate-${Date.now()}.json`);
  const mk = () => new AutoTrader({ mode: 'off', riskEngine: new RiskEngine({ dailyLossLimitPct: 10 }), store: { stats: () => ({}) }, dayStateFile: f });
  const a = mk();
  a.risk.canTrade({ balance: 1000, symbol: 'BTC', openPositions: [] });
  a.risk.recordRealisedPnl(-120);     // 12% down → halt
  a.setDailyLimit(10);                 // triggers #saveDayState → writes the file
  truthy(existsSync(f), 'day-state file written even with no DATABASE_URL');
  const b = mk();                      // "after restart"
  await b.initDayState();
  truthy(b.risk.halted, 'restored halt from file — a user breaker now survives restart without a DB');
  if (existsSync(f)) unlinkSync(f);
});

// ── 12. Confirmation gate — looser default threshold (§3.4) ─────────────────
console.log('\n[12] Confirmation gate threshold + neutral RSI');
test('confirmSignal default dropThreshold is −2.5 (no input → no drop)', () => {
  const r = confirmSignal({ side: 'LONG', ohlcvByTf: {} });
  falsy(r.drop, 'empty input should not drop');
});
test('a single mild disagreement does NOT drop at −2.5', () => {
  // 40 flat-ish closes with a slight uptrend; SHORT side will mildly disagree
  // on momentum but the tally must not reach −2.5 from one timeframe.
  const bars = [];
  for (let i = 0; i < 40; i++) {
    const c = 100 + i * 0.1;
    bars.push({ o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });
  }
  const r = confirmSignal({ side: 'SHORT', ohlcvByTf: { '1hour': bars } });
  falsy(r.drop, `one TF mild disagreement (tally ${r.tally}) should not drop at −2.5`);
});

// ── 12b. Exhaustion-reversal SHORT (watchlist-only HIGH-RISK top fade) ───────
console.log('\n[12b] Exhaustion-reversal short detector + confirm override');
const exhMeta = ({ daily = 86, week = 88, m5 = 'down', h1 = 'down' } = {}) => ({
  '5min':  { rsi: 70, trend: m5,    atr: 1 },
  '1hour': { rsi: 75, trend: h1,    atr: 1 },
  '4hour': { rsi: 78, trend: 'up',  atr: 1 },
  'daily': { rsi: daily, trend: 'up', atr: 1 },
  '1week': { rsi: week,  trend: 'up', atr: 1 }
});
test('exhaustion-reversal: favored + daily RSI 86 + 5m down → TRUE', () =>
  truthy(isExhaustionReversalShort('SHORT', true, exhMeta())));
test('exhaustion-reversal: 5m down + 1h still UP (the LAB case) → TRUE (loosened to 5m)', () =>
  truthy(isExhaustionReversalShort('SHORT', true, exhMeta({ h1: 'up' }))));
test('exhaustion-reversal: stretched via WEEKLY only (daily 72, wk 85) → TRUE', () =>
  truthy(isExhaustionReversalShort('SHORT', true, exhMeta({ daily: 72, week: 85 }))));
test('exhaustion-reversal: NOT favored → false (watchlist-only)', () =>
  falsy(isExhaustionReversalShort('SHORT', false, exhMeta())));
test('exhaustion-reversal: not stretched (daily 70, wk 72) → false', () =>
  falsy(isExhaustionReversalShort('SHORT', true, exhMeta({ daily: 70, week: 72 }))));
test('exhaustion-reversal: 5m still up (not rolled over) → false', () =>
  falsy(isExhaustionReversalShort('SHORT', true, exhMeta({ m5: 'up' }))));
test('exhaustion-reversal: LONG side never qualifies → false', () =>
  falsy(isExhaustionReversalShort('LONG', true, exhMeta())));

// The confirm-gate override: a monotonic-up series → RSI 100 on daily, which
// normally HARD-VETOES a SHORT. allowExhaustionShort must skip that veto.
const exhUpBars = [];
for (let i = 0; i < 40; i++) { const c = 100 + i * 2; exhUpBars.push({ o: c - 1, h: c + 0.5, l: c - 1.5, c, v: 1 }); }
test('confirm gate HARD-VETOES a SHORT into daily RSI ≥ 80 (default)', () => {
  const r = confirmSignal({ side: 'SHORT', ohlcvByTf: { daily: exhUpBars } });
  truthy(r.drop, `overbought daily should veto a SHORT (tally ${r.tally})`);
});
test('confirm gate ALLOWS the SHORT with allowExhaustionShort (override)', () => {
  const r = confirmSignal({ side: 'SHORT', ohlcvByTf: { daily: exhUpBars }, allowExhaustionShort: true });
  falsy(r.drop, `exhaustion override should skip the RSI veto (tally ${r.tally})`);
});

// ── Symmetric reversal LONG (capitulation-bottom buy, own toggle) ────────────
const exhMetaLong = ({ daily = 14, week = 12, m5 = 'up' } = {}) => ({
  '5min':  { rsi: 28, trend: m5,     atr: 1 },
  '1hour': { rsi: 25, trend: 'down', atr: 1 },
  '4hour': { rsi: 22, trend: 'down', atr: 1 },
  'daily': { rsi: daily, trend: 'down', atr: 1 },
  '1week': { rsi: week,  trend: 'down', atr: 1 }
});
test('exhaustion-reversal LONG: favored + daily RSI 14 + 5m up → TRUE', () =>
  truthy(isExhaustionReversalLong('LONG', true, exhMetaLong())));
test('exhaustion-reversal LONG: capitulated via WEEKLY only (daily 30, wk 18) → TRUE', () =>
  truthy(isExhaustionReversalLong('LONG', true, exhMetaLong({ daily: 30, week: 18 }))));
test('exhaustion-reversal LONG: NOT favored → false (watchlist-only)', () =>
  falsy(isExhaustionReversalLong('LONG', false, exhMetaLong())));
test('exhaustion-reversal LONG: not capitulated (daily 40, wk 45) → false', () =>
  falsy(isExhaustionReversalLong('LONG', true, exhMetaLong({ daily: 40, week: 45 }))));
test('exhaustion-reversal LONG: 5m still down (no bounce) → false', () =>
  falsy(isExhaustionReversalLong('LONG', true, exhMetaLong({ m5: 'down' }))));
test('exhaustion-reversal LONG: SHORT side never qualifies → false', () =>
  falsy(isExhaustionReversalLong('SHORT', true, exhMetaLong())));

// Confirm-gate LONG override (mirror of the SHORT): monotonic-DOWN → RSI ~0 on
// daily, which normally HARD-VETOES a LONG. allowExhaustionLong must skip it.
const exhDownBars = [];
for (let i = 0; i < 40; i++) { const c = 100 - i * 2; exhDownBars.push({ o: c + 1, h: c + 1.5, l: c - 0.5, c, v: 1 }); }
test('confirm gate HARD-VETOES a LONG into daily RSI ≤ 20 (default)', () => {
  const r = confirmSignal({ side: 'LONG', ohlcvByTf: { daily: exhDownBars } });
  truthy(r.drop, `oversold daily should veto a LONG (tally ${r.tally})`);
});
test('confirm gate ALLOWS the LONG with allowExhaustionLong (override)', () => {
  const r = confirmSignal({ side: 'LONG', ohlcvByTf: { daily: exhDownBars }, allowExhaustionLong: true });
  falsy(r.drop, `exhaustion override should skip the RSI veto (tally ${r.tally})`);
});

// ── 13. Conductor trade-plan end-to-end (weekly, geometry, leverage) ────────
console.log('\n[13] Conductor.evaluateForAnalysis → trade plan');
await aTest('builds a valid LONG plan with weekly alignment + sane geometry', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['test-x'];
  universe.lookupByCgId = (id) => id === 'test-x'
    ? { symbol: 'TESTX', name: 'Test', chains: null, circulatingSupply: 1e9, fdv: null, fdvRatio: null }
    : null;
  universe.isFavored = () => false;
  universe.isPinned = () => false;

  const prices = new EventEmitter();
  prices.getPrice = () => 100;

  const upTf = (atr) => ({ trend: 'up', atr, rsi: 58, macdHist: 0.2, recentWickRatio: 1, swingHigh: 130, swingLow: 80, swingHighs: [], swingLows: [] });
  const metadata = {
    '1min': upTf(0.4), '5min': upTf(0.5), '1hour': upTf(0.8),
    '4hour': upTf(1.0), 'daily': upTf(1.5), '1week': upTf(2.0)
  };
  const taService = {
    analyze: async (_sym, side) => ({
      findings: side === 'LONG' ? [{ kind: 'ta', text: 'multi-TF up', points: 1.4 }] : [],
      metadata
    })
  };

  const c = new Conductor({ universe, prices, onchainSources: [], funding: null, taService });
  const analysis = await c.evaluateForAnalysis({ symbol: 'TESTX' });
  truthy(analysis, 'analysis should be produced');
  eq(analysis.side, 'LONG', 'all-up metadata → LONG wins');
  const p = analysis.tradePlan;
  truthy(p, 'trade plan should exist');
  // Geometry: LONG → sl < entry < tp1 < tp2 < tp3
  truthy(p.sl < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2 && p.tp2 < p.tp3, 'LONG geometry must hold');
  // Weekly aligned (1week trend up) + daily known
  eq(p.weeklyAligned, true, 'weekly should be flagged aligned');
  eq(p.dailyTrendKnown, true, 'daily trend should be known');
  truthy(['POSITION', 'SWING'].includes(p.horizon), `horizon ${p.horizon} should be POSITION/SWING with full up-alignment`);
  // Leverage sane + tier-capped (not the old flat 25x)
  truthy(p.suggestedLeverage >= 2 && p.maxLeverage >= p.suggestedLeverage && p.maxLeverage <= 25, 'leverage within sane caps');
  // R:R reported
  truthy(p.rr1 >= 1, `rr1 ${p.rr1} should be ≥ 1`);
  // Validity is target/volatility-aware and clamped to the horizon window.
  truthy(p.validityHrs >= 72 && p.validityHrs <= 168, `POSITION validity ${p.validityHrs}h should be 72–168h`);
});

// ── 13a. Structure-aware SL anchors beyond the nearest swing (the WAL lesson) ─
console.log('\n[13a] Structure-aware stop-loss');
await aTest('LONG SL widens to sit just below the nearest swing low', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['wal'];
  universe.lookupByCgId = (id) => id === 'wal' ? { symbol: 'WAL', circulatingSupply: 1e9 } : null;
  universe.isFavored = () => false; universe.isPinned = () => false;
  const prices = new EventEmitter(); prices.getPrice = () => 100;
  // All-up so LONG wins; small ATR so the ATR stop (~1.2%) is far tighter than
  // the swing low at 95 (5% below) — structure must widen the stop past it.
  const up = (atr, extra = {}) => ({ trend: 'up', atr, rsi: 60, macdHist: 0.2, recentWickRatio: 1, swingHigh: 130, swingLow: 80, swingHighs: [], swingLows: [], ...extra });
  const metadata = {
    '1min': up(0.4), '5min': up(0.5), '1hour': up(0.8, { swingLows: [95] }),
    '4hour': up(1.0, { swingLows: [95] }), 'daily': up(1.5), '1week': up(2.0)
  };
  const taService = { analyze: async (_s, side) => ({ findings: side === 'LONG' ? [{ kind: 'ta', text: 'up', points: 1.4 }] : [], metadata }) };
  const c = new Conductor({ universe, prices, onchainSources: [], funding: null, taService });
  const a = await c.evaluateForAnalysis({ symbol: 'WAL' });
  const p = a.tradePlan;
  truthy(p, 'plan exists');
  eq(p.slBasis, 'structure', `SL basis should be 'structure' (got ${p.slBasis})`);
  truthy(p.sl < 95, `SL ${p.sl} should sit BELOW the swing low 95 (stop-hunt can't reach it)`);
  truthy(p.sl < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2 && p.tp2 < p.tp3, 'LONG ladder must hold');
  truthy(p.slPct > 2, `structure SL ${p.slPct?.toFixed?.(2)}% should be WIDER than the bare ATR stop`);
});

// ── 13b. Liquidity-sweep target + direction work hand in hand ────────────────
console.log('\n[13b] Liquidity-sweep TP anchoring');
await aTest('a fade after a sweep anchors a TP at the opposite liq cluster', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['swp'];
  universe.lookupByCgId = (id) => id === 'swp' ? { symbol: 'SWP', circulatingSupply: 1e9 } : null;
  universe.isFavored = () => false; universe.isPinned = () => false;
  const prices = new EventEmitter(); prices.getPrice = () => 100;
  const up = (atr) => ({ trend: 'up', atr, rsi: 60, macdHist: 0.2, recentWickRatio: 1, swingHigh: 130, swingLow: 80, swingHighs: [], swingLows: [] });
  const metadata = { '1min': up(0.4), '5min': up(0.5), '1hour': up(0.8), '4hour': up(1.0), 'daily': up(1.5), '1week': up(2.0) };
  const taService = { analyze: async (_s, side) => ({ findings: side === 'LONG' ? [{ kind: 'ta', text: 'up', points: 1.4 }] : [], metadata }) };
  // Down-sweep → fade LONG; the short-liq cluster the reversal targets sits at 105.
  const liquidationHeatmap = {
    recentSweep: () => ({ side: 'down', fadeSide: 'LONG', sweptPrice: 90, sweptUsd: 5e6, targetPrice: 105, targetUsd: 5e6, targetDistPct: 5 }),
    peek: () => null,
  };
  const c = new Conductor({ universe, prices, onchainSources: [], funding: null, taService, liquidationHeatmap });
  const a = await c.evaluateForAnalysis({ symbol: 'SWP' });
  const p = a.tradePlan;
  truthy(p, 'plan exists');
  eq(a.side, 'LONG', 'all-up + down-sweep fade → LONG');
  // Directional read fired (the scoring bonus + reason).
  truthy(a.reasons.some(r => r.kind === 'liqSweep'), 'liq-sweep reason present (direction)');
  // And a TP snapped to the cluster price (target), so the two work hand in hand.
  const srcs = p.tpSources ?? {};
  const sweepTp = ['tp1', 'tp2', 'tp3'].find(k => srcs[k] === 'liq-sweep');
  truthy(sweepTp, `a TP snapped to the liq-sweep cluster (sources: ${JSON.stringify(srcs)})`);
  truthy(Math.abs(p[sweepTp] - 105 * 0.998) / 105 < 0.01, `${sweepTp}=${p[sweepTp]} sits at the cluster ~104.8`);
});

// ── 13a2. Cross-venue heatmap aggregation (Binance + Bybit, anti-spoof) ──────
console.log('\n[13a2] Heatmap cross-venue aggregation + confirmation weighting');
{
  const asks = [[100.1, 100], [101, 50]];        // best ask 100.1 → mid 100
  const binance = { source: 'binance', bids: [[99.9, 100], [95, 5000]], asks };            // wall @95 (−5%)
  const bybit   = { source: 'bybit',   bids: [[99.9, 100], [97, 11000], [95, 5000]], asks }; // @95 confirms, @97 SOLO bigger
  const agg = aggregateOrderbookClusters([binance, bybit]);
  test('aggregate: merges both venues, source labels both', () => {
    truthy(agg && agg.venuesAvailable === 2);
    eq(agg.source, 'binance+bybit');
  });
  test('aggregate: a CONFIRMED wall outranks a bigger SOLO wall (anti-spoof)', () => {
    // @95 raw 950K (both venues) beats @97 raw 1.07M (Bybit only) AFTER weighting
    eq(agg.bidClusters[0].distancePct, -5, 'confirmed −5% wall ranks first');
    eq(agg.bidClusters[0].venues, 2);
    eq(agg.bidClusters[1].venues, 1);
    truthy(agg.bidClusters[0].rawUsd < agg.bidClusters[1].rawUsd, 'confirmation flipped the raw-size ranking');
  });
  test('aggregate: single venue → no confirmation weighting (sizeUsd === rawUsd)', () => {
    const solo = aggregateOrderbookClusters([binance]);
    eq(solo.venuesAvailable, 1);
    const w95 = solo.bidClusters.find(c => c.distancePct === -5);
    truthy(w95 && Math.abs(w95.sizeUsd - w95.rawUsd) < 1e-6, 'solo book is unweighted');
  });
  test('aggregate: no usable book → null', () => {
    eq(aggregateOrderbookClusters([null, null]), null);
    eq(aggregateOrderbookClusters([]), null);
  });
}

// ── 13a3. Exchange-listing detection (the SLX/Bithumb miss) ─────────────────
console.log('\n[13a3] Listing detection: category-aware + ticker extraction');
test('listing: Bithumb market-addition category → IS a listing (real SLX post)', () => {
  truthy(classifyListing({ categories: ['마켓 추가'], title: '솔스티스(SLX) 원화 마켓 추가 (거래 오픈 오후 6시 예정)' }));
});
test('listing: SAME ticker in an airdrop "이벤트" category → NOT a listing (no dup)', () => {
  falsy(classifyListing({ categories: ['이벤트'], title: '총 2억원 상당, 솔스티스(SLX) 원화마켓 추가 기념 에어드랍 이벤트' }));
});
test('listing: no categories → title-keyword based (Binance/Upbit)', () => {
  truthy(classifyListing({ categories: [], title: 'Binance Will List Foobar (FOO)' }));
  falsy(classifyListing({ categories: [], title: 'Notice: BAR will be delisted from spot' }));
  // Upbit Korean titles that the OLD keyword set missed (the OPG miss): digital
  // asset / listing / trading-support phrasings now match.
  truthy(classifyListing({ categories: [], title: '오피지(OPG) 디지털 자산 추가' }), '디지털 자산');
  truthy(classifyListing({ categories: [], title: 'OPG(OPG) KRW 마켓 신규 상장 안내' }), '신규 상장');
  truthy(classifyListing({ categories: [], title: '비트코인(BTC) 거래지원 개시' }), '거래지원');
  // The EXACT live Upbit titles (verified via the Tokyo forwarder 2026-06-15) —
  // the real OPG miss + its neighbours; the delisting must stay vetoed.
  truthy(classifyListing({ categories: [], title: '오픈그라디언트(OPG) 신규 거래지원 안내 (BTC, USDT 마켓)' }), 'real OPG');
  truthy(classifyListing({ categories: [], title: '바빌론(BABY) KRW 마켓 디지털 자산 추가' }), 'real BABY');
  eq(extractTickers('오픈그라디언트(OPG) 신규 거래지원 안내 (BTC, USDT 마켓)').join(','), 'OPG');
  falsy(classifyListing({ categories: [], title: '[거래 종료] 어떤코인(XYZ) 상장 폐지 안내' }), 'delist vetoed');
  // DELISTINGS that fired as new listings (DENT/NOM/LRC): "거래지원 종료" = trading-
  // SUPPORT termination. The positive '거래지원' matched and the old negative '거래 종료'
  // did NOT (the '지원' breaks the substring) — '종료' is the reliable veto now.
  falsy(classifyListing({ categories: [], title: '덴트(DENT) 거래지원 종료 안내(3/30 15:00)' }), 'DENT delisting vetoed');
  falsy(classifyListing({ categories: [], title: '루프링(LRC) 거래지원 종료 안내 (3/16 15:00)' }), 'LRC delisting vetoed');
  // and real new listings still pass
  truthy(classifyListing({ categories: [], title: '아즈텍(AZTEC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)' }), 'AZTEC new listing still fires');
});
test('listing: classifyRiskTag flags Monitoring/Seed/caution, ignores normal listings', () => {
  eq(classifyRiskTag({ title: 'Binance Will Add FOO to the Monitoring Tag' })?.tag, 'Monitoring');
  eq(classifyRiskTag({ title: 'Notice on Seed Tag tokens (BAR)' })?.tag, 'Seed');
  eq(classifyRiskTag({ title: '어떤코인(XYZ) 유의 종목 지정 안내' })?.tag, 'Caution');
  eq(classifyRiskTag({ title: '아즈텍(AZTEC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)' }), null);  // a real listing, not a risk tag
});
test('listing: parseAnnouncementTs handles ISO / epoch-ms / epoch-s / junk', () => {
  truthy(Math.abs(parseAnnouncementTs('2026-06-27T11:00:00Z') - Date.parse('2026-06-27T11:00:00Z')) < 2);
  eq(parseAnnouncementTs(1_700_000_000_000), 1_700_000_000_000);   // ms passes through
  eq(parseAnnouncementTs(1_700_000_000), 1_700_000_000_000);       // seconds → ms
  eq(parseAnnouncementTs(null), null);
  eq(parseAnnouncementTs('not a date'), null);
});
test('listing: extractTickers pulls the parenthesised ticker, drops quote noise', () => {
  eq(extractTickers('솔스티스(SLX) 원화 마켓 추가').join(','), 'SLX');
  eq(extractTickers('Binance Will List Movement (MOVE)').join(','), 'MOVE');
  eq(extractTickers('KRW market support for (USDT)').length, 0);
});

// ── 13a4. CEX distribution detector (the SKYAI watch — scale-invariant) ──────
console.log('\n[13a4] Distribution aggregation: cumulative outflow vs 24h volume');
const NOW = 2_000_000_000;
const ev = (usd, agoMs = 1000) => ({ usd, ts: NOW - agoMs });
test('distribution: 5 transfers, $600K, 6% of 24h vol → TRIGGERED', () => {
  const r = assessDistribution(Array.from({ length: 5 }, () => ev(120_000)), { now: NOW, vol24h: 10_000_000 });
  truthy(r && r.count === 5);
  eq(r.cumulativeUsd, 600_000);
  truthy(Math.abs(r.volPct - 6) < 0.01);
});
test('distribution: too few transfers (<5) → null (needs a STREAM)', () =>
  eq(assessDistribution([ev(300_000), ev(300_000), ev(300_000)], { now: NOW, vol24h: 10_000_000 }), null));
test('distribution: below the absolute floor ($100K) → null', () =>
  eq(assessDistribution(Array.from({ length: 5 }, () => ev(20_000)), { now: NOW, vol24h: 10_000_000 }), null));
test('distribution: big $ but tiny vs 24h vol ($1.2M of $1B) → null (BTC/ETH safe)', () =>
  eq(assessDistribution(Array.from({ length: 6 }, () => ev(200_000)), { now: NOW, vol24h: 1_000_000_000 }), null));
test('distribution: all transfers older than the window → null (pruned out)', () =>
  eq(assessDistribution(Array.from({ length: 6 }, () => ev(200_000, 3 * 60 * 60_000)), { now: NOW, vol24h: 10_000_000 }), null));
test('distribution: no 24h vol → falls back to a higher absolute floor (3×)', () => {
  eq(assessDistribution(Array.from({ length: 6 }, () => ev(150_000)), { now: NOW }), null);          // $900K < $1.5M
  truthy(assessDistribution(Array.from({ length: 6 }, () => ev(300_000)), { now: NOW }));            // $1.8M ≥ $1.5M
});

// ── 13b. Heatmap feeds /analyze scoring (dominance-based, low-cap aware) ─────
console.log('\n[13b] Orderbook heatmap in /analyze');
await aTest('a dominant wall in the path penalises the trade + is surfaced', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['tx'];
  universe.lookupByCgId = (id) => id === 'tx' ? { symbol: 'TX', circulatingSupply: 1e9 } : null;
  universe.isFavored = () => false; universe.isPinned = () => false;
  const prices = new EventEmitter(); prices.getPrice = () => 100;
  const downTf = (atr) => ({ trend: 'down', atr, rsi: 45, macdHist: -0.2, recentWickRatio: 1, swingHigh: 130, swingLow: 70, swingHighs: [], swingLows: [] });
  const metadata = { '5min': downTf(0.5), '1hour': downTf(0.8), '4hour': downTf(1.0), 'daily': downTf(1.5), '1week': downTf(2.0) };
  const taService = { analyze: async (_s, side) => ({ findings: side === 'SHORT' ? [{ kind: 'ta', text: 'down', points: 1.4 }] : [], metadata }) };
  // Low-cap-style book: a $600K bid wall ~6× the median → dominant barrier for a SHORT.
  const liquidityClusters = { getClusters: async () => ({
    mid: 100, source: 'test',
    bidClusters: [ { midPrice: 95, distancePct: -5, sizeUsd: 600_000 }, { midPrice: 97, distancePct: -3, sizeUsd: 100_000 }, { midPrice: 96, distancePct: -4, sizeUsd: 90_000 } ],
    askClusters: [ { midPrice: 103, distancePct: 3, sizeUsd: 80_000 }, { midPrice: 105, distancePct: 5, sizeUsd: 90_000 } ]
  }) };
  const c = new Conductor({ universe, prices, onchainSources: [], funding: null, taService, liquidityClusters });
  const a = await c.evaluateForAnalysis({ symbol: 'TX' });
  truthy(a, 'analysis produced');
  eq(a.side, 'SHORT', 'down metadata → SHORT');
  const hm = (a.reasons ?? []).find(r => r.kind === 'liqHeatmap');
  truthy(hm, 'heatmap finding present in /analyze reasons (was missing before)');
  truthy(hm.points < 0, 'dominant bid wall in the SHORT path scores as a barrier (negative)');
});

// ── 13c. Exhaustion guard — buying a multi-TF parabolic top is demoted ──────
console.log('\n[13c] RSI exhaustion guard');
await aTest('LONG into 1h/4h/daily extreme overbought is demoted out of signal range', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['stg'];
  universe.lookupByCgId = (id) => id === 'stg' ? { symbol: 'STG', circulatingSupply: 1e9 } : null;
  universe.isFavored = () => false; universe.isPinned = () => false;
  const prices = new EventEmitter(); prices.getPrice = () => 0.4;
  // All TFs trend UP but RSI is extreme-overbought on the higher TFs (the STG case).
  const tf = (atr, rsi) => ({ trend: 'up', atr, rsi, macdHist: 0.2, recentWickRatio: 1, swingHigh: 0.6, swingLow: 0.3, swingHighs: [], swingLows: [] });
  const metadata = {
    '5min': tf(0.004, 60), '1hour': tf(0.008, 86), '4hour': tf(0.01, 91),
    'daily': tf(0.015, 81), '1week': tf(0.02, 70)
  };
  const taService = { analyze: async (_s, side) => ({
    findings: side === 'LONG' ? [{ kind: 'ta', text: 'squeeze', points: 2.5 }] : [],
    metadata }) };
  const c = new Conductor({ universe, prices, onchainSources: [], funding: null, taService });
  const a = await c.evaluateForAnalysis({ symbol: 'STG' });
  truthy(a, 'analysis produced');
  eq(a.side, 'LONG');
  eq(a.tradePlan.exhaustionTfs, 3, 'three higher TFs flagged extreme-overbought');
  // A strong raw LONG (squeeze + up alignment) is demoted below MEDIUM → no signal.
  truthy(['MIXED', 'LOW'].includes(a.strength.label), `exhausted LONG should be ≤ LOW, got ${a.strength.label}`);
});

// ── 14. PriceMonitor — Binance primary + CoinGecko spot-only fallback ───────
console.log('\n[14] PriceMonitor: Binance tickers (relay) + CoinGecko fallback');
await aTest('Bybit drives perp price/surge; CoinGecko covers spot-only; junk symbols skipped', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['bitcoin', 'spotonly'];
  universe.lookupByCgId = (id) =>
    id === 'bitcoin'  ? { symbol: 'BTC' } :
    id === 'spotonly' ? { symbol: 'SPOTX' } : null;
  universe.isFavored = () => false;

  let binCall = 0, cgHit = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v5/market/tickers')) {
      binCall++;
      const btc = binCall === 1 ? 100 : 106;   // +6% on 2nd poll → surge
      // Bybit shape: result.list[], price24hPcnt is a FRACTION, turnover24h ≈ USD vol.
      return { ok: true, json: async () => ({ result: { list: [
        { symbol: 'BTCUSDT',  lastPrice: String(btc), price24hPcnt: '0.125', turnover24h: '1000000000' },
        { symbol: 'ETHUSDC',  lastPrice: '3000', price24hPcnt: '0.01', turnover24h: '1' },   // not USDT → skip
        { symbol: 'WEIRD',    lastPrice: '99',   price24hPcnt: '0.01', turnover24h: '1' }    // odd symbol → skip
      ] } }) };
    }
    if (u.includes('/coins/markets')) {
      cgHit++;
      // CG must be asked ONLY for the uncovered spot-only token, never BTC.
      truthy(u.includes('spotonly'), 'CoinGecko should be queried for spot-only token');
      truthy(!u.includes('bitcoin'), 'CoinGecko must NOT re-fetch the Bybit-covered token');
      return { ok: true, json: async () => ([
        { id: 'spotonly', current_price: 0.5, total_volume: 9_000_000, price_change_percentage_24h: 3 }
      ]) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const pm = new PriceMonitor({
      universe, surgePct: 3, minVolumeUsd: 1_000_000,
      relayBaseUrl: 'https://relay.test/relay', relayAuthSecret: 'sek', cgEveryN: 1
    });
    const surges = [];
    pm.on('surge', s => surges.push(s));

    await pm.pollOnce();                       // tick 1 — BTC=100 (perp), SPOTX=0.5 (CG)
    eq(pm.getPrice('bitcoin'), 100, 'BTC priced from Bybit');
    eq(pm.getPrice('spotonly'), 0.5, 'spot-only priced from CoinGecko');
    truthy(pm.binanceCovered.has('bitcoin'), 'BTC marked perp-covered');
    truthy(!pm.binanceCovered.has('spotonly'), 'spot-only NOT perp-covered');
    eq(pm.priceChange24h.get('bitcoin'), 12.5, '24h% from Bybit (0.125 → 12.5%)');

    // Backdate BTC history so the next poll sees a >60s-old reference price.
    const h = pm.history.get('bitcoin');
    h[0].ts -= 61_000;
    await pm.pollOnce();                       // tick 2 — BTC=106 vs 100 → +6% surge
    eq(pm.getPrice('bitcoin'), 106, 'BTC updated from Binance');
    const btcSurge = surges.find(s => s.token.symbol === 'BTC');
    truthy(btcSurge && btcSurge.direction === 'up', 'BTC +6% should emit an up-surge');
  } finally {
    globalThis.fetch = origFetch;
  }
});
await aTest('relay absent → CoinGecko covers the FULL universe (no regression)', async () => {
  const universe = new Universe({});
  universe.allCgIds = () => ['bitcoin'];
  universe.lookupByCgId = (id) => id === 'bitcoin' ? { symbol: 'BTC' } : null;
  universe.isFavored = () => false;
  const origFetch = globalThis.fetch;
  let askedBitcoin = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/coins/markets')) {
      if (u.includes('bitcoin')) askedBitcoin = true;
      return { ok: true, json: async () => ([{ id: 'bitcoin', current_price: 70000, total_volume: 5e9, price_change_percentage_24h: 1 }]) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const pm = new PriceMonitor({ universe, surgePct: 3, relayBaseUrl: null });  // no relay
    await pm.pollOnce();
    truthy(askedBitcoin, 'with no relay, CoinGecko fetches the full universe');
    eq(pm.getPrice('bitcoin'), 70000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── 15. Regime filter (item G) ──────────────────────────────────────────────
console.log('\n[15] BTC regime scoring');
test('LONG fighting a BTC downtrend is penalised', () => {
  eq(regimeScoreForSide('LONG', { regime: 'BTC_DOWN', acute: false }, { penalty: 1 }).points, -1);
});
test('penalty is 1.5× when BTC is acutely dumping', () => {
  eq(regimeScoreForSide('LONG', { regime: 'BTC_DOWN', acute: true }, { penalty: 1 }).points, -1.5);
});
test('SHORT aligned with a BTC downtrend gets a tailwind', () => {
  eq(regimeScoreForSide('SHORT', { regime: 'BTC_DOWN' }, { penalty: 1, tailwind: 0.3 }).points, 0.3);
});
test('LONG aligned with a BTC uptrend gets a tailwind', () => {
  eq(regimeScoreForSide('LONG', { regime: 'BTC_UP' }, { tailwind: 0.3 }).points, 0.3);
});
test('CHOP / null regime → no adjustment', () => {
  eq(regimeScoreForSide('LONG', { regime: 'CHOP' }), null);
  eq(regimeScoreForSide('LONG', null), null);
});
test('RegimeMonitor toggle: enabled by default, setEnabled flips it', () => {
  const m = new RegimeMonitor({ taService: null });
  eq(m.isEnabled(), true);
  eq(m.setEnabled(false), false);
  eq(m.isEnabled(), false);
  m.setEnabled(true);
  eq(m.isEnabled(), true);
});
test('RegimeMonitor honours initial enabled:false (detect-only)', () => {
  eq(new RegimeMonitor({ taService: null, enabled: false }).isEnabled(), false);
});

// ── 16. Trailing-stop plumbing (item E) ─────────────────────────────────────
console.log('\n[16] Trailing-stop plumbing');
test('PaperBroker.setStop ratchets SL → trade exits at the trailed level', () => {
  let px = 100;
  const pb = new PaperBroker({ startBalance: 1000, priceFn: () => px });
  pb.placeMarketOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: 1, stopLoss: 95, takeProfit: 130 });
  pb.setStop('BTCUSDT', { stopLoss: 100 });                 // trail to breakeven after TP1
  eq(pb.positions.get('BTCUSDT').sl, 100, 'SL moved to breakeven');
  px = 99.5;                                                // dips below the trailed stop
  const resolved = pb.resolveTouches();
  eq(resolved.length, 1);
  eq(resolved[0].reason, 'SL');
  close(resolved[0].exitPrice, 100, 1e-9, 'exits at the trailed breakeven (100), not the original 95');
});
test('PaperBroker limit order RESTS until touched, then fills (not an instant fill)', () => {
  let px = 100;
  const pb = new PaperBroker({ startBalance: 1000, priceFn: () => px });
  pb.placeLimitOrder({ symbol: 'ETHUSDT', side: 'Buy', qty: 1, price: 95, stopLoss: 90, takeProfit: 110 });
  eq(pb.positions.size, 0, 'no position yet — limit is resting');
  eq(pb.pendingLimits.size, 1, 'one resting limit');
  pb.resolveTouches();                       // price still 100 > 95 limit → no fill
  eq(pb.positions.size, 0, 'still resting (LONG limit needs price to FALL to 95)');
  px = 94.5;                                 // price drops to/through the limit
  pb.resolveTouches();
  eq(pb.positions.size, 1, 'limit filled into a position once touched');
  eq(pb.pendingLimits.size, 0, 'resting limit consumed');
  close(pb.positions.get('ETHUSDT').entryPrice, 95, 1e-9, 'fills AT the limit price, not the market tick');
});
test('PaperBroker.cancelOrder drops a resting limit (expiry path)', () => {
  const pb = new PaperBroker({ startBalance: 1000, priceFn: () => 100 });
  pb.placeLimitOrder({ symbol: 'SOLUSDT', side: 'Sell', qty: 1, price: 110 });   // sync body runs (no internal await)
  eq(pb.pendingLimits.size, 1, 'limit resting');
  pb.cancelOrder('SOLUSDT');
  eq(pb.pendingLimits.size, 0, 'cancelled by symbol');
});
test('TradeStore.updateTrade patches an open trade', () => {
  const path = join(tmpdir(), `trades-test-${Date.now()}.jsonl`);
  const ts = new TradeStore({ path });
  ts.append({ id: 'x', symbol: 'BTCUSDT', status: 'open', trailStage: 0, sl: 95 });
  truthy(ts.updateTrade('x', { trailStage: 1, sl: 100 }));
  const open = ts.openTrades();
  eq(open[0].trailStage, 1);
  eq(open[0].sl, 100);
  if (existsSync(path)) unlinkSync(path);
});
test('TradeStore.hasOpen matches by FULL symbol + optional mode (dup-guard fix)', () => {
  const path = join(tmpdir(), `trades-dup-${Date.now()}.jsonl`);
  const ts = new TradeStore({ path });
  ts.append({ id: 'p', symbol: 'STGUSDT', status: 'open', mode: 'paper' });
  truthy(ts.hasOpen('STGUSDT'), 'matches the stored Bybit symbol');
  falsy(ts.hasOpen('STG'), 'does NOT match the bare token symbol — the old guard bug');
  truthy(ts.hasOpen('STGUSDT', 'paper'), 'matches when the mode agrees');
  falsy(ts.hasOpen('STGUSDT', 'live'), 'a paper trade does NOT block a live entry on the same symbol');
  if (existsSync(path)) unlinkSync(path);
});

// ── 17. Crypto vault (per-user key storage at rest) ─────────────────────────
console.log('\n[17] Crypto vault');
test('encrypt → decrypt round-trips the secret', () => {
  process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-key-0123456789';
  truthy(vaultAvailable());
  const secret = 'bybit-api-secret-ABC123xyz';
  const blob = encryptSecret(secret);
  truthy(!blob.includes(secret), 'ciphertext must not contain the plaintext');
  eq(decryptSecret(blob), secret);
});
test('two encryptions of the same value differ (random IV) but both decrypt', () => {
  process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-key-0123456789';
  const a = encryptSecret('same'), b = encryptSecret('same');
  truthy(a !== b, 'IV randomises the ciphertext');
  eq(decryptSecret(a), 'same');
  eq(decryptSecret(b), 'same');
});
test('tampered ciphertext fails authentication (GCM)', () => {
  process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-key-0123456789';
  const blob = encryptSecret('keep-me-safe');
  const [iv, tag, ct] = blob.split('.');
  const flipped = ct[0] === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
  let threw = false;
  try { decryptSecret(`${iv}.${tag}.${flipped}`); } catch { threw = true; }
  truthy(threw, 'decrypt must throw on tampered ciphertext');
});
test('wrong secret cannot decrypt', () => {
  process.env.KEY_ENCRYPTION_SECRET = 'unit-test-secret-key-0123456789';
  const blob = encryptSecret('top-secret');
  process.env.KEY_ENCRYPTION_SECRET = 'a-totally-different-secret-key-99';
  let threw = false;
  try { decryptSecret(blob); } catch { threw = true; }
  truthy(threw, 'a different secret must not decrypt');
});
test('vaultAvailable false when secret missing/too short; maskSecret hides middle', () => {
  const saved = process.env.KEY_ENCRYPTION_SECRET;
  delete process.env.KEY_ENCRYPTION_SECRET;
  falsy(vaultAvailable());
  process.env.KEY_ENCRYPTION_SECRET = 'short';
  falsy(vaultAvailable(), 'a <16-char secret is rejected');
  process.env.KEY_ENCRYPTION_SECRET = saved;
  eq(maskSecret('abcdefghijklmnop'), 'abcd…mnop');
  eq(maskSecret('tiny'), '••••');
});

// ── 18. TradeStore.breakdown (the /pnl view) ────────────────────────────────
console.log('\n[18] TradeStore PnL breakdown');
test('breakdown aggregates by mode + symbol, lists open + recent', () => {
  const path = join(tmpdir(), `pnl-${Date.now()}.jsonl`);
  const ts = new TradeStore({ path });
  ts.append({ id: '1', mode: 'live', symbol: 'BTCUSDT', side: 'Buy', status: 'closed', pnlUsd: 10, pnlPct: 2, reason: 'TP' });
  ts.append({ id: '2', mode: 'live', symbol: 'BTCUSDT', side: 'Sell', status: 'closed', pnlUsd: -4, pnlPct: -1, reason: 'SL' });
  ts.append({ id: '3', mode: 'paper', symbol: 'ETHUSDT', side: 'Buy', status: 'closed', pnlUsd: 7, pnlPct: 3, reason: 'TP' });
  ts.append({ id: '4', mode: 'live', symbol: 'SOLUSDT', side: 'Buy', status: 'open', entry: 100, qty: 1, sl: 95, tp: 110, notionalUsd: 100 });
  const b = ts.breakdown();
  eq(b.closed, 3); eq(b.open, 1); eq(b.wins, 2);
  eq(b.realisedUsd, 13);                       // 10 - 4 + 7
  eq(b.byMode.live.pnlUsd, 6);                 // 10 - 4
  eq(b.byMode.paper.pnlUsd, 7);
  eq(b.bySymbol[0].symbol, 'ETHUSDT');         // highest pnl (+7) ranks first, then BTC (+6)
  eq(b.openTrades.length, 1);
  eq(b.openTrades[0].symbol, 'SOLUSDT');
  eq(b.recent.length, 3);
  // mode scoping
  eq(ts.breakdown('paper').closed, 1);
  eq(ts.breakdown('paper').realisedUsd, 7);
  if (existsSync(path)) unlinkSync(path);
});

// ── 19. Liquidation heatmap engine ──────────────────────────────────────────
console.log('\n[19] Liquidation heatmap');
test('maps far short-liq above + flushes longs that price swept through', () => {
  const C = (t, o, h, l, c) => ({ t, o, h, l, c });
  // Price falls 0.065 → 0.031; OI +1M opened ~0.064 (high), +1M opened ~0.031 (recent).
  const candles = [
    C(1, 0.065, 0.066, 0.064, 0.065), C(2, 0.065, 0.065, 0.063, 0.064),
    C(3, 0.064, 0.064, 0.058, 0.060), C(4, 0.060, 0.060, 0.048, 0.050),
    C(5, 0.050, 0.050, 0.038, 0.040), C(6, 0.040, 0.041, 0.030, 0.032),
    C(7, 0.032, 0.033, 0.030, 0.031),
  ];
  const oi = new Map([[1, 500000], [2, 1500000], [3, 1500000], [4, 1500000], [5, 1500000], [6, 1500000], [7, 2500000]]);
  // Engine correctness — with a WIDE range the far short cluster (0.065 shorts,
  // liquidating ~+100-150% above the 0.031 price) is placed correctly.
  const m = computeLiquidationHeatmap(candles, oi, new Map(), { currentPrice: 0.031, maxDistPct: 250 });
  truthy(m, 'returns a map');
  truthy(m.shortLiqs.some(c => c.distancePct > 90), 'far short-liq cluster (the 0.065 shorts) appears above +90% when range allows');
  truthy(m.shortLiqs.some(c => c.distancePct > 0 && c.distancePct < 30), 'near short-liq cluster too');
  truthy(m.longLiqs.some(c => c.distancePct < 0 && c.distancePct > -30), 'near long-liq cluster below');
  falsy(m.longLiqs.some(c => c.distancePct < -40), 'the high 0.065 LONGS were flushed (price swept them)');
  truthy(m.totalShortUsd > 0 && m.totalLongUsd > 0, 'totals populated');
  // The Coinglass-like ±80% cap drops far phantom clusters (the actual default).
  const capped = computeLiquidationHeatmap(candles, oi, new Map(), { currentPrice: 0.031, maxDistPct: 80 });
  falsy(capped.shortLiqs.some(c => c.distancePct > 80), 'beyond ±80% is excluded — no phantom far clusters');
});
test('liq heatmap: too few candles → null', () => {
  eq(computeLiquidationHeatmap([{ t: 1, o: 1, h: 1, l: 1, c: 1 }], new Map(), new Map(), {}), null);
});
test('liq heatmap: recency weight down-weights OLD OI builds (Coinglass-style)', () => {
  const C = (t, o, h, l, c) => ({ t, o, h, l, c });
  // One OI build early in the window (candle 2). Price hovers ~1.00 so both the
  // long-liq (below) and short-liq (above) levels survive and land in-band.
  const candles = [
    C(1, 1.00, 1.00, 1.00, 1.00), C(2, 1.00, 1.02, 0.98, 1.00),
    C(3, 1.00, 1.02, 0.98, 1.00), C(4, 1.00, 1.02, 0.98, 1.00),
    C(5, 1.00, 1.02, 0.98, 1.00),
  ];
  const oi = new Map([[1, 1e6], [2, 2e6], [3, 2e6], [4, 2e6], [5, 2e6]]);
  const off = computeLiquidationHeatmap(candles, oi, new Map(), { currentPrice: 1.00, recencyHalfLife: 0 });
  const on  = computeLiquidationHeatmap(candles, oi, new Map(), { currentPrice: 1.00, recencyHalfLife: 1 });
  truthy(off && on, 'both maps compute');
  const totalOff = off.totalLongUsd + off.totalShortUsd;
  const totalOn  = on.totalLongUsd + on.totalShortUsd;
  truthy(totalOn < totalOff, 'recency on yields LESS notional — the old build is down-weighted');
  truthy(totalOn > 0.4 * totalOff, 'but only modestly at the default half-life (not erased)');
});
test('liquidity sweep: highs swept (short-liq cluster gone) → fade SHORT toward the low cluster', () => {
  // Prior snapshot: price 100, a $5M short-liq cluster at 108 (above), a $4M long-liq at 92 (below).
  const prev = { currentPrice: 100,
    shortLiqs: [{ price: 108, distancePct: 8, notionalUsd: 5e6 }],
    longLiqs:  [{ price: 92,  distancePct: -8, notionalUsd: 4e6 }] };
  // New snapshot: price ran to 109 (swept the 108 shorts → that cluster is GONE); the
  // 92 long cluster still sits below.
  const next = { currentPrice: 109,
    shortLiqs: [],
    longLiqs:  [{ price: 92, distancePct: -15.6, notionalUsd: 4e6 }] };
  const s = detectLiquiditySweep(prev, next);
  truthy(s, 'a sweep is detected');
  eq(s.side, 'up');
  eq(s.fadeSide, 'SHORT', 'highs swept → fade SHORT');
  eq(s.sweptUsd, 5e6);
  eq(s.targetPrice, 92, 'targets the surviving long-liq cluster below');
});
test('liquidity sweep: lows swept → fade LONG toward the high cluster', () => {
  const prev = { currentPrice: 100,
    shortLiqs: [{ price: 110, distancePct: 10, notionalUsd: 6e6 }],
    longLiqs:  [{ price: 94,  distancePct: -6, notionalUsd: 5e6 }] };
  const next = { currentPrice: 93,   // ran down through 94 → long cluster swept
    shortLiqs: [{ price: 110, distancePct: 18.3, notionalUsd: 6e6 }],
    longLiqs:  [] };
  const s = detectLiquiditySweep(prev, next);
  truthy(s, 'a sweep is detected');
  eq(s.fadeSide, 'LONG', 'lows swept → fade LONG');
  eq(s.targetPrice, 110, 'targets the surviving short-liq cluster above');
});
test('liquidity sweep: a cluster that price never reached is NOT a sweep', () => {
  const prev = { currentPrice: 100,
    shortLiqs: [{ price: 120, distancePct: 20, notionalUsd: 5e6 }], longLiqs: [] };
  // Price barely moved (101); the 120 cluster is gone from the new map (model noise),
  // but price never got near it → no sweep.
  const next = { currentPrice: 101, shortLiqs: [], longLiqs: [] };
  eq(detectLiquiditySweep(prev, next), null, 'gone-but-untagged cluster is not a sweep');
});
test('liquidity sweep: a sub-threshold cluster does not count', () => {
  const prev = { currentPrice: 100,
    shortLiqs: [{ price: 105, distancePct: 5, notionalUsd: 200_000 }], longLiqs: [] };
  const next = { currentPrice: 106, shortLiqs: [], longLiqs: [] };
  eq(detectLiquiditySweep(prev, next), null, 'a $200k swept cluster is below the $1M floor');
});
await aTest('liq heatmap: open interest is SUMMED across multiple exchange markets', async () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({ t: 1000 + i * 14400, o: 100, h: 101, l: 99, c: 100 }));
  // Each exchange contributes the same OI build (+$1M at bar 1); aggregated = +$2M.
  const oiSeries = () => ({ history: bars.map((b, i) => ({ t: b.t, c: i >= 1 ? 2_000_000 : 1_000_000 })) });
  const coinalyze = {
    perpMarketsFor: async () => ['BASE.A', 'BASE.6'],          // two venues
    ohlcvHistory:   async () => ([{ history: bars.map(b => ({ ...b })) }]),
    openInterestHistory: async (syms) => syms.map(() => oiSeries()),
    longShortRatio: async () => null,
  };
  const hm = new LiquidationHeatmap({ coinalyze, perpSymbolMap: new Map([['BASE', 'BASE.A']]) });
  const m = await hm.compute('BASE');
  truthy(m, 'map computes from aggregated OI');
  eq(m.oiMarkets, 2, 'two exchange OI series were aggregated');
  truthy((m.totalLongUsd + m.totalShortUsd) > 0, 'clusters populated from the summed OI build');
});
test('adaptive leverage: high vol skews to LOW leverage, low vol to HIGH', () => {
  const wOf = (arr, lev) => (arr.find(t => t.lev === lev)?.weight ?? 0);
  const meme = adaptiveLeverages(10);   // 10%/bar — volatile
  const major = adaptiveLeverages(1);   // 1%/bar — stable
  // Volatile token: weight sits on low leverage and the 100x band is dropped.
  truthy(wOf(meme, 5) + wOf(meme, 10) > wOf(meme, 50) + wOf(meme, 100), 'meme skews low-leverage');
  truthy(wOf(meme, 100) < 0.03, '100x band negligible/dropped on a 10%/bar coin');
  // Stable token: weight sits on high leverage.
  truthy(wOf(major, 50) + wOf(major, 100) > wOf(major, 5) + wOf(major, 10), 'major skews high-leverage');
  // Weights always normalise to ~1.
  const sum = (a) => a.reduce((s, t) => s + t.weight, 0);
  close(sum(meme), 1, 1e-9, 'meme weights sum to 1');
  close(sum(major), 1, 1e-9, 'major weights sum to 1');
});
test('realizedVolPct: median per-bar range %', () => {
  const c = (h, l, cl) => ({ t: 0, o: cl, h, l, c: cl });
  // ranges: 10/100=10%, 2/100=2%, 6/100=6% → median 6%
  eq(realizedVolPct([c(110, 100, 100), c(102, 100, 100), c(106, 100, 100)]), 6);
});

// ── 19c. Accumulation detection (holder %-of-supply jumps) ──────────────────
console.log('\n[19c] Accumulation detection');
{
  test('flags a wallet whose supply share jumps ≥ minDelta, largest first', () => {
    const prev = [ { address: '0xAAA', percent: 2.0 }, { address: '0xBBB', percent: 5.0 } ];
    const cur  = [ { address: '0xAAA', percent: 6.0 },   // +4.0 → accumulating
                   { address: '0xBBB', percent: 5.3 },   // +0.3 → noise, ignored
                   { address: '0xCCC', percent: 3.0 } ]; // new 3% holder (prev 0) → +3.0
    const accs = detectAccumulation(prev, cur, { minDelta: 2 });
    eq(accs.length, 2, 'two accumulators');
    eq(accs[0].address, '0xAAA', 'largest gain first');
    eq(accs[0].delta, 4); eq(accs[1].address, '0xCCC'); eq(accs[1].delta, 3);
  });
  test('a wallet that SHRANK or barely moved is not accumulation', () => {
    const prev = [ { address: '0xAAA', percent: 8.0 } ];
    const cur  = [ { address: '0xAAA', percent: 4.0 } ];   // distribution, not accumulation
    eq(detectAccumulation(prev, cur, { minDelta: 2 }).length, 0);
  });
  test('case-insensitive address match + empty prev (all new) ', () => {
    const accs = detectAccumulation([], [{ address: '0xDeAd', percent: 5 }], { minDelta: 2 });
    eq(accs.length, 1); eq(accs[0].delta, 5);
  });
  test('new holder appearing "from zero" at a huge share → suppressed (newly-tracked whale)', () => {
    // The ALLO 0%→34% / HYPER 0%→13% false alarms: a pre-existing whale entering
    // tracking, not accumulation. A modest new position (≤ maxNewPct) still fires.
    eq(detectAccumulation([], [{ address: '0xA', percent: 34 }], { minDelta: 2, maxNewPct: 10 }).length, 0);
    eq(detectAccumulation([], [{ address: '0xB', percent: 6 }], { minDelta: 2, maxNewPct: 10 }).length, 1);
    // A TRACKED holder growing past the cap is still real accumulation (prev > 0).
    eq(detectAccumulation([{ address: '0xC', percent: 8 }], [{ address: '0xC', percent: 20 }], { minDelta: 2, maxNewPct: 10 }).length, 1);
  });
}

// ── 20. Raw insider-sell transfer alert ─────────────────────────────────────
console.log('\n[20] Raw insider-sell alert');
await aTest('insider SELL flow emits a labelled insiderSell alert + de-dupes per tx', async () => {
  const universe = new Universe({});
  universe.lookupByCgId = () => ({ symbol: 'HMN' });
  universe.isFavored = () => true;
  const prices = new EventEmitter();
  prices.getPrice = () => 1.0;            // amount × $1 = USD value
  const src = new EventEmitter();
  const c = new Conductor({ universe, prices, onchainSources: [src] });
  c.start();   // wires the onchain 'flow' subscription
  // Pre-seed a same-side cooldown so the heavy async evaluation path early-returns
  // — we only assert the synchronous raw alert here.
  c.lastFiredAt.set('HMN', { ts: Date.now(), side: 'SHORT' });

  let alert = null;
  c.on('insiderSell', (e) => { alert = e; });

  const mkFlow = (txHash) => ({
    chain: 'ethereum',
    token: { symbol: 'HMN', coingeckoId: 'humanity', chain: 'ethereum', address: '0xabc' },
    exchange: 'Uniswap V3',
    direction: 'short',
    fromAddress: '0xd1ea823d421e0c829ee11f772af487fd352678ea',
    toAddress: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
    teamFlow: { side: 'sell', venue: 'dex', venueLabel: 'Uniswap V3', tokenSymbol: 'HMN', holderRank: 4, holderPercent: 2.34, hops: 0 },
    amount: 100000,                       // × $1 = $100k > $50k team-flow gate
    txHash,
    timestamp: Date.now()
  });

  src.emit('flow', mkFlow('0xdeadbeef'));
  truthy(alert, 'insiderSell event fired');
  truthy(/Insider Sell Detected/.test(alert.text), 'headline present');
  truthy(alert.text.includes('HMN'), 'token symbol present');
  truthy(alert.text.includes('Ethereum'), 'network label present');
  truthy(alert.text.includes('Uniswap V3'), 'venue label present');
  truthy(alert.text.includes('etherscan.io/tx/0xdeadbeef'), 'explorer tx link present');
  truthy(alert.text.includes('$100,000'), 'USD value present');

  alert = null;
  src.emit('flow', mkFlow('0xdeadbeef'));    // same tx
  falsy(alert, 'duplicate tx suppressed');

  alert = null;
  src.emit('flow', mkFlow('0xfeedface'));    // new tx
  truthy(alert, 'distinct tx fires again');
});

await aTest('sub-threshold insider sell does NOT fire the raw alert', async () => {
  const universe = new Universe({});
  universe.lookupByCgId = () => ({ symbol: 'HMN' });
  const prices = new EventEmitter();
  prices.getPrice = () => 1.0;
  const src = new EventEmitter();
  const c = new Conductor({ universe, prices, onchainSources: [src] });
  c.start();
  c.lastFiredAt.set('HMN', { ts: Date.now(), side: 'SHORT' });
  let alert = null;
  c.on('insiderSell', (e) => { alert = e; });
  src.emit('flow', {
    chain: 'ethereum',
    token: { symbol: 'HMN', coingeckoId: 'humanity' },
    exchange: 'Uniswap V3', direction: 'short',
    teamFlow: { side: 'sell', venue: 'dex', venueLabel: 'Uniswap V3', holderRank: 4, holderPercent: 2.3 },
    amount: 1000,                          // × $1 = $1k < $50k gate → demoted, no teamFlow
    txHash: '0x01', timestamp: Date.now()
  });
  falsy(alert, 'below $50k team-flow gate → no raw insider alert');
});

// ── 22. SignalTracker stats sources (Neon-backed /tunestats) ────────────────
console.log('\n[22] SignalTracker stats sources');
test('currentRecords returns the in-memory (Neon-backed) live set', () => {
  const path = join(tmpdir(), `sig-cur-${Date.now()}.jsonl`);
  const st = new SignalTracker({ path, priceMonitor: { getPrice: () => null } });
  st.records = [{ outcome: 'WIN_TP1', side: 'LONG' }, { outcome: 'LOSS', side: 'SHORT' }];
  const got = st.currentRecords();
  eq(got.length, 2);
  truthy(got !== st.records, 'returns a copy, not the live array');
  got.push({ junk: true });
  eq(st.records.length, 2, 'mutating the copy does not affect the source');
  if (existsSync(path)) unlinkSync(path);
});
await aTest('allRecords (disk mode) reads live + archived signals*.jsonl', async () => {
  const dir = tmpdir();
  const stamp = Date.now();
  const live = join(dir, `signals.jsonl`);
  const arch = join(dir, `signals.20240101T000000.jsonl`);
  // Write a live file + an archived-reset file in the same dir.
  writeFileSync(live, JSON.stringify({ outcome: 'WIN_TP2', side: 'LONG' }) + '\n');
  writeFileSync(arch, [
    JSON.stringify({ outcome: 'LOSS', side: 'SHORT' }),
    JSON.stringify({ outcome: 'WIN_TP1', side: 'LONG' })
  ].join('\n') + '\n');
  const st = new SignalTracker({ path: live, priceMonitor: { getPrice: () => null } });
  const all = await st.allRecords();
  // At least our 3 records (the shared tmpdir may hold other signals*.jsonl, so ≥).
  truthy(all.length >= 3, 'reads across live + archived files');
  truthy(all.some(r => r.outcome === 'WIN_TP2'), 'live record present');
  truthy(all.some(r => r.outcome === 'LOSS'), 'archived record present');
  if (existsSync(live)) unlinkSync(live);
  if (existsSync(arch)) unlinkSync(arch);
});

// ── 23. Progressive TP tracking (TP1→TP2→TP3 alerts) ────────────────────────
console.log('\n[23] Progressive TP tracking');
{
  // Helper: a SignalTracker whose bar source we drive tick-by-tick.
  let _seq = 0;
  const mkTracker = () => {
    const path = join(tmpdir(), `sig-tp-${Date.now()}-${_seq++}.jsonl`);
    let nextBars = [];
    const taService = { getRecentBars: async () => nextBars };
    const st = new SignalTracker({ path, priceMonitor: { getPrice: () => null }, taService });
    return { st, path, setBars: (b) => { nextBars = b; } };
  };
  const mkRecord = (over = {}) => ({
    ts: Date.now() - 30 * 60_000, symbol: 'HMN', side: 'LONG', cgId: 'humanity',
    entry: 100, sl: 95, tp1: 110, tp2: 120, tp3: 130,
    awaitingLimit: false, limitFilledAt: null, validityHrs: 48,
    tpHit: 0, outcome: null, outcomeAt: null, maxFavorable: null, maxAdverse: null, ...over
  });
  const bar = (h, l) => [{ t: Date.now() - 5 * 60_000, o: 100, h, l, c: (h + l) / 2 }];

  await aTest('TP1 then TP2 fire progressive alerts; trade stays open', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord();
    st.records = [rec];
    const tps = [], resolved = [];
    st.on('tpProgress', (s) => tps.push(s.tpLevel));
    st.on('resolved', (s) => resolved.push(s.outcome));

    st.taService.getRecentBars = async () => bar(112, 99);   // tags TP1 (110), no SL
    await st.resolveOpen();
    eq(rec.outcome, null, 'still open after TP1');
    eq(rec.tpHit, 1, 'tpHit advanced to 1');
    eq(tps.join(','), '1', 'TP1 progressive alert fired');

    st.taService.getRecentBars = async () => bar(122, 108);  // tags TP2 (120)
    await st.resolveOpen();
    eq(rec.outcome, null, 'still open after TP2');
    eq(rec.tpHit, 2);
    eq(tps.join(','), '1,2', 'TP2 progressive alert fired');
    eq(resolved.length, 0, 'no terminal close yet');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('TP3 closes the trade terminally (WIN_TP3)', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord({ tpHit: 2 });   // TP1+TP2 already banked
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    st.taService.getRecentBars = async () => bar(131, 119);  // tags TP3 (130)
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TP3', 'final TP resolves terminally');
    eq(resolved.join(','), 'WIN_TP3');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('after TP1, a retrace to entry closes at breakeven — NOT a loss', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord({ tpHit: 1 });   // TP1 already banked → SL at breakeven
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push({ outcome: s.outcome, breakeven: s.breakeven }));
    st.taService.getRecentBars = async () => bar(101, 94);   // dips below original SL (95) to 94
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TP1', 'banked TP1, not a LOSS');
    eq(resolved[0].breakeven, true, 'flagged as breakeven close');
    // Booked at breakeven (entry 100), NOT at the TP1 price — honest ~0% PnL.
    eq(rec.finalPnlPct, 0, 'breakeven exit books ~0%, not the TP1 gain');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('after TP2, a retrace closes locked at TP1 (not breakeven, not TP2)', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord({ tpHit: 2 });   // TP1+TP2 banked → SL ratchets to TP1 (110)
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    st.taService.getRecentBars = async () => bar(112, 105);   // dips to 105 (below TP1 110) — locked stop
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TP2', 'reached TP2');
    eq(rec.finalPnlPct, 10, 'exits at locked TP1 (+10%), not TP2 and not breakeven');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('SL before any TP is still a LOSS', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord();   // tpHit 0
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    st.taService.getRecentBars = async () => bar(104, 94);   // never tags TP1 (110), hits SL (95)
    await st.resolveOpen();
    eq(rec.outcome, 'LOSS');
    eq(resolved.join(','), 'LOSS');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('bank-pops: +3% peak then retrace → banks the pop (WIN_TRAIL), not a flat scratch', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord();   // entry 100, sl 95 (5% risk), tp1 110
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    const now = Date.now();
    // Bar 1 peaks +3% (103); the ~2% trail gap locks +1% above entry. Bar 2 retraces
    // to 99.9, tagging the +1% trail stop (~101) on the way down → banks +1%, NOT a
    // breakeven scratch (the SAGA "+7% then breakeven, no profit" complaint).
    st.taService.getRecentBars = async () => ([
      { t: now - 4 * 60_000, o: 100, h: 103, l: 100.5, c: 102 },
      { t: now - 3 * 60_000, o: 102, h: 102,  l: 99.9,  c: 100 }
    ]);
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TRAIL', 'a reversed +3% pop banks the trailed profit');
    truthy(rec.finalPnlPct > 0, 'resolved in profit, not at breakeven');
    const stats = st.getStats();
    eq(stats.wins, 1, 'counts as a (small) win, not a scratch');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('breakeven: a pop that barely arms BE (≤ trail gap) still scratches at entry', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord();   // entry 100, sl 95, tp1 110
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    const now = Date.now();
    // Peak only +2% (102) = the trail gap, so nothing locks above entry. A retrace to
    // 99.9 scratches at the breakeven stop, NOT the original SL (95).
    st.taService.getRecentBars = async () => ([
      { t: now - 4 * 60_000, o: 100, h: 102,   l: 100.5, c: 101.5 },
      { t: now - 3 * 60_000, o: 101.5, h: 101.5, l: 99.9, c: 100 }
    ]);
    await st.resolveOpen();
    eq(rec.outcome, 'BREAKEVEN', 'scratched at breakeven, not stopped at the original 95');
    eq(resolved.join(','), 'BREAKEVEN');
    const stats = st.getStats();
    eq(stats.resolved, 0, 'a scratch is excluded from the win/loss denominator');
    eq(stats.breakevens, 1, 'counted as a scratch (so a rescued loss raises WR)');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('early-BE does NOT rescue a single bar that spikes +2% AND wicks SL', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord();
    st.records = [rec];
    st.taService.getRecentBars = async () => bar(104, 94);   // +4% and −6% in ONE bar
    await st.resolveOpen();
    eq(rec.outcome, 'LOSS', 'intrabar order unknown → stays a LOSS, not a phantom scratch');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('FIDA fix: a limit that tags AFTER validity → EXPIRED_UNFILLED, not SL', async () => {
    const { st, path } = mkTracker();
    // LONG limit at 100, fired 3h ago with a 2h validity → the live order would
    // already be cancelled. A bar now tags the limit and dumps to the SL (95).
    const rec = mkRecord({
      awaitingLimit: true, limitEntry: 100, isLiquidityGrab: true,
      validityHrs: 2, ts: Date.now() - 3 * 60 * 60_000
    });
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    st.taService.getRecentBars = async () => bar(99, 94);   // tags 100 AND wicks the 95 SL
    await st.resolveOpen();
    eq(rec.outcome, 'EXPIRED_UNFILLED', 'expired at validity before any fill — no phantom SL');
    eq(resolved.join(','), 'EXPIRED_UNFILLED');
    const stats = st.getStats();
    eq(stats.resolved, 0, 'an unfilled setup is excluded from the win/loss denominator');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('limit that tags WITHIN validity still fills + resolves normally', async () => {
    const { st, path } = mkTracker();
    const rec = mkRecord({
      awaitingLimit: true, limitEntry: 100, isLiquidityGrab: true,
      validityHrs: 8, ts: Date.now() - 1 * 60 * 60_000   // 1h old, 8h validity → live
    });
    st.records = [rec];
    st.taService.getRecentBars = async () => bar(112, 99);   // tags 100 then runs to TP1 (110)
    await st.resolveOpen();
    eq(rec.awaitingLimit, false, 'filled within validity');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('phantom TP3: kline wick that diverges from live price → AMBIGUOUS (the BEAT bug)', async () => {
    const { st, path } = mkTracker();
    st.priceMonitor = { getPrice: () => 100 };   // broad-market price NEVER moved from entry (100)
    // ts recent (6m) so the scan window is FRESH — the live-price check only applies to
    // a recent exit (a stale window can't be corroborated by the current price).
    const rec = mkRecord({ ts: Date.now() - 6 * 60_000 });   // LONG entry 100, tp3 130
    st.records = [rec];
    const resolved = [];
    st.on('resolved', (s) => resolved.push(s.outcome));
    st.taService.getRecentBars = async () => bar(131, 99);   // klines "wick" to TP3 (131) — phantom
    await st.resolveOpen();
    eq(rec.outcome, 'AMBIGUOUS', 'phantom kline TP3 rejected — live price says it never moved');
    eq(resolved.join(','), 'AMBIGUOUS');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('STALE window: a real far-TP win that retraced is NOT voided (the corrupted-stats fix)', async () => {
    const { st, path } = mkTracker();
    st.priceMonitor = { getPrice: () => 100 };   // live price back at entry now (the win retraced)
    // ts 30m ago + no prior lastChecked → window spans 30m > RESOLVE_FRESH_MS(12m). The
    // live price is NOT a valid reference for that old an exit, so the genuine TP3 win
    // must be BOOKED, not voided as AMBIGUOUS (the bug that deflated the win rate).
    const rec = mkRecord({ ts: Date.now() - 30 * 60_000, tpHit: 2 });
    st.records = [rec];
    st.taService.getRecentBars = async () => bar(131, 119);   // tagged TP3 (130) inside the stale window
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TP3', 'stale exit is booked as the win it was, not rejected on a stale live price');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('real TP3: kline move corroborated by live price → WIN_TP3 (not rejected)', async () => {
    const { st, path } = mkTracker();
    st.priceMonitor = { getPrice: () => 129 };   // broad market confirms the move (~TP3)
    const rec = mkRecord({ tpHit: 2 });          // TP1+TP2 banked → TP3 terminal
    st.records = [rec];
    st.taService.getRecentBars = async () => bar(131, 119);  // tags TP3 (130)
    await st.resolveOpen();
    eq(rec.outcome, 'WIN_TP3', 'a corroborated move resolves normally');
    if (existsSync(path)) unlinkSync(path);
  });

  await aTest('banked TP1 runner counts as a win NOW and drops out of /open', async () => {
    const { st, path } = mkTracker();
    // Two still-open records: one fresh (tpHit 0), one that already banked TP1.
    const fresh  = mkRecord({ symbol: 'FRSH' });               // tpHit 0, outcome null
    const banked = mkRecord({ symbol: 'BNKD', tpHit: 1 });     // TP1 hit, still running
    st.records = [fresh, banked];
    const stats = st.getStats();
    eq(stats.open, 1, 'only the fresh trade is "open"; banked runner excluded');
    eq(stats.resolved, 1, 'banked runner counts toward resolved win-rate immediately');
    eq(stats.wins, 1, 'banked TP1 runner is a win before its final TP/stop');
    eq(stats.losses, 0, 'banked runner is never a loss');
    const openSyms = st.getOpenSignals().map(r => r.symbol);
    eq(openSyms.join(','), 'FRSH', '/open hides the banked runner, shows the fresh trade');
    if (existsSync(path)) unlinkSync(path);
  });
}

// ── 24. Per-account autotrade filters (horizons + alignment) ────────────────
console.log('\n[24] Autotrade signal filters');
{
  const mkAT = (opts = {}) => new AutoTrader({
    mode: 'off',
    store: { stats: () => ({ closed: 0, open: 0, winRate: 0, totalPnlUsd: 0 }) },
    riskEngine: { status: () => ({ riskPct: 2, maxPositionUsd: 50 }), maxPositionUsd: 50 },
    ...opts
  });

  test('allowedHorizons normalises to uppercase and surfaces in status()', () => {
    const at = mkAT({ allowedHorizons: ['day', 'swing'] });
    eq(at.allowedHorizons.join(','), 'DAY,SWING');
    eq(at.status().allowedHorizons.join(','), 'DAY,SWING');
  });
  test('no allowedHorizons → null (legacy skipScalp path)', () => {
    const at = mkAT();
    eq(at.allowedHorizons, null);
    eq(at.status().allowedHorizons, null);
  });
  test('setAllowedHorizons + setMinAlignment update + clamp', () => {
    const at = mkAT();
    eq(at.setAllowedHorizons(['scalp', 'day']).allowedHorizons.join(','), 'SCALP,DAY');
    eq(at.setAllowedHorizons([]).allowedHorizons, null);     // empty clears the override
    eq(at.setMinAlignment(4).minAlignment, 4);
    eq(at.setMinAlignment(99).minAlignment, 6);              // clamped to 6
    eq(at.setMinAlignment(-3).minAlignment, 0);              // clamped to 0
  });
  test('constructor seeds minAlignment and filters into status()', () => {
    const at = mkAT({ allowedHorizons: ['DAY'], minAlignment: 3 });
    eq(at.status().allowedHorizons.join(','), 'DAY');
    eq(at.status().minAlignment, 3);
  });

  // ── per-trigger allowlist (#14) ──
  test('allowTriggers: constructor passes through to status()', () => {
    const at = mkAT({ allowTriggers: { surge: true, flow: false } });
    eq(at.status().allowTriggers.surge, true);
    eq(at.status().allowTriggers.flow, false);
  });
  test('allowTriggers: defaults to null when unset', () => {
    eq(mkAT().status().allowTriggers, null);
    eq(mkAT({ allowTriggers: 'nope' }).allowTriggers, null);   // non-object ignored
  });
  test('setTriggerAllowed sets explicit on/off and round-trips', () => {
    const at = mkAT();
    eq(at.setTriggerAllowed('surge', true).state, 'on');
    eq(at.allowTriggers.surge, true);
    eq(at.setTriggerAllowed('flow', false).state, 'off');
    eq(at.allowTriggers.flow, false);
  });
  test('setTriggerAllowed normalises trigger key to lowercase', () => {
    const at = mkAT();
    at.setTriggerAllowed('VolumeSpike', false);
    eq(at.allowTriggers.volumespike, false);
  });
  test('setTriggerAllowed(key, null) clears the override; empty map → null', () => {
    const at = mkAT({ allowTriggers: { surge: true } });
    eq(at.setTriggerAllowed('surge', null).state, 'default');
    eq(at.allowTriggers, null);                                 // last key removed → whole map nulled
  });
}

// ── 25. Momentum confluence gate (Rank 3 — fire flow/funding edge, mute noise) ──
console.log('\n[25] Momentum confluence gate');
{
  const surgeOnly = [{ kind: 'surge', points: 1 }, { kind: 'ta', points: 1.2 }, { kind: 'oi', points: 0.5 }];
  const surgePlusFlow = [{ kind: 'surge', points: 1 }, { kind: 'flow', points: 2 }];
  const surgePlusFunding = [{ kind: 'surge', points: 1 }, { kind: 'funding_trigger', points: 1.5 }];

  test('pure momentum (surge + TA/OI only) is gated', () => {
    eq(momentumLacksEdge('surge', surgeOnly), true);
    eq(momentumLacksEdge('movers', surgeOnly), true);
  });
  test('momentum WITH on-chain/funding edge fires', () => {
    eq(momentumLacksEdge('surge', surgePlusFlow), false);
    eq(momentumLacksEdge('movers', surgePlusFunding), false);
    eq(momentumLacksEdge('surge', [{ kind: 'distribution' }, { kind: 'surge' }]), false);
  });
  test('non-momentum triggers are never gated (flow/funding/liquidation/distribution)', () => {
    eq(momentumLacksEdge('flow', surgeOnly), false);
    eq(momentumLacksEdge('funding_extreme', surgeOnly), false);
    eq(momentumLacksEdge('liquidation', []), false);
    eq(momentumLacksEdge('distribution', surgeOnly), false);
  });
  test('kill switch (requireEdge=false) disables the gate entirely', () => {
    eq(momentumLacksEdge('surge', surgeOnly, false), false);
    eq(momentumLacksEdge('movers', surgeOnly, false), false);
  });
  test('the always-present / negative-lift kinds do NOT count as edge', () => {
    // funding/ta/smc/oi/fdv/liqGrab appear on ~every signal — they must not
    // satisfy the gate, or it would never gate anything.
    eq(momentumLacksEdge('surge', [{ kind: 'funding' }, { kind: 'ta' }, { kind: 'smc' }, { kind: 'fdv' }, { kind: 'oi' }, { kind: 'liqGrab' }]), true);
  });
}

// ── 26. CVD divergence veto (fakeout filter for momentum entries) ───────────
console.log('\n[26] CVD divergence veto');
{
  test('LONG into net SELLING (price up, CVD negative) is vetoed', () => {
    eq(cvdDecision({ priceChangePct: 1.2, cvdRatio: -0.12, side: 'LONG' }), true);
  });
  test('LONG confirmed by net BUYING (price up, CVD positive) is NOT vetoed', () => {
    eq(cvdDecision({ priceChangePct: 1.2, cvdRatio: 0.12, side: 'LONG' }), false);
  });
  test('SHORT into net BUYING (price down, CVD positive) is vetoed', () => {
    eq(cvdDecision({ priceChangePct: -1.0, cvdRatio: 0.10, side: 'SHORT' }), true);
  });
  test('SHORT confirmed by net SELLING is NOT vetoed', () => {
    eq(cvdDecision({ priceChangePct: -1.0, cvdRatio: -0.10, side: 'SHORT' }), false);
  });
  test('tiny price move (below minMove) never vetoes even with opposing CVD', () => {
    eq(cvdDecision({ priceChangePct: 0.1, cvdRatio: -0.5, side: 'LONG' }), false);
  });
  test('weak divergence (below opposeRatio) does not veto', () => {
    eq(cvdDecision({ priceChangePct: 1.0, cvdRatio: -0.03, side: 'LONG' }), false);
  });
  test('missing data fails open (no veto)', () => {
    eq(cvdDecision({ priceChangePct: null, cvdRatio: null, side: 'LONG' }), false);
  });
}

// ── 27. A+ conviction grading (selectivity = high win-rate subset) ──────────
console.log('\n[27] A+ conviction grading');
{
  const strongPlan = { weightedAlignment: 0.4, dailyAgainst: false, rr1: 1.6, rr2: 4, rr3: 6 };
  const aplus = (over = {}) => assessConviction({
    reasons: [{ kind: 'flow' }, { kind: 'confirmation' }, { kind: 'smc' }, { kind: 'liqCluster' }],
    tradePlan: strongPlan, triggerType: 'flow', side: 'SHORT', regime: 'BTC_DOWN', tier: 'HIGH', ...over,
  });

  test('a multi-edge flow setup with a strong tier grades A+', () => {
    const c = aplus();
    truthy(c.isHighConviction, 'should be A+');
    truthy(c.count >= 4, 'counts ≥4 independent edges');
    truthy(c.hasPrimary, 'has a proven-edge source');
  });
  test('no primary on-chain/funding/liq edge → NOT A+ (TA stack alone is not enough)', () => {
    const c = assessConviction({ reasons: [{ kind: 'confirmation' }, { kind: 'smc' }, { kind: 'supplyPct' }], tradePlan: strongPlan, triggerType: 'surge', side: 'LONG', tier: 'HIGH' });
    falsy(c.isHighConviction, 'pure-TA momentum is never A+');
  });
  test('weak base tier (MEDIUM) → NOT A+ even with edges', () => {
    falsy(aplus({ tier: 'MEDIUM' }).isHighConviction);
  });
  test('regime against the trade → NOT A+ (do not fight BTC on your best trade)', () => {
    // LONG into BTC_DOWN is regime-against.
    falsy(aplus({ side: 'LONG', regime: 'BTC_DOWN' }).isHighConviction);
  });
  test('exhaustion-reversal (high-risk fade) is excluded from A+', () => {
    falsy(aplus({ exhReversal: true }).isHighConviction);
  });
  test('too few edges → NOT A+', () => {
    const c = assessConviction({ reasons: [{ kind: 'flow' }], tradePlan: { rr1: 1.0 }, triggerType: 'flow', side: 'SHORT', tier: 'HIGH' });
    falsy(c.isHighConviction);
  });
}

// ── 28. Holder concentration (the "top 10 control 90%" manipulation tell) ────
console.log('\n[28] Holder concentration');
{
  const td = new TeamWalletDiscovery({ universe: {}, cexWallets: {} });
  test('getConcentration is null when no holder data', () => {
    eq(td.getConcentration('FOO'), null);
  });
  test('getConcentration returns stored top-10 % (case-insensitive)', () => {
    td.concentrationBySymbol.set('BEAT', { top10Pct: 91.4, holderCount: 12, ts: Date.now() });
    const c = td.getConcentration('beat');
    eq(c?.top10Pct, 91.4);
    eq(c?.holderCount, 12);
  });
  test('getConcentration ignores stale data (>30d)', () => {
    td.concentrationBySymbol.set('OLD', { top10Pct: 80, holderCount: 5, ts: Date.now() - 40 * 24 * 3600_000 });
    eq(td.getConcentration('OLD'), null);
  });
}

// ── 29. TP ladder ordering (the STG TP2<TP1 bug) ────────────────────────────
console.log('\n[29] TP ladder monotonicity');
{
  const ordered = (side, e, l) => side === 'LONG'
    ? (l.tp1 > e && l.tp2 > l.tp1 && l.tp3 > l.tp2)
    : (l.tp1 < e && l.tp2 < l.tp1 && l.tp3 < l.tp2);

  test('STG case: TP1 snapped above rawTP2 → reverts to a clean ordered ladder', () => {
    // entry 0.54669; raw 1.0/1.75/2.5R = 0.6123/0.6615/0.7107; TP1 snapped to 0.6716 (past rawTP2).
    const L = enforceTpLadder('LONG', 0.54669,
      { tp1: 0.6716, tp2: null, tp3: null },
      { tp1: 0.6123, tp2: 0.6615, tp3: 0.7107 });
    truthy(ordered('LONG', 0.54669, L), `TP1<TP2<TP3 (got ${L.tp1}/${L.tp2}/${L.tp3})`);
    falsy(L.tp2 < L.tp1, 'TP2 is NOT below TP1 (the reported bug)');
  });
  test('SHORT ladder stays strictly decreasing', () => {
    const L = enforceTpLadder('SHORT', 21.4,
      { tp1: 20.5, tp2: null, tp3: null },
      { tp1: 20.0, tp2: 18.0, tp3: 16.5 });
    truthy(ordered('SHORT', 21.4, L), `TP1>TP2>TP3 (got ${L.tp1}/${L.tp2}/${L.tp3})`);
  });
  test('already-ordered snaps are kept', () => {
    const L = enforceTpLadder('LONG', 1, { tp1: 1.1, tp2: 1.25, tp3: 1.4 }, { tp1: 1.08, tp2: 1.2, tp3: 1.35 });
    eq(L.tp1, 1.1); eq(L.tp2, 1.25); eq(L.tp3, 1.4);
    truthy(L.snapped.tp1 && L.snapped.tp2 && L.snapped.tp3, 'all kept as snapped');
  });
  test('degenerate raw (all equal) is forced into a strict ladder', () => {
    const L = enforceTpLadder('LONG', 1, { tp1: null, tp2: null, tp3: null }, { tp1: 1.1, tp2: 1.1, tp3: 1.1 });
    truthy(ordered('LONG', 1, L), 'still strictly increasing');
  });
}

// ── 29b. Structural-location guard (don't enter into the wall) ───────────────
console.log('\n[29b] Structural-location guard');
{
  // FHE: LONG at 0.02366 with a swing-high SHELF just above (0.02440 + 0.02478 =
  // double-top) → resistance ahead, clustered. Should report a shelf with ~3%
  // room (longing into the double-top — the screenshot case).
  test('FHE LONG into a double-top → shelf detected, little room', () => {
    const ta = { '4hour': { swingHighs: [0.02440, 0.02478, 0.02606, 0.02618], swingLows: [0.01576, 0.01962] } };
    const sr = structuralRoom('LONG', 0.02366, ta);
    truthy(sr, 'a level sits ahead');
    truthy(sr.shelf, 'double-top shelf detected');
    truthy(sr.roomPct > 2.5 && sr.roomPct < 4, `~3% to the wall (got ${sr.roomPct}%)`);
  });

  // TAG: SHORT at 0.001017 sitting on a multi-touch support (~0.001000) with the
  // deeper swing low at 0.0009417 → support underfoot, jammed.
  test('TAG SHORT onto support → near level underfoot', () => {
    const ta = { '1hour': { swingHighs: [0.001386], swingLows: [0.001000, 0.000999, 0.0009417] } };
    const sr = structuralRoom('SHORT', 0.001017, ta);
    truthy(sr, 'support sits below');
    truthy(sr.roomPct < 2.2, `<2.2% to support (got ${sr.roomPct}%)`);
  });

  // A genuine breakout — price already ABOVE all recent swing highs → nothing
  // ahead → no penalty (structuralRoom returns null, the breakout exemption).
  test('LONG breakout above all structure → null (no penalty)', () => {
    const ta = { '4hour': { swingHighs: [10, 11, 12], swingLows: [8, 9] } };
    falsy(structuralRoom('LONG', 13, ta), 'nothing overhead → null');
  });

  // Clear path: nearest resistance is far away → a single level, lots of room.
  test('LONG with distant resistance → not a shelf', () => {
    const ta = { '4hour': { swingHighs: [120], swingLows: [80, 90] } };
    const sr = structuralRoom('LONG', 100, ta);
    truthy(sr && !sr.shelf, 'single far level, no shelf');
    truthy(sr.roomPct > 15, `lots of room (got ${sr.roomPct}%)`);
  });

  // Dedup regression: the SINGLE swingHigh is also the last element of swingHighs,
  // so one distinct level appears twice — it must NOT count as a 2-member shelf.
  test('one level duplicated (swingHigh ∈ swingHighs) → NOT a false shelf', () => {
    const ta = { '4hour': { swingHighs: [103], swingHigh: 103, swingLows: [], swingLow: null } };
    const sr = structuralRoom('LONG', 100, ta);
    truthy(sr, 'level ahead');
    falsy(sr.shelf, 'a lone duplicated level is not a shelf');
  });
}

// ── 29c. RSI divergence (regular) — reversal confirmation ───────────────────
console.log('\n[29c] RSI divergence');
{
  const rsiAt = (i4, i11) => { const r = new Array(15).fill(50); r[4] = i4; r[11] = i11; return r; };
  // pivot highs at i=4 (100) and i=11 (106 = HIGHER high)
  const highs = [92, 94, 96, 98, 100, 98, 96, 90, 96, 98, 102, 106, 102, 98, 94];
  // pivot lows at i=4 (100) and i=11 (94 = LOWER low)
  const lows  = [108, 106, 104, 102, 100, 102, 104, 110, 104, 102, 98, 94, 98, 102, 106];

  test('bearish divergence: higher price high + LOWER RSI high → SHORT confirm', () => {
    const d = detectRsiDivergence(highs, rsiAt(72, 60), 'SHORT');
    truthy(d && d.kind === 'bear', `bearish divergence (got ${JSON.stringify(d)})`);
  });
  test('bullish divergence: lower price low + HIGHER RSI low → LONG confirm', () => {
    const d = detectRsiDivergence(lows, rsiAt(28, 40), 'LONG');
    truthy(d && d.kind === 'bull', `bullish divergence (got ${JSON.stringify(d)})`);
  });
  test('no divergence when RSI CONFIRMS the new price extreme → null', () => {
    falsy(detectRsiDivergence(highs, rsiAt(60, 72), 'SHORT'), 'HH + higher RSI high = no divergence');
  });
  test('too few bars / misaligned series → null (guarded)', () => {
    falsy(detectRsiDivergence([1, 2, 3], [50, 50, 50], 'SHORT'), 'short series guarded');
    falsy(detectRsiDivergence(highs, [50, 50], 'SHORT'), 'misaligned rsi length guarded');
  });
}

// ── 29d. Binance liquidation WS parsing ─────────────────────────────────────
console.log('\n[29d] Binance liquidation parse');
{
  const map = new Map([['BTCUSDT', 'BTC'], ['PEPEUSDT', 'PEPE']]);
  test('SELL forceOrder = LONG liquidation, USD = price×qty', () => {
    const r = parseForceOrder({ s: 'BTCUSDT', S: 'SELL', q: '2', ap: '65000' }, map);
    truthy(r && r.token === 'BTC' && r.side === 'long' && r.usd === 130000, JSON.stringify(r));
  });
  test('BUY forceOrder = SHORT liquidation; prefers avgPrice', () => {
    const r = parseForceOrder({ s: 'BTCUSDT', S: 'BUY', q: '1', ap: '65000', p: '64000' }, map);
    eq(r.side, 'short'); eq(r.usd, 65000);
  });
  test('1000-prefixed meme maps to the base token', () => {
    const r = parseForceOrder({ s: '1000PEPEUSDT', S: 'SELL', q: '1000000', ap: '0.01' }, map);
    truthy(r && r.token === 'PEPE', JSON.stringify(r));
  });
  test('untracked symbol or zero qty → null', () => {
    falsy(parseForceOrder({ s: 'FOOUSDT', S: 'SELL', q: '1', ap: '1' }, map));
    falsy(parseForceOrder({ s: 'BTCUSDT', S: 'SELL', q: '0', ap: '1' }, map));
  });
}

// ── 29d2. OI-normalized liquidation significance (% of OI, not flat $) ───────
console.log('\n[29d2] Liquidation significance — % of open interest');
{
  const opts = { minFloorUsd: 25_000, oiPct: 0.0001, absUsd: 2_000_000 };  // accurate-Binance config
  test('dust below floor never fires (even at high OI%)', () => {
    falsy(liquidationSignificance({ totalUsd: 10_000, oiUsd: 1_000_000, ...opts }).fire);
  });
  test('$50K on ETH (huge OI) is NOT significant — the "won\'t move a cent" case', () => {
    const r = liquidationSignificance({ totalUsd: 50_000, oiUsd: 10e9, ...opts });
    falsy(r.fire);                                  // 0.0000005% of OI, below 0.01% and below $2M abs
  });
  test('$200K on a $20M-OI micro-cap IS significant (1% of OI)', () => {
    const r = liquidationSignificance({ totalUsd: 200_000, oiUsd: 20e6, ...opts });
    truthy(r.fire); eq(r.basis, 'oi%');
  });
  test('$1M on ETH fires via OI% (0.01% of $10B)', () => {
    truthy(liquidationSignificance({ totalUsd: 1_000_000, oiUsd: 10e9, ...opts }).fire);
  });
  test('absolutely huge fires even below OI% (abs path)', () => {
    const r = liquidationSignificance({ totalUsd: 3_000_000, oiUsd: 1e12, ...opts });
    truthy(r.fire); eq(r.basis, 'abs');
  });
  test('OI unknown → falls back to absolute threshold', () => {
    falsy(liquidationSignificance({ totalUsd: 100_000, oiUsd: 0, ...opts }).fire);   // < $2M abs, no OI
    truthy(liquidationSignificance({ totalUsd: 2_500_000, oiUsd: 0, ...opts }).fire);
  });
  test('Coinalyze config ($50K abs) still fires on the calibrated majors', () => {
    const cfg = { minFloorUsd: 25_000, oiPct: 0.0001, absUsd: 50_000 };
    truthy(liquidationSignificance({ totalUsd: 222_589, oiUsd: 0, ...cfg }).fire);   // WLD, abs fallback
  });
}

// ── 29d2b. Liquidation OI-size score bonus ──────────────────────────────────
console.log('\n[29d2b] Liquidation OI-size score bonus');
{
  test('no bonus for tiny/zero/unknown OI fraction', () => {
    eq(liquidationOiBonus(0), 0);
    eq(liquidationOiBonus(null), 0);
    eq(liquidationOiBonus(NaN), 0);
    close(liquidationOiBonus(0.0001), 0.01, 1e-9);   // 0.01% of OI → +0.01
  });
  test('scales linearly and caps at +1.0 (≥1% of OI)', () => {
    close(liquidationOiBonus(0.005), 0.5, 1e-9);     // 0.5% of OI → +0.5
    close(liquidationOiBonus(0.01), 1.0, 1e-9);      // 1% of OI → +1.0
    eq(liquidationOiBonus(0.05), 1.0);               // 5% of OI → still capped +1.0
  });
}

// ── 29d4. Billing — HD derivation (known vectors) + credit math ─────────────
console.log('\n[29d4] Billing: HD wallet + subscription math');
{
  // The canonical Hardhat/Anvil test mnemonic — fixed BIP-44 vectors prove our
  // derivation path (m/44'/60'/0'/0/i) matches every standard EVM wallet/tool.
  const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
  test('HD wallet derives standard BIP-44 EVM addresses (gas idx 0, users idx 1+)', () => {
    const hd = new HdWallet(TEST_MNEMONIC);
    eq(hd.addressForIndex(0), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');   // gas wallet
    eq(hd.addressForIndex(1), '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');   // first user
    eq(hd.addressForIndex(2), '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');   // second user
    eq(hd.gasAddress(), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });
  test('HD wallet rejects an invalid/missing seed (fail-loud, no garbage addresses)', () => {
    let threw = false; try { new HdWallet('not a valid mnemonic at all'); } catch { threw = true; }
    truthy(threw);
    let threw2 = false; try { new HdWallet(undefined); } catch { threw2 = true; }
    truthy(threw2);
  });
  test('creditMonths floors amount/price (with fp epsilon)', () => {
    eq(creditMonths(30, 30), 1);
    eq(creditMonths(90, 30), 3);
    eq(creditMonths(29.99, 30), 0);            // under-payment → 0 months
    eq(creditMonths(30.0000001, 30), 1);       // fp dust still counts as a full month
    eq(creditMonths(0, 30), 0);
  });
  test('extendedPaidUntil stacks onto unused time, resets from now if expired', () => {
    const DAY = 86_400_000, MONTH = 30 * DAY, now = 1_700_000_000_000;
    eq(extendedPaidUntil(0, 1, now, MONTH), now + MONTH);                       // fresh
    eq(extendedPaidUntil(now + 10 * DAY, 1, now, MONTH), now + 10 * DAY + MONTH); // stacks
    eq(extendedPaidUntil(now - 5 * DAY, 1, now, MONTH), now + MONTH);           // expired → from now
    eq(extendedPaidUntil(now, 0, now, MONTH), now);                            // 0 months → unchanged
  });
  test('statusOf: none / trial / active / expired', () => {
    const trialMs = 7 * 86_400_000, now = 2_000_000_000_000, DAY = 86_400_000;
    eq(statusOf(null, now, trialMs), 'none');
    eq(statusOf({ trialStartedAt: now - DAY, paidUntil: 0 }, now, trialMs), 'trial');
    eq(statusOf({ trialStartedAt: now - 8 * DAY, paidUntil: 0 }, now, trialMs), 'expired');
    eq(statusOf({ trialStartedAt: now - 8 * DAY, paidUntil: now + DAY }, now, trialMs), 'active');
    eq(accessUntil({ trialStartedAt: now - DAY, paidUntil: 0 }, trialMs), now - DAY + trialMs);
  });
}

// ── 29d3. Bybit perp symbol → bot token mapping ─────────────────────────────
console.log('\n[29d3] Bybit symbol → token mapping');
{
  const known = new Set(['BTC', 'ETH', 'PEPE', 'SOL', 'HYPE']);
  test('plain USDT perp maps to its token', () => {
    eq(bybitSymbolToToken('BTCUSDT', known), 'BTC');
    eq(bybitSymbolToToken('hypeusdt', known), 'HYPE');   // case-insensitive
  });
  test('1000× meme prefix is stripped to the base token', () => {
    eq(bybitSymbolToToken('1000PEPEUSDT', known), 'PEPE');
  });
  test('unknown token or non-USDT pair → null', () => {
    eq(bybitSymbolToToken('FOOUSDT', known), null);
    eq(bybitSymbolToToken('BTCUSDC', known), null);
    eq(bybitSymbolToToken('', known), null);
  });
  test('rollupLiquidationWindow: sums within window, drops stale, accumulates a cascade', () => {
    const now = 1_000_000;
    const win = 180_000;   // 3 min
    // A cascade bleeding $40k/min for 4 min: the oldest ($40k @ -4min) is OUTSIDE the
    // 3-min window and dropped; the last 3 sum to $120k (the per-minute reset would
    // have seen only $40k in each bucket and never crossed a $75k floor).
    const entries = [
      { ts: now - 240_000, usd: 40_000, side: 'long' },   // stale → dropped
      { ts: now - 120_000, usd: 40_000, side: 'long' },
      { ts: now - 60_000,  usd: 40_000, side: 'long' },
      { ts: now - 5_000,   usd: 40_000, side: 'long' },
    ];
    const r = rollupLiquidationWindow(entries, now, win);
    eq(r.kept.length, 3, 'the stale entry is pruned');
    eq(r.total, 120_000, 'the 3 in-window entries accumulate ($120k cascade)');
    eq(r.long, 120_000); eq(r.short, 0);
  });
  test('rollupLiquidationWindow: splits long/short and handles empty', () => {
    const now = 500_000;
    const r = rollupLiquidationWindow([
      { ts: now - 1000, usd: 10_000, side: 'long' },
      { ts: now - 2000, usd: 25_000, side: 'short' },
    ], now, 60_000);
    eq(r.long, 10_000); eq(r.short, 25_000); eq(r.total, 35_000);
    const e = rollupLiquidationWindow([], now, 60_000);
    eq(e.total, 0); eq(e.kept.length, 0);
  });
}

// ── 29e. Manipulation-risk score (NOX low-cap filters) ──────────────────────
console.log('\n[29e] Manipulation-risk score');
{
  test('clean liquid major → ~0 risk, no flags', () => {
    const m = assessManipulation({ futuresVol: 1e9, spotVol: 2e9, volume: 5e8, marketCap: 5e10, floatPct: 0.9, concentrationPct: 15 });
    eq(m.score, 0); eq(m.flags.length, 0);
  });
  test('manipulated low-cap (futures>>spot, vol≥MC, low float, concentrated) → max risk, all flags', () => {
    const m = assessManipulation({ futuresVol: 3e6, spotVol: 1e6, volume: 2e7, marketCap: 1e7, floatPct: 0.10, concentrationPct: 80 });
    truthy(m.score >= 0.9, `near-max risk (got ${m.score})`);
    eq(m.flags.length, 4);
  });
  test('partial flags accumulate (vol≥MC + low float only)', () => {
    const m = assessManipulation({ volume: 1.2e7, marketCap: 1e7, floatPct: 0.2 });
    close(m.score, 0.55, 1e-9, `0.30 (vol/MC) + 0.25 (float) (got ${m.score})`);
  });
  test('missing inputs contribute nothing (graceful)', () => {
    eq(assessManipulation({}).score, 0);
    eq(assessManipulation({ marketCap: 1e7 }).score, 0);   // no volume → no vol/MC flag
  });
}

// ── 30. BOS proximity gate (no stale far-away breaks — the STG case) ─────────
console.log('\n[30] BOS proximity gate');
{
  // Ascending zig-zag with clear 5-bar fractal swings (HH + HL = uptrend):
  // swing highs 56→60, swing lows 47→51; final bar closes a controllable
  // distance above the broken swing high (prevHigh = 56).
  const B = (h, l) => ({ t: 0, o: (h + l) / 2, h, l, c: (h + l) / 2 });
  const uptrend = (lastClose) => ([
    B(50, 48), B(52, 49), B(56, 52), B(53, 50), B(51, 47), B(54, 50),
    B(60, 55), B(57, 53), B(55, 51), B(58, 54), B(59, 55),
    { t: 0, o: lastClose, h: lastClose, l: lastClose * 0.99, c: lastClose },
  ]);
  test('fresh BOS (price near the broken swing high) IS reported', () => {
    const r = analyzeSmc(uptrend(58), { tfLabel: 'daily' });   // +3.6% past prevHigh 56
    truthy(r.findings.some(f => f.smc?.type === 'bos' && f.smc?.side === 'LONG'), 'fresh BOS present');
  });
  test('stale BOS (price ran far past the swing) is DROPPED', () => {
    const r = analyzeSmc(uptrend(100), { tfLabel: 'daily' });   // +78% past prevHigh — the STG-style stale break
    falsy(r.findings.some(f => f.smc?.type === 'bos'), 'ancient far-away BOS not reported');
  });
}

// ── 18. Macro monitor (FOMC/CPI calendar lead-window logic) ──────────────────
console.log('\n[18] Macro monitor: lead-window fire logic');
{
  const HOUR = 3600_000, DAY = 24 * HOUR;
  const leads = [{ label: '1d', ms: DAY }, { label: '1h', ms: HOUR }, { label: 'now', ms: 0 }];
  const events = [{ type: 'FOMC', title: 'FOMC rate decision', time: '2026-07-29T18:00:00Z' }];
  const T = Date.parse('2026-07-29T18:00:00Z');

  test('macroEventId is a stable type:time key', () =>
    eq(macroEventId(events[0]), 'FOMC:2026-07-29T18:00:00Z'));
  test('no fire well outside any lead window', () =>
    eq(dueMacroFires(events, T - 3 * DAY, leads, new Set()).length, 0));
  test('1d window fires once when crossed (1h/now not yet)', () => {
    const f = dueMacroFires(events, T - 12 * HOUR, leads, new Set());
    eq(f.length, 1); eq(f[0].lead.label, '1d');
  });
  test('inside the final hour, both 1d and 1h are due (if unfired)', () =>
    eq(dueMacroFires(events, T - 30 * 60_000, leads, new Set()).map(x => x.lead.label).sort(), ['1d', '1h']));
  test('already-fired keys are skipped', () =>
    eq(dueMacroFires(events, T - 30 * 60_000, leads, new Set(['FOMC:2026-07-29T18:00:00Z:1d'])).map(x => x.lead.label), ['1h']));
  test('"now" fires only within [event, event + 30m grace)', () => {
    truthy(dueMacroFires(events, T + 5 * 60_000, leads, new Set()).some(x => x.lead.label === 'now'));
    falsy(dueMacroFires(events, T + 90 * 60_000, leads, new Set()).some(x => x.lead.label === 'now'));
  });
  test('pre-event leads do NOT fire after the event has passed (only "now")', () =>
    eq(dueMacroFires(events, T + 5 * 60_000, leads, new Set()).map(x => x.lead.label), ['now']));
  test('leadPhrase reads naturally', () => {
    eq(leadPhrase({ label: '1d', ms: DAY }), 'in ~1 day');
    eq(leadPhrase({ label: '1h', ms: HOUR }), 'in ~1 hour');
    eq(leadPhrase({ label: 'now', ms: 0 }), 'now');
  });
  test('shipped macro-calendar.json is well-formed (FOMC + CPI, all times parse)', () => {
    const cal = JSON.parse(readFileSync(new URL('../config/macro-calendar.json', import.meta.url)));
    truthy(Array.isArray(cal.events) && cal.events.length >= 16, 'has ≥16 events');
    truthy(cal.events.every(e => e.type && Number.isFinite(Date.parse(e.time))), 'all times parse');
    truthy(cal.events.some(e => e.type === 'FOMC') && cal.events.some(e => e.type === 'CPI'), 'both FOMC + CPI present');
  });
}

// ── 19. Unlock monitor (DeFiLlama cliff parsing + major-bar + lead logic) ────
console.log('\n[19] Unlock monitor: schedule parse + significance');
{
  const DAY = 86400_000;
  const nowMs = Date.parse('2026-06-17T00:00:00Z');
  const tsFuture = Math.floor((nowMs + 5 * DAY) / 1000);   // emission timestamps are in SECONDS
  const tsPast = Math.floor((nowMs - 5 * DAY) / 1000);
  const doc = {
    gecko_id: 'demo', name: 'Demo', token: 'DEMO',
    supplyMetrics: { maxSupply: 1000 },
    metadata: {
      token: 'DEMO',
      unlockEvents: [
        { timestamp: tsPast, cliffAllocations: [{ recipient: 'Team', category: 'insiders', amount: 50 }], summary: { totalTokensCliff: 50 } },
        { timestamp: tsFuture, cliffAllocations: [{ recipient: 'Investors', category: 'investors', amount: 80 }, { recipient: 'Team', category: 'insiders', amount: 20 }], summary: { totalTokensCliff: 100 } },
        { timestamp: tsFuture + 1000, cliffAllocations: [], linearAllocations: [{ recipient: 'x' }], summary: {} },   // linear-only → ignored
      ],
    },
    documentedData: { data: [
      { label: 'Investors', data: [{ timestamp: tsPast - 86400, unlocked: 200 }, { timestamp: tsFuture - 1, unlocked: 300 }] },
      { label: 'Team', data: [{ timestamp: tsPast - 86400, unlocked: 100 }, { timestamp: tsFuture - 1, unlocked: 100 }] },
    ] },
  };

  test('circulatingAt sums latest cumulative unlocked ≤ ts (300+100=400)', () =>
    eq(circulatingAt(doc.documentedData, tsFuture), 400));

  const parsed = parseUnlockSchedule(doc, { nowMs, horizonMs: 14 * DAY });
  test('parseUnlockSchedule keeps only FUTURE cliff events in horizon', () => {
    eq(parsed.events.length, 1);          // past event + linear-only event both excluded
    eq(parsed.events[0].tokens, 100);
    eq(parsed.symbol, 'DEMO');
  });
  test('parse computes % of circulating (100 / 400 = 25%)', () =>
    close(parsed.events[0].pctOfCirc, 0.25, 1e-9));
  test('recipients sorted by amount, biggest first', () =>
    eq(parsed.events[0].recipients[0].recipient, 'Investors'));   // 80 > 20

  test('isMajorUnlock: ≥5% of circ qualifies even with no price', () => {
    const r = isMajorUnlock(parsed.events[0], null, { minPct: 0.05, minUsd: 25e6 });
    truthy(r.major); eq(r.usd, null); close(r.pct, 0.25, 1e-9);
  });
  test('isMajorUnlock: small % but big $ qualifies on USD', () => {
    const r = isMajorUnlock({ tokens: 1_000_000, pctOfCirc: 0.001, pctOfMax: 0.001 }, 50, { minPct: 0.05, minUsd: 25e6 });
    truthy(r.major); eq(r.usd, 50_000_000);
  });
  test('isMajorUnlock: small % and unknown price → NOT major', () =>
    falsy(isMajorUnlock({ tokens: 100, pctOfCirc: 0.001, pctOfMax: 0.001 }, null, { minPct: 0.05, minUsd: 25e6 }).major));

  test('assessPumpRegime: stacks manipulation legs into one regime read', () => {
    // 2 manip flags alone → below the 3-leg bar
    eq(assessPumpRegime({ manipFlags: ['low float', 'futures 3x spot'] }, 3).isRegime, false);
    // + a supply shock → 3 legs → regime
    const r = assessPumpRegime({ manipFlags: ['low float', 'futures 3x spot'], supplyShock: true }, 3);
    truthy(r.isRegime); eq(r.count, 3);
    truthy(r.legs.includes('supply → CEX'));
    // float + futures + supply shock + squeeze → 4 legs
    const r2 = assessPumpRegime({ manipFlags: ['low float', 'futures 3x spot'], supplyShock: true, squeeze: true }, 3);
    eq(r2.count, 4); truthy(r2.legs.includes('liquidation squeeze'));
    // custom threshold
    eq(assessPumpRegime({ manipFlags: ['low float'], squeeze: true }, 3).isRegime, false);   // 2 legs < 3
  });

  test('assessPrePumpSetup: counts early-accumulation legs (LONG-only, min 2)', () => {
    eq(assessPrePumpSetup({ supplyOffCex: true }, 2).isSetup, false);                          // 1 leg < 2
    const r = assessPrePumpSetup({ supplyOffCex: true, shortsCrowded: true }, 2);
    truthy(r.isSetup); eq(r.count, 2);
    truthy(r.legs.includes('supply off CEX') && r.legs.includes('shorts crowded'));
    const r2 = assessPrePumpSetup({ supplyOffCex: true, thinFloat: true, oiRising: true, volumeSpiking: true, shortsCrowded: true }, 2);
    eq(r2.count, 5);
    eq(assessPrePumpSetup({}, 2).isSetup, false);                                              // no legs
  });

  test('pumpRegimeBias: ride the squeeze-up, fade the blow-off (phase-aware)', () => {
    // squeeze-up: shorts crowded (negative funding) + fuel above, no distribution → ride LONG
    eq(pumpRegimeBias({ fundingAvg: -0.05, squeezeFuelAbove: true }), 'LONG');
    // distribution present → fade SHORT regardless of funding/fuel
    eq(pumpRegimeBias({ fundingAvg: -0.05, squeezeFuelAbove: true, distributing: true }), 'SHORT');
    // longs crowded (positive funding) → fade SHORT
    eq(pumpRegimeBias({ fundingAvg: 0.04, squeezeFuelAbove: true }), 'SHORT');
    // negative funding but NO fuel above → no target to squeeze into → fade SHORT
    eq(pumpRegimeBias({ fundingAvg: -0.05, squeezeFuelAbove: false }), 'SHORT');
    // unknown funding → conservative fade
    eq(pumpRegimeBias({ fundingAvg: null, squeezeFuelAbove: true }), 'SHORT');
  });

  test('liquidationCascadeBase: cumulative cascade scales 0 → +2.0, catches majors', () => {
    eq(liquidationCascadeBase(0), 0);
    eq(liquidationCascadeBase(2_000_000, 2_000_000), 2.0);     // full at the cap
    eq(liquidationCascadeBase(5_000_000, 2_000_000), 2.0);     // capped
    close(liquidationCascadeBase(309_000, 2_000_000), 0.309, 1e-3);   // a lone $309k blip stays small
    close(liquidationCascadeBase(3_300_000, 2_000_000), 2.0, 1e-9);   // $400k+$729k+$2.17M BTC cascade → full
  });

  test('liquidationSignalBase: a major-coin liq reaches signal grade, a small-cap is damped', () => {
    // A $718k BTC squeeze: tiny % of OI (0.007%), but on a LIQUID market → base hits the
    // 2.0 floor and can reach the 3.0 signal bar with confluence (the bug fix). The OLD
    // %-of-OI base scored this ~0.7 and it could NEVER fire.
    const major = liquidationSignalBase({ liquidMarket: true, cascadeUsd: 718_000, oiFrac: 0.00007 });
    truthy(major >= 2.0, `liquid-major liq base ${major.toFixed(2)} should be >= the 2.0 floor`);
    // Same $718k on an ILLIQUID small-cap (3% of a tiny OI): the %-of-OI base would be a
    // full 2.0, but the gate DAMPS it to <=0.4 so it can't carry a signal alone (rekt guard).
    const small = liquidationSignalBase({ liquidMarket: false, cascadeUsd: 718_000, oiFrac: 0.03 });
    truthy(small <= 0.4, `illiquid liq base ${small.toFixed(2)} should be capped (heads-up only)`);
    // A stacking cascade on a liquid major scales above the floor toward the OI bonus.
    const cascade = liquidationSignalBase({ liquidMarket: true, cascadeUsd: 2_000_000, oiFrac: 0.012 });
    truthy(cascade > 2.0, 'a violent liquid cascade exceeds the bare floor via the OI bonus');
  });

  test('dueUnlockFires fires 7d then 1d windows + dedupes', () => {
    const leads = [{ label: '7d', ms: 7 * DAY }, { label: '1d', ms: DAY }];
    const items = [{ id: 'demo:' + (nowMs + 5 * DAY), tsMs: nowMs + 5 * DAY }];
    eq(dueUnlockFires(items, nowMs, leads, new Set()).map(x => x.lead.label), ['7d']);            // 5d out → inside 7d only
    eq(dueUnlockFires(items, nowMs + 4.5 * DAY, leads, new Set()).map(x => x.lead.label).sort(), ['1d', '7d']);  // 12h out → both
    eq(dueUnlockFires(items, nowMs + 4.5 * DAY, leads, new Set(['demo:' + (nowMs + 5 * DAY) + ':7d'])).map(x => x.lead.label), ['1d']);
  });
}

// ── 20. Command accessors (/unlock, /macro, /holders) ───────────────────────
console.log('\n[20] Command accessors for /unlock, /macro, /holders');
{
  test('MacroMonitor.upcoming: future only, soonest first', () => {
    const mm = new MacroMonitor({});
    mm.events = [
      { type: 'FOMC', title: 'far', time: '2099-01-01T00:00:00Z' },
      { type: 'CPI', title: 'past', time: '2000-01-01T00:00:00Z' },
      { type: 'FOMC', title: 'near', time: '2098-01-01T00:00:00Z' },
    ];
    eq(mm.upcoming(5).map(e => e.title), ['near', 'far']);   // past dropped, sorted
  });

  test('UnlockMonitor.nextUnlocks: flatten + sort by date + annotate major/ticker', () => {
    const um = new UnlockMonitor({
      universe: { lookupByCgId: id => id === 'arbitrum' ? { symbol: 'ARB' } : null },
      prices: { getPrice: () => 2 },
    });
    um.schedules = [
      { slug: 'arbitrum', geckoId: 'arbitrum', symbol: null, name: 'Arbitrum', events: [
        { tsMs: 1000, tokens: 100, pctOfCirc: 0.10, pctOfMax: 0.05, recipients: [] },   // 10% → major
        { tsMs: 3000, tokens: 1, pctOfCirc: 0.001, pctOfMax: 0.001, recipients: [] },    // tiny → not major
      ] },
      { slug: 'foo', geckoId: 'foo', symbol: 'FOO', name: 'Foo', events: [
        { tsMs: 2000, tokens: 50, pctOfCirc: 0.02, pctOfMax: 0.02, recipients: [] },
      ] },
    ];
    const rows = um.nextUnlocks(10);
    // De-duped to ONE row per token (soonest): ARB's 1000+3000 collapse to 1000.
    eq(rows.map(r => r.tsMs), [1000, 2000]);          // soonest-per-token, chronological
    eq(rows[0].display, 'ARB');                       // gecko_id → universe ticker
    eq(rows[0].major, true);                          // 10% ≥ 5% bar
    eq(rows[1].display, 'FOO');                        // bare-ticker fallback
    eq(rows.length, 2);                                // no duplicate ARB row (the TIA-spam fix)
  });

  test('TeamWalletDiscovery.holdersForSymbol: cache read, sorted, null for unknown', () => {
    const tw = new TeamWalletDiscovery({ cachePath: null });
    tw.byToken.set('0xabc', { chain: 'eth', tokenSymbol: 'DEMO', tokenAddress: '0xabc', ts: Date.now(),
      addresses: [{ rank: 1, address: '0xaa', percent: 1 }, { rank: 2, address: '0xbb', percent: 5 }] });
    tw.concentrationBySymbol.set('DEMO', { top10Pct: 30, holderCount: 5, ts: Date.now() });
    const h = tw.holdersForSymbol('demo');             // case-insensitive
    truthy(h && h.symbol === 'DEMO');
    eq(h.tokens[0].holders.map(x => x.percent), [5, 1]);   // sorted desc by %
    eq(h.concentration.top10Pct, 30);
    eq(tw.holdersForSymbol('NOPE'), null);
  });
}

// ── 21. Relative-significance scoring (the 2026-06-18 selection fixes) ───────
console.log('\n[21] Relative-significance scoring + smart entry');
{
  // Liquidation base scales by %-of-OI (kills the $309k-BTC-noise that fired +2.0)
  test('liquidationBaseScore: full +2.0 at/above the OI threshold', () => {
    close(liquidationBaseScore(0.003, { fullOi: 0.003 }), 2.0, 1e-9);
    close(liquidationBaseScore(0.05,  { fullOi: 0.003 }), 2.0, 1e-9);   // capped
  });
  test('liquidationBaseScore: tapers toward 0.5 for a trivial %-of-OI (BTC $309k)', () => {
    // $309k on ~$5B OI = 0.00006 → far below 0.3% → near the 0.5 floor
    const base = liquidationBaseScore(0.00006, { fullOi: 0.003 });
    truthy(base < 0.6, `expected ~0.5, got ${base}`);
  });
  test('liquidationBaseScore: unknown OI keeps full base (no missing-data penalty)', () =>
    close(liquidationBaseScore(NaN), 2.0, 1e-9));
  test('liquidationBaseScore: zero/negative OI → floor', () =>
    close(liquidationBaseScore(0), 0.5, 1e-9));

  // Insider-sell materiality floor scales with market cap (kills the ENA $75k)
  test('teamSellMaterialFloorUsd: $1.2B ENA → ~$360k floor (so $75k is demoted)', () => {
    const floor = teamSellMaterialFloorUsd(1_200_000_000, { minMcapPct: 0.0003 });
    close(floor, 360_000, 1);
    truthy(75_536 < floor, 'the ENA $75k sell is below the material floor');
  });
  test('teamSellMaterialFloorUsd: $20M micro-cap → $50k abs floor (so $75k counts)', () => {
    const floor = teamSellMaterialFloorUsd(20_000_000, { minMcapPct: 0.0003, absFloor: 50_000 });
    eq(floor, 50_000);            // 0.03% × 20M = $6k < $50k abs floor
    truthy(75_536 > floor, 'the same $75k on a micro-cap is material');
  });
  test('teamSellMaterialFloorUsd: unknown mcap → abs floor', () =>
    eq(teamSellMaterialFloorUsd(null, { absFloor: 50_000 }), 50_000));

  // Counter-trend stays a LIMIT when coiled, switches to CMP when momentum is live
  test('isMomentumLive: liquidation cascade → true (enter CMP)', () =>
    truthy(isMomentumLive({ type: 'liquidation', value: {} }, 'SHORT')));
  test('isMomentumLive: surge in the trade direction → true', () => {
    truthy(isMomentumLive({ type: 'surge', value: { direction: 'down' } }, 'SHORT'));
    truthy(isMomentumLive({ type: 'surge', value: { direction: 'up' } }, 'LONG'));
  });
  test('isMomentumLive: surge AGAINST the trade (fade) → false (keep swing-limit)', () => {
    falsy(isMomentumLive({ type: 'surge', value: { direction: 'up' } }, 'SHORT'));    // fading a pump
    falsy(isMomentumLive({ type: 'flow', value: {} }, 'SHORT'));                       // coiled flow setup
  });

  // Prior-flows corroboration counts INDEPENDENT senders (one insider chunking ≠ confluence)
  test('independentFlowCount: one insider chunking → 0 (the ENA case)', () => {
    const trigger = { fromName: 'Insider #21' };
    const others = [
      { usd: 25_084, flow: { fromName: 'Insider #21' } },
      { usd: 26_481, flow: { fromName: 'Insider #21' } },
      { usd: 4_576,  flow: { fromName: 'external' } },   // dust → ignored
    ];
    eq(independentFlowCount(others, trigger), 0);
  });
  test('independentFlowCount: two distinct whales → 2 (real corroboration)', () => {
    const others = [
      { usd: 100_000, flow: { fromAddress: '0xaaa' } },
      { usd: 200_000, flow: { fromAddress: '0xbbb' } },
      { usd: 150_000, flow: { fromAddress: '0xaaa' } },   // same as #1 → not double-counted
    ];
    eq(independentFlowCount(others, null), 2);
  });
  test('independentFlowCount: dust-only legs → 0', () =>
    eq(independentFlowCount([{ usd: 5_000, flow: { fromAddress: '0xaaa' } }], null), 0));
}

// ── News monitor — impact classification + normalisation (#9) ───────────────
console.log('\n[news] News-monitor helpers');
{
  test('classifyNewsImpact: flags hacks / regulation / ETF / listings as high-impact', () => {
    truthy(classifyNewsImpact({ title: 'Major DeFi protocol exploited for $50M' }).tags.includes('hack'));
    truthy(classifyNewsImpact({ title: 'SEC charges exchange with fraud' }).tags.includes('regulation'));
    truthy(classifyNewsImpact({ title: 'Spot ETF approved by regulator' }).tags.includes('etf'));
    truthy(classifyNewsImpact({ title: 'Binance will list NEWTOKEN' }).tags.includes('listing'));
    truthy(classifyNewsImpact({ title: 'FOMC holds rates steady', categories: 'Regulation' }).tags.includes('macro'));
  });
  test('classifyNewsImpact: a bland price-recap is NOT high-impact', () => {
    const r = classifyNewsImpact({ title: 'Bitcoin trades sideways as volume cools', categories: 'BTC|Market' });
    eq(r.high, false);
    eq(r.tags.length, 0);
  });
  test('classifyNewsImpact: matches keywords in the categories field too', () => {
    truthy(classifyNewsImpact({ title: 'Daily roundup', categories: 'Regulation|BTC' }).high);
  });
  test('parseRssItems: parses a real-shaped RSS item (CDATA title, plain link, pubDate, category)', () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[SEC charges exchange with fraud]]></title>
        <link>https://coindesk.com/a/1</link>
        <guid isPermaLink="false">abc-123</guid>
        <pubDate>Tue, 30 Jun 2026 13:25:52 +0000</pubDate>
        <category><![CDATA[Regulation]]></category>
        <category>Policy</category>
      </item>
      <item>
        <title>Bitcoin ETF sees record inflows</title>
        <link><![CDATA[https://cointelegraph.com/b/2?utm_source=rss]]></link>
        <guid isPermaLink="true">https://cointelegraph.com/b/2</guid>
        <pubDate>Tue, 30 Jun 2026 12:00:00 +0000</pubDate>
        <category>Markets</category>
      </item>
    </channel></rss>`;
    const items = parseRssItems(xml, 'CoinDesk');
    eq(items.length, 2);
    eq(items[0].title, 'SEC charges exchange with fraud');
    eq(items[0].id, 'abc-123');                 // guid wins
    eq(items[0].source, 'CoinDesk');
    eq(items[0].categories, 'Regulation|Policy');
    truthy(items[0].publishedMs > 0);
    eq(items[1].url, 'https://cointelegraph.com/b/2?utm_source=rss');   // CDATA link unwrapped
  });
  test('parseRssItems: decodes entities + skips items with no title/link; [] on junk', () => {
    const xml = `<item><title>Foo &amp; Bar &#039;quote&#039;</title><link>https://x/y</link></item>
                 <item><title>No link here</title></item>`;
    const items = parseRssItems(xml, 'X');
    eq(items.length, 1);
    eq(items[0].title, "Foo & Bar 'quote'");
    eq(parseRssItems('not xml', 'X').length, 0);
    eq(parseRssItems(null, 'X').length, 0);
  });
  test('classifyNewsImpact reads parsed RSS categories', () => {
    const [it] = parseRssItems('<item><title>Daily market wrap</title><link>https://x/z</link><category>Regulation</category></item>', 'X');
    truthy(classifyNewsImpact(it).tags.includes('regulation'));
  });
  test('newsItemId: id → guid → url fallback chain', () => {
    eq(newsItemId({ id: 7 }), '7');
    eq(newsItemId({ guid: 'g1' }), 'g1');
    eq(newsItemId({ url: 'https://x/y' }), 'https://x/y');
    eq(newsItemId({}), '');
  });
}

// ── Perp-map favored priority (#3 coverage plumbing) ────────────────────────
console.log('\n[perpmap] buildPerpSymbolMap favored priority');
{
  const fakeCoinalyze = {
    async futureMarkets() {
      return ['BTC', 'BIG', 'HOT', 'PIN'].map(b => ({
        is_perpetual: true, base_asset: b, quote_asset: 'USDT', symbol: `${b}USDT_PERP`,
      }));
    },
  };
  // allCgIds order = MC order: btc, big, hot, pin. PIN pinned, HOT a hot-mover.
  const fakeUniverse = {
    _ids: ['btc', 'big', 'hot', 'pin'],
    _sym: { btc: 'BTC', big: 'BIG', hot: 'HOT', pin: 'PIN' },
    allCgIds() { return this._ids; },
    isPinned(id) { return id === 'pin'; },
    isHotMover(id) { return id === 'hot'; },
    isFavored(id) { return this.isPinned(id) || this.isHotMover(id); },
    lookupByCgId(id) { return { symbol: this._sym[id] }; },
  };
  await aTest('favored (pinned + hot-mover) win perp slots over generic top-MC at the cap', async () => {
    const map = await buildPerpSymbolMap(fakeCoinalyze, fakeUniverse, 3);
    truthy(map.has('PIN'), 'pinned mapped');
    truthy(map.has('HOT'), 'hot-mover mapped (would be crowded out without favored-priority)');
    eq(map.size, 3);
    truthy(!map.has('BIG'), 'generic top-MC BIG crowded out at topN=3');
  });
}

// ── Bybit price rounding — the sub-1e-6 tick "SL/TP → 0" live-money bug ──────
console.log('\n[bybit] roundPrice / roundQtyDown tick precision');
{
  const rp = (p, t) => BybitExchange.roundPrice(p, t);
  test('roundPrice survives scientific-notation ticks (TLM SL was rounding to 0)', () => {
    eq(rp(0.00151326, 1e-7), 0.0015133);      // "1e-7" tick → was toFixed(0) → 0
    eq(rp(0.00151326, 0.0000001), 0.0015133);
    eq(rp(0.00151326, 1e-8), 0.00151326);
    truthy(rp(0.0016932, 1e-7) > 0);          // TP also non-zero
  });
  test('roundPrice unchanged for normal ticks', () => {
    eq(rp(58294, 0.1), 58294);
    eq(rp(1.2345, 0.001), 1.235);
    eq(rp(0.00151326, 0.00001), 0.00151);
  });
  test('roundQtyDown floors to step, incl. tiny steps', () => {
    eq(BybitExchange.roundQtyDown(25111.7, 1), 25111);
    eq(BybitExchange.roundQtyDown(0.30000004, 1e-7), 0.3);
  });
}

// ── LLM layer — enable gate + Telegram-Markdown escaping ────────────────────
console.log('\n[llm] LLM helpers');
{
  const saved = process.env.HYPERBOLIC_API_KEY;
  test('llmEnabled: off without a key, on with one', () => {
    delete process.env.HYPERBOLIC_API_KEY; delete process.env.LLM_API_KEY;
    eq(llmEnabled(), false);
    process.env.HYPERBOLIC_API_KEY = 'sk_test';
    eq(llmEnabled(), true);
    if (saved === undefined) delete process.env.HYPERBOLIC_API_KEY; else process.env.HYPERBOLIC_API_KEY = saved;
  });
  test('escapeTgMarkdown neutralises *, _, [] and trims wrapping quotes', () => {
    eq(escapeTgMarkdown('*bold* _it_ [x]'), '\\*bold\\* \\_it\\_ \\[x\\]');
    eq(escapeTgMarkdown('has `code` inside'), 'has \\`code\\` inside');
    eq(escapeTgMarkdown('"wrapped"'), 'wrapped');
    eq(escapeTgMarkdown(null), '');
  });
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════`);
console.log(`  ${passed} passed,  ${failed} failed`);
console.log(`══════════════════════════════════════════\n`);
process.exit(failed > 0 ? 1 : 0);
