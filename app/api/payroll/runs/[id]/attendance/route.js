/**
 * GET  /api/payroll/runs/:id/attendance  — get attendance grid for a run
 * POST /api/payroll/runs/:id/attendance  — upsert attendance rows + recompute entries
 *
 * Body: { rows: [{ employee_id, work_date, present, overtime_hours }] }
 * After saving, recomputes gross/net for each affected employee.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { resolveShaDeduction } from '@/shared/lib/resolveShaDeduction';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];
const OVERTIME_RATE = 200;

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const employee_id = searchParams.get('employee_id');

    let query = serviceClient
      .from('payroll_attendance')
      .select('*')
      .eq('run_id', params.id)
      .order('work_date');

    if (employee_id) query = query.eq('employee_id', employee_id);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch attendance' }, { status: 500 });
    }

    return NextResponse.json({ attendance: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/runs/[id]/attendance unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const runId = params.id;

    // Check run is draft and fetch period bounds
    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status, period_start, period_end')
      .eq('id', runId)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'draft' && role !== 'admin') {
      return NextResponse.json({ error: 'Cannot modify approved run' }, { status: 409 });
    }
    if (run.status === 'closed') {
      return NextResponse.json({ error: 'Closed runs cannot be modified' }, { status: 409 });
    }
    if (!run.period_start || !run.period_end) {
      return NextResponse.json({ error: 'Run is missing period_start or period_end' }, { status: 422 });
    }

    const body = await request.json();
    const { rows } = body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
    }

    // Validate all dates — guard against missing/malformed values AND range checks
    const runStart = new Date(run.period_start + 'T00:00:00Z');
    const runEnd   = new Date(run.period_end   + 'T00:00:00Z');
    const invalidDates  = rows.filter(r => !r.work_date || isNaN(new Date(r.work_date + 'T00:00:00Z')));
    if (invalidDates.length > 0) {
      return NextResponse.json({ error: `${invalidDates.length} row(s) have missing or invalid work_date` }, { status: 400 });
    }
    const outOfRange = rows.filter(r => {
      const d = new Date(r.work_date + 'T00:00:00Z');
      return d < runStart || d > runEnd;
    });
    if (outOfRange.length > 0) {
      return NextResponse.json({
        error: `${outOfRange.length} date(s) fall outside the run period (${run.period_start} – ${run.period_end})`,
      }, { status: 400 });
    }

    // Validate all employees are in this run
    const submittedEmpIds = [...new Set(rows.map(r => r.employee_id))];
    const { data: runEntries } = await serviceClient
      .from('payroll_entries')
      .select('employee_id')
      .eq('run_id', runId)
      .in('employee_id', submittedEmpIds);

    const validEmpIds = new Set((runEntries || []).map(e => e.employee_id));
    const unknownEmps = submittedEmpIds.filter(id => !validEmpIds.has(id));
    if (unknownEmps.length > 0) {
      return NextResponse.json({
        error: `${unknownEmps.length} employee(s) are not part of this payroll run`,
      }, { status: 400 });
    }

    // Upsert attendance (no updated_by — avoids FK constraint on auth.users at insert time)
    const upsertRows = rows.map(r => ({
      run_id:         runId,
      employee_id:    r.employee_id,
      work_date:      r.work_date,
      present:        Boolean(r.present),
      overtime_hours: Number(r.overtime_hours || 0),
      notes:          r.notes || null,
    }));

    const { error: upsertErr } = await serviceClient
      .from('payroll_attendance')
      .upsert(upsertRows, { onConflict: 'run_id,employee_id,work_date' });

    if (upsertErr) {
      console.error('Attendance upsert error:', upsertErr.message, upsertErr.details, upsertErr.hint);
      return NextResponse.json({ error: upsertErr.message || 'Failed to save attendance' }, { status: 500 });
    }

    // Recompute entries for affected employees
    const affectedEmployees = [...new Set(rows.map(r => r.employee_id))];
    const recomputeErrors = [];

    for (const empId of affectedEmployees) {
      const err = await recomputeEntry(runId, empId, user.id);
      if (err) recomputeErrors.push({ employee_id: empId, error: err });
    }

    return NextResponse.json({
      success: true,
      recompute_errors: recomputeErrors,
    });
  } catch (err) {
    console.error('POST /api/payroll/runs/[id]/attendance unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── Recompute a single entry based on current attendance + adjustments ────────
async function recomputeEntry(runId, employeeId, userId) {
  try {
    // Fetch entry
    const { data: entry } = await serviceClient
      .from('payroll_entries')
      .select('*')
      .eq('run_id', runId)
      .eq('employee_id', employeeId)
      .single();

    if (!entry) return 'Entry not found';

    // Permanent employees: gross doesn't change from attendance
    if (entry.snapshot_type === 'permanent') return null;

    // Sum attendance
    const { data: att } = await serviceClient
      .from('payroll_attendance')
      .select('present, overtime_hours')
      .eq('run_id', runId)
      .eq('employee_id', employeeId);

    const days_worked     = (att || []).filter(a => a.present).length;
    const overtime_amount = (att || []).filter(a => a.present).reduce((s, a) => s + Number(a.overtime_hours || 0), 0); // field stores KES amount; only count days worked
    const overtime_hours  = 0; // hours no longer tracked; OT is entered as a fixed KES amount
    const day_rate        = entry.snapshot_day_rate || 0;
    const gross_pay       = days_worked * day_rate + overtime_amount;

    // Sum adjustments
    const { data: adjs } = await serviceClient
      .from('payroll_adjustments')
      .select('adj_type, amount, is_deduction')
      .eq('run_id', runId)
      .eq('employee_id', employeeId);

    let advance_deduction = 0;
    let damage_deduction  = 0;
    let other_deductions  = 0;
    let bonus_addition    = 0;   // non-deduction adjustments (bonuses, overtime additions)

    for (const a of (adjs || [])) {
      if (!a.is_deduction) {
        bonus_addition += Number(a.amount);   // add to gross
      } else if (a.adj_type === 'advance') {
        advance_deduction += Number(a.amount);
      } else if (a.adj_type === 'damage') {
        damage_deduction += Number(a.amount);
      } else {
        other_deductions += Number(a.amount);
      }
    }

    const gross_with_bonus  = gross_pay + bonus_addition;
    // SHA deducts once per calendar month — check other runs in the same month
    const sha_deduction     = await resolveShaDeduction(entry.snapshot_sha || 0, employeeId, runId);
    const total_deductions  = sha_deduction + advance_deduction + damage_deduction + other_deductions;
    const net_pay           = Math.max(0, gross_with_bonus - total_deductions);

    await serviceClient
      .from('payroll_entries')
      .update({
        days_worked, overtime_hours, overtime_amount,
        gross_pay: gross_with_bonus,
        sha_deduction, advance_deduction, damage_deduction, other_deductions,
        total_deductions, net_pay,
      })
      .eq('run_id', runId)
      .eq('employee_id', employeeId);

    return null;
  } catch (e) {
    return e.message;
  }
}
