/**
 * GET    /api/expenses/:id  — get expense with all order links
 * PATCH  /api/expenses/:id  — update payment status / reference / notes
 *                              (non-financial fields only; reversals change amounts)
 * DELETE /api/expenses/:id  — reverse (soft-delete); requires reversal_reason
 *                              only admin can reverse
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { reverseDirectExpenseJournal } from '@/shared/lib/accountingService';
import { checkExpenseOrdersSuspended } from '@/shared/lib/suspendGuard';

const WRITE_ROLES  = ['admin', 'head_of_sales', 'production_manager'];
const ADMIN_ONLY   = ['admin'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: expense, error } = await serviceClient
      .from('order_direct_expenses')
      .select('*')
      .eq('id', params.expenseId)
      .single();

    if (error || !expense) {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    }

    // Fetch order links with order info
    const { data: links } = await serviceClient
      .from('order_direct_expense_links')
      .select(`
        id, allocated_amount,
        orders ( id, order_num, client, status )
      `)
      .eq('expense_id', params.expenseId);

    const totalAllocated = (links || []).reduce((s, l) => s + Number(l.allocated_amount), 0);
    const isFullyAllocated = Math.abs(totalAllocated - Number(expense.amount)) < 0.01;
    const allocationStatus = !links?.length
      ? 'unallocated'
      : isFullyAllocated
        ? 'allocated'
        : 'partially_allocated';

    return NextResponse.json({
      expense,
      links: links || [],
      totalAllocated,
      allocationStatus,
    });
  } catch (err) {
    console.error('GET /api/expenses/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    // Suspension guard — block edits if any linked order is suspended
    const suspendedErr = await checkExpenseOrdersSuspended(params.expenseId);
    if (suspendedErr) return suspendedErr;

    const body = await request.json();

    // Only non-financial fields are patchable without reversal.
    // payment_status and payment_method are intentionally excluded: changing
    // payment status on a posted expense requires an AP-clearing journal entry
    // (DR Accounts Payable, CR Cash/Bank). Use a dedicated Record Payment
    // action for that workflow. Editing them here would silently skip the GL.
    const allowed = ['payment_reference', 'notes', 'receipt_url', 'receipt_name', 'payee_name'];
    const updates = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const { data: expense } = await serviceClient
      .from('order_direct_expenses')
      .select('id, reversed_at')
      .eq('id', params.expenseId)
      .single();

    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (expense.reversed_at) {
      return NextResponse.json({ error: 'Reversed expenses cannot be edited' }, { status: 409 });
    }

    const { data: updated, error } = await serviceClient
      .from('order_direct_expenses')
      .update(updates)
      .eq('id', params.expenseId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to update expense' }, { status: 500 });
    }

    return NextResponse.json({ expense: updated });
  } catch (err) {
    console.error('PATCH /api/expenses/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ADMIN_ONLY);
    if (authError) return authError;

    // Suspension guard — block reversal if any linked order is suspended
    const suspendedErr = await checkExpenseOrdersSuspended(params.expenseId);
    if (suspendedErr) return suspendedErr;

    const { searchParams } = new URL(request.url);
    const reversal_reason = searchParams.get('reason') ||
      (await request.json().catch(() => ({}))).reversal_reason;

    if (!reversal_reason?.trim()) {
      return NextResponse.json(
        { error: 'reversal_reason is required to reverse a posted expense' },
        { status: 400 }
      );
    }

    const { data: expense } = await serviceClient
      .from('order_direct_expenses')
      .select('id, reversed_at, amount, category, description, journal_entry_id, expense_date')
      .eq('id', params.expenseId)
      .single();

    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (expense.reversed_at) {
      return NextResponse.json({ error: 'Expense already reversed' }, { status: 409 });
    }

    const now = new Date().toISOString();

    // ── 1. Post GL reversal FIRST ─────────────────────────────────────────────
    //    If GL fails the P&L and GL stay in sync (both still show the expense).
    //    Only mark reversed after GL confirms.
    const { id: reversalJournalId, error: glErr } = await reverseDirectExpenseJournal({
      reversalExpenseId: params.expenseId,
      originalJournalId: expense.journal_entry_id,
      reversalDate:      now.split('T')[0],
      description:       reversal_reason.trim(),
      postedBy:          user.id,
      client:            serviceClient,
    });

    if (glErr && !glErr.startsWith('SKIP:')) {
      console.error('DELETE /api/expenses/[id] GL reversal error:', glErr);
      return NextResponse.json(
        { error: 'Failed to post GL reversal — expense was not reversed' },
        { status: 500 }
      );
    }

    // ── 2. Mark expense as reversed in DB ────────────────────────────────────
    const { error } = await serviceClient
      .from('order_direct_expenses')
      .update({
        reversed_at:     now,
        reversed_by:     user.id,
        reversal_reason: reversal_reason.trim(),
      })
      .eq('id', params.expenseId);

    if (error) {
      // GL has already been reversed — log but don't fail the request
      console.error('DELETE /api/expenses/[id] DB update failed after GL reversal:', error.message);
      return NextResponse.json({ error: 'GL reversed but failed to update expense record' }, { status: 500 });
    }

    // Activity log against every linked order
    const { data: links } = await serviceClient
      .from('order_direct_expense_links')
      .select('order_id')
      .eq('expense_id', params.expenseId);

    const activityRows = (links || []).map(l => ({
      order_id:      l.order_id,
      activity_type: 'direct_expense_reversed',
      description:   `Direct expense reversed by ${displayName}: ${expense.category} — KES ${Math.round(expense.amount).toLocaleString('en-KE')}. Reason: ${reversal_reason.trim()}`,
      created_by:    user.id,
    }));
    if (activityRows.length > 0) {
      const { error: activityErr } = await serviceClient.from('order_activities').insert(activityRows);
      if (activityErr) console.error('Expense reversal activity log failed:', activityErr.message);
    }

    return NextResponse.json({ success: true, reversed: true, reversalJournalId: reversalJournalId || null });
  } catch (err) {
    console.error('DELETE /api/expenses/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
