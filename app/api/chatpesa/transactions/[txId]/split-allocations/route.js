/**
 * app/api/chatpesa/transactions/[txId]/split-allocations/route.js
 *
 * POST /api/chatpesa/transactions/:id/split-allocations
 *
 * Atomically saves an entire split allocation via the allocate_chatpesa_split
 * PostgreSQL RPC.  The RPC holds a FOR UPDATE lock on the transaction row,
 * preventing concurrent over-allocation or per-purchase aggregate errors.
 *
 * Request body:
 *   {
 *     allocations: [
 *       {
 *         allocation_type:        'supplier_purchase' | 'opening_balance' | 'petty_cash'
 *         supplier_purchase_id?:  uuid    (required for supplier_purchase)
 *         supplier_id?:           uuid    (required for opening_balance)
 *         petty_cash_category?:   string  (required for petty_cash)
 *         accounting_category_id?: uuid   (required for petty_cash)
 *         amount:                 number
 *         note?:                  string
 *       },
 *       ...
 *     ]
 *   }
 *
 * Atomicity guarantee:
 *   Lock → validate → per-purchase aggregate check → insert all rows →
 *   update match_status all happen inside one PostgreSQL transaction.
 *   Journal posting and recalcPurchasePayment remain best-effort after
 *   the DB commit — a failure there does NOT return 500 to the caller.
 *
 * Response:
 *   201 { success: true, data: [allocation, ...] }
 *   400 { error: string }
 *   404 { error: 'Transaction not found' }
 *   409 { error: 'Over-allocation ...' }
 *   500 { error: string }
 */

export const runtime = 'nodejs';

import { NextResponse }                     from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment }            from '@/shared/lib/recalcPurchasePayment';
import { postChatpesaAllocationJournal }    from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];
const VALID_TYPES = ['supplier_purchase', 'opening_balance', 'petty_cash'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { allocations } = body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      return NextResponse.json({ error: 'allocations must be a non-empty array' }, { status: 400 });
    }

    // ── Load and validate the transaction ────────────────────────
    const { data: tx } = await serviceClient
      .from('chatpesa_transactions')
      .select('id, tx_type, match_status, amount, transaction_date')
      .eq('id', params.txId)
      .single();

    if (!tx)                          return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    if (tx.tx_type !== 'debit')       return NextResponse.json({ error: 'Can only allocate debit transactions' }, { status: 400 });
    if (tx.match_status === 'ignored') return NextResponse.json({ error: 'Cannot allocate an ignored transaction' }, { status: 409 });

    // ── Format-validate each allocation (JS-side only) ────────────
    for (const [i, a] of allocations.entries()) {
      const label = `Allocation ${i + 1}`;

      if (!VALID_TYPES.includes(a.allocation_type)) {
        return NextResponse.json({ error: `${label}: invalid allocation_type "${a.allocation_type}"` }, { status: 400 });
      }

      const amt = parseFloat(a.amount);
      if (!amt || amt <= 0) {
        return NextResponse.json({ error: `${label}: amount must be a positive number` }, { status: 400 });
      }

      if (a.allocation_type === 'supplier_purchase' && !a.supplier_purchase_id) {
        return NextResponse.json({ error: `${label}: supplier_purchase_id is required` }, { status: 400 });
      }
      if (a.allocation_type === 'opening_balance' && !a.supplier_id) {
        return NextResponse.json({ error: `${label}: supplier_id is required` }, { status: 400 });
      }
      if (a.allocation_type === 'petty_cash') {
        if (!a.petty_cash_category?.trim()) {
          return NextResponse.json({ error: `${label}: petty_cash_category is required` }, { status: 400 });
        }
        if (!a.accounting_category_id) {
          return NextResponse.json({ error: `${label}: accounting_category_id is required` }, { status: 400 });
        }
      }
    }

    // ── RPC: lock → validate → aggregate-check → insert → match_status ──
    // All DB work is done atomically inside allocate_chatpesa_split().
    // The RPC holds a FOR UPDATE lock on the transaction row which prevents
    // concurrent over-allocation and per-purchase aggregate errors.
    const { data: rpcResult, error: rpcErr } = await serviceClient.rpc(
      'allocate_chatpesa_split',
      {
        p_transaction_id: params.txId,
        p_allocations:    allocations,
        p_created_by:     user.id,
      }
    );

    if (rpcErr) {
      const msg = rpcErr.message || '';
      if (msg.includes('TX_NOT_FOUND'))      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      if (msg.includes('TX_NOT_DEBIT'))      return NextResponse.json({ error: 'Can only allocate debit transactions' }, { status: 400 });
      if (msg.includes('TX_IGNORED'))        return NextResponse.json({ error: 'Cannot allocate an ignored transaction' }, { status: 409 });
      if (msg.includes('OVER_ALLOCATION'))   return NextResponse.json({ error: msg.replace(/^OVER_ALLOCATION:\s*/,   '') }, { status: 409 });
      if (msg.includes('PURCHASE_OVERPAID')) return NextResponse.json({ error: msg.replace(/^PURCHASE_OVERPAID:\s*/, '') }, { status: 400 });
      console.error('POST split-allocations — RPC error:', rpcErr);
      return NextResponse.json({ error: 'Failed to save allocations' }, { status: 500 });
    }

    const inserted       = rpcResult?.inserted || [];
    const allocationDate = tx.transaction_date || new Date().toISOString().split('T')[0];

    // ── Post-commit: journal posting (best-effort) ────────────────
    // Failures here must NOT return 500 — allocations are already committed.
    try {
      for (const savedAlloc of inserted) {
        const { id: jId, error: jErr } = await postChatpesaAllocationJournal({
          allocationId:   savedAlloc.id,
          allocationDate,
          amount:         parseFloat(savedAlloc.amount),
          allocationType: savedAlloc.allocation_type,
          categoryId:     savedAlloc.accounting_category_id || null,
          pettyLabel:     savedAlloc.petty_cash_category    || null,
          postedBy:       user.id,
          client:         serviceClient,
        });

        if (jId) {
          await serviceClient
            .from('chatpesa_payment_allocations')
            .update({ journal_entry_id: jId })
            .eq('id', savedAlloc.id);
        } else if (jErr && !jErr.startsWith('SKIP:')) {
          console.error(`POST split-allocations — journal post failed for allocation ${savedAlloc.id}:`, jErr);
        }
      }
    } catch (journalErr) {
      console.error('POST split-allocations — journal posting threw (allocations saved):', journalErr);
    }

    // ── Post-commit: recalc purchase payment caches (best-effort) ─
    const affectedPurchaseIds = [...new Set(
      inserted
        .filter(a => a.supplier_purchase_id)
        .map(a => a.supplier_purchase_id)
    )];
    try {
      await Promise.all(affectedPurchaseIds.map(pid => recalcPurchasePayment(pid, serviceClient)));
    } catch (recalcErr) {
      console.error('POST split-allocations — recalc threw (allocations saved):', recalcErr);
    }

    return NextResponse.json({ success: true, data: inserted }, { status: 201 });
  } catch (err) {
    console.error('POST /api/chatpesa/transactions/[txId]/split-allocations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
