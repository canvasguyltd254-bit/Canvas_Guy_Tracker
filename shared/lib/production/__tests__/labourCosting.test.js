import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseJobCosting, suggestedAttendanceUnits, workingDaysInclusive, labourCost, plannedLabourCost, isSundayIso, canSeeLabourCost, redactLabourCost } from '../labourCosting.js';

const stages = [{ id: 's1', stage_label: 'Assembly', sort_order: 2 }, { id: 's2', stage_label: 'Sanding', sort_order: 3 }];
const asg = (o) => ({ id: Math.random(), stage_id: 's1', planned_attendance_units: 2, planned_overtime_days: 0, planned_sunday_units: 0, daily_rate_snapshot: 2000, planned_labour_cost: 4000, ...o });
const entry = (o) => ({ id: Math.random(), stage_id: 's1', status: 'approved', attendance_units: 1, has_overtime: false, is_sunday: false, actual_labour_cost: 2000, ...o });

test('working days skip Sunday; suggestion = Mon–Sat days in range', () => {
  assert.equal(workingDaysInclusive('2026-10-10', '2026-10-12'), 2);
  assert.equal(suggestedAttendanceUnits('2026-10-07', '2026-10-08'), 2);
  assert.equal(suggestedAttendanceUnits('2026-10-08', '2026-10-07'), 0);
  assert.equal(isSundayIso('2026-10-11'), true);
  assert.equal(isSundayIso('2026-10-10'), false);
});

test('normal weekday: units x daily rate', () => {
  assert.equal(labourCost(1, false, false, 2000, 200, 1000), 2000);
  assert.equal(labourCost(0.5, false, false, 2000, 200, 1000), 1000);
});
test('weekday with overtime: + units x KES 200, once per day (not per hour)', () => {
  assert.equal(labourCost(1, true, false, 2000, 200, 1000), 2200);
});
test('Sunday: units x 1,000 REPLACES the daily rate and never adds the 200', () => {
  assert.equal(labourCost(1, false, true, 2000, 200, 1000), 1000);
  assert.equal(labourCost(1, true, true, 2000, 200, 1000), 1000);          // overtime flag is ignored on Sunday
  assert.equal(labourCost(1, false, true, null, 200, 1000), 1000);         // no daily rate needed on Sunday
});
test('split day is allocated proportionally (60/40): overtime 120/80, Sunday 600/400', () => {
  assert.equal(labourCost(0.6, true, false, 0, 200, 1000), 120);           // allowance share (daily rate zero here to isolate it)
  assert.equal(labourCost(0.4, true, false, 0, 200, 1000), 80);
  assert.equal(labourCost(0.6, false, true, 2000, 200, 1000), 600);
  assert.equal(labourCost(0.4, false, true, 2000, 200, 1000), 400);
  // and the two shares add back up to the full-day figure
  assert.equal(labourCost(0.6, true, false, 2000, 200, 1000) + labourCost(0.4, true, false, 2000, 200, 1000), 2200);
});
test('missing weekday rate -> null (never 0); invalid units -> null', () => {
  assert.equal(labourCost(1, false, false, null, 200, 1000), null);
  assert.equal(labourCost(0, false, false, 2000, 200, 1000), null);
});
test('plannedLabourCost: days x daily + overtime days x 200 + Sunday days x 1,000', () => {
  const rates = { daily: 2000, otAllowance: 200, sundayRate: 1000 };
  assert.equal(plannedLabourCost({ units: 3, overtimeDays: 1, sundayUnits: 1 }, rates), 6000 + 200 + 1000);
  assert.equal(plannedLabourCost({ units: 0, overtimeDays: 0, sundayUnits: 0 }, rates), null);
  assert.equal(plannedLabourCost({ units: 2 }, { ...rates, daily: null }), null);
  assert.equal(plannedLabourCost({ sundayUnits: 1 }, { ...rates, daily: null }), 1000);
});
test('roles: only admin and production_manager see wages', () => {
  assert.equal(canSeeLabourCost('admin'), true);
  assert.equal(canSeeLabourCost('production_manager'), true);
  for (const r of ['production_staff', 'head_of_sales', 'viewer', undefined]) assert.equal(canSeeLabourCost(r), false);
});
test('plan from assignments supersedes BoQ internal_labour lines (no double count)', () => {
  const s = summariseJobCosting({ stages, assignments: [asg(), asg({ stage_id: 's2', planned_labour_cost: 1760 })],
    lines: [{ boq_line_type: 'internal_labour', estimated_total_cost: 9000 }, { boq_line_type: 'material', estimated_total_cost: 24500 }] });
  assert.equal(s.categories.labour.planned, 5760);
  assert.equal(s.categories.labour.planned_source, 'assignments');
  assert.equal(s.categories.labour.superseded_boq, 9000);
  assert.equal(s.total_planned, 24500 + 5760);
});
test('with no assignment costs the BoQ labour estimate is used and labelled', () => {
  const s = summariseJobCosting({ stages, assignments: [], lines: [{ boq_line_type: 'internal_labour', estimated_total_cost: 9000 }] });
  assert.equal(s.categories.labour.planned, 9000);
  assert.equal(s.categories.labour.planned_source, 'boq');
  assert.equal(s.categories.labour.superseded_boq, null);
});
test('missing rates are counted, not costed as 0', () => {
  const s = summariseJobCosting({ stages, assignments: [asg(), asg({ daily_rate_snapshot: null, planned_labour_cost: null })] });
  assert.equal(s.categories.labour.planned, 4000);
  assert.equal(s.categories.labour.assignments_missing_rate, 1);
});
test('actual labour = approved entries only; units reported by kind; pending counted separately', () => {
  const s = summariseJobCosting({ stages, assignments: [asg()], entries: [
    entry({ actual_labour_cost: 2200, has_overtime: true }), entry({ actual_labour_cost: 1000, is_sunday: true }),
    entry({ status: 'submitted' }), entry({ status: 'draft' }), entry({ status: 'rejected', actual_labour_cost: 9999 }), entry({ status: 'voided', actual_labour_cost: 9999 }),
  ] });
  assert.equal(s.categories.labour.actual, 3200);
  assert.deepEqual(s.categories.labour.actual_units, { weekday: 1, sunday: 1, overtime: 1 });
  assert.equal(s.categories.labour.pending_entries, 2);
  assert.equal(s.stages.find((x) => x.stage_id === 's1').actual, 3200);
});
test('no approved entries -> actual labour null; planned is NEVER added to the actual total', () => {
  const s = summariseJobCosting({ stages, assignments: [asg()], entries: [], selling_value: 10000 });
  assert.equal(s.categories.labour.actual, null);
  assert.equal(s.total_actual, 0);
  assert.equal(s.actual_is_incomplete, true);
  assert.equal(s.forecast_total, 4000);           // forecast is separate and provisional
  assert.equal(s.forecast_gross_profit, 6000);
  assert.equal(s.forecast_margin_pct, 60);
});
test('approved labour present -> actual complete, forecast equals actual', () => {
  const s = summariseJobCosting({ stages, assignments: [asg()], entries: [entry({ actual_labour_cost: 3000 })] });
  assert.equal(s.actual_is_incomplete, false);
  assert.equal(s.total_actual, 3000);
  assert.equal(s.forecast_total, 3000);
});
test('material actuals use issued x unit cost; estimate stands in (provisional) otherwise', () => {
  const s = summariseJobCosting({ stages, lines: [
    { boq_line_type: 'material', estimated_total_cost: 1000, issued_quantity: 12, actual_unit_cost: 100 },
    { boq_line_type: 'consumable', estimated_total_cost: 200, issued_quantity: null, actual_unit_cost: null },
  ] });
  assert.equal(s.categories.materials.planned, 1200);
  assert.equal(s.categories.materials.actual, 1400);
  assert.equal(s.categories.materials.provisional, true);
});
test('variance, gross profit and margin from selling value', () => {
  const s = summariseJobCosting({ stages, assignments: [asg()], entries: [entry({ actual_labour_cost: 5000 })], selling_value: 20000,
    lines: [{ boq_line_type: 'material', estimated_total_cost: 6000, issued_quantity: 1, actual_unit_cost: 6500 }] });
  assert.equal(s.total_planned, 10000);
  assert.equal(s.total_actual, 11500);
  assert.equal(s.variance, 1500);
  assert.equal(s.gross_profit, 8500);
  assert.equal(s.gross_margin_pct, 42.5);
});
test('redaction removes every money figure', () => {
  const s = redactLabourCost(summariseJobCosting({ stages, assignments: [asg()], selling_value: 9999 }));
  const json = JSON.stringify(s);
  assert.equal(s.total_planned, null);
  assert.equal(s.categories.labour.planned, undefined);
  assert.ok(!json.includes('4000') && !json.includes('9999'));
});
test('no overtime hours or multiplier exist in the cost helpers', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../labourCosting.js', import.meta.url), 'utf8'));
  assert.ok(!/overtime_hours|overtimeHours|multiplier|hourly/i.test(src.replace(/NO overtime hours[^\n]*/g, '').replace(/no overtime hours[^\n]*/gi, '')));
});
