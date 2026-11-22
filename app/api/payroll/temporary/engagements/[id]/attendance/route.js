/**
 * GET  /api/payroll/temporary/engagements/:id/attendance   the days marked present on this engagement
 * POST /api/payroll/temporary/engagements/:id/attendance   { days: [{ date: 'YYYY-MM-DD', units: 1 | 0.5 | 0 }] }
 *
 * Days present are marked here, on the engagement, by admin / production manager / head of sales (like the Payroll attendance
 * grid). 1 = Full day, 0.5 = Half day, 0 = clear the day. The database function is the authority (engagement must be active,
 * no future days, nothing before the start date, nothing inside the worker's own payroll run, voiding keeps history).
 * Actor and role always come from the session, never the request body.
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { ATTENDANCE_COLUMNS, isUuid, validateAttendanceDays } from '@/shared/lib/payroll/temporaryAccess';

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data: eng, error: eErr } = await serviceClient.from('temporary_worker_engagements').select('id').eq('id', id).maybeSingle();
  if (eErr) return dbError(eErr);
  if (!eng) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });
  // Only active (not cleared) days; the cleared history stays in the database for audit.
  const { data, error } = await serviceClient.from('temporary_worker_attendance').select(ATTENDANCE_COLUMNS)
    .eq('engagement_id', id).eq('active', true).order('work_date');
  if (error) return dbError(error);
  return NextResponse.json({ days: data || [] });
}

export async function POST(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const msg = validateAttendanceDays(b.days);
  if (msg) return bad(msg);
  // Only the two fields we expect are forwarded.
  const days = b.days.map(d => ({ date: d.date, units: d.units }));
  return rpc('mark_temporary_attendance', { p_engagement: id, p_days: days, p_actor: g.user.id, p_role: g.role });
}
