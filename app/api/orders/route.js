/**
 * app/api/orders/route.js
 *
 * GET   /api/orders  — list orders for pickers/dropdowns
 *   ?status=all|<status>   filter by status (default: all)
 *   ?limit=<n>             max rows (default 200)
 *
 * POST  /api/orders  — create a new order (with line items + activity log)
 *
 * Roles: admin, production_manager, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { lineTypeForCategory } from '@/shared/lib/orderLineTypes';
import { withCustomerNames } from '@/shared/lib/customerDisplay';

export async function GET(request) {
  try {
    const { user } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const status           = searchParams.get('status') || 'all';
    const search           = searchParams.get('search')?.trim() || '';
    const limit            = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);
    const includeSuspended = searchParams.get('include_suspended') === 'true';

    let query = serviceClient
      .from('orders')
      .select('id, order_num, client, customer_id, due_date, status, total_value, order_type, suspended_at, created_at, customers(name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!includeSuspended) {
      query = query.is('suspended_at', null);
    }

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      // Match order_num, the order-time snapshot (client), OR the customer's
      // CURRENT name — so a renamed customer is found under either name.
      const { data: matchedCustomers } = await serviceClient
        .from('customers')
        .select('id')
        .ilike('name', `%${search}%`)
        .limit(200);
      const ids = (matchedCustomers || []).map(c => c.id);
      const clauses = [`order_num.ilike.%${search}%`, `client.ilike.%${search}%`];
      if (ids.length) clauses.push(`customer_id.in.(${ids.join(',')})`);
      query = query.or(clauses.join(','));
    }

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/orders:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // `client` stays the order-time snapshot; the live name is returned
    // separately so provenance is never hidden.
    return NextResponse.json({ success: true, data: (data || []).map(withCustomerNames) });
  } catch (err) {
    console.error('GET /api/orders:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

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
        // Classified server-side from the category; a client-supplied line_type is ignored.
        line_type: lineTypeForCategory(item.category),
      }));

      const { error: itemsErr } = await serviceClient
        .from('order_items')
        .insert(itemRows);

      if (itemsErr) {
        console.error('POST /api/orders — items insert:', itemsErr);
        // Do not leave an empty order header behind: remove it and fail the request.
        const { error: cleanupErr } = await serviceClient.from('orders').delete().eq('id', order.id);
        if (cleanupErr) console.error('POST /api/orders — cleanup of order without items failed:', cleanupErr);
        return NextResponse.json({ error: 'Failed to save order items; the order was not created' }, { status: 500 });
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
