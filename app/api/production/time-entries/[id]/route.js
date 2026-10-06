/**
 * POST /api/production/time-entries/:id    body { action: submit|approve|reject|void, note? }
 *
 * Workflow only — the hours, rates and cost of an entry can never be edited.
 * A mistake is corrected by voiding (admin) and recording a new entry.
 * Role checks are enforced here AND inside transition_time_entry().
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
    let b; try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!['submit', 'approve', 'reject', 'void'].includes(b.action)) {
      return NextResponse.json({ error: 'action must be submit, approve, reject or void' }, { status: 400 });
    }
    const { data, error } = await serviceClient.rpc('transition_time_entry', {
      p_entry_id: params.id, p_action: b.action, p_actor: user.id, p_actor_role: role,
      p_note: typeof b.note === 'string' ? b.note.slice(0, 300) : null,
    });
    if (error) {
      if (error.code === 'PGRST202') return NextResponse.json({ error: 'Time entries are not available yet — run production_v3a_labour_costing.sql', migration_pending: true }, { status: 503 });
      return NextResponse.json({ error: error.message }, { status: /not found/i.test(error.message) ? 404 : 400 });
    }
    return NextResponse.json({ entry: data });
  } catch (err) {
    console.error('Time entry transition unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
