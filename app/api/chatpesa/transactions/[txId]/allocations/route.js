/**
 * app/api/chatpesa/transactions/[txId]/allocations/route.js
 *
 * POST   — RETIRED (410 Gone). Use /api/chatpesa/transactions/[txId]/split-allocations
 *          which executes the allocation atomically via a Postgres RPC, eliminating
 *          the race condition in the old JS-side read-then-insert pattern.
 *
 * DELETE ?allocation_id=uuid — remove one allocation (still active)
 *
 * After DELETE:
 *   1. Recalculates transaction match_status
 *   2. If purchase linked: recalculates supplier_purchases.amount_paid + payment_status
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function recalcTransactionStatus(txId, userId) {
  const [{ data: tx }, { data: allocs }] = await Promise.all([
    serviceClient.from('chatpesa_transactions').select('amount, match_status, tx_type').eq('id', txId).single(),
    serviceClient.from('chatpesa_payment_allocations').select('amount').eq('transaction_id', txId),
  ]);

  if (!tx || tx.tx_type !== 'debit') return;

  const allocated = (allocs || []).reduce((s, a) => s + parseFloat(a.amount || 0), 0);
  const txAmount  = parseFloat(tx.amount || 0);

  let status = 'unmatched';
  let matchedAt = null;
  if (allocated >= txAmount - 0.01) { status = 'matched';  matchedAt = new Date().toISOString(); }
  else if (allocated > 0)           { status = 'partial'; }

  await serviceClient
    .from('chatpesa_transactions')
    .update({ match_status: status, matched_at: matchedAt, matched_by: status === 'matched' ? userId : null })
    .eq('id', txId);
}


// ── POST ─────────────────────────────────────────────────────────────────────
// RETIRED — this endpoint performed allocation validation in two separate JS steps
// (read existing allocs, then insert) which is race-prone under concurrent requests.
// Use POST /api/chatpesa/transactions/[txId]/split-allocations instead, which
// executes the full allocation atomically inside a single Postgres RPC.

export async function POST() {
  return NextResponse.json(
    {
      error: 'This endpoint has been retired. Use POST /api/chatpesa/transactions/{txId}/split-allocations',
      replacement: '/api/chatpesa/transactions/{txId}/split-allocations',
    },
    { status: 410 },
  );
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const allocationId = searchParams.get('allocation_id');
    if (!allocationId) return NextResponse.json({ error: 'Missing allocation_id' }, { status: 400 });

    // Fetch allocation before deleting (need purchase_id for recalc + journal check)
    const { data: alloc } = await serviceClient
      .from('chatpesa_payment_allocations')
      .select('id, transaction_id, supplier_purchase_id, journal_entry_id')
      .eq('id', allocationId)
      .eq('transaction_id', params.txId)
      .single();

    if (!alloc) return NextResponse.json({ error: 'Allocation not found' }, { status: 404 });

    // Block deletion if this allocation is already posted to the General Ledger.
    // Deleting the allocation without reversing the journal would leave the ledger
    // overstating Chatpesa payments and understating the AP balance.
    if (alloc.journal_entry_id) {
      return NextResponse.json(
        {
          error: 'Cannot delete a posted allocation. This allocation has a journal entry in the General Ledger. Create a reversal first.',
          journal_entry_id: alloc.journal_entry_id,
        },
        { status: 409 },
      );
    }

    const { error } = await serviceClient
      .from('chatpesa_payment_allocations')
      .delete()
      .eq('id', allocationId);

    if (error) {
      console.error('DELETE allocation:', error);
      return NextResponse.json({ error: 'Failed to delete allocation' }, { status: 500 });
    }

    await Promise.all([
      recalcTransactionStatus(params.txId, user.id),
      recalcPurchasePayment(alloc.supplier_purchase_id, serviceClient),
    ]);

    return NextResponse.json({ success: true, message: 'Allocation removed' });
  } catch (err) {
    console.error('DELETE /api/chatpesa/transactions/[txId]/allocations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
