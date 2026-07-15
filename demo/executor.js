

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const TOKEN = flag('token', 'BTC');
const BASE = String(flag('url', process.env.ASP_TARGET_URL || 'http://localhost:8402')).replace(/\/$/, '');
const LIVE = !!flag('live', false);
const EXECUTE = !!flag('execute', false);
const SKILL_URL = `${BASE}/skills/theia_signal`;

const log = (...a) => console.log(...a);
const rule = () => log('─'.repeat(64));

function runOnchainos(argv) {
  const r = spawnSync('onchainos', argv, { encoding: 'utf8', timeout: 60000 });
  if (r.error) return { ok: false, error: r.error.message };
  try { return { ok: r.status === 0, json: JSON.parse(r.stdout), raw: r.stdout, stderr: r.stderr }; }
  catch { return { ok: r.status === 0, raw: r.stdout, stderr: r.stderr }; }
}

async function post(url, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token: TOKEN }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {  }
  return { status: res.status, headers: res.headers, json, text };
}

function decodeChallenge(res) {
  const b64 = res.headers.get('PAYMENT-REQUIRED');
  if (b64) { try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch {  } }
  return res.json?.accepts ? { x402Version: res.json.x402Version, accepts: res.json.accepts } : null;
}

async function main() {
  rule();
  log(`  Executor Agent -> Theia ASP`);
  log(`  skill: theia_signal   token: ${TOKEN}   target: ${SKILL_URL}`);
  log(`  mode:  ${LIVE ? 'LIVE (pays via onchainos)' : 'dry-run (prints commands)'}`);
  rule();

  log(`\n[1] Calling theia_signal...`);
  let res = await post(SKILL_URL);

  if (res.status === 200) {
    log(`    -> 200 OK (endpoint served without payment; x402 not enforced here).`);
    return showSignalAndAct(res.json);
  }
  if (res.status !== 402) {
    log(`    -> unexpected status ${res.status}: ${res.text.slice(0, 200)}`);
    process.exit(1);
  }

  const challenge = decodeChallenge(res);
  const accept = challenge?.accepts?.[0];
  log(`    -> 402 Payment Required (x402).`);
  if (accept) {
    const human = accept.extra?.humanAmount ?? '(see atomic)';
    log(`       price: ${human} ${accept.extra?.assetSymbol ?? ''} on ${accept.network} (chainId ${accept.extra?.chainId ?? '?'})`);
    log(`       payTo: ${accept.payTo}`);
  }

  const rawPayload = res.headers.get('PAYMENT-REQUIRED');
  const payCmd = ['payment', 'pay', '--payload', rawPayload || '<PAYMENT-REQUIRED header>'];
  log(`\n[2] Paying with x402 via the OKX Agentic Wallet:`);
  log(`    $ onchainos ${payCmd.join(' ')}`);

  let authHeader = null;
  if (LIVE) {
    const paid = runOnchainos(payCmd);
    authHeader = paid.json?.authorization_header || paid.json?.data?.authorization_header;
    if (!authHeader) { log(`    -> pay failed: ${paid.stderr || paid.raw || paid.error}`); process.exit(1); }
    log(`    -> signed. header_name=${paid.json?.header_name || 'PAYMENT-SIGNATURE'} wallet=${paid.json?.wallet || paid.json?.data?.wallet || '?'}`);
  } else {
    log(`    -> (dry-run) would return { authorization_header, wallet }. Re-run with --live to pay for real.`);
  }

  log(`\n[3] Replaying the request with the payment header...`);
  if (LIVE && authHeader) {
    res = await post(SKILL_URL, { 'PAYMENT-SIGNATURE': authHeader });
    if (res.status !== 200) { log(`    -> replay failed (${res.status}): ${res.text.slice(0, 200)}`); process.exit(1); }
    const settle = res.headers.get('PAYMENT-RESPONSE');
    if (settle) { try { log(`    -> settled: ${JSON.stringify(JSON.parse(Buffer.from(settle, 'base64').toString('utf8')))}`); } catch {  } }
    return showSignalAndAct(res.json);
  }
  log(`    -> (dry-run) would resend with PAYMENT-SIGNATURE and receive the signal JSON.`);
  log(`\n  Full loop: call -> 402 -> onchainos pay -> replay -> signal -> execute.`);
  log(`  Run against a free endpoint (X402_ENFORCE=0) or add --live to see live settlement.`);
}

function showSignalAndAct(signal) {
  rule();
  if (!signal?.ok) { log(`  signal error: ${JSON.stringify(signal?.error || signal)}`); process.exit(1); }
  const d = signal.data;
  log(`  THEIA SIGNAL: ${d.token?.symbol}  ${d.side} ${d.tier ?? ''}  (confidence ${d.confidence ?? 'n/a'}%)`);
  if (d.tradePlan) {
    log(`  Plan: entry ${d.tradePlan.entry} | SL ${d.tradePlan.stopLoss} | TP1 ${d.tradePlan.tp1} | lev ${d.tradePlan.suggestedLeverage}x | ${d.tradePlan.horizon}`);
  } else {
    log(`  (no trade plan at this confidence; data-only read)`);
  }
  rule();

  log(`\n[4] Executing via the OKX Agentic Wallet:`);
  if (!d.tradePlan) { log(`    -> no actionable plan; executor stands down (correct behavior).`); return; }
  const swapCmd = `onchainos swap --chain 196 --from USDT --to ${d.token?.symbol} --amount <size> --slippage 1`;
  log(`    $ ${swapCmd}`);
  if (LIVE && EXECUTE) {
    log(`    -> (live execute is a placeholder in this demo; wire your sizing + risk before enabling).`);
  } else {
    log(`    -> (dry-run) would place the entry, set SL ${d.tradePlan.stopLoss} and TP ladder. Add --live --execute to place.`);
  }
  log(`\n  Done. An agent paid Theia and acted on the result, no human in the loop.`);
}

main().catch((e) => { console.error(`executor error: ${e.stack || e.message}`); process.exit(1); });
