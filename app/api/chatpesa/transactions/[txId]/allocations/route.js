/**
 * app/api/chatpesa/transactions/[txId]/allocations/route.js
 *
 * POST   — add one allocation to a transaction (supports split: call multiple times)
 * DELETE ?allocation_id=uuid — remove one allocation
 *
 * After every POST/DELETE:
 *   1. Recalculates transaction match_status
 *   2. If purchase linked: recalculates supplier_purchases.amount_paid + payment_status
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';
import { postChatpesaAllocationJournal } from '@/shared/lib/accountingService';

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

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { allocation_type, supplier_purchase_id, supplier_id, petty_cash_category, amount, note } = body;

    // Validate amount
    const allocAmount = parseFloat(amount);
    if (!allocAmount || allocAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
    }

    // Validate transaction exists and is a debit
    const { data: tx } = await serviceClient
      .from('chatpesa_transactions')
      .select('id, tx_type, match_status, amount, transaction_date')
      .eq('id', params.txId)
      .single();

    if (!tx) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    if (tx.tx_type !== 'debit') return NextResponse.json({ error: 'Can only allocate debit transactions' }, { status: 400 });
    if (tx.match_status === 'ignored') return NextResponse.json({ error: 'Cannot allocate an ignored transaction' }, { status: 409 });

    // Validate allocation type + destination
    if (!['supplier_purchase','opening_balance','petty_cash'].includes(allocation_type)) {
      return NextResponse.json({ error: 'Invalid allocation_type' }, { status: 400 });
    }
    if (allocation_type === 'supplier_purchase' && !supplier_purchase_id) {
      return NextResponse.json({ error: 'supplier_purchase_id required for supplier_purchase allocation' }, { status: 400 });
    }
    if (allocation_type === 'opening_balance' && !supplier_id) {
      return NextResponse.json({ error: 'supplier_id required for opening_balance allocation' }, { status: 400 });
    }
    if (allocation_type === 'petty_cash') {
      if (!petty_cash_category?.trim()) {
        return NextResponse.json({ error: 'petty_cash_category is required for petty_cash allocation' }, { status: 400 });
      }
      if (!body.accounting_category_id) {
        return NextResponse.json({ error: 'accounting_category_id is required for petty_cash allocation' }, { status: 400 });
      }
    }

    // Overpayment guard — if allocating to a purchase, check remaining balance first
    if (allocation_type === 'supplier_purchase' && supplier_purchase_id) {
      const { data: purchase } = await serviceClient
        .from('supplier_purchases')
        .select('total_amount, amount_paid')
        .eq('id', supplier_purchase_id)
        .single();
      if (purchase) {
        const remaining = parseFloat(purchase.total_amount || 0) - parseFloat(purchase.amount_paid || 0);
        if (allocAmount > remaining + 0.01) {
          return NextResponse.json({
            error: `Overpayment: this purchase has KSh ${Math.round(remaining).toLocaleString()} remaining — allocating KSh ${Math.round(allocAmount).toLocaleString()} would exceed the total`,
          }, { status: 400 });
        }
      }
    }

    // Check we're not over-allocating
    const { data: existingAllocs } = await serviceClient
      .from('chatpesa_payment_allocations')
      .select('amount')
      .eq('transaction_id', params.txId);

    const alreadyAllocated = (existingAllocs || []).reduce((s, a) => s + parseFloat(a.amount || 0), 0);
    if (alreadyAllocated + allocAmount > parseFloat(tx.amount) + 0.01) {
      return NextResponse.json({
        error: `Over-allocation: transaction is KSh ${tx.amount}, already allocated KSh ${alreadyAllocated.toFixed(0)}, adding KSh ${allocAmount} would exceed total`,
      }, { status: 400 });
    }

    // accounting_category_id — required for petty_cash (validated above), optional otherwise
    const { accounting_category_id } = body;

    // Insert allocation
    const alloc = {
      transaction_id:       params.txId,
      allocation_type,
      amount:               allocAmount,
      note:                 note?.trim() || null,
      created_by:           user.id,
      supplier_purchase_id: allocation_type === 'supplier_purchase' ? supplier_purchase_id : null,
      supplier_id:          allocation_type === 'opening_balance'   ? supplier_id          : null,
      petty_cash_category:  allocation_type === 'petty_cash'        ? petty_cash_category  : null,
      accounting_category_id: accounting_category_id || null,
    };

    const { data, error } = await serviceClient
      .from('chatpesa_payment_allocations')
      .insert(alloc)
      .select()
      .single();

    if (error) {
      console.error('POST allocations:', error);
      return NextResponse.json({ error: 'Failed to create allocation' }, { status: 500 });
    }

    // Recalculate payment totals + transaction match status
    await Promise.all([
      recalcTransactionStatus(params.txId, user.id),
      recalcPurchasePayment(supplier_purchase_id, serviceClient),
    ]);

    // Accounting: post journal (fire-and-forget — allocation is already saved)
    // Use the Chatpesa transaction's own date — not today — to put the entry in
    // the correct accounting period.
    const allocationDate = tx.transaction_date || new Date().toISOString().split('T')[0];
    const { id: jId, error: jErr } = await postChatpesaAllocationJournal({
      allocationId:   data.id,
      allocationDate,
      amount:         allocAmount,
      allocationType: allocation_type,
      categoryId:     accounting_category_id || null,
      pettyLabel:     petty_cash_category || null,
      postedBy:       user.id,
      client:         serviceClient,
    });
    if (jId) {
      await serviceClient
        .from('chatpesa_payment_allocations')
        .update({ journal_entry_id: jId })
        .eq('id', data.id);
    } else if (jErr && !jErr.startsWith('SKIP:')) {
      console.error('POST allocations — accounting post failed:', jErr);
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/chatpesa/transactions/[txId]/allocations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
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
