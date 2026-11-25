/**
 * GET    /api/payroll/employees/:id  — get single employee
 * PATCH  /api/payroll/employees/:id  — update employee
 * DELETE /api/payroll/employees/:id  — deactivate only (never hard-delete; history is permanent)
 *
 * Access: admin, head_of_sales, production_manager (see shared/lib/payroll/employeeAccess.js).
 *   admin     edits directly.
 *   managers  activate/deactivate directly; every other change is saved as a CHANGE REQUEST
 *             (202, status 'pending') that an admin approves in /api/payroll/employee-changes.
 *             The request records the old value, so the approver sees old → new.
 * Employee documents are admin-only.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import {
  EMPLOYEE_COLUMNS, employeeAccessLevel, canSeeEmployeeDocuments,
  splitEmployeeUpdate, diffEmployeeChanges, normaliseEmployeeValue,
} from '@/shared/lib/payroll/employeeAccess';
import { isValidIsoDate } from '@/shared/lib/isoDate';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];
const DATE_FIELDS = new Set(['hire_date']);

export async function GET(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data: emp, error } = await serviceClient
      .from('employees')
      .select(EMPLOYEE_COLUMNS[employeeAccessLevel(role)])
      .eq('id', params.id)
      .single();

    if (error || !emp) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    let docs = [];
    if (canSeeEmployeeDocuments(role)) {
      const { data } = await serviceClient
        .from('employee_documents')
        .select('*')
        .eq('employee_id', params.id)
        .order('uploaded_at', { ascending: false });
      docs = data || [];
    }

    // Pending change requests for this employee (so the screen can show "awaiting approval").
    const { data: pending } = await serviceClient
      .from('employee_change_requests')
      .select('id, changes, reason, requested_by_name, requested_at')
      .eq('employee_id', params.id)
      .eq('status', 'pending')
      .order('requested_at', { ascending: false });

    return NextResponse.json({ employee: emp, documents: docs, pendingChanges: pending || [] });
  } catch (err) {
    console.error('GET /api/payroll/employees/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Expected an employee object' }, { status: 400 });
    }
    const { direct, requested } = splitEmployeeUpdate(role, body);

    if (direct.length === 0 && requested.length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }
    if (direct.length && requested.length) {
      return NextResponse.json({ error: 'Save activation separately from a change request.', code: 'MIXED_UPDATE' }, { status: 422 });
    }
    if (direct.includes('is_active') && typeof body.is_active !== 'boolean') {
      return NextResponse.json({ error: 'is_active must be a boolean' }, { status: 400 });
    }
    const { data: current, error: currentError } = await serviceClient
      .from('employees').select(EMPLOYEE_COLUMNS.full).eq('id', params.id).single();
    if (currentError && currentError.code !== 'PGRST116') {
      return NextResponse.json({ error: 'Failed to load employee' }, { status: 500 });
    }
    if (!current) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    if (current.onboarding_status !== 'approved') {
      return NextResponse.json({ error: 'This employee is not approved for payroll.', code: 'EMPLOYEE_ONBOARDING_REQUIRED' }, { status: 409 });
    }

    // ── Direct updates (admin: everything; manager: is_active only) ─────────
    let emp = null;
    if (direct.length > 0) {
      const updates = {};
      for (const key of direct) {
        const val = body[key];
        updates[key] = key === 'is_active' ? !!val : normaliseEmployeeValue(key, val);
        if (Number.isNaN(updates[key]) || (key === 'sha_amount' && updates[key] === null)
          || (key === 'type' && !['casual', 'permanent', 'skilled_casual'].includes(updates[key]))
          || (DATE_FIELDS.has(key) && updates[key] !== null && !isValidIsoDate(updates[key]))) {
          return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 });
        }
        if (key === 'name' && !updates[key]) {
          return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
        }
      }

      const { data, error } = await serviceClient
        .from('employees')
        .update(updates)
        .eq('id', params.id)
        .select(EMPLOYEE_COLUMNS[employeeAccessLevel(role)])
        .single();

      if (error || !data) {
        console.error('PATCH /api/payroll/employees/[id] error:', error?.message);
        return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
      }
      emp = data;

      await serviceClient.from('payroll_activities').insert({
        entity_type:   'employee',
        entity_id:     params.id,
        activity_type: 'updated',
        description:   `Employee ${emp.name} updated by ${displayName}`,
        new_value:     JSON.stringify(Object.keys(updates)),
        created_by:    user.id,
      });
    }

    // ── Manager changes → request for admin approval ────────────────────────
    let changeRequest = null;
    if (requested.length > 0) {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 3) {
        return NextResponse.json(
          { error: 'Give a reason for the change (the admin will see it when approving)', code: 'REASON_REQUIRED' },
          { status: 422 },
        );
      }

      const { changes, invalid } = diffEmployeeChanges(current, body, requested);
      if (invalid.length > 0) {
        return NextResponse.json({ error: `Invalid value for: ${invalid.join(', ')}`, code: 'INVALID_VALUE' }, { status: 400 });
      }
      if (changes.type && !['casual', 'permanent', 'skilled_casual'].includes(changes.type.new)) {
        return NextResponse.json({ error: 'Invalid employee type', code: 'INVALID_VALUE' }, { status: 400 });
      }
      for (const f of Object.keys(changes)) {
        if ((DATE_FIELDS.has(f) && changes[f].new !== null && !isValidIsoDate(changes[f].new))
          || (f === 'sha_amount' && changes[f].new === null)) {
          return NextResponse.json({ error: `Invalid date for ${f}`, code: 'INVALID_VALUE' }, { status: 400 });
        }
      }

      if (Object.keys(changes).length === 0) {
        if (direct.length === 0) {
          return NextResponse.json({ error: 'Nothing has changed', code: 'NO_CHANGE' }, { status: 400 });
        }
      } else {
        const { data: reqRow, error: reqErr } = await serviceClient
          .from('employee_change_requests')
          .insert({
            employee_id:       params.id,
            changes,
            reason,
            status:            'pending',
            requested_by:      user.id,
            requested_by_name: displayName || null,
            requested_by_role: role,
          })
          .select('id, changes, reason, status, requested_at')
          .single();

        if (reqErr || !reqRow) {
          console.error('PATCH /api/payroll/employees/[id] request error:', reqErr?.message);
          return NextResponse.json({ error: 'Failed to log the change request' }, { status: 500 });
        }
        changeRequest = reqRow;

        await serviceClient.from('payroll_activities').insert({
          entity_type:   'employee',
          entity_id:     params.id,
          activity_type: 'change_requested',
          description:   `Change to ${current.employee_num} ${current.name} requested by ${displayName} (${role}): ${Object.keys(changes).join(', ')} — ${reason}`,
          old_value:     JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.old]))),
          new_value:     JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.new]))),
          created_by:    user.id,
        });
      }
      if (!emp) emp = current;
    }

    return NextResponse.json(
      { employee: emp, ...(changeRequest ? { changeRequest, message: 'Change logged. It takes effect when an admin approves it.' } : {}) },
      { status: changeRequest ? 202 : 200 },
    );
  } catch (err) {
    console.error('PATCH /api/payroll/employees/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { user, role, displayName } = await getAuthContext();
    // Admin, Head of Sales and PM can deactivate employees
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    // Always deactivate — never hard delete employees.
    // Payroll history (entries, payments, attendance) is an immutable audit record.
    const { data: emp, error } = await serviceClient
      .from('employees')
      .update({ is_active: false })
      .eq('id', params.id)
      .select('name, employee_num')
      .single();

    if (error || !emp) {
      return NextResponse.json({ error: 'Employee not found or deactivation failed' }, { status: 500 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'employee',
      entity_id:     params.id,
      activity_type: 'deactivated',
      description:   `Employee ${emp.employee_num} ${emp.name} deactivated by ${displayName}`,
      created_by:    user.id,
    });

    return NextResponse.json({
      success: true,
      action:  'deactivated',
      message: 'Employee deactivated. Payroll history is preserved.',
    });
  } catch (err) {
    console.error('DELETE /api/payroll/employees/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
