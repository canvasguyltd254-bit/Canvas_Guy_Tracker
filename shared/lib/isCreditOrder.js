/**
 * shared/lib/isCreditOrder.js
 *
 * Canonical credit-order predicate for Canvas Guy Tracker.
 *
 * Credit orders are defined as:
 *   customer_type IN ('commercial', 'reseller')
 *   AND payment_terms IN ('30_day', '60_day', 'custom')
 *
 * This single source of truth replaces the two divergent inline checks:
 *   - OrderTracker.js line 305: only checked 'reseller' (BUG — misses 'commercial')
 *   - form/page.js line 1129:   correctly checked both types
 *
 * GL timing consequence:
 *   isCreditOrder = true  → invoice GL fires at Quote Approved
 *   isCreditOrder = false → invoice GL fires at Deposit Paid
 */

import { CREDIT_TERMS } from '@/modules/orders/components/constants';

const CREDIT_CUSTOMER_TYPES = ['commercial', 'reseller'];

/**
 * @param {object} order — any object with customer_type and payment_terms
 * @returns {boolean}
 */
export function isCreditOrder(order) {
  return (
    CREDIT_CUSTOMER_TYPES.includes(order.customer_type) &&
    CREDIT_TERMS.includes(order.payment_terms)
  );
}
