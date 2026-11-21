/**
 * GET  /api/payroll/temporary/engagements   list (optional ?status=), each with its unsettled-work summary
 * POST /api/payroll/temporary/engagements   create (database function checks role, worker, overlap)
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { ENGAGEMENT_COLUMNS, ENGAGEMENT_JOINS, isUuid, isIsoDate, positiveNumber } from '@/shared/lib/payroll/temporaryAccess';

const STATUSES = ['planned', 'active', 'completed', 'cancelled'];

export async function GET(request) {
  const g = await guard(); if (g.error) return g.error;
  try {
    const status = new URL(request.url).searchParams.get('status');
    let q = serviceClient.from('temporary_worker_engagements')
      .select(`${ENGAGEMENT_COLUMNS}, ${ENGAGEMENT_JOINS}`).order('created_at', { ascending: false }).limit(300);
    if (status) { if (!STATUSES.includes(status)) return bad('Unknown status'); q = q.eq('status', status); }
    const { data, error } = await q;
    if (error) return dbError(error);
    // ONE call for every engagement that can have unsettled work (not N calls).
    const ids = (data || []).filter(e => e.status === 'active' || e.status === 'completed').map(e => e.id);
    let dueById = {};
    if (ids.length) {
      const { data: due, error: dueErr } = await serviceClient.rpc('temporary_engagements_due', { p_ids: ids });
      if (dueErr) return dbError(dueErr);
      dueById = due || {};
    }
    const rows = (data || []).map(e => ({ ...e, due: dueById[e.id] || null }));
    return NextResponse.json({ engagements: rows });
  } catch (err) { console.error('GET temporary engagements:', err); return NextResponse.json({ error: 'Internal server error' }, { status: 500 }); }
}

export async function POST(request) {
  const g = await guard(); if (g.error) return g.error;
  const b = await readJson(request);
  if (!isUuid(b.employee_id)) return bad('Choose a worker.');
  if (!isUuid(b.order_id)) return bad('Choose a project.');
  if (!positiveNumber(b.agreed_daily_rate)) return bad('Enter the agreed daily rate (above 0).');
  if (!isIsoDate(b.start_date)) return bad('Enter a start date.');
  if (b.expected_end_date && !isIsoDate(b.expected_end_date)) return bad('Enter a valid end date.');
  if (b.max_days != null && b.max_days !== '' && !positiveNumber(b.max_days)) return bad('Maximum days must be above 0.');
  return rpc('create_temporary_engagement', {
    p_employee: b.employee_id, p_order: b.order_id, p_rate: Number(b.agreed_daily_rate), p_start: b.start_date,
    p_end: b.expected_end_date || null, p_max_days: b.max_days ? Number(b.max_days) : null,
    p_notes: typeof b.notes === 'string' ? b.notes.slice(0, 500) : null, p_activate: b.activate !== false,
    p_actor: g.user.id, p_role: g.role,
  }, 201);
}
