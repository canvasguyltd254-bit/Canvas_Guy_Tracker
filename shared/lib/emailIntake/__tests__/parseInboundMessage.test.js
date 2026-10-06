/**
 * shared/lib/emailIntake/__tests__/parseInboundMessage.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLikelyAutomatedMessage,
  normalizeInboundMessage,
  resolveBrandForMailbox,
} from '../parseInboundMessage.js';

describe('isLikelyAutomatedMessage', () => {
  test('flags Auto-Submitted headers other than "no"', () => {
    const parsed = { headers: new Map([['auto-submitted', 'auto-replied']]), from: { value: [{ address: 'jane@client.com' }] } };
    assert.equal(isLikelyAutomatedMessage(parsed), true);
  });

  test('does not flag an explicit Auto-Submitted: no', () => {
    const parsed = { headers: new Map([['auto-submitted', 'no']]), from: { value: [{ address: 'jane@client.com' }] } };
    assert.equal(isLikelyAutomatedMessage(parsed), false);
  });

  test('flags bulk/list/auto_reply Precedence headers', () => {
    const parsed = { headers: new Map([['precedence', 'bulk']]), from: { value: [{ address: 'jane@client.com' }] } };
    assert.equal(isLikelyAutomatedMessage(parsed), true);
  });

  test('flags known automated local-parts (mailer-daemon, postmaster, no-reply, etc.)', () => {
    for (const local of ['mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'bounce']) {
      const parsed = { from: { value: [{ address: `${local}@somehost.com` }] } };
      assert.equal(isLikelyAutomatedMessage(parsed), true, `expected ${local}@ to be flagged`);
    }
  });

  test('does not flag a genuine sender with no automated signals', () => {
    const parsed = { from: { value: [{ address: 'jane@client.com' }] }, headers: new Map() };
    assert.equal(isLikelyAutomatedMessage(parsed), false);
  });

  test('accepts a plain-object headers shape as well as a Map', () => {
    const parsed = { headers: { 'auto-submitted': 'auto-generated' }, from: { value: [{ address: 'jane@client.com' }] } };
    assert.equal(isLikelyAutomatedMessage(parsed), true);
  });

  test('handles a missing parsed object or missing from gracefully', () => {
    assert.equal(isLikelyAutomatedMessage(null), false);
    assert.equal(isLikelyAutomatedMessage({}), false);
  });
});

describe('normalizeInboundMessage', () => {
  const baseParsed = {
    messageId: '<abc123@mail.canvasguy.co.ke>',
    from: { value: [{ address: 'jane@client.com', name: 'Jane Doe' }] },
    subject: '  Enquiry about a dining table  ',
    text: 'Hi, I would like a quote for a 6-seater dining table.',
    html: '<p>Hi, I would like a quote for a 6-seater dining table.</p>',
    date: new Date('2026-09-20T10:15:00Z'),
  };

  test('shapes a complete message into the inbound_emails row contract', () => {
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed: baseParsed });
    assert.deepEqual(row, {
      brand: 'canvas_guy',
      mailbox: 'info@canvasguy.co.ke',
      message_id: 'abc123@mail.canvasguy.co.ke',
      from_address: 'jane@client.com',
      from_name: 'Jane Doe',
      subject: 'Enquiry about a dining table',
      body_text: 'Hi, I would like a quote for a 6-seater dining table.',
      received_at: '2026-09-20T10:15:00.000Z',
    });
  });

  test('falls back to a stripped HTML body when there is no text part', () => {
    const parsed = { ...baseParsed, text: undefined, html: '<p>Hello <b>there</b></p><style>.x{color:red}</style>' };
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed });
    assert.equal(row.body_text, 'Hello there');
  });

  test('defaults a missing subject to a placeholder rather than null', () => {
    const parsed = { ...baseParsed, subject: undefined };
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed });
    assert.equal(row.subject, '(no subject)');
  });

  test('returns null when the message has no usable Message-ID', () => {
    const parsed = { ...baseParsed, messageId: undefined };
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed });
    assert.equal(row, null);
  });

  test('returns null when brand or mailbox is missing', () => {
    assert.equal(normalizeInboundMessage({ brand: null, mailbox: 'info@canvasguy.co.ke', parsed: baseParsed }), null);
    assert.equal(normalizeInboundMessage({ brand: 'canvas_guy', mailbox: null, parsed: baseParsed }), null);
  });

  test('returns null when parsed is missing entirely', () => {
    assert.equal(normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed: null }), null);
  });

  test('leaves body_text null when neither text nor html is present', () => {
    const parsed = { ...baseParsed, text: undefined, html: undefined };
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed });
    assert.equal(row.body_text, null);
  });

  test('leaves received_at null when date is missing or not a Date', () => {
    const parsed = { ...baseParsed, date: undefined };
    const row = normalizeInboundMessage({ brand: 'canvas_guy', mailbox: 'info@canvasguy.co.ke', parsed });
    assert.equal(row.received_at, null);
  });
});

describe('resolveBrandForMailbox', () => {
  const map = {
    'info@canvasguy.co.ke': 'canvas_guy',
    'info@theseatingcompany.co.ke': 'seating_company',
  };

  test('resolves a configured mailbox to its brand', () => {
    assert.equal(resolveBrandForMailbox('info@canvasguy.co.ke', map), 'canvas_guy');
    assert.equal(resolveBrandForMailbox('info@theseatingcompany.co.ke', map), 'seating_company');
  });

  test('is case-insensitive and trims whitespace', () => {
    assert.equal(resolveBrandForMailbox('  INFO@CanvasGuy.co.ke  ', map), 'canvas_guy');
  });

  test('returns null for an unconfigured mailbox rather than guessing', () => {
    assert.equal(resolveBrandForMailbox('unknown@somewhere.com', map), null);
  });

  test('returns null when mailboxAddress or the map is missing', () => {
    assert.equal(resolveBrandForMailbox(null, map), null);
    assert.equal(resolveBrandForMailbox('info@canvasguy.co.ke', null), null);
  });
});
