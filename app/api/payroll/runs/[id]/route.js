/**
 * GET    /api/payroll/runs/:id  — get single run with entries summary
 * PATCH  /api/payroll/runs/:id  — update draft run (notes, dates)
 * DELETE /api/payroll/runs/:id  — delete draft run (admin only)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { RUN_TYPES, entryTypesConflictingWithRun } from '@/shared/lib/payroll/runTypes';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data: run, error } = await serviceClient
      .from('payroll_runs')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !run) {
      return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    }

    // Entries with employee names
    const { data: entries, error: entErr } = await serviceClient
      .from('payroll_entries')
      .select('*, employees(name, employee_num, phone, type)')
      .eq('run_id', params.id)
      .order('snapshot_name');

    if (entErr) {
      console.error('GET /api/payroll/runs/[id] entries error:', entErr.message);
    }

    return NextResponse.json({ run, entries: entries || [] });
  } catch (err) {
    console.error('GET /api/payroll/runs/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    // Fetch current run
    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status')
      .eq('id', params.id)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    const body = await request.json();

    // Approved runs: only notes can be updated — structural fields require reopen first
    const STRUCTURAL = ['period_start', 'period_end', 'run_type'];
    if (run.status === 'approved') {
      const hasStructural = STRUCTURAL.some(k => k in body);
      if (hasStructural) {
        return NextResponse.json(
          { error: 'Approved runs cannot be edited. Reopen to draft first, then make changes.' },
          { status: 409 }
        );
      }
    }

    if (run.status === 'closed') {
      return NextResponse.json({ error: 'Closed runs cannot be modified' }, { status: 409 });
    }

    const allowed = ['period_start', 'period_end', 'notes', 'run_type'];
    const updates = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    // Changing run_type must not smuggle ineligible workers into a run that
    // already has entries (this would bypass the add-time check).
    if ('run_type' in updates) {
      if (!RUN_TYPES.includes(updates.run_type)) {
        return NextResponse.json({ error: 'Invalid run_type' }, { status: 400 });
      }
      const { data: existing, error: entErr } = await serviceClient
        .from('payroll_entries')
        .select('snapshot_type')
        .eq('run_id', params.id);
      if (entErr) {
        return NextResponse.json({ error: 'Failed to validate run type' }, { status: 500 });
      }
      const conflicts = entryTypesConflictingWithRun(
        updates.run_type, (existing || []).map(e => e.snapshot_type));
      if (conflicts.length > 0) {
        return NextResponse.json({
          error: `Cannot change to a ${updates.run_type} run: it already contains ${conflicts.join(', ')} employees. Remove them first.`,
          code: 'RUN_TYPE_MISMATCH',
        }, { status: 409 });
      }
    }

    const { data: updated, error } = await serviceClient
      .from('payroll_runs')
      .update(updates)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to update run' }, { status: 500 });
    }

    return NextResponse.json({ run: updated });
  } catch (err) {
    console.error('PATCH /api/payroll/runs/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status')
      .eq('id', params.id)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    if (run.status !== 'draft') {
      return NextResponse.json(
        { error: `Only draft runs can be deleted. This run is "${run.status}" — reopen it to draft first.` },
        { status: 409 }
      );
    }

    const { error } = await serviceClient
      .from('payroll_runs')
      .delete()
      .eq('id', params.id);

    if (error) {
      return NextResponse.json({ error: 'Failed to delete run' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/payroll/runs/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
