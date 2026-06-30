/**
 * app/api/orders/[id]/payments/route.js
 *
 * GET    /api/orders/:id/payments           — list all payments (any authenticated user)
 * POST   /api/orders/:id/payments           — add payment
 * DELETE /api/orders/:id/payments?payment_id — delete payment (admin only)
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

    // 1. Auth — admin only for deletes
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // 2. Verify payment belongs to this order
    const { data: payment } = await serviceClient
      .from('order_payments')
      .select('id, order_id')
      .eq('id', paymentId)
      .eq('order_id', orderId)
      .single();

    if (!payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
    }

    // 3. Delete
    const { error } = await serviceClient
      .from('order_payments')
      .delete()
      .eq('id', paymentId)
      .eq('order_id', orderId);

    if (error) {
      console.error('DELETE /api/orders/[id]/payments:', error);
      return NextResponse.json({ error: 'Failed to delete payment' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Payment deleted' });

  } catch (err) {
    console.error('DELETE /api/orders/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
