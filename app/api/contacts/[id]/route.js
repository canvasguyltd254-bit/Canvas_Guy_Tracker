/**
 * app/api/contacts/[id]/route.js
 *
 * PATCH  /api/contacts/:id  — update a General/Transporter contact
 * DELETE /api/contacts/:id  — delete a General/Transporter contact
 *
 * Note: Customer and Supplier records are managed by their own modules.
 * This route only operates on the contacts table.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const CONTACT_TYPES = ['General', 'Transporter'];

export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (body.contact_type && !CONTACT_TYPES.includes(body.contact_type)) {
      return NextResponse.json({ error: `contact_type must be one of: ${CONTACT_TYPES.join(', ')}` }, { status: 400 });
    }

    const allowed = ['contact_type','name','company','phone','email','address','notes'];
    const update = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
    }

    if (!Object.keys(update).length) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { data, error } = await serviceClient
      .from('contacts')
      .update(update)
      .eq('id', params.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 });

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales']);
    if (authError) return authError;

    const { error } = await serviceClient.from('contacts').delete().eq('id', params.id);
    if (error) return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });

    return NextResponse.json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
