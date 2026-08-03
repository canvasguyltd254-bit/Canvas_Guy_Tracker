export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// GET /api/crm/followups?pending=true&due_before=2026-08-01
export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { searchParams } = new URL(request.url);
    const pending   = searchParams.get('pending') === 'true';
    const dueBefore = searchParams.get('due_before');

    let query = serviceClient
      .from('followups')
      .select(`
        *,
        enquiries(id, enq_num, stage, prospect_name, customers(id, name)),
        quotations(id, quote_num, status, total, customers(id, name))
      `)
      .order('due_date', { ascending: true })
      .limit(300);

    if (pending)   query = query.is('completed_at', null);
    if (dueBefore) query = query.lte('due_date', dueBefore);

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/crm/followups:', error);
      return NextResponse.json({ error: 'Failed to fetch follow-ups' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET /api/crm/followups:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/crm/followups
export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Exactly one parent required
    const hasEnquiry   = !!body.enquiry_id;
    const hasQuotation = !!body.quotation_id;
    if (hasEnquiry === hasQuotation) {
      return NextResponse.json(
        { error: 'Must provide exactly one of enquiry_id or quotation_id' },
        { status: 422 },
      );
    }

    if (!body.due_date) {
      return NextResponse.json({ error: 'due_date is required' }, { status: 422 });
    }

    const safe = pick({ ...body, created_by: user.id }, ALLOWED_FIELDS.followups.insert);

    const { data, error } = await serviceClient
      .from('followups')
      .insert(safe)
      .select()
      .single();

    if (error) {
      console.error('POST /api/crm/followups:', error);
      return NextResponse.json({ error: 'Failed to create follow-up' }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/crm/followups:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
