import test from 'node:test';
import assert from 'node:assert/strict';
import { combineOrderLabour, rollupOrderCosting } from '../orderCosting.js';

test('attendance wins per worker; payroll allocation for the same worker is superseded, not added', () => {
  const r = combineOrderLabour({
    entries: [{ employee_id: 'a', employee_name: 'Ann', actual_labour_cost: 2000 }, { employee_id: 'a', employee_name: 'Ann', actual_labour_cost: 2200 }],
    allocations: [{ employee_id: 'a', worker_name: 'Ann', allocated_amount: 5000 }, { employee_id: 'b', worker_name: 'Bob', allocated_amount: 1500 }],
  });
  assert.equal(r.attendance_total, 4200);
  assert.equal(r.payroll_fallback_total, 1500);       // Bob only
  assert.equal(r.superseded_payroll_total, 5000);     // Ann's allocation excluded
  assert.equal(r.actual, 5700);
  assert.equal(r.is_provisional, true);
});
test('no attendance and no allocations -> labour actual null (never 0, never planned)', () => {
  assert.equal(combineOrderLabour({}).actual, null);
});
test('approved entry without a cost is counted as missing, not as 0', () => {
  const r = combineOrderLabour({ entries: [{ employee_id: 'a', actual_labour_cost: null }] });
  assert.equal(r.approved_entries_missing_cost, 1);
  assert.equal(r.actual, null);
});
const job = (labPlanned, mat) => ({ categories: {
  materials: { planned: mat, actual: mat + 100, provisional: false }, labour: { planned: labPlanned },
  machine: { planned: 0, actual: 0 }, outsourced: { planned: 0, actual: 0 }, packaging: { planned: 50, actual: 40, provisional: true } } });
test('rollup: sums jobs, labour from order-level actual, planned labour never in actual', () => {
  const r = rollupOrderCosting({ jobSummaries: [job(3000, 1000), job(1000, 500)], labour: combineOrderLabour({}), delivery: { planned: null, actual: 300 }, revenueExVat: 20000 });
  assert.equal(r.rows.labour.planned, 4000);
  assert.equal(r.rows.labour.actual, null);
  assert.equal(r.total_actual, 1100 + 600 + 80 + 300);
  assert.equal(r.actual_is_incomplete, true);
  assert.equal(r.forecast_total, 1100 + 600 + 80 + 300 + 4000);
  assert.equal(r.gross_profit, 20000 - r.total_actual);
  assert.equal(r.actual_is_provisional, true);       // packaging estimate
});
test('rollup with attendance: complete, margin = GP / revenue ex VAT', () => {
  const lab = combineOrderLabour({ entries: [{ employee_id: 'a', actual_labour_cost: 4000 }] });
  const r = rollupOrderCosting({ jobSummaries: [job(4000, 1000)], labour: lab, revenueExVat: 10000 });
  assert.equal(r.actual_is_incomplete, false);
  assert.equal(r.total_actual, 1100 + 40 + 4000);
  assert.equal(r.gross_margin_pct, Math.round(((10000 - 5140) / 10000) * 1000) / 10);
});
