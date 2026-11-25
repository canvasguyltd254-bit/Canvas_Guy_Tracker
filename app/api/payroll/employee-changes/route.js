/**
 * GET /api/payroll/employee-changes?status=pending|approved|rejected|stale|all
 *
 * The change-request log. Admin sees every request; Head of Sales / Production Manager see
 * requests (so they can follow up on their own and see what is waiting). Decisions are made in
 * /api/payroll/employee-changes/:id (admin only).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];
const STATUSES = ['pending', 'approved', 'rejected', 'stale'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const status = new URL(request.url).searchParams.get('status') || 'pending';
    if (status !== 'all' && !STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    let q = serviceClient
      .from('employee_change_requests')
      .select('id, employee_id, kind, changes, reason, status, requested_by, requested_by_name, requested_by_role, requested_at, decided_by_name, decided_at, decision_note, employees(employee_num, name, type)')
      .order('requested_at', { ascending: false })
      .limit(200);
    if (status !== 'all') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) {
      console.error('GET /api/payroll/employee-changes error:', error.message);
      return NextResponse.json({ error: 'Failed to load change requests' }, { status: 500 });
    }
    return NextResponse.json({ requests: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/employee-changes unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
