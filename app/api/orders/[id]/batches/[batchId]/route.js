/**
 * app/api/orders/[id]/batches/[batchId]/route.js
 *
 * PATCH /api/orders/:id/batches/:batchId
 *   Two modes (determined by presence of `newStatus` in body):
 *
 *   Mode A — Status advance:
 *     Body: { newStatus: string, reason?: string }
 *     Validates transition against BATCH_STATUS_TRANSITIONS.
 *     Role gates:
 *       Planned → Picking / Loaded             production_manager | admin
 *       Loaded → Out for Delivery → Delivered  any authenticated user (logistics)
 *       Delivered → Signed                     production_manager | admin
 *       Any → Cancelled                        production_manager | admin
 *       Any → Rejected / Returned              any authenticated user
 *
 *   Mode B — Logistics update (no status change):
 *     Body: { driver?, vehicle?, planned_date?, delivery_location?, notes? }
 *     Allowed for production_manager | admin on any non-terminal batch.
 *     Allowed for logistics roles when batch is Loaded or Out for Delivery.
 *
 *   Mode C — Quantity update (production_manager / admin only):
 *     Sends items array: [{ id: batchItemId, quantity_delivered, quantity_rejected, rejection_reason? }]
 *     Used when recording actual delivered/rejected quantities at Delivered/Signed stage.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import {
  BATCH_STATUS_TRANSITIONS,
  ROLES_CAN_CREATE_BATCH,
  ROLES_CAN_UPDATE_BATCH,
} from '@/modules/orders/components/constants';

// All batch status advances use ROLES_CAN_UPDATE_BATCH (admin, production_manager, head_of_sales)
const LOGISTICS_ADVANCEABLE = new Set(['Out for Delivery', 'Delivered', 'Rejected', 'Returned']);

// Terminal statuses — no further updates allowed
const TERMINAL_STATUSES = new Set(['Signed', 'Cancelled', 'Rejected', 'Returned']);

export async function PATCH(request, { params }) {
  try {
    const { id: orderId, batchId } = params;

    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body;
    try { body = await request.json(); }
    catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    // Fetch current batch
    const { data: batch, error: fetchErr } = await serviceClient
      .from('delivery_batches')
      .select('*')
      .eq('id', batchId)
      .eq('order_id', orderId)
      .single();

    if (fetchErr || !batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    if (TERMINAL_STATUSES.has(batch.status) && !body.newStatus) {
      return NextResponse.json(
        { error: `Batch is ${batch.status} and cannot be modified.` },
        { status: 422 },
      );
    }

    // ── Mode A: Status advance ────────────────────────────────────────────────
    if (body.newStatus) {
      const newStatus = body.newStatus;
      const allowedNext = BATCH_STATUS_TRANSITIONS[batch.status] || [];

      if (!allowedNext.includes(newStatus)) {
        return NextResponse.json(
          { error: `Cannot move batch from "${batch.status}" to "${newStatus}".` },
          { status: 422 },
        );
      }

      // Role gate
      const isLogisticsMove = LOGISTICS_ADVANCEABLE.has(newStatus);
      if (isLogisticsMove) {
        // Logistics or above can make this move
        const authError = requireRole(user, role, ROLES_CAN_UPDATE_BATCH);
        if (authError) return authError;
      } else {
        // PM / Admin only
        const authError = requireRole(user, role, ROLES_CAN_CREATE_BATCH);
        if (authError) return authError;
      }

      const updatePayload = { status: newStatus };

      // Set actual_delivery_date when batch is marked Delivered
      if (newStatus === 'Delivered' && !batch.actual_delivery_date) {
        updatePayload.actual_delivery_date = new Date().toISOString().split('T')[0];
      }

      // Set cancelled_at when cancelled
      if (newStatus === 'Cancelled') {
        updatePayload.cancelled_at = new Date().toISOString();
        if (body.reason) updatePayload.cancelled_reason = body.reason;
      }

      const safeUpdate = pick(updatePayload, ALLOWED_FIELDS.delivery_batches.update);

      const { error: updateErr } = await serviceClient
        .from('delivery_batches')
        .update(safeUpdate)
        .eq('id', batchId);

      if (updateErr) {
        console.error('PATCH /batches/[batchId] status:', updateErr);
        return NextResponse.json({ error: 'Failed to update batch status.' }, { status: 500 });
      }

      // Activity log
      await serviceClient.from('order_activities').insert({
        order_id: orderId,
        activity_type: 'batch_status_change',
        description: `Batch ${batch.batch_number}: ${batch.status} → ${newStatus}${body.reason ? ` — ${body.reason}` : ''}`,
      });

      // ── Completion rule ─────────────────────────────────────────────────────
      // When a batch is marked Delivered, check if all ordered quantities for
      // this order have now been delivered. If so, mark the main order Delivered.
      if (newStatus === 'Delivered') {
        const { data: fulfillment } = await serviceClient
          .from('order_item_fulfillment')
          .select('remaining_qty')
          .eq('order_id', orderId);

        const allDelivered = fulfillment?.length > 0
          && fulfillment.every(f => (f.remaining_qty || 0) === 0);

        if (allDelivered) {
          await serviceClient
            .from('orders')
            .update({
              status: 'Delivered',
              actual_delivery_date: new Date().toISOString().split('T')[0],
            })
            .eq('id', orderId);

          await serviceClient.from('order_activities').insert({
            order_id: orderId,
            activity_type: 'status_change',
            description: 'All quantities delivered — order marked Delivered automatically.',
          });
        }
      }

      return NextResponse.json({ success: true, data: { batchId, oldStatus: batch.status, newStatus } });
    }

    // ── Mode B: Logistics / field update ─────────────────────────────────────
    if (body.items === undefined) {
      const authError = requireRole(user, role, ROLES_CAN_UPDATE_BATCH);
      if (authError) return authError;

      const safeUpdate = pick(body, ALLOWED_FIELDS.delivery_batches.update);

      // Never allow status to change through this mode
      delete safeUpdate.status;
      delete safeUpdate.cancelled_at;
      delete safeUpdate.cancelled_reason;
      delete safeUpdate.signed_copy_path;

      if (Object.keys(safeUpdate).length === 0) {
        return NextResponse.json({ error: 'No valid fields to update.' }, { status: 400 });
      }

      const { error: updateErr } = await serviceClient
        .from('delivery_batches')
        .update(safeUpdate)
        .eq('id', batchId);

      if (updateErr) {
        console.error('PATCH /batches/[batchId] fields:', updateErr);
        return NextResponse.json({ error: 'Failed to update batch.' }, { status: 500 });
      }

      return NextResponse.json({ success: true });
    }

    // ── Mode C: Record delivered / rejected quantities ─────────────────────
    const authError = requireRole(user, role, ROLES_CAN_CREATE_BATCH);
    if (authError) return authError;

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: 'items must be a non-empty array.' }, { status: 400 });
    }

    const updatePromises = body.items.map(item => {
      if (!item.id) return Promise.resolve({ error: { message: 'Missing batch item id' } });
      const safeItem = pick(item, ALLOWED_FIELDS.delivery_batch_items.update);
      return serviceClient
        .from('delivery_batch_items')
        .update(safeItem)
        .eq('id', item.id)
        .eq('batch_id', batchId);
    });

    const results = await Promise.all(updatePromises);
    const failed = results.filter(r => r.error);
    if (failed.length > 0) {
      console.error('PATCH /batches/[batchId] items:', failed[0].error);
      return NextResponse.json({ error: 'Failed to update some batch item quantities.' }, { status: 500 });
    }

    // Activity log
    await serviceClient.from('order_activities').insert({
      order_id: orderId,
      activity_type: 'batch_quantities_updated',
      description: `Batch ${batch.batch_number}: delivered/rejected quantities recorded.`,
    });

    return NextResponse.json({ success: true });

  } catch (err) {
    console.error('PATCH /batches/[batchId]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
