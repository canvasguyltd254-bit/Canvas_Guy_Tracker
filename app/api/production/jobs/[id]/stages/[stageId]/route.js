/**
 * app/api/production/jobs/[id]/stages/[stageId]/route.js
 *
 * PATCH /api/production/jobs/:id/stages/:stageId
 *   Toggle a stage enabled/disabled.
 *   Locked once any quantity movement has been recorded.
 *
 * Body: { is_enabled: boolean }
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function PATCH(request, props) {
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

    const { is_enabled } = body;
    if (typeof is_enabled !== 'boolean') {
      return NextResponse.json({ error: 'is_enabled must be a boolean' }, { status: 400 });
    }

    // Fetch the stage to get its stage_key
    const { data: stage, error: fetchErr } = await serviceClient
      .from('production_job_stages')
      .select('stage_key')
      .eq('id', stageId)
      .eq('job_id', jobId)
      .single();

    if (fetchErr || !stage) {
      return NextResponse.json({ error: 'Stage not found' }, { status: 404 });
    }

    const { error: rpcErr } = await serviceClient.rpc('toggle_job_stage', {
      p_job_id:     jobId,
      p_stage_key:  stage.stage_key,
      p_is_enabled: is_enabled,
      p_toggled_by: user.id,
    });

    if (rpcErr) {
      return NextResponse.json({ error: rpcErr.message }, { status: 422 });
    }

    // Return updated stage
    const { data: updated, error: refetchErr } = await serviceClient
      .from('production_job_stages')
      .select('*')
      .eq('id', stageId)
      .single();

    if (refetchErr) throw refetchErr;

    return NextResponse.json({ stage: updated });
  } catch (err) {
    console.error('PATCH /stages/:stageId error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
