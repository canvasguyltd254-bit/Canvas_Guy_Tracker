import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkingDay, workingDaysBetween, computeConflicts, weeklyHours, conflictsCausedBy } from '../workerLoad.js';

const A = (o) => ({ status: 'Assigned', ...o });

describe('working days', () => {
  test('Sunday is non-working, Mon–Sat are working', () => {
    assert.equal(isWorkingDay('2026-10-11'), false);   // Sunday
    assert.equal(isWorkingDay('2026-10-10'), true);    // Saturday
    assert.deepEqual(workingDaysBetween('2026-10-09', '2026-10-12'), ['2026-10-09', '2026-10-10', '2026-10-12']);
  });
});

describe('computeConflicts', () => {
  const kevin = [
    A({ employee_id: 'k', job_id: 'j7', job_num: 'JOB-7', planned_start_date: '2026-10-05', planned_end_date: '2026-10-08', planned_hours_per_day: 6 }),
    A({ employee_id: 'k', job_id: 'j8', job_num: 'JOB-8', planned_start_date: '2026-10-07', planned_end_date: '2026-10-09', planned_hours_per_day: 6 }),
  ];
  test('reports employee, exact date, jobs, allocated and available hours', () => {
    const c = computeConflicts(kevin);
    assert.deepEqual(c.map((x) => x.date), ['2026-10-07', '2026-10-08']);
    assert.equal(c[0].allocated_hours, 12);
    assert.equal(c[0].available_hours, 8);
    assert.deepEqual(c[0].job_nums.sort(), ['JOB-7', 'JOB-8']);
  });
  test('exactly 8 hours is not a conflict', () => {
    const ok = [A({ employee_id: 'k', job_id: 'a', planned_start_date: '2026-10-05', planned_end_date: '2026-10-05', planned_hours_per_day: 4 }),
                A({ employee_id: 'k', job_id: 'b', planned_start_date: '2026-10-05', planned_end_date: '2026-10-05', planned_hours_per_day: 4 })];
    assert.equal(computeConflicts(ok).length, 0);
  });
  test('Sundays and removed or undated assignments are ignored', () => {
    const rows = [
      A({ employee_id: 'k', job_id: 'a', planned_start_date: '2026-10-11', planned_end_date: '2026-10-11', planned_hours_per_day: 12 }),
      A({ employee_id: 'k', job_id: 'b', planned_start_date: '2026-10-12', planned_end_date: '2026-10-12', planned_hours_per_day: 9, status: 'Removed' }),
      A({ employee_id: 'k', job_id: 'c', planned_start_date: null, planned_end_date: null, planned_hours_per_day: 9 }),
    ];
    assert.equal(computeConflicts(rows).length, 0);
  });
});

describe('weeklyHours / conflictsCausedBy', () => {
  test('weekly hours count Mon–Sat only', () => {
    const rows = [A({ employee_id: 'k', job_id: 'a', planned_start_date: '2026-10-05', planned_end_date: '2026-10-11', planned_hours_per_day: 4 })];
    assert.equal(weeklyHours(rows, 'k', '2026-10-05'), 24);   // 6 working days × 4 h
  });
  test('only conflicts introduced by the proposal are reported', () => {
    const existing = [A({ employee_id: 'k', job_id: 'a', job_num: 'A', planned_start_date: '2026-10-05', planned_end_date: '2026-10-06', planned_hours_per_day: 6 })];
    const proposed = [A({ employee_id: 'k', job_id: 'b', job_num: 'B', planned_start_date: '2026-10-06', planned_end_date: '2026-10-07', planned_hours_per_day: 4 })];
    const c = conflictsCausedBy(existing, proposed);
    assert.deepEqual(c.map((x) => x.date), ['2026-10-06']);
    assert.equal(c[0].allocated_hours, 10);
  });
});
