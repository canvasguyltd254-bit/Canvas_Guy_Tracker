/**
 * app/api/crm/quotations/[id]/suspend/route.js
 *
 * POST   — suspend a quotation
 * DELETE — unsuspend a quotation
 *
 * Admin only. Does NOT touch quotations.status.
 * Each operation is atomic: the RPC updates the row AND writes the lifecycle
 * audit row in one transaction.
 *
 * Body (POST): { reason: string }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ADMIN_ONLY = ['admin'];

export async function POST(request, { params }) {
  try {
    // 1. Auth first — before any DB read
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const quoteId = params.id;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const reason = body?.reason?.trim();
    if (!reason) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    // 2. Atomic suspend via RPC
    const { data, error: rpcErr } = await serviceClient.rpc('suspend_quotation', {
      p_quote_id:  quoteId,
      p_reason:    reason,
      p_actor_id:  user.id,
    });

    if (rpcErr) {
      if (rpcErr.code === 'P0001') {
        return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
      }
      if (rpcErr.code === 'P0004') {
        return NextResponse.json({ error: 'Quotation is already suspended' }, { status: 409 });
      }
      console.error('POST /quotations/[id]/suspend RPC:', rpcErr);
      return NextResponse.json({ error: 'Failed to suspend quotation' }, { status: 500 });
    }

    return NextResponse.json({ suspended: true });
  } catch (err) {
    console.error('POST /api/crm/quotations/[id]/suspend:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req, { params }) {
  try {
    // 1. Auth first
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ADMIN_ONLY);
    if (authErr) return authErr;

    const quoteId = params.id;

    // 2. Atomic unsuspend via RPC
    const { data, error: rpcErr } = await serviceClient.rpc('unsuspend_quotation', {
      p_quote_id:  quoteId,
      p_actor_id:  user.id,
    });

    if (rpcErr) {
      if (rpcErr.code === 'P0001') {
        return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
      }
      if (rpcErr.code === 'P0005') {
        return NextResponse.json({ error: 'Quotation is not suspended' }, { status: 409 });
      }
      console.error('DELETE /quotations/[id]/suspend RPC:', rpcErr);
      return NextResponse.json({ error: 'Failed to unsuspend quotation' }, { status: 500 });
    }

    return NextResponse.json({ suspended: false });
  } catch (err) {
    console.error('DELETE /api/crm/quotations/[id]/suspend:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
