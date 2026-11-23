/**
 * shared/lib/isCreditOrder.js
 *
 * Canonical credit-order predicate for Canvas Guy Tracker.
 *
 * An order is a credit order when its PAYMENT TERMS are credit terms:
 *   payment_terms IN ('30_day', '60_day', 'custom')
 *
 * Customer type does NOT decide this. It used to (commercial/reseller only),
 * but customer_type defaults to 'retail' and cannot be changed after the order
 * is created, so an order given 30/60-day or custom terms for a retail-typed
 * customer was stuck behind the Deposit Paid gate with no way out.
 *
 * Credit risk is controlled by the Credit Approval step (approval reference,
 * credit limit check, Head of Sales cap), not by the customer-type label.
 *
 * GL timing consequence:
 *   isCreditOrder = true  → invoice GL fires at Quote Approved
 *   isCreditOrder = false → invoice GL fires at Deposit Paid
 *
 * The database function advance_order_status() mirrors this rule
 * (supabase/migrations/orders_credit_by_payment_terms.sql). Change both together.
 */

// Relative import (not '@/…') so this file also loads under plain `node --test`.
import { CREDIT_TERMS } from '../../modules/orders/components/constants.js';

/**
 * @param {object} order — any object with payment_terms
 * @returns {boolean}
 */
export function isCreditOrder(order) {
  return !!order && CREDIT_TERMS.includes(order.payment_terms);
}
