/**
 * shared/lib/reports/orderRows.js
 *
 * Turns orders into the rows, sort keys, KPIs and CSV/PDF payloads the order
 * reports use. Pure; every number comes from the value model in orderRules.js so
 * the screen, the CSV and the PDF cannot disagree.
 */

import { SETTLED_TOLERANCE } from '../customerBalance.js';
import { daysPast } from './orderRules.js';

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** A flat, display-ready row for one order. billable/balance/undelivered may be null (unknown). */
export function orderRow(o, model, today) {
  const balance = model.balance(o);
  const owes = balance !== null && balance >= SETTLED_TOLERANCE;
  return {
    id: o.id,
    client: o.client || '',
    customer_id: o.customer_id || null,
    order_num: o.order_num || '',
    invoice_number: o.invoice_number || '',
    status: o.status || '',
    created_at: o.created_at || null,
    due_date: o.due_date || null,
    payment_due_date: o.payment_due_date || null,
    total_value: num(o.total_value),
    billable: model.billable(o),
    paid: model.paid(o),
    balance,
    undelivered: model.undelivered(o),
    // Days the PAYMENT is overdue (only while money is still owed).
    days_late: owes ? daysPast(o.payment_due_date, today) : 0,
    // Days the DELIVERY is late (production reports).
    delivery_days_late: daysPast(o.due_date, today),
  };
}

/** Sort key lookup for an order row. */
export function orderSortValue(row, field) {
  switch (field) {
    case 'balance': case 'billable': case 'paid': case 'total_value':
    case 'days_late': case 'delivery_days_late':
      return row[field];
    case 'client': case 'order_num': case 'status': case 'invoice_number':
      return row[field];
    default:
      return row[field] ?? null; // dates are ISO strings: they sort correctly as text
  }
}

/** Totals for a set of order rows. Unknown (null) amounts are skipped and counted. */
export function summariseOrderRows(rows) {
  const t = { count: rows.length, billable: 0, paid: 0, balance: 0, overdue: 0, overdueCount: 0, unknown: 0, undelivered: 0 };
  for (const r of rows) {
    t.paid += r.paid;
    if (r.billable === null || r.balance === null) { t.unknown += 1; continue; }
    t.billable += r.billable;
    t.balance += r.balance;
    t.undelivered += r.undelivered || 0;
    if (r.days_late > 0) { t.overdue += r.balance; t.overdueCount += 1; }
  }
  return t;
}

/** Units on an order: sum of item quantities, or 1 when it has no items. */
export function orderUnits(items) {
  return items && items.length ? items.reduce((s, i) => s + (num(i.quantity) || 1), 0) : 1;
}

export const FINANCIAL_CSV_COLUMNS = [
  { key: 'client', label: 'Client' },
  { key: 'order_num', label: 'Order' },
  { key: 'invoice_number', label: 'Invoice' },
  { key: 'status', label: 'Status' },
  { key: 'due_date', label: 'Delivery due' },
  { key: 'payment_due_date', label: 'Payment due' },
  { key: 'total_value', label: 'Order total' },
  { key: 'billable', label: 'Invoiced' },
  { key: 'paid', label: 'Paid' },
  { key: 'balance', label: 'Balance' },
  { key: 'days_late', label: 'Days overdue' },
];

export const OPERATIONAL_CSV_COLUMNS = [
  { key: 'client', label: 'Client' },
  { key: 'order_num', label: 'Order' },
  { key: 'status', label: 'Status' },
  { key: 'due_date', label: 'Due date' },
  { key: 'delivery_days_late', label: 'Days late' },
  { key: 'units', label: 'Units' },
  { key: 'items', label: 'Items' },
];

export const SUPPLIER_CSV_COLUMNS = [
  { key: 'supplier_name', label: 'Supplier' },
  { key: 'purchase_date', label: 'Date' },
  { key: 'items_bought', label: 'Items' },
  { key: 'total_amount', label: 'Total' },
  { key: 'amount_paid', label: 'Paid' },
  { key: 'balance', label: 'Balance' },
  { key: 'payment_status', label: 'Status' },
];

export function supplierRow(p) {
  const total = num(p.total_amount), paid = num(p.amount_paid);
  return { ...p, total_amount: total, amount_paid: paid, balance: Math.max(total - paid, 0) };
}
