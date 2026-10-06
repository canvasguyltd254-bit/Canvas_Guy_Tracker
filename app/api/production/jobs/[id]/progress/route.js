/**
 * app/api/production/jobs/[id]/progress/route.js
 *
 * POST /api/production/jobs/:id/progress
 *
 * Records a quantity transition on a production job via the
 * record_job_progress() RPC (Phase 1B).
 *
 * Body: { transition, quantity, notes? }
 *
 * Transition types:
 *   start        — move units from not-started → in production
 *   submit_qc    — in production → awaiting QC
 *   accept       — awaiting QC → accepted (auto-completes job when full)
 *   rework       — awaiting QC → rework
 *   rework_start — rework → in production
 *   scrap        — awaiting QC → scrapped
 *
 * Returns: { job } — the updated job row
 *
 * Roles: admin, production_manager, production_staff
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const VALID_TRANSITIONS = ['start', 'submit_qc', 'accept', 'rework', 'rework_start', 'scrap'];

export async function POST(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'production_staff']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { transition, quantity, notes } = body;

    if (!transition || !VALID_TRANSITIONS.includes(transition)) {
      return NextResponse.json(
        { error: `Invalid transition. Must be one of: ${VALID_TRANSITIONS.join(', ')}` },
        { status: 400 }
      );
    }

    const qty = parseInt(quantity, 10);
    if (!qty || qty <= 0) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    // Transition-level role check — fast error before hitting the DB
    const QC_ONLY_TRANSITIONS = ['accept', 'rework', 'scrap'];
    const canQC = ['admin', 'production_manager'].includes(role);
    if (QC_ONLY_TRANSITIONS.includes(transition) && !canQC) {
      return NextResponse.json(
        { error: `Transition '${transition}' requires admin or production_manager role` },
        { status: 403 }
      );
    }

    // Verify job exists and fetch current state for response
    const { data: existing } = await serviceClient
      .from('production_jobs')
      .select('id, status')
      .eq('id', jobId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Call the RPC
    const { error: rpcError } = await serviceClient.rpc('record_job_progress', {
      p_job_id:      jobId,
      p_transition:  transition,
      p_quantity:    qty,
      p_notes:       notes || null,
      p_recorded_by: user.id,
    });

    if (rpcError) {
      console.error('record_job_progress RPC:', rpcError.message);
      return NextResponse.json({ error: rpcError.message }, { status: 400 });
    }

    // Fetch the updated job
    const { data: job, error: fetchError } = await serviceClient
      .from('production_jobs')
      .select(`
        id, job_num, status, priority,
        planned_quantity,
        in_production_qty, awaiting_qc_qty, rework_qty, accepted_qty, scrapped_qty,
        actual_start, actual_finish, planned_start, planned_finish,
        blocker_reason, production_instructions,
        category, description, size, finish_type, finish_color, wood_type,
        updated_at,
        production_job_assignments(
          id, assigned_quantity, status, planned_hours, notes,
          employees(id, name),
          production_operations(id, name, code)
        )
      `)
      .eq('id', jobId)
      .single();

    if (fetchError) {
      console.error('Progress POST fetch job:', fetchError.message);
      return NextResponse.json({ error: 'Progress recorded but failed to fetch updated job' }, { status: 207 });
    }

    return NextResponse.json({ job }, { status: 200 });
  } catch (err) {
    console.error('Progress POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
