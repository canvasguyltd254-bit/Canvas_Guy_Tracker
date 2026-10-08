/**
 * shared/lib/reports/orderRules.js
 *
 * Pure rules behind the Reports tab's order reports: which orders count, how
 * much of an order is billable, what is owed, and the per-report filters.
 * No React, no I/O. Dates are 'YYYY-MM-DD' strings throughout (compared as
 * strings), never Date objects, so results do not depend on the viewer's
 * timezone or on the time of day.
 */

import { localDateOf } from '../customerReport.js';
import { isInvoiceRecognised, SETTLED_TOLERANCE } from '../customerBalance.js';

// Every spelling of "cancelled" that has existed in this codebase.
export const CANCELLED_STATUSES = new Set([
  'Cancelled / Refunded', 'Cancelled/Refunded', 'Cancelled', 'Refunded',
]);
export const FINISHED_STATUSES = ['Delivered', 'Closed'];
export const PROD_STATUSES = ['Material Check', 'Production', 'Quality Control', 'Ready for Delivery'];

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export const isCancelled = o => !!o && CANCELLED_STATUSES.has(o.status);
export const isSuspended = o => !!o && !!o.suspended_at;
/** An order that should appear in any report: not cancelled, not suspended. */
export const isLive = o => !!o && !isCancelled(o) && !isSuspended(o);

/** True when the 'YYYY-MM-DD' day falls inside the inclusive { from, to } range. */
export function inRange(day, { from = null, to = null } = {}) {
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// ── value model ─────────────────────────────────────────────────────────────

/**
 * How much of each order is billable and how much is still owed.
 *
 *  - Partially Delivered orders that really use batch delivery: only the value
 *    of Delivered/Signed batch items is billable (null while that data failed to
 *    load, so totals never overstate).
 *  - Everything else: the full order total.
 */
export function makeValueModel({
  payTotals = {}, batchOrderIds = new Set(), deliveredValues = {}, batchLoadError = null,
} = {}) {
  const isPartialBatch = o => o.status === 'Partially Delivered' && batchOrderIds.has(o.id);

  const billable = o => {
    if (isPartialBatch(o)) {
      if (batchLoadError) return null;
      return deliveredValues[o.id] ?? 0;
    }
    return num(o.total_value);
  };
  const paid = o => payTotals[o.id] || 0;
  const balance = o => {
    const bv = billable(o);
    if (bv === null) return null;
    return Math.max(bv - paid(o), 0);
  };
  const undelivered = o => {
    if (!isPartialBatch(o)) return 0;
    const bv = billable(o);
    if (bv === null) return null;
    return Math.max(num(o.total_value) - bv, 0);
  };
  return { billable, paid, balance, undelivered, isPartialBatch };
}

/** Whole days late: positive when `due` is before `today`, else 0. */
export function daysPast(due, today) {
  if (!due || !today) return 0;
  const [dy, dm, dd] = String(due).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = String(today).slice(0, 10).split('-').map(Number);
  const d = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
  return d > 0 ? d : 0;
}

// ── per-report filters ──────────────────────────────────────────────────────

/**
 * One predicate per order report.
 *
 * @param {{ today: string, range: {from?:string,to?:string}, model: ReturnType<typeof makeValueModel> }} ctx
 */
export function makeOrderFilters({ today, range = {}, model }) {
  const owes = o => {
    const b = model.balance(o);
    return b !== null && b >= SETTLED_TOLERANCE;
  };
  const receivable = o => isLive(o) && isInvoiceRecognised(o) && owes(o);
  const createdIn = o => inRange(localDateOf(o.created_at), range);

  return {
    // Production lateness: past the delivery due date and not yet delivered.
    overdue: o =>
      isLive(o) && !!o.due_date && o.due_date < today && !FINISHED_STATUSES.includes(o.status),
    'due-week': o =>
      isLive(o) && !!o.due_date && !FINISHED_STATUSES.includes(o.status) && inRange(o.due_date, range),
    production: o => isLive(o) && o.status === 'Production',
    ready:      o => isLive(o) && o.status === 'Ready for Delivery',
    workload:   o => isLive(o) && PROD_STATUSES.includes(o.status),
    // Money owed, whatever the delivery status. A Closed order that still owes
    // money must show up here, so status is not part of the test.
    receivables: receivable,
    // Money owed whose PAYMENT is due in the range (payment_due_date, not the
    // production delivery date).
    collections: o => receivable(o) && inRange(o.payment_due_date, range),
    'sales-week': o => isLive(o) && isInvoiceRecognised(o) && createdIn(o),
    completed:    o => isLive(o) && FINISHED_STATUSES.includes(o.status) && createdIn(o),
    'order-pnl':  o => isLive(o) && createdIn(o),
  };
}

/** Receivables that have no payment due date, so Collections can never list them. */
export function countUndatedReceivables(orders, model) {
  let count = 0, amount = 0;
  for (const o of orders || []) {
    if (!isLive(o) || !isInvoiceRecognised(o) || o.payment_due_date) continue;
    const b = model.balance(o);
    if (b !== null && b >= SETTLED_TOLERANCE) { count += 1; amount += b; }
  }
  return { count, amount };
}

// ── sorting ─────────────────────────────────────────────────────────────────

/**
 * Stable sort. `getValue(row, field)` returns a number or string; null/undefined
 * sort last in either direction (a missing balance is never "the smallest").
 */
export function sortRows(rows, field, dir, getValue) {
  if (!field) return rows;
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: getValue(row, field) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || a.v === '';
      const bn = b.v === null || b.v === undefined || b.v === '';
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      let c;
      if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
      else c = String(a.v).localeCompare(String(b.v), undefined, { sensitivity: 'base', numeric: true });
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map(x => x.row);
}

/** Sensible default ordering per report (field, direction). */
export const DEFAULT_SORT = {
  overdue:             { field: 'due_date', dir: 'asc' },
  'due-week':          { field: 'due_date', dir: 'asc' },
  production:          { field: 'due_date', dir: 'asc' },
  ready:               { field: 'due_date', dir: 'asc' },
  workload:            { field: 'due_date', dir: 'asc' },
  receivables:         { field: 'balance', dir: 'desc' },
  collections:         { field: 'payment_due_date', dir: 'asc' },
  'sales-week':        { field: 'total_value', dir: 'desc' },
  completed:           { field: 'created_at', dir: 'desc' },
  'order-pnl':         { field: 'profit', dir: 'asc' },
  'supplier-payables': { field: 'balance', dir: 'desc' },
  'supplier-purchases':{ field: 'purchase_date', dir: 'desc' },
};
