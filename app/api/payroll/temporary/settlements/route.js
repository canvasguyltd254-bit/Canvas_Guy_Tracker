/**
 * GET  /api/payroll/temporary/settlements   list (?status=, ?engagement_id=)
 * POST /api/payroll/temporary/settlements   prepare a settlement (takes EVERY eligible approved entry to the cutoff)
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { SETTLEMENT_COLUMNS, SETTLEMENT_JOINS, isUuid, isIsoDate } from '@/shared/lib/payroll/temporaryAccess';

const STATUSES = ['draft', 'approved', 'paid', 'voided'];

export async function GET(request) {
  const g = await guard(); if (g.error) return g.error;
  const sp = new URL(request.url).searchParams;
  let q = serviceClient.from('temporary_worker_settlements').select(`${SETTLEMENT_COLUMNS}, ${SETTLEMENT_JOINS}`)
    .order('prepared_at', { ascending: false }).limit(300);
  if (sp.get('status')) { if (!STATUSES.includes(sp.get('status'))) return bad('Unknown status'); q = q.eq('status', sp.get('status')); }
  if (sp.get('engagement_id')) { if (!isUuid(sp.get('engagement_id'))) return bad('Invalid engagement'); q = q.eq('engagement_id', sp.get('engagement_id')); }
  const { data, error } = await q;
  if (error) return dbError(error);
  return NextResponse.json({ settlements: data || [] });
}

export async function POST(request) {
  const g = await guard(); if (g.error) return g.error;
  const b = await readJson(request);
  if (!isUuid(b.engagement_id)) return bad('Choose an engagement.');
  if (!isIsoDate(b.cutoff_date)) return bad('Choose a cutoff date.');
  if (!['threshold', 'close_out', 'early'].includes(b.kind)) return bad('Unknown settlement kind.');
  return rpc('prepare_temporary_settlement', {
    p_engagement: b.engagement_id, p_cutoff: b.cutoff_date, p_kind: b.kind,
    p_reason: typeof b.reason === 'string' ? b.reason : null, p_actor: g.user.id, p_role: g.role,
  }, 201);
}
