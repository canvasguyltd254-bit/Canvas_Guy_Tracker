/**
 * shared/lib/reports/orderPnl.js
 *
 * Per-order profit & loss for the Reports tab. Uses the same cost definition as
 * the single-order P&L tab (GET /api/orders/[id]/pnl): supplier purchases (the
 * allocated share), skilled-casual payroll allocations, and active direct
 * expenses. Revenue is NET of VAT, because VAT collected is not income.
 */

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = n => Math.round(n * 100) / 100;

export const VAT_RATE = 0.16;

/**
 * Net (ex-VAT) revenue for an order.
 *  - Exact when every item carries net_amount (sum of those).
 *  - Otherwise estimated as total_value / 1.16, flagged `estimated: true`.
 *  - VAT-exempt orders (no vat on any item) fall out naturally from net_amount.
 */
export function orderNetRevenue(order, items) {
  const list = items || [];
  const hasAll = list.length > 0 && list.every(i => i.net_amount !== null && i.net_amount !== undefined);
  if (hasAll) {
    const net = list.reduce((s, i) => s + num(i.net_amount), 0);
    return { net: r2(net), estimated: false };
  }
  return { net: r2(num(order.total_value) / (1 + VAT_RATE)), estimated: true };
}

/**
 * @param {object} p
 * @param {object[]} p.orders
 * @param {Record<string, object[]>} p.itemsByOrder
 * @param {Record<string, object[]>} p.purchasesByOrder  [{ total_amount, supplier_name, items_bought, purchase_date }]
 * @param {Record<string, number>}   p.labourByOrder     order_id → allocated labour total
 * @param {Record<string, object[]>} p.expensesByOrder    [{ allocated_amount, reversed_at, description }]
 * @param {Record<string, number>}   p.payTotals
 */
export function buildOrderPnlRows({
  orders, itemsByOrder = {}, purchasesByOrder = {}, labourByOrder = {}, expensesByOrder = {}, payTotals = {},
}) {
  return (orders || []).map(o => {
    const { net, estimated } = orderNetRevenue(o, itemsByOrder[o.id]);
    const purchases = purchasesByOrder[o.id] || [];
    const materials = purchases.reduce((s, p) => s + num(p.total_amount), 0);
    const labour = num(labourByOrder[o.id]);
    const direct = (expensesByOrder[o.id] || [])
      .filter(e => !e.reversed_at)
      .reduce((s, e) => s + num(e.allocated_amount), 0);
    const cost = materials + labour + direct;
    const profit = net - cost;
    return {
      id: o.id,
      order_num: o.order_num || '',
      client: o.client || '',
      status: o.status || '',
      created_at: o.created_at || null,
      revenue_gross: num(o.total_value),
      revenue: r2(net),
      revenue_estimated: estimated,
      collected: num(payTotals[o.id]),
      materials: r2(materials),
      labour: r2(labour),
      direct: r2(direct),
      cost: r2(cost),
      profit: r2(profit),
      margin: net > 0 ? r2((profit / net) * 100) : null,
      purchases,
    };
  });
}

export function pnlTotals(rows) {
  const t = { count: rows.length, revenue: 0, materials: 0, labour: 0, direct: 0, cost: 0, profit: 0, estimated: 0, uncosted: 0 };
  for (const r of rows) {
    t.revenue += r.revenue; t.materials += r.materials; t.labour += r.labour;
    t.direct += r.direct; t.cost += r.cost; t.profit += r.profit;
    if (r.revenue_estimated) t.estimated += 1;
    if (r.cost === 0) t.uncosted += 1;
  }
  for (const k of ['revenue', 'materials', 'labour', 'direct', 'cost', 'profit']) t[k] = r2(t[k]);
  t.margin = t.revenue > 0 ? r2((t.profit / t.revenue) * 100) : null;
  return t;
}
