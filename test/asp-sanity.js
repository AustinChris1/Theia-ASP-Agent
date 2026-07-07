// test/asp-sanity.js — pure unit suite for the ASP layer. NO live network calls.
// Skills run against a mock engine; the x402 facilitator path mocks global fetch.
// Run: node test/asp-sanity.js

// Env MUST be set before importing the ASP modules (config + x402 read env at load).
process.env.X402_ENFORCE = '0';
process.env.X402_PAY_TO = '0x000000000000000000000000000000000000dEaD';
process.env.X402_ASSET_USDT_ADDRESS = '0x1E4a5963aBFD975d8c9021ce480b42188849D41d'; // placeholder X Layer USDT
process.env.X402_NETWORK = 'eip155:196';

import { createHash } from 'node:crypto';
const sha = (s) => createHash('sha256').update(s).digest('hex');

let pass = 0, fail = 0;
const results = [];
function group(name) { results.push({ group: name }); }
function ok(cond, msg) {
  if (cond) { pass++; results.push({ ok: true, msg }); }
  else { fail++; results.push({ ok: false, msg }); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

// ── Dynamic imports after env is set ─────────────────────────────────────────
const { config, x402Ready } = await import('../config.js');
const { SKILLS, SKILLS_BY_NAME, skillManifest } = await import('../skills/index.js');
const x402 = await import('../payments/x402.js');
const ledger = await import('../reputation/ledger.js');
const deepDesk = await import('../a2a/deep-desk.js');

// ── Mock engine (no network) ─────────────────────────────────────────────────
const BTC = { symbol: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin', marketCap: 1.2e12, circulatingSupply: 19e6, totalSupply: 21e6, chains: {} };
const mockEngine = {
  status: { ta: true, funding: 'binance', heatmap: true, clusters: true, teamDiscovery: true, cexHoldings: true },
  universe: {
    allCgIds: () => ['bitcoin'],
    lookupByCgId: (id) => (id === 'bitcoin' ? BTC : null),
    ensureBySymbol: async (s) => (String(s).toUpperCase() === 'BTC' ? { coingeckoId: 'bitcoin' } : null),
  },
  prices: {
    getPrice: () => 60000,
    getFuturesVolume: () => 2.4e9,
    getSpotVolume: () => 1.0e9,
    get24hVolume: () => 3.0e10,
  },
  teamDiscovery: {
    getConcentration: () => ({ top10Pct: 42, holderCount: 1200 }),
    holdersForSymbol: (s) => (String(s).toUpperCase() === 'BTC'
      ? { symbol: 'BTC', concentration: { top10Pct: 42, holderCount: 1200 }, tokens: [{ chain: 'ethereum', tokenAddress: '0xabc', ts: Date.now(), holders: [{ address: '0xInsider1', percent: 5.2, balance: 1000 }, { address: '0xInsider2', percent: 3.1, balance: 600 }] }] }
      : null),
  },
  cexHoldings: {
    getLeaderboard: () => ({ computedAt: Date.now(), byExchange: { binance: [{ symbol: 'ARB', cgId: 'arbitrum', pctSupply: 12.5, amount: 5e8, usd: 4e8 }] } }),
    snapshot: async () => ({ ethereum: [{ address: '0xCold1', balance: 500, exchange: 'binance' }], bsc: [], totalBalance: 500, totalUsd: 3e7, pctOfSupply: 0.6 }),
  },
  liquidationHeatmap: {
    compute: async () => ({
      currentPrice: 60000,
      longLiqs: [{ price: 57000, distancePct: -5, notionalUsd: 8e6, dominantLev: 25 }],
      shortLiqs: [{ price: 63000, distancePct: 5, notionalUsd: 6e6, dominantLev: 20 }],
      totalLongUsd: 8e6, totalShortUsd: 6e6,
    }),
  },
  analyze: async (symbol) => (String(symbol).toUpperCase() === 'BTC'
    ? {
        token: { symbol: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin', chain: 'ethereum' },
        side: 'LONG', strength: { label: 'HIGH', confidence: 78, total: 4.2 }, score: 4.2,
        reasons: [{ kind: 'funding', text: 'funding aligned', points: 1.2 }, { kind: 'ta', text: '4h uptrend', points: 0.8 }],
        tradePlan: { entry: 60000, sl: 58000, tp1: 62000, tp2: 64000, tp3: 66000, slPct: 3.33, rr1: 1, rr2: 2, rr3: 3, suggestedLeverage: 5, maxLeverage: 10, horizon: 'SWING', validityHrs: 24 },
        manipulationRegime: false, currentPrice: 60000, lowConviction: false, sideScores: { long: 4.2, short: 1.1 },
      }
    : null),
};

// ── Registry ─────────────────────────────────────────────────────────────────
group('registry');
eq(SKILLS.length, 6, 'six skills registered');
ok(skillManifest().every((s) => s.name && s.priceUsdt && s.inputSchema), 'manifest entries well-formed');
ok(['theia_signal', 'theia_manipulation_check', 'theia_cex_flow', 'theia_insider_scan', 'theia_liqmap', 'theia_cex_holdings'].every((n) => SKILLS_BY_NAME[n]), 'all six skill names present');

// ── theia_signal ─────────────────────────────────────────────────────────────
group('theia_signal');
{
  const r = await SKILLS_BY_NAME.theia_signal.run({ token: 'BTC' }, mockEngine);
  ok(r.ok === true, 'signal ok');
  eq(r.data.side, 'LONG', 'signal side');
  eq(r.data.tier, 'HIGH', 'signal tier');
  eq(r.data.confidence, 78, 'signal confidence');
  eq(r.data.tradePlan.entry, 60000, 'signal plan entry');
  eq(r.data.tradePlan.rr3, 3, 'signal plan rr3');
  ok(r.data.reasons.length === 2, 'signal reasons passthrough');
  ok(typeof r.disclaimer === 'string' && r.meta.deterministic === true, 'signal envelope disclaimer + deterministic');
  const bad = await SKILLS_BY_NAME.theia_signal.run({ token: 'NOPE' }, mockEngine);
  ok(bad.ok === false && bad.error.code === 'unresolved_token', 'signal rejects unknown token');
  const noParam = await SKILLS_BY_NAME.theia_signal.run({}, mockEngine);
  ok(noParam.ok === false && noParam.error.code === 'bad_request', 'signal rejects missing token');
}

// ── theia_manipulation_check ─────────────────────────────────────────────────
group('theia_manipulation_check');
{
  const r = await SKILLS_BY_NAME.theia_manipulation_check.run({ token: 'BTC' }, mockEngine);
  ok(r.ok === true, 'manip ok');
  ok(typeof r.data.riskScore === 'number' && r.data.riskScore >= 0 && r.data.riskScore <= 1, 'manip riskScore in [0,1]');
  ok(Array.isArray(r.data.flags), 'manip flags array');
  ok(['low', 'moderate', 'elevated', 'high'].includes(r.data.riskLevel), 'manip riskLevel valid');
  eq(r.data.measured.futuresToSpotRatio, 2.4, 'manip futures/spot ratio computed');
  ok(r.data.coverage.measured.length >= 1, 'manip coverage note');
}

// ── theia_insider_scan ───────────────────────────────────────────────────────
group('theia_insider_scan');
{
  const r = await SKILLS_BY_NAME.theia_insider_scan.run({ token: 'BTC' }, mockEngine);
  ok(r.ok === true, 'insider ok');
  eq(r.data.concentrationTop10Pct, 42, 'insider concentration');
  ok(r.data.insiderHolders.length === 2, 'insider holders count');
  ok(r.data.insiderHolders[0].percentOfSupply >= r.data.insiderHolders[1].percentOfSupply, 'insider holders sorted desc');
}

// ── theia_liqmap ─────────────────────────────────────────────────────────────
group('theia_liqmap');
{
  const r = await SKILLS_BY_NAME.theia_liqmap.run({ token: 'BTC' }, mockEngine);
  ok(r.ok === true, 'liqmap ok');
  eq(r.data.currentPrice, 60000, 'liqmap current price');
  ok(r.data.clustersAbove.length === 1 && r.data.clustersBelow.length === 1, 'liqmap clusters both sides');
  eq(r.data.nearestAbove.price, 63000, 'liqmap nearest above');
}

// ── theia_cex_holdings (token + exchange modes) ──────────────────────────────
group('theia_cex_holdings');
{
  const rTok = await SKILLS_BY_NAME.theia_cex_holdings.run({ token: 'BTC' }, mockEngine);
  ok(rTok.ok === true && rTok.data.mode === 'token', 'cex_holdings token mode');
  eq(rTok.data.pctOfSupplyInColdStorage, 0.6, 'cex_holdings pct of supply');
  const rEx = await SKILLS_BY_NAME.theia_cex_holdings.run({ token: 'binance' }, mockEngine);
  ok(rEx.ok === true && rEx.data.mode === 'exchange', 'cex_holdings exchange mode');
  ok(rEx.data.corneredTokens[0].symbol === 'ARB', 'cex_holdings cornered token');
}

// ── theia_cex_flow (baseline then delta) ─────────────────────────────────────
group('theia_cex_flow');
{
  const r1 = await SKILLS_BY_NAME.theia_cex_flow.run({ token: 'BTC' }, mockEngine);
  ok(r1.ok === true, 'cex_flow ok (baseline)');
  ok(r1.data.custody.totalInColdStorage === 500, 'cex_flow custody total');
  // Second call: custody changes -> direction populated.
  const engine2 = { ...mockEngine, cexHoldings: { ...mockEngine.cexHoldings, snapshot: async () => ({ ethereum: [{ address: '0xCold1', balance: 700, exchange: 'binance' }], bsc: [], totalBalance: 700, totalUsd: 4.2e7, pctOfSupply: 0.84 }) } };
  const r2 = await SKILLS_BY_NAME.theia_cex_flow.run({ token: 'BTC' }, engine2);
  ok(r2.ok === true && r2.data.flow, 'cex_flow flow populated on 2nd call');
  eq(r2.data.flow.direction, 'deposit', 'cex_flow direction = deposit (custody rose)');
  eq(r2.data.flow.bias, 'bearish', 'cex_flow bias bearish on deposit');
}

// ── x402: unit conversions ───────────────────────────────────────────────────
group('x402 conversions');
eq(x402.toBaseUnits('0.10', 6), '100000', 'toBaseUnits 0.10');
eq(x402.toBaseUnits('0.02', 6), '20000', 'toBaseUnits 0.02');
eq(x402.toBaseUnits('1', 6), '1000000', 'toBaseUnits 1');
eq(x402.toBaseUnits('0.000001', 6), '1', 'toBaseUnits smallest unit');
{ let threw = false; try { x402.toBaseUnits('abc', 6); } catch { threw = true; } ok(threw, 'toBaseUnits rejects garbage'); }

// ── x402: buildPaymentRequired shape ─────────────────────────────────────────
group('x402 challenge shape');
{
  const p = x402.buildPaymentRequired({ resource: 'https://x/skills/theia_signal', priceUsdt: '0.10', description: 'test' });
  eq(p.x402Version, 1, 'x402Version=1');
  ok(Array.isArray(p.accepts) && p.accepts.length === 1, 'accepts array');
  const a = p.accepts[0];
  eq(a.scheme, 'exact', 'scheme exact');
  eq(a.network, 'eip155:196', 'network X Layer');
  eq(a.maxAmountRequired, '100000', 'atomic amount');
  eq(a.payTo, process.env.X402_PAY_TO, 'payTo');
  eq(a.asset, process.env.X402_ASSET_USDT_ADDRESS, 'asset address');
  ok(a.extra && a.extra.chainId === 196, 'extra carries chainId');
}

// ── x402: gate modes (fake req/res) ──────────────────────────────────────────
group('x402 gate modes');
const mkReq = (headers = {}) => ({
  baseUrl: '', path: '/skills/theia_signal',
  get: (n) => headers[n] ?? headers[n.toUpperCase()] ?? headers[n.toLowerCase()] ?? null,
});
const mkRes = () => ({ statusCode: 200, headers: {}, body: null, ended: false,
  status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
  json(b) { this.body = b; this.ended = true; return this; } });

// off mode -> next()
config.x402.enforce = false;
{
  const gate = x402.x402Gate({ priceUsdt: '0.10', description: 'x' });
  const res = mkRes(); let nexted = false;
  await gate(mkReq(), res, () => { nexted = true; });
  ok(nexted && !res.ended, 'off mode calls next (free)');
}
// declare mode, no payment -> 402 with PAYMENT-REQUIRED header
config.x402.enforce = true; config.x402.facilitatorUrl = null;
eq(x402.x402Mode(), 'declare', 'mode=declare when enforce + no facilitator');
{
  const gate = x402.x402Gate({ priceUsdt: '0.10', description: 'x' });
  const res = mkRes(); let nexted = false;
  await gate(mkReq(), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 402, 'declare mode returns 402 without payment');
  ok(typeof res.headers['PAYMENT-REQUIRED'] === 'string', 'declare mode sets PAYMENT-REQUIRED header');
}
// declare mode, payment present but no facilitator -> 402 facilitator_not_configured
{
  const gate = x402.x402Gate({ priceUsdt: '0.10', description: 'x' });
  const res = mkRes(); let nexted = false;
  await gate(mkReq({ 'PAYMENT-SIGNATURE': 'ZmFrZQ==' }), res, () => { nexted = true; });
  ok(!nexted && res.statusCode === 402 && res.body.reason === 'facilitator_not_configured', 'declare mode refuses unverifiable payment');
}
// facilitator mode, mocked fetch success -> next() + PAYMENT-RESPONSE header
group('x402 facilitator (mocked)');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0xTX', payer: '0xBuyer' }),
  });
  config.x402.enforce = true; config.x402.facilitatorUrl = 'https://facilitator.test';
  try {
    eq(x402.x402Mode(), 'facilitator', 'mode=facilitator when url set');
    const gate = x402.x402Gate({ priceUsdt: '0.10', description: 'x' });
    const res = mkRes(); let nexted = false;
    await gate(mkReq({ 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify({ scheme: 'exact' })).toString('base64') }), res, () => { nexted = true; });
    ok(nexted, 'facilitator success calls next (paid)');
    ok(typeof res.headers['PAYMENT-RESPONSE'] === 'string', 'facilitator success sets PAYMENT-RESPONSE');
    // failure path
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ isValid: false, invalidReason: 'bad_sig' }) });
    const res2 = mkRes(); let nexted2 = false;
    await gate(mkReq({ 'PAYMENT-SIGNATURE': 'ZmFrZQ==' }), res2, () => { nexted2 = true; });
    ok(!nexted2 && res2.statusCode === 402 && res2.body.reason === 'bad_sig', 'facilitator verify-fail returns 402 with reason');
  } finally {
    globalThis.fetch = realFetch;
    config.x402.enforce = false; config.x402.facilitatorUrl = null;
  }
}

// ── Reputation ledger (real outcomes only) ───────────────────────────────────
group('reputation ledger');
{
  // leafFor is deterministic (same record -> same hash).
  const rec = { symbol: 'BTC', side: 'LONG', strength: 'HIGH', entry: 60000, sl: 58000, tp1: 62000, outcome: 'WIN_TP1', finalPnlPct: 3.3, createdAt: 1000, resolvedAt: 2000 };
  const l1 = ledger.leafFor(rec);
  const l2 = ledger.leafFor({ ...rec });
  ok(l1.hash === l2.hash && /^[0-9a-f]{64}$/.test(l1.hash), 'leafFor deterministic sha256');
  const changed = ledger.leafFor({ ...rec, outcome: 'LOSS' });
  ok(changed.hash !== l1.hash, 'leaf hash changes with outcome');

  // merkleRoot stable + order-independent pairing.
  const leaves = ['aa', 'bb', 'cc'].map((x) => sha(x));
  const root = ledger.merkleRoot(leaves);
  ok(/^[0-9a-f]{64}$/.test(root), 'merkleRoot is a 32-byte hex');
  ok(ledger.merkleRoot([leaves[0]]) === leaves[0], 'single leaf root = leaf');

  // computeLedger uses ONLY resolved records; ignores open ones.
  const mockTracker = {
    allRecords: async () => [
      rec,
      { symbol: 'ETH', side: 'SHORT', outcome: 'OPEN' },      // ignored (not resolved)
      { symbol: 'SOL', side: 'LONG', outcome: 'LOSS', finalPnlPct: -2.0 },
    ],
    getStats: () => ({ resolved: 2, wins: 1, losses: 1, winPct: 50, byStrength: {} }),
  };
  const led = await ledger.computeLedger(mockTracker);
  eq(led.count, 2, 'computeLedger counts only resolved');
  ok(led.available === true && /^[0-9a-f]{64}$/.test(led.merkleRoot), 'computeLedger builds a root');

  const sb = await ledger.scoreboard(mockTracker);
  eq(sb.winRatePct, 50, 'scoreboard win rate');
  eq(sb.resolvedSignals, 2, 'scoreboard resolved count');

  // Empty tracker -> honest "no data", never fabricated.
  const empty = await ledger.computeLedger({ allRecords: async () => [], getStats: () => ({}) });
  ok(empty.available === false && empty.count === 0, 'empty ledger reports no data honestly');

  // anchor command shape (calldata sink default).
  const cmd = ledger.anchorCommand('deadbeef'.repeat(8), { payTo: '0xabc' });
  ok(cmd.sink === 'calldata' && cmd.command.includes('onchainos wallet send') && cmd.memoHex.startsWith('0x'), 'anchor command (calldata) well-formed');
}

// ── A2A Deep Desk ─────────────────────────────────────────────────────────────
group('a2a deep desk');
{
  const toks = deepDesk.extractTokens('Please audit BTC and ETH portfolio, USDT excluded, deep risk report');
  ok(toks.includes('BTC') && !toks.includes('USDT') && !toks.includes('AUDIT'), 'extractTokens filters stables + stopwords');

  const accept = await deepDesk.assessJob({ description: 'audit BTC and FOOBAR', budgetUsdt: 10 }, mockEngine);
  ok(accept.accept === true && accept.tokens.includes('BTC') && accept.unrecognized.includes('FOOBAR'), 'assessJob accepts recognized, flags unrecognized');

  const lowBudget = await deepDesk.assessJob({ description: 'audit BTC', budgetUsdt: 0.5 }, mockEngine);
  ok(lowBudget.accept === false && /floor/i.test(lowBudget.reason), 'assessJob declines below budget floor');

  const noTok = await deepDesk.assessJob({ description: 'hello world please help' }, mockEngine);
  ok(noTok.accept === false && noTok.tokens.length === 0, 'assessJob declines when no tokens');

  const { report, markdown } = await deepDesk.runDeepDesk({ tokens: ['BTC'], jobId: 'task-1' }, mockEngine);
  ok(report.tokenCount === 1 && report.tokens[0].token === 'BTC', 'runDeepDesk audits the token set');
  ok(typeof markdown === 'string' && markdown.includes('## BTC') && markdown.includes('Manipulation risk'), 'deep desk markdown renders findings');

  ok(deepDesk.cli.canDeliver(1) === true && deepDesk.cli.canDeliver(0) === false, 'canDeliver gated on ACCEPTED(1)');
  ok(deepDesk.cli.deliver('task-1', '/x/r.md', '963').includes('onchainos agent deliver'), 'deliver cli command');
}

// ── Engine pure-function regression (functions the ASP depends on) ────────────
group('engine functions');
{
  const { assessManipulation, assessPumpRegime, enforceTpLadder } = await import('../src/conductor.js');
  const clean = assessManipulation({ futuresVol: 1, spotVol: 1, volume: 1, marketCap: 1e9, floatPct: 0.9, concentrationPct: 10 });
  ok(clean.score === 0 && Array.isArray(clean.flags), 'assessManipulation clean token scores 0');
  const dirty = assessManipulation({ futuresVol: 10, spotVol: 1, volume: 2e6, marketCap: 1e6, floatPct: 0.1, concentrationPct: 80 });
  ok(dirty.score > 0.5 && dirty.flags.length >= 3, 'assessManipulation stacks legs on a manipulated token');
  const regime = assessPumpRegime({ manipFlags: dirty.flags }, 3);
  ok(typeof regime.isRegime === 'boolean' && Array.isArray(regime.legs), 'assessPumpRegime returns legs + verdict');
  const ladder = enforceTpLadder('LONG', 100, {}, { tp1: 102, tp2: 101, tp3: 104 });
  ok(ladder.tp1 <= ladder.tp2 && ladder.tp2 <= ladder.tp3, 'enforceTpLadder orders a LONG ladder ascending');
}

// ── OKX v5 client (mocked fetch; no live calls) ───────────────────────────────
group('okx client');
{
  const { OkxClient, OKX_BAR } = await import('../src/okx.js');
  const origFetch = global.fetch;
  const body = (data) => ({ ok: true, json: async () => ({ code: '0', data }) });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/market/candles')) return body([
      ['1700000600000', '10', '12', '9', '11', '100', 'x', 'x', '1'],
      ['1700000000000', '9', '11', '8', '10', '90', 'x', 'x', '1'],
    ]);
    if (u.includes('/public/funding-rate')) return body([{ instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', nextFundingTime: '1700003600000' }]);
    if (u.includes('/public/open-interest')) return body([{ instId: 'BTC-USDT-SWAP', oi: '1000', oiCcy: '50', ts: '1700000000000' }]);
    if (u.includes('/public/instruments')) return body([
      { instId: 'BTC-USDT-SWAP', settleCcy: 'USDT', ctType: 'linear', ctValCcy: 'BTC' },
      { instId: 'ETH-USD-SWAP', settleCcy: 'ETH', ctType: 'inverse', ctValCcy: 'ETH' },
    ]);
    return { ok: false, json: async () => ({}) };
  };

  const okx = new OkxClient({});
  const candles = await okx.getCandles('BTC-USDT-SWAP', '1H', 300);
  ok(candles.length === 2 && candles[0].t < candles[1].t, 'candles reversed to ascending by time');
  ok(candles[0].t === 1700000000 && candles[0].c === 10, 'candle ms->sec + OHLC parsed');
  const fr = await okx.getFundingRate('BTC-USDT-SWAP');
  ok(fr.fundingRate === 0.0001 && typeof fr.fundingRate === 'number', 'funding rate parsed as number');
  const oi = await okx.getOpenInterest('BTC-USDT-SWAP');
  ok(oi.oiCcy === 50, 'open interest oiCcy parsed');
  const map = await okx.buildSwapMap();
  ok(map.get('BTC') === 'BTC-USDT-SWAP' && !map.has('ETH'), 'swap map keeps USDT-linear only');
  ok(OKX_BAR['1hour'] === '1H' && OKX_BAR['daily'] === '1D' && OKX_BAR['5min'] === '5m', 'OKX_BAR interval mapping');

  ok(new OkxClient({}).base === 'https://www.okx.com', 'default base = okx.com direct');
  const relay = new OkxClient({ relayBaseUrl: 'https://r.dev', relayAuthSecret: 's' });
  ok(relay.base === 'https://r.dev/okx' && relay.auth === 's', 'relay base = /okx prefix with auth');
  ok(new OkxClient({ baseUrl: 'https://custom.okx' }).base === 'https://custom.okx', 'OKX_BASE_URL override wins');

  global.fetch = async () => ({ ok: true, json: async () => ({ code: '50011', msg: 'rate limit', data: [] }) });
  ok((await new OkxClient({}).getCandles('BTC-USDT-SWAP', '1H', 1)) === null, 'OKX code != 0 returns null');
  global.fetch = origFetch;
}

// ── FundingMonitor OKX gap-filler (mocked; no live calls) ─────────────────────
group('funding okx gap-filler');
{
  const { FundingMonitor } = await import('../src/funding.js');
  const mockOkx = {
    getFundingRate: async (inst) => ({ instId: inst, fundingRate: 0.0002, nextFundingTime: 1 }),
    getOpenInterest: async (inst) => ({ instId: inst, oi: 1000, oiCcy: 50, ts: 1 }),
  };
  const fm = new FundingMonitor({
    coinalyze: null, perpSymbolMap: new Map(), universe: { lookupByCgId: () => null },
    okx: mockOkx, okxSwapMap: new Map([['BTC', 'BTC-USDT-SWAP']]),
  });
  const rec = await fm.ensureBySymbol('BTC', 60000);
  ok(rec.summary.avg === 0.0002 && rec.summary.source === 'okx', 'okx funding rate populated + tagged');
  ok(rec.summary.totalOi === 50 * 60000, 'okx OI notional = oiCcy * price');
  ok(rec.summary.oiDeltaPct === null, 'first okx read has null oi delta (no false OI score)');
  ok((await fm.ensureBySymbol('BTC', 60000)) === rec, 'fresh funding not re-fetched');

  const fm2 = new FundingMonitor({ coinalyze: null, perpSymbolMap: new Map(), universe: {}, okx: null });
  ok((await fm2.ensureBySymbol('ETH')) === null, 'no okx client returns null gracefully');
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('');
let lastGroup = '';
for (const r of results) {
  if (r.group) { if (r.group !== lastGroup) { console.log(`\n[${r.group}]`); lastGroup = r.group; } continue; }
  console.log(`  ${r.ok ? '✓' : '✗ FAIL:'} ${r.msg}`);
}
console.log('\n' + '='.repeat(46));
console.log(`  ${pass} passed,  ${fail} failed`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);
