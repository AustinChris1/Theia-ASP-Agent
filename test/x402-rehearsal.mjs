

import http from 'node:http';

process.env.X402_ENFORCE = '1';
process.env.X402_PAY_TO = '0x000000000000000000000000000000000000dEaD';
process.env.X402_ASSET_USDT_ADDRESS = '0x1E4a5963aBFD975d8c9021ce480b42188849D41d';
process.env.X402_ASSET_USDT_DECIMALS = '6';
process.env.X402_DEFAULT_ASSET = 'USDT';
process.env.ASP_PUBLIC_URL = 'http://localhost';

let facilMode = 'ok';
const seen = { verify: 0, settle: 0 };
const facil = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = () => { try { return JSON.parse(body); } catch { return {}; } };
    if (req.url.endsWith('/verify')) {
      seen.verify++;
      const payload = j();
      const okShape = payload.x402Version === 1 && payload.paymentRequirements && payload.paymentPayload;
      res.writeHead(okShape ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(facilMode === 'ok' ? { isValid: true } : { isValid: false, invalidReason: 'bad-signature' }));
    } else if (req.url.endsWith('/settle')) {
      seen.settle++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, transaction: '0xdeadbeef', payer: '0xBuyer', amount: '100000', network: 'eip155:196' }));
    } else {
      res.writeHead(404); res.end('{}');
    }
  });
});
await new Promise((r) => facil.listen(0, r));
process.env.X402_FACILITATOR_URL = `http://localhost:${facil.address().port}`;

const { createApp } = await import('../server.js');
const { x402Mode } = await import('../payments/x402.js');

const stubEngine = {
  status: { ta: true, funding: 'coinalyze' },
  analyze: async () => ({
    token: { symbol: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin', marketCap: 1.2e12 },
    side: 'LONG', strength: { label: 'STRONG', confidence: 72 }, score: 5.2, currentPrice: 62000,
    sideScores: { long: 5.2, short: 1.1 }, reasons: [{ kind: 'ta', text: 'demo', points: 1 }],
    tradePlan: { entry: 62000, sl: 61000, tp1: 63000, tp2: 64000, tp3: 65000, slPct: 1.6, rr1: 1, rr2: 2, rr3: 3, suggestedLeverage: 10, maxLeverage: 20, horizon: 'SWING', validityHrs: 24 },
  }),
};
const app = createApp(stubEngine);
const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${srv.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const post = (path, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token: 'BTC' }) });

console.log('\nx402 live-enforcement dress-rehearsal\n');

ok(x402Mode() === 'facilitator', 'mode = facilitator (enforce on + facilitator configured)');

const health = await fetch(`${base}/health`);
ok(health.status === 200, 'GET /health stays free under enforcement');
const manifest = await (await fetch(`${base}/`)).json();
ok(manifest.payment.mode === 'facilitator', 'manifest advertises payment.mode = facilitator');

const r1 = await post('/skills/theia_signal');
ok(r1.status === 402, 'unpaid call returns HTTP 402');
const prHeader = r1.headers.get('PAYMENT-REQUIRED');
ok(!!prHeader, 'PAYMENT-REQUIRED header present');
const challenge = prHeader ? JSON.parse(Buffer.from(prHeader, 'base64').toString('utf8')) : {};
ok(challenge.x402Version === 1, 'challenge.x402Version = 1');
const a = challenge.accepts?.[0] || {};
ok(a.scheme === 'exact', 'accepts.scheme = exact');
ok(a.network === 'eip155:196', 'accepts.network = eip155:196 (X Layer)');
ok(a.payTo === process.env.X402_PAY_TO, 'accepts.payTo = our wallet');
ok(a.asset === process.env.X402_ASSET_USDT_ADDRESS, 'accepts.asset = X Layer USDT address');
ok(a.maxAmountRequired === '100000', 'accepts.maxAmountRequired = 100000 (0.10 USDT x 1e6)');
ok(a.extra?.humanAmount === '0.10' && a.extra?.assetSymbol === 'USDT', 'extra carries humanAmount + assetSymbol');
ok(typeof a.resource === 'string' && a.resource.endsWith('/skills/theia_signal'), 'accepts.resource points at the skill');
ok(a.maxTimeoutSeconds > 0, 'accepts.maxTimeoutSeconds set');

const payment = Buffer.from(JSON.stringify({ scheme: 'exact', network: 'eip155:196', payload: { signature: '0xsig', authorization: { from: '0xBuyer' } } }), 'utf8').toString('base64');
facilMode = 'ok';
const r2 = await post('/skills/theia_signal', { 'PAYMENT-SIGNATURE': payment });
ok(r2.status === 200, 'paid replay returns HTTP 200');
ok(seen.verify >= 1 && seen.settle >= 1, 'facilitator /verify AND /settle were called');
const respHeader = r2.headers.get('PAYMENT-RESPONSE');
ok(!!respHeader, 'PAYMENT-RESPONSE header present on success');
const settle = respHeader ? JSON.parse(Buffer.from(respHeader, 'base64').toString('utf8')) : {};
ok(settle.success === true && settle.transaction === '0xdeadbeef', 'PAYMENT-RESPONSE carries settlement tx');
const body2 = await r2.json();
ok(body2.ok === true && body2.data?.side === 'LONG', 'skill JSON returned after payment');

facilMode = 'reject';
const settleBefore = seen.settle;
const r3 = await post('/skills/theia_signal', { 'PAYMENT-SIGNATURE': payment });
ok(r3.status === 402, 'invalid payment is refused with 402');
ok(seen.settle === settleBefore, 'no settlement attempted when verify fails');

srv.close(); facil.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
