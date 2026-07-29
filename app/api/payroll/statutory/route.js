/**
 * GET  /api/payroll/statutory  — list statutory rules
 * POST /api/payroll/statutory  — create a new rule (admin only)
 *
 * Rules are effective-dated. The active rule is the one with no effective_to
 * (or the most recent effective_from that is <= today).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('statutory_rules')
      .select('*')
      .order('rule_type')
      .order('effective_from', { ascending: false });

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch statutory rules' }, { status: 500 });
    }

    return NextResponse.json({ rules: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/statutory unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const body = await request.json();
    const { rule_type, effective_from, rate, fixed_amount, description } = body;

    if (!rule_type || !effective_from) {
      return NextResponse.json({ error: 'rule_type and effective_from are required' }, { status: 400 });
    }

    if (!rate && !fixed_amount) {
      return NextResponse.json({ error: 'Either rate or fixed_amount is required' }, { status: 400 });
    }

    // Close out the previous active rule for this type
    await serviceClient
      .from('statutory_rules')
      .update({ effective_to: effective_from })
      .eq('rule_type', rule_type)
      .is('effective_to', null);

    const { data: rule, error: insertErr } = await serviceClient
      .from('statutory_rules')
      .insert({
        rule_type,
        effective_from,
        effective_to:  null,
        rate:          rate          ? Number(rate)         : null,
        fixed_amount:  fixed_amount  ? Number(fixed_amount) : null,
        description:   description   || null,
      })
      .select()
      .single();

    if (insertErr) {
      return NextResponse.json({ error: 'Failed to create rule' }, { status: 500 });
    }

    return NextResponse.json({ rule }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/statutory unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
