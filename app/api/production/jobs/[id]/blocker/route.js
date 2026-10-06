/**
 * POST /api/production/jobs/:id/blocker
 *
 * Raise a blocker on a job. Body:
 *   { reason (required), owner_employee_id?, expected_resolution_date?, supplier_po_ref?, notes?, stage_id? }
 * Records ownership; does NOT change job status, stage status, quantities or dates.
 *
 * GET  — open + recently resolved blockers for the job (any production role).
 * Roles: POST admin, production_manager. GET adds head_of_sales, production_staff.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isValidIsoDate } from '@/shared/lib/production/stageSchedule';

const PENDING = { error: 'Blockers are not available yet — run production_v2c_blockers.sql', migration_pending: true };
const isMissing = (e) => e && (e.code === 'PGRST202' || e.code === '42P01' || /does not exist|could not find/i.test(e.message || ''));

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reason) return NextResponse.json({ error: 'A blocker needs a reason' }, { status: 400 });
    if (reason.length > 300) return NextResponse.json({ error: 'Reason is too long (300 characters max)' }, { status: 400 });
    if (b.expected_resolution_date && !isValidIsoDate(b.expected_resolution_date)) {
      return NextResponse.json({ error: 'expected_resolution_date must be YYYY-MM-DD' }, { status: 400 });
    }

    const { data, error } = await serviceClient.rpc('raise_job_blocker', {
      p_job_id: params.id,
      p_stage_id: b.stage_id || null,
      p_reason: reason,
      p_owner: b.owner_employee_id || null,
      p_expected: b.expected_resolution_date || null,
      p_ref: b.supplier_po_ref || null,
      p_notes: b.notes || null,
      p_actor: user.id,
    });
    if (error) {
      if (isMissing(error)) return NextResponse.json(PENDING, { status: 503 });
      if (error.code === 'P0001' || error.code === 'P0002') {
        return NextResponse.json({ error: error.message }, { status: error.code === 'P0002' ? 404 : 409 });
      }
      console.error('Blocker POST rpc:', error.message);
      return NextResponse.json({ error: 'Failed to raise blocker' }, { status: 500 });
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error('Blocker POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(_request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('production_job_blockers')
      .select('id, stage_id, reason, owner_employee_id, expected_resolution_date, supplier_po_ref, notes, created_at, resolved_at, resolution_note, employees:owner_employee_id(name)')
      .eq('job_id', params.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      if (isMissing(error)) return NextResponse.json({ blockers: [], ...PENDING });
      console.error('Blocker GET:', error.message);
      return NextResponse.json({ error: 'Failed to load blockers' }, { status: 500 });
    }
    return NextResponse.json({
      blockers: (data || []).map((r) => ({ ...r, owner_name: r.employees?.name ?? null, employees: undefined })),
    });
  } catch (err) {
    console.error('Blocker GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
