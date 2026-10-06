/**
 * shared/lib/supplierTerms.js
 *
 * One definition of what supplier credit terms mean, and how a purchase's
 * due date and its provenance are derived, shared by:
 *   - POST/PATCH /api/suppliers          (writing suppliers.payment_terms_days)
 *   - POST/PATCH /api/purchases          (writing due_date + due_date_source)
 *   - SuppliersModule / SupplierProfile  (client-side preview + validation)
 *   - the Cashflow forecast engine       (reading these to explain a date)
 *
 * Three distinctions this file exists to protect:
 *
 *   payment_terms_days: null vs 0
 *     null → no terms agreed with this supplier. Cashflow applies its
 *            configured default and labels the resulting date ASSUMED.
 *     0    → cash on delivery. A real, recorded answer.
 *
 *   due_date_source: 'explicit' vs 'supplier_terms' vs null
 *     Once a due_date is stored, the ONLY reliable way to know whether it was
 *     a negotiated date or a derived one is to have recorded which at write
 *     time. Comparing the stored date against the supplier's *current* terms
 *     is unsafe — terms can change after the purchase was made, which would
 *     silently misclassify old, correctly-derived dates as manual overrides
 *     (or vice versa). due_date_source is the fact; nothing downstream
 *     re-derives it.
 *
 *   due_date_terms_days: the SNAPSHOT, not the supplier's current terms
 *     due_date_source = 'supplier_terms' says a date was derived; it does not
 *     say from WHICH terms. If a supplier's payment_terms_days changes after
 *     a purchase was made, describing an old purchase with the supplier's
 *     CURRENT terms silently rewrites history — "Supplier terms · 30 days"
 *     becomes "Supplier terms · 60 days" on a row nobody touched. The DB
 *     column supplier_purchases.due_date_terms_days snapshots the terms
 *     actually used, at write time. describeDueDateSource() below must
 *     always be called with that stored snapshot — never with
 *     supplier.payment_terms_days — or this bug comes back.
 */

import { isValidIsoDate } from './isoDate.js';

export const MIN_TERMS_DAYS = 0;
export const MAX_TERMS_DAYS = 365;

export const DUE_DATE_SOURCES = Object.freeze(['explicit', 'supplier_terms']);

/**
 * Parse a user-supplied credit-terms value.
 *
 * Accepts null, undefined, "" and whitespace as "not recorded" (→ null).
 * Anything else must be a whole number within range.
 *
 * NOTE on NaN: parseInt('abc') is NaN and every comparison against NaN is
 * false, so a bare `v < 0 || v > 365` range check lets garbage through to the
 * insert. Validity is therefore established with Number.isInteger first.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: number|null } | { ok: false, error: string }}
 */
export function parsePaymentTermsDays(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  const s = String(raw).trim();
  if (s === '') return { ok: true, value: null };

  const n = Number(s);
  if (!Number.isInteger(n)) {
    return { ok: false, error: 'Credit terms must be a whole number of days, or left blank.' };
  }
  if (n < MIN_TERMS_DAYS || n > MAX_TERMS_DAYS) {
    return {
      ok: false,
      error: `Credit terms must be between ${MIN_TERMS_DAYS} and ${MAX_TERMS_DAYS} days, or left blank.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * True when a supplier has genuinely recorded terms — including 0.
 * Use this, never a truthiness check, because `0` is falsy in JavaScript
 * and a plain `if (terms)` would misread cash-on-delivery as unrecorded.
 *
 * @param {number|null|undefined} termsDays
 */
export function hasRecordedTerms(termsDays) {
  return Number.isInteger(termsDays);
}

/**
 * Resolve a purchase due date from a purchase date and a number of credit
 * terms days, using UTC calendar arithmetic so the result never shifts with
 * the server's local timezone (the calendar answer to "30 days after 28 Sep"
 * doesn't depend on where the server happens to be).
 *
 * This mirrors the resolve_purchase_due_date() BEFORE INSERT trigger in
 * cashflow_v0_supplier_terms.sql. The database is the source of truth for
 * what gets stored; this exists so the UI can preview it and the forecast
 * engine can explain it. If the two ever disagree, the trigger wins and this
 * function is the bug.
 *
 * @param {string} purchaseDate  ISO date, "YYYY-MM-DD"
 * @param {number|null} termsDays
 * @returns {string|null} ISO date, or null when no basis exists
 */
export function deriveDueDate(purchaseDate, termsDays) {
  if (!hasRecordedTerms(termsDays)) return null;
  if (!isValidIsoDate(purchaseDate)) return null;

  const [y, m, d] = purchaseDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + termsDays);

  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Human-readable provenance for a stored due date, in the exact wording the
 * Cashflow UI is specified to show:
 *   - "Explicit date"
 *   - "Supplier terms · 30 days"
 *   - "Assumed by Cashflow"     (no due_date_source recorded at all)
 *
 * snapshotTermsDays MUST be the row's own due_date_terms_days — the terms
 * that were actually used when this specific date was derived — never the
 * supplier's current payment_terms_days. Passing the live value defeats the
 * whole point of storing a snapshot: an old purchase would start reporting
 * whatever the supplier's terms happen to be today, silently, the moment
 * they change. See the file-level comment above.
 *
 * @param {'explicit'|'supplier_terms'|null|undefined} source        stored due_date_source
 * @param {number|null|undefined} snapshotTermsDays  stored due_date_terms_days — NOT supplier.payment_terms_days
 * @returns {{ label: string, assumed: boolean }}
 */
export function describeDueDateSource(source, snapshotTermsDays) {
  if (source === 'explicit') {
    return { label: 'Explicit date', assumed: false };
  }
  if (source === 'supplier_terms') {
    const label = hasRecordedTerms(snapshotTermsDays)
      ? `Supplier terms · ${snapshotTermsDays} day${snapshotTermsDays === 1 ? '' : 's'}`
      : 'Supplier terms';
    return { label, assumed: false };
  }
  return { label: 'Assumed by Cashflow', assumed: true };
}

/**
 * The three write outcomes for a purchase's due date, given an already
 * RESOLVED mode (not the raw request — callers decide 'explicit' vs
 * 'supplier_terms' vs 'unrecorded' first, including via
 * inferLegacyDueDateMode below, then call this).
 *
 * Single source of truth for two rules that must never diverge between the
 * POST and PATCH purchase routes:
 *   - 'unrecorded' ALWAYS clears due_date, due_date_source and
 *     due_date_terms_days together, regardless of what the supplier's terms
 *     currently are. (This is the rev-2 P0 fix: before it, POST's BEFORE
 *     INSERT trigger derived a date whenever the supplier had terms, even
 *     when the caller asked for "unrecorded" — while PATCH honoured
 *     "unrecorded" literally. Same request, two different outcomes.)
 *   - 'explicit' never carries a due_date_terms_days snapshot — a typed-in
 *     date has no "terms used" to remember.
 *
 * Used directly by PATCH (which computes the derived date itself, since the
 * resolve_purchase_due_date() trigger is BEFORE INSERT only). POST cannot
 * use the 'supplier_terms' branch of this function — it must not compute or
 * snapshot the date in JS, only ask the trigger to via
 * shouldRequestSupplierTermsDerivation() below, so there is exactly one
 * implementation of "purchase_date + terms" (the trigger's) — but POST does
 * use inferLegacyDueDateMode() and would use the 'explicit'/'unrecorded'
 * branches here if it needed the same object shape.
 *
 * @param {'explicit'|'supplier_terms'|'unrecorded'} mode
 * @param {{ explicitDate?: string, derivedDate?: string, supplierTermsDays?: number }} inputs
 * @returns {{ due_date: string|null, due_date_source: string|null, due_date_terms_days: number|null }}
 */
export function buildDueDateFields(mode, { explicitDate, derivedDate, supplierTermsDays } = {}) {
  if (mode === 'explicit') {
    if (!explicitDate) {
      throw new RangeError('buildDueDateFields: explicitDate is required for mode "explicit"');
    }
    return { due_date: explicitDate, due_date_source: 'explicit', due_date_terms_days: null };
  }
  if (mode === 'supplier_terms') {
    if (!derivedDate) {
      throw new RangeError('buildDueDateFields: derivedDate is required for mode "supplier_terms"');
    }
    if (!hasRecordedTerms(supplierTermsDays)) {
      throw new RangeError('buildDueDateFields: supplierTermsDays must be recorded for mode "supplier_terms"');
    }
    // The snapshot: exactly the terms passed in, frozen into the return
    // value. Nothing here re-reads the supplier row later.
    return { due_date: derivedDate, due_date_source: 'supplier_terms', due_date_terms_days: supplierTermsDays };
  }
  if (mode === 'unrecorded') {
    return { due_date: null, due_date_source: null, due_date_terms_days: null };
  }
  throw new RangeError(`buildDueDateFields: unknown mode "${mode}"`);
}

/**
 * Whether an INSERT should ask the BEFORE INSERT trigger to derive the due
 * date from supplier terms, via the due_date_request_mode marker.
 *
 * The only 'true' case is an explicit request for 'supplier_terms' — a
 * caller whose resolved mode is 'unrecorded' gets `false` even when the
 * supplier has terms recorded. This is the fix for the rev-2 bug: the
 * trigger used to derive a date whenever one was POSSIBLE, not when one was
 * REQUESTED, so "unrecorded" silently stopped meaning unrecorded on create.
 *
 * @param {'explicit'|'supplier_terms'|'unrecorded'} mode
 * @returns {boolean}
 */
export function shouldRequestSupplierTermsDerivation(mode) {
  return mode === 'supplier_terms';
}

/**
 * The legacy-omission compatibility rule for POST /api/purchases: a caller
 * that sends NO due_date_mode at all must not be silently treated as having
 * chosen "unrecorded" (rev 2's bug — the code defaulted the mode STRING to
 * 'unrecorded' while the trigger's actual behavior still derived a date
 * whenever the supplier had terms, so the default was a lie about what
 * would happen).
 *
 * Reproduces the pre-provenance contract explicitly instead of leaving it as
 * an accidental trigger side effect: a raw due_date present means the caller
 * meant 'explicit'; otherwise derive from the supplier's terms if they have
 * any recorded (including 0 — cash on delivery is a recorded answer), else
 * 'unrecorded'.
 *
 * Only applies to creating a new row. PATCH treats an omitted due_date_mode
 * as "don't touch the due date" (ordinary partial-update semantics) — an
 * existing purchase's due date must never move just because some unrelated
 * field was edited.
 *
 * @param {{ rawDueDateProvided: boolean, supplierTermsDays: number|null|undefined }} inputs
 * @returns {'explicit'|'supplier_terms'|'unrecorded'}
 */
export function inferLegacyDueDateMode({ rawDueDateProvided, supplierTermsDays }) {
  if (rawDueDateProvided) return 'explicit';
  return hasRecordedTerms(supplierTermsDays) ? 'supplier_terms' : 'unrecorded';
}
