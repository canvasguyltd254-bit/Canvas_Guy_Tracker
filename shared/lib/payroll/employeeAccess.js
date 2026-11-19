/**
 * Who may see and change which employee fields.
 *
 * (Payroll RUNS, entries, PDFs and payments are governed by payrollAccess.js.)
 *
 * Three response shapes, each an explicit column ALLOW-LIST. Routes pass the
 * list straight to .select(), so private columns are never fetched for roles
 * that must not see them (nothing is fetched and then stripped), and a column
 * added to `employees` later stays hidden from everyone until it is added here.
 *
 *   private      admin               full profile (pay, statutory, contact, bank)
 *   operational  production_manager  identity, status and day rate only
 *   basic        head_of_sales       identity and status only
 *
 * Shop-floor roles never use payroll routes; Production has its own worker
 * routes that select only id/name/employee_number/type.
 *
 * Pure and client-safe (no imports).
 */

export const EMPLOYEE_COLUMNS = Object.freeze({
  basic:       'id, employee_num, name, type, is_active',
  operational: 'id, employee_num, name, type, is_active, day_rate',
  private:
    'id, employee_num, name, type, is_active, day_rate, monthly_salary, piece_rate, sha_amount, ' +
    'nssf_number, id_number, phone, bank_account, bank_name, bank_branch, paybill_number, ' +
    'hire_date, notes, created_at, created_by',
});

export function employeeAccessLevel(role) {
  if (role === 'admin') return 'private';
  if (role === 'production_manager') return 'operational';
  if (role === 'head_of_sales') return 'basic';
  return null;
}

export const canSeePrivateEmployeeData = (role) => employeeAccessLevel(role) === 'private';

// ── Writes ────────────────────────────────────────────────────────────────────

/** Any payroll role may change these. `type` is NOT here: an employee's pay basis
 *  decides which runs they can be in and how they are paid, so it is admin-only. */
const COMMON_WRITE = ['name', 'is_active'];
/** Plus these for roles that can see day rates. */
const OPERATIONAL_WRITE = [...COMMON_WRITE, 'day_rate'];
/** Admin only: pay basis, pay, statutory, contact, banking, history. */
export const SENSITIVE_FIELDS = Object.freeze([
  'monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number', 'id_number',
  'phone', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number',
  'hire_date', 'notes',
]);
export const ADMIN_ONLY_FIELDS = Object.freeze(['type', ...SENSITIVE_FIELDS]);
const ADMIN_WRITE = [...OPERATIONAL_WRITE, ...ADMIN_ONLY_FIELDS];

/**
 * Creating a payroll employee needs pay basis, rate/salary and statutory data,
 * all admin-only, so creation is admin-only. (A controlled temporary-worker
 * creation flow, if built later, is a separate, deliberate design.)
 */
export const canCreateEmployee = (role) => role === 'admin';

export function writableEmployeeFields(role) {
  switch (employeeAccessLevel(role)) {
    case 'private':     return ADMIN_WRITE;
    case 'operational': return OPERATIONAL_WRITE;
    case 'basic':       return COMMON_WRITE;
    default:            return [];
  }
}

/**
 * Split a request body into the fields this role may write and the known
 * employee fields it tried to write but may not. Unknown keys are ignored
 * (same as the old whitelist). A forbidden key is reported even when its
 * value is empty: the server never silently drops a write the caller
 * believes happened.
 */
export function partitionEmployeeWrite(role, body = {}) {
  const writable = new Set(writableEmployeeFields(role));
  const known = new Set(ADMIN_WRITE);
  const allowed = [];
  const forbidden = [];
  for (const key of Object.keys(body || {})) {
    if (!known.has(key)) continue;
    (writable.has(key) ? allowed : forbidden).push(key);
  }
  return { allowed, forbidden };
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Build the PostgREST .or() filter for the employee search box, or null.
 * - strips characters that are PostgREST filter syntax (, ( ) * % \ ") so the
 *   search text cannot add its own filters (which would let a caller probe
 *   columns they cannot read);
 * - only admin may match on phone.
 */
export function employeeSearchFilter(role, raw) {
  const term = String(raw ?? '').replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!term) return null;
  const cols = ['name', 'employee_num'];
  if (canSeePrivateEmployeeData(role)) cols.push('phone');
  return cols.map(c => `${c}.ilike.%${term}%`).join(',');
}
