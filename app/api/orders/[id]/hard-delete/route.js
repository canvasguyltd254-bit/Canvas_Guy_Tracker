/**
 * app/api/orders/[id]/hard-delete/route.js
 *
 * DELETE /api/orders/:id/hard-delete
 *
 * Permanently deletes a clean, early-stage order. Admin only.
 * The transactional RPC hard_delete_order re-runs all eligibility checks
 * inside the same transaction — the client-side eligibility check is for UX only.
 *
 * Body: { confirmation: "ORD-042", reason: "Created by mistake" }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ADMIN_ONLY = ['admin'];

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const orderId = params.id;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { confirmation, reason } = body ?? {};

    if (!confirmation?.trim()) {
      return NextResponse.json({ error: 'confirmation is required' }, { status: 400 });
    }
    if (!reason?.trim()) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    const { data, error: rpcErr } = await serviceClient.rpc('hard_delete_order', {
      p_order_id:     orderId,
      p_confirmation: confirmation.trim(),
      p_reason:       reason.trim(),
      p_actor_id:     user.id,
    });

    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      if (msg.includes('ORDER_NOT_FOUND')) {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }
      if (msg.includes('CONFIRMATION_MISMATCH')) {
        return NextResponse.json({ error: 'Confirmation does not match order number' }, { status: 400 });
      }
      if (msg.includes('NOT_DELETABLE')) {
        return NextResponse.json({ error: 'Order cannot be deleted — it has linked records', detail: msg }, { status: 409 });
      }
      console.error('hard_delete_order rpc:', rpcErr);
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('DELETE /api/orders/[id]/hard-delete:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
