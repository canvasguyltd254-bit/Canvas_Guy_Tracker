/**
 * app/api/orders/[id]/route.js
 *
 * PATCH /api/orders/:id  — update order metadata + manage line items
 *
 * Body: {
 *   items?:          [{ id?, category, description, quantity, unit_price, ... }],
 *   deletedItemIds?: uuid[],
 *   reason?:         string   // REQUIRED whenever financial items change
 *   notes, due_date, delivery_address, ...   // metadata (whitelisted)
 * }
 *
 * Notes:
 *  - 'status' is intentionally excluded from this route. Use /status instead.
 *  - Line items are saved by ONE atomic RPC (update_order_items_with_audit):
 *    server-side net/VAT/gross, server-side order totals, audit rows in the
 *    same transaction. The client never supplies total_value/subtotal/VAT —
 *    any such keys in the body are ignored.
 *  - Once the invoice is posted to accounting (invoice_journal_entry_id set)
 *    financial changes are refused with 409 INVOICE_POSTED. Metadata stays
 *    editable.
 *  - An edit that would drop the total below non-reversed payments is refused
 *    with 409 TOTAL_BELOW_PAYMENTS (the whole item change rolls back).
 *  - The item change (rows + audit + totals) is atomic. Metadata is a SEPARATE
 *    request afterwards, so a full Save is not one transaction: if metadata
 *    fails, the items stay saved and the response says so.
 *  - Item permissions mirror the order form: admin + head_of_sales always;
 *    sales only while the order is pre-production.
 *
 * Returns { success, data: <order>, items: [...], event_id }.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { checkOrderSuspended } from '@/shared/lib/suspendGuard';

// status is workflow-only; money fields are server-derived from the items.
const SERVER_OWNED_FIELDS = new Set(['status', 'total_value', 'subtotal_amount', 'vat_amount']);
const ORDER_UPDATE_FIELDS = ALLOWED_FIELDS.orders.update.filter(f => !SERVER_OWNED_FIELDS.has(f));

const PRE_PRODUCTION_STATUSES = ['Inquiry', 'Quote Approved', 'Deposit Paid', 'Material Check'];

// RPC error prefix → HTTP status
const RPC_ERRORS = {
  INVOICE_POSTED:       409,
  TOTAL_BELOW_PAYMENTS: 409,
  REASON_REQUIRED:      422,
  INVALID_ITEM:         422,
  ORDER_NOT_FOUND:      404,
};

function mapRpcError(error) {
  const msg  = String(error?.message || '');
  const code = (msg.match(/^([A-Z_]+)(?::|$)/) || [])[1];
  if (code && RPC_ERRORS[code]) {
    const text = msg.replace(/^[A-Z_]+:?\s*/, '') || code;
    return NextResponse.json({ error: text, code }, { status: RPC_ERRORS[code] });
  }
  return null;
}

export async function PATCH(request, props) {
  const params = await props.params;
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
      .select('id, status')
      .eq('id', orderId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // 4. Suspension guard — suspended orders are read-only
    const suspendErr = await checkOrderSuspended(orderId);
    if (suspendErr) return suspendErr;

    // 5. Line items — one atomic call, BEFORE metadata so a blocked financial
    //    change never leaves a half-saved edit behind.
    const items      = Array.isArray(body.items) ? body.items : [];
    const deletedIds = Array.isArray(body.deletedItemIds) ? body.deletedItemIds : [];
    const hasItemChanges = items.length > 0 || deletedIds.length > 0;

    let rpcResult = null;

    if (hasItemChanges) {
      const mayEditItems =
        ['admin', 'head_of_sales'].includes(role) ||
        (role === 'sales' && PRE_PRODUCTION_STATUSES.includes(existing.status));
      if (!mayEditItems) {
        return NextResponse.json(
          { error: 'You do not have permission to change line items on this order at its current stage', code: 'FORBIDDEN' },
          { status: 403 },
        );
      }

      // Whitelist each line; ids and order_id are never client-controlled
      // beyond identifying an existing line of THIS order (checked in the RPC).
      const cleanItems = items.map(item => ({
        id: item.id || null,
        ...pick(item, ALLOWED_FIELDS.order_items.insert.filter(
          f => !['order_id', 'line_type', 'vat_rate', 'net_amount', 'vat_amount', 'gross_amount'].includes(f),
        )),
      }));

      const { data, error } = await serviceClient.rpc('update_order_items_with_audit', {
        p_order_id:         orderId,
        p_items:            cleanItems,
        p_deleted_item_ids: deletedIds,
        p_reason:           typeof body.reason === 'string' ? body.reason : null,
        p_changed_by:       user.id,
      });

      if (error) {
        const mapped = mapRpcError(error);
        if (mapped) return mapped;
        console.error('PATCH /api/orders/[id] — update_order_items_with_audit:', error);
        return NextResponse.json({ error: 'Failed to save line items' }, { status: 500 });
      }
      rpcResult = data;
    }

    // 6. Order metadata (status and all money fields excluded)
    const safeUpdate = pick(body, ORDER_UPDATE_FIELDS);
    if (Object.keys(safeUpdate).length > 0) {
      const { error: updateErr } = await serviceClient
        .from('orders')
        .update(safeUpdate)
        .eq('id', orderId);

      if (updateErr) {
        console.error('PATCH /api/orders/[id] — order update:', updateErr);
        return NextResponse.json(
          { error: rpcResult ? 'Line items were saved but the order details failed to update' : 'Failed to update order' },
          { status: 500 },
        );
      }
    }

    // 7. Canonical order + items
    const [{ data: updated }, { data: updatedItems }] = await Promise.all([
      serviceClient.from('orders').select().eq('id', orderId).single(),
      serviceClient.from('order_items').select().eq('order_id', orderId).order('sort_order'),
    ]);

    return NextResponse.json({
      success:  true,
      data:     updated,
      items:    updatedItems || [],
      event_id: rpcResult?.event_id || null,
    });

  } catch (err) {
    console.error('PATCH /api/orders/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
