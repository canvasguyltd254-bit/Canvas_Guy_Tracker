/**
 * shared/lib/production/labourCosting.js
 *
 * Pure helpers for job labour costing. No I/O. All money is computed from rows the
 * SERVER loaded; nothing here trusts a browser-supplied total.
 *
 * Pay model (attendance, NOT hours — no overtime hours, no multiplier):
 *   weekday:           units x daily rate
 *   weekday + OT:      units x daily rate + units x overtime allowance (flat, KES 200)
 *   Sunday:            units x Sunday rate (flat, KES 1,000) — replaces the daily rate, no OT on top
 * `units` is the share of a worker's day booked to the job (1 = a full day), so a day
 * split across jobs splits the allowance proportionally.
 *
 * Authoritative-source rules (no double counting):
 *   • Internal labour PLAN: worker assignments (rate snapshots) when any assignment
 *     has a planned cost; otherwise the BoQ "internal_labour" lines. If both exist,
 *     the BoQ lines are reported as `superseded_boq` and NOT added.
 *   • Internal labour ACTUAL: approved time entries only.
 *   • Other categories: BoQ estimates, with actuals from issued qty x unit cost
 *     where a manager recorded them; otherwise the estimate stands in and the
 *     category is flagged provisional.
 * A missing rate is reported as a count, never as 0.
 */

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** Roles that may see wage rates and labour cost. Production staff never do. */
export const LABOUR_COST_ROLES = ['admin', 'production_manager'];
export const canSeeLabourCost = (role) => LABOUR_COST_ROLES.includes(role);

/** Mon–Sat working days between two ISO dates inclusive. */
export function workingDaysInclusive(start, end) {
  if (!start || !end || end < start) return 0;
  let n = 0;
  const t0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const t1 = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  for (let t = t0; t <= t1; t += 86400000) if (new Date(t).getUTCDay() !== 0) n++;
  return n;
}

export function isSundayIso(iso) {
  return !!iso && new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay() === 0;
}

/** "Scheduled duration: 2 days → suggested 2 attendance days". The manager can override it. */
export function suggestedAttendanceUnits(start, end) {
  return workingDaysInclusive(start, end);
}

/**
 * Cost of one booking. Returns null when the rate needed is missing (never 0).
 *   Sunday  : units x sundayRate
 *   Weekday : units x daily  (+ units x otAllowance when the day carries overtime)
 */
export function labourCost(units, hasOvertime, isSunday, daily, otAllowance, sundayRate) {
  const u = Number(units);
  if (!(u > 0)) return null;
  if (isSunday) return sundayRate == null ? null : r2(u * Number(sundayRate));
  if (daily == null) return null;
  return r2(u * Number(daily) + (hasOvertime ? u * Number(otAllowance || 0) : 0));
}

/** Planned cost of an assignment: weekday days, overtime days (flat allowance each) and Sunday days. */
export function plannedLabourCost({ units, overtimeDays, sundayUnits }, { daily, otAllowance, sundayRate }) {
  const u = Number(units || 0), o = Number(overtimeDays || 0), su = Number(sundayUnits || 0);
  if (u === 0 && o === 0 && su === 0) return null;
  if (u > 0 && daily == null) return null;
  if (su > 0 && sundayRate == null) return null;
  return r2(u * Number(daily || 0) + o * Number(otAllowance || 0) + su * Number(sundayRate || 0));
}

const CATEGORY_OF = {
  material: 'materials', consumable: 'materials',
  packaging: 'packaging', machine_time: 'machine',
  outsourced_service: 'outsourced', internal_labour: 'boq_labour',
};
export const COST_CATEGORIES = ['materials', 'labour', 'machine', 'outsourced', 'packaging'];

const lineActual = (l) =>
  l.issued_quantity != null && l.actual_unit_cost != null ? r2(Number(l.issued_quantity) * Number(l.actual_unit_cost)) : null;

/**
 * @param {object} p
 *   assignments: [{ id, stage_id, employee_id, employee_name, planned_attendance_units, planned_overtime_days,
 *                   planned_sunday_units, daily_rate_snapshot, planned_labour_cost }]   (active only)
 *   entries:     [{ id, stage_id, assignment_id, status, attendance_units, has_overtime, is_sunday, actual_labour_cost }]
 *   lines:       [{ boq_line_type, estimated_total_cost, issued_quantity, actual_unit_cost }]
 *   stages:      [{ id, stage_label, sort_order }]
 *   selling_value: number | null   (ex-VAT, this job's share)
 */
export function summariseJobCosting({ assignments = [], entries = [], lines = [], stages = [], selling_value = null }) {
  const cat = Object.fromEntries(COST_CATEGORIES.map((c) => [c, { planned: 0, actual: 0, provisional: false, lines: 0 }]));
  let boqLabourPlanned = 0, boqLabourLines = 0;

  for (const l of lines) {
    const c = CATEGORY_OF[l.boq_line_type] || 'materials';
    const planned = Number(l.estimated_total_cost || 0);
    if (c === 'boq_labour') { boqLabourPlanned += planned; boqLabourLines++; continue; }
    const a = lineActual(l);
    cat[c].planned += planned; cat[c].lines++;
    if (a == null) { cat[c].actual += planned; cat[c].provisional = true; } else cat[c].actual += a;
  }

  // ── Labour ────────────────────────────────────────────────────────────────
  const costed = assignments.filter((a) => a.planned_labour_cost != null);
  // "Rate missing": weekday days are planned but no cost could be calculated (no daily rate).
  const planned_missing_rate = assignments.filter((a) => Number(a.planned_attendance_units || 0) > 0 && a.planned_labour_cost == null).length;
  const planned_unplanned = assignments.filter((a) => a.planned_attendance_units == null && a.planned_overtime_days == null && a.planned_sunday_units == null).length;
  const asgPlanned = r2(costed.reduce((s, a) => s + Number(a.planned_labour_cost), 0));
  const useAssignments = costed.length > 0;
  const approved = entries.filter((e) => e.status === 'approved');
  const pending = entries.filter((e) => e.status === 'draft' || e.status === 'submitted');
  const actualLabour = r2(approved.reduce((s, e) => s + Number(e.actual_labour_cost || 0), 0));
  const labour = {
    planned: useAssignments ? asgPlanned : r2(boqLabourPlanned),
    planned_source: useAssignments ? 'assignments' : (boqLabourLines ? 'boq' : 'none'),
    superseded_boq: useAssignments && boqLabourLines ? r2(boqLabourPlanned) : null,
    assignments_missing_rate: planned_missing_rate,
    assignments_without_plan: planned_unplanned,
    actual: approved.length ? actualLabour : null,
    actual_units: {
      weekday: r2(approved.filter((e) => !e.is_sunday).reduce((s, e) => s + Number(e.attendance_units), 0)),
      sunday: r2(approved.filter((e) => e.is_sunday).reduce((s, e) => s + Number(e.attendance_units), 0)),
      overtime: r2(approved.filter((e) => e.has_overtime).reduce((s, e) => s + Number(e.attendance_units), 0)),
    },
    pending_entries: pending.length,
    pending_units: r2(pending.reduce((s, e) => s + Number(e.attendance_units), 0)),
    approved_entries_missing_cost: approved.filter((e) => e.actual_labour_cost == null).length,
  };

  // ── Stage drill-down (labour) ─────────────────────────────────────────────
  const byStage = stages.map((s) => {
    const a = assignments.filter((x) => x.stage_id === s.id && x.planned_labour_cost != null);
    const e = approved.filter((x) => x.stage_id === s.id);
    return {
      stage_id: s.id, stage_label: s.stage_label, sort_order: s.sort_order,
      planned: r2(a.reduce((t, x) => t + Number(x.planned_labour_cost), 0)),
      actual: e.length ? r2(e.reduce((t, x) => t + Number(x.actual_labour_cost || 0), 0)) : null,
    };
  }).filter((s) => s.planned > 0 || s.actual != null);

  // ── Totals ────────────────────────────────────────────────────────────────
  const categories = {
    materials: { ...cat.materials, planned: r2(cat.materials.planned), actual: r2(cat.materials.actual) },
    labour,
    machine: { ...cat.machine, planned: r2(cat.machine.planned), actual: r2(cat.machine.actual) },
    outsourced: { ...cat.outsourced, planned: r2(cat.outsourced.planned), actual: r2(cat.outsourced.actual) },
    packaging: { ...cat.packaging, planned: r2(cat.packaging.planned), actual: r2(cat.packaging.actual) },
  };
  const totalPlanned = r2(COST_CATEGORIES.reduce((s, c) => s + categories[c].planned, 0));
  // Actual total: RECORDED actuals only. Planned labour is never substituted into an actual total.
  // Materials/machine/etc. may carry a labelled provisional estimate (provisional flag). Labour with no
  // approved attendance contributes 0 to actual and flags the total incomplete.
  // The forecast total (actual where known, else plan) is reported separately and is always provisional.
  let totalActual = 0, totalForecast = 0, provisional = false, incomplete = false;
  for (const c of COST_CATEGORIES) {
    const x = categories[c];
    if (c === 'labour') {
      if (x.actual == null) { if (x.planned > 0) incomplete = true; totalForecast += x.planned; }
      else { totalActual += x.actual; totalForecast += x.actual; }
    } else { totalActual += x.actual; totalForecast += x.actual; if (x.provisional) provisional = true; }
  }
  totalActual = r2(totalActual); totalForecast = r2(totalForecast);
  const hasSelling = selling_value != null && Number.isFinite(Number(selling_value));
  const gp = hasSelling ? r2(Number(selling_value) - totalActual) : null;
  return {
    categories, stages: byStage,
    total_planned: totalPlanned, total_actual: totalActual, variance: r2(totalActual - totalPlanned),
    actual_is_provisional: provisional,
    actual_is_incomplete: incomplete,          // labour planned but no approved attendance yet
    forecast_total: totalForecast,             // provisional: plan stands in where actual is missing
    selling_value: hasSelling ? r2(selling_value) : null,
    gross_profit: gp,
    gross_margin_pct: hasSelling && Number(selling_value) > 0 ? Math.round((gp / Number(selling_value)) * 1000) / 10 : null,
    forecast_gross_profit: hasSelling ? r2(Number(selling_value) - totalForecast) : null,
    forecast_margin_pct: hasSelling && Number(selling_value) > 0 ? Math.round(((Number(selling_value) - totalForecast) / Number(selling_value)) * 1000) / 10 : null,
  };
}

/** Strip every money figure (wages, material and other costs, margin) for callers who may not see them. */
export function redactLabourCost(summary) {
  const { labour } = summary.categories;
  return {
    categories: { labour: {
      planned_source: labour.planned_source, assignments_missing_rate: labour.assignments_missing_rate,
      assignments_without_plan: labour.assignments_without_plan, actual_units: labour.actual_units,
      pending_entries: labour.pending_entries, pending_units: labour.pending_units,
    } },
    stages: [], total_planned: null, total_actual: null, variance: null, actual_is_provisional: null,
    actual_is_incomplete: null, forecast_total: null, forecast_gross_profit: null, forecast_margin_pct: null,
    selling_value: null, gross_profit: null, gross_margin_pct: null,
  };
}
