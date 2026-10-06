/**
 * GET /api/production/schedule
 *
 * Read-only data for the Workshop Gantt: every ACTIVE job with its enabled
 * stages, each stage's persisted schedule, stage-level worker assignments,
 * production due vs customer delivery due, and advisory worker conflicts.
 * The same persisted rows feed the job list and job detail — nothing here is
 * computed from progress, and nothing is written.
 *
 * Tolerant of the v2a / v2b migrations not being applied: it degrades to
 * whatever columns exist and reports `migration_pending`.
 *
 * Roles: admin, production_manager, head_of_sales, production_staff (view).
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { computeConflicts, CAPACITY_HOURS_PER_DAY } from '@/shared/lib/production/workerLoad';
import { jobAttention, DEFAULT_QC_WAITING_DAYS } from '@/shared/lib/production/attention';
import { stageAvailability } from '@/shared/lib/production/stageAvailability';
import { todayInNairobi } from '@/shared/lib/production/stageSchedule';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';

// Only released plans reach the shop floor. Draft/Cancelled/Completed plans stay out.
const FLOOR_PLAN_STATUSES = ['Active', 'Paused'];
const ACTIVE = ['Planned', 'Awaiting Materials', 'Materials Ready', 'In Production', 'Quality Control', 'Paused'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;

    const pending = { schedules: false, assignments: false, blockers: false, readiness: false };

    const jobSel = (withDue, withSch) => `
      id, job_num, description, category, status, priority, blocker_reason,
      planned_quantity, accepted_qty, awaiting_qc_qty, rework_qty,
      planned_start, planned_finish, ${withDue ? 'production_due_date,' : ''}
      production_plans(id, status, orders(id, order_num, client, due_date)),
      production_job_stages(
        id, stage_key, stage_label, sort_order, is_enabled, status,
        planned_quantity, completed_quantity
        ${withSch ? ', production_job_stage_schedules(planned_start_date, planned_end_date, status)' : ''}
      )`;

    let { data: jobs, error } = await serviceClient
      .from('production_jobs').select(jobSel(true, true)).in('status', ACTIVE)
      .order('priority', { ascending: false }).order('planned_finish', { ascending: true, nullsFirst: false });
    if (error && !isMissingSchema(error)) {
      console.error('Production schedule GET (jobs):', error.message);
      return NextResponse.json({ error: 'Failed to load schedule' }, { status: 500 });
    }
    if (error) {
      pending.schedules = true;
      ({ data: jobs, error } = await serviceClient
        .from('production_jobs').select(jobSel(false, false)).in('status', ACTIVE)
        .order('priority', { ascending: false }).order('planned_finish', { ascending: true, nullsFirst: false }));
    }
    if (error) {
      console.error('Production schedule GET (jobs):', error.message);
      return NextResponse.json({ error: 'Failed to load schedule' }, { status: 500 });
    }

    // Draft (unreleased) plans must not appear in any workshop view.
    jobs = (jobs || []).filter((j) => FLOOR_PLAN_STATUSES.includes(j.production_plans?.status));

    const { data: asg, error: asgErr } = await serviceClient
      .from('production_job_assignments')
      .select('id, employee_id, job_id, stage_id, assigned_quantity, status, planned_start_date, planned_end_date, planned_hours_per_day, employees(name), production_jobs(job_num)')
      .neq('status', 'Removed');
    if (asgErr && !isMissingSchema(asgErr)) { console.error('Production schedule GET (assignments):', asgErr.message); return NextResponse.json({ error: 'Failed to load assignments' }, { status: 500 }); }
    if (asgErr) pending.assignments = true;
    const assignments = (asg || []).map((a) => ({
      id: a.id, employee_id: a.employee_id, employee_name: a.employees?.name ?? null,
      job_id: a.job_id, job_num: a.production_jobs?.job_num ?? null, stage_id: a.stage_id,
      status: a.status, planned_start_date: a.planned_start_date, planned_end_date: a.planned_end_date,
      planned_hours_per_day: a.planned_hours_per_day,
    }));

    // ── Open blockers (v2c) — tolerant if the migration is not applied ────────
    const blockersByJob = {};
    const { data: bl, error: blErr } = await serviceClient
      .from('production_job_blockers')
      .select('id, job_id, stage_id, reason, owner_employee_id, expected_resolution_date, supplier_po_ref, notes, created_at, employees:owner_employee_id(name)')
      .is('resolved_at', null)
      .order('created_at', { ascending: false });
    if (blErr && !isMissingSchema(blErr)) { console.error('Production schedule GET (blockers):', blErr.message); return NextResponse.json({ error: 'Failed to load blockers' }, { status: 500 }); }
    if (blErr) pending.blockers = true;
    for (const b of bl || []) {
      (blockersByJob[b.job_id] ||= []).push({
        id: b.id, stage_id: b.stage_id, reason: b.reason, owner_employee_id: b.owner_employee_id,
        owner_name: b.employees?.name ?? null, expected_resolution_date: b.expected_resolution_date,
        supplier_po_ref: b.supplier_po_ref, notes: b.notes, created_at: b.created_at,
      });
    }

    // ── Material lines marked short (v2d) — tolerant ──────────────────────────
    const shortByJob = {};
    {
      const jobIds = (jobs || []).map((j) => j.id);
      if (jobIds.length) {
        const { data: sh, error: shErr } = await serviceClient
          .from('production_material_estimates')
          .select('id, job_id, material_name, short_note')
          .in('job_id', jobIds).eq('readiness', 'short');
        if (shErr && !isMissingSchema(shErr)) { console.error('Production schedule GET (readiness):', shErr.message); return NextResponse.json({ error: 'Failed to load material readiness' }, { status: 500 }); }
        if (shErr) pending.readiness = true;
        for (const m of sh || []) (shortByJob[m.job_id] ||= []).push({ id: m.id, material_name: m.material_name, short_note: m.short_note });
      }
    }

    // ── QC waiting: threshold setting + when units last entered QC ────────────
    let qcDays = DEFAULT_QC_WAITING_DAYS;
    try {
      const { data: st } = await serviceClient
        .from('admin_settings').select('value').eq('key', 'production_qc_waiting_days').maybeSingle();
      const n = st ? Number(st.value) : NaN;
      if (Number.isFinite(n) && n >= 0) qcDays = n;
    } catch { /* default */ }

    // Units enter QC when the last enabled stage before Packaging records an
    // advance (or finishes rework). Latest such event is the best available
    // "waiting since"; if none is found the helper reports "waiting time unknown".
    const qcSinceByJob = {};
    const qcJobs = (jobs || []).filter((j) => (j.awaiting_qc_qty || 0) > 0);
    if (qcJobs.length) {
      const { data: ev } = await serviceClient
        .from('production_stage_progress_entries')
        .select('job_id, stage_id, event_type, created_at')
        .in('job_id', qcJobs.map((j) => j.id))
        .in('event_type', ['advance', 'rework_completed'])
        .order('created_at', { ascending: false });
      for (const j of qcJobs) {
        const feeders = (j.production_job_stages || [])
          .filter((s) => s.is_enabled !== false && s.stage_key !== 'packaging')
          .sort((a, b) => b.sort_order - a.sort_order);
        const feeder = feeders[0];
        const hit = feeder && (ev || []).find((e) => e.job_id === j.id && e.stage_id === feeder.id);
        if (hit) qcSinceByJob[j.id] = hit.created_at.slice(0, 10);
      }
    }
    const today = todayInNairobi();

    const out = (jobs || []).map((j) => {
      const order = j.production_plans?.orders || null;
      const stages = (j.production_job_stages || [])
        .filter((s) => s.is_enabled !== false)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((s) => {
          const sch = Array.isArray(s.production_job_stage_schedules) ? s.production_job_stage_schedules[0] : s.production_job_stage_schedules;
          return {
            id: s.id, stage_key: s.stage_key, stage_label: s.stage_label, sort_order: s.sort_order, status: s.status,
            planned_quantity: s.planned_quantity, completed_quantity: s.completed_quantity,
            start: sch?.planned_start_date ?? null, end: sch?.planned_end_date ?? null,
            workers: assignments.filter((a) => a.stage_id === s.id).map((a) => a.employee_name).filter(Boolean),
          };
        });
      return {
        id: j.id, job_num: j.job_num, name: j.description || j.category || 'Untitled', status: j.status,
        priority: j.priority, blocker_reason: j.blocker_reason,
        order_id: order?.id ?? null, order_num: order?.order_num ?? null, client: order?.client ?? null,
        production_due_date: j.production_due_date ?? null,   // when production must finish
        customer_due_date: order?.due_date ?? null,           // when the customer expects delivery
        job_planned_start: j.planned_start, job_planned_finish: j.planned_finish,
        awaiting_qc_qty: j.awaiting_qc_qty || 0, rework_qty: j.rework_qty || 0,
        planned_quantity: j.planned_quantity, accepted_qty: j.accepted_qty || 0,
        short_lines: shortByJob[j.id] || [],
        blockers: blockersByJob[j.id] || [],
        stages,
      };
    });

    const conflicts = computeConflicts(
      assignments.filter((a) => out.some((j) => j.id === a.job_id)),
      CAPACITY_HOURS_PER_DAY,
    ).map((c) => ({
      ...c,
      employee_name: assignments.find((a) => a.employee_id === c.employee_id)?.employee_name ?? null,
    }));

    // Units ready to work at each stage (upstream completed − this completed).
    for (const job of out) {
      const av = Object.fromEntries(stageAvailability(job).map((a) => [a.stage_id, a.available]));
      for (const st of job.stages) st.available = av[st.id] ?? 0;
    }

    // One shared helper decides why a job needs attention (explicit reasons).
    for (const job of out) {
      job.attention = jobAttention(
        { ...job, stages: job.stages.map((st) => ({ ...st, stage_label: st.stage_label })) },
        {
          today,
          blockers: job.blockers.map((b) => ({ ...b, stage_label: null })),
          short_lines: job.short_lines,
          conflicts: conflicts.filter((c) => (c.job_ids || []).includes(job.id)),
          qc_since: qcSinceByJob[job.id] || null,
          qc_waiting_days: qcDays,
        },
      );
    }

    return NextResponse.json({
      jobs: out, conflicts, qc_waiting_days: qcDays, capacity_hours_per_day: CAPACITY_HOURS_PER_DAY,
      migration_pending: pending.schedules || pending.assignments || !!pending.blockers || !!pending.readiness,
      pending,
    });
  } catch (err) {
    console.error('Production schedule GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
