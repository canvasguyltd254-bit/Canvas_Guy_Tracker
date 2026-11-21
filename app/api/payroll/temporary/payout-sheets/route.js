/**
 * GET  /api/payroll/temporary/payout-sheets   list
 * POST /api/payroll/temporary/payout-sheets   { settlement_ids: [id] } create a sheet for ONE approved, unpaid settlement
 *   (one settlement per sheet: the signed paper then matches exactly one payment; also a unique index in the database)
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { SHEET_COLUMNS, isUuid } from '@/shared/lib/payroll/temporaryAccess';

export async function GET() {
  const g = await guard(); if (g.error) return g.error;
  const { data, error } = await serviceClient.from('temporary_worker_payout_sheets').select(SHEET_COLUMNS)
    .order('created_at', { ascending: false }).limit(200);
  if (error) return dbError(error);
  return NextResponse.json({ sheets: data || [] });
}

export async function POST(request) {
  const g = await guard(); if (g.error) return g.error;
  const b = await readJson(request);
  const ids = Array.isArray(b.settlement_ids) ? b.settlement_ids : [];
  if (ids.length !== 1 || !isUuid(ids[0])) return bad('A payout sheet covers exactly one settlement.');
  return rpc('create_payout_sheet', { p_settlement_ids: ids, p_actor: g.user.id, p_role: g.role }, 201);
}
