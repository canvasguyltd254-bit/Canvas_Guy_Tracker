import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLiveInvoice, owes, daysPastDue, dueInfo, ageingBucket, invoiceTabs, invoiceTabCounts,
  matchesInvoiceSearch, summariseInvoices, AGEING_BUCKETS,
} from '../invoiceView.js';

const TODAY = '2026-10-08';
const inv = (o = {}) => ({ pending_invoice: false, status: 'Production', total_value: 1000, total_paid: 0, balance: 1000, payment_due_date: '2026-10-20', ...o });

test('live invoice excludes pending, cancelled and suspended', () => {
  assert.equal(isLiveInvoice(inv()), true);
  assert.equal(isLiveInvoice(inv({ pending_invoice: true })), false);
  assert.equal(isLiveInvoice(inv({ status: 'Cancelled / Refunded' })), false);
  assert.equal(isLiveInvoice(inv({ suspended_at: '2026-10-01' })), false);
  assert.equal(owes(inv({ balance: 0.4 })), false);   // inside tolerance = settled
  assert.equal(owes(inv({ balance: 0.5 })), true);
});

test('dueInfo: overdue, today, soon, later, undated, and nothing when settled', () => {
  const d = o => dueInfo(inv(o), TODAY);
  assert.deepEqual(d({ payment_due_date: '2026-10-05' }), { text: '3 days overdue', tone: 'amber', overdue: true });
  assert.equal(d({ payment_due_date: '2026-08-01' }).tone, 'red');          // > 30 days late
  assert.equal(d({ payment_due_date: '2026-10-08' }).text, 'Due today');
  assert.deepEqual(d({ payment_due_date: '2026-10-12' }), { text: 'Due in 4 days', tone: 'amber', overdue: false });
  assert.equal(d({ payment_due_date: '2026-10-30' }).tone, 'muted');
  assert.equal(d({ payment_due_date: null }).text, 'No due date');
  assert.equal(d({ balance: 0 }), null);
  assert.equal(d({ pending_invoice: true }), null);
});

test('ageing buckets', () => {
  const b = date => ageingBucket(inv({ payment_due_date: date }), TODAY);
  assert.equal(b('2026-10-20'), 'current');
  assert.equal(b('2026-10-08'), 'current');
  assert.equal(b('2026-10-07'), 'd1_30');
  assert.equal(b('2026-09-08'), 'd1_30');   // 30 days
  assert.equal(b('2026-09-07'), 'd31_60');
  assert.equal(b('2026-08-09'), 'd31_60');  // 60
  assert.equal(b('2026-08-08'), 'd61_90');
  assert.equal(b('2026-05-01'), 'd90p');
  assert.equal(b(null), 'nodate');
  assert.equal(daysPastDue(inv(), 'bad'), null);
});

test('tabs and counts', () => {
  assert.deepEqual(invoiceTabs(inv({ pending_invoice: true }), TODAY), ['all', 'pending']);
  assert.deepEqual(invoiceTabs(inv({ status: 'Cancelled / Refunded' }), TODAY), ['all', 'cancelled']);
  assert.deepEqual(invoiceTabs(inv({ balance: 0, total_paid: 1000 }), TODAY), ['all', 'paid']);
  assert.deepEqual(invoiceTabs(inv(), TODAY), ['all', 'outstanding']);
  assert.deepEqual(invoiceTabs(inv({ payment_due_date: '2026-10-01' }), TODAY), ['all', 'outstanding', 'overdue']);
  const c = invoiceTabCounts([inv(), inv({ payment_due_date: '2026-10-01' }), inv({ balance: 0 }), inv({ pending_invoice: true })], TODAY);
  assert.deepEqual(c, { all: 4, outstanding: 2, overdue: 1, paid: 1, pending: 1, cancelled: 0 });
});

test('search covers invoice, customer (current or issued name), quote and order', () => {
  const i = inv({ invoice_number: 'INV-2026-0007', customer_name: 'Dee Interiors', customer_name_current: 'Dee Ltd', quote_num: 'QT-2026-0100', order_num: 'ORD-057' });
  for (const t of ['inv-2026-0007', 'dee', 'ltd', 'qt-2026-0100', 'ord-057', 'dee ord']) assert.equal(matchesInvoiceSearch(i, t), true, t);
  assert.equal(matchesInvoiceSearch(i, 'zzz'), false);
});

test('summary: money, ageing sums to outstanding, pending and cancelled kept out', () => {
  const list = [
    inv({ total_value: 1000, total_paid: 400, balance: 600, payment_due_date: '2026-10-01' }),   // overdue 7d
    inv({ total_value: 2000, total_paid: 0, balance: 2000, payment_due_date: '2026-10-10' }),    // due soon
    inv({ total_value: 500, total_paid: 0, balance: 500, payment_due_date: '2026-12-01' }),      // later
    inv({ total_value: 300, total_paid: 0, balance: 300, payment_due_date: null }),               // undated
    inv({ total_value: 800, total_paid: 800, balance: 0 }),                                       // paid
    inv({ pending_invoice: true, total_value: 9000 }),
    inv({ status: 'Cancelled / Refunded', total_value: 7000, balance: 7000 }),
    inv({ suspended_at: '2026-10-01', total_value: 6000, balance: 6000 }),
  ];
  const s = summariseInvoices(list, TODAY);
  assert.equal(s.invoiced, 4600);
  assert.equal(s.collected, 1200);
  assert.equal(s.outstanding, 3400);
  assert.equal(s.invoiceCount, 5);
  assert.equal(s.owingCount, 4);
  assert.equal(s.overdue, 600); assert.equal(s.overdueCount, 1);
  assert.equal(s.dueSoon, 2000); assert.equal(s.dueSoonCount, 1);
  assert.equal(s.undated, 300);
  assert.equal(s.pendingCount, 1); assert.equal(s.pendingValue, 9000);
  assert.equal(s.collectionRate, 26);
  const ageTotal = AGEING_BUCKETS.reduce((t, b) => t + s.ageing[b.key], 0);
  assert.equal(ageTotal, s.outstanding);
  assert.equal(s.ageing.d1_30, 600); assert.equal(s.ageing.current, 2500); assert.equal(s.ageing.nodate, 300);
  assert.equal(summariseInvoices([], TODAY).collectionRate, null);
});
