/**
 * GET   /api/payroll/temporary/payout-sheets/:id   sheet + its settlements, deductions, payout rows (phone masked)
 * PATCH /api/payroll/temporary/payout-sheets/:id   { action: approve | cancel | match | release }
 *
 * Payment is by ChatPesa (M-Pesa), never cash:
 *   export  POST .../:id/export        admin: freezes the rows and downloads the ChatPesa bulk file (see that route)
 *   match   PATCH { action: 'match' }  pairs each unpaid row with an imported ChatPesa debit; matched settlements become paid
 *   release PATCH { action: 'release', reason }   admin: close out rows that were never paid so they can go on a new sheet
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import {
  SHEET_COLUMNS, SETTLEMENT_COLUMNS, DEDUCTION_COLUMNS, PAYOUT_ROW_COLUMNS, maskPhone, isUuid,
} from '@/shared/lib/payroll/temporaryAccess';

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data: sheet, error } = await serviceClient.from('temporary_worker_payout_sheets').select(SHEET_COLUMNS).eq('id', id).maybeSingle();
  if (error) return dbError(error);                       // a database failure is never reported as "not found"
  if (!sheet) return NextResponse.json({ error: 'Payout sheet not found' }, { status: 404 });
  const { data: settlements, error: sErr } = await serviceClient.from('temporary_worker_settlements')
    .select(`${SETTLEMENT_COLUMNS}, employees(name, employee_num), temporary_worker_engagements(engagement_num)`)
    .eq('payout_sheet_id', id).order('settlement_num');
  if (sErr) return dbError(sErr);
  const { data: rawRows, error: rErr } = await serviceClient.from('temporary_worker_payout_rows')
    .select(`${PAYOUT_ROW_COLUMNS}, phone`).eq('sheet_id', id).order('created_at');
  if (rErr) return dbError(rErr);
  const rows = (rawRows || []).map(({ phone, ...r }) => ({ ...r, phone_masked: maskPhone(phone) }));   // the raw number never leaves the server
  const ids = (settlements || []).map(s => s.id);
  let deductions = [];
  if (ids.length) {
    const { data: d, error: dErr } = await serviceClient.from('temporary_worker_settlement_deductions')
      .select(DEDUCTION_COLUMNS).in('settlement_id', ids).eq('active', true).order('recorded_at');
    if (dErr) return dbError(dErr);
    deductions = d || [];
  }
  return NextResponse.json({ sheet, settlements: settlements || [], deductions, rows });
}

export async function PATCH(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const who = { p_actor: g.user.id, p_role: g.role };

  switch (b.action) {
    case 'approve': return rpc('approve_payout_sheet', { p_id: id, ...who });
    case 'cancel':  return rpc('cancel_payout_sheet', { p_id: id, p_reason: String(b.reason || ''), ...who });
    case 'match':   return rpc('match_payout_sheet', { p_id: id, ...who });
    case 'release': return rpc('release_unpaid_payout_rows', { p_id: id, p_reason: String(b.reason || ''), ...who });
    default: return bad('Unknown action');
  }
}
