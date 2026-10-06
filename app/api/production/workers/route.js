/**
 * GET /api/production/workers
 *
 * Active workers plus what the assignment modal needs to be honest about load:
 *   - recent_operations: operations they have ACTUALLY been assigned before
 *     (derived from history — employees have no skills field, none is invented)
 *   - week_hours: planned hours this Mon–Sat (8 h/day capacity)
 *   - assignments: compact active assignments, so the modal can warn about
 *     overlaps live using the same pure helper the server uses
 *
 * If production_v2a_stage_assignments.sql has not been applied the response
 * says so (migration_pending) instead of failing.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { weeklyHours, CAPACITY_HOURS_PER_DAY } from '@/shared/lib/production/workerLoad';

function mondayOf(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay();                       // 0 = Sun
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return x.toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'production_staff']);
    if (authError) return authError;

    const { data: employees, error: empErr } = await serviceClient
      .from('employees')
      .select('id, name, employee_num, type')
      .eq('is_active', true)
      .order('name');
    if (empErr) {
      console.error('Production workers GET (employees):', empErr.message);
      return NextResponse.json({ error: 'Failed to load workers' }, { status: 500 });
    }

    const { data: rows, error: asgErr } = await serviceClient
      .from('production_job_assignments')
      .select('id, employee_id, job_id, stage_id, operation_id, assigned_quantity, assignment_mode, status, planned_start_date, planned_end_date, planned_hours_per_day, production_jobs(job_num), production_operations(name)')
      .neq('status', 'Removed');

    const migrationPending = !!asgErr;
    const assignments = (rows || []).map((r) => ({
      id: r.id, employee_id: r.employee_id, job_id: r.job_id, job_num: r.production_jobs?.job_num ?? null,
      stage_id: r.stage_id, operation_id: r.operation_id, operation_name: r.production_operations?.name ?? null,
      assigned_quantity: r.assigned_quantity, assignment_mode: r.assignment_mode, status: r.status,
      planned_start_date: r.planned_start_date, planned_end_date: r.planned_end_date,
      planned_hours_per_day: r.planned_hours_per_day,
    }));

    const week = mondayOf();
    const workers = (employees || []).map((e) => {
      const mine = assignments.filter((a) => a.employee_id === e.id);
      return {
        ...e,
        recent_operations: [...new Set(mine.map((a) => a.operation_name).filter(Boolean))],
        week_hours: weeklyHours(mine, e.id, week),
        week_capacity: CAPACITY_HOURS_PER_DAY * 6,
      };
    });

    return NextResponse.json({ workers, assignments, week_start: week, migration_pending: migrationPending });
  } catch (err) {
    console.error('Production workers GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
