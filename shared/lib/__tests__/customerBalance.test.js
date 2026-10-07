import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcCustomerStats, isInvoiceRecognised, SETTLED_TOLERANCE } from '../customerBalance.js';

const TODAY = '2026-10-07';
const cust  = (ob = 0) => ({ opening_balance: ob });
const order = (id, total, due, status = 'Delivered', extra = {}) =>
  ({ id, total_value: total, payment_due_date: due, status, ...extra });

test('a sub-KES-0.5 float residue is not overdue, but a real KES 1 balance is', () => {
  const orders = [order('a', 100000, '2026-09-01')];
  const s = calcCustomerStats(cust(), orders, { a: 99999.7 }, TODAY);
  assert.equal(s.overdue, 0);
  const real = calcCustomerStats(cust(), orders, { a: 99999 }, TODAY);
  assert.equal(real.overdue, 1);
  assert.deepEqual(s.overdueAging, { d1_30: 0, d31_60: 0, d60p: 0 });
  assert.equal(s.oldestOverdueDays, 0);
});

test('a real shortfall at the tolerance boundary is overdue', () => {
  const orders = [order('a', 1000, '2026-09-01')];
  const s = calcCustomerStats(cust(), orders, { a: 1000 - SETTLED_TOLERANCE }, TODAY);
  assert.equal(s.overdue, SETTLED_TOLERANCE);
});

test('ageing buckets by days past due and sum to overdue', () => {
  const orders = [
    order('a', 100, '2026-10-01'),   //  6 days → 1–30
    order('b', 200, '2026-09-07'),   // 30 days → 1–30 (boundary)
    order('c', 300, '2026-09-06'),   // 31 days → 31–60
    order('d', 400, '2026-08-08'),   // 60 days → 31–60 (boundary)
    order('e', 500, '2026-08-07'),   // 61 days → 60+
  ];
  const s = calcCustomerStats(cust(), orders, {}, TODAY);
  assert.deepEqual(s.overdueAging, { d1_30: 300, d31_60: 700, d60p: 500 });
  assert.equal(s.overdue, 1500);
  assert.equal(s.overdueAging.d1_30 + s.overdueAging.d31_60 + s.overdueAging.d60p, s.overdue);
  assert.equal(s.oldestOverdueDays, 61);
});

test('only delivered orders past their due date age; open and future ones do not', () => {
  const orders = [
    order('a', 100, '2026-09-01', 'Production'),      // not delivered
    order('b', 200, '2026-10-20', 'Delivered'),       // not yet due
    order('c', 300, null,         'Delivered'),       // no due date
  ];
  const s = calcCustomerStats(cust(), orders, {}, TODAY);
  assert.equal(s.overdue, 0);
  assert.equal(s.notYetDue, 600);
});

test('notYetDue is outstanding minus overdue, including opening balance, never negative', () => {
  const orders = [order('a', 1000, '2026-09-01')];
  const s = calcCustomerStats(cust(500), orders, { a: 200 }, TODAY);
  assert.equal(s.outstanding, 1300);
  assert.equal(s.overdue, 800);
  assert.equal(s.notYetDue, 500);
  const credit = calcCustomerStats(cust(0), [order('a', 100, '2026-09-01')], { a: 400 }, TODAY);
  assert.equal(credit.notYetDue, 0);
});

test('existing fields are unchanged', () => {
  const orders = [order('a', 1000, '2026-10-30', 'Production')];
  const s = calcCustomerStats(cust(), orders, { a: 250 }, TODAY);
  assert.equal(s.totalSales, 1000);
  assert.equal(s.totalPaid, 250);
  assert.equal(s.outstanding, 750);
  assert.equal(s.activeWorkValue, 1000);
  assert.equal(s.activeOrders, 1);
});

test('isInvoiceRecognised: quote orders need an invoice number, direct orders always count', () => {
  assert.equal(isInvoiceRecognised({ quote_id: null, invoice_number: null }), true);
  assert.equal(isInvoiceRecognised({ quote_id: 'q', invoice_number: null }), false);
  assert.equal(isInvoiceRecognised({ quote_id: 'q', invoice_number: 'INV-1' }), true);
});
