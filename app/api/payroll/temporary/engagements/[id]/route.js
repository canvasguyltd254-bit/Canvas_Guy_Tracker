/**
 * GET   /api/payroll/temporary/engagements/:id   engagement + unsettled summary
 * PATCH /api/payroll/temporary/engagements/:id   { action: activate | complete | cancel | revise_rate | link_assignment, ... }
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient } from '@/shared/lib/payroll/temporaryServer';
import { ENGAGEMENT_COLUMNS, ENGAGEMENT_JOINS, isUuid, positiveNumber } from '@/shared/lib/payroll/temporaryAccess';

export async function GET(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const { data, error } = await serviceClient.from('temporary_worker_engagements')
    .select(`${ENGAGEMENT_COLUMNS}, ${ENGAGEMENT_JOINS}`).eq('id', id).single();
  if (error || !data) return NextResponse.json({ error: 'Engagement not found' }, { status: 404 });
  const { data: due } = await serviceClient.rpc('temporary_engagement_due', { p_engagement: id, p_cutoff: null });
  return NextResponse.json({ engagement: data, due: due || null });
}

export async function PATCH(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const who = { p_actor: g.user.id, p_role: g.role };
  switch (b.action) {
    case 'activate': return rpc('set_engagement_status', { p_id: id, p_status: 'active', p_reason: null, ...who });
    case 'complete': return rpc('set_engagement_status', { p_id: id, p_status: 'completed', p_reason: String(b.reason || ''), ...who });
    case 'cancel':   return rpc('set_engagement_status', { p_id: id, p_status: 'cancelled', p_reason: String(b.reason || ''), ...who });
    case 'revise_rate':
      if (!positiveNumber(b.new_rate)) return bad('Enter the new daily rate (above 0).');
      return rpc('revise_engagement_rate', { p_id: id, p_new_rate: Number(b.new_rate), p_reason: String(b.reason || ''), ...who });
    case 'link_assignment':
      if (!isUuid(b.assignment_id)) return bad('Choose an assignment.');
      return rpc('link_assignment_to_engagement', { p_assignment: b.assignment_id, p_engagement: id, ...who });
    default: return bad('Unknown action');
  }
}
