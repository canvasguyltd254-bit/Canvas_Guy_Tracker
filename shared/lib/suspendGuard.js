/**
 * shared/lib/suspendGuard.js
 *
 * Returns a NextResponse if the mutation should be blocked, or null to proceed.
 *
 * - 409  ORDER_SUSPENDED / QUOTATION_SUSPENDED  — entity is suspended
 * - 500  DB error — fail closed (do NOT allow the mutation on a DB failure)
 * - null — entity is not suspended; caller may proceed
 * - null — entity not found (PGRST116); let the downstream handler surface 404
 *
 * Usage:
 *   const blocked = await checkOrderSuspended(orderId);
 *   if (blocked) return blocked;
 */

import { NextResponse } from 'next/server';
import { serviceClient }  from '@/shared/lib/api-auth';

// Supabase PostgREST "no rows returned" code — not a DB failure, just not-found
const PGRST_NOT_FOUND = 'PGRST116';

export async function checkOrderSuspended(orderId) {
  const { data, error } = await serviceClient
    .from('orders')
    .select('suspended_at, suspension_reason')
    .eq('id', orderId)
    .single();

  if (error) {
    // Not found — let the downstream 404 handler deal with it
    if (error.code === PGRST_NOT_FOUND) return null;
    // Any other DB error: fail closed so a broken connection can't bypass the guard
    console.error('checkOrderSuspended DB error:', error.message);
    return NextResponse.json(
      { error: 'Failed to verify order suspension status' },
      { status: 500 }
    );
  }

  if (data?.suspended_at !== null && data?.suspended_at !== undefined) {
    return NextResponse.json(
      {
        error:  'Order is suspended',
        reason: data.suspension_reason ?? 'No reason provided',
        code:   'ORDER_SUSPENDED',
      },
      { status: 409 }
    );
  }
  return null;
}

export async function checkQuotationSuspended(quoteId) {
  const { data, error } = await serviceClient
    .from('quotations')
    .select('suspended_at, suspension_reason')
    .eq('id', quoteId)
    .single();

  if (error) {
    if (error.code === PGRST_NOT_FOUND) return null;
    console.error('checkQuotationSuspended DB error:', error.message);
    return NextResponse.json(
      { error: 'Failed to verify quotation suspension status' },
      { status: 500 }
    );
  }

  if (data?.suspended_at !== null && data?.suspended_at !== undefined) {
    return NextResponse.json(
      {
        error:  'Quotation is suspended',
        reason: data.suspension_reason ?? 'No reason provided',
        code:   'QUOTATION_SUSPENDED',
      },
      { status: 409 }
    );
  }
  return null;
}

/**
 * Guard for mutations on a direct expense that is linked to one or more orders.
 * Blocks if ANY linked order is suspended.
 * Returns a 409 response if blocked, null to proceed.
 */
export async function checkExpenseOrdersSuspended(expenseId) {
  // Fetch the orders linked to this expense
  const { data: links, error: linksErr } = await serviceClient
    .from('order_direct_expense_links')
    .select('order_id')
    .eq('expense_id', expenseId);

  if (linksErr) {
    console.error('checkExpenseOrdersSuspended — links fetch error:', linksErr.message);
    return NextResponse.json(
      { error: 'Failed to verify linked order suspension status' },
      { status: 500 }
    );
  }

  if (!links || links.length === 0) return null; // unlinked expense — no guard needed

  // Check if any linked order is suspended
  const orderIds = links.map(l => l.order_id);
  const { data: suspended, error: suspErr } = await serviceClient
    .from('orders')
    .select('id, order_num, suspension_reason')
    .in('id', orderIds)
    .not('suspended_at', 'is', null);

  if (suspErr) {
    console.error('checkExpenseOrdersSuspended — orders check error:', suspErr.message);
    return NextResponse.json(
      { error: 'Failed to verify linked order suspension status' },
      { status: 500 }
    );
  }

  if (suspended && suspended.length > 0) {
    const nums = suspended.map(o => o.order_num).join(', ');
    return NextResponse.json(
      {
        error:  `Cannot modify expense — linked order(s) are suspended: ${nums}`,
        code:   'ORDER_SUSPENDED',
      },
      { status: 409 }
    );
  }

  return null;
}
