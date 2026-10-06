/**
 * shared/lib/production/orderCosting.js — pure order-level production costing.
 *
 * One authoritative source per cost (no double counting):
 *   materials  : issued qty × unit cost; the BoQ estimate only while no actual exists  (provisional)
 *   labour     : APPROVED attendance allocations. For a worker with approved attendance on this order, any
 *                payroll order-allocation for the same worker is superseded and NOT added. A payroll
 *                allocation is used only for workers with no attendance on the order, and is labelled provisional.
 *                Planned labour is never substituted into an actual.
 *   machine / outsourced / packaging : recorded actual, else estimate (provisional)
 * Payroll runs are never added wholesale — only order allocations reach an order.
 */
import { COST_CATEGORIES } from './labourCosting.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** entries: approved time entries [{employee_id, employee_name, actual_labour_cost}]; allocations: payroll [{employee_id, worker_name, allocated_amount}] */
export function combineOrderLabour({ entries = [], allocations = [] } = {}) {
  const byEmp = new Map();
  let missingCost = 0;
  for (const e of entries) {
    if (e.actual_labour_cost == null) { missingCost++; continue; }
    const k = e.employee_id;
    const row = byEmp.get(k) || { employee_id: k, employee_name: e.employee_name ?? null, amount: 0, entries: 0 };
    row.amount += Number(e.actual_labour_cost); row.entries++;
    byEmp.set(k, row);
  }
  const attendance = [...byEmp.values()].map((r) => ({ ...r, amount: r2(r.amount), source: 'attendance' }));
  const have = new Set(attendance.map((r) => r.employee_id));
  const payroll = [], superseded = [];
  for (const a of allocations) {
    const amt = Number(a.allocated_amount || 0);
    if (a.employee_id && have.has(a.employee_id)) superseded.push({ employee_id: a.employee_id, worker_name: a.worker_name ?? null, amount: r2(amt) });
    else payroll.push({ employee_id: a.employee_id ?? null, employee_name: a.worker_name ?? null, amount: r2(amt), source: 'payroll_allocation', provisional: true });
  }
  const attendanceTotal = r2(attendance.reduce((s, r) => s + r.amount, 0));
  const payrollTotal = r2(payroll.reduce((s, r) => s + r.amount, 0));
  const any = attendance.length > 0 || payroll.length > 0;
  return {
    rows: [...attendance, ...payroll], superseded_payroll: superseded,
    superseded_payroll_total: r2(superseded.reduce((s, r) => s + r.amount, 0)),
    attendance_total: attendanceTotal, payroll_fallback_total: payrollTotal,
    actual: any ? r2(attendanceTotal + payrollTotal) : null,
    is_provisional: payroll.length > 0, approved_entries_missing_cost: missingCost,
  };
}

/**
 * jobSummaries: outputs of summariseJobCosting (unredacted). revenueExVat: order revenue excluding VAT.
 * delivery: { planned: number|null, actual: number } from attributable direct expenses.
 */
export function rollupOrderCosting({ jobSummaries = [], labour, delivery = { planned: null, actual: 0 }, revenueExVat = null }) {
  const cats = {};
  for (const c of COST_CATEGORIES) cats[c] = { planned: 0, actual: 0, provisional: false };
  for (const j of jobSummaries) {
    for (const c of COST_CATEGORIES) {
      const x = j.categories[c]; if (!x) continue;
      cats[c].planned += Number(x.planned || 0);
      if (c !== 'labour') { cats[c].actual += Number(x.actual || 0); if (x.provisional) cats[c].provisional = true; }
    }
  }
  cats.labour.actual = labour?.actual ?? null;
  cats.labour.provisional = !!labour?.is_provisional;
  const deliveryRow = { planned: delivery.planned == null ? null : r2(delivery.planned), actual: r2(delivery.actual || 0), provisional: false };
  const rows = { ...Object.fromEntries(COST_CATEGORIES.map((c) => [c, { ...cats[c], planned: r2(cats[c].planned), actual: cats[c].actual == null ? null : r2(cats[c].actual) }])), delivery: deliveryRow };
  const keys = [...COST_CATEGORIES, 'delivery'];
  const totalPlanned = r2(keys.reduce((s, k) => s + Number(rows[k].planned || 0), 0));
  const totalActual = r2(keys.reduce((s, k) => s + Number(rows[k].actual || 0), 0));   // labour null counts 0 — never planned
  const incomplete = rows.labour.actual == null && rows.labour.planned > 0;
  const forecast = r2(keys.reduce((s, k) => s + Number(rows[k].actual ?? rows[k].planned ?? 0), 0));
  const rev = revenueExVat != null && Number.isFinite(Number(revenueExVat)) ? r2(revenueExVat) : null;
  const gp = rev == null ? null : r2(rev - totalActual);
  const fgp = rev == null ? null : r2(rev - forecast);
  const pct = (v) => (rev != null && rev > 0 && v != null ? Math.round((v / rev) * 1000) / 10 : null);
  return {
    rows, total_planned: totalPlanned, total_actual: totalActual, variance: r2(totalActual - totalPlanned),
    actual_is_incomplete: incomplete,
    actual_is_provisional: keys.some((k) => rows[k].provisional),
    revenue_ex_vat: rev, gross_profit: gp, gross_margin_pct: pct(gp),
    forecast_total: forecast, forecast_gross_profit: fgp, forecast_margin_pct: pct(fgp),
  };
}
