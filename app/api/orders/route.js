/**
 * app/api/orders/route.js
 *
 * POST  /api/orders  — create a new order (with line items + activity log)
 *
 * Roles: admin, production_manager, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

export async function POST(request) {
  try {
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

    // 3. Whitelist order fields
    const safeOrder = pick(body, ALLOWED_FIELDS.orders.insert);

    if (!safeOrder.client?.trim()) {
      return NextResponse.json({ error: 'client is required' }, { status: 400 });
    }

    // 4. Insert order
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .insert(safeOrder)
      .select()
      .single();

    if (orderErr) {
      console.error('POST /api/orders — order insert:', orderErr);
      return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }

    // 5. Insert order_items (if provided)
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 0) {
      const itemRows = items.map((item) => ({
        ...pick(item, ALLOWED_FIELDS.order_items.insert),
        order_id: order.id, // injected server-side — never trust body.order_id
      }));

      const { error: itemsErr } = await serviceClient
        .from('order_items')
        .insert(itemRows);

      if (itemsErr) {
        console.error('POST /api/orders — items insert:', itemsErr);
        // Order already created — log but don't roll back (order_items can be added later)
      }
    }

    // 6. Activity log
    await serviceClient.from('order_activities').insert(
      pick(
        {
          order_id: order.id,
          activity_type: 'created',
          description: `Order ${order.order_num} created for ${order.client}`,
        },
        ALLOWED_FIELDS.order_activities.insert,
      ),
    );

    return NextResponse.json({ success: true, data: order }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
