/**
 * Who may see and change which employee fields.
 *
 * (Payroll RUNS, entries, PDFs and payments are governed by payrollAccess.js.)
 *
 * Policy
 *   admin                              sees and edits everything, approves change requests.
 *   production_manager, head_of_sales  see the full employee profile (so they can find and reach
 *                                      staff, incl. by phone), ADD employees with every field, and
 *                                      activate/deactivate. They cannot change anything on an existing
 *                                      employee directly: any other change (rate, salary, phone, bank,
 *                                      paybill, SHA, NSSF, name, type ...) is logged as a CHANGE REQUEST
 *                                      that only an admin can approve (employee_change_requests).
 *                                      They do not see employee documents (admin only).
 *
 * The column list is an explicit ALLOW-LIST passed to .select(); a column added to `employees` later
 * stays hidden from everyone until it is added here.
 *
 * Pure and client-safe (no imports).
 */

export const EMPLOYEE_COLUMNS = Object.freeze({
  full:
    'id, employee_num, name, type, is_active, day_rate, monthly_salary, piece_rate, sha_amount, ' +
    'nssf_number, id_number, phone, bank_account, bank_name, bank_branch, paybill_number, ' +
    'hire_date, notes, created_at, created_by, onboarding_status',
});

export const MANAGER_ROLES = Object.freeze(['production_manager', 'head_of_sales']);

/** 'full' for admin and managers; null for everyone else. */
export function employeeAccessLevel(role) {
  return role === 'admin' || MANAGER_ROLES.includes(role) ? 'full' : null;
}
export const canSeeEmployeeProfile = (role) => employeeAccessLevel(role) === 'full';
/** Employee documents (ID copies, contracts …) stay admin-only. */
export const canSeeEmployeeDocuments = (role) => role === 'admin';
export const canDecideEmployeeChange = (role) => role === 'admin';

// ── Writes ────────────────────────────────────────────────────────────────────

/** Every employee field a request may change (is_active is deliberately not here). */
export const REQUESTABLE_FIELDS = Object.freeze([
  'name', 'type', 'day_rate', 'monthly_salary', 'piece_rate', 'sha_amount',
  'nssf_number', 'id_number', 'phone', 'bank_account', 'bank_name', 'bank_branch',
  'paybill_number', 'hire_date', 'notes',
]);
/** Fields that decide WHAT someone is paid or WHERE it goes: flagged for the approver. */
export const PAYMENT_FIELDS = Object.freeze([
  'day_rate', 'monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number',
  'phone', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number',
]);
export const NUMERIC_FIELDS = Object.freeze(['day_rate', 'monthly_salary', 'piece_rate', 'sha_amount']);
export const FIELD_LABELS = Object.freeze({
  name: 'Name', type: 'Type', day_rate: 'Day rate', monthly_salary: 'Monthly salary', piece_rate: 'Piece rate',
  sha_amount: 'SHA', nssf_number: 'NSSF number', id_number: 'ID number', phone: 'M-Pesa phone',
  bank_account: 'Bank account', bank_name: 'Bank name', bank_branch: 'Bank branch', paybill_number: 'Paybill',
  hire_date: 'Hire date', notes: 'Notes',
});

const ALL_FIELDS = [...REQUESTABLE_FIELDS, 'is_active'];

/** Anyone with a payroll role may add an employee, with every field. */
export const canCreateEmployee = (role) => employeeAccessLevel(role) === 'full';

/**
 * Split a PATCH body by role.
 *   admin    → everything is applied directly
 *   manager  → is_active directly; every other field becomes a change request
 *   others   → nothing
 */
export function splitEmployeeUpdate(role, body = {}) {
  const keys = Object.keys(body || {}).filter(k => ALL_FIELDS.includes(k));
  if (role === 'admin') return { direct: keys, requested: [] };
  if (MANAGER_ROLES.includes(role)) {
    return { direct: keys.filter(k => k === 'is_active'), requested: keys.filter(k => k !== 'is_active') };
  }
  return { direct: [], requested: [] };
}

/** Normalise a value for comparison/storage: '' / undefined → null, numeric fields → number. */
export function normaliseEmployeeValue(field, value) {
  if (typeof value === 'string') value = value.trim();
  if (value === '' || value === undefined || value === null) return null;
  if (NUMERIC_FIELDS.includes(field)) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value))) return NaN;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 99999999.99 && Number(n.toFixed(2)) === n ? n : NaN;
  }
  return typeof value === 'string' ? value : NaN;
}

/**
 * Compare a requested update with the employee's current row. Returns only the fields that
 * actually differ, as { field: { old, new } }, plus any fields with an invalid value.
 */
export function diffEmployeeChanges(current, body, fields) {
  const changes = {};
  const invalid = [];
  for (const f of fields) {
    const next = normaliseEmployeeValue(f, body[f]);
    if (Number.isNaN(next)) { invalid.push(f); continue; }
    const prev = normaliseEmployeeValue(f, current?.[f]);
    if (prev === next) continue;
    if (f === 'name' && !next) { invalid.push(f); continue; }
    changes[f] = { old: Number.isNaN(prev) || !NUMERIC_FIELDS.includes(f) ? current?.[f] ?? null : prev, new: next };
  }
  return { changes, invalid };
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Build the PostgREST .or() filter for the employee search box, or null.
 * Strips characters that are PostgREST filter syntax (, ( ) * % \ ") so the search text
 * cannot add its own filters. Phone matching for anyone who can see the profile (managers
 * need to reach staff).
 */
export function employeeSearchFilter(role, raw) {
  const term = String(raw ?? '').replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!term) return null;
  const cols = ['name', 'employee_num'];
  if (canSeeEmployeeProfile(role)) cols.push('phone');
  return cols.map(c => `${c}.ilike.%${term}%`).join(',');
}
