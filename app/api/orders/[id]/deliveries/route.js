/**
 * app/api/orders/[id]/deliveries/route.js
 *
 * GET   /api/orders/:id/deliveries            — list all delivery batches
 * POST  /api/orders/:id/deliveries            — record a new batch
 * PATCH /api/orders/:id/deliveries?batch_id=  — edit an existing batch
 *
 * Security:
 *  - admin_authorized is injected server-side from the session role + payment balance.
 *    The client NEVER sets this field — it cannot be spoofed.
 *  - batch_number is computed server-side (MAX existing + 1).
 *  - payment_status_at_delivery is computed server-side from DB payments.
 *  - order_id is always injected from URL params, never from body.
 */

export const runtime = 'edge';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { ROLES_CAN_DELIVER } from '@/modules/orders/components/constants';

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request, { params }) {
  try {
    const orderId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('order_deliveries')
      .select('*')
      .eq('order_id', orderId)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('GET /api/orders/[id]/deliveries:', error);
      return NextResponse.json({ error: 'Failed to fetch deliveries' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('GET /api/orders/[id]/deliveries:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES_CAN_DELIVER);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const quantity = parseInt(body.quantity);
    if (!quantity || quantity <= 0) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    // 3. Verify order exists + get total_value for payment check
    const { data: order } = await serviceClient
      .from('orders')
      .select('id, total_value, status')
      .eq('id', orderId)
      .single();

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 4. Compute batch_number server-side — client cannot supply this
    const { data: existing } = await serviceClient
      .from('order_deliveries')
      .select('batch_number')
      .eq('order_id', orderId)
      .order('batch_number', { ascending: false })
      .limit(1);

    const batchNumber = existing && existing.length > 0
      ? (existing[0].batch_number + 1)
      : 1;

    // 5. Compute payment_status_at_delivery server-side
    //    Fetch total paid, compare against order.total_value
    const { data: payments } = await serviceClient
      .from('order_payments')
      .select('amount')
      .eq('order_id', orderId);

    const totalPaid = (payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const orderTotal = parseFloat(order.total_value) || 0;
    const balance = Math.max(orderTotal - totalPaid, 0);
    const paymentStatusAtDelivery = balance > 0 ? 'Balance pending' : 'Paid';

    // 6. Compute admin_authorized server-side
    //    True when there's an outstanding balance AND the user is admin or head_of_sales.
    //    The client cannot spoof this — it comes from the verified session role.
    const needsAuth = balance > 0;
    const canAuthorizeWithBalance = ['admin', 'head_of_sales'].includes(role);
    const adminAuthorized = needsAuth && canAuthorizeWithBalance;

    // 7. If balance outstanding and user can't authorize — block the delivery
    if (needsAuth && !canAuthorizeWithBalance) {
      return NextResponse.json(
        { error: 'Outstanding balance. Admin or Head of Sales authorization required.' },
        { status: 403 },
      );
    }

    // 8. Build the admin_auth_reason from body (only meaningful when admin_authorized)
    const adminAuthReason = adminAuthorized
      ? (body.auth_reason?.trim() || null)
      : null;

    // 9. Whitelist body fields — server-injected fields are added separately
    const bodyFields = pick(body, ALLOWED_FIELDS.order_deliveries.insert.filter(
      f => !['order_id', 'batch_number', 'payment_status_at_delivery'].includes(f)
    ));

    const insertRow = {
      ...bodyFields,
      order_id: orderId,                              // server-injected
      batch_number: batchNumber,                      // server-computed
      payment_status_at_delivery: paymentStatusAtDelivery, // server-computed
      admin_authorized: adminAuthorized,              // server-computed from role
      admin_auth_reason: adminAuthReason,             // from body, only when authorized
      delivery_date: body.delivery_date || new Date().toISOString().split('T')[0],
    };

    const { data, error } = await serviceClient
      .from('order_deliveries')
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      console.error('POST /api/orders/[id]/deliveries:', error);
      return NextResponse.json({ error: 'Failed to record delivery' }, { status: 500 });
    }

    // 10. Activity log
    const loc = body.delivery_location?.trim();
    const authTag = adminAuthorized
      ? ` [${role === 'head_of_sales' ? 'Head of Sales' : 'Admin'} auth]`
      : '';

    await serviceClient.from('order_activities').insert({
      order_id: orderId,
      activity_type: 'delivery',
      description: `Batch ${batchNumber}: ${quantity} units${loc ? ` to ${loc}` : ''}${authTag}`,
    });

    return NextResponse.json({ success: true, data }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders/[id]/deliveries:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(request, { params }) {
  try {
    const orderId = params.id;
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get('batch_id');

    if (!batchId) {
      return NextResponse.json({ error: 'Missing batch_id query param' }, { status: 400 });
    }

    // 1. Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES_CAN_DELIVER);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const quantity = parseInt(body.quantity);
    if (!quantity || quantity <= 0) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    // 3. Verify batch belongs to this order
    const { data: batch } = await serviceClient
      .from('order_deliveries')
      .select('id, batch_number, order_id')
      .eq('id', batchId)
      .eq('order_id', orderId)
      .single();

    if (!batch) {
      return NextResponse.json({ error: 'Delivery batch not found' }, { status: 404 });
    }

    // 4. Whitelist update fields
    const safeUpdate = pick(body, ALLOWED_FIELDS.order_deliveries.update);

    const { data, error } = await serviceClient
      .from('order_deliveries')
      .update(safeUpdate)
      .eq('id', batchId)
      .eq('order_id', orderId)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/orders/[id]/deliveries:', error);
      return NextResponse.json({ error: 'Failed to update delivery batch' }, { status: 500 });
    }

    // 5. Activity log
    const loc = body.delivery_location?.trim();
    await serviceClient.from('order_activities').insert({
      order_id: orderId,
      activity_type: 'delivery_edited',
      description: `Batch ${batch.batch_number} edited: ${quantity} units${loc ? ` to ${loc}` : ''}`,
    });

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('PATCH /api/orders/[id]/deliveries:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
