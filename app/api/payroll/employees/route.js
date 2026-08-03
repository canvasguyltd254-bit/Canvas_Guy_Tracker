/**
 * GET  /api/payroll/employees  — list employees (with filters)
 * POST /api/payroll/employees  — create employee
 *
 * Access: admin, head_of_sales, production_manager
 * All three roles can view and edit all employee fields including salaries.
 * Only admin can approve/reopen payroll runs (enforced in runs routes).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

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

    let query = serviceClient
      .from('employees')
      .select('*')
      .order('name');

    if (type)   query = query.eq('type', type);
    if (active !== null && active !== '') {
      query = query.eq('is_active', active === 'true');
    }
    if (search) {
      query = query.or(`name.ilike.%${search}%,employee_num.ilike.%${search}%,phone.ilike.%${search}%`);
    }

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

    const body = await request.json();
    const {
      name, type, day_rate, monthly_salary, piece_rate,
      sha_amount, nssf_number, id_number,
      phone, bank_account, bank_name, bank_branch, paybill_number,
      hire_date, notes,
    } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: 'Employee name is required' }, { status: 400 });
    }
    if (!type || !['casual', 'permanent', 'skilled_casual'].includes(type)) {
      return NextResponse.json({ error: 'Invalid employee type' }, { status: 400 });
    }

    // Look up the active SHA rule rather than relying on a manually entered amount
    let sha_from_rule = null;
    const { data: shaRule } = await serviceClient
      .from('statutory_rules')
      .select('fixed_amount, rate')
      .eq('rule_type', 'sha')
      .is('effective_to', null)
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    if (shaRule) {
      sha_from_rule = shaRule.fixed_amount ?? 0;
    }

    // sha_amount from request overrides rule (allows per-employee overrides), falls back to rule, then 0
    const resolved_sha = sha_amount !== undefined && sha_amount !== ''
      ? Number(sha_amount)
      : (sha_from_rule ?? 0);

    // Generate employee_num via DB function
    const { data: numData, error: numErr } = await serviceClient.rpc('next_employee_num');
    if (numErr) {
      return NextResponse.json({ error: 'Failed to generate employee number' }, { status: 500 });
    }

    const { data: emp, error: insertErr } = await serviceClient
      .from('employees')
      .insert({
        employee_num:    numData,
        name:            name.trim(),
        type,
        day_rate:        day_rate        ? Number(day_rate)        : null,
        monthly_salary:  monthly_salary  ? Number(monthly_salary)  : null,
        piece_rate:      piece_rate      ? Number(piece_rate)       : null,
        sha_amount:      resolved_sha,
        nssf_number:     nssf_number     || null,
        id_number:       id_number       || null,
        phone:           phone           || null,
        bank_account:    bank_account    || null,
        bank_name:       bank_name       || null,
        bank_branch:     bank_branch     || null,
        paybill_number:  paybill_number  || null,
        hire_date:       hire_date       || null,
        notes:           notes           || null,
        created_by:      user.id,
      })
      .select()
      .single();

    if (insertErr) {
      console.error('POST /api/payroll/employees insert error:', insertErr.message);
      return NextResponse.json({ error: 'Failed to create employee' }, { status: 500 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'employee',
      entity_id:     emp.id,
      activity_type: 'created',
      description:   `Employee ${emp.employee_num} ${emp.name} (${emp.type}) created by ${displayName}`,
      created_by:    user.id,
    });

    return NextResponse.json({ employee: emp }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/employees unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
