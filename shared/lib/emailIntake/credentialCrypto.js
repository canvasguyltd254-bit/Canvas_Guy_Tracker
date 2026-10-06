/**
 * shared/lib/emailIntake/credentialCrypto.js
 *
 * AES-256-GCM encryption for mailbox passwords stored in
 * email_mailbox_settings. The key lives in EMAIL_CREDENTIALS_KEY (base64 of
 * exactly 32 bytes) — never in the database. Format: v1:<iv>:<tag>:<data>,
 * each base64. A fresh random 12-byte IV is used for every encryption.
 *
 * Generate a key:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Losing or rotating the key makes stored passwords undecryptable; the app
 * reports that explicitly and the admin simply re-enters them.
 */

import crypto from 'node:crypto';

function loadKey(env = process.env) {
  const raw = env.EMAIL_CREDENTIALS_KEY;
  if (!raw) throw new Error('KEY_MISSING');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('KEY_INVALID');
  return key;
}

export function isEncryptionConfigured(env = process.env) {
  try { loadKey(env); return true; } catch { return false; }
}

export function encryptSecret(plaintext, env = process.env) {
  if (typeof plaintext !== 'string' || plaintext === '') throw new Error('EMPTY_SECRET');
  const key = loadKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(payload, env = process.env) {
  const key = loadKey(env);
  const parts = String(payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('BAD_FORMAT');
  const [, iv, tag, data] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64')));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Throws if the key is wrong or the ciphertext was altered (GCM auth).
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
