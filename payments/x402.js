// Seller-side x402 V2: emit a 402 challenge for X Layer USDT, then verify+settle
// the replay via a configurable facilitator. Modes: off / declare / facilitator.
import { config, activeAsset } from '../config.js';

const X402_VERSION = 1;
const TRUST_UNVERIFIED = process.env.X402_TRUST_UNVERIFIED === '1';
const NETWORK = process.env.X402_NETWORK || config.x402.network;

// Human decimal string -> atomic base units.
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
    extra: {
      name: asset.eip712Name,
      version: asset.eip712Version,
      assetSymbol: asset.symbol,
      chainId: config.x402.chainId,
      humanAmount: priceUsdt,
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

// Standard x402 facilitator: POST /verify then /settle. Fetches carry AbortSignal timeouts.
export async function settleViaFacilitator({ paymentB64, payload }) {
  const base = config.x402.facilitatorUrl.replace(/\/$/, '');
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentB64, 'base64').toString('utf8'));
  } catch {
    paymentPayload = { raw: paymentB64 };
  }
  const requirements = payload.accepts[0];
  const headers = { 'content-type': 'application/json' };
  try {
    const vr = await fetch(`${base}/verify`, {
      method: 'POST', headers,
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(8000),
    });
    const vj = await vr.json().catch(() => ({}));
    if (!vr.ok || vj.isValid === false) return { ok: false, reason: vj.invalidReason || vj.reason || `verify failed (${vr.status})` };

    const sr = await fetch(`${base}/settle`, {
      method: 'POST', headers,
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(12000),
    });
    const sj = await sr.json().catch(() => ({}));
    if (!sr.ok || sj.success === false) return { ok: false, reason: sj.errorReason || sj.reason || `settle failed (${sr.status})` };
    return { ok: true, settlement: sj };
  } catch (e) {
    return { ok: false, reason: `facilitator error: ${e.message}` };
  }
}

// Express middleware: gate one route with an x402 price.
export function x402Gate({ priceUsdt, description }) {
  return async function gate(req, res, next) {
    const mode = x402Mode();
    if (mode === 'off') return next();

    const resource = `${config.server.publicUrl.replace(/\/$/, '')}${req.baseUrl || ''}${req.path}`;
    const payload = buildPaymentRequired({ resource, priceUsdt, description });

    // Accept PAYMENT-SIGNATURE (v2), X-PAYMENT (v1), or Authorization: Payment (charge).
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

    // declare mode: no facilitator; refuse unverifiable payment unless demo-only trust flag is set.
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
  };
}

export default { x402Gate, buildPaymentRequired, paymentInfo, x402Mode, toBaseUnits, settleViaFacilitator };
