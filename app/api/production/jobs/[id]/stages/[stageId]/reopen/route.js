/**
 * app/api/production/jobs/[id]/stages/[stageId]/reopen/route.js
 *
 * POST /api/production/jobs/:id/stages/:stageId/reopen
 *
 * Admin/manager: revert a completed or skipped stage back to active.
 * Clears completed_at/completed_by; sets status = 'active'.
 * Use when a stage was marked complete in error or additional work is needed.
 *
 * Body: { notes? }
 *
 * Roles: admin, production_manager
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

    let body = {};
    try {
      body = await request.json();
    } catch {
      // notes is optional; empty body is fine
    }

    const { notes } = body;

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

    const { error: rpcErr } = await serviceClient.rpc('reopen_stage', {
      p_job_id:      jobId,
      p_stage_key:   stage.stage_key,
      p_notes:       notes   ?? null,
      p_recorded_by: user.id,
    });

    if (rpcErr) {
      return NextResponse.json({ error: rpcErr.message }, { status: 422 });
    }

    // Return the updated stage
    const { data: updated, error: refetchErr } = await serviceClient
      .from('production_job_stages')
      .select('*')
      .eq('id', stageId)
      .single();

    if (refetchErr) throw refetchErr;

    return NextResponse.json({ stage: updated });
  } catch (err) {
    console.error('POST /stages/:stageId/reopen error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
