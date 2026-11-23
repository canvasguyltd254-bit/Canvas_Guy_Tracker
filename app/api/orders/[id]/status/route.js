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
 *  Extra role rules enforced here (the database enforces the rest):
 *  - Cancel / refund: ROLES_CAN_REFUND
 *  - Sales: only up to SALES_MAX_ADVANCE_TO (explicit allow-list)
 *  - Credit approval (Quote Approved → Material Check): admin, or head_of_sales up to
 *    HEAD_OF_SALES_CREDIT_LIMIT
 *
 *  Credit approval is checked in advance_order_status(): credit terms, approval reference,
 *  an order linked to a customer, and that customer's credit limit (Customers screen)
 *  against what they already owe. Nothing is stored per order; the customer's balance is
 *  derived from order status and payments.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { checkOrderSuspended } from '@/shared/lib/suspendGuard';
import {
  STATUSES,
  REPAIR_STATUSES,
  REWORK_TARGETS,
  ROLES_CAN_ADVANCE,
  ROLES_CAN_REWORK,
  ROLES_CAN_REFUND,
  SALES_MAX_ADVANCE_TO,
  HEAD_OF_SALES_CREDIT_LIMIT,
} from '@/modules/orders/components/constants';

// Who may approve credit (skip Deposit Paid). Head of Sales is capped by order value.
const ROLES_CAN_APPROVE_CREDIT = ['admin', 'head_of_sales'];

const ALL_VALID_STATUSES = new Set([...STATUSES, ...REPAIR_STATUSES]);
const REWORK_SOURCES = new Set(Object.keys(REWORK_TARGETS));

export async function POST(request, props) {
  const params = await props.params;
  try {
    const orderId = params.id;

    // 0. Auth — must happen before any DB reads to avoid leaking data to unauthenticated callers
    const { user, role } = await getAuthContext();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized: no active session' }, { status: 401 });
    }

    // 1. Suspension gate — block all status changes on suspended orders
    const suspendedErr = await checkOrderSuspended(orderId);
    if (suspendedErr) return suspendedErr;

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

      // Refund / cancel: refund roles only (the UI hides the button, the server must enforce it).
      if (newStatus === 'Cancelled / Refunded') {
        const refundErr = requireRole(user, role, ROLES_CAN_REFUND);
        if (refundErr) return refundErr;
      } else if (role === 'sales') {
        // Sales may move an order only to a status up to SALES_MAX_ADVANCE_TO (Deposit Paid).
        // Explicit allow-list: repair/return statuses (Assessed, In Repair, QC ...) are not in
        // STATUSES, so a ceiling test with indexOf() would let them through.
        const salesMayReach = STATUSES.slice(0, STATUSES.indexOf(SALES_MAX_ADVANCE_TO) + 1);
        if (!salesMayReach.includes(newStatus)) {
          return NextResponse.json(
            { error: `Sales can advance orders only up to ${SALES_MAX_ADVANCE_TO}.` },
            { status: 403 },
          );
        }
      }

      // Credit approval = skipping Deposit Paid (Quote Approved → Material Check).
      // Admin, or Head of Sales up to the approval cap. Never Sales or production roles.
      if (oldStatus === 'Quote Approved' && newStatus === 'Material Check') {
        const creditErr = requireRole(user, role, ROLES_CAN_APPROVE_CREDIT);
        if (creditErr) return creditErr;
        if (role === 'head_of_sales' && (parseFloat(order.total_value) || 0) > HEAD_OF_SALES_CREDIT_LIMIT) {
          return NextResponse.json(
            { error: `Head of Sales can approve credit only up to KES ${HEAD_OF_SALES_CREDIT_LIMIT.toLocaleString('en-KE')}. This order needs an admin.` },
            { status: 403 },
          );
        }
      }
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
        if (msg.includes('INVALID_TRANSITION')) {
          return NextResponse.json({ error: `Cannot move an order from ${oldStatus} to ${newStatus}.` }, { status: 422 });
        }
        if (msg.includes('DEPOSIT_PAYMENT_REQUIRED') || msg.includes('NO_UNPOSTED_PAYMENTS')) {
          return NextResponse.json(
            { error: 'Record a deposit payment on this order before moving it to Deposit Paid. Reversed payments do not count, and a payment that is already posted cannot be used again.' },
            { status: 422 },
          );
        }
        if (msg.includes('CUSTOMER_REQUIRED')) {
          return NextResponse.json(
            { error: 'Link this order to a customer profile (Info tab → Customer profile) so their credit limit can be checked, then try again.' },
            { status: 422 },
          );
        }
        if (msg.includes('CREDIT_LIMIT_NOT_SET')) {
          return NextResponse.json(
            { error: 'This customer has no credit limit set, so credit cannot be approved. An admin sets it on the customer\'s page (Credit Limit), then try again.' },
            { status: 422 },
          );
        }
        if (msg.includes('CREDIT_LIMIT_EXCEEDED')) {
          return NextResponse.json({ error: 'This order would take the customer over their credit limit (what they already owe plus this order). An admin must raise the limit or the customer must pay down first.' }, { status: 422 });
        }
        if (msg.includes('REFUND_REFERENCE_REQUIRED')) {
          return NextResponse.json({ error: 'A refund reference is required.' }, { status: 422 });
        }
        if (msg.includes('DEPOSIT_REQUIRED')) {
          return NextResponse.json(
            { error: 'This order is not on credit terms (30 day, 60 day or custom), so it cannot skip Deposit Paid. Record the deposit and advance to Deposit Paid, or change the order\'s payment terms.' },
            { status: 422 },
          );
        }
        if (msg.includes('CREDIT_APPROVAL_REQUIRED')) {
          return NextResponse.json({ error: 'A credit approval reference is required to skip Deposit Paid.' }, { status: 422 });
        }
        console.error('advance_order_status RPC failed:', orderId, msg);
        return NextResponse.json({ error: `Failed to advance status: ${msg}` }, { status: 500 });
      }
    } else {
      // Rework (backward move) — no GL side-effects; direct row update is fine.
      // Send-back changes the status only. Refund / credit references are never set here.
      const { error: updateErr } = await serviceClient
        .from('orders')
        .update(pick({ status: newStatus }, ['status']))
        .eq('id', orderId);

      if (updateErr) {
        console.error('POST /api/orders/[id]/status — rework update:', updateErr);
        return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
      }
      // Nothing to release on send-back: a customer's exposure is derived from order status and
      // payments (customer_credit_position), so an order back at Quote Approved stops counting
      // by itself, and re-approval cannot count it twice.
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
