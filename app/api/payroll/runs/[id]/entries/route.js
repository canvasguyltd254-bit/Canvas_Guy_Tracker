/**
 * GET  /api/payroll/runs/:id/entries  — list entries for a run
 * POST /api/payroll/runs/:id/entries  — add employee to run (creates/updates entry)
 *
 * Entry calculations are done server-side from attendance + adjustments.
 * Called after attendance is saved to recompute gross/net.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ALLOWED_ROLES = ['admin', 'production_manager'];
const OVERTIME_RATE = 200; // KES per hour

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data: entries, error } = await serviceClient
      .from('payroll_entries')
      .select('*, employees(name, employee_num, phone, type, day_rate, monthly_salary)')
      .eq('run_id', params.id)
      .order('snapshot_name');

    if (error) {
      console.error('GET entries error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch entries' }, { status: 500 });
    }

    return NextResponse.json({ entries: entries || [] });
  } catch (err) {
    console.error('GET /api/payroll/runs/[id]/entries unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const runId = params.id;

    // Check run is still draft
    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status, period_start, period_end, run_type')
      .eq('id', runId)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Cannot modify approved run' }, { status: 409 });
    }

    const body = await request.json();
    const { employee_id } = body;

    if (!employee_id) {
      return NextResponse.json({ error: 'employee_id is required' }, { status: 400 });
    }

    // Fetch employee
    const { data: emp, error: empErr } = await serviceClient
      .from('employees')
      .select('*')
      .eq('id', employee_id)
      .single();

    if (empErr || !emp) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    if (!emp.is_active) {
      return NextResponse.json({ error: 'Cannot add inactive employee to payroll' }, { status: 400 });
    }

    // Check if already in run
    const { data: existing } = await serviceClient
      .from('payroll_entries')
      .select('id')
      .eq('run_id', runId)
      .eq('employee_id', employee_id)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Employee already in this payroll run' }, { status: 409 });
    }

    // For permanent employees: gross = monthly_salary; days_worked = 0
    // For casual/skilled_casual: gross computed from attendance (0 at creation)
    const gross_pay = emp.type === 'permanent' ? (emp.monthly_salary || 0) : 0;
    const sha_deduction = emp.sha_amount || 0;
    const net_pay = Math.max(0, gross_pay - sha_deduction);

    const { data: entry, error: insertErr } = await serviceClient
      .from('payroll_entries')
      .insert({
        run_id:            runId,
        employee_id,
        snapshot_name:     emp.name,
        snapshot_type:     emp.type,
        snapshot_day_rate: emp.day_rate,
        snapshot_salary:   emp.monthly_salary,
        snapshot_sha:      emp.sha_amount || 0,
        days_worked:       0,
        overtime_hours:    0,
        overtime_rate:     OVERTIME_RATE,
        overtime_amount:   0,
        gross_pay,
        sha_deduction,
        advance_deduction: 0,
        damage_deduction:  0,
        other_deductions:  0,
        total_deductions:  sha_deduction,
        net_pay,
        payment_status:    'unpaid',
      })
      .select()
      .single();

    if (insertErr) {
      console.error('POST entries insert error:', insertErr.message);
      return NextResponse.json({ error: 'Failed to add employee to run' }, { status: 500 });
    }

    // Seed attendance rows for casual workers (UTC-safe date generation)
    if (emp.type === 'casual' || emp.type === 'skilled_casual') {
      const rows = [];
      const d    = new Date(run.period_start + 'T00:00:00Z');
      const end  = new Date(run.period_end   + 'T00:00:00Z');
      while (d <= end) {
        rows.push({
          run_id:         runId,
          employee_id,
          work_date:      d.toISOString().split('T')[0],
          present:        false,
          overtime_hours: 0,
        });
        d.setUTCDate(d.getUTCDate() + 1);
      }
      if (rows.length > 0) {
        const { error: attErr } = await serviceClient
          .from('payroll_attendance')
          .upsert(rows, { onConflict: 'run_id,employee_id,work_date', ignoreDuplicates: true });
        if (attErr) {
          console.error('Attendance seed error:', attErr.message);
        }
      }
    }

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/runs/[id]/entries unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
