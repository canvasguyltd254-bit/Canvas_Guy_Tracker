/**
 * shared/lib/reports/dateBounds.js
 *
 * Server-side helpers to turn a 'YYYY-MM-DD' range into timestamptz bounds in
 * the business timezone (Africa/Nairobi, UTC+3, no daylight saving), so a
 * payment or order created at 23:30 Nairobi time lands on the right day even
 * though the database stores UTC.
 */

import { isIsoDate } from '../customerReport.js';

const NAIROBI = '+03:00';

function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * @returns {{ gte: string|null, lt: string|null }} ISO timestamps with offset.
 *   `gte` is the start of `from`; `lt` is the start of the day AFTER `to`.
 */
export function nairobiBounds({ from = null, to = null } = {}) {
  return {
    gte: from && isIsoDate(from) ? `${from}T00:00:00${NAIROBI}` : null,
    lt:  to && isIsoDate(to) ? `${nextDay(to)}T00:00:00${NAIROBI}` : null,
  };
}

/** Today's date in Nairobi as 'YYYY-MM-DD'. */
export function nairobiToday(now = new Date()) {
  const shifted = new Date(now.getTime() + 3 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Validate query-string dates; returns an error message or ''. */
export function validateQueryRange({ from, to }) {
  if (from && !isIsoDate(from)) return 'Invalid "from" date.';
  if (to && !isIsoDate(to)) return 'Invalid "to" date.';
  if (from && to && from > to) return '"from" must be on or before "to".';
  return '';
}
