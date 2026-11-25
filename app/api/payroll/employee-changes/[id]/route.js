/**
 * POST /api/payroll/employee-changes/:id   body: { action: 'approve' | 'reject', note?: string }
 *
 * ADMIN ONLY. Approving applies the requested change to the employee (rate, phone, bank, SHA,
 * NSSF ...) and logs it, in one database transaction (approve_employee_change). If the employee's
 * value has changed since the request was made, approval is refused (409 STALE_REQUEST) and the
 * request is marked stale: reject it and ask for a fresh request.
 * Rejecting requires a note.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { canDecideEmployeeChange } from '@/shared/lib/payroll/employeeAccess';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;
    if (!canDecideEmployeeChange(role)) {
      return NextResponse.json({ error: 'Only an admin can decide change requests' }, { status: 403 });
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    const action = body?.action;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';
    if (!['approve', 'reject'].includes(action)) {
      return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
    }
    if (action === 'reject' && note.length < 3) {
      return NextResponse.json({ error: 'Give a reason for rejecting', code: 'NOTE_REQUIRED' }, { status: 422 });
    }

    const fn = action === 'approve' ? 'approve_employee_change' : 'reject_employee_change';
    const { data, error } = await serviceClient.rpc(fn, {
      p_request_id:      params.id,
      p_decided_by:      user.id,
      p_decided_by_name: displayName || null,
      p_note:            note || null,
    });

    if (error) {
      const msg = String(error.message || '');
      if (msg.includes('REQUEST_NOT_FOUND')) return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
      if (msg.includes('NOT_PENDING')) return NextResponse.json({ error: 'This request has already been decided', code: 'NOT_PENDING' }, { status: 409 });
      if (msg.includes('INVALID_FIELD') || msg.includes('violates') || msg.includes('check')) {
        return NextResponse.json({ error: 'The requested value is not valid, so nothing was applied.', code: 'INVALID_VALUE' }, { status: 422 });
      }
      console.error(`${fn} failed:`, params.id, msg);
      return NextResponse.json({ error: 'Failed to record the decision' }, { status: 500 });
    }

    if (data?.status === 'stale') {
      return NextResponse.json(
        { error: 'The employee record changed. Nothing was applied. Ask for a fresh request.', code: 'STALE_REQUEST' },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, result: data });
  } catch (err) {
    console.error('POST /api/payroll/employee-changes/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
