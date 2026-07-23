/**
 * app/api/accounting/review/retry/route.js
 *
 * POST /api/accounting/review/retry
 *
 * Retries journal posting for a single unposted record.
 *
 * IDEMPOTENCY: Before calling the accounting service, each branch checks whether a
 * journal_entry already exists for the source record (by source_id). If one is found,
 * the endpoint re-links it rather than posting a second journal. This means the endpoint
 * is safe to call multiple times even if a prior call posted the journal but failed to
 * write back the journal_entry_id.
 *
 * Request body:
 *   {
 *     source_type:             'supplier_purchase' | 'purchase' (alias) |
 *                              'manual_payment' | 'chatpesa_allocation' |
 *                              'supplier_opening_balance'
 *     source_id:               uuid
 *     accounting_category_id?: uuid   — optional; writes category to the purchase
 *                                       before posting (fixes "No category" errors)
 *   }
 *
 * Response:
 *   200 { success: true, journal_entry_id: uuid }
 *   400 { error: string }
 *   404 { error: 'Record not found' }
 *   409 { error: 'Already posted' }
 *   422 { error: string }   — journal posted but source linking failed
 *   500 { error: string }
 *
 * Required role: admin | production_manager | head_of_sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import {
  postPurchaseJournal,
  postManualPaymentJournal,
  postChatpesaAllocationJournal,
  postOpeningBalanceJournal,
} from '@/shared/lib/accountingService';

// 'purchase' is what postJournal/accountingService writes to journal_entries.source_type.
// Posting errors inherit that value.  Normalise to 'supplier_purchase' before branching.
const VALID_SOURCE_TYPES = [
  'supplier_purchase',
  'purchase',                  // alias — normalised below
  'manual_payment',
  'chatpesa_allocation',
  'supplier_opening_balance',
];

/**
 * Looks up an existing journal entry for a source record by source_id.
 * Used to recover from partial failures where the journal was posted but the
 * journal_entry_id was not written back to the source table.
 *
 * source_id UUIDs are unique within journal_entries in normal operation —
 * a given purchase / payment / allocation should never have two journal rows.
 */
async function findExistingJournal(sourceId) {
  const { data } = await serviceClient
    .from('journal_entries')
    .select('id')
    .eq('source_id', sourceId)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Writes journal_entry_id back to a source table after posting.
 * Returns { error } on failure; null on success.
 */
async function linkJournal(table, column, journalId, sourceId) {
  const { error } = await serviceClient
    .from(table)
    .update({ [column]: journalId })
    .eq('id', sourceId);
  return error ?? null;
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    // production_manager and head_of_sales can see this screen; they should also be able to retry
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { source_id, accounting_category_id } = body;
    const rawType = body.source_type;

    if (!rawType || !VALID_SOURCE_TYPES.includes(rawType)) {
      return NextResponse.json({
        error: `source_type must be one of: ${VALID_SOURCE_TYPES.filter(t => t !== 'purchase').join(', ')}`,
      }, { status: 400 });
    }
    if (!source_id) {
      return NextResponse.json({ error: 'source_id is required' }, { status: 400 });
    }

    // Normalise 'purchase' alias → 'supplier_purchase'
    const source_type = rawType === 'purchase' ? 'supplier_purchase' : rawType;

    let result;

    // ── supplier_purchase ────────────────────────────────────────
    if (source_type === 'supplier_purchase') {
      const { data: sp } = await serviceClient
        .from('supplier_purchases')
        .select('id, purchase_date, total_amount, items_bought, accounting_category_id, journal_entry_id')
        .eq('id', source_id)
        .single();

      if (!sp) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
      if (sp.journal_entry_id) return NextResponse.json({ error: 'Already posted' }, { status: 409 });

      // Recovery: if a journal was posted in a prior call but linking failed,
      // re-link the existing journal instead of posting a duplicate.
      const existingJeId = await findExistingJournal(source_id);
      if (existingJeId) {
        result = { id: existingJeId };
      } else {
        // If the caller supplies an accounting_category_id (e.g. from the "Assign Category"
        // UI action), write it to the purchase first so the journal gets the correct category.
        const effectiveCategoryId = accounting_category_id || sp.accounting_category_id;
        if (accounting_category_id && accounting_category_id !== sp.accounting_category_id) {
          const { error: catErr } = await serviceClient
            .from('supplier_purchases')
            .update({ accounting_category_id })
            .eq('id', source_id);
          if (catErr) {
            console.error('retry: failed to update accounting_category_id on supplier_purchase:', catErr.message);
            return NextResponse.json({ error: 'Failed to assign category — journal not posted' }, { status: 422 });
          }
        }

        result = await postPurchaseJournal({
          purchaseId:   sp.id,
          purchaseDate: sp.purchase_date,
          totalAmount:  parseFloat(sp.total_amount),
          categoryId:   effectiveCategoryId,
          description:  sp.items_bought,
          postedBy:     user.id,
          client:       serviceClient,
        });
      }

      if (result.id) {
        const linkErr = await linkJournal('supplier_purchases', 'journal_entry_id', result.id, source_id);
        if (linkErr) {
          console.error('retry: failed to write journal_entry_id to supplier_purchase:', linkErr.message);
          return NextResponse.json(
            { error: `Journal ${result.id} was posted but source linking failed — call retry again to re-link without re-posting` },
            { status: 422 },
          );
        }
      }
    }

    // ── manual_payment ───────────────────────────────────────────
    else if (source_type === 'manual_payment') {
      const { data: mp } = await serviceClient
        .from('manual_supplier_payments')
        .select('id, payment_date, amount, payment_method, journal_entry_id')
        .eq('id', source_id)
        .single();

      if (!mp) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
      if (mp.journal_entry_id) return NextResponse.json({ error: 'Already posted' }, { status: 409 });

      // Recovery: re-link if journal already exists from a prior partial call
      const existingJeId = await findExistingJournal(source_id);
      if (existingJeId) {
        result = { id: existingJeId };
      } else {
        result = await postManualPaymentJournal({
          paymentId:     mp.id,
          paymentDate:   mp.payment_date,
          amount:        parseFloat(mp.amount),
          paymentMethod: mp.payment_method,
          postedBy:      user.id,
          client:        serviceClient,
        });
      }

      if (result.id) {
        const linkErr = await linkJournal('manual_supplier_payments', 'journal_entry_id', result.id, source_id);
        if (linkErr) {
          console.error('retry: failed to write journal_entry_id to manual_supplier_payment:', linkErr.message);
          return NextResponse.json(
            { error: `Journal ${result.id} was posted but source linking failed — call retry again to re-link without re-posting` },
            { status: 422 },
          );
        }
      }
    }

    // ── chatpesa_allocation ──────────────────────────────────────
    else if (source_type === 'chatpesa_allocation') {
      const { data: ca } = await serviceClient
        .from('chatpesa_payment_allocations')
        .select(`
          id, amount, allocation_type, accounting_category_id, petty_cash_category, journal_entry_id,
          chatpesa_transactions!inner(transaction_date)
        `)
        .eq('id', source_id)
        .single();

      if (!ca) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
      if (ca.journal_entry_id) return NextResponse.json({ error: 'Already posted' }, { status: 409 });

      // Recovery: re-link if journal already exists from a prior partial call
      const existingJeId = await findExistingJournal(source_id);
      if (existingJeId) {
        result = { id: existingJeId };
      } else {
        result = await postChatpesaAllocationJournal({
          allocationId:   ca.id,
          allocationDate: ca.chatpesa_transactions?.transaction_date,
          amount:         parseFloat(ca.amount),
          allocationType: ca.allocation_type,
          categoryId:     ca.accounting_category_id || null,
          pettyLabel:     ca.petty_cash_category || null,
          postedBy:       user.id,
          client:         serviceClient,
        });
      }

      if (result.id) {
        const linkErr = await linkJournal('chatpesa_payment_allocations', 'journal_entry_id', result.id, source_id);
        if (linkErr) {
          console.error('retry: failed to write journal_entry_id to chatpesa_payment_allocation:', linkErr.message);
          return NextResponse.json(
            { error: `Journal ${result.id} was posted but source linking failed — call retry again to re-link without re-posting` },
            { status: 422 },
          );
        }
      }
    }

    // ── supplier_opening_balance ─────────────────────────────────
    else if (source_type === 'supplier_opening_balance') {
      const { data: supplier } = await serviceClient
        .from('suppliers')
        .select('id, name, opening_balance, opening_balance_date, opening_balance_journal_entry_id')
        .eq('id', source_id)
        .single();

      if (!supplier) return NextResponse.json({ error: 'Record not found' }, { status: 404 });
      if (supplier.opening_balance_journal_entry_id) {
        return NextResponse.json({ error: 'Already posted' }, { status: 409 });
      }
      if (!supplier.opening_balance || parseFloat(supplier.opening_balance) <= 0) {
        return NextResponse.json({ error: 'Supplier has no opening balance to post' }, { status: 400 });
      }

      // Recovery: re-link if journal already exists from a prior partial call
      const existingJeId = await findExistingJournal(source_id);
      if (existingJeId) {
        result = { id: existingJeId };
      } else {
        result = await postOpeningBalanceJournal({
          supplierId:     supplier.id,
          openingBalance: parseFloat(supplier.opening_balance),
          balanceDate:    supplier.opening_balance_date || new Date().toISOString().split('T')[0],
          supplierName:   supplier.name,
          postedBy:       user.id,
          client:         serviceClient,
        });
      }

      if (result.id) {
        const linkErr = await linkJournal('suppliers', 'opening_balance_journal_entry_id', result.id, source_id);
        if (linkErr) {
          console.error('retry: failed to write opening_balance_journal_entry_id to supplier:', linkErr.message);
          return NextResponse.json(
            { error: `Journal ${result.id} was posted but source linking failed — call retry again to re-link without re-posting` },
            { status: 422 },
          );
        }
      }
    }

    if (!result?.id) {
      // postJournal() already writes to accounting_posting_errors on failure —
      // do NOT insert a second row here (would cause duplicate error entries).
      return NextResponse.json({
        error: result?.error || 'Posting failed — error logged to review queue',
      }, { status: 422 });
    }

    // ── Resolve posting_error rows for this source ────────────────
    // accountingService writes source_type = 'purchase' for supplier_purchases, so
    // error rows for that type may be stored as either 'purchase' or 'supplier_purchase'
    // depending on which path wrote them. Resolve all known aliases unconditionally.
    const typesToResolve = new Set([rawType, source_type]);
    if (source_type === 'supplier_purchase') typesToResolve.add('purchase');

    await Promise.all([...typesToResolve].map(t =>
      serviceClient
        .from('accounting_posting_errors')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('source_type', t)
        .eq('source_id',   source_id)
        .eq('resolved',    false),
    ));

    return NextResponse.json({ success: true, journal_entry_id: result.id });
  } catch (err) {
    console.error('POST /api/accounting/review/retry:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
