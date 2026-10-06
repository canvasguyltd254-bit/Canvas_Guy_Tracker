/**
 * shared/lib/emailIntake/fetchNewMessages.js
 *
 * The one I/O seam for email intake — connects to a single IMAP mailbox,
 * fetches unseen messages, and parses them. Mirrors
 * shared/lib/cashflow/buildSnapshot.js's role: all the actual network/parse
 * work lives here, untested directly (it needs a live mailbox); everything
 * that can be pure logic (parseInboundMessage.js) is split out and tested
 * there instead.
 *
 * Idempotency note: this flags fetched messages \Seen after a successful
 * fetch so a later poll doesn't re-download them, but that is only an
 * optimization. The real de-dup guard is the (mailbox, message_id) unique
 * index on inbound_emails — if flagging \Seen fails, or two polls race,
 * the database still refuses the duplicate row.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * @param {object} config
 * @param {string} config.host
 * @param {number} config.port
 * @param {boolean} [config.secure]
 * @param {string} config.user
 * @param {string} config.pass
 * @param {string} [config.folder] - defaults to INBOX
 * @returns {Promise<Array<{ uid: number, parsed: object }>>}
 *   `parsed` is mailparser's simpleParser() output — the exact shape
 *   normalizeInboundMessage() in parseInboundMessage.js expects.
 */
export async function fetchNewMessages({ host, port, secure = true, user, pass, folder = 'INBOX' }) {
  if (!host || !port || !user || !pass) {
    throw new Error('fetchNewMessages: host, port, user and pass are all required');
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
  });

  const messages = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search({ seen: false }, { uid: true });

      if (uids && uids.length > 0) {
        for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            messages.push({ uid: msg.uid, parsed });
          } catch (parseErr) {
            // One malformed message should not take down the whole poll —
            // log context and keep going with the rest of this mailbox.
            console.error(`fetchNewMessages: failed to parse uid ${msg.uid} in ${user}:`, parseErr.message);
          }
        }

        // Best-effort: mark fetched messages \Seen so the next poll doesn't
        // re-download them. Never throws — the DB unique index is the real
        // guard against duplicates (see module comment above).
        try {
          await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
        } catch (flagErr) {
          console.error(`fetchNewMessages: failed to flag messages \\Seen in ${user}:`, flagErr.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  return messages;
}
