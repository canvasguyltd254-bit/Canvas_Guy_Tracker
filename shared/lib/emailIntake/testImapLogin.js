/**
 * shared/lib/emailIntake/testImapLogin.js
 *
 * Opens an IMAP session, selects INBOX read-only and logs out. It does NOT
 * search, fetch or flag anything, so testing a login never marks mail as read.
 * Returns a sanitised outcome — never the password or raw server text.
 */

import { ImapFlow } from 'imapflow';

export async function testImapLogin({ host, port, secure, user, pass }) {
  const client = new ImapFlow({
    host, port, secure, auth: { user, pass }, logger: false,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  // Without a listener an async socket error would crash the process.
  client.on('error', () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    lock.release();
    return { ok: true };
  } catch (err) {
    if (err?.authenticationFailed) return { ok: false, reason: 'auth', message: 'The server rejected the username or password. For Gmail/Google Workspace use an app password.' };
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(err?.code)) return { ok: false, reason: 'host', message: 'The server name could not be found.' };
    if (['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(err?.code)) return { ok: false, reason: 'network', message: 'Could not reach the server on that port.' };
    return { ok: false, reason: 'other', message: 'Could not log in to the mailbox.' };
  } finally {
    try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } }
  }
}
