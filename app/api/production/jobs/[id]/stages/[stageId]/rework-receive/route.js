/**
 * app/api/production/jobs/[id]/stages/[stageId]/rework-receive/route.js
 *
 * POST /api/production/jobs/:id/stages/:stageId/rework-receive
 *
 * QC routes N units back to this stage for rework.
 * Atomically:
 *   • awaiting_qc_qty -= N  (job)
 *   • rework_qty       += N  (job)
 *   • stage.rework_received_quantity += N
 *   • Writes production_progress_entries (rework transition)
 *   • Writes production_stage_progress_entries (rework_received event)
 *
 * Body: { quantity, notes? }
 *
 * Roles: admin, production_manager  (QC decision — restricted roles)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, stageId } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { quantity, notes } = body;

    if (!quantity || !Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    // Fetch the stage to get its stage_key for the RPC
    const { data: stage, error: fetchErr } = await serviceClient
      .from('production_job_stages')
      .select('stage_key')
      .eq('id', stageId)
      .eq('job_id', jobId)
      .single();

    if (fetchErr || !stage) {
      return NextResponse.json({ error: 'Stage not found' }, { status: 404 });
    }

    const { error: rpcErr } = await serviceClient.rpc('route_rework_to_stage', {
      p_job_id:      jobId,
      p_stage_key:   stage.stage_key,
      p_quantity:    quantity,
      p_notes:       notes   ?? null,
      p_recorded_by: user.id,
    });

    if (rpcErr) {
      return NextResponse.json({ error: rpcErr.message }, { status: 422 });
    }

    // Return updated stage + fresh job status
    const [{ data: updatedStage, error: s1 }, { data: job, error: s2 }] = await Promise.all([
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

    return NextResponse.json({ stage: updatedStage, job });
  } catch (err) {
    console.error('POST /stages/:stageId/rework-receive error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
