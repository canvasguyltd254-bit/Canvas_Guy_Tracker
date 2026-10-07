import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isIsoDate, localDateOf, formatDay, presetRange, matchPreset, describePeriod, validateRange,
  filterOrders, filterReceivables, searchCustomers, customerOptionLabel,
  orderBalance, daysLate, orderKpis, receivableKpis,
} from '../customerReport.js';

const TODAY = '2026-10-07';

test('isIsoDate rejects impossible dates', () => {
  assert.equal(isIsoDate('2026-10-07'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-1-7'), false);
  assert.equal(isIsoDate(null), false);
});

test('presets: this month, last month (incl. January rollover and leap February), 3 months, year, all', () => {
  assert.deepEqual(presetRange('this_month', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(presetRange('last_month', TODAY), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('last_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(presetRange('last_month', '2024-03-10'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(presetRange('last_3_months', TODAY), { from: '2026-07-07', to: TODAY });
  assert.deepEqual(presetRange('last_3_months', '2026-05-31'), { from: '2026-02-28', to: '2026-05-31' });
  assert.deepEqual(presetRange('this_year', TODAY), { from: '2026-01-01', to: TODAY });
  assert.deepEqual(presetRange('all', TODAY), { from: null, to: null });
});

test('matchPreset recognises presets and falls back to custom', () => {
  assert.equal(matchPreset(presetRange('last_month', TODAY), TODAY), 'last_month');
  assert.equal(matchPreset({ from: null, to: null }, TODAY), 'all');
  assert.equal(matchPreset({ from: '2026-08-01', to: '2026-08-09' }, TODAY), 'custom');
});

test('describePeriod and validateRange', () => {
  assert.equal(describePeriod({ from: '2026-07-07', to: TODAY }), '7 Jul 2026 – 7 Oct 2026');
  assert.equal(describePeriod({ from: '2026-07-07', to: null }), 'From 7 Jul 2026');
  assert.equal(describePeriod({ from: null, to: TODAY }), 'Up to 7 Oct 2026');
  assert.equal(describePeriod({}), 'All time');
  assert.equal(validateRange({ from: '2026-10-07', to: '2026-10-01' }), 'The start date must be on or before the end date.');
  assert.equal(validateRange({ from: '2026-10-01', to: '2026-10-01' }), '');
  assert.equal(validateRange({ from: '2026-02-30' }), 'Enter a valid start date.');
  assert.equal(validateRange({ from: null, to: null }), '');
});

test('localDateOf keeps plain dates and converts timestamps', () => {
  assert.equal(localDateOf('2026-10-07'), '2026-10-07');
  assert.equal(localDateOf(null), null);
  assert.equal(localDateOf('not a date'), null);
  assert.match(localDateOf('2026-10-07T12:00:00Z'), /^2026-10-0[678]$/);
  assert.equal(formatDay('2026-10-07'), '7 Oct 2026');
});

const orders = [
  { id: 'a', customer_id: 'c1', created_at: '2026-10-01', status: 'Delivered', total_value: 1000, due_date: '2026-09-20' },
  { id: 'b', customer_id: 'c2', created_at: '2026-08-15', status: 'Production', total_value: 500,  due_date: '2026-12-01' },
  { id: 'c', customer_id: 'c1', created_at: '2026-06-01', status: 'Cancelled / Refunded', total_value: 900 },
  { id: 'd', customer_id: 'c1', created_at: '2026-09-30', status: 'Closed', total_value: 200, due_date: '2026-09-30' },
];

test('filterOrders: customer by id (not name), inclusive period, cancelled excluded', () => {
  assert.deepEqual(filterOrders(orders).map(o => o.id), ['a', 'b', 'd']);
  assert.deepEqual(filterOrders(orders, { customerId: 'c1' }).map(o => o.id), ['a', 'd']);
  assert.deepEqual(filterOrders(orders, { from: '2026-09-30', to: '2026-10-01' }).map(o => o.id), ['a', 'd']);
  assert.deepEqual(filterOrders(orders, { from: '2026-10-02' }).map(o => o.id), []);
  assert.deepEqual(filterOrders(orders, { to: '2026-08-15' }).map(o => o.id), ['b']);
  assert.deepEqual(filterOrders([{ id: 'x', customer_id: 'c1', created_at: null, status: 'Delivered' }], { from: '2026-01-01' }), []);
});

test('filterReceivables by id', () => {
  const cs = [{ id: '1' }, { id: '2' }];
  assert.equal(filterReceivables(cs).length, 2);
  assert.deepEqual(filterReceivables(cs, { customerId: '2' }), [{ id: '2' }]);
});

test('searchCustomers ranks prefix > substring > other fields; finds by phone in any format', () => {
  const cs = [
    { id: '1', name: 'Westgate Mall', phone: '0733111222' },
    { id: '2', name: 'Gate Works', phone: '0700000000' },
    { id: '3', name: 'Akaka Omari', phone: '0720 692 126', contact_person: 'Gate Keeper' },
    { id: '4', name: 'Caviar Interiors', email: 'x@caviar.co.ke' },
  ];
  assert.deepEqual(searchCustomers(cs, 'gate').map(c => c.id), ['2', '1', '3']);
  assert.deepEqual(searchCustomers(cs, '720692').map(c => c.id), ['3']);
  assert.deepEqual(searchCustomers(cs, 'caviar.co').map(c => c.id), ['4']);
  assert.deepEqual(searchCustomers(cs, 'zzz'), []);
  assert.equal(searchCustomers(cs, '').length, 4);
  assert.equal(searchCustomers(cs, '', 2).length, 2);
});

test('customerOptionLabel disambiguates same-named customers by phone', () => {
  assert.equal(customerOptionLabel({ name: 'Caroline Rintari', phone: '0702264538' }), 'Caroline Rintari · 0702264538');
  assert.equal(customerOptionLabel({ name: 'Solo' }), 'Solo');
});

test('order balance, days late and KPIs', () => {
  const paid = { a: 400, b: 500, d: 200 };
  assert.equal(orderBalance(orders[0], paid), 600);
  assert.equal(daysLate(orders[0], paid, TODAY), 17);          // due 20 Sep, 600 owing
  assert.equal(daysLate(orders[1], paid, TODAY), 0);           // not yet due
  assert.equal(daysLate(orders[3], paid, TODAY), 0);           // fully paid
  assert.equal(daysLate({ ...orders[0], due_date: null }, paid, TODAY), 0);
  assert.equal(daysLate({ ...orders[0], total_value: 400.2 }, paid, TODAY), 0);  // sub-0.5 residue
  const k = orderKpis([orders[0], orders[1], orders[3]], paid, TODAY);
  assert.deepEqual(k, { count: 3, value: 1700, collected: 1100, outstanding: 600, lateCount: 1, lateAmount: 600 });
});

test('over-payment does not inflate collected beyond order value', () => {
  const k = orderKpis([orders[1]], { b: 900 }, TODAY);
  assert.equal(k.collected, 500);
  assert.equal(k.outstanding, 0);
});

test('receivable KPIs ignore credit balances and count overdue customers', () => {
  const cs = [
    { _stats: { total_sales: 1000, outstanding: 600, overdue: 200 } },
    { _stats: { total_sales: 500,  outstanding: -50, overdue: 0 } },
    { _stats: { total_sales: 0,    outstanding: 0,   overdue: 0.3 } },
  ];
  assert.deepEqual(receivableKpis(cs), { count: 3, sales: 1500, outstanding: 600, overdue: 200.3, overdueCustomers: 1 });
});
