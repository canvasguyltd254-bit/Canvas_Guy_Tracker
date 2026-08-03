export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// GET /api/crm/enquiries?stage=new&source=referral&q=search
export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { searchParams } = new URL(request.url);
    const stage  = searchParams.get('stage');
    const source = searchParams.get('source');
    const q      = searchParams.get('q');

    let query = serviceClient
      .from('enquiries')
      .select(`
        *,
        customers(id, name, phone, email),
        followups(id, due_date, completed_at)
      `)
      .order('created_at', { ascending: false })
      .limit(200);

    if (stage)  query = query.eq('stage', stage);
    if (source) query = query.eq('source', source);
    if (q)      query = query.ilike('description', `%${q}%`);

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/crm/enquiries:', error);
      return NextResponse.json({ error: 'Failed to fetch enquiries' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET /api/crm/enquiries:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/crm/enquiries
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

    // Validate: must have customer_id or prospect_name
    if (!body.customer_id && !body.prospect_name?.trim()) {
      return NextResponse.json(
        { error: 'Must provide either customer_id or prospect_name' },
        { status: 422 },
      );
    }

    // Generate enq_num via RPC
    const { data: enqNum, error: numErr } = await serviceClient.rpc('next_enq_num');
    if (numErr) {
      console.error('next_enq_num failed:', numErr);
      return NextResponse.json({ error: 'Failed to generate enquiry number' }, { status: 500 });
    }

    const safe = pick({ ...body, created_by: user.id }, ALLOWED_FIELDS.enquiries.insert);

    const { data, error } = await serviceClient
      .from('enquiries')
      .insert({ ...safe, enq_num: enqNum, stage: safe.stage || 'new' })
      .select()
      .single();

    if (error) {
      console.error('POST /api/crm/enquiries:', error);
      return NextResponse.json({ error: 'Failed to create enquiry' }, { status: 500 });
    }

    // Activity log
    await serviceClient.from('quote_activities').insert({
      entity_type: 'enquiry',
      entity_id: data.id,
      activity_type: 'created',
      description: `Enquiry ${enqNum} created`,
      created_by: user.id,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/crm/enquiries:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
