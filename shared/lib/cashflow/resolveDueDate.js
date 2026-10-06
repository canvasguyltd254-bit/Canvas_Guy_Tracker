/**
 * shared/lib/cashflow/resolveDueDate.js
 *
 * The ONE place a supplier purchase's due date, or a customer receipt's
 * expected payment date, is resolved for forecasting. Nothing else —
 * including projectCashflow.js — re-derives these priority chains; every
 * caller consumes this file's output.
 *
 * Zero Supabase imports. Zero I/O. Given identical inputs, always produces
 * an identical result.
 *
 * ── Judgment calls made in this file, flagged for review ───────────────────
 *
 * The spec did not dictate exact export names for this file (unlike
 * isoWeeks.js / confidence.js / classifyWeek.js, which each had an explicit
 * "Exports:" list) — `resolveSupplierPurchaseDueDate` and
 * `resolveCustomerReceiptDate` are this file's own naming choice.
 *
 * 1. The declared return shape is fixed to exactly
 *    `{ date, source, label, assumed, baseline_date, adjustment_days }`.
 *    But the spec separately requires supplier-purchase tier 3 to "include
 *    explanation: '...'" — a 7th piece of information with no slot in that
 *    shape. Rather than silently drop the requirement or silently violate
 *    the declared shape by renaming a field, this file adds an *additional*,
 *    optional `explanation` property, populated only on the tiers the spec
 *    calls "Assumed by Cashflow" (supplier tiers 3-4, receipt tiers 3-4) —
 *    additive, so every field the spec promised is still exactly where it
 *    said it would be.
 *
 * 2. Receipt tier 3/4 fallback baselines are timestamps in the snapshot
 *    ("date(invoice_issued_at)", "date(order.created_at)" — the spec's own
 *    `date(...)` notation implies a cast from timestamp to calendar date),
 *    truncated to their date component with a local `toIsoDateOnly` helper.
 *
 * 3. `customerHistory.median_lag_days` can be a fractional day count (an
 *    even-sized settled-order sample averages its two middle values — see
 *    confidence.js's `median`). A calendar date can only shift by whole
 *    days, so the shift applied here is `Math.round(median_lag_days)`. The
 *    unrounded value is left untouched everywhere else (confidence.js's own
 *    threshold comparisons use the exact figure) — rounding happens only at
 *    the point of date arithmetic, and `adjustment_days` reports the
 *    rounded, actually-applied shift rather than the unrounded input.
 *
 * 4. "Assumed" flags whether the DATE ANCHOR itself is a real recorded fact
 *    or a substituted fallback — not whether a forecast technique (the
 *    median-lag shift) was applied on top of it. A stored contractual
 *    `payment_due_date` is a real anchor (assumed: false) even though the
 *    expected-date shown has a historical-lag shift layered on it; an
 *    invoice date or order-created date standing in for a missing due date
 *    is a substituted anchor (assumed: true). This matches the supplier
 *    side of the spec, which explicitly treats a *snapshotted* supplier-
 *    terms due date as not assumed, and only calls the current-live-terms
 *    and cashflow-default derivations "assumed" — the distinguishing factor
 *    is anchor reliability, not whether any arithmetic happened at all.
 *
 * ── Snapshot shapes (types.js) drive these signatures directly ─────────────
 * `SupplierPurchaseSnapshot` already carries the supplier's live terms
 * flattened onto the row as `current_supplier_terms_days` — there is no
 * separate supplier object to pass in. `ReceiptSnapshot` already carries
 * `created_at` and `schedule` directly on itself — there is no separate
 * order object either. Both functions below take exactly the snapshot
 * objects types.js defines, plus the one thing that ISN'T embedded on a row
 * (cashflow_settings, and the customer's separately-keyed payment history).
 */

import { isValidIsoDate, diffInDays, addDaysToIsoDate } from '../isoDate.js';
import { hasRecordedTerms } from '../supplierTerms.js';

/**
 * @typedef {Object} ResolvedDate
 * @property {string} date              resolved "YYYY-MM-DD"
 * @property {string} source            machine-readable tier identifier
 * @property {string} label             short human-facing explanation
 * @property {boolean} assumed          true when the anchor is a substituted
 *                                      fallback rather than a recorded fact
 * @property {?string} baseline_date    the date the offset was measured
 *                                      from, or null when there is none
 *                                      (a direct override, tier 1)
 * @property {?number} adjustment_days  whole days added to baseline_date to
 *                                      reach `date`, or null when there is
 *                                      no baseline (tier 1)
 * @property {string} [explanation]     present only on "Assumed by
 *                                      Cashflow" tiers — see judgment call 1
 */

function toIsoDateOnly(value) {
  return typeof value === 'string' ? value.slice(0, 10) : value;
}

// ── supplier purchases ──────────────────────────────────────────────────────

/**
 * Resolves the due date to use for a supplier purchase in the forecast,
 * following the spec's fixed priority order:
 *   1. Explicit stored date.
 *   2. Stored supplier-terms date, using the ROW'S OWN terms snapshot
 *      (`due_date_terms_days`) — never the supplier's current terms, even if
 *      they've since changed.
 *   3. Legacy purchase with no stored date, but the supplier currently has
 *      recorded terms (`current_supplier_terms_days`) — derived from
 *      purchase_date + those live terms, and explicitly NOT treated as a
 *      confirmed supplier-terms date since the terms weren't snapshotted at
 *      creation time.
 *   4. No stored date, no supplier terms — derived from purchase_date +
 *      cashflow_settings.default_supplier_terms_days.
 *
 * Validation (fails visibly rather than silently, even though the database
 * already enforces most of this for new rows — this engine must not trust
 * a snapshot blindly): rejects an invalid purchase_date; a stored due_date
 * with no valid due_date_source; a due_date_source of 'supplier_terms' with
 * no terms snapshot; and any due_date before purchase_date.
 *
 * @param {SupplierPurchaseSnapshot} purchase
 * @param {CashflowSettingsSnapshot} settings
 * @returns {ResolvedDate}
 */
export function resolveSupplierPurchaseDueDate(purchase, settings) {
  if (!purchase || typeof purchase !== 'object') {
    throw new RangeError('resolveSupplierPurchaseDueDate: purchase is required');
  }
  if (!isValidIsoDate(purchase.purchase_date)) {
    throw new RangeError(`resolveSupplierPurchaseDueDate: invalid purchase_date "${purchase.purchase_date}"`);
  }

  const { due_date, due_date_source, due_date_terms_days, current_supplier_terms_days } = purchase;

  if (due_date != null) {
    if (!isValidIsoDate(due_date)) {
      throw new RangeError(`resolveSupplierPurchaseDueDate: invalid due_date "${due_date}"`);
    }
    if (due_date_source !== 'explicit' && due_date_source !== 'supplier_terms') {
      throw new RangeError(
        `resolveSupplierPurchaseDueDate: purchase has due_date but due_date_source is "${due_date_source}", not "explicit" or "supplier_terms"`,
      );
    }
    if (due_date_source === 'supplier_terms' && !hasRecordedTerms(due_date_terms_days)) {
      throw new RangeError(
        'resolveSupplierPurchaseDueDate: due_date_source is "supplier_terms" but due_date_terms_days is not recorded — cannot trust an unsnapshotted terms value',
      );
    }
    if (diffInDays(purchase.purchase_date, due_date) < 0) {
      throw new RangeError('resolveSupplierPurchaseDueDate: due_date is before purchase_date');
    }
  }

  // Tier 1: explicit stored date.
  if (due_date_source === 'explicit') {
    return {
      date: due_date,
      source: 'explicit',
      label: 'Explicit date',
      assumed: false,
      baseline_date: purchase.purchase_date,
      adjustment_days: diffInDays(purchase.purchase_date, due_date),
    };
  }

  // Tier 2: stored supplier-terms date — the row's own snapshot, never the
  // supplier's live terms.
  if (due_date_source === 'supplier_terms') {
    return {
      date: due_date,
      source: 'supplier_terms',
      label: `Supplier terms · ${due_date_terms_days} day${due_date_terms_days === 1 ? '' : 's'}`,
      assumed: false,
      baseline_date: purchase.purchase_date,
      adjustment_days: due_date_terms_days,
    };
  }

  // Tier 3: legacy purchase, no stored date, supplier currently has terms.
  if (hasRecordedTerms(current_supplier_terms_days)) {
    return {
      date: addDaysToIsoDate(purchase.purchase_date, current_supplier_terms_days),
      source: 'current_supplier_terms',
      label: 'Assumed by Cashflow',
      explanation: 'Current supplier terms used because this historical purchase has no recorded due date.',
      assumed: true,
      baseline_date: purchase.purchase_date,
      adjustment_days: current_supplier_terms_days,
    };
  }

  // Tier 4: no stored date, no supplier terms — cashflow default.
  const defaultDays = settings?.default_supplier_terms_days;
  if (!Number.isInteger(defaultDays) || defaultDays < 0) {
    throw new RangeError(
      'resolveSupplierPurchaseDueDate: settings.default_supplier_terms_days must be a recorded, non-negative integer to fall back on',
    );
  }
  return {
    date: addDaysToIsoDate(purchase.purchase_date, defaultDays),
    source: 'cashflow_default',
    label: 'Assumed by Cashflow',
    explanation: `No recorded due date and no supplier terms; using Cashflow's default of ${defaultDays} days after purchase.`,
    assumed: true,
    baseline_date: purchase.purchase_date,
    adjustment_days: defaultDays,
  };
}

// ── customer receipts ───────────────────────────────────────────────────────

/**
 * Resolves the expected payment date for a customer receipt, following the
 * spec's fixed priority order:
 *   1. The receipt's own schedule.planned_date always wins outright —
 *      historical lag is NOT applied on top of a human-planned date.
 *   2. Stored payment_due_date, shifted by the customer's historical median
 *      lag (negative lag — paying early — is honoured as-is).
 *   3. No payment_due_date, but invoice_issued_at exists — baseline is the
 *      invoice date, expected date is baseline + 30 days + median lag. The
 *      30-day fallback is exposed as an assumption.
 *   4. Neither exists — baseline is the receipt's own created_at, same
 *      30 + lag formula, exposed the same way. A customer with no settled
 *      history at all uses 0 lag (never coerced to some other default).
 *
 * @param {ReceiptSnapshot} receipt
 * @param {CustomerHistorySnapshot|null|undefined} customerHistory
 * @returns {ResolvedDate}
 */
export function resolveCustomerReceiptDate(receipt, customerHistory) {
  if (!receipt || typeof receipt !== 'object') {
    throw new RangeError('resolveCustomerReceiptDate: receipt is required');
  }

  // "If the customer has no historical lag, use 0 lag" — an explicit,
  // spec-defined fallback, not a silent coercion of a missing value.
  const rawLagDays = customerHistory?.median_lag_days ?? 0;
  const lagDays = Math.round(rawLagDays); // see judgment call 3 — dates only shift by whole days

  // Tier 1: schedule override — wins outright, no lag re-applied.
  const plannedDate = receipt.schedule?.planned_date;
  if (plannedDate != null) {
    if (!isValidIsoDate(plannedDate)) {
      throw new RangeError(`resolveCustomerReceiptDate: invalid schedule.planned_date "${plannedDate}"`);
    }
    return {
      date: plannedDate,
      source: 'schedule_override',
      label: 'Planned date override',
      assumed: false,
      baseline_date: null,
      adjustment_days: null,
    };
  }

  // Tier 2: stored payment due date + historical lag.
  if (receipt.payment_due_date != null) {
    if (!isValidIsoDate(receipt.payment_due_date)) {
      throw new RangeError(`resolveCustomerReceiptDate: invalid payment_due_date "${receipt.payment_due_date}"`);
    }
    return {
      date: addDaysToIsoDate(receipt.payment_due_date, lagDays),
      source: 'payment_due_date',
      label: lagDays === 0
        ? 'Payment due date'
        : `Payment due date ${lagDays > 0 ? '+' : ''}${lagDays}d (customer history)`,
      assumed: false,
      baseline_date: receipt.payment_due_date,
      adjustment_days: lagDays,
    };
  }

  // Tier 3: invoice-issued fallback.
  if (receipt.invoice_issued_at != null) {
    const invoiceDate = toIsoDateOnly(receipt.invoice_issued_at);
    if (!isValidIsoDate(invoiceDate)) {
      throw new RangeError(`resolveCustomerReceiptDate: invalid invoice_issued_at "${receipt.invoice_issued_at}"`);
    }
    const adjustment = 30 + lagDays;
    return {
      date: addDaysToIsoDate(invoiceDate, adjustment),
      source: 'invoice_issued_fallback',
      label: 'Assumed by Cashflow',
      explanation: "No recorded payment due date; assuming payment 30 days after the invoice was issued, adjusted by this customer's payment history.",
      assumed: true,
      baseline_date: invoiceDate,
      adjustment_days: adjustment,
    };
  }

  // Tier 4: receipt-created fallback (receipt.created_at is required by
  // ReceiptSnapshot, so this tier always has a baseline to work with —
  // still validated rather than trusted blindly).
  const createdDate = toIsoDateOnly(receipt.created_at);
  if (!isValidIsoDate(createdDate)) {
    throw new RangeError(`resolveCustomerReceiptDate: invalid created_at "${receipt.created_at}"`);
  }
  const adjustment = 30 + lagDays;
  return {
    date: addDaysToIsoDate(createdDate, adjustment),
    source: 'cashflow_default',
    label: 'Assumed by Cashflow',
    explanation: "No recorded due date or invoice date; assuming payment 30 days after the order was created, adjusted by this customer's payment history.",
    assumed: true,
    baseline_date: createdDate,
    adjustment_days: adjustment,
  };
}
