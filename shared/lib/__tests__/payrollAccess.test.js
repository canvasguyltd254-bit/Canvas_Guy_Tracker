import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_ATTENDANCE_ROLES, ADMIN_ONLY, RUN_COLUMNS, ENTRY_COLUMNS, MONEY_RUN_FIELDS, MONEY_ENTRY_FIELDS,
  canSeePayrollMoney, canAccessPayrollRuns, runColumnsFor, entryColumnsFor, entryJoinFor, payrollTabsFor,
} from '../payroll/payrollAccess.js';

const cols = (s) => s.split(',').map(x => x.trim());

test('money is admin-only; production manager may use runs; head of sales may not', () => {
  assert.equal(canSeePayrollMoney('admin'), true);
  for (const r of ['production_manager', 'head_of_sales', 'production_staff', 'sales', null, undefined]) {
    assert.equal(canSeePayrollMoney(r), false, String(r));
  }
  assert.equal(canAccessPayrollRuns('admin'), true);
  assert.equal(canAccessPayrollRuns('production_manager'), true);
  for (const r of ['head_of_sales', 'production_staff', 'sales', null]) assert.equal(canAccessPayrollRuns(r), false, String(r));
  assert.deepEqual([...RUN_ATTENDANCE_ROLES], ['admin', 'production_manager']);
  assert.deepEqual([...ADMIN_ONLY], ['admin']);
});

test('attendance entry columns contain NO money field (snapshot salary, gross, net, deductions, rates)', () => {
  const c = cols(ENTRY_COLUMNS.attendance);
  for (const f of MONEY_ENTRY_FIELDS) assert.ok(!c.includes(f), `${f} must not reach non-admin`);
  for (const f of ['snapshot_salary', 'gross_pay', 'net_pay', 'sha_deduction', 'total_deductions', 'amount_paid']) {
    assert.ok(MONEY_ENTRY_FIELDS.includes(f), `${f} is in the money list`);
  }
  assert.deepEqual(c, ['id', 'run_id', 'employee_id', 'snapshot_name', 'snapshot_type', 'days_worked', 'created_at']);
});

test('attendance run columns contain no totals or approval snapshot', () => {
  const c = cols(RUN_COLUMNS.attendance);
  for (const f of MONEY_RUN_FIELDS) assert.ok(!c.includes(f), f);
  for (const f of ['run_num', 'period_start', 'period_end', 'run_type', 'status']) assert.ok(c.includes(f), f);
});

test('admin columns include every money field; nothing is select-star', () => {
  const e = cols(ENTRY_COLUMNS.admin), r = cols(RUN_COLUMNS.admin);
  for (const f of MONEY_ENTRY_FIELDS) assert.ok(e.includes(f), f);
  // total_outstanding is computed by the runs list for admin, not a table column
  for (const f of MONEY_RUN_FIELDS.filter(f => f !== 'total_outstanding')) assert.ok(r.includes(f), f);
  for (const v of [...Object.values(ENTRY_COLUMNS), ...Object.values(RUN_COLUMNS)]) assert.ok(!v.includes('*'));
});

test('role helpers pick the right lists; non-admin never gets the admin list', () => {
  assert.equal(entryColumnsFor('admin'), ENTRY_COLUMNS.admin);
  assert.equal(runColumnsFor('admin'), RUN_COLUMNS.admin);
  for (const r of ['production_manager', 'head_of_sales', undefined, null]) {
    assert.equal(entryColumnsFor(r), ENTRY_COLUMNS.attendance, String(r));
    assert.equal(runColumnsFor(r), RUN_COLUMNS.attendance, String(r));
    assert.ok(!/phone|salary|day_rate|bank|nssf/.test(entryJoinFor(r)), String(r));
  }
  assert.match(entryJoinFor('admin'), /day_rate/);
  assert.doesNotMatch(entryJoinFor('admin'), /phone|salary/);
});

test('screens per role: admin all, production manager employees + runs, head of sales employees only', () => {
  assert.deepEqual(payrollTabsFor('admin'), ['overview', 'employees', 'runs', 'payments', 'compliance', 'reports']);
  assert.deepEqual(payrollTabsFor('production_manager'), ['employees', 'runs']);
  assert.deepEqual(payrollTabsFor('head_of_sales'), ['employees']);
  for (const r of ['production_staff', 'sales', null, undefined]) assert.deepEqual(payrollTabsFor(r), []);
});
