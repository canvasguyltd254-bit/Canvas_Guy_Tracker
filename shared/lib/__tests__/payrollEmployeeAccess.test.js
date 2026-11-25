import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYEE_COLUMNS, SENSITIVE_FIELDS, ADMIN_ONLY_FIELDS,
  employeeAccessLevel, canSeePrivateEmployeeData, writableEmployeeFields,
  partitionEmployeeWrite, employeeSearchFilter, canCreateEmployee, creatableTypes, partitionEmployeeCreate,
  serializeEmployee, canEditEmployeeRecord,
} from '../payroll/employeeAccess.js';

const cols = (s) => s.split(',').map(x => x.trim());
const ADMIN_ONLY = ['monthly_salary', 'sha_amount', 'nssf_number'];
const WORKER_DETAILS = ['day_rate', 'piece_rate', 'phone', 'id_number', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'hire_date', 'notes'];

test('access levels by role; shop floor and unknown roles get nothing', () => {
  assert.equal(employeeAccessLevel('admin'), 'private');
  assert.equal(employeeAccessLevel('production_manager'), 'manager');
  assert.equal(employeeAccessLevel('head_of_sales'), 'manager');
  for (const r of ['production_staff', 'sales', 'viewer', '', null, undefined]) {
    assert.equal(employeeAccessLevel(r), null, String(r));
  }
});

test('no select-star anywhere, and every column list is explicit', () => {
  for (const v of Object.values(EMPLOYEE_COLUMNS)) assert.ok(!v.includes('*'));
});

test('managers see worker pay details (phone, bank, rate) but never salary, SHA or NSSF', () => {
  const c = cols(EMPLOYEE_COLUMNS.manager);
  for (const f of WORKER_DETAILS) assert.ok(c.includes(f), f);
  for (const f of ADMIN_ONLY) assert.ok(!c.includes(f), `${f} must not reach a manager`);
});

test('admin sees every field', () => {
  const c = cols(EMPLOYEE_COLUMNS.private);
  for (const f of [...WORKER_DETAILS, ...ADMIN_ONLY]) assert.ok(c.includes(f), f);
});

test('permanent staff are reduced to identity + status for managers, untouched for admin', () => {
  const perm = { id: 1, employee_num: 'E1', name: 'P', type: 'permanent', is_active: true, phone: '07', bank_account: '9', day_rate: 1 };
  for (const r of ['production_manager', 'head_of_sales']) {
    assert.deepEqual(serializeEmployee(r, perm), { id: 1, employee_num: 'E1', name: 'P', type: 'permanent', is_active: true });
  }
  assert.deepEqual(serializeEmployee('admin', perm), perm);
  const casual = { ...perm, type: 'casual' };
  assert.deepEqual(serializeEmployee('head_of_sales', casual), casual);
});

test('SENSITIVE_FIELDS (admin-only writes) are exactly salary, SHA and NSSF', () => {
  assert.deepEqual([...SENSITIVE_FIELDS].sort(), [...ADMIN_ONLY].sort());
  assert.deepEqual([...ADMIN_ONLY_FIELDS].sort(), [...ADMIN_ONLY].sort());
});

test('admin, production manager and head of sales can add employees; nobody else', () => {
  for (const r of ['admin', 'production_manager', 'head_of_sales']) assert.equal(canCreateEmployee(r), true, r);
  for (const r of ['production_staff', 'sales', null, undefined]) assert.equal(canCreateEmployee(r), false, String(r));
});

test('only an admin may create permanent staff; others create day-paid types', () => {
  assert.deepEqual(creatableTypes('admin').sort(), ['casual', 'permanent', 'skilled_casual']);
  for (const r of ['production_manager', 'head_of_sales']) {
    assert.deepEqual(creatableTypes(r).sort(), ['casual', 'skilled_casual']);
  }
});

test('managers may write all worker details on create/edit; salary, SHA, NSSF refused', () => {
  for (const r of ['production_manager', 'head_of_sales']) {
    const w = writableEmployeeFields(r);
    for (const f of [...WORKER_DETAILS, 'name', 'is_active', 'type']) assert.ok(w.includes(f), `${r} ${f}`);
    for (const f of ADMIN_ONLY) assert.ok(!w.includes(f), `${r} must not write ${f}`);
    assert.deepEqual(partitionEmployeeCreate(r, { name: 'A', type: 'casual', phone: '07', bank_account: '1', day_rate: 900 }).forbidden, []);
    assert.deepEqual(partitionEmployeeCreate(r, { name: 'A', monthly_salary: 3, sha_amount: 1, nssf_number: 'x' }).forbidden.sort(), [...ADMIN_ONLY].sort());
  }
  assert.deepEqual(writableEmployeeFields('production_staff'), []);
  for (const f of ADMIN_ONLY) assert.ok(writableEmployeeFields('admin').includes(f), `admin ${f}`);
});

test('managers cannot edit permanent staff (except activate/deactivate) or make anyone permanent', () => {
  for (const r of ['production_manager', 'head_of_sales']) {
    assert.equal(canEditEmployeeRecord(r, { type: 'permanent' }, { is_active: false }).ok, true);
    assert.equal(canEditEmployeeRecord(r, { type: 'permanent' }, { phone: '07' }).ok, false);
    assert.equal(canEditEmployeeRecord(r, { type: 'permanent' }, { bank_account: '1' }).ok, false);
    assert.equal(canEditEmployeeRecord(r, { type: 'casual' }, { phone: '07', bank_account: '1' }).ok, true);
    assert.equal(canEditEmployeeRecord(r, { type: 'casual' }, { type: 'permanent' }).ok, false);
    assert.equal(canEditEmployeeRecord(r, { type: 'casual' }, { type: 'skilled_casual' }).ok, true);
  }
  assert.equal(canEditEmployeeRecord('admin', { type: 'permanent' }, { phone: '07' }).ok, true);
});

test('partition reports forbidden keys even when the value is empty', () => {
  const r = partitionEmployeeWrite('production_manager', { name: 'A', day_rate: 900, sha_amount: '', monthly_salary: 5, bogus: 1 });
  assert.deepEqual(r.allowed.sort(), ['day_rate', 'name']);
  assert.deepEqual(r.forbidden.sort(), ['monthly_salary', 'sha_amount']);
});

test('partition: admin may write everything, unknown keys ignored', () => {
  const r = partitionEmployeeWrite('admin', { name: 'A', phone: '07', id_number: '1', evil: 'x' });
  assert.deepEqual(r.forbidden, []);
  assert.deepEqual(r.allowed.sort(), ['id_number', 'name', 'phone']);
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
