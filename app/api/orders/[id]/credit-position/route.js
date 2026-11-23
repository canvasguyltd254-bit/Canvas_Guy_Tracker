/**
 * app/api/orders/[id]/credit-position/route.js
 *
 * GET /api/orders/:id/credit-position — the numbers the credit approval will be checked against.
 *
 * Returns { customerName, limit, owed, thisOrder, afterApproval, available, withinLimit }.
 * Calls the SAME database function the approval uses (customer_credit_position), so the modal
 * can never show a different figure from the one that is enforced.
 *
 * Roles: those who may approve credit (admin, head_of_sales).
 * 422 CUSTOMER_REQUIRED       — order is not linked to a customer record
 * 422 CREDIT_LIMIT_NOT_SET    — the customer has no limit above 0
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const orderId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales']);
    if (authError) return authError;

    const { data: order } = await serviceClient
      .from('orders')
      .select('id, client, total_value, customer_id')
      .eq('id', orderId)
      .single();
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    if (!order.customer_id) {
      return NextResponse.json(
        { error: 'Link this order to a customer profile (Info tab → Customer profile) so their credit limit can be checked.', code: 'CUSTOMER_REQUIRED' },
        { status: 422 },
      );
    }

    const { data: pos, error } = await serviceClient.rpc('customer_credit_position', {
      p_customer_id: order.customer_id,
      p_exclude_order: orderId,
    });
    if (error || !pos) {
      console.error('GET /api/orders/[id]/credit-position:', error);
      return NextResponse.json({ error: 'Could not read the customer\'s credit position' }, { status: 500 });
    }

    const limit = Number(pos.limit) || 0;
    if (limit <= 0) {
      return NextResponse.json(
        { error: `${pos.customer_name} has no credit limit set. An admin sets it on the customer's page (Credit Limit).`, code: 'CREDIT_LIMIT_NOT_SET', customerName: pos.customer_name },
        { status: 422 },
      );
    }

    const { data: pays } = await serviceClient
      .from('order_payments')
      .select('amount')
      .eq('order_id', orderId)
      .is('reversed_at', null);
    const paid = (pays || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const thisOrder = Math.max(0, (parseFloat(order.total_value) || 0) - paid);

    const owed = Number(pos.outstanding) || 0;
    const afterApproval = owed + thisOrder;

    return NextResponse.json({
      customerName: pos.customer_name,
      limit,
      owed,
      thisOrder,
      afterApproval,
      available: Math.max(0, limit - owed),
      withinLimit: afterApproval <= limit,
    });
  } catch (err) {
    console.error('GET /api/orders/[id]/credit-position:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
