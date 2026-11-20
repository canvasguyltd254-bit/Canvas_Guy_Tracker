/** PATCH /api/payroll/temporary/deductions/:id — { action: approve | void, reason? } (draft settlements only) */
import { guard, rpc, bad, readJson } from '@/shared/lib/payroll/temporaryServer';
import { isUuid } from '@/shared/lib/payroll/temporaryAccess';

export async function PATCH(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  if (b.action === 'approve') return rpc('approve_settlement_deduction', { p_id: id, p_actor: g.user.id, p_role: g.role });
  if (b.action === 'void') return rpc('void_settlement_deduction', { p_id: id, p_reason: String(b.reason || ''), p_actor: g.user.id, p_role: g.role });
  return bad('Unknown action');
}
