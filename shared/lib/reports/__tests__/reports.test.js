import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCancelled, isSuspended, isLive, inRange, makeValueModel, makeOrderFilters,
  countUndatedReceivables, sortRows, daysPast, DEFAULT_SORT,
} from '../orderRules.js';
import { fetchAllRows, chunk, fetchByIds } from '../fetchAll.js';
import { toCsv } from '../csv.js';
import { buildPaymentsReport, basisDate } from '../paymentsReceived.js';
import { orderNetRevenue, buildOrderPnlRows, pnlTotals } from '../orderPnl.js';
import { nairobiBounds, nairobiToday, validateQueryRange } from '../dateBounds.js';

const TODAY = '2026-10-07';

// ── order rules ─────────────────────────────────────────────────────────────

test('cancelled spellings and suspended orders are not live', () => {
  for (const s of ['Cancelled / Refunded', 'Cancelled/Refunded', 'Cancelled', 'Refunded']) {
    assert.equal(isCancelled({ status: s }), true, s);
    assert.equal(isLive({ status: s }), false, s);
  }
  assert.equal(isSuspended({ suspended_at: '2026-10-01T00:00:00Z' }), true);
  assert.equal(isLive({ status: 'Production', suspended_at: '2026-10-01T00:00:00Z' }), false);
  assert.equal(isLive({ status: 'Production' }), true);
  assert.equal(isLive(null), false);
});

test('inRange is inclusive and open-ended', () => {
  assert.equal(inRange('2026-10-01', { from: '2026-10-01', to: '2026-10-31' }), true);
  assert.equal(inRange('2026-10-31', { from: '2026-10-01', to: '2026-10-31' }), true);
  assert.equal(inRange('2026-09-30', { from: '2026-10-01' }), false);
  assert.equal(inRange('2027-01-01', { from: '2026-10-01' }), true);
  assert.equal(inRange(null, {}), false);
});

test('value model: full total, prorated partial batch, unknown on load error', () => {
  const payTotals = { a: 400, b: 100 };
  const o = { id: 'a', status: 'Production', total_value: 1000 };
  const partial = { id: 'b', status: 'Partially Delivered', total_value: 1000 };
  const m = makeValueModel({ payTotals, batchOrderIds: new Set(['b']), deliveredValues: { b: 600 } });
  assert.equal(m.balance(o), 600);
  assert.equal(m.billable(partial), 600);
  assert.equal(m.balance(partial), 500);
  assert.equal(m.undelivered(partial), 400);
  // partial status but no batch rows → not treated as batch
  assert.equal(m.billable({ id: 'z', status: 'Partially Delivered', total_value: 50 }), 50);
  const err = makeValueModel({ payTotals, batchOrderIds: new Set(['b']), batchLoadError: 'x' });
  assert.equal(err.billable(partial), null);
  assert.equal(err.balance(partial), null);
  assert.equal(err.undelivered(partial), null);
  // overpaid never goes negative
  assert.equal(makeValueModel({ payTotals: { a: 5000 } }).balance(o), 0);
});

const orders = [
  { id: '1', status: 'Delivered', total_value: 1000, due_date: '2026-09-01', payment_due_date: '2026-09-20', created_at: '2026-09-02T10:00:00Z' },
  { id: '2', status: 'Cancelled / Refunded', total_value: 700, payment_due_date: '2026-09-20', created_at: '2026-09-03T10:00:00Z', due_date: '2026-09-01' },
  { id: '3', status: 'Delivered', total_value: 500, payment_due_date: '2026-09-25', suspended_at: '2026-09-30T00:00:00Z', created_at: '2026-09-04T10:00:00Z' },
  { id: '4', status: 'Closed', total_value: 300, payment_due_date: '2026-09-22', created_at: '2026-09-05T10:00:00Z' },
  { id: '5', status: 'Production', total_value: 800, quote_id: 'q', invoice_number: null, created_at: '2026-09-06T10:00:00Z', due_date: '2026-10-07' },
  { id: '6', status: 'Delivered', total_value: 200, created_at: '2026-09-07T10:00:00Z' },
  { id: '7', status: 'Production', total_value: 900, due_date: '2026-10-06', created_at: '2026-09-08T10:00:00Z' },
];
const model = makeValueModel({ payTotals: { 1: 400, 4: 0, 6: 0 } });
const range = { from: '2026-09-01', to: '2026-09-30' };
const F = makeOrderFilters({ today: TODAY, range, model });
const ids = fn => orders.filter(fn).map(o => o.id);

test('receivables exclude cancelled, suspended and un-invoiced quote orders; include Closed with a balance', () => {
  assert.deepEqual(ids(F.receivables), ['1', '4', '6', '7']);
});

test('collections use payment_due_date, not the delivery due date', () => {
  assert.deepEqual(ids(F.collections), ['1', '4']);
  const f2 = makeOrderFilters({ today: TODAY, range: { from: '2026-09-21', to: '2026-09-30' }, model });
  assert.deepEqual(orders.filter(f2.collections).map(o => o.id), ['4']);
});

test('undated receivables are counted separately', () => {
  assert.deepEqual(countUndatedReceivables(orders, model), { count: 2, amount: 1100 });
});

test('overdue (production): date-only, due today is not late, finished and dead orders excluded', () => {
  assert.deepEqual(ids(F.overdue), ['7']);   // 2 is cancelled; 1 delivered; 5 due today
});

test('sales/completed/pnl filters respect dead orders and the period', () => {
  assert.deepEqual(ids(F['sales-week']), ['1', '4', '6', '7']);   // 5 un-invoiced quote, 2/3 dead
  assert.deepEqual(ids(F.completed), ['1', '4', '6']);
  assert.deepEqual(ids(F['order-pnl']), ['1', '4', '5', '6', '7']);
  const none = makeOrderFilters({ today: TODAY, range: { from: '2026-10-01', to: '2026-10-31' }, model });
  assert.deepEqual(orders.filter(none['sales-week']), []);
});

test('created_at is bucketed by local calendar day, not raw UTC string', () => {
  const o = { id: 'x', status: 'Production', total_value: 1, created_at: '2026-09-30T12:00:00Z' };
  assert.equal(makeOrderFilters({ today: TODAY, range, model })['order-pnl'](o), true);
});

test('daysPast', () => {
  assert.equal(daysPast('2026-10-01', TODAY), 6);
  assert.equal(daysPast('2026-10-07', TODAY), 0);
  assert.equal(daysPast('2026-10-09', TODAY), 0);
  assert.equal(daysPast(null, TODAY), 0);
});

test('sortRows: numeric, text, nulls last both ways, stable', () => {
  const rows = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }, { n: 'd', v: 2 }];
  const get = (r, f) => r[f];
  assert.deepEqual(sortRows(rows, 'v', 'asc', get).map(r => r.n), ['b', 'd', 'c', 'a']);
  assert.deepEqual(sortRows(rows, 'v', 'desc', get).map(r => r.n), ['c', 'b', 'd', 'a']);
  assert.deepEqual(sortRows(rows, 'n', 'asc', get).map(r => r.n), ['a', 'b', 'c', 'd']);
  assert.equal(sortRows(rows, null, 'asc', get), rows);
  assert.ok(DEFAULT_SORT.receivables && DEFAULT_SORT['order-pnl']);
});

// ── paging ──────────────────────────────────────────────────────────────────

test('fetchAllRows pages past the 1000-row cap and stops on a short page', async () => {
  const all = Array.from({ length: 2300 }, (_, i) => ({ i }));
  const calls = [];
  const rows = await fetchAllRows((f, t) => { calls.push([f, t]); return Promise.resolve({ data: all.slice(f, t + 1), error: null }); }, { label: 'x' });
  assert.equal(rows.length, 2300);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('fetchAllRows: an exact multiple of the page size asks for one more page', async () => {
  const all = Array.from({ length: 2000 }, (_, i) => ({ i }));
  let n = 0;
  const rows = await fetchAllRows((f, t) => { n += 1; return Promise.resolve({ data: all.slice(f, t + 1), error: null }); });
  assert.equal(rows.length, 2000);
  assert.equal(n, 3);
});

test('fetchAllRows throws on error so a failed read never looks empty', async () => {
  await assert.rejects(
    fetchAllRows(() => Promise.resolve({ data: null, error: { message: 'boom' } }), { label: 'orders' }),
    /Could not load orders: boom/,
  );
});

test('chunk and fetchByIds', async () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const seen = [];
  const out = await fetchByIds(['a', 'a', 'b', null, 'c'], async part => { seen.push(part); return part.map(x => ({ x })); }, 2);
  assert.deepEqual(seen, [['a', 'b'], ['c']]);
  assert.equal(out.length, 3);
});

// ── csv ─────────────────────────────────────────────────────────────────────

test('csv: BOM, CRLF, quoting, numbers untouched, formula injection neutralised', () => {
  const csv = toCsv(
    [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Amount' }],
    [{ a: 'Say "hi", ok', b: -1500.5 }, { a: '=SUM(A1)', b: 0 }, { a: '+254', b: null }, { a: 'line\nbreak', b: 1 }],
  );
  assert.ok(csv.startsWith('﻿Name,Amount\r\n'));
  assert.ok(csv.includes('"Say ""hi"", ok",-1500.5\r\n'));
  assert.ok(csv.includes("'=SUM(A1),0\r\n"));
  assert.ok(csv.includes("'+254,\r\n"));
  assert.ok(csv.includes('"line\nbreak",1\r\n'));
});

// ── payments received ───────────────────────────────────────────────────────

const pays = [
  { id: 'p1', amount: 1000, payment_date: '2026-10-01', banked_date: '2026-10-01', payment_method: 'Bank Transfer', orders: { client: 'Acme', customer_id: 'c1', order_num: 'O1', status: 'Delivered' } },
  { id: 'p2', amount: '2500.50', payment_date: '2026-10-03', banked_date: null, payment_method: 'M-Pesa', orders: { client: 'Bolt', customer_id: 'c2', order_num: 'O2', status: 'Production' } },
  { id: 'p3', amount: 400, payment_date: '2026-10-03', banked_date: '2026-10-05', payment_method: null, orders: { client: 'Acme', customer_id: 'c1', order_num: 'O1', status: 'Delivered' } },
  { id: 'p4', amount: 999, payment_date: '2026-10-02', reversed_at: '2026-10-04T08:00:00Z', orders: { client: 'Acme', customer_id: 'c1', status: 'Delivered' } },
  { id: 'p5', amount: 300, payment_date: '2026-10-02', orders: { client: 'Dead', customer_id: 'c3', status: 'Cancelled / Refunded' } },
  { id: 'p6', amount: 50, payment_date: '2026-10-02', orders: { client: 'Hold', customer_id: 'c4', status: 'Delivered', suspended_at: '2026-10-02T00:00:00Z' } },
  { id: 'p7', amount: 70, payment_date: '2026-09-30', orders: { client: 'Acme', customer_id: 'c1', status: 'Delivered' } },
  { id: 'p8', amount: 80, payment_date: '2026-10-04', orders: { client: 'Acme', customer_id: 'c1', status: 'Delivered' } },
];

test('payments received: total, reversed and excluded are separate, range inclusive', () => {
  const r = buildPaymentsReport(pays, { from: '2026-10-01', to: '2026-10-03' });
  assert.equal(r.summary.total, 3900.5);
  assert.equal(r.summary.count, 3);
  assert.equal(r.summary.largest, 2500.5);
  assert.equal(r.summary.average, 1300.17);
  assert.deepEqual(r.reversed, { count: 1, total: 999 });
  assert.deepEqual(r.excluded, { count: 2, total: 350 });
  assert.deepEqual(r.byDay, [
    { date: '2026-10-01', count: 1, total: 1000 },
    { date: '2026-10-03', count: 2, total: 2900.5 },
  ]);
  assert.deepEqual(r.byMethod.map(m => [m.name, m.total]), [['M-Pesa', 2500.5], ['Bank Transfer', 1000], ['Unspecified', 400]]);
  assert.deepEqual(r.byCustomer.map(c => [c.name, c.total]), [['Bolt', 2500.5], ['Acme', 1400]]);
  assert.deepEqual(r.rows.map(x => x.id), ['p1', 'p3', 'p2']);
});

test('payments received: a single day, and unbanked cash is flagged', () => {
  const r = buildPaymentsReport(pays, { from: '2026-10-03', to: '2026-10-03' });
  assert.equal(r.summary.total, 2900.5);
  assert.deepEqual(r.unbanked, { count: 1, total: 2500.5 });
});

test('payments received: banked basis uses banked_date and ignores unbanked rows', () => {
  const r = buildPaymentsReport(pays, { from: '2026-10-05', to: '2026-10-05', basis: 'banked' });
  assert.equal(r.summary.total, 400);
  assert.equal(r.unbanked, null);
  assert.equal(basisDate(pays[1], 'banked'), null);
});

test('payments received: customer and method filters; float sums stay exact', () => {
  assert.equal(buildPaymentsReport(pays, { from: '2026-10-01', to: '2026-10-31', customerId: 'c2' }).summary.total, 2500.5);
  assert.equal(buildPaymentsReport(pays, { from: '2026-10-01', to: '2026-10-31', method: 'Unspecified' }).rows.length, 2);
  const tenths = Array.from({ length: 10 }, (_, i) => ({ id: String(i), amount: 0.1, payment_date: '2026-10-01', orders: { client: 'x', status: 'Delivered' } }));
  assert.equal(buildPaymentsReport(tenths, { from: '2026-10-01', to: '2026-10-01' }).summary.total, 1);
  const empty = buildPaymentsReport([], { from: '2026-10-01', to: '2026-10-01' });
  assert.equal(empty.summary.total, 0);
  assert.equal(empty.summary.average, 0);
});

// ── order p&l ───────────────────────────────────────────────────────────────

test('net revenue: exact from item net_amount, estimated otherwise', () => {
  assert.deepEqual(orderNetRevenue({ total_value: 1160 }, [{ net_amount: 600 }, { net_amount: 400 }]), { net: 1000, estimated: false });
  assert.deepEqual(orderNetRevenue({ total_value: 1160 }, [{ net_amount: 600 }, { net_amount: null }]), { net: 1000, estimated: true });
  assert.deepEqual(orderNetRevenue({ total_value: 1160 }, []), { net: 1000, estimated: true });
});

test('order p&l rows: purchases + labour + active direct expenses; margin on net revenue', () => {
  const rows = buildOrderPnlRows({
    orders: [{ id: 'a', order_num: 'A1', client: 'Acme', status: 'Delivered', total_value: 1160 }, { id: 'b', total_value: 0 }],
    itemsByOrder: { a: [{ net_amount: 1000 }] },
    purchasesByOrder: { a: [{ total_amount: 300 }, { total_amount: 100 }] },
    labourByOrder: { a: 150 },
    expensesByOrder: { a: [{ allocated_amount: 50 }, { allocated_amount: 999, reversed_at: 'x' }] },
    payTotals: { a: 600 },
  });
  const a = rows[0];
  assert.equal(a.revenue, 1000);
  assert.equal(a.materials, 400);
  assert.equal(a.labour, 150);
  assert.equal(a.direct, 50);
  assert.equal(a.cost, 600);
  assert.equal(a.profit, 400);
  assert.equal(a.margin, 40);
  assert.equal(a.collected, 600);
  assert.equal(rows[1].margin, null);
  const t = pnlTotals(rows);
  assert.equal(t.profit, a.profit + rows[1].profit);
  assert.equal(t.uncosted, 1);
  assert.equal(t.margin, 40);
});

// ── date bounds ─────────────────────────────────────────────────────────────

test('nairobiBounds and helpers', () => {
  assert.deepEqual(nairobiBounds({ from: '2026-10-01', to: '2026-10-31' }),
    { gte: '2026-10-01T00:00:00+03:00', lt: '2026-11-01T00:00:00+03:00' });
  assert.deepEqual(nairobiBounds({ from: '2026-12-31', to: '2026-12-31' }),
    { gte: '2026-12-31T00:00:00+03:00', lt: '2027-01-01T00:00:00+03:00' });
  assert.deepEqual(nairobiBounds({}), { gte: null, lt: null });
  assert.equal(nairobiToday(new Date('2026-10-07T22:30:00Z')), '2026-10-08');
  assert.equal(nairobiToday(new Date('2026-10-07T20:59:00Z')), '2026-10-07');
  assert.equal(validateQueryRange({ from: '2026-10-05', to: '2026-10-01' }), '"from" must be on or before "to".');
  assert.equal(validateQueryRange({ from: 'x' }), 'Invalid "from" date.');
  assert.equal(validateQueryRange({ from: '2026-10-01', to: '2026-10-01' }), '');
});

// ── order rows ──────────────────────────────────────────────────────────────
import { orderRow, summariseOrderRows, orderUnits, supplierRow, orderSortValue } from '../orderRows.js';

test('order rows: payment lateness only while money is owed; unknowns skipped in totals', () => {
  const m = makeValueModel({
    payTotals: { a: 400, b: 1000, c: 0 },
    batchOrderIds: new Set(['p']),
    deliveredValues: {},
    batchLoadError: 'x',
  });
  const a = orderRow({ id: 'a', client: 'A', status: 'Delivered', total_value: 1000, payment_due_date: '2026-10-01' }, m, TODAY);
  const b = orderRow({ id: 'b', client: 'B', status: 'Delivered', total_value: 1000, payment_due_date: '2026-10-01' }, m, TODAY);
  const p = orderRow({ id: 'p', client: 'P', status: 'Partially Delivered', total_value: 500 }, m, TODAY);
  assert.equal(a.balance, 600);
  assert.equal(a.days_late, 6);
  assert.equal(b.balance, 0);
  assert.equal(b.days_late, 0);       // fully paid: not late
  assert.equal(p.balance, null);       // batch data unavailable
  const t = summariseOrderRows([a, b, p]);
  assert.deepEqual(
    { count: t.count, billable: t.billable, paid: t.paid, balance: t.balance, overdue: t.overdue, overdueCount: t.overdueCount, unknown: t.unknown },
    { count: 3, billable: 2000, paid: 1400, balance: 600, overdue: 600, overdueCount: 1, unknown: 1 },
  );
});

test('order rows: sort keys, units, supplier rows', () => {
  assert.equal(orderUnits([{ quantity: 2 }, { quantity: '3' }, {}]), 6);
  assert.equal(orderUnits([]), 1);
  const s = supplierRow({ total_amount: '100', amount_paid: '130' });
  assert.equal(s.balance, 0);
  assert.equal(orderSortValue({ balance: null }, 'balance'), null);
  assert.equal(orderSortValue({ due_date: '2026-10-01' }, 'due_date'), '2026-10-01');
});
