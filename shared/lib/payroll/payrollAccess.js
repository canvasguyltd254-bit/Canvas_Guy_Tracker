/**
 * Who may touch payroll RUNS (as opposed to the employee directory, which is
 * governed by employeeAccess.js).
 *
 *   admin               everything, including every money figure
 *   production_manager  attendance work only: run header, who is in the run,
 *                       days worked, saving attendance. NO pay figures, no
 *                       adjustments, PDFs, payments, batches, allocations,
 *                       statutory rules or reports.
 *   head_of_sales       no payroll-run access at all (employee directory only)
 *
 * Column lists are explicit allow-lists passed straight to .select(): nothing
 * private is fetched for a role that must not see it, and a column added to the
 * tables later stays hidden from non-admins until it is added here.
 *
 * Pure and client-safe (no imports).
 */

export const ADMIN_ONLY = Object.freeze(['admin']);
/** Roles allowed on the run/attendance routes (payroll money still admin-only). */
export const RUN_ATTENDANCE_ROLES = Object.freeze(['admin', 'production_manager']);

export const canSeePayrollMoney = (role) => role === 'admin';
export const canAccessPayrollRuns = (role) => RUN_ATTENDANCE_ROLES.includes(role);

// ── payroll_runs ──────────────────────────────────────────────────────────────
const RUN_BASE = 'id, run_num, period_type, period_start, period_end, run_type, status, notes, created_at, created_by';
export const RUN_COLUMNS = Object.freeze({
  admin:
    `${RUN_BASE}, reopen_reason, approved_by, approved_at, approved_by_name, ` +
    'total_gross, total_deductions, total_net, employee_count',
  attendance: RUN_BASE,                       // no totals, no approval snapshot
});

// ── payroll_entries ───────────────────────────────────────────────────────────
export const ENTRY_COLUMNS = Object.freeze({
  admin:
    'id, run_id, employee_id, snapshot_name, snapshot_type, snapshot_day_rate, snapshot_salary, snapshot_sha, ' +
    'days_worked, overtime_hours, overtime_rate, overtime_amount, gross_pay, sha_deduction, advance_deduction, ' +
    'damage_deduction, other_deductions, total_deductions, net_pay, amount_paid, balance, payment_status, notes, created_at',
  // Attendance view: who, what type, how many days. No rates, pay, deductions or payment state.
  attendance: 'id, run_id, employee_id, snapshot_name, snapshot_type, days_worked, created_at',
});

/** Employee join on entries: identity only (day rate is admin-only here). */
export const ENTRY_EMPLOYEE_JOIN_ATTENDANCE = 'employees(name, employee_num, type)';
export const ENTRY_EMPLOYEE_JOIN_ADMIN = 'employees(name, employee_num, type, day_rate)';

export const runColumnsFor   = (role) => (canSeePayrollMoney(role) ? RUN_COLUMNS.admin   : RUN_COLUMNS.attendance);
export const entryColumnsFor = (role) => (canSeePayrollMoney(role) ? ENTRY_COLUMNS.admin : ENTRY_COLUMNS.attendance);
export const entryJoinFor    = (role) => (canSeePayrollMoney(role) ? ENTRY_EMPLOYEE_JOIN_ADMIN : ENTRY_EMPLOYEE_JOIN_ATTENDANCE);

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
  if (role === 'production_manager') return ['employees', 'runs'];
  if (role === 'head_of_sales') return ['employees'];
  return [];
}
