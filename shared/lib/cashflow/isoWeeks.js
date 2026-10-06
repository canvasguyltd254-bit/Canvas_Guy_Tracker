/**
 * shared/lib/cashflow/isoWeeks.js
 *
 * The ONLY implementation of forecast-week boundaries. Nothing else in the
 * Cashflow engine (or, per the Stage 2 contract, any UI component) computes
 * a week start/end or buckets a date into a week independently — everything
 * routes through this file.
 *
 * Zero Supabase imports. Zero I/O. Pure date arithmetic, in UTC throughout so
 * results never depend on the server's local timezone (same convention as
 * shared/lib/isoDate.js and shared/lib/supplierTerms.js).
 *
 * ISO week: Monday to Sunday. "First forecast week: the first Monday on or
 * after as_of" — if as_of is itself a Monday, that IS the first week; a
 * Wed/Thu/etc. as_of rolls forward to the following Monday (the Monday of
 * as_of's OWN week has already partly elapsed and is never in range).
 */

import { isValidIsoDate, compareIsoDates } from '../isoDate.js';

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const RECURRENCE_STEP_MONTHS = Object.freeze({
  monthly: 1,
  quarterly: 3,
  annual: 12,
});

// ── internal helpers (not exported — everything outside this file works in
//    "YYYY-MM-DD" strings, never raw Date objects, so a caller can never
//    accidentally introduce timezone drift by holding onto a Date) ─────────

function parseIsoDateToUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDate(date) {
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatWeekLabel(dateUtc) {
  // "28 Sep" — no leading zero on the day, matching the Cashflow UI's
  // established date-label style (see the Payments Plan mockup).
  return `${dateUtc.getUTCDate()} ${MONTH_ABBR[dateUtc.getUTCMonth()]}`;
}

// ── exports ──────────────────────────────────────────────────────────────

/**
 * The Monday (YYYY-MM-DD) of the ISO week containing `date`.
 * Mon->same date; Tue..Sun -> the Monday on or before `date`.
 *
 * @param {string} date
 * @returns {string}
 */
export function getIsoMonday(date) {
  if (!isValidIsoDate(date)) {
    throw new RangeError(`getIsoMonday: invalid date "${date}"`);
  }
  const dt = parseIsoDateToUtc(date);
  const jsDow = dt.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
  const isoDow = jsDow === 0 ? 7 : jsDow; // 1=Mon,...,7=Sun
  dt.setUTCDate(dt.getUTCDate() - (isoDow - 1));
  return formatUtcDate(dt);
}

/**
 * The first Monday ON OR AFTER `date`. If `date` is itself a Monday, returns
 * `date` unchanged. This is the anchor for the whole forecast horizon — see
 * buildIsoWeeks below.
 *
 * @param {string} date
 * @returns {string}
 */
export function getNextIsoMonday(date) {
  if (!isValidIsoDate(date)) {
    throw new RangeError(`getNextIsoMonday: invalid date "${date}"`);
  }
  const currentWeekMonday = getIsoMonday(date);
  if (currentWeekMonday === date) return currentWeekMonday;

  const dt = parseIsoDateToUtc(currentWeekMonday);
  dt.setUTCDate(dt.getUTCDate() + 7);
  return formatUtcDate(dt);
}

/**
 * Builds the full forecast horizon: `horizonWeeks` consecutive ISO weeks
 * starting at the first Monday on or after `asOf`.
 *
 * @param {string} asOf
 * @param {number} horizonWeeks
 * @returns {{index:number, week_start:string, week_end:string, label:string}[]}
 */
export function buildIsoWeeks(asOf, horizonWeeks) {
  if (!isValidIsoDate(asOf)) {
    throw new RangeError(`buildIsoWeeks: invalid as_of date "${asOf}"`);
  }
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1) {
    throw new RangeError(`buildIsoWeeks: horizonWeeks must be a positive integer, got ${horizonWeeks}`);
  }

  const firstMonday = getNextIsoMonday(asOf);
  const cursor = parseIsoDateToUtc(firstMonday);
  const weeks = [];

  for (let i = 0; i < horizonWeeks; i++) {
    const weekStart = formatUtcDate(cursor);
    const endCursor = new Date(cursor);
    endCursor.setUTCDate(endCursor.getUTCDate() + 6);
    const weekEnd = formatUtcDate(endCursor);

    weeks.push({
      index: i,
      week_start: weekStart,
      week_end: weekEnd,
      label: formatWeekLabel(cursor),
    });

    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return weeks;
}

/**
 * Maps `date` onto one of the weeks built by buildIsoWeeks.
 *
 *   - Before weeks[0].week_start -> { index: 0, is_overdue: true }
 *     (overdue items roll into week one and stay marked overdue — they are
 *     never silently dropped or reassigned to a calendar week that doesn't
 *     exist in the horizon).
 *   - Within some week's [week_start, week_end] -> { index, is_overdue: false }
 *   - After the final week_end -> null (outside the projection).
 *   - Invalid date -> throws.
 *
 * @param {string} date
 * @param {{index:number, week_start:string, week_end:string}[]} weeks
 * @returns {{index:number, is_overdue:boolean}|null}
 */
export function bucketDateIntoWeek(date, weeks) {
  if (!isValidIsoDate(date)) {
    throw new RangeError(`bucketDateIntoWeek: invalid date "${date}"`);
  }
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new RangeError('bucketDateIntoWeek: weeks must be a non-empty array');
  }

  const firstStart = weeks[0].week_start;
  const lastEnd = weeks[weeks.length - 1].week_end;

  if (compareIsoDates(date, firstStart) < 0) {
    return { index: 0, is_overdue: true };
  }
  if (compareIsoDates(date, lastEnd) > 0) {
    return null;
  }

  for (const w of weeks) {
    if (compareIsoDates(date, w.week_start) >= 0 && compareIsoDates(date, w.week_end) <= 0) {
      return { index: w.index, is_overdue: false };
    }
  }

  // Unreachable given the boundary checks above (the weeks array is
  // contiguous by construction) — fail loudly rather than silently drop the
  // date if that invariant is ever broken by a future change.
  throw new Error(`bucketDateIntoWeek: date "${date}" did not match any week bucket — weeks array may not be contiguous`);
}

/**
 * The last valid day of (year, month), clamping a requested day that
 * overshoots (day_of_month = 31 in a 30-day or 28/29-day month).
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} requestedDay  1-31
 * @returns {number}
 */
export function clampDayToMonth(year, month, requestedDay) {
  if (!Number.isInteger(year)) {
    throw new RangeError(`clampDayToMonth: invalid year "${year}"`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`clampDayToMonth: month must be 1-12, got ${month}`);
  }
  if (!Number.isInteger(requestedDay) || requestedDay < 1 || requestedDay > 31) {
    throw new RangeError(`clampDayToMonth: requestedDay must be 1-31, got ${requestedDay}`);
  }
  // Date.UTC(year, month, 0) — passing the 1-based `month` value into the
  // 0-based monthIndex slot lands on "month+1, day 0", i.e. the last day of
  // the (1-based) `month` requested.
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(requestedDay, lastDayOfMonth);
}

/**
 * Generates every occurrence date of a recurring (or one-off) obligation
 * that falls within [rangeStart, rangeEnd] inclusive.
 *
 * Rules (see cashflow_manual_obligations / Stage 2 spec):
 *   - is_active === false -> no occurrences, ever.
 *   - 'once' -> exactly first_due_date, if it lands in range.
 *   - 'monthly' / 'quarterly' / 'annual' -> first_due_date is occurrence #0
 *     exactly (guaranteeing "never before first_due_date" trivially and
 *     giving a stable occurrence identity for the very first instance);
 *     each subsequent occurrence steps the anchor month by 1/3/12 months and
 *     applies day_of_month, clamped via clampDayToMonth for that month.
 *   - Generation stops once an occurrence would fall after `ends_on`
 *     (when set) or after `rangeEnd`, whichever comes first.
 *
 * Occurrence identity is (obligation_id, occurrence_date) — this function
 * returns dates only; the caller pairs each with obligation.id.
 *
 * @param {{recurrence:string, first_due_date:string, ends_on:?string, is_active:boolean, day_of_month:?number}} obligation
 * @param {string} rangeStart
 * @param {string} rangeEnd
 * @returns {string[]}
 */
export function generateObligationOccurrences(obligation, rangeStart, rangeEnd) {
  const { recurrence, first_due_date, ends_on, is_active, day_of_month } = obligation || {};

  if (!isValidIsoDate(first_due_date)) {
    throw new RangeError(`generateObligationOccurrences: invalid first_due_date "${first_due_date}"`);
  }
  if (!isValidIsoDate(rangeStart) || !isValidIsoDate(rangeEnd)) {
    throw new RangeError('generateObligationOccurrences: invalid rangeStart/rangeEnd');
  }
  if (ends_on != null && !isValidIsoDate(ends_on)) {
    throw new RangeError(`generateObligationOccurrences: invalid ends_on "${ends_on}"`);
  }

  if (is_active === false) return [];

  if (recurrence === 'once') {
    const inRange =
      compareIsoDates(first_due_date, rangeStart) >= 0 &&
      compareIsoDates(first_due_date, rangeEnd) <= 0 &&
      (ends_on == null || compareIsoDates(first_due_date, ends_on) <= 0);
    return inRange ? [first_due_date] : [];
  }

  const step = RECURRENCE_STEP_MONTHS[recurrence];
  if (!step) {
    throw new RangeError(`generateObligationOccurrences: unknown recurrence "${recurrence}"`);
  }
  if (!Number.isInteger(day_of_month) || day_of_month < 1 || day_of_month > 31) {
    throw new RangeError(`generateObligationOccurrences: day_of_month is required for recurrence "${recurrence}"`);
  }

  const anchorYear = Number(first_due_date.slice(0, 4));
  const anchorMonth = Number(first_due_date.slice(5, 7));

  const occurrences = [];
  // Safety valve against a malformed input looping forever — 1200 monthly
  // steps is 100 years, far beyond any realistic obligation lifetime, and
  // this is the largest possible per-recurrence count since quarterly/annual
  // advance faster per step.
  const MAX_ITERATIONS = 1200;

  for (let k = 0; k <= MAX_ITERATIONS; k++) {
    let occDate;
    if (k === 0) {
      occDate = first_due_date;
    } else {
      const totalMonths = (anchorMonth - 1) + step * k;
      const occYear = anchorYear + Math.floor(totalMonths / 12);
      const occMonth = (totalMonths % 12) + 1;
      const day = clampDayToMonth(occYear, occMonth, day_of_month);
      occDate = `${occYear}-${String(occMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    if (ends_on != null && compareIsoDates(occDate, ends_on) > 0) break;
    if (compareIsoDates(occDate, rangeEnd) > 0) break;

    if (compareIsoDates(occDate, rangeStart) >= 0) {
      occurrences.push(occDate);
    }
  }

  return occurrences;
}
