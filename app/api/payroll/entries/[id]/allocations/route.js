/**
 * GET  /api/payroll/entries/:id/allocations  — get order allocations for entry
 * POST /api/payroll/entries/:id/allocations  — replace allocations via atomic RPC
 *
 * Skilled casual only — allocates pay to specific order items.
 * Uses replace_order_allocations RPC for transactional delete-then-insert.
 * After saving, recomputes the entry's gross_pay and net_pay from allocation totals.
 * Blocked if entry has any payments recorded.
 *
 * Access: admin, production_manager
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

/** Fetch order details for a set of order IDs */
async function enrichOrders(orderIds) {
  if (!orderIds.length) return {};
  const { data } = await serviceClient
    .from('orders')
    .select('id, order_num, client, status')
    .in('id', orderIds);
  const map = {};
  (data || []).forEach(o => { map[o.id] = o; });
  return map;
}

/** Fetch order item details for a set of item IDs */
async function enrichItems(itemIds) {
  if (!itemIds.length) return {};
  const { data } = await serviceClient
    .from('order_items')
    .select('id, description, category, quantity, unit_price')
    .in('id', itemIds);
  const map = {};
  (data || []).forEach(i => { map[i.id] = i; });
  return map;
}

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('payroll_order_allocations')
      .select('id, entry_id, run_id, employee_id, order_id, allocated_amount, notes, created_at')
      .eq('entry_id', params.id)
      .order('created_at');

    if (error) {
      console.error('GET allocations query error:', error.message);
      return NextResponse.json({ error: error.message || 'Failed to fetch allocations' }, { status: 500 });
    }

    // Try to also fetch order_item_id — column added in payroll_allocations_item_links migration.
    // If the migration hasn't been run yet, skip item enrichment gracefully.
    let itemIdsByRow = {};
    const { data: withItem, error: itemColErr } = await serviceClient
      .from('payroll_order_allocations')
      .select('id, order_item_id')
      .eq('entry_id', params.id);
    if (!itemColErr) {
      (withItem || []).forEach(r => { itemIdsByRow[r.id] = r.order_item_id; });
    }

    const rows = (data || []).map(r => ({ ...r, order_item_id: itemIdsByRow[r.id] || null }));
    const orderIds = [...new Set(rows.map(a => a.order_id).filter(Boolean))];
    const itemIds  = [...new Set(rows.map(a => a.order_item_id).filter(Boolean))];

    const [ordersMap, itemsMap] = await Promise.all([
      enrichOrders(orderIds),
      enrichItems(itemIds),
    ]);

    const allocations = rows.map(a => ({
      ...a,
      orders:      ordersMap[a.order_id]      || null,
      order_item:  itemsMap[a.order_item_id]  || null,
    }));

    return NextResponse.json({ allocations });
  } catch (err) {
    console.error('GET /api/payroll/entries/[id]/allocations unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const entryId = params.id;

    const { data: entry } = await serviceClient
      .from('payroll_entries')
      .select('id, run_id, employee_id, gross_pay, net_pay, snapshot_type, snapshot_sha, amount_paid, payroll_runs(status)')
      .eq('id', entryId)
      .single();

    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    if (entry.snapshot_type !== 'skilled_casual') {
      return NextResponse.json({ error: 'Order allocations only apply to skilled_casual employees' }, { status: 400 });
    }

    if (Number(entry.amount_paid) > 0) {
      return NextResponse.json({ error: 'Cannot change allocations after payment has been recorded' }, { status: 409 });
    }

    const body = await request.json();
    const { allocations } = body; // [{ order_id, order_item_id?, allocated_amount, notes? }]

    if (!Array.isArray(allocations) || allocations.length === 0) {
      return NextResponse.json({ error: 'allocations array is required' }, { status: 400 });
    }

    // Validate total — skilled_casual pay is per-item with no net pay cap
    const newTotal = allocations.reduce((s, a) => s + Number(a.allocated_amount || 0), 0);
    if (newTotal <= 0) {
      return NextResponse.json({ error: 'Total allocation must be greater than zero' }, { status: 400 });
    }

    // Atomic replace via RPC — delete + insert in one transaction.
    // The RPC (replace_order_allocations) validates and accepts order_item_id.
    const rpcPayload = allocations.map(a => ({
      order_id:         a.order_id,
      order_item_id:    a.order_item_id || null,
      allocated_amount: Number(a.allocated_amount),
      notes:            a.notes || null,
    }));

    const { error: rpcErr } = await serviceClient.rpc('replace_order_allocations', {
      p_entry_id:    entryId,
      p_run_id:      entry.run_id,
      p_employee_id: entry.employee_id,
      p_allocations: rpcPayload,
      p_created_by:  user.id,
    });

    if (rpcErr) {
      console.error('POST allocations RPC error:', rpcErr.message);
      return NextResponse.json({ error: rpcErr.message || 'Failed to save allocations' }, { status: 500 });
    }

    // Recompute entry gross_pay and net_pay — for skilled_casual, pay = sum of allocations
    const sha      = Number(entry.snapshot_sha || 0);
    const grossPay = newTotal;
    const netPay   = Math.max(0, grossPay - sha);

    await serviceClient
      .from('payroll_entries')
      .update({ gross_pay: grossPay, overtime_amount: newTotal, net_pay: netPay })
      .eq('id', entryId);

    // Return enriched allocations (order_item_id always present after migration)
    const { data: saved } = await serviceClient
      .from('payroll_order_allocations')
      .select('id, entry_id, run_id, employee_id, order_id, order_item_id, allocated_amount, notes, created_at')
      .eq('entry_id', entryId)
      .order('created_at');

    const savedWithItems = (saved || []);

    const orderIds = [...new Set(savedWithItems.map(a => a.order_id).filter(Boolean))];
    const itemIds  = [...new Set(savedWithItems.map(a => a.order_item_id).filter(Boolean))];
    const [ordersMap, itemsMap] = await Promise.all([
      enrichOrders(orderIds),
      enrichItems(itemIds),
    ]);

    const enriched = savedWithItems.map(a => ({
      ...a,
      orders:     ordersMap[a.order_id]     || null,
      order_item: itemsMap[a.order_item_id] || null,
    }));

    return NextResponse.json({
      allocations: enriched,
      gross_pay:   grossPay,
      net_pay:     netPay,
    }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/entries/[id]/allocations unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
