import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYEE_COLUMNS, SENSITIVE_FIELDS, ADMIN_ONLY_FIELDS,
  employeeAccessLevel, canSeePrivateEmployeeData, writableEmployeeFields,
  partitionEmployeeWrite, employeeSearchFilter, canCreateEmployee,
} from '../payroll/employeeAccess.js';

const cols = (s) => s.split(',').map(x => x.trim());
const PRIVATE_ONLY = ['monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number', 'id_number', 'phone',
  'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'hire_date', 'notes'];

test('access levels by role; shop floor and unknown roles get nothing', () => {
  assert.equal(employeeAccessLevel('admin'), 'private');
  assert.equal(employeeAccessLevel('production_manager'), 'operational');
  assert.equal(employeeAccessLevel('head_of_sales'), 'basic');
  for (const r of ['production_staff', 'sales', 'viewer', '', null, undefined]) {
    assert.equal(employeeAccessLevel(r), null, String(r));
  }
});

test('no select-star anywhere, and every column list is explicit', () => {
  for (const v of Object.values(EMPLOYEE_COLUMNS)) assert.ok(!v.includes('*'));
});

test('head of sales: identity and status only', () => {
  const c = cols(EMPLOYEE_COLUMNS.basic);
  assert.deepEqual(c, ['id', 'employee_num', 'name', 'type', 'is_active']);
  for (const f of ['day_rate', ...PRIVATE_ONLY]) assert.ok(!c.includes(f), f);
});

test('production manager: identity, status and day rate; nothing private', () => {
  const c = cols(EMPLOYEE_COLUMNS.operational);
  assert.ok(c.includes('day_rate'));
  for (const f of PRIVATE_ONLY) assert.ok(!c.includes(f), `${f} must not reach production manager`);
});

test('admin sees every private field', () => {
  const c = cols(EMPLOYEE_COLUMNS.private);
  for (const f of [...PRIVATE_ONLY, 'day_rate']) assert.ok(c.includes(f), f);
});

test('SENSITIVE_FIELDS matches the private-only list exactly', () => {
  assert.deepEqual([...SENSITIVE_FIELDS].sort(), [...PRIVATE_ONLY].sort());
});

test('employee creation is admin-only', () => {
  assert.equal(canCreateEmployee('admin'), true);
  for (const r of ['production_manager', 'head_of_sales', 'production_staff', null, undefined]) {
    assert.equal(canCreateEmployee(r), false, String(r));
  }
});

test('employee type (pay basis) is admin-only to change', () => {
  assert.ok(ADMIN_ONLY_FIELDS.includes('type'));
  assert.ok(writableEmployeeFields('admin').includes('type'));
  assert.ok(!writableEmployeeFields('production_manager').includes('type'));
  assert.ok(!writableEmployeeFields('head_of_sales').includes('type'));
  assert.deepEqual(partitionEmployeeWrite('production_manager', { type: 'permanent' }).forbidden, ['type']);
});

test('writes: sensitive fields are admin only', () => {
  for (const f of SENSITIVE_FIELDS) {
    assert.ok(writableEmployeeFields('admin').includes(f), `admin ${f}`);
    assert.ok(!writableEmployeeFields('production_manager').includes(f), `pm ${f}`);
    assert.ok(!writableEmployeeFields('head_of_sales').includes(f), `hos ${f}`);
  }
  assert.ok(writableEmployeeFields('production_manager').includes('day_rate'));
  assert.ok(!writableEmployeeFields('head_of_sales').includes('day_rate'));
  assert.deepEqual(writableEmployeeFields('production_staff'), []);
});

test('partition reports forbidden keys even when the value is empty', () => {
  const r = partitionEmployeeWrite('production_manager', { name: 'A', day_rate: 900, phone: '', bank_account: '123', bogus: 1 });
  assert.deepEqual(r.allowed.sort(), ['day_rate', 'name']);
  assert.deepEqual(r.forbidden.sort(), ['bank_account', 'phone']);
});

test('partition: admin may write everything, unknown keys ignored', () => {
  const r = partitionEmployeeWrite('admin', { name: 'A', phone: '07', id_number: '1', evil: 'x' });
  assert.deepEqual(r.forbidden, []);
  assert.deepEqual(r.allowed.sort(), ['id_number', 'name', 'phone']);
  assert.deepEqual(partitionEmployeeWrite('admin', { type: 'permanent' }).allowed, ['type']);
});

test('partition: head of sales may only change name and status', () => {
  const r = partitionEmployeeWrite('head_of_sales', { is_active: false, day_rate: 1 });
  assert.deepEqual(r.allowed, ['is_active']);
  assert.deepEqual(r.forbidden, ['day_rate']);
});

test('search: phone matching is admin only', () => {
  assert.match(employeeSearchFilter('admin', 'john'), /phone\.ilike/);
  assert.doesNotMatch(employeeSearchFilter('production_manager', 'john'), /phone/);
  assert.doesNotMatch(employeeSearchFilter('head_of_sales', 'john'), /phone/);
});

test('search: filter syntax in the term cannot add its own filters', () => {
  const f = employeeSearchFilter('production_manager', 'x,bank_account.ilike.%1%),(id_number.eq.5');
  const clauses = f.split(',');
  assert.equal(clauses.length, 2);                // only name + employee_num: no injected clause
  assert.match(clauses[0], /^name\.ilike\.%[^,()*\\"]*%$/);
  assert.match(clauses[1], /^employee_num\.ilike\.%[^,()*\\"]*%$/);
  assert.ok(!/[()]/.test(f));
  assert.equal(employeeSearchFilter('admin', '   '), null);
  assert.equal(employeeSearchFilter('admin', undefined), null);
  const long = employeeSearchFilter('admin', 'a'.repeat(500));
  assert.ok(long.includes('a'.repeat(60)) && !long.includes('a'.repeat(61)), 'search term capped at 60 chars');
});

test('canSeePrivateEmployeeData is admin only', () => {
  assert.equal(canSeePrivateEmployeeData('admin'), true);
  for (const r of ['production_manager', 'head_of_sales', 'production_staff', null]) assert.equal(canSeePrivateEmployeeData(r), false);
});
