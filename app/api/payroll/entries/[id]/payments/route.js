/**
 * GET  /api/payroll/entries/:id/payments  — list payments for an entry
 * POST /api/payroll/entries/:id/payments  — record a payment using atomic RPC
 *
 * Payment insert and entry balance update are performed in a single Postgres
 * transaction via the record_payroll_payment RPC to prevent concurrent overpayment
 * and inconsistent balance state.
 *
 * Access: admin only (production_manager cannot record payments)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('payroll_payments')
      .select('*')
      .eq('entry_id', params.id)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch payments' }, { status: 500 });
    }

    return NextResponse.json({ payments: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/entries/[id]/payments unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const entryId = params.id;

    // Fetch entry — must be from an approved run
    const { data: entry } = await serviceClient
      .from('payroll_entries')
      .select('employee_id, net_pay, amount_paid, snapshot_name, payroll_runs(status, run_num)')
      .eq('id', entryId)
      .single();

    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    if (entry.payroll_runs?.status !== 'approved') {
      return NextResponse.json({ error: 'Run must be approved before recording payments' }, { status: 409 });
    }

    const body = await request.json();
    const { amount, payment_method = 'mpesa', phone, reference, payment_date, batch_id, notes } = body;

    if (!amount || Number(amount) <= 0) {
      return NextResponse.json({ error: 'Payment amount must be positive' }, { status: 400 });
    }

    // Delegate to atomic RPC (handles lock + overpayment guard + insert + update in one transaction)
    const { data: result, error: rpcErr } = await serviceClient.rpc('record_payroll_payment', {
      p_entry_id:       entryId,
      p_batch_id:       batch_id || null,
      p_employee_id:    entry.employee_id,
      p_amount:         Number(amount),
      p_payment_date:   payment_date || new Date().toISOString().slice(0, 10),
      p_payment_method: payment_method,
      p_phone:          phone || null,
      p_reference:      reference || null,
      p_notes:          notes || null,
      p_created_by:     user.id,
    });

    if (rpcErr) {
      console.error('POST /api/payroll/entries/[id]/payments RPC error:', rpcErr.message);
      // RPC raises descriptive exceptions — surface them to the client
      return NextResponse.json({ error: rpcErr.message || 'Payment failed' }, { status: 400 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'run',
      entity_id:     entry.run_id,
      activity_type: 'payment_added',
      description:   `Payment KES ${Number(amount).toLocaleString()} to ${entry.snapshot_name} via ${payment_method}`,
      new_value:     JSON.stringify(result),
      created_by:    user.id,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/entries/[id]/payments unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
