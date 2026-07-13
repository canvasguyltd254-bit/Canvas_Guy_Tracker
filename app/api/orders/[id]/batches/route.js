/**
 * app/api/orders/[id]/batches/route.js
 *
 * GET  /api/orders/:id/batches
 *   Returns all delivery_batches for the order, each with its batch_items
 *   joined to order_items for category/description/size.
 *
 * POST /api/orders/:id/batches
 *   Creates a new batch + batch_items in one atomic operation.
 *   Body: {
 *     planned_date?:       string  (ISO date)
 *     driver?:             string
 *     vehicle?:            string
 *     delivery_location?:  string
 *     notes?:              string
 *     items: [{ order_item_id: string, quantity_planned: number }]
 *   }
 *
 *   Server-side validation:
 *   • Only production_manager / admin can create batches.
 *   • Each item's quantity_planned must be > 0.
 *   • quantity_planned must not exceed remaining_qty from order_item_fulfillment
 *     (prevents over-allocation regardless of client-side guards).
 *   • batch_number is auto-assigned by DB trigger — never sent by client.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { ROLES_CAN_CREATE_BATCH } from '@/modules/orders/components/constants';

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(_req, { params }) {
  try {
    const { user } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await serviceClient
      .from('delivery_batches')
      .select(`
        *,
        delivery_batch_items (
          id,
          order_item_id,
          quantity_planned,
          quantity_delivered,
          quantity_rejected,
          rejection_reason,
          order_items ( id, category, description, size, quantity )
        )
      `)
      .eq('order_id', params.id)
      .order('batch_number', { ascending: true });

    if (error) {
      console.error('GET /batches:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET /batches:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth — only PM / Admin can create batches
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const authError = requireRole(user, role, ROLES_CAN_CREATE_BATCH);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { items, ...batchFields } = body;

    // 3. Validate items array
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'A batch must contain at least one item.' },
        { status: 400 },
      );
    }

    for (const item of items) {
      if (!item.order_item_id || typeof item.order_item_id !== 'string') {
        return NextResponse.json({ error: 'Each item must have an order_item_id.' }, { status: 400 });
      }
      if (!Number.isInteger(item.quantity_planned) || item.quantity_planned <= 0) {
        return NextResponse.json(
          { error: `quantity_planned must be a positive integer (got ${item.quantity_planned}).` },
          { status: 400 },
        );
      }
    }

    // 4. Fetch current fulfillment state from the view — server-side guard
    const itemIds = items.map(i => i.order_item_id);
    const { data: fulfillment, error: fErr } = await serviceClient
      .from('order_item_fulfillment')
      .select('order_item_id, ordered_qty, batched_qty, remaining_qty')
      .eq('order_id', orderId)
      .in('order_item_id', itemIds);

    if (fErr) {
      console.error('POST /batches — fulfillment fetch:', fErr);
      return NextResponse.json({ error: 'Could not verify item quantities.' }, { status: 500 });
    }

    const fulfillmentMap = Object.fromEntries(
      (fulfillment || []).map(f => [f.order_item_id, f])
    );

    // 5. Validate each item against remaining_qty
    const overAllocated = [];
    for (const item of items) {
      const f = fulfillmentMap[item.order_item_id];
      if (!f) {
        return NextResponse.json(
          { error: `Item ${item.order_item_id} does not belong to this order.` },
          { status: 400 },
        );
      }
      if (item.quantity_planned > f.remaining_qty) {
        overAllocated.push({
          order_item_id: item.order_item_id,
          requested: item.quantity_planned,
          remaining: f.remaining_qty,
        });
      }
    }

    if (overAllocated.length > 0) {
      return NextResponse.json(
        {
          error: 'Some items exceed remaining available quantity.',
          details: overAllocated,
        },
        { status: 422 },
      );
    }

    // 6. Insert batch (batch_number auto-assigned by trigger)
    const batchInsert = pick(
      {
        order_id: orderId,
        status: 'Quality Control',   // batches begin at QC before planning
        created_by: user.id,
        ...batchFields,
      },
      ALLOWED_FIELDS.delivery_batches.insert,
    );

    const { data: batch, error: batchErr } = await serviceClient
      .from('delivery_batches')
      .insert(batchInsert)
      .select()
      .single();

    if (batchErr) {
      console.error('POST /batches — batch insert:', batchErr);
      return NextResponse.json({ error: 'Failed to create batch.' }, { status: 500 });
    }

    // 7. Insert batch_items
    const batchItemRows = items.map(item =>
      pick(
        { batch_id: batch.id, order_item_id: item.order_item_id, quantity_planned: item.quantity_planned },
        ALLOWED_FIELDS.delivery_batch_items.insert,
      )
    );

    const { error: itemsErr } = await serviceClient
      .from('delivery_batch_items')
      .insert(batchItemRows);

    if (itemsErr) {
      // Roll back the batch if items fail
      await serviceClient.from('delivery_batches').delete().eq('id', batch.id);
      console.error('POST /batches — batch_items insert:', itemsErr);
      return NextResponse.json({ error: 'Failed to save batch items.' }, { status: 500 });
    }

    // 8. Activity log
    const itemSummary = items
      .map(i => {
        const f = fulfillmentMap[i.order_item_id];
        return `${i.quantity_planned}× ${f?.category || i.order_item_id}`;
      })
      .join(', ');

    await serviceClient.from('order_activities').insert({
      order_id: orderId,
      activity_type: 'batch_created',
      description: `Batch ${batch.batch_number} created — ${itemSummary}`,
    });

    return NextResponse.json({ data: batch }, { status: 201 });

  } catch (err) {
    console.error('POST /batches:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
