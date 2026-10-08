/**
 * app/api/reports/order-pnl/route.js
 *
 * GET /api/reports/order-pnl?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Per-order profit & loss for orders created in the range (Nairobi calendar
 * days). Cost definition matches GET /api/orders/[id]/pnl: supplier purchases
 * (allocated share), skilled-casual payroll allocations, and active direct
 * expenses. Revenue is ex-VAT. Cancelled and suspended orders are excluded.
 *
 * Roles: admin, head_of_sales.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { fetchAllRows, fetchByIds } from '@/shared/lib/reports/fetchAll';
import { isLive } from '@/shared/lib/reports/orderRules';
import { buildOrderPnlRows, pnlTotals } from '@/shared/lib/reports/orderPnl';
import { nairobiBounds, validateQueryRange } from '@/shared/lib/reports/dateBounds';

const ROLES = ['admin', 'head_of_sales'];

const group = (rows, key) => rows.reduce((m, r) => { (m[r[key]] ||= []).push(r); return m; }, {});

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES);
    if (authError) return authError;

    const sp = new URL(request.url).searchParams;
    const from = sp.get('from') || null;
    const to = sp.get('to') || null;
    if (!from || !to) return NextResponse.json({ error: 'Both "from" and "to" are required.' }, { status: 400 });
    const rangeError = validateQueryRange({ from, to });
    if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });

    const { gte, lt } = nairobiBounds({ from, to });

    const allOrders = await fetchAllRows(
      (a, b) => serviceClient.from('orders')
        .select('id, order_num, client, status, total_value, created_at, suspended_at')
        .gte('created_at', gte).lt('created_at', lt)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .range(a, b),
      { label: 'orders' },
    );
    const orders = allOrders.filter(isLive);
    const orderIds = orders.map(o => o.id);

    const [items, links, labour, expenseLinks, payments] = await Promise.all([
      fetchByIds(orderIds, async part => fetchAllRows(
        (a, b) => serviceClient.from('order_items').select('order_id, net_amount').in('order_id', part).order('id').range(a, b),
        { label: 'order items' })),
      fetchByIds(orderIds, async part => fetchAllRows(
        (a, b) => serviceClient.from('purchase_order_links')
          .select('purchase_id, order_id, amount, supplier_purchases(total_amount, items_bought, purchase_date, suppliers(name))')
          // Composite key (purchase_id, order_id): this table has no id column.
          .in('order_id', part).order('order_id').order('purchase_id').range(a, b),
        { label: 'purchase links' })),
      fetchByIds(orderIds, async part => fetchAllRows(
        (a, b) => serviceClient.from('payroll_order_allocations')
          .select('id, order_id, allocated_amount').in('order_id', part).order('id').range(a, b),
        { label: 'labour allocations' })),
      fetchByIds(orderIds, async part => fetchAllRows(
        (a, b) => serviceClient.from('order_direct_expense_links')
          .select('id, order_id, allocated_amount, order_direct_expenses(reversed_at, description)')
          .in('order_id', part).order('id').range(a, b),
        { label: 'direct expenses' })),
      fetchByIds(orderIds, async part => fetchAllRows(
        (a, b) => serviceClient.from('order_payments')
          .select('id, order_id, amount').in('order_id', part).is('reversed_at', null).order('id').range(a, b),
        { label: 'payments' })),
    ]);

    const itemsByOrder = group(items, 'order_id');

    // Same rule as the single-order P&L: link.amount, else the purchase total.
    const purchasesByOrder = {};
    for (const l of links) {
      const sp2 = l.supplier_purchases;
      if (!sp2) continue;
      const amount = l.amount != null ? parseFloat(l.amount) : parseFloat(sp2.total_amount || 0);
      (purchasesByOrder[l.order_id] ||= []).push({
        supplier_name: sp2.suppliers?.name || 'Unknown',
        items_bought: sp2.items_bought || '—',
        purchase_date: sp2.purchase_date || null,
        total_amount: amount,
      });
    }

    const labourByOrder = {};
    for (const l of labour) labourByOrder[l.order_id] = (labourByOrder[l.order_id] || 0) + parseFloat(l.allocated_amount || 0);

    const expensesByOrder = {};
    for (const l of expenseLinks) {
      if (!l.order_direct_expenses) continue;
      (expensesByOrder[l.order_id] ||= []).push({
        allocated_amount: l.allocated_amount,
        reversed_at: l.order_direct_expenses.reversed_at,
        description: l.order_direct_expenses.description,
      });
    }

    const payTotals = {};
    for (const p of payments) payTotals[p.order_id] = (payTotals[p.order_id] || 0) + parseFloat(p.amount || 0);

    const rows = buildOrderPnlRows({ orders, itemsByOrder, purchasesByOrder, labourByOrder, expensesByOrder, payTotals });

    return NextResponse.json({
      success: true,
      data: { from, to, rows, totals: pnlTotals(rows), excludedOrders: allOrders.length - orders.length },
    });
  } catch (err) {
    console.error('GET /api/reports/order-pnl:', err);
    return NextResponse.json({ error: 'Failed to build the P&L report.' }, { status: 500 });
  }
}
