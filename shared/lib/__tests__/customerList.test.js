import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone, normalizeName, findDuplicateGroups, duplicateIndex,
  isOwing, isOverdue, isDormant, creditUsed, isNearLimit,
  matchesChip, chipCounts, matchesSearch, sortCustomers,
  ageingTotals, summarise, buildAttention,
} from '../customerList.js';

const TODAY = '2026-10-07';
const mk = (id, name, over = {}, stats = {}) => ({
  id, name, phone: null, credit_limit: 0, credit_terms: 'COD', created_at: '2026-09-01T00:00:00Z',
  _stats: { outstanding: 0, overdue: 0, total_sales: 0, last_order_date: '2026-10-01', ...stats }, ...over,
});

test('phone normalisation unifies 07…, +254… and spaced forms; short numbers are ignored', () => {
  assert.equal(normalizePhone('0702 264 538'), '702264538');
  assert.equal(normalizePhone('+254 702-264-538'), '702264538');
  assert.equal(normalizePhone('254702264538'), '702264538');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(null), null);
});

test('name normalisation ignores case, punctuation and spacing', () => {
  assert.equal(normalizeName('  Caviar  Interiors. '), 'caviar interiors');
  assert.equal(normalizeName(''), null);
});

test('duplicates: same phone groups differently named records (the Caroline case)', () => {
  const cs = [
    mk('1', 'Caroline',         { phone: '0702264538' }),
    mk('2', 'Caroline Rintari', { phone: '0702264538' }),
    mk('3', 'Caroline Rintari', { phone: '+254702264538' }),
    mk('4', 'Someone Else',     { phone: '0711000111' }),
  ];
  const groups = findDuplicateGroups(cs);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids.sort(), ['1', '2', '3']);
  assert.equal(groups[0].reason, 'phone and name');
  assert.equal(duplicateIndex(groups).has('4'), false);
});

test('duplicates: same name with different phones is flagged by name; unique records are not', () => {
  const cs = [
    mk('1', 'Westgate Mall', { phone: '0733111222' }),
    mk('2', 'westgate mall', { phone: '0733999888' }),
    mk('3', 'Akaka Omari',   { phone: '0720692126' }),
  ];
  const g = findDuplicateGroups(cs);
  assert.equal(g.length, 1);
  assert.equal(g[0].reason, 'name');
  assert.deepEqual(findDuplicateGroups([cs[2]]), []);
});

test('duplicates: records without phone or name never group on null', () => {
  const cs = [mk('1', 'A', { phone: null }), mk('2', 'B', { phone: '' })];
  assert.deepEqual(findDuplicateGroups(cs), []);
});

test('owing / overdue use the 0.5 settled tolerance', () => {
  assert.equal(isOwing(mk('a', 'A', {}, { outstanding: 0.4 })), false);
  assert.equal(isOwing(mk('a', 'A', {}, { outstanding: 1 })), true);
  assert.equal(isOwing(mk('a', 'A', {}, { outstanding: -500 })), false);
  assert.equal(isOverdue(mk('a', 'A', {}, { overdue: 1 })), true);
});

test('dormant: >90 days since last order; never-ordered only once the record is old', () => {
  assert.equal(isDormant(mk('a', 'A', {}, { last_order_date: '2026-07-01' }), TODAY), true);
  assert.equal(isDormant(mk('a', 'A', {}, { last_order_date: '2026-08-01' }), TODAY), false);
  assert.equal(isDormant(mk('a', 'A', { created_at: '2026-10-01T00:00:00Z' }, { last_order_date: null }), TODAY), false);
  assert.equal(isDormant(mk('a', 'A', { created_at: '2026-01-01T00:00:00Z' }, { last_order_date: null }), TODAY), true);
});

test('credit used: null without a limit, ratio with one, near-limit at 80%', () => {
  assert.equal(creditUsed(mk('a', 'A')), null);
  const c = mk('a', 'A', { credit_limit: '800000' }, { outstanding: 736000 });
  assert.equal(creditUsed(c), 0.92);
  assert.equal(isNearLimit(c), true);
  assert.equal(isNearLimit(mk('b', 'B', { credit_limit: 1000 }, { outstanding: 500 })), false);
  assert.equal(isNearLimit(mk('c', 'C')), false);
});

test('chips filter and count consistently', () => {
  const cs = [
    mk('1', 'Owes',    {}, { outstanding: 500 }),
    mk('2', 'Overdue', {}, { outstanding: 900, overdue: 900 }),
    mk('3', 'Dormant', {}, { last_order_date: '2026-01-01' }),
    mk('4', 'Clear',   {}, {}),
  ];
  const counts = chipCounts(cs, TODAY);
  assert.deepEqual(counts, { all: 4, owes: 2, overdue: 1, dormant: 1 });
  for (const chip of ['all', 'owes', 'overdue', 'dormant']) {
    assert.equal(cs.filter(c => matchesChip(c, chip, TODAY)).length, counts[chip]);
  }
});

test('search matches name, contact, email and phone in any format', () => {
  const c = mk('1', 'Caviar Interiors', { contact_person: 'Mary', email: 'a@b.co', phone: '0712 345 678' });
  assert.equal(matchesSearch(c, 'caviar'), true);
  assert.equal(matchesSearch(c, 'mary'), true);
  assert.equal(matchesSearch(c, '+254712345678'.slice(-9)), true);
  assert.equal(matchesSearch(c, '712 345'), true);
  assert.equal(matchesSearch(c, 'zzz'), false);
  assert.equal(matchesSearch(c, '  '), true);
});

test('sort: owes desc puts debtors first; nulls always last; stable on ties', () => {
  const cs = [
    mk('1', 'A', {}, { outstanding: 0 }),
    mk('2', 'B', {}, { outstanding: 900 }),
    mk('3', 'C', {}, { outstanding: 900 }),
    mk('4', 'D', {}, { outstanding: 100 }),
  ];
  assert.deepEqual(sortCustomers(cs, 'owes', 'desc').map(c => c.id), ['2', '3', '4', '1']);
  assert.deepEqual(sortCustomers(cs, 'owes', 'asc').map(c => c.id), ['1', '4', '2', '3']);
  const lim = [
    mk('1', 'A'),                                              // no limit → null
    mk('2', 'B', { credit_limit: 1000 }, { outstanding: 500 }),
    mk('3', 'C', { credit_limit: 1000 }, { outstanding: 900 }),
  ];
  assert.deepEqual(sortCustomers(lim, 'credit', 'desc').map(c => c.id), ['3', '2', '1']);
  assert.deepEqual(sortCustomers(lim, 'credit', 'asc').map(c => c.id), ['2', '3', '1']);
  assert.deepEqual(sortCustomers(cs, 'name', 'asc').map(c => c.name), ['A', 'B', 'C', 'D']);
});

test('sort does not mutate its input', () => {
  const cs = [mk('1', 'B'), mk('2', 'A')];
  sortCustomers(cs, 'name', 'asc');
  assert.deepEqual(cs.map(c => c.id), ['1', '2']);
});

test('ageing totals add up across customers', () => {
  const cs = [
    mk('1', 'A', {}, { outstanding: 1500, overdue: 800, not_yet_due: 700, overdue_aging: { d1_30: 300, d31_60: 500, d60p: 0 } }),
    mk('2', 'B', {}, { outstanding: 400,  overdue: 400, not_yet_due: 0,   overdue_aging: { d1_30: 0, d31_60: 0, d60p: 400 } }),
  ];
  const t = ageingTotals(cs);
  assert.deepEqual(t, { notYetDue: 700, d1_30: 300, d31_60: 500, d60p: 400, overdue: 1200, total: 1900 });
});

test('summary: receivables ignore credit balances; top debtor share is computed', () => {
  const cs = [
    mk('1', 'Big',    {}, { outstanding: 750, overdue: 100, active_work_value: 1000, active_orders: 2 }),
    mk('2', 'Small',  {}, { outstanding: 250, active_work_value: 500,  active_orders: 1 }),
    mk('3', 'Credit', {}, { outstanding: -300 }),
    mk('4', 'Old',    {}, { last_order_date: '2026-01-01' }),
  ];
  const s = summarise(cs, TODAY);
  assert.equal(s.receivables, 1000);
  assert.equal(s.overdue, 100);
  assert.equal(s.overdueCustomers, 1);
  assert.equal(s.openWork, 1500);
  assert.equal(s.activeOrders, 3);
  assert.equal(s.dormant, 1);
  assert.equal(s.active, 3);
  assert.equal(s.topDebtor.name, 'Big');
  assert.equal(s.topDebtor.share, 0.75);
});

test('summary of an empty list is all zeros with no top debtor', () => {
  const s = summarise([], TODAY);
  assert.equal(s.receivables, 0);
  assert.equal(s.topDebtor, null);
});

test('attention queue: overdue (largest first), then limit, then duplicates', () => {
  const cs = [
    mk('1', 'Small overdue', {}, { outstanding: 200, overdue: 200, oldest_overdue_days: 10 }),
    mk('2', 'Big overdue',   {}, { outstanding: 900, overdue: 900, oldest_overdue_days: 40 }),
    mk('3', 'Near limit',    { credit_limit: 1000 }, { outstanding: 850 }),
    mk('4', 'Over limit',    { credit_limit: 1000 }, { outstanding: 1200 }),
  ];
  const groups = [{ ids: ['5', '6'], names: ['X', 'X Ltd'], reason: 'phone' }];
  const q = buildAttention(cs, groups);
  assert.deepEqual(q.map(i => i.kind), ['overdue', 'overdue', 'limit', 'limit', 'duplicate']);
  assert.equal(q[0].title, 'Big overdue');
  assert.equal(q[0].days, 40);
  assert.equal(q[2].title, 'Over limit');
  assert.equal(q[2].tone, 'red');
  assert.equal(q[3].chip, 'Near limit');
  assert.equal(q[4].count, 2);
});
