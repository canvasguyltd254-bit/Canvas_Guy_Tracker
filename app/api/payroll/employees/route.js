/**
 * GET  /api/payroll/employees  — list employees (with filters)
 * POST /api/payroll/employees  — create employee
 *
 * Access: admin, production_manager
 * Production managers cannot set banking details or permanent salaries.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ALLOWED_ROLES = ['admin', 'production_manager'];

// Fields that only admin can set/update (sensitive banking + permanent salary)
const ADMIN_ONLY_FIELDS = ['monthly_salary', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'nssf_number', 'id_number'];

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

    // Redact banking details for non-admin roles
    const employees = role === 'admin'
      ? data
      : (data || []).map(e => ({
          ...e,
          bank_account:   e.type === 'permanent' ? '[restricted]' : e.bank_account,
          bank_name:      e.type === 'permanent' ? '[restricted]' : e.bank_name,
          bank_branch:    e.type === 'permanent' ? '[restricted]' : e.bank_branch,
          paybill_number: e.type === 'permanent' ? '[restricted]' : e.paybill_number,
          nssf_number:    '[restricted]',
          id_number:      '[restricted]',
          monthly_salary: e.type === 'permanent' ? null : e.monthly_salary,
        }));

    return NextResponse.json({ employees });
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

    // Production managers cannot set banking details or permanent salaries
    if (role !== 'admin') {
      const restricted = ADMIN_ONLY_FIELDS.filter(f => body[f] !== undefined && body[f] !== null && body[f] !== '');
      if (restricted.length > 0) {
        return NextResponse.json({
          error: `Production managers cannot set: ${restricted.join(', ')}`,
        }, { status: 403 });
      }
      if (type === 'permanent') {
        return NextResponse.json({
          error: 'Production managers cannot create permanent employees',
        }, { status: 403 });
      }
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
        monthly_salary:  (role === 'admin' && monthly_salary)  ? Number(monthly_salary)  : null,
        piece_rate:      piece_rate      ? Number(piece_rate)       : null,
        sha_amount:      resolved_sha,
        nssf_number:     (role === 'admin' && nssf_number)     ? nssf_number : null,
        id_number:       (role === 'admin' && id_number)        ? id_number   : null,
        phone:           phone           || null,
        bank_account:    (role === 'admin' && bank_account)    ? bank_account    : null,
        bank_name:       (role === 'admin' && bank_name)       ? bank_name       : null,
        bank_branch:     (role === 'admin' && bank_branch)     ? bank_branch     : null,
        paybill_number:  (role === 'admin' && paybill_number)  ? paybill_number  : null,
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
