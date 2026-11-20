import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_ROLES, ADMIN_ONLY, RUN_COLUMNS, ENTRY_COLUMNS, MONEY_RUN_FIELDS, MONEY_ENTRY_FIELDS,
  canSeePayrollMoney, canAccessPayrollRuns, runColumnsFor, entryColumnsFor, entryJoinFor, payrollTabsFor,
} from '../payroll/payrollAccess.js';

const cols = (s) => s.split(',').map(x => x.trim());

test('run roles are admin, production manager and head of sales; nobody else', () => {
  assert.deepEqual([...RUN_ROLES], ['admin', 'production_manager', 'head_of_sales']);
  for (const r of RUN_ROLES) {
    assert.equal(canAccessPayrollRuns(r), true, r);
    assert.equal(canSeePayrollMoney(r), true, r);
  }
  for (const r of ['production_staff', 'sales', 'viewer', '', null, undefined]) {
    assert.equal(canAccessPayrollRuns(r), false, String(r));
    assert.equal(canSeePayrollMoney(r), false, String(r));
  }
  assert.deepEqual([...ADMIN_ONLY], ['admin']);
});

test('run roles get the full run and entry columns, including sums', () => {
  for (const r of RUN_ROLES) {
    assert.equal(runColumnsFor(r), RUN_COLUMNS.full, r);
    assert.equal(entryColumnsFor(r), ENTRY_COLUMNS.full, r);
  }
  const run = cols(RUN_COLUMNS.full), entry = cols(ENTRY_COLUMNS.full);
  for (const f of ['total_gross', 'total_deductions', 'total_net', 'employee_count']) assert.ok(run.includes(f), f);
  for (const f of ['gross_pay', 'net_pay', 'total_deductions', 'amount_paid']) assert.ok(entry.includes(f), f);
  for (const f of MONEY_ENTRY_FIELDS) assert.ok(entry.includes(f), f);
  // total_outstanding is computed by the runs list, not a table column
  for (const f of MONEY_RUN_FIELDS.filter(f => f !== 'total_outstanding')) assert.ok(run.includes(f), f);
});

test('roles without run access can only ever get the minimal, money-free shape', () => {
  for (const r of ['production_staff', 'sales', null, undefined]) {
    assert.equal(runColumnsFor(r), RUN_COLUMNS.minimal, String(r));
    assert.equal(entryColumnsFor(r), ENTRY_COLUMNS.minimal, String(r));
    assert.ok(!/phone|salary|day_rate|bank|nssf/.test(entryJoinFor(r)), String(r));
  }
  for (const f of MONEY_ENTRY_FIELDS) assert.ok(!cols(ENTRY_COLUMNS.minimal).includes(f), f);
  for (const f of MONEY_RUN_FIELDS) assert.ok(!cols(RUN_COLUMNS.minimal).includes(f), f);
});

test('nothing is select-star and the join never carries phone or monthly salary', () => {
  for (const v of [...Object.values(ENTRY_COLUMNS), ...Object.values(RUN_COLUMNS)]) assert.ok(!v.includes('*'));
  for (const r of ['admin', 'production_manager', 'head_of_sales', null]) {
    assert.doesNotMatch(entryJoinFor(r), /phone|salary|bank|nssf|id_number/);
  }
});

test('screens per role: admin all; production manager and head of sales Employees + Payroll Runs', () => {
  assert.deepEqual(payrollTabsFor('admin'), ['overview', 'employees', 'runs', 'payments', 'compliance', 'reports']);
  assert.deepEqual(payrollTabsFor('production_manager'), ['employees', 'runs']);
  assert.deepEqual(payrollTabsFor('head_of_sales'), ['employees', 'runs']);
  for (const r of ['production_staff', 'sales', null, undefined]) assert.deepEqual(payrollTabsFor(r), []);
});
