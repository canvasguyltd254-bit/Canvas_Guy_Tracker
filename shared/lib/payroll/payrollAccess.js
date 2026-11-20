/**
 * Who may touch payroll RUNS (as opposed to the employee directory, which is
 * governed by employeeAccess.js).
 *
 *   admin               everything, including approving / reopening / deleting runs
 *   production_manager  see runs and their sums; create runs, add workers, edit
 *   head_of_sales       attendance, adjustments and order links; cannot approve,
 *                       reopen or delete, and cannot see or move payments
 *
 * NOT run access, still admin-only: approving, reopening and deleting runs;
 * payment batches, payments and exports; statutory/compliance rules; the
 * employee payroll PDF; and the private employee profile (see employeeAccess.js).
 *
 * Column lists are explicit allow-lists passed straight to .select(). Roles
 * with no run access (and any unknown role) fall back to the header-only
 * "minimal" shape, so a new role can never receive pay figures by accident.
 *
 * Pure and client-safe (no imports).
 */

export const ADMIN_ONLY = Object.freeze(['admin']);
/** Roles allowed on the run, entry, attendance, adjustment and run-PDF routes. */
export const RUN_ROLES = Object.freeze(['admin', 'production_manager', 'head_of_sales']);

/** Run roles see run figures; approval and payments remain admin-only. */
export const canSeePayrollMoney = (role) => RUN_ROLES.includes(role);
export const canAccessPayrollRuns = (role) => RUN_ROLES.includes(role);

// ── payroll_runs ──────────────────────────────────────────────────────────────
const RUN_BASE = 'id, run_num, period_type, period_start, period_end, run_type, status, notes, created_at, created_by';
export const RUN_COLUMNS = Object.freeze({
  full:
    `${RUN_BASE}, reopen_reason, approved_by, approved_at, approved_by_name, ` +
    'total_gross, total_deductions, total_net, employee_count',
  minimal: RUN_BASE,                          // no totals, no approval snapshot
});

// ── payroll_entries ───────────────────────────────────────────────────────────
export const ENTRY_COLUMNS = Object.freeze({
  full:
    'id, run_id, employee_id, snapshot_name, snapshot_type, snapshot_day_rate, snapshot_salary, snapshot_sha, ' +
    'days_worked, overtime_hours, overtime_rate, overtime_amount, gross_pay, sha_deduction, advance_deduction, ' +
    'damage_deduction, other_deductions, total_deductions, net_pay, amount_paid, balance, payment_status, notes, created_at',
  // Fallback for roles without run access: who, what type, how many days. No rates, pay,
  // deductions or payment state.
  minimal: 'id, run_id, employee_id, snapshot_name, snapshot_type, days_worked, created_at',
});

/** Employee join on entries. */
export const ENTRY_EMPLOYEE_JOIN_MINIMAL = 'employees(name, employee_num, type)';
export const ENTRY_EMPLOYEE_JOIN_FULL = 'employees(name, employee_num, type, day_rate)';

export const runColumnsFor   = (role) => (canSeePayrollMoney(role) ? RUN_COLUMNS.full   : RUN_COLUMNS.minimal);
export const entryColumnsFor = (role) => (canSeePayrollMoney(role) ? ENTRY_COLUMNS.full : ENTRY_COLUMNS.minimal);
export const entryJoinFor    = (role) => (canSeePayrollMoney(role) ? ENTRY_EMPLOYEE_JOIN_FULL : ENTRY_EMPLOYEE_JOIN_MINIMAL);

/** Every column that carries money, for tests and defensive scrubbing. */
export const MONEY_RUN_FIELDS = Object.freeze(['total_gross', 'total_deductions', 'total_net', 'total_outstanding', 'approved_by', 'approved_at', 'approved_by_name', 'reopen_reason']);
export const MONEY_ENTRY_FIELDS = Object.freeze([
  'snapshot_day_rate', 'snapshot_salary', 'snapshot_sha', 'overtime_rate', 'overtime_amount', 'gross_pay',
  'sha_deduction', 'advance_deduction', 'damage_deduction', 'other_deductions', 'total_deductions',
  'net_pay', 'amount_paid', 'balance', 'payment_status',
]);

/** Payroll screens each role may open, in display order. */
export function payrollTabsFor(role) {
  if (role === 'admin') return ['overview', 'employees', 'runs', 'payments', 'compliance', 'reports'];
  if (role === 'production_manager' || role === 'head_of_sales') return ['employees', 'runs'];
  return [];
}
