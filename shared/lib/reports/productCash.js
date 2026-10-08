/**
 * shared/lib/reports/productCash.js
 *
 * "Cash by product": what each item category has brought in.
 *
 * Customers pay against an ORDER, not a line, so per-category cash is an
 * ALLOCATION: each payment is split across the order's lines in proportion to
 * their value. Splitting is done in integer cents with largest-remainder
 * rounding so category totals add back to the payment exactly.
 *
 * Two independent views, deliberately not mixed:
 *   - Cash received in the period      (payments dated in the range)
 *   - Orders raised in the period      (invoiced, collected to date,
 *                                        outstanding, revenue, est. margin)
 *
 * Category = order_items.category (free text today; case/space-insensitive
 * grouping). Replace with the product catalogue when the inventory module lands.
 */

import { isCancelled, isSuspended } from './orderRules.js';

export const UNALLOCATED = 'Unallocated (order has no priced lines)';
export const OTHER = 'Other';

const cents = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = c => c / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

const catKey = c => String(c || OTHER).trim().toLowerCase() || OTHER.toLowerCase();
const catLabel = c => String(c || '').trim() || OTHER;

/**
 * Split `total` cents over `weights` (non-negative numbers) so the parts sum to
 * exactly `total`. Largest remainder; ties go to the earlier index.
 */
export function allocateCents(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length || sum <= 0) return weights.map(() => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const exact = weights.map(w => (abs * w) / sum);
  const parts = exact.map(Math.floor);
  let left = abs - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) parts[order[k].i] += 1;
  return parts.map(p => p * sign);
}

/**
 * Per-category weights for one order's lines, in cents of value.
 * Prefers gross_amount, then net_amount, then unit_price x quantity.
 * @returns {{ key: string, label: string, weight: number, units: number }[]}  one entry per category
 */
export function orderWeights(items) {
  const byCat = new Map();
  for (const it of items || []) {
    const gross = cents(it.gross_amount);
    const net = cents(it.net_amount);
    const list = cents((parseFloat(it.unit_price) || 0) * (parseFloat(it.quantity) || 1));
    const w = gross > 0 ? gross : net > 0 ? net : list;
    const key = catKey(it.category);
    if (!byCat.has(key)) byCat.set(key, { key, label: catLabel(it.category), weight: 0, units: 0 });
    const e = byCat.get(key);
    e.weight += Math.max(w, 0);
    if (!it.line_type || it.line_type === 'product') e.units += parseInt(it.quantity, 10) || 1;
  }
  const list = [...byCat.values()];
  return list.reduce((s, e) => s + e.weight, 0) > 0 ? list : [];
}

function row(map, key, label) {
  if (!map.has(key)) {
    map.set(key, {
      category: label, cashC: 0, invoicedC: 0, collectedC: 0, revenueC: 0, costC: 0,
      units: 0, orders: new Set(), cashOrders: new Set(),
    });
  }
  return map.get(key);
}

/**
 * @param {object} p
 * @param {object[]} p.payments      order_payments rows with `orders` embedded; already date-filtered
 * @param {object[]} p.cohort        orders created in the period that are invoiced and live
 * @param {Record<string, object[]>} p.itemsByOrder  order_id → order_items rows (for payment orders AND cohort)
 * @param {Record<string, number>}   p.payTotals     order_id → non-reversed payments to date (cohort orders)
 * @param {Record<string, {revenue:number,cost:number,revenue_estimated:boolean}>} p.pnlByOrder  cohort order_id → P&L row
 * @param {number|null} p.expectedTotal  independent total from the Payments Received report, for reconciliation
 */
export function buildProductCash({
  payments = [], cohort = [], itemsByOrder = {}, payTotals = {}, pnlByOrder = {}, expectedTotal = null,
}) {
  const map = new Map();
  let allocatedC = 0, unallocatedC = 0, excludedC = 0, reversedCount = 0, unallocatedCount = 0;

  // 1) Cash received, allocated over each order's lines.
  for (const p of payments) {
    if (p.reversed_at) { reversedCount += 1; continue; }
    const order = p.orders || {};
    const c = cents(p.amount);
    if (isCancelled(order) || isSuspended(order)) { excludedC += c; continue; }

    const weights = orderWeights(itemsByOrder[p.order_id]);
    if (!weights.length) {
      unallocatedC += c; unallocatedCount += 1;
      continue;
    }
    const parts = allocateCents(c, weights.map(w => w.weight));
    weights.forEach((w, i) => {
      const r = row(map, w.key, w.label);
      r.cashC += parts[i];
      r.cashOrders.add(p.order_id);
    });
    allocatedC += c;
  }

  // 2) Orders raised in the period, split the same way.
  let estimatedOrders = 0, noLinesOrders = 0, noLinesValueC = 0, uncostedOrders = 0;
  for (const o of cohort) {
    const weights = orderWeights(itemsByOrder[o.id]);
    const w = weights.map(x => x.weight);
    const invoiced = cents(o.total_value);
    if (!weights.length) { noLinesOrders += 1; noLinesValueC += invoiced; continue; }
    const pnl = pnlByOrder[o.id];
    if (pnl?.revenue_estimated) estimatedOrders += 1;
    if (!pnl || cents(pnl.cost) === 0) uncostedOrders += 1;

    const inv = allocateCents(invoiced, w);
    const col = allocateCents(cents(payTotals[o.id]), w);
    const rev = pnl ? allocateCents(cents(pnl.revenue), w) : w.map(() => 0);
    const cost = pnl ? allocateCents(cents(pnl.cost), w) : w.map(() => 0);
    weights.forEach((x, i) => {
      const r = row(map, x.key, x.label);
      r.invoicedC += inv[i]; r.collectedC += col[i]; r.revenueC += rev[i]; r.costC += cost[i];
      r.units += x.units; r.orders.add(o.id);
    });
  }

  const rows = [...map.values()].map(r => {
    const outstandingC = r.invoicedC - r.collectedC;
    const profitC = r.revenueC - r.costC;
    return {
      category: r.category,
      cash: money(r.cashC),
      cash_orders: r.cashOrders.size,
      invoiced: money(r.invoicedC),
      collected: money(r.collectedC),
      outstanding: money(outstandingC),
      revenue: money(r.revenueC),
      cost: money(r.costC),
      profit: money(profitC),
      // No cost recorded means no real margin; do not show a flattering 100%.
      margin: r.costC > 0 ? pct(profitC, r.revenueC) : null,
      uncosted: r.costC === 0 && r.revenueC > 0,
      units: r.units,
      orders: r.orders.size,
    };
  }).sort((a, b) => b.cash - a.cash || b.invoiced - a.invoiced || a.category.localeCompare(b.category));

  const sumC = k => [...map.values()].reduce((s, r) => s + r[k], 0);
  const totalsRevenueC = sumC('revenueC'), totalsCostC = sumC('costC');
  const totals = {
    cash: money(sumC('cashC')),
    invoiced: money(sumC('invoicedC')),
    collected: money(sumC('collectedC')),
    outstanding: money(sumC('invoicedC') - sumC('collectedC')),
    revenue: money(totalsRevenueC),
    cost: money(totalsCostC),
    profit: money(totalsRevenueC - totalsCostC),
    margin: totalsCostC > 0 ? pct(totalsRevenueC - totalsCostC, totalsRevenueC) : null,
    units: rows.reduce((s, r) => s + r.units, 0),
  };

  const countedC = allocatedC + unallocatedC;
  const reconciliation = {
    allocated: money(allocatedC),
    unallocated: money(unallocatedC),
    unallocatedPayments: unallocatedCount,
    total: money(countedC),
    expected: expectedTotal === null ? null : expectedTotal,
    difference: expectedTotal === null ? null : money(countedC - cents(expectedTotal)),
    excluded: money(excludedC),
    reversedPayments: reversedCount,
  };
  reconciliation.ok = reconciliation.difference === null ? null : Math.abs(reconciliation.difference) < 0.005;

  return {
    rows,
    totals,
    reconciliation,
    flags: {
      estimatedOrders,
      uncostedOrders,
      ordersWithoutLines: noLinesOrders,
      ordersWithoutLinesValue: money(noLinesValueC),
      cohortOrders: cohort.length,
    },
  };
}

export const PRODUCT_CASH_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'cash', label: 'Cash received (allocated)' },
  { key: 'orders', label: 'Orders raised' },
  { key: 'units', label: 'Units' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'collected', label: 'Collected to date' },
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'revenue', label: 'Revenue ex-VAT' },
  { key: 'cost', label: 'Est. cost' },
  { key: 'profit', label: 'Est. margin' },
  { key: 'margin', label: 'Margin %' },
];
