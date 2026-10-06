/**
 * GET  /api/production/time-entries?job_id=&employee_id=&status=&from=&to=
 * POST /api/production/time-entries
 *   body { assignment_id, work_date, attendance_units, has_overtime?, overtime_reason?, notes?, submit? }
 *   attendance_units = share of the worker's day booked to this job (0 < units <= 1). No hours are stored.
 *
 * Daily actual labour. A manager/admin records hours FOR a worker (workers have no
 * individual logins yet). All validation, rate snapshotting and costing happens in
 * record_time_entry() — the browser never supplies a rate or a cost.
 * Roles: admin, production_manager.
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';
import { todayInNairobi } from '@/shared/lib/production/stageSchedule';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PENDING = { error: 'Time entries are not available yet — run production_v3a_labour_costing.sql', migration_pending: true };
const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'voided'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    const sp = new URL(request.url).searchParams;
    let q = serviceClient.from('production_time_entries')
      .select('id, job_id, stage_id, operation_id, assignment_id, employee_id, work_date, attendance_units, has_overtime, is_sunday, overtime_reason, notes, status, recorded_by, recorded_at, approved_at, decision_note, void_reason, actual_labour_cost, employees(name), production_jobs(job_num), production_job_stages(stage_label)')
      .order('work_date', { ascending: false }).order('recorded_at', { ascending: false }).limit(500);
    if (sp.get('job_id')) q = q.eq('job_id', sp.get('job_id'));
    if (sp.get('employee_id')) q = q.eq('employee_id', sp.get('employee_id'));
    if (sp.get('status')) {
      const s = sp.get('status').split(',').filter((x) => STATUSES.includes(x));
      if (s.length) q = q.in('status', s);
    }
    if (ISO.test(sp.get('from') || '')) q = q.gte('work_date', sp.get('from'));
    if (ISO.test(sp.get('to') || '')) q = q.lte('work_date', sp.get('to'));
    const { data, error } = await q;
    if (error) {
      if (isMissingSchema(error)) return NextResponse.json(PENDING, { status: 503 });
      console.error('Time entries GET:', error.message);
      return NextResponse.json({ error: 'Failed to load time entries' }, { status: 500 });
    }
    return NextResponse.json({
      entries: (data || []).map((e) => ({
        ...e, employee_name: e.employees?.name ?? null, job_num: e.production_jobs?.job_num ?? null,
        stage_label: e.production_job_stages?.stage_label ?? null,
        rate_missing: e.actual_labour_cost == null,
        employees: undefined, production_jobs: undefined, production_job_stages: undefined,
      })),
    });
  } catch (err) {
    console.error('Time entries GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    let b; try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!b.assignment_id) return NextResponse.json({ error: 'assignment_id is required' }, { status: 400 });
    if (!ISO.test(b.work_date || '')) return NextResponse.json({ error: 'work_date must be YYYY-MM-DD' }, { status: 400 });
    const units = Number(b.attendance_units);
    if (!Number.isFinite(units)) return NextResponse.json({ error: 'attendance_units must be a number' }, { status: 400 });

    const { data, error } = await serviceClient.rpc('record_time_entry', {
      p_assignment_id: b.assignment_id, p_work_date: b.work_date,
      p_units: units, p_has_overtime: b.has_overtime === true,
      p_overtime_reason: typeof b.overtime_reason === 'string' ? b.overtime_reason.slice(0, 300) : null,
      p_notes: typeof b.notes === 'string' ? b.notes.slice(0, 500) : null,
      p_submit: b.submit !== false, p_actor: user.id, p_today: todayInNairobi(),
    });
    if (error) {
      if (error.code === 'PGRST202') return NextResponse.json(PENDING, { status: 503 });
      return NextResponse.json({ error: error.message }, { status: 400 });   // RPC messages are user-readable
    }
    return NextResponse.json({ entry: data }, { status: 201 });
  } catch (err) {
    console.error('Time entries POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
