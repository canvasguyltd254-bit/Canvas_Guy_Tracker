/**
 * app/api/orders/[id]/payments/route.js
 *
 * GET    /api/orders/:id/payments           — list all payments (any authenticated user)
 * POST   /api/orders/:id/payments           — add payment
 * DELETE /api/orders/:id/payments?payment_id — delete payment (admin, head_of_sales) with required reason; logs to order_activities
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { checkOrderSuspended } from '@/shared/lib/suspendGuard';

export async function GET(request, { params }) {
  try {
    const orderId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role); // any authenticated user
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('order_payments')
      .select('*')
      .eq('order_id', orderId)
      .order('payment_date', { ascending: true });

    if (error) {
      console.error('GET /api/orders/[id]/payments:', error);
      return NextResponse.json({ error: 'Failed to fetch payments' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('GET /api/orders/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth first — never leak suspension state to unauthenticated callers
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'sales']);
    if (authError) return authError;

    // 2. Suspension guard
    const suspendedErr = await checkOrderSuspended(orderId);
    if (suspendedErr) return suspendedErr;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // 3. Whitelist + inject order_id server-side
    const safePayment = {
      ...pick(body, ALLOWED_FIELDS.order_payments.insert.filter(f => f !== 'order_id')),
      order_id: orderId, // always injected server-side
    };

    if (!safePayment.amount || parseFloat(safePayment.amount) <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
    }

    // 4. Insert
    const { data, error } = await serviceClient
      .from('order_payments')
      .insert(safePayment)
      .select()
      .single();

    if (error) {
      console.error('POST /api/orders/[id]/payments:', error);
      return NextResponse.json({ error: 'Failed to add payment' }, { status: 500 });
    }

    // 5. Post the receipt to GL (Debit Bank / Credit AR).
    //    Best-effort: the payment record already exists (cash was actually received),
    //    so a GL posting failure must not roll back or hide the payment — it just
    //    means this payment needs to be retried from Accounting Review.
    //    INVOICE_NOT_POSTED is expected/normal for early payments taken before the
    //    order's invoice journal has been posted (e.g. deposits) — not an error.
    let glPosted = false;
    let glWarning = null;
    try {
      const { error: rpcErr } = await serviceClient.rpc('post_customer_payment', {
        p_payment_id: data.id,
        p_posted_by: user.id,
      });
      if (rpcErr) {
        const msg = rpcErr.message || '';
        if (!msg.includes('INVOICE_NOT_POSTED')) {
          console.error('post_customer_payment RPC error:', rpcErr);
          glWarning = 'Payment recorded but GL posting failed. Retry from Accounting Review.';
        }
      } else {
        glPosted = true;
      }
    } catch (rpcCatchErr) {
      console.error('post_customer_payment RPC threw:', rpcCatchErr);
      glWarning = 'Payment recorded but GL posting failed. Retry from Accounting Review.';
    }

    return NextResponse.json({ success: true, data, gl_posted: glPosted, gl_warning: glWarning }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const paymentId = searchParams.get('payment_id');

    if (!paymentId) {
      return NextResponse.json({ error: 'Missing payment_id query param' }, { status: 400 });
    }

    // 1. Auth — admin + head_of_sales can delete payments
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales']);
    if (authError) return authError;

    // 1a. Suspension guard — suspended orders are read-only
    const suspendedErr = await checkOrderSuspended(orderId);
    if (suspendedErr) return suspendedErr;

    // 2. Require a deletion reason
    let reason = '';
    try {
      const body = await request.json();
      reason = (body?.reason || '').trim();
    } catch { /* body may not be parseable */ }
    if (!reason) {
      return NextResponse.json({ error: 'A reason is required to delete a payment' }, { status: 400 });
    }

    // 3. Verify payment belongs to this order
    const { data: payment, error: fetchErr } = await serviceClient
      .from('order_payments')
      .select('id, order_id, amount, description, journal_entry_id, reversed_at')
      .eq('id', paymentId)
      .eq('order_id', orderId)
      .single();

    if (fetchErr || !payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    // 3a. Posted payments must be reversed, not deleted — deleting a payment that
    //     already has a GL journal would leave the journal orphaned and the books
    //     wrong. Use POST /api/order-payments/:id/reverse instead.
    if (payment.journal_entry_id) {
      return NextResponse.json(
        {
          error: 'This payment has already been posted to the ledger and cannot be deleted. '
            + 'Use "Reverse payment" instead (admin only) to correct it — this keeps the audit trail intact.',
        },
        { status: 409 },
      );
    }

    // 4. Hard delete — only reachable for payments that were never posted to GL
    const { error: delError } = await serviceClient
      .from('order_payments')
      .delete()
      .eq('id', paymentId)
      .eq('order_id', orderId);

    if (delError) {
      console.error('DELETE /api/orders/[id]/payments:', delError);
      return NextResponse.json({ error: 'Failed to delete payment' }, { status: 500 });
    }

    // 5. Log to order_activities — best-effort (payment is already gone if this fails)
    const amt  = parseFloat(payment.amount || 0).toLocaleString('en-KE');
    const desc = payment.description ? ` — "${payment.description}"` : '';
    const { error: actError } = await serviceClient.from('order_activities').insert({
      order_id:      orderId,
      activity_type: 'payment_deleted',
      description:   `Payment of KES ${amt}${desc} deleted by ${displayName}. Reason: ${reason}`,
      created_by:    user.id,
    });
    if (actError) {
      console.error('DELETE /api/orders/[id]/payments — activity log failed:', actError.message);
    }

    return NextResponse.json({
      success:          true,
      message:          'Payment deleted',
      activity_logged:  !actError,
    });

  } catch (err) {
    console.error('DELETE /api/orders/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
