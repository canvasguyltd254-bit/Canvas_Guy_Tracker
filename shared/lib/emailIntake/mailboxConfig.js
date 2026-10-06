/**
 * shared/lib/emailIntake/mailboxConfig.js
 *
 * Resolves the IMAP login for each brand. Precedence per brand:
 *   1. a row in email_mailbox_settings (entered by an admin in the CRM screen)
 *   2. EMAIL_<BRAND>_HOST / _USER / _PASS environment variables
 * A stored row that cannot be decrypted is reported as an error and does NOT
 * silently fall back to the environment — that would hide a broken setup.
 */

import { decryptSecret } from './credentialCrypto.js';

export const MAILBOXES = [
  { brand: 'canvas_guy',      label: 'Canvas Guy',      prefix: 'EMAIL_CANVAS_GUY' },
  { brand: 'seating_company', label: 'Seating Company', prefix: 'EMAIL_SEATING_COMPANY' },
];

function fromEnv({ prefix }, env) {
  return {
    host: env[`${prefix}_HOST`],
    port: Number(env[`${prefix}_PORT`] || 993),
    secure: env[`${prefix}_SECURE`] !== 'false',
    user: env[`${prefix}_USER`],
    pass: env[`${prefix}_PASS`],
  };
}

/**
 * @param {Record<string, object>} rowsByBrand  email_mailbox_settings rows keyed by brand
 * @returns one resolved entry per brand:
 *   { brand, label, source: 'database'|'environment'|null, configured, missing[],
 *     error: string|null, host, port, secure, user, pass }
 */
export function resolveMailboxes(rowsByBrand = {}, env = process.env, decrypt = decryptSecret) {
  return MAILBOXES.map((mb) => {
    const row = rowsByBrand[mb.brand];
    if (row) {
      let pass = null;
      let error = null;
      try {
        pass = decrypt(row.password_encrypted, env);
      } catch (e) {
        error = e.message === 'KEY_MISSING' || e.message === 'KEY_INVALID'
          ? 'Stored password cannot be read: EMAIL_CREDENTIALS_KEY is missing or invalid.'
          : 'Stored password could not be decrypted (key changed?). Re-enter it.';
      }
      return {
        brand: mb.brand, label: mb.label, source: 'database',
        configured: !error, missing: [], error,
        host: row.host, port: row.port, secure: row.secure, user: row.username, pass,
      };
    }
    const e = fromEnv(mb, env);
    const missing = ['HOST', 'USER', 'PASS'].filter((k) => !env[`${mb.prefix}_${k}`]).map((k) => `${mb.prefix}_${k}`);
    const configured = missing.length === 0;
    return {
      brand: mb.brand, label: mb.label, source: configured ? 'environment' : null,
      configured, missing, error: null, ...e,
    };
  });
}

/** Loads stored rows (service client) and resolves them. */
export async function loadMailboxes(db, env = process.env) {
  const { data, error } = await db
    .from('email_mailbox_settings')
    .select('brand, host, port, secure, username, password_encrypted');
  // Table not created yet (migration not applied) → behave as "no stored rows".
  const rows = {};
  if (!error) for (const r of (data || [])) rows[r.brand] = r;
  return resolveMailboxes(rows, env);
}

/** Names/flags only — safe to send to an authenticated browser. */
export function toPublicStatus(resolved) {
  return resolved.map((m) => ({
    brand: m.brand,
    label: m.label,
    configured: m.configured,
    source: m.source,
    missing: m.missing,
    error: m.error,
    mailbox: m.user || null,
    host: m.host || null,
    port: m.port ?? null,
    secure: m.secure ?? true,
  }));
}

export function isCronSecretConfigured(env = process.env) {
  return !!env.CRON_SECRET;
}
