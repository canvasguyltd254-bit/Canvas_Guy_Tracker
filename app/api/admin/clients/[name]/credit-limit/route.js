/**
 * app/api/admin/clients/[name]/credit-limit/route.js
 *
 * PATCH /api/admin/clients/:name/credit-limit  — set credit limit (admin only)
 *
 * Body: { credit_limit: number }
 *
 * Uses client_name as the URL param (matches how client_profiles is keyed).
 * If no profile exists for this client, creates one with credit_limit set.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function PATCH(request, { params }) {
  try {
    const clientName = decodeURIComponent(params.name);

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

    const newLimit = parseFloat(body.credit_limit);
    if (isNaN(newLimit) || newLimit < 0) {
      return NextResponse.json(
        { error: 'credit_limit must be a non-negative number' },
        { status: 400 },
      );
    }

    // 3. Check if profile exists — upsert accordingly
    const { data: existing } = await serviceClient
      .from('client_profiles')
      .select('id, customer_type')
      .eq('client_name', clientName)
      .maybeSingle();

    let data, error;

    if (existing) {
      // Update existing profile — only credit_limit; never touch current_exposure here
      ({ data, error } = await serviceClient
        .from('client_profiles')
        .update({ credit_limit: newLimit })
        .eq('client_name', clientName)
        .select()
        .single());
    } else {
      // Auto-create profile with the limit (admin shortcut via this endpoint)
      const customerType = body.customer_type || 'reseller';
      ({ data, error } = await serviceClient
        .from('client_profiles')
        .insert({
          client_name: clientName,
          customer_type: customerType,
          credit_limit: newLimit,
          current_exposure: 0,
        })
        .select()
        .single());
    }

    if (error) {
      console.error('PATCH /api/admin/clients/[name]/credit-limit:', error);
      return NextResponse.json({ error: 'Failed to update credit limit' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('PATCH /api/admin/clients/[name]/credit-limit:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
