/**
 * app/api/crm/quotations/[id]/hard-delete/route.js
 *
 * DELETE /api/crm/quotations/:id/hard-delete
 * Admin only.
 * Body: { confirmation: "QUO-007", reason: "Test data" }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ['admin']);
    if (authErr) return authErr;

    const quoteId = params.id;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { confirmation, reason } = body ?? {};
    if (!confirmation?.trim()) return NextResponse.json({ error: 'confirmation is required' }, { status: 400 });
    if (!reason?.trim())       return NextResponse.json({ error: 'reason is required' }, { status: 400 });

    const { data, error: rpcErr } = await serviceClient.rpc('hard_delete_quotation', {
      p_quote_id:     quoteId,
      p_confirmation: confirmation.trim(),
      p_reason:       reason.trim(),
      p_actor_id:     user.id,
    });

    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      if (msg.includes('QUOTE_NOT_FOUND'))       return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
      if (msg.includes('CONFIRMATION_MISMATCH')) return NextResponse.json({ error: 'Confirmation does not match quotation number' }, { status: 400 });
      if (msg.includes('NOT_DELETABLE'))         return NextResponse.json({ error: 'Quotation cannot be deleted', detail: msg }, { status: 409 });
      console.error('hard_delete_quotation rpc:', rpcErr);
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('DELETE /api/crm/quotations/[id]/hard-delete:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
