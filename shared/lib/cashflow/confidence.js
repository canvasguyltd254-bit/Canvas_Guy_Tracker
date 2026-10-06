/**
 * shared/lib/cashflow/confidence.js
 *
 * The ONE place a receipt's collection confidence (confirmed / likely /
 * uncertain) is decided. Per the Stage 2 contract, nothing else re-derives
 * this — projectCashflow.js consumes deriveReceiptConfidence's output, and
 * per Stage 2's own design invariant the UI never reproduces this logic
 * either.
 *
 * Zero Supabase imports. Zero I/O. Pure, deterministic given its inputs.
 *
 * ── Two judgment calls made in this file, flagged for review ───────────────
 *
 * 1. `deriveReceiptConfidence`'s spec-dictated export signature is
 *    `(receipt, customerHistory, schedule)` — three arguments, no "today"
 *    reference. But the Confirmed/Likely/Uncertain rules all depend on
 *    whether "the current receipt is already 60+ days overdue," which is
 *    inherently relative to as_of. Reading system time inside this function
 *    would silently break the file's own determinism requirement ("produce
 *    identical results for identical input"), so this file adds a 4th
 *    parameter, `asOf`, rather than reach for `Date.now()`. Every call site
 *    must pass the snapshot's `as_of` explicitly.
 *
 * 2. Overdue-ness is measured against `receipt.payment_due_date` specifically
 *    — the contractual due date — not against the lag-adjusted "expected
 *    date" that resolveDueDate.js computes. Measuring overdue-ness against
 *    our own forecast would be circular (the forecast already builds in an
 *    assumed lag; a receipt "overdue" only relative to a lag we invented
 *    isn't really overdue yet). When `payment_due_date` is missing, overdue
 *    days can't be determined; this file treats "unknown" as "not confirmed
 *    severely overdue" rather than assuming the worst, consistent with the
 *    project rule that a missing value stays visibly unknown rather than
 *    being coerced to an assumed extreme in either direction.
 */

import { isValidIsoDate, diffInDays } from '../isoDate.js';

const WEIGHTS = Object.freeze({
  confirmed: 1.00,
  likely: 0.80,
  uncertain: 0.50,
});

const SEVERELY_OVERDUE_DAYS = 60;
const CONFIRMED_MAX_MEDIAN_LAG_DAYS = 7;
const LIKELY_MAX_MEDIAN_LAG_DAYS = 30;
const CONFIRMED_MIN_SETTLED_ORDERS = 3;

/**
 * Median of a non-empty array of finite numbers. Even-length arrays average
 * the two middle values.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('median: values must be a non-empty array of numbers');
  }
  const sorted = [...values].sort((a, b) => a - b);
  for (const v of sorted) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RangeError(`median: all values must be finite numbers, got ${JSON.stringify(v)}`);
    }
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * The confidence-weight lookup — the only place `confidence_override` /
 * derived-confidence strings are translated into the numeric weight used to
 * compute a receipt's weighted (forecast-only) amount.
 *
 * @param {'confirmed'|'likely'|'uncertain'} confidence
 * @returns {number}
 */
export function confidenceWeight(confidence) {
  if (!Object.prototype.hasOwnProperty.call(WEIGHTS, confidence)) {
    throw new RangeError(`confidenceWeight: unknown confidence "${confidence}"`);
  }
  return WEIGHTS[confidence];
}

/**
 * Builds a customer's payment-history summary from their eligible settled
 * orders.
 *
 * Eligibility filtering (same customer; valid payment_due_date; positive
 * invoice/order value; non-reversed payments that fully settle the order;
 * a final settlement date available; excluding reversed payments and
 * cancelled/refunded orders with no remaining receivable) is the snapshot
 * builder's responsibility — by the time an order reaches `settledOrders`
 * here it is expected to already be eligible. This function still validates
 * that every entry has the two dates it needs, and throws rather than
 * silently skipping a malformed entry, so a data problem in the snapshot
 * builder surfaces immediately instead of quietly skewing the median.
 *
 * @param {{order_id:string, payment_due_date:string, final_payment_date:string}[]} settledOrders
 * @returns {{settled_order_count:number, median_lag_days:number|null, sample_label:string}}
 */
export function calculateCustomerPaymentHistory(settledOrders) {
  if (!Array.isArray(settledOrders)) {
    throw new RangeError('calculateCustomerPaymentHistory: settledOrders must be an array');
  }

  const lags = settledOrders.map((order, i) => {
    if (!order || typeof order !== 'object') {
      throw new RangeError(`calculateCustomerPaymentHistory: settledOrders[${i}] is not an object`);
    }
    if (!isValidIsoDate(order.payment_due_date)) {
      throw new RangeError(`calculateCustomerPaymentHistory: settledOrders[${i}].payment_due_date is missing or invalid`);
    }
    if (!isValidIsoDate(order.final_payment_date)) {
      throw new RangeError(`calculateCustomerPaymentHistory: settledOrders[${i}].final_payment_date is missing or invalid`);
    }
    // Positive = paid after due date; negative = paid early.
    return diffInDays(order.payment_due_date, order.final_payment_date);
  });

  const count = lags.length;
  const medianLagDays = count > 0 ? median(lags) : null;

  const sampleLabel = count > 0
    ? `Median ${medianLagDays} day${medianLagDays === 1 ? '' : 's'} over ${count} settled order${count === 1 ? '' : 's'}`
    : 'No settled order history';

  return {
    settled_order_count: count,
    median_lag_days: medianLagDays,
    sample_label: sampleLabel,
  };
}

/**
 * Days `receipt.payment_due_date` is overdue as of `asOf` (positive = overdue,
 * zero/negative = not yet due). `null` when the receipt has no recorded due
 * date — overdue-ness is then unknown, not assumed in either direction.
 *
 * @param {{payment_due_date:?string}} receipt
 * @param {string} asOf
 * @returns {number|null}
 */
function daysOverdue(receipt, asOf) {
  const due = receipt?.payment_due_date;
  if (!due || !isValidIsoDate(due)) return null;
  return diffInDays(due, asOf);
}

/**
 * Derives a receipt's collection confidence.
 *
 * Precedence (the three sections of the spec only partition cleanly when
 * read together in this order — see the file header):
 *   1. Severely overdue (60+ days) forces 'uncertain', regardless of an
 *      otherwise-strong payment history — Confirmed's own definition
 *      requires "not already 60+ days overdue," and Uncertain explicitly
 *      lists severe overdue as its own trigger, so it wins over Confirmed
 *      and over the Likely fallback.
 *   2. Otherwise, median lag > 30 days forces 'uncertain'.
 *   3. Otherwise, 3+ settled historical orders AND median lag <= 7 days
 *      gives 'confirmed'.
 *   4. Otherwise 'likely' — this is the catch-all for fewer than 3 settled
 *      orders (including a brand-new customer with zero history) and for a
 *      median lag of 8-30 days inclusive. A new customer can only ever reach
 *      'likely', never 'confirmed', regardless of how clean their first one
 *      or two payments were.
 *
 * A schedule's `confidence_override`, when set, wins outright — the return
 * shape still carries the derived value under `derived_confidence` so the
 * override never destroys the underlying signal.
 *
 * @param {{payment_due_date:?string}} receipt
 * @param {{settled_order_count:number, median_lag_days:number|null}|null|undefined} customerHistory
 * @param {{confidence_override:?string}|null|undefined} schedule
 * @param {string} asOf  the snapshot's as_of date — see judgment call #1 above
 * @returns {{confidence:'confirmed'|'likely'|'uncertain', source:'human_override'|'derived', derived_confidence:'confirmed'|'likely'|'uncertain'}}
 */
export function deriveReceiptConfidence(receipt, customerHistory, schedule, asOf) {
  if (!receipt || typeof receipt !== 'object') {
    throw new RangeError('deriveReceiptConfidence: receipt is required');
  }
  if (!isValidIsoDate(asOf)) {
    throw new RangeError(`deriveReceiptConfidence: asOf must be a valid ISO date, got ${JSON.stringify(asOf)}`);
  }

  const settledCount = customerHistory?.settled_order_count ?? 0;
  const medianLagDays = customerHistory?.median_lag_days ?? null;

  if (settledCount > 0 && medianLagDays == null) {
    throw new RangeError(
      'deriveReceiptConfidence: customerHistory has settled_order_count > 0 but no median_lag_days — malformed history',
    );
  }

  const overdueDays = daysOverdue(receipt, asOf);
  const isSeverelyOverdue = overdueDays != null && overdueDays >= SEVERELY_OVERDUE_DAYS;

  let derived;
  if (isSeverelyOverdue || (medianLagDays != null && medianLagDays > LIKELY_MAX_MEDIAN_LAG_DAYS)) {
    derived = 'uncertain';
  } else if (
    settledCount >= CONFIRMED_MIN_SETTLED_ORDERS &&
    medianLagDays != null &&
    medianLagDays <= CONFIRMED_MAX_MEDIAN_LAG_DAYS
  ) {
    derived = 'confirmed';
  } else {
    derived = 'likely';
  }

  const override = schedule?.confidence_override;
  if (override === 'confirmed' || override === 'likely' || override === 'uncertain') {
    return { confidence: override, source: 'human_override', derived_confidence: derived };
  }

  return { confidence: derived, source: 'derived', derived_confidence: derived };
}
