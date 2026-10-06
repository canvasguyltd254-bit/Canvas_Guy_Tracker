/**
 * shared/lib/emailIntake/parseInboundMessage.js
 *
 * Pure, zero-I/O helpers for the email intake holding queue. Nothing here
 * touches IMAP or Supabase — that's fetchNewMessages.js (the I/O seam) and
 * the API routes. This file only shapes and classifies already-parsed
 * messages, so it can be fully unit tested without a live mailbox.
 *
 * Input contract: a "parsed" object shaped like what mailparser's
 * simpleParser() returns (or a plain object with the same fields, e.g. in
 * tests) — { messageId, from, subject, text, html, date, headers }.
 * `from` is mailparser's AddressObject: { value: [{ address, name }], text }.
 * `headers` is a Map (or a plain object with lowercase keys, both supported
 * here) of lowercase header name -> value.
 */

const AUTOMATED_LOCAL_PARTS = [
  'mailer-daemon',
  'postmaster',
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'bounce',
  'bounces',
];

/**
 * Reads a header value regardless of whether `headers` is a Map (mailparser's
 * real shape) or a plain object (convenient in tests).
 */
function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
}

/**
 * True when a message looks automated (bounce, auto-reply, mailing-list
 * notice) rather than a genuine enquiry. Used to skip queueing junk before
 * it ever reaches a human — never used to auto-convert anything.
 */
export function isLikelyAutomatedMessage(parsed) {
  if (!parsed) return false;

  const autoSubmitted = readHeader(parsed.headers, 'auto-submitted');
  if (typeof autoSubmitted === 'string' && autoSubmitted.toLowerCase() !== 'no') {
    return true;
  }

  const precedence = readHeader(parsed.headers, 'precedence');
  if (typeof precedence === 'string' && ['bulk', 'auto_reply', 'list'].includes(precedence.toLowerCase())) {
    return true;
  }

  const address = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const localPart = address.split('@')[0];
  if (localPart && AUTOMATED_LOCAL_PARTS.includes(localPart)) {
    return true;
  }

  return false;
}

/**
 * Best-effort plain-text body. Prefers the real text part; only strips tags
 * from HTML as a last resort, and never tries to be a real HTML-to-text
 * converter (that's not this module's job, and a rough version is safer
 * than a silently-wrong "clean" one).
 */
function extractBodyText(parsed) {
  if (typeof parsed?.text === 'string' && parsed.text.trim() !== '') {
    return parsed.text.trim();
  }
  if (typeof parsed?.html === 'string' && parsed.html.trim() !== '') {
    return parsed.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return null;
}

/**
 * Strips the wrapping <...> mailparser/RFC 5322 Message-IDs normally carry,
 * so the same message always produces the same dedup key regardless of
 * which library or mail server formatted it.
 */
function normalizeMessageId(rawMessageId) {
  if (!rawMessageId) return null;
  return String(rawMessageId).trim().replace(/^<|>$/g, '');
}

/**
 * Shapes a mailparser-style parsed message plus its known context (which
 * mailbox it came from, which brand that mailbox maps to) into the exact
 * row shape inbound_emails expects. Returns null when the message has no
 * usable Message-ID — without one, de-duplication on repeated polls is
 * impossible, so the row is skipped rather than risking duplicates.
 */
export function normalizeInboundMessage({ brand, mailbox, parsed }) {
  if (!brand || !mailbox || !parsed) return null;

  const messageId = normalizeMessageId(parsed.messageId);
  if (!messageId) return null;

  const fromEntry = parsed.from?.value?.[0] || null;

  return {
    brand,
    mailbox,
    message_id: messageId,
    from_address: fromEntry?.address || null,
    from_name: fromEntry?.name || null,
    subject: parsed.subject?.trim() || '(no subject)',
    body_text: extractBodyText(parsed),
    received_at: parsed.date instanceof Date ? parsed.date.toISOString() : null,
  };
}

/**
 * Maps a mailbox address to its brand using a plain lookup table (the
 * caller supplies this from env-var configuration — this function stays
 * pure so the mapping logic itself is testable without env vars).
 * Returns null for an unrecognized mailbox rather than guessing, so a
 * misconfigured mailbox surfaces as "no messages ever queued" — loud by
 * absence — instead of silently mislabeling every message with a brand.
 */
export function resolveBrandForMailbox(mailboxAddress, mailboxBrandMap) {
  if (!mailboxAddress || !mailboxBrandMap) return null;
  const key = mailboxAddress.trim().toLowerCase();
  for (const [configuredMailbox, brand] of Object.entries(mailboxBrandMap)) {
    if (configuredMailbox.trim().toLowerCase() === key) return brand;
  }
  return null;
}
