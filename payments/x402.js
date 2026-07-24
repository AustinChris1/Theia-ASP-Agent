

import { createHmac } from 'node:crypto';
import { config, activeAsset } from '../config.js';

const X402_VERSION = 1;
const TRUST_UNVERIFIED = process.env.X402_TRUST_UNVERIFIED === '1';
const NETWORK = process.env.X402_NETWORK || config.x402.network;

export function toBaseUnits(decimalStr, decimals) {
  const s = String(decimalStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${decimalStr}`);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined || '0';
}

export function x402Mode() {
  if (!config.x402.enforce) return 'off';
  if (config.x402.facilitatorUrl) return 'facilitator';
  return 'declare';
}

export function buildPaymentRequired({ resource, priceUsdt, description }) {
  const asset = activeAsset();
  const accepts = [{
    scheme: config.x402.scheme,
    network: NETWORK,
    maxAmountRequired: toBaseUnits(priceUsdt, asset.decimals),
    resource,
    description,
    mimeType: 'application/json',
    payTo: config.x402.payTo,
    maxTimeoutSeconds: 120,
    asset: asset.address,
    decimals: asset.decimals,
    // Exact scheme: extra is the token EIP-712 domain only. Extra fields here can
    // fail the facilitator's paymentRequirements compare (param_mismatch).
    extra: {
      name: asset.eip712Name,
      version: asset.eip712Version,
    },
  }];
  return { x402Version: X402_VERSION, resource, accepts };
}

function encodeRequired(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function send402(res, payload, extra = {}) {
  res.status(402);
  res.set('PAYMENT-REQUIRED', encodeRequired(payload));
  res.json({ x402Version: X402_VERSION, error: 'payment_required', ...extra, accepts: payload.accepts, resource: payload.resource });
}

// OKX OK-ACCESS signing: Base64(HMAC-SHA256(ts + METHOD + requestPath + body, secret)).
function okxAuthHeaders({ method, requestPath, body }) {
  const a = config.x402.facilitatorAuth;
  if (!a?.apiKey || !a?.secretKey || !a?.passphrase) return {};
  const ts = new Date().toISOString();
  const sign = createHmac('sha256', a.secretKey)
    .update(ts + method.toUpperCase() + requestPath + (body || ''))
    .digest('base64');
  const h = {
    'OK-ACCESS-KEY': a.apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': a.passphrase,
  };
  if (a.projectId) h['OK-ACCESS-PROJECT'] = a.projectId;
  return h;
}

// Body must be byte-identical between signing and sending, and requestPath is path-only.
async function facilitatorPost(origin, requestPath, bodyObj, timeoutMs) {
  const body = JSON.stringify(bodyObj);
  const headers = { 'content-type': 'application/json', ...okxAuthHeaders({ method: 'POST', requestPath, body }) };
  const res = await fetch(`${origin}${requestPath}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

export async function settleViaFacilitator({ paymentB64, payload }) {
  const url = new URL(config.x402.facilitatorUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentB64, 'base64').toString('utf8'));
  } catch {
    paymentPayload = { raw: paymentB64 };
  }
  const requirements = payload.accepts[0];
  const reqBody = { x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements };
  try {
    // OKX wraps results in {code, msg, data}. Fail closed: only an explicit
    // code 0 + data.isValid / data.success passes; anything else rejects.
    const { res: vr, json: vj } = await facilitatorPost(url.origin, `${basePath}/verify`, reqBody, 8000);
    const vd = vj?.data ?? {};
    if (!vr.ok || String(vj?.code ?? '') !== '0') {
      console.warn(`[x402] verify envelope rejected: status=${vr.status} code=${vj?.code} msg=${vj?.msg} data=${JSON.stringify(vd)}`);
      return { ok: false, reason: vj?.msg || vd.invalidMessage || `verify failed (${vr.status})` };
    }
    if (vd.isValid !== true) {
      console.warn(`[x402] verify invalid: reason=${vd.invalidReason} msg=${vd.invalidMessage} data=${JSON.stringify(vd)}`);
      return { ok: false, reason: vd.invalidReason || vd.invalidMessage || 'payment not valid' };
    }

    const { res: sr, json: sj } = await facilitatorPost(url.origin, `${basePath}/settle`, reqBody, 12000);
    const sd = sj?.data ?? {};
    if (!sr.ok || String(sj?.code ?? '') !== '0') return { ok: false, reason: sj?.msg || sd.errorMessage || `settle failed (${sr.status})` };
    if (sd.success !== true) return { ok: false, reason: sd.errorReason || sd.errorMessage || 'settlement failed' };
    return { ok: true, settlement: sd };
  } catch (e) {
    return { ok: false, reason: `facilitator error: ${e.message}` };
  }
}

export function x402Gate({ priceUsdt, description }) {
  return async function gate(req, res, next) {
    const mode = x402Mode();
    if (mode === 'off') return next();

    const resource = `${config.server.publicUrl.replace(/\/$/, '')}${req.baseUrl || ''}${req.path}`;
    const payload = buildPaymentRequired({ resource, priceUsdt, description });

    const paymentB64 = req.get('PAYMENT-SIGNATURE')
      || req.get('X-PAYMENT')
      || (req.get('Authorization')?.startsWith('Payment ') ? req.get('Authorization').slice('Payment '.length) : null);

    if (!paymentB64) return send402(res, payload);

    if (mode === 'facilitator') {
      const result = await settleViaFacilitator({ paymentB64, payload });
      if (!result.ok) return send402(res, payload, { reason: result.reason });
      if (result.settlement) {
        res.set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(result.settlement), 'utf8').toString('base64'));
      }
      return next();
    }

    if (TRUST_UNVERIFIED) {
      res.set('X-Payment-Warning', 'accepted without verification (X402_TRUST_UNVERIFIED=1, demo only)');
      return next();
    }
    return send402(res, payload, { reason: 'facilitator_not_configured' });
  };
}

export function paymentInfo() {
  const asset = activeAsset();
  return {
    protocol: 'x402',
    version: X402_VERSION,
    mode: x402Mode(),
    network: NETWORK,
    chainId: config.x402.chainId,
    settlementAsset: { symbol: asset.symbol, address: asset.address, decimals: asset.decimals },
    payTo: config.x402.payTo,
    facilitator: config.x402.facilitatorUrl || null,
    facilitatorAuth: !!config.x402.facilitatorAuth?.apiKey,
  };
}

export default { x402Gate, buildPaymentRequired, paymentInfo, x402Mode, toBaseUnits, settleViaFacilitator };
