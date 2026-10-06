/**
 * app/api/production/jobs/[id]/history/route.js
 *
 * GET /api/production/jobs/:id/history
 *
 * Returns production_progress_entries for a job, most-recent first.
 * Includes the recorded_by employee name via a join.
 *
 * Roles: admin, production_manager, head_of_sales, production_staff
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { data: entries, error } = await serviceClient
      .from('production_progress_entries')
      .select('id, transition, quantity, notes, recorded_at, recorded_by')
      .eq('job_id', jobId)
      .order('recorded_at', { ascending: false });

    if (error) {
      console.error('Progress history GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch progress history' }, { status: 500 });
    }

    return NextResponse.json({ entries: entries || [] });
  } catch (err) {
    console.error('Progress history GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
