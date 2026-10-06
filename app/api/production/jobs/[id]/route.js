/**
 * app/api/production/jobs/[id]/route.js
 *
 * PATCH /api/production/jobs/:id  — update mutable job fields
 *
 * Mutable fields: status, blocker_reason, production_instructions,
 *                 priority, planned_start, planned_finish
 *
 * Status transitions are validated loosely here (no explicit state machine
 * in V1 — production manager is trusted). Phase 1B will add the progress
 * RPC which enforces qty-aware transitions.
 *
 * Cancel logic: set status = 'Cancelled', require cancelled_reason.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isValidIsoDate } from '@/shared/lib/production/stageSchedule';

// ── GET /api/production/jobs/:id ──────────────────────────────────────────────

export async function GET(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { data: job, error } = await serviceClient
      .from('production_jobs')
      .select(`
        id, job_num, status, priority,
        planned_quantity,
        in_production_qty, awaiting_qc_qty, rework_qty, accepted_qty, scrapped_qty,
        actual_start, actual_finish, planned_start, planned_finish,
        blocker_reason, cancelled_reason, production_instructions,
        category, description, size, finish_type, finish_color, wood_type,
        order_item_id, created_at, updated_at,
        production_plans!inner(
          id, status, notes,
          orders(id, order_num, client, due_date)
        ),
        production_job_assignments(
          id, assigned_quantity, status, planned_hours, notes,
          employees(id, name),
          production_operations(id, name, code)
        )
      `)
      .eq('id', jobId)
      .single();

    if (error || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Expose order_id from the plan's order for drawings lookup
    const orderObj = job.production_plans?.orders;
    const enriched = {
      ...job,
      order_id: orderObj?.id || null,
    };

    // Stage rows drive the pipeline in the job page hero — which stage the job is
    // actually in is the first thing that screen has to answer.
    // Queried separately (and defensively) so this route still works if
    // production_v1e_stages has not been applied in a given environment.
    enriched.production_job_stages = [];
    try {
      const { data: stages, error: stagesErr } = await serviceClient
        .from('production_job_stages')
        .select(`
          id, stage_key, stage_label, sort_order,
          is_enabled, status,
          planned_quantity, completed_quantity,
          rework_received_quantity, rework_completed_quantity,
          started_at, completed_at
        `)
        .eq('job_id', jobId)
        .order('sort_order', { ascending: true });

      if (stagesErr) {
        console.warn('production_job_stages not available (migration pending?):', stagesErr.message);
      } else {
        enriched.production_job_stages = stages || [];
      }
    } catch (stagesEx) {
      console.warn('Job stages fetch skipped:', stagesEx.message);
    }

    // Production due (v2b) — tolerant so the page still loads before the migration.
    enriched.production_due_date = null;
    try {
      const { data: due, error: dueErr } = await serviceClient
        .from('production_jobs').select('production_due_date').eq('id', jobId).single();
      if (!dueErr && due) enriched.production_due_date = due.production_due_date;
    } catch { /* migration pending */ }

    return NextResponse.json({ job: enriched });
  } catch (err) {
    console.error('Production job GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH /api/production/jobs/:id ────────────────────────────────────────────

const MUTABLE_STATUS_FIELDS = [
  'status',
  'blocker_reason',
  'production_instructions',
  'priority',
  'planned_start',
  'planned_finish',
  'cancelled_reason',
];

const VALID_STATUSES = [
  'Planned',
  'Awaiting Materials',
  'Materials Ready',
  'In Production',
  'Quality Control',
  'Paused',
  'Cancelled',
];

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    const { data: job } = await serviceClient
      .from('production_jobs')
      .select('id, status, completed_at')
      .eq('id', jobId)
      .single();

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    if (job.status === 'Completed') {
      return NextResponse.json({ error: 'Completed jobs cannot be edited' }, { status: 409 });
    }
    if (job.status === 'Cancelled' && body.status !== 'Cancelled') {
      return NextResponse.json({ error: 'Cancelled jobs cannot be reopened here' }, { status: 409 });
    }

    if (body.status && !VALID_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
    }
    if (body.status === 'Cancelled' && !body.cancelled_reason) {
      return NextResponse.json({ error: 'cancelled_reason is required when cancelling a job' }, { status: 400 });
    }

    // ── Build update payload ──────────────────────────────────────────────────
    const patch = { updated_at: new Date().toISOString() };
    for (const f of MUTABLE_STATUS_FIELDS) {
      if (body[f] !== undefined) patch[f] = body[f];
    }

    // Production due (when production must finish) — distinct from the order's
    // customer delivery date. Changing it never moves stage schedules; the UI
    // shows the resulting warnings instead.
    if (body.production_due_date !== undefined) {
      if (body.production_due_date !== null && !isValidIsoDate(body.production_due_date)) {
        return NextResponse.json({ error: 'production_due_date must be YYYY-MM-DD or null' }, { status: 400 });
      }
      patch.production_due_date = body.production_due_date;
    }

    // Once a job has stage schedules, planned_start/planned_finish are derived
    // from them (apply_stage_schedules). Editing them directly would drift.
    if (body.planned_start !== undefined || body.planned_finish !== undefined) {
      const { count } = await serviceClient
        .from('production_job_stage_schedules')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', jobId);
      if ((count || 0) > 0) {
        return NextResponse.json({
          error: 'This job has stage schedules; change its dates by rescheduling stages instead',
        }, { status: 409 });
      }
    }
    if (body.status === 'Cancelled') {
      patch.cancelled_at = new Date().toISOString();
      patch.cancelled_by  = user.id;
    }

    // blocker_reason is a mirror of the open-blocker records (production_v2c).
    // Writing the text alone would create a blocker nobody owns, so route it
    // through the blocker functions; fall back to the plain column only when
    // the v2c migration has not been applied.
    if (body.blocker_reason !== undefined) {
      const text = typeof body.blocker_reason === 'string' ? body.blocker_reason.trim() : '';
      let handled = false;
      if (text) {
        const { error: rErr } = await serviceClient.rpc('raise_job_blocker', {
          p_job_id: jobId, p_stage_id: null, p_reason: text.slice(0, 300), p_owner: null,
          p_expected: null, p_ref: null, p_notes: 'Raised from the job status change', p_actor: user.id,
        });
        if (!rErr) handled = true;
        else if (!(rErr.code === 'PGRST202' || /could not find|does not exist/i.test(rErr.message || ''))) {
          console.error('Production job PATCH (raise blocker):', rErr.message);
          return NextResponse.json({ error: 'Failed to record blocker' }, { status: 500 });
        }
      } else {
        const { data: open, error: oErr } = await serviceClient
          .from('production_job_blockers').select('id').eq('job_id', jobId).is('resolved_at', null);
        if (!oErr) {
          for (const row of open || []) {
            const { error: vErr } = await serviceClient.rpc('resolve_job_blocker', {
              p_blocker_id: row.id, p_note: 'Cleared from the job status change', p_actor: user.id,
            });
            if (vErr) {
              console.error('Production job PATCH (resolve blocker):', vErr.message);
              return NextResponse.json({ error: 'Failed to clear blocker' }, { status: 500 });
            }
          }
          handled = true;
        }
      }
      if (handled) delete patch.blocker_reason;   // the functions already wrote the mirror
    }

    const { data: updated, error } = await serviceClient
      .from('production_jobs')
      .update(patch)
      .eq('id', jobId)
      .select('id, job_num, status, blocker_reason, updated_at')
      .single();

    if (error) {
      if (/production_due_date/i.test(error.message || '')) {
        return NextResponse.json({ error: 'Production due date is not available yet — run production_v2b_stage_schedules.sql', migration_pending: true }, { status: 503 });
      }
      console.error('Production job PATCH:', error.message);
      return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
    }

    return NextResponse.json({ job: updated });
  } catch (err) {
    console.error('Production job PATCH unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
