/**
 * POST /api/production/jobs/:id/blocker/resolve
 * Body: { blocker_id, note? }
 *
 * Resolves one blocker (records who and when). Never moves dates or changes
 * status. Returns { remaining_open, has_schedules, review_dates } — review_dates
 * is true when the job has stage schedules, so the UI can ask the manager
 * whether to review them. Roles: admin, production_manager.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!b.blocker_id) return NextResponse.json({ error: 'blocker_id is required' }, { status: 400 });

    // The blocker must belong to the job in the URL (the RPC only knows the blocker).
    const { data: row, error: rowErr } = await serviceClient
      .from('production_job_blockers').select('id, job_id').eq('id', b.blocker_id).maybeSingle();
    if (rowErr && (rowErr.code === '42P01' || /does not exist/i.test(rowErr.message || ''))) {
      return NextResponse.json({ error: 'Blockers are not available yet — run production_v2c_blockers.sql', migration_pending: true }, { status: 503 });
    }
    if (!row || row.job_id !== params.id) return NextResponse.json({ error: 'Blocker not found for this job' }, { status: 404 });

    const { data, error } = await serviceClient.rpc('resolve_job_blocker', {
      p_blocker_id: b.blocker_id, p_note: b.note || null, p_actor: user.id,
    });
    if (error) {
      if (error.code === 'P0001' || error.code === 'P0002') {
        return NextResponse.json({ error: error.message }, { status: error.code === 'P0002' ? 404 : 409 });
      }
      console.error('Blocker resolve rpc:', error.message);
      return NextResponse.json({ error: 'Failed to resolve blocker' }, { status: 500 });
    }
    return NextResponse.json({ ...data, review_dates: !!data.has_schedules });
  } catch (err) {
    console.error('Blocker resolve unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
