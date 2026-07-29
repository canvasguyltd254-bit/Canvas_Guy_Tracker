/**
 * GET    /api/payroll/employees/:id  — get single employee (banking redacted for non-admin)
 * PATCH  /api/payroll/employees/:id  — update employee (admin-only fields restricted for prod_manager)
 * DELETE /api/payroll/employees/:id  — deactivate only (never hard-delete; history is permanent)
 *
 * Access: admin, production_manager
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ALLOWED_ROLES = ['admin', 'production_manager'];
const ADMIN_ONLY_FIELDS = ['monthly_salary', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'nssf_number', 'id_number'];

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { data: emp, error } = await serviceClient
      .from('employees')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !emp) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Redact sensitive fields for non-admin
    if (role !== 'admin') {
      emp.bank_account   = emp.type === 'permanent' ? '[restricted]' : emp.bank_account;
      emp.bank_name      = emp.type === 'permanent' ? '[restricted]' : emp.bank_name;
      emp.bank_branch    = emp.type === 'permanent' ? '[restricted]' : emp.bank_branch;
      emp.paybill_number = emp.type === 'permanent' ? '[restricted]' : emp.paybill_number;
      emp.nssf_number    = '[restricted]';
      emp.id_number      = '[restricted]';
      emp.monthly_salary = emp.type === 'permanent' ? null : emp.monthly_salary;
    }

    // Fetch documents
    const { data: docs } = await serviceClient
      .from('employee_documents')
      .select('*')
      .eq('employee_id', params.id)
      .order('uploaded_at', { ascending: false });

    return NextResponse.json({ employee: emp, documents: docs || [] });
  } catch (err) {
    console.error('GET /api/payroll/employees/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const body = await request.json();

    // Block non-admin from touching restricted fields
    if (role !== 'admin') {
      const forbidden = ADMIN_ONLY_FIELDS.filter(f => f in body && body[f] !== null && body[f] !== '');
      if (forbidden.length > 0) {
        return NextResponse.json({
          error: `Production managers cannot update: ${forbidden.join(', ')}`,
        }, { status: 403 });
      }
      // Also block changing employee type to permanent
      if (body.type === 'permanent') {
        return NextResponse.json({ error: 'Production managers cannot change employee type to permanent' }, { status: 403 });
      }
    }

    // Whitelist updatable fields
    const allowedAll  = ['name', 'type', 'day_rate', 'piece_rate', 'sha_amount', 'phone', 'hire_date', 'notes', 'is_active'];
    const adminExtra  = ADMIN_ONLY_FIELDS;

    const allowed = role === 'admin' ? [...allowedAll, ...adminExtra] : allowedAll;

    const updates = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const { data: emp, error } = await serviceClient
      .from('employees')
      .update(updates)
      .eq('id', params.id)
      .select()
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

export async function DELETE(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    // Only admins can deactivate
    const authError = requireRole(user, role, ['admin']);
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
