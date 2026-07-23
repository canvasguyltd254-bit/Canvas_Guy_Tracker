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

    // 1. Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'sales']);
    if (authError) return authError;

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

    return NextResponse.json({ success: true, data }, { status: 201 });

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

    // 2. Require a deletion reason
    let reason = '';
    try {
      const body = await request.json();
      reason = (body?.reason || '').trim();
    } catch { /* body may not be parseable */ }
    if (!reason) {
      return NextResponse.json({ error: 'A reason is required to delete a payment' }, { status: 400 });
    }

    // 3. Verify payment belongs to this order — fetch only columns that exist
    const { data: payment, error: fetchErr } = await serviceClient
      .from('order_payments')
      .select('id, order_id, amount, description')
      .eq('id', paymentId)
      .eq('order_id', orderId)
      .single();

    if (fetchErr || !payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    // 4. Hard delete
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
