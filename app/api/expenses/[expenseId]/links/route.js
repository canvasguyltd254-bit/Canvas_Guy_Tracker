/**
 * GET  /api/expenses/:id/links   — get all order allocations for an expense
 * PUT  /api/expenses/:id/links   — replace all order allocations atomically
 *   Body: { links: [{ order_id, allocated_amount }] }
 *   Validation:
 *     - each allocated_amount > 0
 *     - SUM(allocated_amount) <= expense.amount
 *     - no duplicate order_id
 *
 * Access: admin, head_of_sales, production_manager
 * Note: changing links on a reversed expense is blocked.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data: links, error } = await serviceClient
      .from('order_direct_expense_links')
      .select(`
        id, allocated_amount,
        orders ( id, order_num, client, status )
      `)
      .eq('expense_id', params.expenseId);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch links' }, { status: 500 });
    }

    return NextResponse.json({ links: links || [] });
  } catch (err) {
    console.error('GET /api/expenses/[id]/links unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    const { links } = await request.json();

    if (!Array.isArray(links)) {
      return NextResponse.json({ error: 'links must be an array' }, { status: 400 });
    }

    // Fetch expense to validate state
    const { data: expense } = await serviceClient
      .from('order_direct_expenses')
      .select('id, amount, reversed_at, is_posted')
      .eq('id', params.expenseId)
      .single();

    if (!expense) return NextResponse.json({ error: 'Expense not found' }, { status: 404 });
    if (expense.reversed_at) {
      return NextResponse.json(
        { error: 'Cannot change allocations on a reversed expense' },
        { status: 409 }
      );
    }
    if (expense.is_posted) {
      return NextResponse.json(
        { error: 'Cannot modify links on a posted expense — reverse and create a new expense instead' },
        { status: 409 }
      );
    }

    // Validate individual links client-side before calling RPC
    const orderIds = new Set();
    for (const l of links) {
      const alloc = parseFloat(l.allocated_amount);
      if (!l.order_id) return NextResponse.json({ error: 'Each link must have an order_id' }, { status: 400 });
      if (!alloc || alloc <= 0) return NextResponse.json({ error: 'Each allocated_amount must be positive' }, { status: 400 });
      if (orderIds.has(l.order_id)) return NextResponse.json({ error: `Duplicate order_id: ${l.order_id}` }, { status: 400 });
      orderIds.add(l.order_id);
    }

    const totalAlloc = links.reduce((s, l) => s + parseFloat(l.allocated_amount), 0);
    if (totalAlloc > Number(expense.amount) + 0.01) {
      return NextResponse.json(
        { error: `Total allocated (${Math.round(totalAlloc)}) exceeds expense amount (${Math.round(expense.amount)})` },
        { status: 400 }
      );
    }

    // Atomically replace via RPC — pass array directly (Supabase serialises to JSONB)
    const { error: rpcErr } = await serviceClient.rpc('replace_expense_links', {
      p_expense_id: params.expenseId,
      p_links:      links.map(l => ({
        order_id:         l.order_id,
        allocated_amount: parseFloat(l.allocated_amount),
      })),
    });

    if (rpcErr) {
      console.error('PUT /api/expenses/[id]/links RPC error:', rpcErr.message);
      return NextResponse.json({ error: rpcErr.message || 'Failed to update allocations' }, { status: 500 });
    }

    // Refetch and return updated links
    const { data: updated } = await serviceClient
      .from('order_direct_expense_links')
      .select(`id, allocated_amount, orders ( id, order_num, client, status )`)
      .eq('expense_id', params.expenseId);

    return NextResponse.json({ links: updated || [], totalAllocated: totalAlloc });
  } catch (err) {
    console.error('PUT /api/expenses/[id]/links unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
