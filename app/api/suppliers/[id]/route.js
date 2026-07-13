/**
 * app/api/suppliers/[id]/route.js
 *
 * GET    /api/suppliers/:id  — fetch single supplier + their purchases
 * PATCH  /api/suppliers/:id  — update supplier fields
 * DELETE /api/suppliers/:id  — delete supplier (admin only)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { postOpeningBalanceJournal } from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: supplier, error } = await serviceClient
      .from('suppliers')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !supplier) {
      return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });
    }

    // Fetch purchases (with linked order numbers)
    const { data: purchases } = await serviceClient
      .from('supplier_purchases')
      .select('*, purchase_order_links(order_id, orders(order_num, client))')
      .eq('supplier_id', params.id)
      .order('purchase_date', { ascending: true });

    // Fetch manual payments for this supplier
    const { data: manualPayments } = await serviceClient
      .from('manual_supplier_payments')
      .select('*')
      .eq('supplier_id', params.id)
      .order('payment_date', { ascending: true });

    // Fetch Chatpesa allocations linked to this supplier's purchases
    const purchaseIds = (purchases || []).map(p => p.id);
    let chatpesaAllocations = [];
    if (purchaseIds.length > 0) {
      const { data: allocByPurchase } = await serviceClient
        .from('chatpesa_payment_allocations')
        .select('*, chatpesa_transactions(transaction_date, amount, description, confirm_code)')
        .in('supplier_purchase_id', purchaseIds)
        .order('created_at', { ascending: true });
      chatpesaAllocations = allocByPurchase || [];
    }
    // Also fetch any allocations matched directly to this supplier (opening balance type)
    const { data: allocBySupplier } = await serviceClient
      .from('chatpesa_payment_allocations')
      .select('*, chatpesa_transactions(transaction_date, amount, description, confirm_code)')
      .eq('supplier_id', params.id)
      .is('supplier_purchase_id', null)
      .order('created_at', { ascending: true });
    chatpesaAllocations = [...chatpesaAllocations, ...(allocBySupplier || [])];

    // Compute stats — use payment transaction tables as source of truth, not
    // the denormalised amount_paid column (which may lag until recalc runs).
    const totalPurchased  = (purchases || []).reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
    const manualPaid      = (manualPayments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const chatpesaPaid    = chatpesaAllocations
      .filter(a => a.allocation_type === 'supplier_purchase')
      .reduce((s, a) => s + parseFloat(a.amount || 0), 0);
    const chatpesaObPaid  = chatpesaAllocations
      .filter(a => a.allocation_type === 'opening_balance')
      .reduce((s, a) => s + parseFloat(a.amount || 0), 0);
    // total_paid includes ALL credits against this supplier — purchase payments AND
    // opening-balance Chatpesa allocations — so the identity holds:
    //   current_balance = opening_balance + total_purchased - total_paid
    const totalPaid       = manualPaid + chatpesaPaid + chatpesaObPaid;
    const openingBalance  = parseFloat(supplier.opening_balance || 0);
    const currentBalance  = openingBalance + totalPurchased - totalPaid;

    return NextResponse.json({
      success: true,
      data: {
        ...supplier,
        purchases:            purchases           || [],
        manual_payments:      manualPayments      || [],
        chatpesa_allocations: chatpesaAllocations,
        stats: {
          total_purchased:  totalPurchased,
          total_paid:       totalPaid,          // manual + chatpesa purchase allocations
          opening_balance:  openingBalance,
          current_balance:  Math.max(currentBalance, 0),
        },
      },
    });
  } catch (err) {
    console.error('GET /api/suppliers/[id]:', err);
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

    const safe = pick(body, ALLOWED_FIELDS.suppliers.update);

    // Trim string fields — null out blanks
    for (const k of ['name', 'contact_person', 'phone', 'email', 'materials_supplied', 'opening_balance_notes', 'notes']) {
      if (safe[k] !== undefined) safe[k] = safe[k]?.trim() || null;
    }
    if (safe.name !== undefined && !safe.name) {
      return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 });
    }

    // Numeric field — empty string → 0, otherwise parse float
    if (safe.opening_balance !== undefined) {
      const v = String(safe.opening_balance).trim();
      safe.opening_balance = v === '' ? 0 : parseFloat(v) || 0;
    }
    // Date field — empty string → null
    if (safe.opening_balance_date !== undefined) {
      const v = String(safe.opening_balance_date || '').trim();
      safe.opening_balance_date = v || null;
    }

    if (Object.keys(safe).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // Fetch current record to check if OB journal already exists
    const { data: current } = await serviceClient
      .from('suppliers')
      .select('name, opening_balance, opening_balance_date, opening_balance_journal_entry_id')
      .eq('id', params.id)
      .single();

    // Block edits to opening_balance or opening_balance_date once the OB has been
    // posted to the General Ledger — the journal entry would then disagree with
    // the operational record. Create a reversal first.
    if (current?.opening_balance_journal_entry_id) {
      const obChange = safe.opening_balance !== undefined || safe.opening_balance_date !== undefined;
      if (obChange) {
        return NextResponse.json(
          {
            error: 'Cannot change the opening balance or its date after posting to the General Ledger. Create a reversal entry first.',
            journal_entry_id: current.opening_balance_journal_entry_id,
          },
          { status: 409 },
        );
      }
    }

    const { data, error } = await serviceClient
      .from('suppliers')
      .update(safe)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/suppliers/[id]:', error);
      return NextResponse.json({ error: 'Failed to update supplier' }, { status: 500 });
    }

    // Accounting: post opening balance journal if OB is being set for the first time
    // (only if no journal exists yet — we don't automatically reverse/re-post on OB edits)
    const newOb = parseFloat(safe.opening_balance ?? current?.opening_balance ?? 0);
    if (newOb > 0 && !current?.opening_balance_journal_entry_id) {
      const obDate = safe.opening_balance_date || current?.opening_balance_date
        || new Date().toISOString().split('T')[0];
      const { id: jId, error: jErr } = await postOpeningBalanceJournal({
        supplierId:     params.id,
        openingBalance: newOb,
        balanceDate:    obDate,
        supplierName:   current?.name || data.name,
        postedBy:       user.id,
        client:         serviceClient,
      });
      if (jId) {
        await serviceClient
          .from('suppliers')
          .update({ opening_balance_journal_entry_id: jId })
          .eq('id', params.id);
      } else if (jErr && !jErr.startsWith('SKIP:')) {
        console.error('PATCH /api/suppliers/[id] — OB journal failed:', jErr);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/suppliers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // Check if supplier has purchases — prevent orphan delete
    const { count } = await serviceClient
      .from('supplier_purchases')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', params.id);

    if (count > 0) {
      return NextResponse.json(
        { error: `Cannot delete: supplier has ${count} purchase record(s). Delete purchases first.` },
        { status: 409 }
      );
    }

    // Check for posted opening balance journal
    const { data: supplierRecord } = await serviceClient
      .from('suppliers')
      .select('opening_balance_journal_entry_id')
      .eq('id', params.id)
      .single();

    if (supplierRecord?.opening_balance_journal_entry_id) {
      return NextResponse.json(
        {
          error: 'Cannot delete: supplier has a posted opening balance journal entry. Create a reversal first.',
          journal_entry_id: supplierRecord.opening_balance_journal_entry_id,
        },
        { status: 409 },
      );
    }

    const { error } = await serviceClient
      .from('suppliers')
      .delete()
      .eq('id', params.id);

    if (error) {
      console.error('DELETE /api/suppliers/[id]:', error);
      return NextResponse.json({ error: 'Failed to delete supplier' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Supplier deleted' });
  } catch (err) {
    console.error('DELETE /api/suppliers/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
