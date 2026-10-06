/**
 * Distinguish "this migration has not been applied" from a real query failure.
 * Only the former may fall back to a degraded response; the latter must surface.
 *  42703 undefined_column, 42P01 undefined_table, 42883 undefined_function,
 *  PGRST200 (no relationship), PGRST202 (no function), PGRST204 (no column), PGRST205 (no table)
 */
const MISSING_CODES = new Set(['42703', '42P01', '42883', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205']);

export function isMissingSchema(error) {
  if (!error) return false;
  if (error.code && MISSING_CODES.has(error.code)) return true;
  return /does not exist|could not find the .* (column|table|function|relationship)|schema cache/i.test(error.message || '');
}
