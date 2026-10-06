/**
 * POST /api/production/labour/preview
 * body { workers:[{employee_id, planned_attendance_units?, planned_overtime_days?, planned_sunday_units?}], start?, end? }
 *
 * Read-only. Returns, per worker, whether a daily rate exists and the planned cost,
 * using the SAME SQL rate lookup the save uses (production_employee_rates).
 * A missing rate is "missing" with a null cost — never 0. Also returns the suggested
 * attendance days for the scheduled dates (Mon–Sat).
 * Pay model: days x daily rate; + flat overtime allowance per overtime day;
 * Sunday days at the flat Sunday rate. No hours, no multiplier.
 * Roles: admin, production_manager (wage figures are confidential).
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';
import { plannedLabourCost, suggestedAttendanceUnits } from '@/shared/lib/production/labourCosting';

const n = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    let b; try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    const workers = Array.isArray(b.workers) ? b.workers.slice(0, 50) : [];

    const { data: st, error: sErr } = await serviceClient.from('production_labour_settings').select('overtime_allowance, sunday_rate').eq('id', true).maybeSingle();
    if (sErr) {
      if (isMissingSchema(sErr)) return NextResponse.json({ error: 'Labour costing is not available yet — run production_v3a_labour_costing.sql', migration_pending: true }, { status: 503 });
      return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
    }
    const out = [];
    for (const w of workers) {
      const { data: r, error } = await serviceClient.rpc('production_employee_rates', { p_employee: w.employee_id });
      if (error) { console.error('Labour preview rates:', error.message); return NextResponse.json({ error: 'Failed to look up rates' }, { status: 500 }); }
      const daily = r?.daily ?? null;
      const plan = { units: n(w.planned_attendance_units), overtimeDays: n(w.planned_overtime_days), sundayUnits: n(w.planned_sunday_units) };
      const planned = plan.units !== undefined || plan.overtimeDays !== undefined || plan.sundayUnits !== undefined;
      out.push({
        employee_id: w.employee_id,
        rate_status: daily == null ? 'missing' : 'available',
        daily_rate: daily,
        planned_labour_cost: !planned ? null : plannedLabourCost(plan, { daily, otAllowance: r?.overtime_allowance ?? st?.overtime_allowance, sundayRate: r?.sunday_rate ?? st?.sunday_rate }),
      });
    }
    return NextResponse.json({
      workers: out,
      suggested_attendance_units: b.start && b.end ? suggestedAttendanceUnits(b.start, b.end) : null,
      overtime_allowance: st?.overtime_allowance ?? null, sunday_rate: st?.sunday_rate ?? null,
    });
  } catch (err) {
    console.error('Labour preview unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
