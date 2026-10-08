/**
 * shared/lib/reports/paymentsReceived.js
 *
 * Pure logic for the "Payments Received" report: what customers paid between
 * two dates. Input rows are order_payments rows with their order embedded as
 * `orders` (order_num, client, customer_id, status, suspended_at, invoice_number).
 *
 * Two bases:
 *   'received' — payment_date (the day the customer paid). Default.
 *   'banked'   — banked_date  (the day it reached the bank/till account).
 *
 * Rules:
 *   - Reversed payments (reversed_at set) are never in the total; they are
 *     reported on their own line so the report reconciles to the ledger.
 *   - Payments on cancelled or suspended orders are not in the total either, but
 *     are shown as "excluded" so a refund-related payment is not silently lost.
 *   - Amounts are summed in integer cents to avoid float drift.
 */

import { isCancelled, isSuspended, inRange } from './orderRules.js';

export const BASES = ['received', 'banked'];
export const UNSPECIFIED = 'Unspecified';

const cents = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = c => c / 100;

const dateOnly = v => (typeof v === 'string' ? v.slice(0, 10) : null);

/** The date a payment counts on, for the chosen basis (null when unknown). */
export function basisDate(payment, basis = 'received') {
  return basis === 'banked' ? dateOnly(payment.banked_date) : dateOnly(payment.payment_date);
}

function bucket() { return { count: 0, cents: 0 }; }
function add(b, c) { b.count += 1; b.cents += c; }
const out = b => ({ count: b.count, total: money(b.cents) });

/**
 * @param {object[]} payments
 * @param {{ from?: string|null, to?: string|null, basis?: 'received'|'banked',
 *           customerId?: string|null, method?: string|null }} [opts]
 */
export function buildPaymentsReport(payments, opts = {}) {
  const { from = null, to = null, basis = 'received', customerId = null, method = null } = opts;
  const range = { from, to };

  const total = bucket();
  const reversed = bucket();
  const excluded = bucket();
  const unbanked = bucket();     // received in range but not yet banked (received basis only)
  const byMethod = new Map();
  const byCustomer = new Map();
  const byDay = new Map();
  const rows = [];
  let largest = 0;

  for (const p of payments || []) {
    const order = p.orders || {};
    if (customerId && order.customer_id !== customerId) continue;
    const methodName = p.payment_method || UNSPECIFIED;
    if (method && methodName !== method) continue;

    const day = basisDate(p, basis);
    // Received basis keeps unbanked cash visible; banked basis can only count banked rows.
    if (!inRange(day, range)) continue;

    const c = cents(p.amount);

    if (p.reversed_at) { add(reversed, c); continue; }
    if (isCancelled(order) || isSuspended(order)) { add(excluded, c); continue; }

    add(total, c);
    if (c > largest) largest = c;
    if (basis === 'received' && !p.banked_date) add(unbanked, c);

    const mk = methodName;
    if (!byMethod.has(mk)) byMethod.set(mk, bucket());
    add(byMethod.get(mk), c);

    const ck = order.customer_id || order.client || '—';
    if (!byCustomer.has(ck)) byCustomer.set(ck, { name: order.client || '—', ...bucket() });
    add(byCustomer.get(ck), c);

    if (!byDay.has(day)) byDay.set(day, bucket());
    add(byDay.get(day), c);

    rows.push({
      id: p.id,
      date: day,
      payment_date: dateOnly(p.payment_date),
      banked_date: dateOnly(p.banked_date),
      customer: order.client || '—',
      customer_id: order.customer_id || null,
      order_num: order.order_num || '',
      invoice_number: order.invoice_number || '',
      amount: money(c),
      method: methodName,
      reference: p.reference || p.description || '',
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || a.customer.localeCompare(b.customer) || String(a.id).localeCompare(String(b.id)));

  const byMethodArr = [...byMethod.entries()]
    .map(([name, b]) => ({ name, ...out(b) }))
    .sort((a, b) => b.total - a.total);
  const byCustomerArr = [...byCustomer.values()]
    .map(b => ({ name: b.name, ...out(b) }))
    .sort((a, b) => b.total - a.total);
  const byDayArr = [...byDay.entries()]
    .map(([date, b]) => ({ date, ...out(b) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    basis, from, to,
    summary: {
      ...out(total),
      average: total.count ? money(Math.round(total.cents / total.count)) : 0,
      largest: money(largest),
    },
    byMethod: byMethodArr,
    byCustomer: byCustomerArr,
    byDay: byDayArr,
    reversed: out(reversed),
    excluded: out(excluded),
    unbanked: basis === 'received' ? out(unbanked) : null,
    rows,
  };
}

/** Columns for CSV export / PDF table. */
export const PAYMENT_COLUMNS = [
  { key: 'date',           label: 'Date' },
  { key: 'customer',       label: 'Customer' },
  { key: 'order_num',      label: 'Order' },
  { key: 'invoice_number', label: 'Invoice' },
  { key: 'method',         label: 'Method' },
  { key: 'reference',      label: 'Reference' },
  { key: 'amount',         label: 'Amount (KES)' },
  { key: 'banked_date',    label: 'Banked' },
];
