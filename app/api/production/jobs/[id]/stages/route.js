/**
 * app/api/production/jobs/[id]/stages/route.js
 *
 * GET  /api/production/jobs/:id/stages
 *   Returns all stage rows for the job, ordered by sort_order,
 *   with recent event history for each stage.
 *
 * Roles: admin, production_manager, head_of_sales, production_staff
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(_request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    // Stages with embedded recent events (last 50 per job, ordered newest-first)
    const { data: stages, error: stagesErr } = await serviceClient
      .from('production_job_stages')
      .select(`
        id, stage_key, stage_label, sort_order,
        is_enabled, status,
        planned_quantity, completed_quantity,
        rework_received_quantity, rework_completed_quantity,
        started_at, started_by, completed_at, completed_by,
        notes, created_at, updated_at
      `)
      .eq('job_id', jobId)
      .order('sort_order', { ascending: true });

    if (stagesErr) throw stagesErr;

    // Event history for this job's stages
    const { data: events, error: eventsErr } = await serviceClient
      .from('production_stage_progress_entries')
      .select(`
        id, stage_id, event_type, quantity,
        from_stage_key, to_stage_key, notes,
        recorded_by, created_at,
        production_operations(id, name, code),
        employees(id, name)
      `)
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (eventsErr) throw eventsErr;

    // Attach events to their respective stage
    const eventsByStage = {};
    for (const ev of events || []) {
      if (!eventsByStage[ev.stage_id]) eventsByStage[ev.stage_id] = [];
      eventsByStage[ev.stage_id].push(ev);
    }

    // Persisted schedules (same rows the Gantt reads). Tolerant of the v2b
    // migration not being applied yet.
    const scheduleByStage = {};
    const { data: schedules, error: schErr } = await serviceClient
      .from('production_job_stage_schedules')
      .select('job_stage_id, planned_start_date, planned_end_date, status')
      .eq('job_id', jobId);
    if (!schErr) {
      for (const sc of schedules || []) scheduleByStage[sc.job_stage_id] = sc;
    }

    const result = (stages || []).map(s => ({
      ...s,
      events: eventsByStage[s.id] || [],
      schedule: scheduleByStage[s.id]
        ? { start: scheduleByStage[s.id].planned_start_date, end: scheduleByStage[s.id].planned_end_date, status: scheduleByStage[s.id].status }
        : null,
    }));

    return NextResponse.json({ stages: result });
  } catch (err) {
    console.error('GET /stages error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
