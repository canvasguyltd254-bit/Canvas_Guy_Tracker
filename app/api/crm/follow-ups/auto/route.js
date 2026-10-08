/**
 * GET /api/crm/follow-ups/auto
 *
 * Daily job (Vercel Cron). Creates ONE follow-up task per sent quote that has
 * gone quiet (rule: shared/lib/quoteFollowUp.js), so it also appears in the
 * Follow-ups tab. Safe to run repeatedly: a quote that already has an open
 * system-made task is skipped, and the database allows only one open per quote.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` and carries no user
 * session, same as /api/email-intake/poll. Without a matching secret the route
 * refuses to run.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { serviceClient } from '@/shared/lib/api-auth';
import { needsAutoTask, autoTaskNote } from '@/shared/lib/quoteFollowUp';
import { nairobiToday } from '@/shared/lib/reports/dateBounds';

const BATCH_CAP = 200;

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('GET /api/crm/follow-ups/auto: CRON_SECRET is not configured — refusing to run');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = nairobiToday();

    const { data: quotes, error } = await serviceClient
      .from('quotations')
      .select('id, quote_num, status, sent_at, last_contact_at, follow_up_snoozed_until, converted_order_id, suspended_at, updated_at, created_at')
      .eq('status', 'sent')
      .is('suspended_at', null)
      .is('converted_order_id', null)
      .limit(1000);
    if (error) {
      console.error('follow-ups/auto: load quotes:', error.message);
      return NextResponse.json({ error: 'Failed to load quotations (has quote_followup_nudges.sql been applied?)' }, { status: 500 });
    }

    const ids = (quotes || []).map(q => q.id);
    const open = new Set();
    if (ids.length) {
      const { data: tasks, error: tErr } = await serviceClient
        .from('followups')
        .select('quotation_id')
        .in('quotation_id', ids)
        .eq('auto_source', 'quote_nudge')
        .is('completed_at', null);
      if (tErr) {
        console.error('follow-ups/auto: load open tasks:', tErr.message);
        return NextResponse.json({ error: 'Failed to load follow-ups' }, { status: 500 });
      }
      (tasks || []).forEach(t => open.add(t.quotation_id));
    }

    const todo = (quotes || []).filter(q => needsAutoTask(q, today, open.has(q.id))).slice(0, BATCH_CAP);
    let created = 0, duplicates = 0;
    for (const q of todo) {
      const { error: insErr } = await serviceClient.from('followups').insert({
        quotation_id: q.id,
        due_date: today,
        note: autoTaskNote(q, today),
        auto_source: 'quote_nudge',
      });
      if (!insErr) { created += 1; continue; }
      if (insErr.code === '23505') { duplicates += 1; continue; }   // another run got there first
      console.error('follow-ups/auto: insert failed for', q.quote_num, insErr.message);
    }

    return NextResponse.json({ success: true, checked: (quotes || []).length, created, duplicates });
  } catch (err) {
    console.error('GET /api/crm/follow-ups/auto:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
