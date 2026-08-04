/**
 * GET  /api/orders/:id/expenses
 *   Returns ALL direct expenses allocated to this order (including reversed),
 *   with their allocated_amount from the junction table.
 *   Reversed expenses carry reversed_at so the UI can show a "Reversed" badge.
 *
 * POST /api/orders/:id/expenses
 *   Creates a direct expense atomically (expense row + all order links in one
 *   JS transaction with rollback on failure), then posts a GL journal entry.
 *
 *   Body:
 *     expense_date         string   YYYY-MM-DD  (required)
 *     accounting_category_id uuid  (required — determines GL account)
 *     description          string  (required)
 *     payee_name           string  (optional)
 *     amount               number  > 0 (required)
 *     payment_status       'unpaid' | 'paid'  (default 'unpaid')
 *     payment_method       'cash' | 'bank' | 'chatpesa' | 'mpesa'  (required when paid)
 *     payment_reference    string  (optional)
 *     receipt_url          string  (optional)
 *     receipt_name         string  (optional)
 *     notes                string  (optional)
 *     allocated_amount     number  (optional — defaults to full amount for this order)
 *     extra_links          [{order_id, allocated_amount}]  (optional — additional orders)
 *
 * Access: admin, head_of_sales, production_manager (write)
 *         any authenticated user (read)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { postDirectExpenseJournal } from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'head_of_sales', 'production_manager'];

const VALID_PAYMENT_METHODS = new Set(['cash', 'bank', 'chatpesa', 'mpesa']);

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: links, error } = await serviceClient
      .from('order_direct_expense_links')
      .select(`
        allocated_amount,
        order_direct_expenses (
          id, expense_date, expense_category, category, description, payee_name,
          amount, payment_status, payment_method, payment_reference,
          receipt_url, receipt_name, notes, accounting_category_id,
          journal_entry_id, is_posted, reversed_at, reversal_reason, created_at
        )
      `)
      .eq('order_id', params.id)
      .order('created_at', { referencedTable: 'order_direct_expenses', ascending: true });

    if (error) {
      console.error('GET /api/orders/[id]/expenses error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch expenses' }, { status: 500 });
    }

    // Return ALL expenses (including reversed) so the UI can show "Reversed" badge
    const expenses = (links || [])
      .filter(l => l.order_direct_expenses)
      .map(l => ({
        ...l.order_direct_expenses,
        allocated_amount: Number(l.allocated_amount),
      }));

    // Only non-reversed count toward P&L
    const totalDirectExpenses = expenses
      .filter(e => !e.reversed_at)
      .reduce((s, e) => s + Number(e.allocated_amount), 0);

    return NextResponse.json({ expenses, totalDirectExpenses });
  } catch (err) {
    console.error('GET /api/orders/[id]/expenses unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    const orderId = params.id;

    // Verify order exists
    const { data: order } = await serviceClient
      .from('orders')
      .select('id, order_num')
      .eq('id', orderId)
      .single();
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    const body = await request.json();
    const {
      expense_date,
      expense_category,
      accounting_category_id,
      description,
      payee_name,
      amount,
      payment_status = 'unpaid',
      payment_method,
      payment_reference,
      receipt_url,
      receipt_name,
      notes,
      allocated_amount,   // allocation for THIS order (defaults to full amount)
      extra_links = [],   // [{order_id, allocated_amount}] for additional orders
    } = body;

    // ── Server-side validation ────────────────────────────────────────────────
    if (!expense_date)
      return NextResponse.json({ error: 'expense_date is required' }, { status: 400 });
    if (!accounting_category_id)
      return NextResponse.json({ error: 'accounting_category_id is required' }, { status: 400 });
    if (!description?.trim())
      return NextResponse.json({ error: 'description is required' }, { status: 400 });

    const amt = parseFloat(amount);
    if (!amt || amt <= 0)
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });

    if (!['unpaid', 'paid'].includes(payment_status))
      return NextResponse.json({ error: 'payment_status must be unpaid or paid' }, { status: 400 });

    if (payment_status === 'paid' && !VALID_PAYMENT_METHODS.has(payment_method))
      return NextResponse.json(
        { error: 'payment_method is required when status is paid (cash, bank, chatpesa, mpesa)' },
        { status: 400 }
      );

    // Validate accounting_category exists AND is flagged for direct expenses
    const { data: cat } = await serviceClient
      .from('accounting_categories')
      .select('id, label, account_id, for_direct_expenses')
      .eq('id', accounting_category_id)
      .single();
    if (!cat)
      return NextResponse.json({ error: 'Invalid accounting_category_id' }, { status: 400 });
    if (!cat.for_direct_expenses)
      return NextResponse.json(
        { error: 'The selected GL account is not configured for direct expenses' },
        { status: 400 }
      );

    // Build full links array: this order + any extra
    const thisAlloc = allocated_amount != null ? parseFloat(allocated_amount) : amt;
    if (thisAlloc <= 0 || thisAlloc > amt + 0.01)
      return NextResponse.json(
        { error: 'allocated_amount must be positive and cannot exceed the total amount' },
        { status: 400 }
      );

    const allLinks = [
      { order_id: orderId, allocated_amount: thisAlloc },
      ...(Array.isArray(extra_links) ? extra_links : []),
    ];

    const totalAlloc = allLinks.reduce((s, l) => s + (parseFloat(l.allocated_amount) || 0), 0);
    if (totalAlloc > amt + 0.01)
      return NextResponse.json(
        { error: `Total allocated (${Math.round(totalAlloc)}) exceeds expense amount (${Math.round(amt)})` },
        { status: 400 }
      );

    const orderIdSet = new Set(allLinks.map(l => l.order_id));
    if (orderIdSet.size < allLinks.length)
      return NextResponse.json({ error: 'Duplicate order_id in links' }, { status: 400 });

    // ── 1. Atomically create expense + links via RPC ──────────────────────────
    //    RPC inserts expense with is_posted = false, then inserts all links.
    //    GL journal is posted after; is_posted is set true only on GL success.
    const { data: expenseId, error: rpcErr } = await serviceClient.rpc('create_direct_expense', {
      p_expense_date:           expense_date,
      p_expense_category:       body.expense_category?.trim() || null,
      p_gl_label:               cat.label,
      p_description:            description.trim(),
      p_payee_name:             payee_name?.trim() || '',
      p_amount:                 amt,
      p_payment_status:         payment_status,
      p_payment_method:         payment_status === 'paid' ? (payment_method || '') : '',
      p_payment_reference:      payment_reference?.trim() || '',
      p_receipt_url:            receipt_url || '',
      p_notes:                  notes?.trim() || '',
      p_accounting_category_id: accounting_category_id,
      p_created_by:             user.id,
      p_links:                  allLinks.map(l => ({
        order_id:         l.order_id,
        allocated_amount: parseFloat(l.allocated_amount),
      })),
    });

    if (rpcErr) {
      console.error('POST /api/orders/[id]/expenses RPC error:', rpcErr.message);
      return NextResponse.json({ error: rpcErr.message || 'Failed to create expense' }, { status: 500 });
    }

    // ── 2. Post GL journal entry ──────────────────────────────────────────────
    const { id: journalId, error: glErr } = await postDirectExpenseJournal({
      expenseId:     expenseId,
      expenseDate:   expense_date,
      amount:        amt,
      categoryId:    accounting_category_id,
      description:   description.trim(),
      paymentStatus: payment_status,
      paymentMethod: payment_method,
      postedBy:      user.id,
      client:        serviceClient,
    });

    if (glErr && !glErr.startsWith('SKIP:')) {
      // GL failed — roll back by hard-deleting the expense (cascade removes links)
      console.error('POST /api/orders/[id]/expenses GL posting error:', glErr);
      const { error: rollbackErr } = await serviceClient
        .from('order_direct_expenses')
        .delete()
        .eq('id', expenseId);
      if (rollbackErr) console.error('Direct expense rollback failed:', rollbackErr.message);
      return NextResponse.json(
        { error: 'Failed to post GL journal entry — expense was not saved' },
        { status: 500 }
      );
    }

    // ── 3. Mark expense as posted + store journal_entry_id ───────────────────
    const { error: updateErr } = await serviceClient
      .from('order_direct_expenses')
      .update({ is_posted: true, journal_entry_id: journalId || null })
      .eq('id', expenseId);

    if (updateErr) {
      console.error('POST expenses — is_posted update failed:', updateErr.message);
      // Non-fatal: journal was posted successfully; expense exists with is_posted=false
    }

    // ── 4. Activity log for each linked order ─────────────────────────────────
    const activityRows = allLinks.map(l => ({
      order_id:      l.order_id,
      activity_type: 'direct_expense_added',
      description:   `Direct expense added by ${displayName}: ${cat.label} — KES ${Math.round(parseFloat(l.allocated_amount)).toLocaleString('en-KE')} (${description.trim()})`,
      created_by:    user.id,
    }));
    const { error: activityErr } = await serviceClient.from('order_activities').insert(activityRows);
    if (activityErr) console.error('Direct expense activity log failed:', activityErr.message);

    return NextResponse.json(
      { expense: { id: expenseId, allocated_amount: thisAlloc, journal_entry_id: journalId || null } },
      { status: 201 }
    );
  } catch (err) {
    console.error('POST /api/orders/[id]/expenses unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
