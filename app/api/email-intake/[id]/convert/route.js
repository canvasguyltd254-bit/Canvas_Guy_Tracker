/**
 * app/api/email-intake/[id]/convert/route.js
 *
 * POST /api/email-intake/[id]/convert
 *
 * Turns one pending inbound_emails row into a real enquiries row, via the
 * convert_inbound_email_to_enquiry RPC (atomic — see that migration for
 * why this isn't a plain two-step insert-then-update).
 *
 * Body fields all default from the inbound email itself; the caller only
 * needs to send overrides (e.g. a chosen category, an edited description,
 * or customer_id to link an existing customer instead of a free-text
 * prospect).
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { id } = params;

    let body = {};
    try { body = await request.json(); } catch { /* body is optional — all-defaults conversion is valid */ }

    const { data: inbound, error: fetchErr } = await serviceClient
      .from('inbound_emails')
      .select('id, from_address, from_name, subject, body_text, status')
      .eq('id', id)
      .single();

    if (fetchErr || !inbound) {
      return NextResponse.json({ error: 'Inbound email not found' }, { status: 404 });
    }
    if (inbound.status !== 'pending') {
      return NextResponse.json({ error: `Already ${inbound.status} — cannot convert again` }, { status: 409 });
    }

    const prospectName    = body.customer_id ? null : (body.prospect_name?.trim() || inbound.from_name || inbound.from_address || 'Unknown sender');
    const prospectContact = body.customer_id ? null : (body.prospect_contact?.trim() || inbound.from_address || null);
    const description     = body.description?.trim() || [inbound.subject, inbound.body_text].filter(Boolean).join('\n\n') || inbound.subject || '(no content)';

    const { data: enqNum, error: numErr } = await serviceClient.rpc('next_enq_num');
    if (numErr) {
      console.error('POST /api/email-intake/[id]/convert next_enq_num:', numErr);
      return NextResponse.json({ error: 'Failed to generate enquiry number' }, { status: 500 });
    }

    const { data, error } = await serviceClient.rpc('convert_inbound_email_to_enquiry', {
      p_inbound_email_id: id,
      p_enq_num: enqNum,
      p_customer_id: body.customer_id || null,
      p_prospect_name: prospectName,
      p_prospect_contact: prospectContact,
      p_category: body.category || null,
      p_description: description,
      p_estimated_value: Number.isFinite(body.estimated_value) ? body.estimated_value : 0,
      p_assigned_to: body.assigned_to || null,
      p_created_by: user.id,
    });

    if (error) {
      console.error('POST /api/email-intake/[id]/convert:', error);
      return NextResponse.json({ error: error.message || 'Failed to convert to enquiry' }, { status: 500 });
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/email-intake/[id]/convert:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
