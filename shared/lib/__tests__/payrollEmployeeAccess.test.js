import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYEE_COLUMNS, REQUESTABLE_FIELDS, PAYMENT_FIELDS,
  employeeAccessLevel, canSeeEmployeeProfile, canSeeEmployeeDocuments, canDecideEmployeeChange,
  canCreateEmployee, splitEmployeeUpdate, diffEmployeeChanges, normaliseEmployeeValue, employeeSearchFilter,
} from '../payroll/employeeAccess.js';

const cols = (s) => s.split(',').map(x => x.trim());

test('pay fields accept zero but reject negatives, non-finite values, coercions and sub-cent amounts', () => {
  for (const key of ['day_rate', 'monthly_salary', 'piece_rate', 'sha_amount']) {
    assert.equal(normaliseEmployeeValue(key, '0'), 0);
    for (const bad of [-1, Infinity, NaN, true, [], '1e3', 1.001, 100000000]) {
      assert.ok(Number.isNaN(normaliseEmployeeValue(key, bad)), `${key}: ${bad}`);
    }
  }
});

test('admin and both managers see the full profile; shop floor and unknown roles get nothing', () => {
  for (const r of ['admin', 'production_manager', 'head_of_sales']) {
    assert.equal(employeeAccessLevel(r), 'full', r);
    assert.equal(canSeeEmployeeProfile(r), true, r);
  }
  for (const r of ['production_staff', 'sales', 'viewer', '', null, undefined]) {
    assert.equal(employeeAccessLevel(r), null, String(r));
    assert.equal(canSeeEmployeeProfile(r), false, String(r));
  }
});

test('column list is explicit (no select-star) and carries phone, bank, rate, salary, SHA, NSSF', () => {
  assert.ok(!EMPLOYEE_COLUMNS.full.includes('*'));
  const c = cols(EMPLOYEE_COLUMNS.full);
  for (const f of ['phone', 'bank_account', 'paybill_number', 'day_rate', 'monthly_salary', 'sha_amount', 'nssf_number']) assert.ok(c.includes(f), f);
});

test('employee documents and change decisions are admin-only', () => {
  assert.equal(canSeeEmployeeDocuments('admin'), true);
  assert.equal(canDecideEmployeeChange('admin'), true);
  for (const r of ['production_manager', 'head_of_sales', 'production_staff', null]) {
    assert.equal(canSeeEmployeeDocuments(r), false, String(r));
    assert.equal(canDecideEmployeeChange(r), false, String(r));
  }
});

test('admin, production manager and head of sales can add employees; nobody else', () => {
  for (const r of ['admin', 'production_manager', 'head_of_sales']) assert.equal(canCreateEmployee(r), true, r);
  for (const r of ['production_staff', 'sales', null, undefined]) assert.equal(canCreateEmployee(r), false, String(r));
});

test('updates: admin applies directly; managers apply only is_active, everything else is a request', () => {
  const body = { name: 'A', phone: '07', day_rate: 1, is_active: false, reason: 'x', bogus: 1 };
  assert.deepEqual(splitEmployeeUpdate('admin', body).requested, []);
  assert.deepEqual(splitEmployeeUpdate('admin', body).direct.sort(), ['day_rate', 'is_active', 'name', 'phone']);
  for (const r of ['production_manager', 'head_of_sales']) {
    const s = splitEmployeeUpdate(r, body);
    assert.deepEqual(s.direct, ['is_active']);
    assert.deepEqual(s.requested.sort(), ['day_rate', 'name', 'phone']);
  }
  assert.deepEqual(splitEmployeeUpdate('production_staff', body), { direct: [], requested: [] });
});

test('every requestable field is covered and is_active is not requestable', () => {
  assert.ok(!REQUESTABLE_FIELDS.includes('is_active'));
  for (const f of ['name', 'type', 'day_rate', 'monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number', 'phone',
    'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'id_number', 'hire_date', 'notes']) {
    assert.ok(REQUESTABLE_FIELDS.includes(f), f);
  }
  for (const f of ['phone', 'bank_account', 'paybill_number', 'day_rate', 'sha_amount', 'nssf_number']) assert.ok(PAYMENT_FIELDS.includes(f), f);
});

test('normalise: blank → null, numeric fields → numbers, junk → NaN, text trimmed', () => {
  assert.equal(normaliseEmployeeValue('phone', ''), null);
  assert.equal(normaliseEmployeeValue('phone', ' 0712 '), '0712');
  assert.equal(normaliseEmployeeValue('day_rate', '1200'), 1200);
  assert.equal(normaliseEmployeeValue('day_rate', '1000.00'), 1000);
  assert.equal(normaliseEmployeeValue('sha_amount', 0), 0);
  assert.ok(Number.isNaN(normaliseEmployeeValue('day_rate', 'abc')));
});

test('diff: only real changes are returned, with old and new; unchanged and blank≡null are ignored', () => {
  const cur = { name: 'Jane', day_rate: '1000.00', phone: '0712345678', bank_account: null, sha_amount: 0 };
  const { changes, invalid } = diffEmployeeChanges(cur,
    { name: 'Jane', day_rate: 1200, phone: '0799', bank_account: '', sha_amount: '0' },
    ['name', 'day_rate', 'phone', 'bank_account', 'sha_amount']);
  assert.deepEqual(changes, { day_rate: { old: 1000, new: 1200 }, phone: { old: '0712345678', new: '0799' } });
  assert.deepEqual(invalid, []);
});

test('diff: invalid numbers and an emptied name are reported, not queued', () => {
  const { changes, invalid } = diffEmployeeChanges({ name: 'Jane', day_rate: 1000 }, { name: ' ', day_rate: 'abc' }, ['name', 'day_rate']);
  assert.deepEqual(changes, {});
  assert.deepEqual(invalid.sort(), ['day_rate', 'name']);
});

test('search: phone matching for everyone who can see the profile, not for others', () => {
  for (const r of ['admin', 'production_manager', 'head_of_sales']) assert.match(employeeSearchFilter(r, 'john'), /phone\.ilike/, r);
  assert.doesNotMatch(employeeSearchFilter('production_staff', 'john'), /phone/);
});

test('search: filter syntax in the term cannot add its own filters', () => {
  const f = employeeSearchFilter('production_manager', 'x,bank_account.ilike.%1%),(id_number.eq.5');
  const clauses = f.split(',');
  assert.equal(clauses.length, 3);                // name + employee_num + phone only: no injected clause
  assert.match(clauses[0], /^name\.ilike\.%[^,()*\\"]*%$/);
  assert.match(clauses[1], /^employee_num\.ilike\.%[^,()*\\"]*%$/);
  assert.match(clauses[2], /^phone\.ilike\.%[^,()*\\"]*%$/);
  assert.ok(!/[()]/.test(f));
  assert.equal(employeeSearchFilter('admin', '   '), null);
  assert.equal(employeeSearchFilter('admin', undefined), null);
  const long = employeeSearchFilter('admin', 'a'.repeat(500));
  assert.ok(long.includes('a'.repeat(60)) && !long.includes('a'.repeat(61)), 'search term capped at 60 chars');
});
