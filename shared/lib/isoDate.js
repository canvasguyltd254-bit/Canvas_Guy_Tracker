/**
 * shared/lib/isoDate.js
 *
 * Strict validation for "YYYY-MM-DD" date strings, shared by every route that
 * accepts a date from the client.
 *
 * WHY THIS EXISTS
 *   `"2026-02-30" < "2026-03-01"` is true — string comparison orders ISO dates
 *   correctly, but only once both strings are known to be real calendar dates.
 *   A regex like /^\d{4}-\d{2}-\d{2}$/ accepts "2026-02-30" and "2026-13-40";
 *   neither exists. Without validating first, an invalid date can pass a
 *   `dueDate < purchaseDate` comparison and reach PostgreSQL, which will
 *   either reject it with an opaque driver error or, worse, coerce it.
 *
 *   Validation is done with UTC date arithmetic specifically so the check
 *   depends only on the calendar, never on the server's local timezone.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when `s` is a real calendar date in "YYYY-MM-DD" form.
 * Rejects malformed strings, out-of-range months/days, and dates that don't
 * exist (Feb 30, Apr 31, non-leap Feb 29).
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;

  const year  = Number(m[1]);
  const month = Number(m[2]);
  const day   = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // Round-trip through Date.UTC and read the components back. An invalid
  // calendar date (Feb 30) rolls over to a different date, so the read-back
  // values won't match what was asked for.
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Compares two ISO date strings chronologically. Callers must validate both
 * with isValidIsoDate() first — this does plain string comparison, which is
 * only correct for well-formed, zero-padded "YYYY-MM-DD" strings.
 *
 * @returns {-1|0|1}
 */
export function compareIsoDates(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Validates `s` is a real ISO date, returning it unchanged, or throws a
 * {@link RangeError} with a message safe to surface directly in an API
 * error response. Use where a route needs a required, valid date or a 400.
 *
 * @param {unknown} s
 * @param {string} [fieldName] — used in the thrown message
 * @returns {string}
 */
export function requireValidIsoDate(s, fieldName = 'date') {
  if (!isValidIsoDate(s)) {
    throw new RangeError(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
  return s;
}

/**
 * `date` plus (or minus, for a negative `days`) a whole number of days, in
 * UTC calendar arithmetic — the same convention as the rest of this file, so
 * the result never depends on the server's local timezone.
 *
 * @param {string} date  valid "YYYY-MM-DD"
 * @param {number} days  integer, may be negative
 * @returns {string}
 */
export function addDaysToIsoDate(date, days) {
  if (!isValidIsoDate(date)) {
    throw new RangeError(`addDaysToIsoDate: invalid date "${date}"`);
  }
  if (!Number.isInteger(days)) {
    throw new RangeError(`addDaysToIsoDate: days must be an integer, got ${JSON.stringify(days)}`);
  }
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Whole-day difference `toDate - fromDate` (positive when `toDate` is later),
 * in UTC calendar arithmetic.
 *
 * @param {string} fromDate  valid "YYYY-MM-DD"
 * @param {string} toDate    valid "YYYY-MM-DD"
 * @returns {number}
 */
export function diffInDays(fromDate, toDate) {
  if (!isValidIsoDate(fromDate)) {
    throw new RangeError(`diffInDays: invalid fromDate "${fromDate}"`);
  }
  if (!isValidIsoDate(toDate)) {
    throw new RangeError(`diffInDays: invalid toDate "${toDate}"`);
  }
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}
