/**
 * POST /api/crm/quotations/:id/follow-up
 *
 * Body: { action: 'contact', method: 'call'|'whatsapp'|'email'|'visit'|'other', note?: string }
 *       { action: 'snooze', days?: number }   (default 3, max 14)
 *
 * 'contact' records that someone reached out to the client: it restarts the
 * follow-up clock (last_contact_at), writes a history entry, clears any snooze
 * and closes the system-made "chase this quote" task. The app cannot see calls or
 * WhatsApp, so this is the only way the nudge learns a client was contacted.
 * 'snooze' hides the nudge for N days and closes the system-made task (the daily
 * job makes a fresh one when the snooze ends and the quote is still due).
 *
 * Everything happens inside ONE database function (record_quote_followup_action):
 * it locks and validates the quote, so either all of it is saved or none of it.
 * Only open (sent, unconverted, unsuspended) quotes can be chased.
 * Roles: admin, head_of_sales, sales.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { CONTACT_METHODS, SNOOZE_DAYS } from '@/shared/lib/quoteFollowUp';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// Codes raised by the database function → HTTP responses.
const DB_ERRORS = {
  QUOTE_NOT_FOUND: [404, 'Quotation not found'],
  QUOTE_NOT_CHASEABLE: [422, 'Only an open sent quotation can be followed up.'],
  BAD_METHOD: [400, 'Choose how you contacted the client.'],
  BAD_ACTION: [400, 'Unknown action.'],
};

export async function POST(request, props) {
  try {
    const params = await props.params;
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const action = body?.action;
    if (action !== 'contact' && action !== 'snooze') {
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }

    const method = String(body.method || '').toLowerCase();
    if (action === 'contact' && !CONTACT_METHODS.includes(method)) {
      return NextResponse.json({ error: 'Choose how you contacted the client.' }, { status: 400 });
    }

    const { data, error } = await serviceClient.rpc('record_quote_followup_action', {
      p_quotation_id: params.id,
      p_action: action,
      p_method: action === 'contact' ? method : null,
      p_note: action === 'contact' ? String(body.note || '') : null,
      p_days: action === 'snooze' ? (parseInt(body.days, 10) || SNOOZE_DAYS) : null,
      p_user_id: user.id,
    });

    if (error) {
      const mapped = DB_ERRORS[String(error.message || '').trim()];
      if (mapped) return NextResponse.json({ error: mapped[1] }, { status: mapped[0] });
      console.error(`POST follow-up ${action}:`, error);
      return NextResponse.json({ error: 'Failed to save the follow-up.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/crm/quotations/[id]/follow-up:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
