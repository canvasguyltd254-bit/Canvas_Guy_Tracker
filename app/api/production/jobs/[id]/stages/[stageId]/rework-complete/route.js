/**
 * app/api/production/jobs/[id]/stages/[stageId]/rework-complete/route.js
 *
 * POST /api/production/jobs/:id/stages/:stageId/rework-complete
 *
 * Worker has finished rework on N units at this stage.
 * Units re-enter the production pipeline (rework_qty → in_production_qty).
 * From there the normal advance_stage flow continues until Finishing
 * submits them to QC again.
 *
 * Atomically:
 *   • stage.rework_completed_quantity += N
 *   • job.rework_qty        -= N
 *   • job.in_production_qty += N
 *   • Writes production_progress_entries (rework_start transition)
 *   • Writes production_stage_progress_entries (rework_completed event)
 *
 * Body: { quantity, operation_id?, employee_id?, notes? }
 *
 * Roles: admin, production_manager, production_staff
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, stageId } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'production_staff']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { quantity, operation_id, employee_id, notes } = body;

    if (!quantity || !Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    const { error: rpcErr } = await serviceClient.rpc('complete_stage_rework', {
      p_job_id:       jobId,
      p_stage_id:     stageId,
      p_quantity:     quantity,
      p_operation_id: operation_id ?? null,
      p_employee_id:  employee_id  ?? null,
      p_notes:        notes        ?? null,
      p_recorded_by:  user.id,
    });

    if (rpcErr) {
      return NextResponse.json({ error: rpcErr.message }, { status: 422 });
    }

    // Return updated stage + fresh job status
    const [{ data: stage, error: s1 }, { data: job, error: s2 }] = await Promise.all([
      serviceClient
        .from('production_job_stages')
        .select('*')
        .eq('id', stageId)
        .single(),
      serviceClient
        .from('production_jobs')
        .select('id, status, in_production_qty, awaiting_qc_qty, rework_qty, accepted_qty, scrapped_qty')
        .eq('id', jobId)
        .single(),
    ]);

    if (s1) throw s1;
    if (s2) throw s2;

    return NextResponse.json({ stage, job });
  } catch (err) {
    console.error('POST /stages/:stageId/rework-complete error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
