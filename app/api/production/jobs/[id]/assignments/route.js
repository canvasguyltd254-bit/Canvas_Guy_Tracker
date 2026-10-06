/**
 * app/api/production/jobs/[id]/assignments/route.js
 *
 * PUT /api/production/jobs/:id/assignments
 *   RETIRED (410). The old replace_job_assignments RPC rewrites every assignment on
 *   a job and would destroy stage-level assignments. Use POST below.
 *
 * POST /api/production/jobs/:id/assignments
 *   Stage-level assignment (the workflow the Gantt and Workshop views use).
 *   Delegates to assign_workers_to_stage(): the operation must belong to the
 *   stage, quantities obey the chosen assignment_mode, all in one transaction.
 *   Capacity (8 h/day, Mon-Sat) is ADVISORY: conflicts come back as `warnings`
 *   and never block the save.
 *
 *   Saves the WHOLE (job, stage, operation) group atomically: listed workers are created or
 *   updated, active workers not listed are marked Removed (history kept). One mode per group.
 *   Body: { stage_id, operation_id, assignment_mode: 'working_together'|'split_quantity',
 *           workers: [{ employee_id, assigned_quantity }],
 *           planned_start_date, planned_end_date, planned_hours_per_day }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { canSeeLabourCost } from '@/shared/lib/production/labourCosting';
import { conflictsCausedBy, CAPACITY_HOURS_PER_DAY } from '@/shared/lib/production/workerLoad';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function PUT() {
  // Retired: replace_job_assignments rewrites ALL of a job's assignments and would
  // wipe stage-level assignments (stage, mode, dates, hours). Use POST, which
  // assigns workers to one stage with validation.
  return NextResponse.json(
    { error: 'This endpoint has been retired. Assign workers per stage with POST /api/production/jobs/:id/assignments.' },
    { status: 410 },
  );
}

export async function POST(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!b.stage_id || !b.operation_id) {
      return NextResponse.json({ error: 'stage_id and operation_id are required' }, { status: 400 });
    }
    if (!ISO.test(b.planned_start_date || '') || !ISO.test(b.planned_end_date || '')) {
      return NextResponse.json({ error: 'planned_start_date and planned_end_date must be YYYY-MM-DD' }, { status: 400 });
    }
    const hpd = Number(b.planned_hours_per_day);
    if (!Array.isArray(b.workers) || b.workers.length === 0) {
      return NextResponse.json({ error: 'Select at least one worker (use DELETE to clear the group)' }, { status: 400 });
    }

    const { data, error } = await serviceClient.rpc('assign_workers_to_stage', {
      p_job_id:        jobId,
      p_stage_id:      b.stage_id,
      p_operation_id:  b.operation_id,
      p_mode:          b.assignment_mode,
      p_workers:       b.workers.map((w) => {
        const o = { employee_id: w.employee_id, assigned_quantity: Number(w.assigned_quantity) };
        // Planned days are optional; when omitted the saved plan is kept. Rates are never accepted from the browser.
        for (const k of ['planned_attendance_units', 'planned_overtime_days', 'planned_sunday_units']) {
          if (w[k] !== undefined && w[k] !== null && w[k] !== '') o[k] = Number(w[k]);
        }
        return o;
      }),
      p_start:         b.planned_start_date,
      p_end:           b.planned_end_date,
      p_hours_per_day: hpd,
      p_assigned_by:   user.id,
    });

    if (error) {
      // RPC validation messages are written to be user-readable.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Advisory capacity warnings, computed from persisted assignments.
    const ids = data?.assignment_ids || [];
    let warnings = [];
    const employeeIds = [...new Set(b.workers.map((w) => w.employee_id))];
    const { data: rows } = await serviceClient
      .from('production_job_assignments')
      .select('id, employee_id, job_id, status, planned_start_date, planned_end_date, planned_hours_per_day, production_jobs(job_num)')
      .in('employee_id', employeeIds)
      .neq('status', 'Removed')
      .not('planned_start_date', 'is', null)
      .lte('planned_start_date', b.planned_end_date)
      .gte('planned_end_date', b.planned_start_date);
    const all = (rows || []).map((r) => ({ ...r, job_num: r.production_jobs?.job_num }));
    const proposed = all.filter((r) => ids.includes(r.id));
    const existing = all.filter((r) => !ids.includes(r.id));
    warnings = conflictsCausedBy(existing, proposed, CAPACITY_HOURS_PER_DAY);

    if (data?.outside_stage_schedule) {
      warnings = [...warnings, { code: 'outside_stage_schedule', message: `These dates fall outside the stage schedule (${data.stage_start} – ${data.stage_end})` }];
    } else if (data && data.stage_scheduled === false) {
      warnings = [...warnings, { code: 'stage_not_scheduled', message: 'This stage has no schedule yet — schedule it so the workers\' dates can be checked against it' }];
    }

    return NextResponse.json({ assignment_ids: ids, removed_ids: data?.removed_ids || [], warnings }, { status: 201 });
  } catch (err) {
    console.error('Job assignments POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/production/jobs/:id/assignments[?stage_id=]
 * The active assignment GROUPS on a job (one per stage + operation), with each
 * worker's quantity, mode, dates and hours — what the "Adjust team" modal prefills from.
 * Roles: admin, production_manager, head_of_sales, production_staff.
 */
export async function GET(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;

    const stageId = new URL(request.url).searchParams.get('stage_id');
    const BASE = 'id, employee_id, stage_id, operation_id, assigned_quantity, assignment_mode, status, planned_start_date, planned_end_date, planned_hours_per_day, employees(name), production_operations(name, code)';
    const LABOUR = ', planned_attendance_units, planned_overtime_days, planned_sunday_units, daily_rate_snapshot, planned_labour_cost';
    const run = (sel) => {
      let q = serviceClient.from('production_job_assignments').select(sel).eq('job_id', params.id)
        .in('status', ['Assigned', 'In Progress']).not('stage_id', 'is', null);
      return stageId ? q.eq('stage_id', stageId) : q;
    };
    let { data, error } = await run(BASE + LABOUR);
    if (error && /planned_attendance_units|daily_rate_snapshot|planned_labour_cost/i.test(error.message || '')) {
      ({ data, error } = await run(BASE));          // v3a not applied yet
    }
    if (error) {
      if (/stage_id|assignment_mode|planned_start_date|column/i.test(error.message || '')) {
        return NextResponse.json({ groups: [], migration_pending: true });
      }
      console.error('Job assignments GET:', error.message);
      return NextResponse.json({ error: 'Failed to load assignments' }, { status: 500 });
    }
    const showCost = canSeeLabourCost(role);
    const groups = new Map();
    for (const a of data || []) {
      const key = `${a.stage_id}|${a.operation_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          stage_id: a.stage_id, operation_id: a.operation_id, operation_name: a.production_operations?.name ?? null,
          assignment_mode: a.assignment_mode, planned_start_date: a.planned_start_date, planned_end_date: a.planned_end_date,
          planned_hours_per_day: a.planned_hours_per_day, workers: [],
        });
      }
      groups.get(key).workers.push({
        assignment_id: a.id, employee_id: a.employee_id, employee_name: a.employees?.name ?? null, assigned_quantity: a.assigned_quantity, status: a.status,
        planned_attendance_units: a.planned_attendance_units ?? null, planned_overtime_days: a.planned_overtime_days ?? null,
        planned_sunday_units: a.planned_sunday_units ?? null,
        // Days are not confidential; rates and cost are — only managers receive them.
        rate_status: a.daily_rate_snapshot == null ? 'missing' : 'available',
        ...(showCost ? { daily_rate: a.daily_rate_snapshot ?? null, planned_labour_cost: a.planned_labour_cost ?? null } : {}),
      });
    }
    return NextResponse.json({ groups: [...groups.values()] });
  } catch (err) {
    console.error('Job assignments GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/production/jobs/:id/assignments   body { stage_id, operation_id }
 * Removes the whole group: every active worker is marked Removed (history kept).
 * Roles: admin, production_manager.
 */
export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!b.stage_id || !b.operation_id) return NextResponse.json({ error: 'stage_id and operation_id are required' }, { status: 400 });

    const { data, error } = await serviceClient.rpc('assign_workers_to_stage', {
      p_job_id: params.id, p_stage_id: b.stage_id, p_operation_id: b.operation_id,
      p_mode: 'split_quantity', p_workers: [], p_start: null, p_end: null, p_hours_per_day: null, p_assigned_by: user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ removed_ids: data?.removed_ids || [] });
  } catch (err) {
    console.error('Job assignments DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
