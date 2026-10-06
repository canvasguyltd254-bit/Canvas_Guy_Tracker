/**
 * shared/lib/production/stageSchedule.js
 *
 * Pure helpers for stage scheduling. Dates are 'YYYY-MM-DD' (UTC, no timezone
 * drift). Working days are Mon–Sat; Sunday is non-working (same rule as
 * workerLoad.js). Nothing here touches the database.
 *
 * Stage keys are the DATABASE keys: materials, assembly, sanding, finishing,
 * packaging. (QC is a gate with no stage row, so it is not scheduled.)
 */

import { isWorkingDay } from './workerLoad.js';

export const STAGE_ORDER = ['materials', 'assembly', 'sanding', 'finishing', 'packaging'];

const DAY = 86400000;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Today's date in the workshop's timezone (Nairobi, UTC+3) as YYYY-MM-DD — not the UTC date,
 *  which is still "yesterday" between 00:00 and 03:00 local time. */
export function todayInNairobi(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const t = toUtc(s);
  return !Number.isNaN(t) && fromUtc(t) === s;
}

/** Signed count of working days from a to b (b later => positive). Sundays skipped. */
export function workingDayDelta(a, b) {
  if (a === b) return 0;
  const sign = toUtc(b) > toUtc(a) ? 1 : -1;
  let n = 0;
  for (let t = toUtc(a); fromUtc(t) !== b; t += sign * DAY) {
    const next = t + sign * DAY;
    if (isWorkingDay(fromUtc(next))) n += sign;
  }
  return n;
}

/** Move a working date by n working days (n may be negative). Sundays skipped. */
export function shiftWorkingDays(iso, n) {
  let t = toUtc(iso);
  const sign = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    t += sign * DAY;
    if (isWorkingDay(fromUtc(t))) left -= 1;
  }
  return fromUtc(t);
}

/** Number of working days in [start, end] inclusive. */
export function workingSpan(start, end) {
  let n = 0;
  for (let t = toUtc(start); t <= toUtc(end); t += DAY) if (isWorkingDay(fromUtc(t))) n += 1;
  return n;
}

/**
 * Validate one stage's proposed dates. Returns an error string or null.
 */
export function validateStageDates(start, end) {
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return 'Dates must be valid YYYY-MM-DD';
  if (toUtc(end) < toUtc(start)) return 'End date must be on or after start date';
  if (!isWorkingDay(start) || !isWorkingDay(end)) return 'Start and end must be working days (not Sunday)';
  return null;
}

/**
 * Work out what moving one stage does to the stages after it.
 *
 * @param {Array<{id,stage_key,sort_order,status,schedule:{start,end}|null}>} stages  all ENABLED stages of the job
 * @param {string} stageId        the stage being moved
 * @param {{start:string,end:string}} next  its proposed dates
 * @returns {{
 *   error?: string,
 *   moved: {stage_id,start,end},
 *   delta_working_days: number,      // change in the moved stage's END, in working days
 *   downstream: Array<{stage_id, stage_key, start, end, shifted_start, shifted_end, locked:boolean, overlaps:boolean}>,
 *   needs_choice: boolean            // true when at least one movable downstream schedule would be affected
 * }}
 *
 * `locked` = stage already completed/skipped: it is never shifted.
 * `overlaps` = the downstream stage would START before the moved stage's new
 *   END if left where it is (the "keep" choice leaves this visible, not hidden).
 * A choice is needed when the end moved (delta != 0) OR a kept downstream stage
 * would overlap — i.e. whenever silently doing nothing could hide a problem.
 */
export function computeDateImpact(stages, stageId, next) {
  const sorted = [...(stages || [])].sort((a, b) => a.sort_order - b.sort_order);
  const idx = sorted.findIndex((s) => s.id === stageId);
  if (idx < 0) return { error: 'Stage not found for this job' };
  const cur = sorted[idx];
  const bad = validateStageDates(next.start, next.end);
  if (bad) return { error: bad };
  if (cur.status === 'completed' || cur.status === 'skipped') {
    return { error: `Stage is already ${cur.status} and cannot be rescheduled` };
  }

  const delta = cur.schedule ? workingDayDelta(cur.schedule.end, next.end) : 0;
  const downstream = [];
  for (const s of sorted.slice(idx + 1)) {
    if (!s.schedule) continue;
    const locked = s.status === 'completed' || s.status === 'skipped';
    downstream.push({
      stage_id: s.id,
      stage_key: s.stage_key,
      start: s.schedule.start,
      end: s.schedule.end,
      shifted_start: locked || delta === 0 ? s.schedule.start : shiftWorkingDays(s.schedule.start, delta),
      shifted_end:   locked || delta === 0 ? s.schedule.end   : shiftWorkingDays(s.schedule.end, delta),
      locked,
      overlaps: !locked && toUtc(s.schedule.start) < toUtc(next.end),
    });
  }
  const movable = downstream.filter((d) => !d.locked);
  return {
    moved: { stage_id: stageId, start: next.start, end: next.end },
    delta_working_days: delta,
    downstream,
    needs_choice: movable.length > 0 && (delta !== 0 || movable.some((d) => d.overlaps)),
  };
}

/**
 * Turn an impact + the user's explicit choice into the final change list.
 * @param {object} impact  result of computeDateImpact (no error)
 * @param {'shift'|'keep'|'review'} choice
 * @param {Array<{stage_id,start,end}>} [overrides]  required for 'review'
 * @returns {{error?:string, changes?:Array<{stage_id,start,end}>}}
 */
export function resolveChoice(impact, choice, overrides) {
  const changes = [{ stage_id: impact.moved.stage_id, start: impact.moved.start, end: impact.moved.end }];
  const movable = impact.downstream.filter((d) => !d.locked);

  if (choice === 'keep') return { changes };
  if (choice === 'shift') {
    for (const d of movable) changes.push({ stage_id: d.stage_id, start: d.shifted_start, end: d.shifted_end });
    return { changes };
  }
  if (choice === 'review') {
    if (!Array.isArray(overrides) || overrides.length === 0) {
      return { error: 'Review choice requires explicit dates for each downstream stage' };
    }
    const allowed = new Map(movable.map((d) => [d.stage_id, d]));
    const seen = new Set();
    for (const o of overrides) {
      if (!allowed.has(o.stage_id)) return { error: 'Override refers to a stage that is not a movable downstream stage' };
      if (seen.has(o.stage_id)) return { error: 'Duplicate stage in overrides' };
      seen.add(o.stage_id);
      const bad = validateStageDates(o.start, o.end);
      if (bad) return { error: bad };
      changes.push({ stage_id: o.stage_id, start: o.start, end: o.end });
    }
    // Every movable stage must be explicitly answered — no silent leftovers.
    if (seen.size !== allowed.size) return { error: 'Review choice must give dates for every downstream stage' };
    return { changes };
  }
  return { error: 'Unknown downstream choice' };
}

/**
 * Advisory warnings for a final schedule (never blocking).
 * @param {Array<{stage_key,sort_order,start,end}>} finalStages  every scheduled stage after the change
 * @param {{production_due_date?:string|null, customer_due_date?:string|null}} due
 */
export function scheduleWarnings(finalStages, due = {}) {
  const w = [];
  const sorted = [...finalStages].sort((a, b) => a.sort_order - b.sort_order);
  for (let i = 1; i < sorted.length; i++) {
    if (toUtc(sorted[i].start) < toUtc(sorted[i - 1].end)) {
      w.push({ code: 'stage_overlap', stage_key: sorted[i].stage_key,
        message: `${sorted[i].stage_key} starts before ${sorted[i - 1].stage_key} ends` });
    }
  }
  const lastEnd = sorted.length ? sorted.reduce((m, s) => (toUtc(s.end) > toUtc(m) ? s.end : m), sorted[0].end) : null;
  if (lastEnd && due.production_due_date && toUtc(lastEnd) > toUtc(due.production_due_date)) {
    w.push({ code: 'after_production_due', message: `Schedule finishes ${lastEnd}, after production due ${due.production_due_date}` });
  }
  if (due.production_due_date && due.customer_due_date && toUtc(due.production_due_date) > toUtc(due.customer_due_date)) {
    w.push({ code: 'production_due_after_customer', message: `Production due ${due.production_due_date} is after customer delivery ${due.customer_due_date}` });
  }
  if (lastEnd && due.customer_due_date && toUtc(lastEnd) > toUtc(due.customer_due_date)) {
    w.push({ code: 'after_customer_due', message: `Schedule finishes ${lastEnd}, after customer delivery ${due.customer_due_date}` });
  }
  return w;
}

/**
 * Where should a worker's assignment dates go when their stage is rescheduled?
 *   • assignment covered the whole old stage  → it now covers the whole new stage
 *   • otherwise → shifted by the stage START's working-day change, then clamped
 *     into the new stage dates (so it never sticks out of the stage)
 *   • stage had no schedule before → only clamped if it falls outside
 * Returns { start, end } when the dates should change, otherwise null.
 */
export function assignmentDatesAfterStageMove(assignment, oldStage, newStage) {
  const a = { start: assignment.planned_start_date, end: assignment.planned_end_date };
  if (!a.start || !a.end) return null;
  let start = a.start;
  let end = a.end;
  if (oldStage && oldStage.start && oldStage.end) {
    if (a.start === oldStage.start && a.end === oldStage.end) {
      start = newStage.start; end = newStage.end;
    } else {
      const d = workingDayDelta(oldStage.start, newStage.start);
      start = shiftWorkingDays(a.start, d);
      end = shiftWorkingDays(a.end, d);
    }
  }
  if (toUtc(start) < toUtc(newStage.start)) start = newStage.start;
  if (toUtc(end) > toUtc(newStage.end)) end = newStage.end;
  if (toUtc(end) < toUtc(start)) end = start;
  if (!isWorkingDay(start)) start = shiftWorkingDays(start, 1);
  if (!isWorkingDay(end)) end = shiftWorkingDays(end, -1);
  if (toUtc(end) < toUtc(start)) end = start;
  return start === a.start && end === a.end ? null : { start, end };
}
