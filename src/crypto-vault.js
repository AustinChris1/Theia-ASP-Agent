// AES-256-GCM vault for secrets at rest — specifically users' Bybit API keys.
//
// The 32-byte encryption key is derived (scrypt) from the KEY_ENCRYPTION_SECRET
// env var, so the ciphertext on disk is useless without that secret. GCM gives
// authenticated encryption: decrypt() throws if the blob was tampered with or
// the secret is wrong. Ciphertext is encoded as "ivB64.tagB64.ctB64".
//
// If KEY_ENCRYPTION_SECRET is unset (or too short), vaultAvailable() is false
// and the per-user-keys feature stays DISABLED — we never store secrets in
// plaintext as a fallback.

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const MIN_SECRET_LEN = 16;

export function vaultAvailable() {
  const s = process.env.KEY_ENCRYPTION_SECRET;
  return typeof s === 'string' && s.length >= MIN_SECRET_LEN;
}

let _key = null;
function key() {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(`KEY_ENCRYPTION_SECRET missing or too short (need ≥${MIN_SECRET_LEN} chars)`);
  }
  // Cache the derived key, but re-derive if the secret changes (tests). A fixed
  // salt is acceptable: the secret is high-entropy operator config, and scrypt
  // still stretches it; a per-value salt would have to be stored alongside.
  if (!_key || _key.secret !== secret) {
    _key = { secret, buf: crypto.scryptSync(secret, 'tradeAlertBot:keyvault:v1', 32) };
  }
  return _key.buf;
}

// Encrypt a UTF-8 string → "ivB64.tagB64.ctB64". Throws if the vault is unset.
export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

// Decrypt "ivB64.tagB64.ctB64" → UTF-8 string. Throws on tamper / wrong secret.
export function decryptSecret(blob) {
  const parts = String(blob).split('.');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

// Mask a secret for display/logging — never show more than the first/last few.
export function maskSecret(s) {
  const str = String(s ?? '');
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}
