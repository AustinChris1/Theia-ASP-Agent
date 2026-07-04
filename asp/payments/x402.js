// asp/payments/x402.js — the SELLER side of x402 (resource-server middleware).
//
// Emits a standard x402 V2 `402` challenge (the `PAYMENT-REQUIRED` header, base64
// JSON `{ x402Version, resource, accepts }`) declaring a fixed USDT price on X
// Layer, then, when the caller replays with a `PAYMENT-SIGNATURE`, verifies +
// settles via a configurable facilitator before serving the paid JSON.
//
// Why hand-rolled and not vanilla `x402-express`: the public `x402` package's
// Network enum targets Base / Avalanche / Polygon and does NOT include X Layer
// (chainId 196). OKX's own A2MCP endpoints settle on X Layer via OKX's facilitator
// (see NOTES-okx §3-4). This middleware follows the same x402 V2 wire format but
// keeps the network + facilitator fully configurable so it matches OKX exactly
// once the facilitator URL is confirmed with `onchainos agent x402-check`.
//
// Modes (auto-selected):
//   off         - x402 not enforced (X402_ENFORCE=0): routes serve free. Dev/demo.
//   facilitator - enforce + a facilitator URL is set: verify + settle for real.
//   declare     - enforce + no facilitator yet: emit a valid 402, but do NOT grant
//                 access on an unverifiable payment unless X402_TRUST_UNVERIFIED=1
//                 (loudly-labeled demo-only shortcut).
import { config, activeAsset } from '../config.js';

const X402_VERSION = 1;
const TRUST_UNVERIFIED = process.env.X402_TRUST_UNVERIFIED === '1';
const NETWORK = process.env.X402_NETWORK || config.x402.network; // e.g. eip155:196

/** Convert a human decimal string ("0.10") to atomic base units for `decimals`. */
export function toBaseUnits(decimalStr, decimals) {
  const s = String(decimalStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${decimalStr}`);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined || '0';
}

/** Effective mode given current config. */
export function x402Mode() {
  if (!config.x402.enforce) return 'off';
  if (config.x402.facilitatorUrl) return 'facilitator';
  return 'declare';
}

/**
 * Build the x402 V2 `accepts` entry + full PAYMENT-REQUIRED payload for a route.
 * @param {{resource:string, priceUsdt:string, description:string}} opts
 */
export function buildPaymentRequired({ resource, priceUsdt, description }) {
  const asset = activeAsset();
  const accepts = [{
    scheme: config.x402.scheme,               // 'exact'
    network: NETWORK,                          // CAIP-2, e.g. eip155:196 (X Layer)
    maxAmountRequired: toBaseUnits(priceUsdt, asset.decimals),
    resource,
    description,
    mimeType: 'application/json',
    payTo: config.x402.payTo,
    maxTimeoutSeconds: 120,
    asset: asset.address,
    // EIP-712 domain for EIP-3009 (exact scheme). OKX display extras alongside.
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

/** Base64-encode the payment-required JSON for the PAYMENT-REQUIRED header. */
function encodeRequired(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** Send a well-formed 402 challenge (header + body) and end the response. */
function send402(res, payload, extra = {}) {
  res.status(402);
  res.set('PAYMENT-REQUIRED', encodeRequired(payload));
  res.json({ x402Version: X402_VERSION, error: 'payment_required', ...extra, accepts: payload.accepts, resource: payload.resource });
}

/**
 * Verify + settle a submitted payment via the configured facilitator (standard
 * x402 facilitator API: POST /verify then POST /settle). Every fetch carries an
 * AbortSignal timeout per the repo convention.
 * @returns {Promise<{ok:boolean, reason?:string, settlement?:object}>}
 */
export async function settleViaFacilitator({ paymentB64, payload }) {
  const base = config.x402.facilitatorUrl.replace(/\/$/, '');
  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentB64, 'base64').toString('utf8'));
  } catch {
    // Some callers send an opaque header value; forward it as-is under `raw`.
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

/**
 * Express middleware factory that gates a single route with an x402 price.
 * @param {{priceUsdt:string, description:string}} opts
 */
export function x402Gate({ priceUsdt, description }) {
  return async function gate(req, res, next) {
    const mode = x402Mode();
    if (mode === 'off') return next();

    const resource = `${config.server.publicUrl.replace(/\/$/, '')}${req.baseUrl || ''}${req.path}`;
    const payload = buildPaymentRequired({ resource, priceUsdt, description });

    // Standard x402 V2 replay header is PAYMENT-SIGNATURE; also accept X-PAYMENT
    // (legacy v1) and Authorization: Payment (WWW-Authenticate charge path).
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

    // declare mode: no facilitator configured.
    if (TRUST_UNVERIFIED) {
      res.set('X-Payment-Warning', 'accepted without verification (X402_TRUST_UNVERIFIED=1, demo only)');
      return next();
    }
    return send402(res, payload, { reason: 'facilitator_not_configured' });
  };
}

/** Public payment info for the service manifest. */
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
