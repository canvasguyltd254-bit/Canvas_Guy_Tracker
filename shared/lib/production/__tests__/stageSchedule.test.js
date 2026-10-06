import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  workingDayDelta, shiftWorkingDays, workingSpan, validateStageDates,
  computeDateImpact, resolveChoice, scheduleWarnings, isValidIsoDate,
} from '../stageSchedule.js';

// 2026-10-05 is a Monday; 2026-10-10 Saturday; 2026-10-11 Sunday.
const stages = () => [
  { id: 'm', stage_key: 'materials', sort_order: 1, status: 'completed', schedule: { start: '2026-10-05', end: '2026-10-06' } },
  { id: 'a', stage_key: 'assembly',  sort_order: 2, status: 'active',    schedule: { start: '2026-10-07', end: '2026-10-09' } },
  { id: 's', stage_key: 'sanding',   sort_order: 3, status: 'not_started', schedule: { start: '2026-10-10', end: '2026-10-12' } },
  { id: 'f', stage_key: 'finishing', sort_order: 4, status: 'not_started', schedule: { start: '2026-10-13', end: '2026-10-14' } },
  { id: 'p', stage_key: 'packaging', sort_order: 5, status: 'not_started', schedule: null },
];

test('shiftWorkingDays skips Sundays both directions', () => {
  assert.equal(shiftWorkingDays('2026-10-10', 1), '2026-10-12'); // Sat -> Mon
  assert.equal(shiftWorkingDays('2026-10-12', -1), '2026-10-10');
  assert.equal(shiftWorkingDays('2026-10-05', 0), '2026-10-05');
});

test('workingDayDelta is the inverse of shift', () => {
  assert.equal(workingDayDelta('2026-10-09', '2026-10-12'), 2);
  assert.equal(workingDayDelta('2026-10-12', '2026-10-09'), -2);
  assert.equal(workingDayDelta('2026-10-09', '2026-10-09'), 0);
});

test('workingSpan excludes Sunday', () => {
  assert.equal(workingSpan('2026-10-10', '2026-10-12'), 2);
});

test('validateStageDates rejects Sunday, reversed and bad dates', () => {
  assert.match(validateStageDates('2026-10-11', '2026-10-12'), /Sunday/);
  assert.match(validateStageDates('2026-10-09', '2026-10-08'), /on or after/);
  assert.match(validateStageDates('2026-02-30', '2026-03-01'), /valid/);
  assert.equal(validateStageDates('2026-10-05', '2026-10-05'), null);
  assert.equal(isValidIsoDate('2026-13-01'), false);
});

test('impact: extending assembly 2 working days flags downstream and needs choice', () => {
  const imp = computeDateImpact(stages(), 'a', { start: '2026-10-07', end: '2026-10-12' });
  assert.equal(imp.error, undefined);
  assert.equal(imp.delta_working_days, 2);
  assert.equal(imp.needs_choice, true);
  assert.deepEqual(imp.downstream.map((d) => d.stage_key), ['sanding', 'finishing']);
  const s = imp.downstream[0];
  assert.equal(s.shifted_start, '2026-10-13'); // Sat +2wd = Tue
  assert.equal(s.overlaps, true);              // sanding starts Sat 10-10 < new end 10-12
});

test('impact: unscheduled stage has no downstream impact and no choice needed', () => {
  const st = stages(); st[1].schedule = null;
  const imp = computeDateImpact(st, 'a', { start: '2026-10-07', end: '2026-10-09' });
  assert.equal(imp.delta_working_days, 0);
  assert.equal(imp.needs_choice, false);
});

test('impact: no change and no overlap => no choice', () => {
  const imp = computeDateImpact(stages(), 'a', { start: '2026-10-07', end: '2026-10-09' });
  assert.equal(imp.needs_choice, false);
});

test('impact: completed stage cannot be moved; completed downstream is locked', () => {
  assert.match(computeDateImpact(stages(), 'm', { start: '2026-10-05', end: '2026-10-07' }).error, /completed/);
  const st = stages(); st[3].status = 'completed';
  const imp = computeDateImpact(st, 'a', { start: '2026-10-07', end: '2026-10-12' });
  const f = imp.downstream.find((d) => d.stage_id === 'f');
  assert.equal(f.locked, true);
  assert.equal(f.shifted_start, f.start);
});

test('resolveChoice shift moves only unlocked downstream by the delta', () => {
  const imp = computeDateImpact(stages(), 'a', { start: '2026-10-07', end: '2026-10-12' });
  const r = resolveChoice(imp, 'shift');
  assert.deepEqual(r.changes.map((c) => c.stage_id), ['a', 's', 'f']);
  assert.deepEqual(r.changes[2], { stage_id: 'f', start: '2026-10-15', end: '2026-10-16' });
});

test('resolveChoice keep changes only the moved stage', () => {
  const imp = computeDateImpact(stages(), 'a', { start: '2026-10-07', end: '2026-10-12' });
  assert.deepEqual(resolveChoice(imp, 'keep').changes.map((c) => c.stage_id), ['a']);
});

test('resolveChoice review needs every downstream stage and valid dates', () => {
  const imp = computeDateImpact(stages(), 'a', { start: '2026-10-07', end: '2026-10-12' });
  assert.match(resolveChoice(imp, 'review', []).error, /explicit/);
  assert.match(resolveChoice(imp, 'review', [{ stage_id: 's', start: '2026-10-13', end: '2026-10-14' }]).error, /every downstream/);
  assert.match(resolveChoice(imp, 'review', [
    { stage_id: 'x', start: '2026-10-13', end: '2026-10-14' },
  ]).error, /not a movable/);
  assert.match(resolveChoice(imp, 'review', [
    { stage_id: 's', start: '2026-10-11', end: '2026-10-14' },
    { stage_id: 'f', start: '2026-10-15', end: '2026-10-16' },
  ]).error, /Sunday/);
  const ok = resolveChoice(imp, 'review', [
    { stage_id: 's', start: '2026-10-13', end: '2026-10-14' },
    { stage_id: 'f', start: '2026-10-15', end: '2026-10-16' },
  ]);
  assert.equal(ok.changes.length, 3);
  assert.match(resolveChoice(imp, 'bogus').error, /Unknown/);
});

test('scheduleWarnings: overlap, after production due, production after customer', () => {
  const w = scheduleWarnings(
    [
      { stage_key: 'assembly', sort_order: 2, start: '2026-10-07', end: '2026-10-12' },
      { stage_key: 'sanding',  sort_order: 3, start: '2026-10-10', end: '2026-10-14' },
    ],
    { production_due_date: '2026-10-13', customer_due_date: '2026-10-12' },
  );
  const codes = w.map((x) => x.code).sort();
  assert.deepEqual(codes, ['after_customer_due', 'after_production_due', 'production_due_after_customer', 'stage_overlap']);
  assert.deepEqual(scheduleWarnings([], {}), []);
});

import { todayInNairobi } from '../stageSchedule.js';
test('todayInNairobi uses Nairobi (UTC+3), not UTC, around midnight', () => {
  assert.equal(todayInNairobi(new Date('2026-10-05T22:30:00Z')), '2026-10-06'); // 01:30 EAT next day
  assert.equal(todayInNairobi(new Date('2026-10-05T20:59:00Z')), '2026-10-05'); // 23:59 EAT
});

import { assignmentDatesAfterStageMove } from '../stageSchedule.js';
test('assignment covering the whole stage follows the stage', () => {
  const r = assignmentDatesAfterStageMove({ planned_start_date: '2026-10-07', planned_end_date: '2026-10-09' },
    { start: '2026-10-07', end: '2026-10-09' }, { start: '2026-10-12', end: '2026-10-15' });
  assert.deepEqual(r, { start: '2026-10-12', end: '2026-10-15' });
});
test('partial assignment shifts by the start change and is clamped into the new stage', () => {
  const r = assignmentDatesAfterStageMove({ planned_start_date: '2026-10-08', planned_end_date: '2026-10-09' },
    { start: '2026-10-07', end: '2026-10-09' }, { start: '2026-10-12', end: '2026-10-13' });
  assert.deepEqual(r, { start: '2026-10-13', end: '2026-10-13' });
});
test('unchanged or undated assignments return null; no old schedule only clamps', () => {
  assert.equal(assignmentDatesAfterStageMove({ planned_start_date: '2026-10-07', planned_end_date: '2026-10-08' }, { start: '2026-10-07', end: '2026-10-08' }, { start: '2026-10-07', end: '2026-10-08' }), null);
  assert.equal(assignmentDatesAfterStageMove({ planned_start_date: null, planned_end_date: null }, null, { start: '2026-10-07', end: '2026-10-08' }), null);
  assert.deepEqual(assignmentDatesAfterStageMove({ planned_start_date: '2026-10-01', planned_end_date: '2026-10-20' }, null, { start: '2026-10-07', end: '2026-10-09' }), { start: '2026-10-07', end: '2026-10-09' });
});
