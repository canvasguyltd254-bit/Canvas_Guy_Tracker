/**
 * app/api/chatpesa/transactions/[txId]/route.js
 *
 * GET   /api/chatpesa/transactions/:id  — fetch single transaction + allocations
 * PATCH /api/chatpesa/transactions/:id  — update match_status (ignore / unignore)
 *
 * Also used as the list endpoint:
 * GET   /api/chatpesa/transactions      — via parent route below
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: tx, error } = await serviceClient
      .from('chatpesa_transactions')
      .select(`
        *,
        suggested_supplier:suppliers!suggested_supplier_id(id, name),
        chatpesa_payment_allocations(
          id, allocation_type, amount, note, petty_cash_category, created_at,
          supplier_purchase:supplier_purchases(id, purchase_date, items_bought, total_amount, amount_paid),
          supplier:suppliers!supplier_id(id, name)
        )
      `)
      .eq('id', params.txId)
      .single();

    if (error || !tx) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: tx });
  } catch (err) {
    console.error('GET /api/chatpesa/transactions/[txId]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { action } = body;

    // Fetch current transaction
    const { data: tx } = await serviceClient
      .from('chatpesa_transactions')
      .select('id, match_status, tx_type')
      .eq('id', params.txId)
      .single();

    if (!tx) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

    // Only debits can be ignored/unignored
    if (tx.tx_type !== 'debit') {
      return NextResponse.json({ error: 'Only debit transactions can be actioned' }, { status: 400 });
    }

    let update = {};

    if (action === 'ignore') {
      if (tx.match_status === 'matched') {
        return NextResponse.json({ error: 'Cannot ignore a matched transaction — remove allocations first' }, { status: 409 });
      }
      update = { match_status: 'ignored', ignored_at: new Date().toISOString(), ignored_by: user.id };
    } else if (action === 'unignore') {
      if (tx.match_status !== 'ignored') {
        return NextResponse.json({ error: 'Transaction is not ignored' }, { status: 400 });
      }
      update = { match_status: 'unmatched', ignored_at: null, ignored_by: null };
    } else {
      return NextResponse.json({ error: 'Invalid action — use "ignore" or "unignore"' }, { status: 400 });
    }

    const { data, error } = await serviceClient
      .from('chatpesa_transactions')
      .update(update)
      .eq('id', params.txId)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/chatpesa/transactions/[txId]:', error);
      return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/chatpesa/transactions/[txId]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
