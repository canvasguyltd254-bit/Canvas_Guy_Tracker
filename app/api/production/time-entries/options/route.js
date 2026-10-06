/**
 * GET /api/production/time-entries/options
 * Active assignments time can be booked to (job, stage, operation, worker), so the
 * entry form offers only valid targets. No rates or costs. Roles: admin, production_manager.
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    const { data, error } = await serviceClient.from('production_job_assignments')
      .select('id, employee_id, planned_start_date, planned_end_date, employees(name), production_operations(name), production_job_stages(stage_label, is_enabled), production_jobs(job_num, status, production_plans(status))')
      .in('status', ['Assigned', 'In Progress']).not('stage_id', 'is', null);
    if (error) {
      console.error('Time entry options:', error.message);
      return NextResponse.json({ error: 'Failed to load assignments' }, { status: 500 });
    }
    const options = (data || [])
      .filter((a) => a.production_job_stages?.is_enabled !== false
        && !['Cancelled', 'Completed'].includes(a.production_jobs?.status)
        && ['Active', 'Paused'].includes(a.production_jobs?.production_plans?.status))
      .map((a) => ({
        assignment_id: a.id, employee_id: a.employee_id, employee_name: a.employees?.name ?? null,
        job_num: a.production_jobs?.job_num ?? null, stage_label: a.production_job_stages?.stage_label ?? null,
        operation_name: a.production_operations?.name ?? null,
        planned_start_date: a.planned_start_date, planned_end_date: a.planned_end_date,
      }))
      .sort((x, y) => (x.job_num || '').localeCompare(y.job_num || '') || (x.employee_name || '').localeCompare(y.employee_name || ''));
    return NextResponse.json({ options });
  } catch (err) {
    console.error('Time entry options unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
