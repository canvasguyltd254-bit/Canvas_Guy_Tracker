/**
 * Who may see and change which employee fields.
 *
 * (Payroll RUNS, entries, PDFs and payments are governed by payrollAccess.js.)
 *
 * Two response shapes, each an explicit column ALLOW-LIST. Routes pass the list
 * straight to .select(), so columns a role must not see are never fetched, and a
 * column added to `employees` later stays hidden from everyone until it is added here.
 *
 *   private  admin                                full profile
 *   manager  production_manager, head_of_sales    day-paid workers' full details
 *            (name, status, day/piece rate, phone, ID, bank/paybill, hire date, notes).
 *            NOT monthly salary, SHA or NSSF.
 *
 * Permanent (salaried) staff are admin-only: for a manager their row is reduced to
 * identity + status (`serializeEmployee`), and managers cannot edit them except to
 * activate/deactivate. Managers may add and edit casual / skilled-casual workers,
 * because those workers cannot be paid without a phone number or bank details.
 *
 * Shop-floor roles never use payroll routes; Production has its own worker
 * routes that select only id/name/employee_number/type.
 *
 * Pure and client-safe (no imports).
 */

const IDENTITY = 'id, employee_num, name, type, is_active';

export const EMPLOYEE_COLUMNS = Object.freeze({
  // what a manager sees of a permanent employee (and the minimum for anyone)
  basic: IDENTITY,
  manager:
    `${IDENTITY}, day_rate, piece_rate, phone, id_number, bank_account, bank_name, bank_branch, ` +
    'paybill_number, hire_date, notes',
  private:
    `${IDENTITY}, day_rate, monthly_salary, piece_rate, sha_amount, ` +
    'nssf_number, id_number, phone, bank_account, bank_name, bank_branch, paybill_number, ' +
    'hire_date, notes, created_at, created_by',
});

export const MANAGER_ROLES = Object.freeze(['production_manager', 'head_of_sales']);
export const DAY_PAID_TYPES = Object.freeze(['casual', 'skilled_casual']);

export function employeeAccessLevel(role) {
  if (role === 'admin') return 'private';
  if (MANAGER_ROLES.includes(role)) return 'manager';
  return null;
}

export const canSeePrivateEmployeeData = (role) => employeeAccessLevel(role) === 'private';

/**
 * Final per-row filter for non-admins: a permanent employee's row is cut down to
 * identity + status, whatever columns were fetched.
 */
export function serializeEmployee(role, emp) {
  if (!emp || role === 'admin') return emp;
  if (emp.type !== 'permanent') return emp;
  return { id: emp.id, employee_num: emp.employee_num, name: emp.name, type: emp.type, is_active: emp.is_active };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Managers may write these on day-paid workers. */
const MANAGER_WRITE = [
  'name', 'is_active', 'type', 'day_rate', 'piece_rate',
  'phone', 'id_number', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number',
  'hire_date', 'notes',
];
/** Admin only: monthly salary and statutory deductions. */
export const ADMIN_ONLY_FIELDS = Object.freeze(['monthly_salary', 'sha_amount', 'nssf_number']);
/** Kept for callers/tests that list the private-only fields. */
export const SENSITIVE_FIELDS = ADMIN_ONLY_FIELDS;
const ADMIN_WRITE = [...MANAGER_WRITE, ...ADMIN_ONLY_FIELDS];

/** Who may add an employee, and which pay types they may add. */
export const CREATABLE_TYPES = Object.freeze({
  admin: ['casual', 'permanent', 'skilled_casual'],
  production_manager: [...DAY_PAID_TYPES],
  head_of_sales: [...DAY_PAID_TYPES],
});
export const creatableTypes = (role) => CREATABLE_TYPES[role] || [];
export const canCreateEmployee = (role) => creatableTypes(role).length > 0;

export function writableEmployeeFields(role) {
  switch (employeeAccessLevel(role)) {
    case 'private': return ADMIN_WRITE;
    case 'manager': return MANAGER_WRITE;
    default:        return [];
  }
}

/**
 * Split a request body into the fields this role may write and the known
 * employee fields it tried to write but may not. Unknown keys are ignored.
 * A forbidden key is reported even when its value is empty: the server never
 * silently drops a write the caller believes happened.
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

/** Same split for CREATE (the route additionally restricts `type` to creatableTypes). */
export const partitionEmployeeCreate = partitionEmployeeWrite;

/**
 * May this role edit (not just activate/deactivate) this existing employee?
 * Managers cannot edit permanent staff, and cannot move a worker to/from permanent.
 */
export function canEditEmployeeRecord(role, existing, body = {}) {
  if (role === 'admin') return { ok: true };
  if (existing?.type === 'permanent') {
    const keys = Object.keys(body || {}).filter(k => ADMIN_WRITE.includes(k));
    if (keys.every(k => k === 'is_active')) return { ok: true };
    return { ok: false, error: 'Permanent (salaried) employees can only be edited by an admin' };
  }
  if (body.type !== undefined && !DAY_PAID_TYPES.includes(body.type)) {
    return { ok: false, error: 'Only an admin can make an employee permanent (salaried)' };
  }
  return { ok: true };
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Build the PostgREST .or() filter for the employee search box, or null.
 * Strips characters that are PostgREST filter syntax (, ( ) * % \ ") so the
 * search text cannot add its own filters (which would let a caller probe
 * columns they cannot read). Only admin matches on phone (a manager's phone search
 * would reveal permanent staff's numbers by probing).
 */
export function employeeSearchFilter(role, raw) {
  const term = String(raw ?? '').replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!term) return null;
  const cols = ['name', 'employee_num'];
  if (canSeePrivateEmployeeData(role)) cols.push('phone');
  return cols.map(c => `${c}.ilike.%${term}%`).join(',');
}
