/**
 * GET   /api/payroll/temporary/settlements/:id   settlement + lines + deductions
 * PATCH /api/payroll/temporary/settlements/:id   { action: approve | void | pay, ... }
 *
 * A paid settlement can never be voided: the database refuses it for every role.
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import {
  SETTLEMENT_COLUMNS, SETTLEMENT_JOINS, LINE_COLUMNS, DEDUCTION_COLUMNS, isUuid, validateReceiverName,
} from '@/shared/lib/payroll/temporaryAccess';

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data: settlement, error } = await serviceClient.from('temporary_worker_settlements')
    .select(`${SETTLEMENT_COLUMNS}, ${SETTLEMENT_JOINS}`).eq('id', id).single();
  if (error || !settlement) return NextResponse.json({ error: 'Settlement not found' }, { status: 404 });
  const [{ data: lines, error: lErr }, { data: deductions, error: dErr }] = await Promise.all([
    serviceClient.from('temporary_worker_settlement_lines').select(LINE_COLUMNS).eq('settlement_id', id).order('work_date'),
    serviceClient.from('temporary_worker_settlement_deductions').select(DEDUCTION_COLUMNS).eq('settlement_id', id).order('recorded_at'),
  ]);
  if (lErr || dErr) return dbError(lErr || dErr);
  return NextResponse.json({ settlement, lines: lines || [], deductions: deductions || [] });
}

export async function PATCH(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const who = { p_actor: g.user.id, p_role: g.role };
  switch (b.action) {
    case 'approve':
      return rpc('approve_temporary_settlement', { p_id: id, ...who, p_override_reason: typeof b.override_reason === 'string' ? b.override_reason : null });
    case 'void':
      return rpc('void_temporary_settlement', { p_id: id, p_reason: String(b.reason || ''), ...who });
    case 'pay': {
      const nameError = validateReceiverName(b.received_by_full_name);
      if (nameError) return bad(nameError);
      return rpc('pay_temporary_settlement', { p_id: id, ...who, p_received_by: String(b.received_by_full_name), p_note: typeof b.payment_note === 'string' ? b.payment_note : null });
    }
    default: return bad('Unknown action');
  }
}
