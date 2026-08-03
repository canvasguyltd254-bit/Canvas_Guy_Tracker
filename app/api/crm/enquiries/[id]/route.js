export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// PATCH /api/crm/enquiries/[id]  — update stage or other editable fields
export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const safe = pick(body, ALLOWED_FIELDS.enquiries.update);
    if (Object.keys(safe).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 422 });
    }

    const { data, error } = await serviceClient
      .from('enquiries')
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/crm/enquiries/[id]:', error);
      return NextResponse.json({ error: 'Failed to update enquiry' }, { status: 500 });
    }

    // Activity log
    if (safe.stage) {
      await serviceClient.from('quote_activities').insert({
        entity_type: 'enquiry',
        entity_id:   params.id,
        activity_type: 'stage_change',
        description: `Stage changed to "${safe.stage}"`,
        created_by: user.id,
      });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('PATCH /api/crm/enquiries/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
