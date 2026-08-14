/**
 * GET  /api/payroll/runs/:id/adjustments  — list adjustments for a run
 * POST /api/payroll/runs/:id/adjustments  — add adjustment + recompute entry
 * DELETE /api/payroll/runs/:id/adjustments?adj_id=  — remove adjustment (draft runs only)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { resolveShaDeduction } from '@/shared/lib/resolveShaDeduction';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('payroll_adjustments')
      .select('*, employees(name)')
      .eq('run_id', params.id)
      .order('created_at');

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch adjustments' }, { status: 500 });
    }

    return NextResponse.json({ adjustments: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/runs/[id]/adjustments unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const runId = params.id;

    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status')
      .eq('id', runId)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Cannot modify approved run' }, { status: 409 });
    }

    const body = await request.json();
    const { employee_id, adj_type, amount, is_deduction = true, description } = body;

    if (!employee_id || !adj_type || !amount || !description) {
      return NextResponse.json({ error: 'employee_id, adj_type, amount, and description are required' }, { status: 400 });
    }

    if (Number(amount) <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than zero' }, { status: 400 });
    }

    if (!['advance', 'damage', 'overtime', 'bonus', 'other'].includes(adj_type)) {
      return NextResponse.json({ error: 'Invalid adj_type' }, { status: 400 });
    }

    // Verify employee is actually in this run
    const { data: entry, error: entryErr } = await serviceClient
      .from('payroll_entries')
      .select('id')
      .eq('run_id', runId)
      .eq('employee_id', employee_id)
      .single();

    if (entryErr || !entry) {
      return NextResponse.json({ error: 'Employee is not part of this payroll run' }, { status: 400 });
    }

    const { data: adj, error: insertErr } = await serviceClient
      .from('payroll_adjustments')
      .insert({
        run_id: runId,
        employee_id,
        entry_id:    entry.id,
        adj_type,
        amount:      Number(amount),
        is_deduction,
        description,
        created_by:  user.id,
      })
      .select()
      .single();

    if (insertErr) {
      return NextResponse.json({ error: 'Failed to save adjustment' }, { status: 500 });
    }

    // Recompute entry
    await recomputeEntry(runId, employee_id);

    return NextResponse.json({ adjustment: adj }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/runs/[id]/adjustments unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales', 'production_manager']);
    if (authError) return authError;

    const runId = params.id;
    const { searchParams } = new URL(request.url);
    const adjId = searchParams.get('adj_id');
    if (!adjId) return NextResponse.json({ error: 'adj_id required' }, { status: 400 });

    const { data: run } = await serviceClient
      .from('payroll_runs').select('status').eq('id', runId).single();

    if (run?.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft runs can be modified' }, { status: 409 });
    }

    const { data: adj } = await serviceClient
      .from('payroll_adjustments').select('employee_id').eq('id', adjId).single();

    await serviceClient.from('payroll_adjustments').delete().eq('id', adjId);

    if (adj?.employee_id) await recomputeEntry(runId, adj.employee_id);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/payroll/runs/[id]/adjustments unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function recomputeEntry(runId, employeeId) {
  try {
    const { data: entry } = await serviceClient
      .from('payroll_entries').select('*')
      .eq('run_id', runId).eq('employee_id', employeeId).single();
    if (!entry) return;

    // Permanent employees: gross = monthly salary; attendance does not change it.
    if (entry.snapshot_type === 'permanent') {
      // Still need to recompute adjustments on top of the fixed salary.
      const gross_pay = entry.snapshot_salary || 0;
      const { data: adjs } = await serviceClient
        .from('payroll_adjustments').select('adj_type, amount, is_deduction')
        .eq('run_id', runId).eq('employee_id', employeeId);

      let advance_deduction = 0, damage_deduction = 0, other_deductions = 0, bonus_addition = 0;
      for (const a of (adjs || [])) {
        if (!a.is_deduction) bonus_addition += Number(a.amount);
        else if (a.adj_type === 'advance') advance_deduction += Number(a.amount);
        else if (a.adj_type === 'damage')  damage_deduction  += Number(a.amount);
        else                               other_deductions  += Number(a.amount);
      }

      const gross_with_bonus = gross_pay + bonus_addition;
      const sha_deduction    = gross_with_bonus > 0
        ? await resolveShaDeduction(entry.snapshot_sha || 0, employeeId, runId)
        : 0;
      const total_deductions = sha_deduction + advance_deduction + damage_deduction + other_deductions;
      const net_pay          = Math.max(0, gross_with_bonus - total_deductions);

      await serviceClient.from('payroll_entries').update({
        gross_pay: gross_with_bonus,
        sha_deduction, advance_deduction, damage_deduction, other_deductions,
        total_deductions, net_pay,
      }).eq('run_id', runId).eq('employee_id', employeeId);
      return;
    }

    // Casual / skilled_casual: derive gross from attendance.
    const { data: att } = await serviceClient
      .from('payroll_attendance').select('present, overtime_hours')
      .eq('run_id', runId).eq('employee_id', employeeId);

    const days_worked    = (att || []).filter(a => a.present).length;
    // overtime_hours field stores a direct KES amount per day — sum present days only.
    const overtime_amount = (att || []).filter(a => a.present)
      .reduce((s, a) => s + Number(a.overtime_hours || 0), 0);
    const overtime_hours  = 0; // hours no longer tracked; field is repurposed to KES amount
    const gross_pay       = days_worked * (entry.snapshot_day_rate || 0) + overtime_amount;

    const { data: adjs } = await serviceClient
      .from('payroll_adjustments').select('adj_type, amount, is_deduction')
      .eq('run_id', runId).eq('employee_id', employeeId);

    let advance_deduction = 0, damage_deduction = 0, other_deductions = 0, bonus_addition = 0;
    for (const a of (adjs || [])) {
      if (!a.is_deduction) bonus_addition += Number(a.amount);
      else if (a.adj_type === 'advance') advance_deduction += Number(a.amount);
      else if (a.adj_type === 'damage')  damage_deduction  += Number(a.amount);
      else                               other_deductions  += Number(a.amount);
    }

    const gross_with_bonus = gross_pay + bonus_addition;
    // SHA deducts once per calendar month — only when the employee has gross pay.
    const sha_deduction    = gross_with_bonus > 0
      ? await resolveShaDeduction(entry.snapshot_sha || 0, employeeId, runId)
      : 0;
    const total_deductions = sha_deduction + advance_deduction + damage_deduction + other_deductions;
    const net_pay          = Math.max(0, gross_with_bonus - total_deductions);

    await serviceClient.from('payroll_entries').update({
      days_worked, overtime_hours, overtime_amount,
      gross_pay: gross_with_bonus,
      sha_deduction, advance_deduction, damage_deduction, other_deductions,
      total_deductions, net_pay,
    }).eq('run_id', runId).eq('employee_id', employeeId);
  } catch (e) {
    console.error('recomputeEntry error:', e.message);
  }
}
