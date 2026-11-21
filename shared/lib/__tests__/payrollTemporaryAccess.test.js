import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMP_ROLES, canUseTemporaryWorkers, canManageTemporarySettings, canVoidApprovedSettlement, canLinkAssignment,
  validateDeductionInput, validateReceiverName, mapTemporaryDbError, isUuid, isIsoDate, isFullName,
  ENGAGEMENT_COLUMNS, SETTLEMENT_COLUMNS, LINE_COLUMNS, DEDUCTION_COLUMNS, SHEET_COLUMNS, SETTINGS_COLUMNS,
  ENGAGEMENT_JOINS, SETTLEMENT_JOINS, OTHER_REASON_MIN_CHARS, overApprovalLimit, deductionNeedsAdmin,
} from '../payroll/temporaryAccess.js';

test('only admin, production manager and head of sales may use temporary workers', () => {
  assert.deepEqual([...TEMP_ROLES], ['admin', 'production_manager', 'head_of_sales']);
  for (const r of TEMP_ROLES) assert.equal(canUseTemporaryWorkers(r), true);
  for (const r of ['production_staff', 'sales', 'viewer', null, undefined]) assert.equal(canUseTemporaryWorkers(r), false);
});

test('settings and voiding approved settlements are admin-only; linking is admin or production manager', () => {
  assert.equal(canManageTemporarySettings('admin'), true);
  assert.equal(canManageTemporarySettings('head_of_sales'), false);
  assert.equal(canVoidApprovedSettlement('production_manager'), false);
  assert.equal(canLinkAssignment('production_manager'), true);
  assert.equal(canLinkAssignment('head_of_sales'), false);
});

test('column allow-lists are explicit and never carry private or storage fields', () => {
  for (const c of [ENGAGEMENT_COLUMNS, SETTLEMENT_COLUMNS, LINE_COLUMNS, DEDUCTION_COLUMNS, SHEET_COLUMNS, SETTINGS_COLUMNS, ENGAGEMENT_JOINS, SETTLEMENT_JOINS]) {
    assert.ok(!c.includes('*'), c);
    for (const banned of ['phone', 'bank', 'id_number', 'nssf', 'monthly_salary', 'evidence_path', 'signed_receipt_path']) {
      assert.ok(!c.includes(banned), `${banned} in ${c}`);
    }
  }
});

test('"other" deduction needs a reason of at least 20 characters, with a counter in the message', () => {
  const base = { type: 'other', amount: 100, ref: '' };
  assert.match(validateDeductionInput({ ...base, reason: 'misc' }), /at least 20 characters \(4\/20\)/);
  assert.equal(validateDeductionInput({ ...base, reason: 'x'.repeat(OTHER_REASON_MIN_CHARS) }), null);
  assert.equal(validateDeductionInput({ ...base, reason: '   ' + 'x'.repeat(19) + '   ' }) === null, false);   // trimmed before counting
});

test('references are required for advances, tools and damage', () => {
  assert.match(validateDeductionInput({ type: 'cash_advance', amount: 50, reason: 'Advance on Tuesday', ref: '' }), /Advance voucher/);
  assert.match(validateDeductionInput({ type: 'tools_or_materials', amount: 50, reason: 'Issued a router bit', ref: ' ' }), /Issue-slip/);
  assert.match(validateDeductionInput({ type: 'damage', amount: 50, reason: 'Broke a saw blade', ref: '' }), /Evidence reference/);
  assert.equal(validateDeductionInput({ type: 'cash_advance', amount: 50, reason: 'Advance on Tuesday', ref: 'ADV-1' }), null);
});

test('amount, type and reason are validated', () => {
  assert.match(validateDeductionInput({ type: 'paye', amount: 10, reason: 'tax', ref: 'x' }), /Choose a deduction type/);
  assert.match(validateDeductionInput({ type: 'cash_advance', amount: 0, reason: 'a reason', ref: 'x' }), /above 0/);
  assert.match(validateDeductionInput({ type: 'cash_advance', amount: 10, reason: ' ', ref: 'x' }), /reason is required/);
});

test('receiver must be a full name', () => {
  assert.equal(validateReceiverName('Jane Wanjiru'), null);
  assert.equal(validateReceiverName('  Jane   Wanjiru Kamau '), null);
  for (const v of ['Jane', '   ', '', null, undefined, 42]) assert.ok(validateReceiverName(v));
  assert.equal(isFullName('a b'), true);
});

test('uuid and date validators', () => {
  assert.equal(isUuid('9a43ae83-237c-45a4-8678-f868ec880b8b'), true);
  for (const v of ['x', '', null, 5, '9a43ae83-237c-45a4-8678']) assert.equal(isUuid(v), false);
  assert.equal(isIsoDate('2026-11-02'), true);
  for (const v of ['2026-13-40', '02/11/2026', '', null, '2026-02-30', '2026-04-31', '2025-02-29']) assert.equal(isIsoDate(v), false);
  assert.equal(isIsoDate('2028-02-29'), true);   // leap day
});

test('a missing migration names every migration to run, in order', () => {
  const m = mapTemporaryDbError({ code: '42883', message: 'function temporary_engagements_due does not exist' });
  assert.equal(m.status, 503);
  assert.equal(m.body.code, 'SETUP_INCOMPLETE');
  for (const f of ['temporary_workers_stage1,', 'temporary_workers_stage1b', 'temporary_workers_stage1c']) assert.ok(m.body.error.includes(f), f);
  assert.ok(m.body.error.indexOf('stage1b') < m.body.error.indexOf('stage1c'));
});

test('database errors map to safe responses', () => {
  assert.equal(mapTemporaryDbError({ code: 'P0001', message: 'Not allowed' }).status, 403);
  assert.equal(mapTemporaryDbError({ code: 'P0001', message: 'Settlement not found' }).status, 404);
  const ov = mapTemporaryDbError({ code: 'P0001', message: 'TEMP_ENGAGEMENT_OVERLAP: this worker is in payroll run PR-1 for an overlapping period' });
  assert.equal(ov.status, 422); assert.equal(ov.body.code, 'TEMP_ENGAGEMENT_OVERLAP'); assert.ok(!/TEMP_ENGAGEMENT_OVERLAP:/.test(ov.body.error));
  const reg = mapTemporaryDbError({ code: 'P0001', message: 'Worker not found or inactive. Ask an administrator to register this worker.' });
  assert.equal(reg.status, 422); assert.equal(reg.body.code, 'WORKER_NOT_REGISTERED');
  assert.equal(mapTemporaryDbError({ code: 'P0001', message: 'A paid settlement is final and cannot be voided' }).status, 422);
  const chk = mapTemporaryDbError({ code: '23514', message: 'new row violates check constraint "tws_status_fields"' });
  assert.equal(chk.status, 409); assert.ok(!/tws_status_fields/.test(JSON.stringify(chk.body)));
  assert.equal(mapTemporaryDbError({ code: '23505', message: 'duplicate key uq_twl_entry_active' }).status, 409);
  assert.equal(mapTemporaryDbError({ code: '40P01', message: 'deadlock' }).status, 409);
  const boom = mapTemporaryDbError({ code: '58000', message: 'secret internal detail' });
  assert.equal(boom.status, 500); assert.ok(!/secret/.test(JSON.stringify(boom.body)));
});

test('approval limit is fail-closed on the screen too', () => {
  assert.equal(overApprovalLimit({ admin_approval_limit_kes: 10000 }, 9999), false);
  assert.equal(overApprovalLimit({ admin_approval_limit_kes: 10000 }, 10000), false);
  assert.equal(overApprovalLimit({ admin_approval_limit_kes: 10000 }, 10000.01), true);
  assert.equal(overApprovalLimit({ admin_approval_limit_kes: null }, 1), true);
  assert.equal(overApprovalLimit(null, 1), true);
  assert.equal(overApprovalLimit(undefined, 1), true);
});

test('deduction admin rule: single over limit or total over share of gross', () => {
  const st = { deduction_single_limit_kes: 1000, deduction_total_pct: 25 };
  assert.equal(deductionNeedsAdmin(st, { amount: 1000 }, 1000, 9000), false);
  assert.equal(deductionNeedsAdmin(st, { amount: 1001 }, 1001, 9000), true);
  assert.equal(deductionNeedsAdmin(st, { amount: 800 }, 800, 3000), true);      // 800 > 750
  assert.equal(deductionNeedsAdmin(st, { amount: 700 }, 750, 3000), false);     // 750 is exactly 25%
  assert.equal(deductionNeedsAdmin(null, { amount: 1 }, 1, 1000), true);
});

test('a missing table or function is reported as an incomplete setup, not a generic failure', () => {
  for (const code of ['42P01', '42883', 'PGRST205', 'PGRST202', 'PGRST200']) {
    const m = mapTemporaryDbError({ code, message: 'relation "public.temporary_worker_engagements" does not exist' });
    assert.equal(m.status, 503); assert.equal(m.body.code, 'SETUP_INCOMPLETE');
    assert.match(m.body.error, /temporary_workers_stage1/);
    assert.ok(!/relation|public\./.test(m.body.error));
  }
});
