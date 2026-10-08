import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysLeft, validityInfo, statusView, primaryAction, menuActions, customerLabel,
  matchesSearch, tabCounts, summarise,
} from '../quoteView.js';

const TODAY = '2026-10-08';

test('daysLeft handles dates, timestamps, past, and missing', () => {
  assert.equal(daysLeft('2026-10-14', TODAY), 6);
  assert.equal(daysLeft('2026-10-08T00:00:00Z', TODAY), 0);
  assert.equal(daysLeft('2026-10-05', TODAY), -3);
  assert.equal(daysLeft('2026-11-01', '2026-10-30'), 2); // month boundary
  assert.equal(daysLeft(null, TODAY), null);
  assert.equal(daysLeft('garbage', TODAY), null);
});

test('validityInfo: only open quotes, with urgency tones', () => {
  const v = (status, valid_until) => validityInfo({ status, valid_until }, TODAY);
  assert.equal(v('accepted', '2026-10-01'), null);
  assert.equal(v('rejected', '2026-10-20'), null);
  assert.equal(v('sent', null), null);
  assert.deepEqual(v('sent', '2026-10-05'), { text: 'Expired 3 days ago', tone: 'red', days: -3 });
  assert.equal(v('sent', '2026-10-07').text, 'Expired 1 day ago');
  assert.equal(v('sent', '2026-10-08').text, 'Expires today');
  assert.deepEqual(v('sent', '2026-10-09'), { text: '1 day left', tone: 'red', days: 1 });
  assert.equal(v('sent', '2026-10-11').tone, 'red');   // 3 days
  assert.equal(v('sent', '2026-10-14').tone, 'amber'); // 6 days
  assert.equal(v('draft', '2026-10-15').tone, 'amber'); // 7 days
  assert.equal(v('sent', '2026-10-16').tone, 'muted'); // 8 days
});

test('statusView merges converted into one status', () => {
  assert.deepEqual(statusView({ status: 'accepted', converted_order_id: 'o1' }), { label: 'Order created', color: 'green', key: 'converted' });
  assert.equal(statusView({ status: 'accepted' }).label, 'Accepted');
  assert.equal(statusView({ status: 'sent' }).color, 'blue');
  assert.equal(statusView({ status: 'weird' }).label, 'weird');
});

test('primaryAction: one per status, with an inline reason when blocked', () => {
  assert.equal(primaryAction({ status: 'draft' }).key, 'send');
  assert.deepEqual(primaryAction({ status: 'sent', customer_id: 'c1' }), { key: 'accept', label: 'Accept' });
  const blocked = primaryAction({ status: 'sent', customer_id: null });
  assert.equal(blocked.key, 'accept');
  assert.match(blocked.disabledReason, /customer/i);
  assert.equal(primaryAction({ status: 'accepted', customer_id: 'c1' }).key, 'convert');
  assert.match(primaryAction({ status: 'accepted' }).disabledReason, /customer/i);
  assert.equal(primaryAction({ status: 'accepted', converted_order_id: 'o', orders: { invoice_number: 'INV-1' } }).key, 'invoice');
  assert.equal(primaryAction({ status: 'accepted', converted_order_id: 'o', orders: {} }), null);
  assert.equal(primaryAction({ status: 'rejected' }), null);
  assert.equal(primaryAction({ status: 'sent', customer_id: 'c', suspended_at: '2026-10-01' }), null);
});

test('menuActions: reject only on sent, edit only before conversion', () => {
  const keys = q => menuActions(q).map(a => a.key);
  assert.deepEqual(keys({ status: 'sent' }), ['pdf', 'contact', 'snooze', 'edit', 'reject']);
  assert.deepEqual(keys({ status: 'sent', suspended_at: '2026-10-01' }), ['pdf', 'edit', 'reject']);
  assert.deepEqual(keys({ status: 'draft' }), ['pdf', 'edit']);
  assert.deepEqual(keys({ status: 'accepted', converted_order_id: 'o', orders: { invoice_number: 'I' } }), ['pdf', 'invoice']);
  assert.equal(menuActions({ status: 'sent' }).find(a => a.key === 'reject').danger, true);
});

test('customerLabel prefers the customer and cleans the ~ prefix', () => {
  assert.deepEqual(customerLabel({ customers: { name: 'Design Lab' }, prospect_name: 'x' }), { name: 'Design Lab', isCustomer: true });
  assert.deepEqual(customerLabel({ prospect_name: '~Mairi' }), { name: 'Mairi', isCustomer: false });
  assert.deepEqual(customerLabel({}), { name: '—', isCustomer: false });
});

test('search covers quote number, customer, prospect and project', () => {
  const q = { quote_num: 'QT-2026-0097', customers: { name: 'Design Lab' }, project_description: 'ARTWORK' };
  assert.equal(matchesSearch(q, 'qt-2026-0097'), true);
  assert.equal(matchesSearch(q, 'design art'), true);
  assert.equal(matchesSearch(q, 'sofa'), false);
  assert.equal(matchesSearch({ prospect_name: 'Mairi' }, 'mairi'), true);
  assert.equal(matchesSearch(q, '  '), true);
});

test('tabCounts and summarise', () => {
  const quotes = [
    { status: 'sent', total: 1000, valid_until: '2026-10-10' },
    { status: 'sent', total: 500, valid_until: '2026-12-01' },
    { status: 'sent', total: 200, valid_until: '2026-10-01' },          // lapsed, still counted open
    { status: 'draft', total: 50, valid_until: '2026-10-09' },
    { status: 'accepted', total: 700 },
    { status: 'accepted', total: 900, converted_order_id: 'o1' },
    { status: 'sent', total: 99999, valid_until: '2026-10-09', suspended_at: '2026-10-01' }, // ignored
    { status: 'rejected', total: 5 },
  ];
  const c = tabCounts(quotes);
  assert.equal(c.all, 8); assert.equal(c.sent, 4); assert.equal(c.accepted, 2); assert.equal(c.rejected, 1);
  const s = summarise(quotes, TODAY);
  assert.equal(s.openCount, 3); assert.equal(s.openValue, 1700);
  assert.equal(s.expiringSoon, 3);   // 10-10, lapsed 10-01, draft 10-09
  assert.equal(s.toConvert, 1); assert.equal(s.toConvertValue, 700);
});
