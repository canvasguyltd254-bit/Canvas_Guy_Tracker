/**
 * POST /api/production/jobs/:id/stages/:stageId/schedule
 *
 * Set a stage's planned start/end. PLANNED DATES ONLY — this route never writes
 * quantities, stage status, or progress events.
 *
 * Body: { start, end, downstream?: 'shift' | 'keep' | 'review', overrides?: [{stage_id,start,end}] }
 *
 * Date-impact rule (never silent): when the move would affect later scheduled
 * stages and no `downstream` choice is supplied, nothing is saved and the route
 * answers 409 { requires_choice: true, impact } so the UI can ask:
 *   shift  — move every later, unfinished stage by the same working-day change
 *   keep   — leave later stages where they are (overlaps are reported back)
 *   review — caller supplies explicit dates for every later unfinished stage
 *
 * Worker assignment dates: when the new stage dates leave workers booked on dates that
 * no longer fit, the route also asks (409 with assignment_impact) whether to 'move' their
 * dates with the stage or 'keep' them (body.assignments). Never silent.
 *
 * Roles: admin, production_manager.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { computeDateImpact, resolveChoice, scheduleWarnings, assignmentDatesAfterStageMove } from '@/shared/lib/production/stageSchedule';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { id: jobId, stageId } = params;

    const { data: job, error: jobErr } = await serviceClient
      .from('production_jobs')
      .select('id, status, production_due_date, production_plans(orders(due_date))')
      .eq('id', jobId)
      .single();
    if (jobErr && /production_due_date|column/i.test(jobErr.message || '')) {
      return NextResponse.json({ error: 'Scheduling is not available yet — run production_v2b and production_v2e', migration_pending: true }, { status: 503 });
    }
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (['Completed', 'Cancelled'].includes(job.status)) {
      return NextResponse.json({ error: `Job is ${job.status} and cannot be rescheduled` }, { status: 409 });
    }

    const { data: stageRows, error: stErr } = await serviceClient
      .from('production_job_stages')
      .select('id, stage_key, sort_order, status, is_enabled, production_job_stage_schedules(planned_start_date, planned_end_date)')
      .eq('job_id', jobId)
      .eq('is_enabled', true)
      .order('sort_order');
    if (stErr) {
      if (/production_job_stage_schedules/i.test(stErr.message || '')) {
        return NextResponse.json({ error: 'Scheduling is not available yet — run production_v2b and production_v2e', migration_pending: true }, { status: 503 });
      }
      console.error('Stage schedule POST (stages):', stErr.message);
      return NextResponse.json({ error: 'Failed to load stages' }, { status: 500 });
    }

    const stages = (stageRows || []).map((s) => {
      const sch = Array.isArray(s.production_job_stage_schedules) ? s.production_job_stage_schedules[0] : s.production_job_stage_schedules;
      return {
        id: s.id, stage_key: s.stage_key, sort_order: s.sort_order, status: s.status,
        schedule: sch ? { start: sch.planned_start_date, end: sch.planned_end_date } : null,
      };
    });
    if (!stages.some((s) => s.id === stageId)) {
      return NextResponse.json({ error: 'Stage not found, or not enabled for this job' }, { status: 404 });
    }

    const impact = computeDateImpact(stages, stageId, { start: b.start, end: b.end });
    if (impact.error) return NextResponse.json({ error: impact.error }, { status: 400 });

    if (impact.needs_choice && !b.downstream) {
      return NextResponse.json({
        requires_choice: true,
        message: 'This change affects later stages. Choose how to handle them.',
        impact,
      }, { status: 409 });
    }

    const resolved = impact.needs_choice
      ? resolveChoice(impact, b.downstream, b.overrides)
      : { changes: [{ stage_id: stageId, start: b.start, end: b.end }] };
    if (resolved.error) return NextResponse.json({ error: resolved.error }, { status: 400 });

    // ── Worker assignment dates on the stages being changed ──────────────────
    // Never moved silently: if any assignment would move, the caller must say
    // 'move' or 'keep' (body.assignments).
    const oldByStage = new Map(stages.map((s) => [s.id, s.schedule]));
    const { data: asgRows, error: asgErr } = await serviceClient
      .from('production_job_assignments')
      .select('id, stage_id, planned_start_date, planned_end_date, employees(name)')
      .eq('job_id', jobId)
      .in('stage_id', resolved.changes.map((c) => c.stage_id))
      .in('status', ['Assigned', 'In Progress'])
      .not('planned_start_date', 'is', null);
    if (asgErr && !/stage_id|planned_start_date|column/i.test(asgErr.message || '')) {
      console.error('Stage schedule POST (assignments):', asgErr.message);
      return NextResponse.json({ error: 'Failed to load worker assignments' }, { status: 500 });
    }
    const newByStage = new Map(resolved.changes.map((c) => [c.stage_id, { start: c.start, end: c.end }]));
    const stageKeyById = new Map(stages.map((s) => [s.id, s.stage_key]));
    const proposals = [];
    for (const a of asgRows || []) {
      const next = assignmentDatesAfterStageMove(a, oldByStage.get(a.stage_id), newByStage.get(a.stage_id));
      if (next) {
        proposals.push({
          assignment_id: a.id, stage_id: a.stage_id, stage_key: stageKeyById.get(a.stage_id),
          employee_name: a.employees?.name ?? null,
          start: a.planned_start_date, end: a.planned_end_date, new_start: next.start, new_end: next.end,
        });
      }
    }
    if (proposals.length && !['move', 'keep'].includes(b.assignments)) {
      return NextResponse.json({
        requires_choice: true,
        message: 'Workers are assigned on dates that no longer match the stage. Choose whether their dates move with it.',
        impact, downstream_choice: b.downstream || null,
        assignment_impact: proposals,
      }, { status: 409 });
    }
    const assignmentChanges = b.assignments === 'move'
      ? proposals.map((p) => ({ assignment_id: p.assignment_id, start: p.new_start, end: p.new_end }))
      : null;

    const { data, error } = await serviceClient.rpc('apply_stage_schedules', {
      p_job_id: jobId, p_changes: resolved.changes, p_actor: user.id,
      p_assignment_changes: assignmentChanges,
    });
    if (error) {
      if (error.code === 'PGRST202' || /apply_stage_schedules/i.test(error.message || '') && /not find|does not exist/i.test(error.message || '')) {
        return NextResponse.json({ error: 'Scheduling is not available yet — run production_v2b_stage_schedules.sql', migration_pending: true }, { status: 503 });
      }
      if (error.code === 'P0001' || error.code === 'P0002') {
        return NextResponse.json({ error: error.message }, { status: error.code === 'P0002' ? 404 : 409 });
      }
      console.error('Stage schedule POST rpc:', error.message);
      return NextResponse.json({ error: 'Failed to save schedule' }, { status: 500 });
    }

    // Advisory warnings on the resulting plan.
    const changed = new Map(resolved.changes.map((c) => [c.stage_id, c]));
    const final = stages
      .map((s) => {
        const c = changed.get(s.id);
        const sch = c ? { start: c.start, end: c.end } : s.schedule;
        return sch ? { stage_key: s.stage_key, sort_order: s.sort_order, start: sch.start, end: sch.end } : null;
      })
      .filter(Boolean);
    const customer = job.production_plans?.orders?.due_date || null;
    const warnings = scheduleWarnings(final, { production_due_date: job.production_due_date, customer_due_date: customer });
    if (b.downstream === 'keep') {
      for (const d of impact.downstream.filter((x) => x.overlaps)) {
        warnings.push({ code: 'kept_overlap', stage_key: d.stage_key, message: `${d.stage_key} was left where it was and now overlaps the moved stage` });
      }
    }

    if (b.assignments === 'keep') {
      for (const p of proposals) {
        warnings.push({
          code: 'assignment_dates_kept', message: `${p.employee_name || 'A worker'} stays booked ${p.start} – ${p.end}, which no longer matches the ${p.stage_key} stage dates`,
        });
      }
    }

    return NextResponse.json({ ...data, applied_changes: resolved.changes, warnings });
  } catch (err) {
    console.error('Stage schedule POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
