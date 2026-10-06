/**
 * app/api/email-intake/[id]/dismiss/route.js
 *
 * POST /api/email-intake/[id]/dismiss
 *
 * Marks a pending inbound_emails row as dismissed (spam, an auto-reply
 * that slipped past the automated-message filter, an existing
 * conversation already handled elsewhere, etc.). A single conditional
 * UPDATE is atomic enough here — unlike convert, there is no second table
 * to keep in sync, so this doesn't need an RPC.
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

    const { data, error } = await serviceClient
      .from('inbound_emails')
      .update({ status: 'dismissed', reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending') // guard: only a pending row can be dismissed
      .select()
      .maybeSingle();

    if (error) {
      console.error('POST /api/email-intake/[id]/dismiss:', error);
      return NextResponse.json({ error: 'Failed to dismiss' }, { status: 500 });
    }
    if (!data) {
      // Either the id doesn't exist, or it wasn't pending (already reviewed) —
      // both are the same "nothing to do" outcome for the caller.
      return NextResponse.json({ error: 'Inbound email not found, or already reviewed' }, { status: 409 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('POST /api/email-intake/[id]/dismiss:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
