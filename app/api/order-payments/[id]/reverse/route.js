export const runtime = 'nodejs';

/**
 * POST /api/order-payments/[id]/reverse
 *
 * Reverses a posted customer payment via the reverse_customer_payment() RPC.
 * Body: { reason: string }
 * Admin only.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_REVERSE = ['admin'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_REVERSE);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!body.reason?.trim()) {
      return NextResponse.json({ error: 'reason is required' }, { status: 422 });
    }

    const { data: reversalId, error: rpcErr } = await serviceClient.rpc(
      'reverse_customer_payment',
      { p_payment_id: params.id, p_reason: body.reason.trim(), p_reversed_by: user.id },
    );

    if (rpcErr) {
      const msg = rpcErr.message || '';
      if (msg.includes('PAYMENT_NOT_FOUND'))  return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
      if (msg.includes('PAYMENT_NOT_POSTED')) return NextResponse.json({ error: 'Payment has not been posted to GL' }, { status: 422 });
      if (msg.includes('ALREADY_REVERSED'))   return NextResponse.json({ error: 'Payment has already been reversed' }, { status: 422 });
      if (msg.includes('REASON_REQUIRED'))    return NextResponse.json({ error: 'A reason is required' }, { status: 422 });
      console.error('reverse_customer_payment RPC error:', rpcErr);
      return NextResponse.json({ error: 'Failed to reverse payment' }, { status: 500 });
    }

    return NextResponse.json({ data: { reversal_journal_entry_id: reversalId } });
  } catch (err) {
    console.error('POST /api/order-payments/[id]/reverse:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
