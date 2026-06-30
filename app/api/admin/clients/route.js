/**
 * app/api/admin/clients/route.js
 *
 * POST /api/admin/clients  — create a client credit profile (admin only)
 *
 * Body: { client_name, customer_type }
 *
 * credit_limit is always created as 0 — use PATCH /credit-limit to set it.
 * current_exposure is always created as 0 — server manages this field.
 */

export const runtime = 'edge';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

export async function POST(request) {
  try {
    // 1. Auth — admin only
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const clientName = body.client_name?.trim();
    if (!clientName) {
      return NextResponse.json({ error: 'client_name is required' }, { status: 400 });
    }

    const customerType = body.customer_type || 'reseller';
    if (!['reseller', 'commercial'].includes(customerType)) {
      return NextResponse.json(
        { error: 'customer_type must be "reseller" or "commercial"' },
        { status: 400 },
      );
    }

    // 3. Check for duplicate
    const { data: existing } = await serviceClient
      .from('client_profiles')
      .select('id')
      .eq('client_name', clientName)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: 'A credit profile already exists for this client' },
        { status: 409 },
      );
    }

    // 4. Insert — credit_limit and current_exposure are always 0 on create.
    //    Client cannot set these on creation; use the credit-limit route to set limits.
    const safeInsert = pick(
      { client_name: clientName, customer_type: customerType },
      ALLOWED_FIELDS.client_profiles.insert,
    );
    safeInsert.credit_limit = 0;
    safeInsert.current_exposure = 0;

    const { data, error } = await serviceClient
      .from('client_profiles')
      .insert(safeInsert)
      .select()
      .single();

    if (error) {
      console.error('POST /api/admin/clients:', error);
      return NextResponse.json({ error: 'Failed to create client profile' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });

  } catch (err) {
    console.error('POST /api/admin/clients:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
