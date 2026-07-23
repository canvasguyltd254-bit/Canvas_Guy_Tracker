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

  const overdue = nonCancelledOrders
    .filter(
      o =>
        o.payment_due_date &&
        o.payment_due_date < today &&
        DELIVERED_STATUSES.includes(o.status)
    )
    .reduce((s, o) => {
      const paid = paymentsByOrder[o.id] || 0;
      return s + Math.max(0, parseFloat(o.total_value || 0) - paid);
    }, 0);

  const activeWorkValue = nonCancelledOrders
    .filter(o => !CLOSED_STATUSES.includes(o.status))
    .reduce((s, o) => s + parseFloat(o.total_value || 0), 0);

  const activeOrders = nonCancelledOrders.filter(o =>
    ACTIVE_STATUSES.includes(o.status)
  ).length;

  return { totalSales, totalPaid, outstanding, overdue, activeWorkValue, activeOrders };
}
