/**
 * app/api/orders/[id]/route.js
 *
 * PATCH /api/orders/:id  — update order metadata + manage line items
 *
 * Notes:
 *  - 'status' is intentionally excluded from this route. Use /status instead.
 *  - Item add/update/delete: admin + head_of_sales only.
 */

export const runtime = 'edge';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

// status is a workflow-only field — excluded from the general update route
const ORDER_UPDATE_FIELDS = ALLOWED_FIELDS.orders.update.filter(f => f !== 'status');

export async function PATCH(request, { params }) {
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

    // 3. Verify order exists
    const { data: existing } = await serviceClient
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 4. Update order metadata (status excluded)
    const safeUpdate = pick(body, ORDER_UPDATE_FIELDS);

    if (Object.keys(safeUpdate).length > 0) {
      const { error: updateErr } = await serviceClient
        .from('orders')
        .update(safeUpdate)
        .eq('id', orderId);

      if (updateErr) {
        console.error('PATCH /api/orders/[id] — order update:', updateErr);
        return NextResponse.json({ error: 'Failed to update order' }, { status: 500 });
      }
    }

    // 5. Line item mutations — admin + head_of_sales only
    const hasItemChanges =
      (Array.isArray(body.items) && body.items.length > 0) ||
      (Array.isArray(body.deletedItemIds) && body.deletedItemIds.length > 0);

    if (hasItemChanges) {
      const itemRoles = ['admin', 'head_of_sales'];
      const itemAuthError = requireRole(user, role, itemRoles);
      if (itemAuthError) return itemAuthError;

      // 5a. Delete removed items
      if (Array.isArray(body.deletedItemIds) && body.deletedItemIds.length > 0) {
        const { error: deleteErr } = await serviceClient
          .from('order_items')
          .delete()
          .in('id', body.deletedItemIds)
          .eq('order_id', orderId); // scope to this order only

        if (deleteErr) {
          console.error('PATCH /api/orders/[id] — items delete:', deleteErr);
          return NextResponse.json({ error: 'Failed to remove items' }, { status: 500 });
        }
      }

      // 5b. Upsert items: with id → update, without id → insert
      if (Array.isArray(body.items) && body.items.length > 0) {
        const toUpdate = body.items.filter(i => i.id);
        const toInsert = body.items.filter(i => !i.id);

        // Updates
        for (const item of toUpdate) {
          const safeItem = pick(item, ALLOWED_FIELDS.order_items.update);
          await serviceClient
            .from('order_items')
            .update(safeItem)
            .eq('id', item.id)
            .eq('order_id', orderId); // scope check
        }

        // Inserts
        if (toInsert.length > 0) {
          const insertRows = toInsert.map(item => ({
            ...pick(item, ALLOWED_FIELDS.order_items.insert),
            order_id: orderId, // injected server-side
          }));

          const { error: insertErr } = await serviceClient
            .from('order_items')
            .insert(insertRows);

          if (insertErr) {
            console.error('PATCH /api/orders/[id] — items insert:', insertErr);
            return NextResponse.json({ error: 'Failed to add items' }, { status: 500 });
          }
        }
      }
    }

    // 6. Return updated order
    const { data: updated } = await serviceClient
      .from('orders')
      .select()
      .eq('id', orderId)
      .single();

    return NextResponse.json({ success: true, data: updated });

  } catch (err) {
    console.error('PATCH /api/orders/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
