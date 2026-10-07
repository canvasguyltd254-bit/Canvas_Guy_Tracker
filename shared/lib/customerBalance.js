/**
 * shared/lib/customerBalance.js
 *
 * Canonical customer balance calculation shared by:
 *   GET /api/customers          (list)
 *   GET /api/customers/[id]     (profile)
 *
 * Having one implementation ensures that the KPI bar on the list page,
 * the stats header on the profile, and the running balance on the
 * statement all use the same formula.
 *
 * Formula:
 *   outstanding = opening_balance + totalSales - totalPaid
 *
 * Opening balance sign:
 *   Positive OB → customer already owed money before the system → debit entry
 *   Negative OB → credit entry using ABS(opening_balance)
 */

// ── Status vocabulary ──────────────────────────────────────────────────────
// Must stay in sync with modules/orders/components/constants.js

export const ACTIVE_STATUSES = [
  'Inquiry',
  'Quote Approved',
  'Deposit Paid',
  'Material Check',
  'Production',
  'Quality Control',
  'Ready for Delivery',
];

export const QUOTE_STATUSES = ['Inquiry', 'Quote Approved'];

export const DELIVERED_STATUSES = ['Partially Delivered', 'Delivered', 'Closed'];

export const CLOSED_STATUSES = ['Closed', 'Cancelled / Refunded'];

export const CANCELLED_STATUS = 'Cancelled / Refunded';

// Remaining balances below this (KES) are rounding residue, not debt.
export const SETTLED_TOLERANCE = 0.5;

// Whole days from `from` to `to`, both 'YYYY-MM-DD'. UTC arithmetic so it never
// depends on the server's timezone.
function daysBetween(from, to) {
  const [fy, fm, fd] = String(from).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = String(to).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// ── calcCustomerStats ──────────────────────────────────────────────────────

/**
 * Compute financial stats for a customer.
 *
 * @param {object}   customer           — customer row (needs opening_balance)
 * @param {object[]} nonCancelledOrders — orders pre-filtered to exclude CANCELLED_STATUS
 * @param {object}   paymentsByOrder    — { [order_id]: totalPaid (number) }
 * @param {string}   today              — 'YYYY-MM-DD'
 *
 * @returns {{
 *   totalSales:      number,
 *   totalPaid:       number,
 *   outstanding:     number,
 *   overdue:         number,
 *   activeWorkValue: number,
 *   activeOrders:    number,
 * }}
 */
export function calcCustomerStats(customer, nonCancelledOrders, paymentsByOrder, today) {
  const totalSales = nonCancelledOrders.reduce(
    (s, o) => s + parseFloat(o.total_value || 0),
    0
  );
  const totalPaid = nonCancelledOrders.reduce(
    (s, o) => s + (paymentsByOrder[o.id] || 0),
    0
  );
  const outstanding = parseFloat(customer.opening_balance || 0) + totalSales - totalPaid;

  // An order whose remaining balance is a sub-KES-0.5 rounding residual is
  // settled (the CRM invoices list already treats it that way). Without this a
  // KES 1 residual showed up as an "overdue" order.
  const overdueOrders = nonCancelledOrders
    .filter(
      o =>
        o.payment_due_date &&
        o.payment_due_date < today &&
        DELIVERED_STATUSES.includes(o.status)
    )
    .map(o => ({
      due:       o.payment_due_date,
      remaining: Math.max(0, parseFloat(o.total_value || 0) - (paymentsByOrder[o.id] || 0)),
    }))
    .filter(o => o.remaining >= SETTLED_TOLERANCE);

  const overdue = overdueOrders.reduce((s, o) => s + o.remaining, 0);

  // Ageing of the overdue amount by days past due. The three buckets always
  // sum to `overdue`; "not yet due" is outstanding minus overdue (see below).
  const overdueAging = { d1_30: 0, d31_60: 0, d60p: 0 };
  let oldestOverdueDays = 0;
  for (const o of overdueOrders) {
    const days = daysBetween(o.due, today);
    if (days > oldestOverdueDays) oldestOverdueDays = days;
    if (days <= 30)      overdueAging.d1_30  += o.remaining;
    else if (days <= 60) overdueAging.d31_60 += o.remaining;
    else                 overdueAging.d60p   += o.remaining;
  }
  const notYetDue = Math.max(0, outstanding - overdue);

  const activeWorkValue = nonCancelledOrders
    .filter(o => !CLOSED_STATUSES.includes(o.status))
    .reduce((s, o) => s + parseFloat(o.total_value || 0), 0);

  const activeOrders = nonCancelledOrders.filter(o =>
    ACTIVE_STATUSES.includes(o.status)
  ).length;

  return {
    totalSales, totalPaid, outstanding, overdue, activeWorkValue, activeOrders,
    overdueAging, oldestOverdueDays, notYetDue,
  };
}

/**
 * Whether an order counts toward a customer's receivable. Quote-originated
 * orders count only once they carry an invoice number; direct orders always
 * count. Shared so the list and the profile cannot drift apart again.
 */
export function isInvoiceRecognised(order) {
  return !(order.quote_id && !order.invoice_number);
}
