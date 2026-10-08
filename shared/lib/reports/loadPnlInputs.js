/**
 * shared/lib/reports/loadPnlInputs.js
 *
 * Loads everything buildOrderPnlRows needs for a set of order ids, paged past
 * the 1,000-row cap and chunked for .in() lists. Shared by the Order P&L and
 * Cash-by-product routes so the cost definition lives in one place and matches
 * GET /api/orders/[id]/pnl: supplier purchases (link.amount, else purchase
 * total), skilled-casual payroll allocations, and active direct expenses.
 *
 * `items` are returned with value columns so callers can allocate by line.
 */

import { fetchAllRows, fetchByIds } from './fetchAll.js';

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const group = (rows, key) => rows.reduce((m, r) => { (m[r[key]] ||= []).push(r); return m; }, {});

export const ITEM_COLUMNS = 'order_id, category, line_type, quantity, unit_price, net_amount, gross_amount';

/** Items only (used when the caller does not need costs, e.g. orders with payments but outside the cohort). */
export async function loadItems(client, orderIds) {
  const items = await fetchByIds(orderIds, part => fetchAllRows(
    (a, b) => client.from('order_items').select(ITEM_COLUMNS).in('order_id', part).order('id').range(a, b),
    { label: 'order items' }));
  return group(items, 'order_id');
}

export async function loadPayTotals(client, orderIds) {
  const payments = await fetchByIds(orderIds, part => fetchAllRows(
    (a, b) => client.from('order_payments')
      .select('id, order_id, amount').in('order_id', part).is('reversed_at', null).order('id').range(a, b),
    { label: 'payments' }));
  const totals = {};
  for (const p of payments) totals[p.order_id] = (totals[p.order_id] || 0) + num(p.amount);
  return totals;
}

export async function loadPnlInputs(client, orderIds) {
  const [itemsByOrder, links, labour, expenseLinks, payTotals] = await Promise.all([
    loadItems(client, orderIds),
    fetchByIds(orderIds, part => fetchAllRows(
      (a, b) => client.from('purchase_order_links')
        .select('purchase_id, order_id, amount, supplier_purchases(total_amount, items_bought, purchase_date, suppliers(name))')
        // Composite key (purchase_id, order_id): this table has no id column.
        .in('order_id', part).order('order_id').order('purchase_id').range(a, b),
      { label: 'purchase links' })),
    fetchByIds(orderIds, part => fetchAllRows(
      (a, b) => client.from('payroll_order_allocations')
        .select('id, order_id, allocated_amount').in('order_id', part).order('id').range(a, b),
      { label: 'labour allocations' })),
    fetchByIds(orderIds, part => fetchAllRows(
      (a, b) => client.from('order_direct_expense_links')
        .select('id, order_id, allocated_amount, order_direct_expenses(reversed_at, description)')
        .in('order_id', part).order('id').range(a, b),
      { label: 'direct expenses' })),
    loadPayTotals(client, orderIds),
  ]);

  const purchasesByOrder = {};
  for (const l of links) {
    const sp = l.supplier_purchases;
    if (!sp) continue;
    const amount = l.amount != null ? num(l.amount) : num(sp.total_amount);
    (purchasesByOrder[l.order_id] ||= []).push({
      supplier_name: sp.suppliers?.name || 'Unknown',
      items_bought: sp.items_bought || '—',
      purchase_date: sp.purchase_date || null,
      total_amount: amount,
    });
  }

  const labourByOrder = {};
  for (const l of labour) labourByOrder[l.order_id] = (labourByOrder[l.order_id] || 0) + num(l.allocated_amount);

  const expensesByOrder = {};
  for (const l of expenseLinks) {
    if (!l.order_direct_expenses) continue;
    (expensesByOrder[l.order_id] ||= []).push({
      allocated_amount: l.allocated_amount,
      reversed_at: l.order_direct_expenses.reversed_at,
      description: l.order_direct_expenses.description,
    });
  }

  return { itemsByOrder, purchasesByOrder, labourByOrder, expensesByOrder, payTotals };
}
