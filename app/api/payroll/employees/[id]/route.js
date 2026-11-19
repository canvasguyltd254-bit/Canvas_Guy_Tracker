/**
 * GET    /api/payroll/employees/:id  — get single employee
 * PATCH  /api/payroll/employees/:id  — update employee
 * DELETE /api/payroll/employees/:id  — deactivate only (never hard-delete; history is permanent)
 *
 * Access: admin, head_of_sales, production_manager — with different visibility
 * (see shared/lib/payroll/employeeAccess.js). Pay basis (type), salary, statutory
 * numbers, phone, banking, notes and employee documents are admin-only, for reads
 * and writes.
 * Only admin can approve/reopen payroll runs (enforced in runs routes).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import {
  EMPLOYEE_COLUMNS, employeeAccessLevel, canSeePrivateEmployeeData, partitionEmployeeWrite,
} from '@/shared/lib/payroll/employeeAccess';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    // Only the columns this role may see are fetched (never select('*')).
    const { data: emp, error } = await serviceClient
      .from('employees')
      .select(EMPLOYEE_COLUMNS[employeeAccessLevel(role)])
      .eq('id', params.id)
      .single();

    if (error || !emp) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Employee documents (ID copies, contracts, …) are admin-only.
    let docs = [];
    if (canSeePrivateEmployeeData(role)) {
      const { data } = await serviceClient
        .from('employee_documents')
        .select('*')
        .eq('employee_id', params.id)
        .order('uploaded_at', { ascending: false });
      docs = data || [];
    }

    return NextResponse.json({ employee: emp, documents: docs });
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

    const body = await request.json();

    // Role-based write whitelist. Pay, statutory, contact and banking fields are
    // admin-only; a request that includes any of them from another role is
    // refused outright (UI hiding alone is not a control).
    const { allowed, forbidden } = partitionEmployeeWrite(role, body);
    if (forbidden.length > 0) {
      return NextResponse.json(
        { error: `Only an admin can change: ${forbidden.join(', ')}`, code: 'ADMIN_ONLY_FIELDS', fields: forbidden },
        { status: 403 }
      );
    }

    const NUMERIC_FIELDS = new Set(['day_rate', 'monthly_salary', 'piece_rate', 'sha_amount']);
    const DATE_FIELDS    = new Set(['hire_date']);

    const updates = {};
    for (const key of allowed) {
      if (!(key in body)) continue;
      const val = body[key];
      if (NUMERIC_FIELDS.has(key)) {
        updates[key] = val === '' || val === null || val === undefined ? null : parseFloat(val);
      } else if (DATE_FIELDS.has(key)) {
        updates[key] = val === '' || val === null || val === undefined ? null : val;
      } else {
        updates[key] = val;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const { data: emp, error } = await serviceClient
      .from('employees')
      .update(updates)
      .eq('id', params.id)
      .select(EMPLOYEE_COLUMNS[employeeAccessLevel(role)])
      .single();

    if (error) {
      console.error('PATCH /api/payroll/employees/[id] error:', error.message);
      return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'employee',
      entity_id:     params.id,
      activity_type: 'updated',
      description:   `Employee ${emp.name} updated by ${displayName}`,
      new_value:     JSON.stringify(Object.keys(updates)),
      created_by:    user.id,
    });

    return NextResponse.json({ employee: emp });
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
