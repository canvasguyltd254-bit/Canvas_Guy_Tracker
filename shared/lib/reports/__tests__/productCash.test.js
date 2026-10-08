import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCents, orderWeights, buildProductCash } from '../productCash.js';
import { buildPaymentsReport } from '../paymentsReceived.js';

test('allocateCents always sums back exactly', () => {
  for (const [total, w] of [[10000, [1, 1, 1]], [1, [3, 3, 3]], [99999, [7, 11, 13, 17]], [0, [1, 2]], [-500, [1, 1, 1]]]) {
    const parts = allocateCents(total, w);
    assert.equal(parts.reduce((s, p) => s + p, 0), total, JSON.stringify([total, w]));
  }
  assert.deepEqual(allocateCents(100, [0, 0]), [0, 0]);
  assert.deepEqual(allocateCents(100, []), []);
});

test('orderWeights groups categories case-insensitively and falls back net → list price', () => {
  const w = orderWeights([
    { category: 'Sofa', gross_amount: 1160, quantity: 1 },
    { category: ' sofa ', gross_amount: 580, quantity: 2 },
    { category: 'Bed', net_amount: 500, quantity: 1 },
    { category: 'Wall art', unit_price: 100, quantity: 3 },
  ]);
  const by = Object.fromEntries(w.map(x => [x.label, x]));
  assert.equal(w.length, 3);
  assert.equal(by.Sofa.weight, 174000);
  assert.equal(by.Sofa.units, 3);
  assert.equal(by.Bed.weight, 50000);
  assert.equal(by['Wall art'].weight, 30000);
  assert.deepEqual(orderWeights([{ category: 'X', quantity: 1 }]), []);
});

const items = {
  o1: [{ category: 'Sofa', gross_amount: 600, net_amount: 517.24, quantity: 1, line_type: 'product' },
       { category: 'Table', gross_amount: 400, net_amount: 344.83, quantity: 2, line_type: 'product' }],
  o2: [{ category: 'Sofa', gross_amount: 1000, net_amount: 862.07, quantity: 1 }],
  bare: [],
};
const pay = (id, order_id, amount, extra = {}) => ({ id, order_id, amount, payment_date: '2026-10-02', orders: { status: 'Production' }, ...extra });

test('cash is allocated pro-rata and reconciles to Payments Received', () => {
  const payments = [
    pay('p1', 'o1', 500),
    pay('p2', 'o2', 250),
    pay('p3', 'bare', 100),                                   // no lines → unallocated
    pay('p4', 'o1', 70, { reversed_at: '2026-10-03' }),       // reversed → ignored
    pay('p5', 'o1', 90, { orders: { status: 'Cancelled / Refunded' } }), // excluded
  ];
  const expected = buildPaymentsReport(payments, { from: '2026-10-01', to: '2026-10-31' }).summary.total;
  const r = buildProductCash({ payments, itemsByOrder: items, expectedTotal: expected });
  const by = Object.fromEntries(r.rows.map(x => [x.category, x]));
  assert.equal(by.Sofa.cash, 300 + 250);
  assert.equal(by.Table.cash, 200);
  assert.equal(r.reconciliation.unallocated, 100);
  assert.equal(r.reconciliation.excluded, 90);
  assert.equal(r.reconciliation.reversedPayments, 1);
  assert.equal(r.reconciliation.total, 850);
  assert.equal(expected, 850);
  assert.equal(r.reconciliation.ok, true);
  assert.equal(r.totals.cash + r.reconciliation.unallocated, 850);
});

test('a wrong expected total is flagged, not hidden', () => {
  const r = buildProductCash({ payments: [pay('p1', 'o1', 500)], itemsByOrder: items, expectedTotal: 499 });
  assert.equal(r.reconciliation.ok, false);
  assert.equal(r.reconciliation.difference, 1);
});

test('odd-cent splits still add up', () => {
  const three = { x: [{ category: 'A', gross_amount: 100 }, { category: 'B', gross_amount: 100 }, { category: 'C', gross_amount: 100 }] };
  const r = buildProductCash({ payments: [pay('p', 'x', 100)], itemsByOrder: three, expectedTotal: 100 });
  assert.equal(r.rows.reduce((s, x) => s + Math.round(x.cash * 100), 0), 10000);
  assert.equal(r.reconciliation.ok, true);
});

test('cohort: invoiced / collected / outstanding / margin by category', () => {
  const cohort = [{ id: 'o1', total_value: 1000 }, { id: 'o2', total_value: 1000 }, { id: 'bare', total_value: 300 }];
  const r = buildProductCash({
    payments: [], cohort, itemsByOrder: items,
    payTotals: { o1: 500, o2: 1000 },
    pnlByOrder: {
      o1: { revenue: 862.07, cost: 400, revenue_estimated: false },
      o2: { revenue: 862.07, cost: 0, revenue_estimated: true },
    },
  });
  const by = Object.fromEntries(r.rows.map(x => [x.category, x]));
  assert.equal(by.Sofa.invoiced, 600 + 1000);
  assert.equal(by.Sofa.collected, 300 + 1000);
  assert.equal(by.Sofa.outstanding, 300);
  assert.equal(by.Table.outstanding, 200);
  assert.equal(by.Sofa.units, 1 + 1);
  assert.equal(by.Sofa.cost, 240);
  assert.equal(r.totals.invoiced, 2000);
  assert.equal(r.totals.outstanding, 500);
  assert.equal(r.flags.estimatedOrders, 1);
  assert.equal(r.flags.uncostedOrders, 1);
  assert.equal(by.Table.margin !== null, true);
  assert.equal(r.flags.ordersWithoutLines, 1);
  assert.equal(r.flags.ordersWithoutLinesValue, 300);
});

test('a category with revenue but no recorded cost has no margin (not 100%)', () => {
  const r = buildProductCash({
    cohort: [{ id: 'o2', total_value: 1000 }], itemsByOrder: items, payTotals: { o2: 1000 },
    pnlByOrder: { o2: { revenue: 862.07, cost: 0, revenue_estimated: false } },
  });
  assert.equal(r.rows[0].margin, null);
  assert.equal(r.rows[0].uncosted, true);
  assert.equal(r.totals.margin, null);
  assert.equal(r.flags.uncostedOrders, 1);
});
