/**
 * app/api/production/jobs/route.js
 *
 * GET  /api/production/jobs   — shop-floor job list with embedded plan/order/assignment data
 *
 * Query params:
 *   status      "all_active" (default) | any production_jobs.status value | "all"
 *   employee_id  uuid — filter to jobs assigned to this worker
 *   plan_id      uuid — filter to jobs in this plan
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ACTIVE_STATUSES = [
  'Planned',
  'Awaiting Materials',
  'Materials Ready',
  'In Production',
  'Quality Control',
  'Paused',
];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const statusParam   = searchParams.get('status')      || 'all_active';
    const employeeId    = searchParams.get('employee_id') || null;
    const planId        = searchParams.get('plan_id')     || null;

    // ── Build base query ──────────────────────────────────────────────────────
    let query = serviceClient
      .from('production_jobs')
      .select(`
        id, job_num, plan_id, order_id, order_item_id,
        category, description, size, finish_type, finish_color, wood_type,
        production_instructions,
        planned_quantity,
        in_production_qty, awaiting_qc_qty, rework_qty, accepted_qty, scrapped_qty,
        status, priority, blocker_reason,
        planned_start, planned_finish, actual_start, actual_finish,
        cancelled_at, cancelled_reason, completed_at,
        created_at, updated_at,
        production_plans(
          id, status,
          orders(id, order_num, client, due_date)
        ),
        production_job_assignments(
          id, assigned_quantity, status,
          operation_id,
          employees(id, name),
          production_operations(id, name, code)
        )
      `)
      .order('priority',      { ascending: false })
      .order('planned_finish', { ascending: true,  nullsFirst: false })
      .order('created_at',    { ascending: true });

    // Status filter
    if (statusParam === 'all_active') {
      query = query.in('status', ACTIVE_STATUSES);
    } else if (statusParam !== 'all') {
      query = query.eq('status', statusParam);
    }

    // Plan filter
    if (planId) {
      query = query.eq('plan_id', planId);
    }

    const { data: jobs, error } = await query;
    if (error) {
      console.error('Production jobs GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch production jobs' }, { status: 500 });
    }

    // ── Fetch stage data (separate query — degrades gracefully if table absent) ─
    //
    // production_job_stages is created by migration production_v1e_stages.sql.
    // We query it separately so the board still loads before that migration runs.
    let stagesByJobId = {};
    try {
      const jobIds = (jobs || []).map(j => j.id);
      if (jobIds.length > 0) {
        const { data: stages, error: stagesErr } = await serviceClient
          .from('production_job_stages')
          .select(`
            id, job_id, stage_key, stage_label, sort_order,
            is_enabled, status,
            planned_quantity, completed_quantity,
            rework_received_quantity, rework_completed_quantity,
            started_at, completed_at
          `)
          .in('job_id', jobIds)
          .order('sort_order', { ascending: true });

        if (!stagesErr && stages) {
          for (const s of stages) {
            if (!stagesByJobId[s.job_id]) stagesByJobId[s.job_id] = [];
            stagesByJobId[s.job_id].push(s);
          }
        }
        // Silently swallow error — table may not exist yet (migration pending)
        if (stagesErr) {
          console.warn('production_job_stages not available (migration pending?):', stagesErr.message);
        }
      }
    } catch (stagesEx) {
      console.warn('Stages fetch skipped:', stagesEx.message);
    }

    // Production due date (v2b). Separate, tolerant query so the list still loads
    // before production_v2b_stage_schedules.sql has been applied.
    const dueByJobId = {};
    try {
      const ids = (jobs || []).map(j => j.id);
      if (ids.length > 0) {
        const { data: dues, error: dueErr } = await serviceClient
          .from('production_jobs')
          .select('id, production_due_date')
          .in('id', ids);
        if (!dueErr) for (const d of dues || []) dueByJobId[d.id] = d.production_due_date;
      }
    } catch (dueEx) {
      console.warn('production_due_date fetch skipped:', dueEx.message);
    }

    // Attach stages to each job
    const jobsWithStages = (jobs || []).map(j => ({
      ...j,
      production_due_date: dueByJobId[j.id] ?? null,
      production_job_stages: stagesByJobId[j.id] || [],
    }));

    // ── Employee filter (post-query, because it's via assignments join) ───────
    let result = jobsWithStages;
    if (employeeId) {
      result = result.filter(j =>
        (j.production_job_assignments || []).some(a => a.employees?.id === employeeId)
      );
    }

    // ── Compute summary stats ─────────────────────────────────────────────────
    const allActiveJobs = jobsWithStages.filter(j => ACTIVE_STATUSES.includes(j.status));

    const stats = {
      // Jobs currently being worked on (In Production + Quality Control + Paused)
      active_count: allActiveJobs.filter(j =>
        ['In Production', 'Quality Control', 'Paused'].includes(j.status)
      ).length,
      active_orders: new Set(
        allActiveJobs
          .filter(j => ['In Production', 'Quality Control', 'Paused'].includes(j.status))
          .map(j => j.order_id)
      ).size,
      active_units: allActiveJobs
        .filter(j => ['In Production', 'Quality Control', 'Paused'].includes(j.status))
        .reduce((s, j) => s + (j.in_production_qty + j.awaiting_qc_qty + j.rework_qty), 0),

      // Awaiting materials
      awaiting_materials_count: allActiveJobs.filter(j => j.status === 'Awaiting Materials').length,
      awaiting_materials_blocked: allActiveJobs.filter(
        j => j.status === 'Awaiting Materials' && j.blocker_reason
      ).length,

      // Accepted / ready for delivery
      accepted_units: allActiveJobs.reduce((s, j) => s + j.accepted_qty, 0),
      accepted_jobs:  allActiveJobs.filter(j => j.accepted_qty > 0).length,
    };

    return NextResponse.json({ jobs: result, stats });
  } catch (err) {
    console.error('Production jobs GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
