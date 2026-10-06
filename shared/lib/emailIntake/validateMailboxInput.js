/**
 * shared/lib/emailIntake/validateMailboxInput.js
 *
 * Pure validation for the admin "mailbox login" form. The host is used by the
 * server to open a network connection, so it must not be pointable at the
 * server's own machine or private network (basic SSRF guard — it checks the
 * literal host text, not DNS results, so it reduces rather than eliminates
 * the risk; the route is admin-only for the same reason).
 */

import { MAILBOXES } from './mailboxConfig.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isBlockedHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // Literal IPv4 / IPv6 hosts are refused outright; real mail hosts are names.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[')) return true;
  return false;
}

/** @returns {{ ok: true, value: object } | { ok: false, error: string }} */
export function validateMailboxInput(body) {
  const brand = body?.brand;
  if (!MAILBOXES.some((m) => m.brand === brand)) return { ok: false, error: 'Unknown mailbox brand' };

  const host = String(body?.host || '').trim();
  if (!HOST_RE.test(host) || isBlockedHost(host)) {
    return { ok: false, error: 'Enter the IMAP server name, e.g. imap.gmail.com (no IP addresses or local names)' };
  }

  const port = Number(body?.port ?? 993);
  if (![993, 143].includes(port)) return { ok: false, error: 'Port must be 993 (SSL) or 143' };

  const username = String(body?.username || '').trim();
  if (!username || username.length > 254) return { ok: false, error: 'Username is required' };
  if (username.includes('@') && !EMAIL_RE.test(username)) return { ok: false, error: 'Username is not a valid email address' };

  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length > 512) return { ok: false, error: 'Password is too long' };

  return {
    ok: true,
    value: { brand, host, port, secure: port === 993, username, password },
  };
}
