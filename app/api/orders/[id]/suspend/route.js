/**
 * app/api/orders/[id]/suspend/route.js
 *
 * POST   /api/orders/:id/suspend    — suspend an order
 * DELETE /api/orders/:id/suspend    — unsuspend an order
 *
 * Admin only. Suspension is orthogonal to workflow status — it does NOT change
 * orders.status. Each operation is atomic: the suspend_order / unsuspend_order
 * RPCs update the row AND write the lifecycle audit row in one transaction.
 *
 * POST body: { reason: string }   (required)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ADMIN_ONLY = ['admin'];

// ── POST: suspend ─────────────────────────────────────────────────────────────
export async function POST(request, { params }) {
  try {
    // 1. Auth first — before any DB read
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const orderId = params.id;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const reason = body?.reason?.trim();
    if (!reason) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    // 2. Atomic suspend — update + audit in one transaction via RPC
    const { data, error: rpcErr } = await serviceClient.rpc('suspend_order', {
      p_order_id:  orderId,
      p_reason:    reason,
      p_actor_id:  user.id,
    });

    if (rpcErr) {
      if (rpcErr.code === 'P0001') {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }
      if (rpcErr.code === 'P0004') {
        return NextResponse.json({ error: 'Order is already suspended' }, { status: 409 });
      }
      console.error('POST /suspend RPC:', rpcErr);
      return NextResponse.json({ error: 'Failed to suspend order' }, { status: 500 });
    }

    // 3. Activity log (best-effort — non-fatal if it fails)
    const { error: actErr } = await serviceClient.from('order_activities').insert({
      order_id:      orderId,
      activity_type: 'suspension',
      description:   `Order suspended: ${reason}`,
      created_by:    user.id,
    });
    if (actErr) console.warn('suspend activity log failed:', actErr.message);

    return NextResponse.json({ suspended: true });
  } catch (err) {
    console.error('POST /api/orders/[id]/suspend:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE: unsuspend ─────────────────────────────────────────────────────────
export async function DELETE(_req, { params }) {
  try {
    // 1. Auth first
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const orderId = params.id;

    // 2. Atomic unsuspend — update + audit in one transaction via RPC
    const { data, error: rpcErr } = await serviceClient.rpc('unsuspend_order', {
      p_order_id:  orderId,
      p_actor_id:  user.id,
    });

    if (rpcErr) {
      if (rpcErr.code === 'P0001') {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }
      if (rpcErr.code === 'P0005') {
        return NextResponse.json({ error: 'Order is not suspended' }, { status: 409 });
      }
      console.error('DELETE /suspend RPC:', rpcErr);
      return NextResponse.json({ error: 'Failed to unsuspend order' }, { status: 500 });
    }

    // 3. Activity log (best-effort)
    const { error: actErr } = await serviceClient.from('order_activities').insert({
      order_id:      orderId,
      activity_type: 'suspension',
      description:   'Suspension lifted by admin',
      created_by:    user.id,
    });
    if (actErr) console.warn('unsuspend activity log failed:', actErr.message);

    return NextResponse.json({ suspended: false });
  } catch (err) {
    console.error('DELETE /api/orders/[id]/suspend:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
