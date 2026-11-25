/**
 * GET  /api/payroll/employees  — list employees (with filters)
 * POST /api/payroll/employees  — create employee
 *
 * Access: admin, head_of_sales, production_manager (see shared/lib/payroll/employeeAccess.js).
 * All three see full profiles and may submit new employees for admin approval.
 * After that only an admin edits directly; a manager's change is a request an admin approves
 * (PATCH /api/payroll/employees/:id → /api/payroll/employee-changes).
 * Only admin can approve/reopen payroll runs (enforced in runs routes).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import {
  EMPLOYEE_COLUMNS, employeeAccessLevel, employeeSearchFilter, canCreateEmployee, REQUESTABLE_FIELDS, normaliseEmployeeValue,
} from '@/shared/lib/payroll/employeeAccess';
import { isValidIsoDate } from '@/shared/lib/isoDate';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const type        = searchParams.get('type');
    const active      = searchParams.get('active');
    const search      = searchParams.get('search');

    // Only the columns this role may see are fetched (never select('*')).
    let query = serviceClient
      .from('employees')
      .select(EMPLOYEE_COLUMNS[employeeAccessLevel(role)])
      .order('name');

    if (type)   query = query.eq('type', type);
    if (active !== null && active !== '') {
      query = query.eq('is_active', active === 'true');
    }
    const searchFilter = employeeSearchFilter(role, search);
    if (searchFilter) query = query.or(searchFilter);

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/payroll/employees error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch employees' }, { status: 500 });
    }

    return NextResponse.json({ employees: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/employees unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    if (!canCreateEmployee(role)) {
      return NextResponse.json(
        { error: 'You cannot add payroll employees', code: 'FORBIDDEN' },
        { status: 403 }
      );
    }

    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Expected an employee object' }, { status: 400 });
    }

    // Admin and managers add an employee with every field. After this, a manager can only
    // REQUEST changes (PATCH → employee_change_requests); the creation is logged below.

    const fields = Object.fromEntries(REQUESTABLE_FIELDS.map(key => [key, normaliseEmployeeValue(key, body[key])]));
    const bad = REQUESTABLE_FIELDS.find(key => Number.isNaN(fields[key]));
    if (bad || (fields.hire_date && !isValidIsoDate(fields.hire_date))) {
      return NextResponse.json({ error: 'Invalid value for ' + (bad || 'hire_date') }, { status: 400 });
    }
    if (!fields.name) {
      return NextResponse.json({ error: 'Employee name is required' }, { status: 400 });
    }
    if (!['casual', 'permanent', 'skilled_casual'].includes(fields.type)) {
      return NextResponse.json({ error: 'Invalid employee type' }, { status: 400 });
    }

    // Look up the active SHA rule rather than relying on a manually entered amount
    let sha_from_rule = null;
    const { data: shaRule, error: shaError } = await serviceClient
      .from('statutory_rules')
      .select('fixed_amount, rate')
      .eq('rule_type', 'sha')
      .is('effective_to', null)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (shaError && fields.sha_amount === null) {
      return NextResponse.json({ error: 'Could not load the SHA default' }, { status: 500 });
    }

    if (shaRule) {
      sha_from_rule = shaRule.fixed_amount ?? 0;
    }

    fields.sha_amount ??= sha_from_rule ?? 0;
    const { data: emp, error: insertErr } = await serviceClient.rpc('submit_employee_onboarding', {
      p_fields: fields, p_actor: user.id, p_name: displayName || null, p_role: role,
    });

    if (insertErr || !emp) {
      console.error('POST /api/payroll/employees onboarding failed:', insertErr?.code);
      return NextResponse.json({ error: 'Failed to submit employee for approval' }, { status: 500 });
    }

    const employee = Object.fromEntries(EMPLOYEE_COLUMNS.full.split(', ').map(key => [key, emp[key]]));
    return NextResponse.json({ employee, message: 'Employee submitted for admin approval.' }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/employees unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
