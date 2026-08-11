/**
 * app/api/orders/[id]/eligibility/route.js
 *
 * GET /api/orders/:id/eligibility
 *
 * Returns the suspension state and deletion eligibility for an order.
 * Admin only.
 *
 * Response shape:
 *   {
 *     suspended: bool,
 *     suspendedAt: string|null,
 *     suspensionReason: string|null,
 *     canSuspend: true,          -- always true for admin; any order can be suspended
 *     canDelete: bool,
 *     blockers: [{ code, count?, detail? }]
 *   }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ADMIN_ONLY = ['admin'];

export async function GET(_req, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const orderId = params.id;

    // Fetch suspension state from orders table
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select('id, order_num, status, suspended_at, suspended_by, suspension_reason')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Call RPC for eligibility check
    const { data: check, error: rpcErr } = await serviceClient
      .rpc('check_order_deletable', { p_order_id: orderId });

    if (rpcErr) {
      console.error('GET /eligibility rpc:', rpcErr);
      return NextResponse.json({ error: 'Eligibility check failed' }, { status: 500 });
    }

    return NextResponse.json({
      suspended:        order.suspended_at !== null,
      suspendedAt:      order.suspended_at,
      suspensionReason: order.suspension_reason,
      canSuspend:       true,
      canDelete:        check.canDelete,
      blockers:         check.blockers ?? [],
    });
  } catch (err) {
    console.error('GET /api/orders/[id]/eligibility:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
