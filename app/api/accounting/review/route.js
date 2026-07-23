/**
 * app/api/accounting/review/route.js
 *
 * GET /api/accounting/review
 *
 * Returns a complete snapshot of the GL health for the admin review screen:
 *
 *   unposted.supplier_purchases       — supplier_purchases with journal_entry_id IS NULL
 *   unposted.manual_payments          — manual_supplier_payments with journal_entry_id IS NULL
 *   unposted.chatpesa_allocations     — chatpesa_payment_allocations with journal_entry_id IS NULL
 *   unposted.supplier_opening_balances — suppliers with opening_balance > 0 and no journal
 *
 *   posting_errors                    — accounting_posting_errors where resolved = false
 *   reversal_history                  — journal_entries with source_type = 'reversal', newest first
 *
 * Required role: admin | production_manager | head_of_sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const REVIEW_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, REVIEW_ROLES);
    if (authError) return authError;

    const [
      { data: purchases,       error: purchasesErr,    count: purchasesCount    },
      { data: manualPayments,  error: manualErr,        count: manualCount       },
      { data: chatpesaAllocs,  error: chatpesaErr,      count: chatpesaCount     },
      { data: obSuppliers,     error: obErr                                       },
      { data: postingErrors,   error: postingErr,       count: errorsCount       },
      { data: reversalHistory, error: reversalErr,      count: reversalCount     },
    ] = await Promise.all([

      // Unposted supplier purchases — include supplier + category label for display
      // { count: 'exact' } gives the true total independent of .limit()
      serviceClient
        .from('supplier_purchases')
        .select(`
          id, purchase_date, total_amount, items_bought, accounting_category_id, created_at,
          suppliers!inner(name),
          accounting_categories(label)
        `, { count: 'exact' })
        .is('journal_entry_id', null)
        .order('purchase_date', { ascending: false })
        .limit(200),

      // Unposted manual payments
      serviceClient
        .from('manual_supplier_payments')
        .select(`
          id, payment_date, amount, payment_method, reference, created_at,
          suppliers!inner(name)
        `, { count: 'exact' })
        .is('journal_entry_id', null)
        .order('payment_date', { ascending: false })
        .limit(200),

      // Unposted Chatpesa allocations
      serviceClient
        .from('chatpesa_payment_allocations')
        .select(`
          id, amount, allocation_type, petty_cash_category, created_at,
          chatpesa_transactions!inner(transaction_date, amount),
          suppliers(name),
          supplier_purchases(supplier_id, suppliers(name))
        `, { count: 'exact' })
        .is('journal_entry_id', null)
        .order('created_at', { ascending: false })
        .limit(200),

      // Supplier opening balances not yet journalised (no limit — typically few rows)
      serviceClient
        .from('suppliers')
        .select('id, name, opening_balance, opening_balance_date, created_at')
        .is('opening_balance_journal_entry_id', null)
        .gt('opening_balance', 0)
        .order('name', { ascending: true }),

      // Unresolved posting errors
      serviceClient
        .from('accounting_posting_errors')
        .select('id, source_type, source_id, error_message, attempted_at, resolved', { count: 'exact' })
        .eq('resolved', false)
        .order('attempted_at', { ascending: false })
        .limit(200),

      // Reversal history — all reversal entries, newest first
      serviceClient
        .from('journal_entries')
        .select('id, entry_date, description, source_id, posted_at, posted_by', { count: 'exact' })
        .eq('source_type', 'reversal')
        .order('posted_at', { ascending: false })
        .limit(100),
    ]);

    // Surface any query failures rather than silently returning empty arrays
    if (purchasesErr || manualErr || chatpesaErr || obErr || postingErr || reversalErr) {
      const first = purchasesErr || manualErr || chatpesaErr || obErr || postingErr || reversalErr;
      console.error('GET /api/accounting/review — query error:', first);
      return NextResponse.json({ error: 'Failed to load GL data' }, { status: 500 });
    }

    // Shape unposted purchases for the UI
    // Note: column is `label` not `name` in accounting_categories
    const shapedPurchases = (purchases || []).map(p => ({
      id:                     p.id,
      date:                   p.purchase_date,
      amount:                 parseFloat(p.total_amount || 0),
      description:            p.items_bought || '—',
      supplier_name:          p.suppliers?.name || '—',
      category_name:          p.accounting_categories?.label || null,
      accounting_category_id: p.accounting_category_id || null,
      created_at:             p.created_at,
    }));

    // Shape unposted manual payments
    const shapedManual = (manualPayments || []).map(m => ({
      id:             m.id,
      date:           m.payment_date,
      amount:         parseFloat(m.amount || 0),
      payment_method: m.payment_method,
      reference:      m.reference || null,
      supplier_name:  m.suppliers?.name || '—',
      created_at:     m.created_at,
    }));

    // Shape unposted Chatpesa allocations
    const shapedChatpesa = (chatpesaAllocs || []).map(c => {
      const supplierName =
        c.suppliers?.name ||
        c.supplier_purchases?.suppliers?.name ||
        null;
      return {
        id:             c.id,
        date:           c.chatpesa_transactions?.transaction_date || null,
        amount:         parseFloat(c.amount || 0),
        type:           c.allocation_type,
        petty_label:    c.petty_cash_category || null,
        supplier_name:  supplierName,
        created_at:     c.created_at,
      };
    });

    // Shape supplier opening balances
    const shapedOB = (obSuppliers || []).map(s => ({
      id:              s.id,
      supplier_name:   s.name,
      amount:          parseFloat(s.opening_balance || 0),
      date:            s.opening_balance_date || s.created_at?.split('T')[0] || null,
      created_at:      s.created_at,
    }));

    // Normalize posting_errors: source_type = 'purchase' is the raw value written by
    // accountingService.js (source_type comes from journal_entries.source_type = 'purchase').
    // The retry route accepts 'supplier_purchase' as the canonical name.  Normalise here
    // so the UI sends the right value and the column renders readably.
    const shapedErrors = (postingErrors || []).map(e => ({
      ...e,
      source_type: e.source_type === 'purchase' ? 'supplier_purchase' : e.source_type,
    }));

    return NextResponse.json({
      success: true,
      data: {
        unposted: {
          supplier_purchases:        shapedPurchases,
          manual_payments:           shapedManual,
          chatpesa_allocations:      shapedChatpesa,
          supplier_opening_balances: shapedOB,
        },
        posting_errors:   shapedErrors,
        reversal_history: reversalHistory || [],
        // Exact counts — independent of the .limit() on each data query
        summary: {
          unposted_count:
            (purchasesCount  ?? shapedPurchases.length) +
            (manualCount     ?? shapedManual.length)    +
            (chatpesaCount   ?? shapedChatpesa.length)  +
            shapedOB.length,
          error_count:    errorsCount   ?? shapedErrors.length,
          reversal_count: reversalCount ?? (reversalHistory || []).length,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/accounting/review:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
