/**
 * Settle a website enquiry whose phone/email matched SEVERAL customers.
 *
 * GET  /api/crm/enquiries/:id/customer-match
 *        -> { data: [{ id, name, phone, email }] }  customers sharing the contact
 *
 * POST /api/crm/enquiries/:id/customer-match
 *        Body: { action: 'link', customer_id } | { action: 'keep_prospect' }
 *
 * The POST is ONE database function (resolve_web_enquiry_customer): it locks the
 * enquiry and its submission, checks the chosen customer really is one of the
 * candidates, links or keeps, and writes the audit row, all or nothing. If two
 * people decide at once the second gets 409 and the first decision stands.
 * Roles: admin, head_of_sales, sales.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DB_ERRORS = {
  ENQUIRY_NOT_FOUND: [404, 'Enquiry not found'],
  NOT_WEB_ENQUIRY: [404, 'This is not a website enquiry.'],
  ALREADY_RESOLVED: [409, 'Someone has already settled this match. Refresh to see the result.'],
  NOT_AMBIGUOUS: [409, 'This enquiry has no customer match to settle.'],
  CUSTOMER_NOT_CANDIDATE: [422, 'That customer does not match this enquiry\'s phone or email.'],
  CUSTOMER_REQUIRED: [400, 'Choose a customer to link.'],
  BAD_ACTION: [400, 'Unknown action.'],
  BAD_INPUT: [400, 'Invalid request.'],
};

async function authorise() {
  const { user, role } = await getAuthContext();
  if (!user) return { res: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const authErr = requireRole(user, role, ROLES_CRM);
  if (authErr) return { res: authErr };
  return { user };
}

export async function GET(_request, props) {
  try {
    const params = await props.params;
    const a = await authorise();
    if (a.res) return a.res;
    if (!UUID.test(params.id)) return NextResponse.json({ error: 'Enquiry not found' }, { status: 404 });

    const { data, error } = await serviceClient.rpc('web_enquiry_candidates', { p_enquiry_id: params.id });
    if (error) {
      console.error('GET customer-match:', error);
      return NextResponse.json({ error: 'Could not load matching customers.' }, { status: 500 });
    }
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('GET /api/crm/enquiries/[id]/customer-match:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, props) {
  try {
    const params = await props.params;
    const a = await authorise();
    if (a.res) return a.res;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const action = body?.action;
    if (action !== 'link' && action !== 'keep_prospect') {
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    }
    if (action === 'link' && !UUID.test(String(body.customer_id || ''))) {
      return NextResponse.json({ error: 'Choose a customer to link.' }, { status: 400 });
    }
    if (!UUID.test(params.id)) return NextResponse.json({ error: 'Enquiry not found' }, { status: 404 });

    const { data, error } = await serviceClient.rpc('resolve_web_enquiry_customer', {
      p_enquiry_id: params.id,
      p_action: action,
      p_customer_id: action === 'link' ? body.customer_id : null,
      p_user_id: a.user.id,
    });

    if (error) {
      const mapped = DB_ERRORS[String(error.message || '').trim()];
      if (mapped) return NextResponse.json({ error: mapped[1] }, { status: mapped[0] });
      console.error('POST customer-match:', error);
      return NextResponse.json({ error: 'Failed to save the decision.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/crm/enquiries/[id]/customer-match:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
