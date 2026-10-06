/**
 * app/api/email-intake/poll/route.js
 *
 * GET /api/email-intake/poll
 *
 * Polls the two brand mailboxes over IMAP and queues genuinely new
 * messages into inbound_emails. Nothing here creates an enquiry — this
 * route only fills the holding queue; a human converts or dismisses each
 * row via /api/email-intake/[id]/convert|dismiss.
 *
 * Auth: this endpoint is invoked by Vercel Cron, which carries no user
 * session, so it cannot use getAuthContext()/requireRole() like every
 * other route in this app. Instead it checks the Authorization header
 * Vercel automatically attaches when a CRON_SECRET env var is set:
 * `Authorization: Bearer <CRON_SECRET>`. A request without a matching
 * header is rejected — this route must never be reachable by an
 * unauthenticated caller, since it holds IMAP credentials in its call
 * graph and writes to the database.
 *
 * One mailbox failing (bad credentials, network issue, not yet
 * configured) never blocks the other — each mailbox is polled inside
 * its own try/catch and reported independently in the response.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { serviceClient } from '@/shared/lib/api-auth';
import { fetchNewMessages } from '@/shared/lib/emailIntake/fetchNewMessages';
import { loadMailboxes } from '@/shared/lib/emailIntake/mailboxConfig';
import { isLikelyAutomatedMessage, normalizeInboundMessage } from '@/shared/lib/emailIntake/parseInboundMessage';

async function pollOneMailbox(config) {
  const result = {
    brand: config.brand,
    mailbox: config.user || null,
    configured: config.configured,
    fetched: 0,
    queued: 0,
    duplicates: 0,
    skipped_automated: 0,
    skipped_no_message_id: 0,
    errors: [],
  };

  if (!result.configured) {
    result.errors.push(config.error || 'mailbox not configured — no stored login and missing host/user/pass env vars');
    return result;
  }

  let messages;
  try {
    messages = await fetchNewMessages({
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
    });
  } catch (err) {
    result.errors.push(`IMAP fetch failed: ${err.message}`);
    return result;
  }

  result.fetched = messages.length;

  for (const { parsed } of messages) {
    if (isLikelyAutomatedMessage(parsed)) {
      result.skipped_automated += 1;
      continue;
    }

    const row = normalizeInboundMessage({ brand: config.brand, mailbox: config.user, parsed });
    if (!row) {
      result.skipped_no_message_id += 1;
      continue;
    }

    const { error } = await serviceClient.from('inbound_emails').insert(row);
    if (error) {
      if (error.code === '23505') {
        // Already queued from a previous poll — expected and harmless.
        result.duplicates += 1;
      } else {
        result.errors.push(`insert failed for message ${row.message_id}: ${error.message}`);
      }
      continue;
    }
    result.queued += 1;
  }

  return result;
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('GET /api/email-intake/poll: CRON_SECRET is not configured — refusing to run');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const configs = await loadMailboxes(serviceClient);
    const results = [];
    for (const config of configs) {
      // Sequential, not Promise.all: two IMAP connections opening at once
      // from one serverless invocation is unnecessary contention for a
      // two-mailbox, low-volume job, and sequential makes the per-mailbox
      // error isolation easier to reason about in logs.
      results.push(await pollOneMailbox(config));
    }

    return NextResponse.json({ success: true, data: { mailboxes: results } });
  } catch (err) {
    console.error('GET /api/email-intake/poll:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
