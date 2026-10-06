/**
 * shared/lib/production/workerLoad.js
 *
 * Pure, advisory worker-capacity helpers. Rule (confirmed): 8 hours per day,
 * Monday–Saturday; Sundays are non-working. Assignments carry
 * planned_hours_per_day; a worker's load on a day is the sum over every active
 * assignment covering that day. Nothing here is stored — it is recomputed.
 *
 * Dates are 'YYYY-MM-DD' strings, handled in UTC so there is no timezone drift.
 */

export const CAPACITY_HOURS_PER_DAY = 8;

const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;

export function isWorkingDay(iso) {
  return new Date(toUtc(iso)).getUTCDay() !== 0;   // 0 = Sunday
}

export function workingDaysBetween(startIso, endIso) {
  const out = [];
  for (let t = toUtc(startIso); t <= toUtc(endIso); t += DAY) {
    const d = fromUtc(t);
    if (isWorkingDay(d)) out.push(d);
  }
  return out;
}

function usable(a) {
  return a && a.status !== 'Removed' && a.planned_start_date && a.planned_end_date
    && Number(a.planned_hours_per_day) > 0;
}

/**
 * Every (employee, day) where the allocated hours exceed capacity.
 * @param {Array<{employee_id,job_id,job_num?,planned_start_date,planned_end_date,planned_hours_per_day,status?}>} assignments
 * @returns {Array<{employee_id,date,job_ids,job_nums,allocated_hours,available_hours}>}
 */
export function computeConflicts(assignments, capacity = CAPACITY_HOURS_PER_DAY) {
  const byEmpDay = new Map();
  for (const a of (assignments || []).filter(usable)) {
    for (const day of workingDaysBetween(a.planned_start_date, a.planned_end_date)) {
      const key = `${a.employee_id}|${day}`;
      if (!byEmpDay.has(key)) byEmpDay.set(key, { employee_id: a.employee_id, date: day, hours: 0, jobs: new Map() });
      const e = byEmpDay.get(key);
      e.hours += Number(a.planned_hours_per_day);
      e.jobs.set(a.job_id, a.job_num || a.job_id);
    }
  }
  return [...byEmpDay.values()]
    .filter((e) => e.hours > capacity + 1e-9)
    .map((e) => ({
      employee_id: e.employee_id,
      date: e.date,
      job_ids: [...e.jobs.keys()],
      job_nums: [...e.jobs.values()],
      allocated_hours: e.hours,
      available_hours: capacity,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.employee_id.localeCompare(b.employee_id));
}

/** Hours allocated to one employee over Mon–Sat of the week starting `weekStartIso` (a Monday). */
export function weeklyHours(assignments, employeeId, weekStartIso) {
  const weekDays = new Set(workingDaysBetween(weekStartIso, fromUtc(toUtc(weekStartIso) + 5 * DAY)));
  let h = 0;
  for (const a of (assignments || []).filter(usable)) {
    if (a.employee_id !== employeeId) continue;
    for (const day of workingDaysBetween(a.planned_start_date, a.planned_end_date)) {
      if (weekDays.has(day)) h += Number(a.planned_hours_per_day);
    }
  }
  return h;
}

/**
 * Conflicts that exist ONLY because of the proposed assignment (i.e. new
 * conflicts or conflicts it makes worse), so the modal can warn precisely.
 */
export function conflictsCausedBy(existing, proposed, capacity = CAPACITY_HOURS_PER_DAY) {
  const before = new Map(computeConflicts(existing, capacity).map((c) => [`${c.employee_id}|${c.date}`, c.allocated_hours]));
  return computeConflicts([...(existing || []), ...(proposed || [])], capacity)
    .filter((c) => {
      const prev = before.get(`${c.employee_id}|${c.date}`);
      return prev == null || c.allocated_hours > prev + 1e-9;
    })
    .filter((c) => (proposed || []).some((p) => p.employee_id === c.employee_id));
}
