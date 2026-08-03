export const runtime = 'nodejs';

/**
 * POST /api/order-payments/[id]/post
 *
 * Posts a single customer receipt to GL for a payment that was added
 * AFTER the invoice was issued. Calls the post_customer_payment() RPC.
 * Idempotent: safe to call multiple times.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_POST = ['admin', 'head_of_sales'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_POST);
    if (authErr) return authErr;

    const { data: journalId, error: rpcErr } = await serviceClient.rpc(
      'post_customer_payment',
      { p_payment_id: params.id, p_posted_by: user.id },
    );

    if (rpcErr) {
      const msg = rpcErr.message || '';
      if (msg.includes('PAYMENT_NOT_FOUND'))   return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
      if (msg.includes('PAYMENT_REVERSED'))    return NextResponse.json({ error: 'Payment has been reversed' }, { status: 422 });
      if (msg.includes('INVOICE_NOT_POSTED'))  return NextResponse.json({ error: 'Invoice has not been posted yet for this order' }, { status: 422 });
      console.error('post_customer_payment RPC error:', rpcErr);
      return NextResponse.json({ error: 'Failed to post payment journal' }, { status: 500 });
    }

    return NextResponse.json({ data: { journal_entry_id: journalId } });
  } catch (err) {
    console.error('POST /api/order-payments/[id]/post:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
