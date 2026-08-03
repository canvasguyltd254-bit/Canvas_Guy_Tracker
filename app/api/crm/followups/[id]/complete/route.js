export const runtime = 'nodejs';

/**
 * POST /api/crm/followups/[id]/complete
 * Marks a follow-up as completed. Optionally schedules the next one.
 * Body: { next_due_date?, next_note? }
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    let body = {};
    try { body = await request.json() ?? {}; } catch { /* empty body is fine */ }

    // Fetch the follow-up to get parent IDs
    const { data: followup, error: fetchErr } = await serviceClient
      .from('followups')
      .select('id, enquiry_id, quotation_id, completed_at')
      .eq('id', params.id)
      .single();

    if (fetchErr || !followup) return NextResponse.json({ error: 'Follow-up not found' }, { status: 404 });
    if (followup.completed_at) return NextResponse.json({ error: 'Follow-up already completed' }, { status: 422 });

    const { error: updateErr } = await serviceClient
      .from('followups')
      .update({ completed_at: new Date().toISOString(), completed_by: user.id })
      .eq('id', params.id);

    if (updateErr) {
      console.error('complete followup update:', updateErr);
      return NextResponse.json({ error: 'Failed to complete follow-up' }, { status: 500 });
    }

    let nextFollowup = null;

    // Create next follow-up if requested
    if (body.next_due_date) {
      const nextSafe = pick({
        enquiry_id:   followup.enquiry_id,
        quotation_id: followup.quotation_id,
        due_date:     body.next_due_date,
        note:         body.next_note || '',
        created_by:   user.id,
      }, ALLOWED_FIELDS.followups.insert);

      const { data: nf } = await serviceClient
        .from('followups')
        .insert(nextSafe)
        .select()
        .single();

      nextFollowup = nf;
    }

    return NextResponse.json({ data: { completed: true, next_followup: nextFollowup } });
  } catch (err) {
    console.error('POST /api/crm/followups/[id]/complete:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
