/**
 * POST /api/crm/enquiries/:id/contact
 *
 * Body: { method: 'call'|'whatsapp'|'email'|'visit'|'other', note?: string }
 *
 * Records that a person has reached out to the customer for the first time.
 * This is the ONLY thing that stops an enquiry's first-reply clock, and the only
 * way an enquiry moves from New to Contacted. Everything (who, when, how, the stage
 * change and the history row) is saved by ONE database function, so it all
 * succeeds or none of it does. The automatic acknowledgement email does not count.
 *
 * If somebody else already logged first contact, answers 200 with
 * { already: true } and changes nothing.
 * Roles: admin, head_of_sales, sales.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { CONTACT_METHODS } from '@/shared/lib/webEnquiry';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

const DB_ERRORS = {
  ENQUIRY_NOT_FOUND: [404, 'Enquiry not found'],
  ENQUIRY_CLOSED: [422, 'This enquiry is already won or lost.'],
  BAD_METHOD: [400, 'Choose how you contacted the customer.'],
  BAD_INPUT: [400, 'Invalid request.'],
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

    const method = String(body?.method || '').toLowerCase();
    if (!CONTACT_METHODS.includes(method)) {
      return NextResponse.json({ error: 'Choose how you contacted the customer.' }, { status: 400 });
    }

    const { data, error } = await serviceClient.rpc('mark_enquiry_contacted', {
      p_enquiry_id: params.id,
      p_method: method,
      p_note: String(body?.note || ''),
      p_user_id: user.id,
    });

    if (error) {
      const mapped = DB_ERRORS[String(error.message || '').trim()];
      if (mapped) return NextResponse.json({ error: mapped[1] }, { status: mapped[0] });
      console.error('POST enquiry contact:', error);
      return NextResponse.json({ error: 'Failed to record the contact.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/crm/enquiries/[id]/contact:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
