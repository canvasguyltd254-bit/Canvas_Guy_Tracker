/**
 * app/api/orders/[id]/status/route.js
 *
 * POST /api/orders/:id/status  — advance or send back order status
 *
 * Body: {
 *   newStatus: string,
 *   reason?: string,
 *   authorizedBy?: string,
 *   refundReference?: string,
 *   creditApprovalRef?: string,
 * }
 *
 * Roles:
 *  - Forward movement: ROLES_CAN_ADVANCE
 *  - Backward movement (rework): ROLES_CAN_REWORK
 *  Status is validated against STATUSES + REPAIR_STATUSES.
 *
 *  Credit approval side-effect:
 *  When creditApprovalRef is present, the server reads order.total_value
 *  and client_profiles.current_exposure from DB and writes the new exposure
 *  atomically — the client never touches this field.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import {
  STATUSES,
  REPAIR_STATUSES,
  REWORK_TARGETS,
  ROLES_CAN_ADVANCE,
  ROLES_CAN_REWORK,
} from '@/modules/orders/components/constants';

const ALL_VALID_STATUSES = new Set([...STATUSES, ...REPAIR_STATUSES]);
const REWORK_SOURCES = new Set(Object.keys(REWORK_TARGETS));

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth — determine roles after we know direction
    const { user, role } = await getAuthContext();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized: no active session' }, { status: 401 });
    }

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { newStatus, reason, authorizedBy, refundReference, creditApprovalRef } = body;

    // 3. Validate newStatus
    if (!newStatus || !ALL_VALID_STATUSES.has(newStatus)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of the defined STATUSES or REPAIR_STATUSES.` },
        { status: 400 },
      );
    }

    // 4. Fetch current order (include fields needed for GL + isCreditOrder)
    const { data: order, error: fetchErr } = await serviceClient
      .from('orders')
      .select('id, status, order_num, client, total_value, customer_type, payment_terms, invoice_journal_entry_id')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const oldStatus = order.status;

    // 5. Determine direction and gate roles
    const isRework = REWORK_SOURCES.has(oldStatus) && REWORK_TARGETS[oldStatus] === newStatus;

    if (isRework) {
      const authError = requireRole(user, role, ROLES_CAN_REWORK);
      if (authError) return authError;
    } else {
      const authError = requireRole(user, role, ROLES_CAN_ADVANCE);
      if (authError) return authError;
    }

    // 5a. Balance gate — block closing/completing with outstanding balance
    //     Admin can always override; all other roles are blocked.
    const CLOSE_STATUSES = new Set(['Closed', 'Redelivered']);
    if (CLOSE_STATUSES.has(newStatus)) {
      const totalValue = parseFloat(order.total_value) || 0;

      if (totalValue > 0) {
        const { data: payments } = await serviceClient
          .from('order_payments')
          .select('amount')
          .eq('order_id', orderId)
          .is('reversed_at', null);

        const totalPaid = (payments || []).reduce(
          (sum, p) => sum + (parseFloat(p.amount) || 0), 0
        );
        const balance = Math.round((totalValue - totalPaid) * 100) / 100;

        if (balance > 0.01 && role !== 'admin') {
          return NextResponse.json(
            {
              error: `Cannot close: KES ${Math.round(balance).toLocaleString('en-KE')} still outstanding. Record the payment first, or ask an admin to override.`,
            },
            { status: 422 },
          );
        }
      }
    }

    // 6. For forward moves, use the atomic advance_order_status RPC which posts
    //    GL journals AND updates the order status inside a single PostgreSQL
    //    transaction — eliminating the split-brain where GL posts but the status
    //    update fails (or vice-versa). For rework (backward) moves there is no GL
    //    side-effect, so we keep a direct row update.
    if (!isRework) {
      const extra = {};
      if (refundReference)   extra.refund_reference    = refundReference;
      if (creditApprovalRef) extra.credit_approval_ref = creditApprovalRef;

      const { error: rpcErr } = await serviceClient.rpc(
        'advance_order_status',
        {
          p_order_id:   orderId,
          p_new_status: newStatus,
          p_posted_by:  user.id,
          p_extra:      Object.keys(extra).length ? extra : {},
        },
      );

      if (rpcErr) {
        const msg = rpcErr.message || '';
        if (msg.includes('ORDER_NOT_FOUND'))  return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        if (msg.includes('SAME_STATUS'))      return NextResponse.json({ error: 'Order is already in that status' }, { status: 422 });
        console.error('advance_order_status RPC failed:', orderId, msg);
        return NextResponse.json({ error: `Failed to advance status: ${msg}` }, { status: 500 });
      }
    } else {
      // Rework (backward move) — no GL side-effects; direct row update is fine.
      const dbUpdateRaw = { status: newStatus };
      if (refundReference)   dbUpdateRaw.refund_reference    = refundReference;
      if (creditApprovalRef) dbUpdateRaw.credit_approval_ref = creditApprovalRef;

      const STATUS_UPDATE_FIELDS = ['status', 'refund_reference', 'credit_approval_ref'];
      const safeUpdate = pick(dbUpdateRaw, STATUS_UPDATE_FIELDS);

      const { error: updateErr } = await serviceClient
        .from('orders')
        .update(safeUpdate)
        .eq('id', orderId);

      if (updateErr) {
        console.error('POST /api/orders/[id]/status — rework update:', updateErr);
        return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
      }
    }

    // 8. Activity log
    const activityDescription = isRework
      ? `Status sent back: ${oldStatus} → ${newStatus}${reason ? ` — ${reason}` : ''}${authorizedBy ? ` (auth: ${authorizedBy})` : ''}`
      : `Status advanced: ${oldStatus} → ${newStatus}${reason ? ` — ${reason}` : ''}${authorizedBy ? ` (auth: ${authorizedBy})` : ''}`;

    await serviceClient.from('order_activities').insert(
      pick(
        {
          order_id: orderId,
          activity_type: isRework ? 'status_rework' : 'status_change',
          description: activityDescription,
        },
        ALLOWED_FIELDS.order_activities.insert,
      ),
    );

    return NextResponse.json({
      success: true,
      data: { orderId, oldStatus, newStatus },
    });

  } catch (err) {
    console.error('POST /api/orders/[id]/status:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
