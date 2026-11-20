/** POST /api/payroll/temporary/settlements/:id/deductions — record an operational deduction (draft settlements only). */
import { guard, rpc, bad, readJson } from '@/shared/lib/payroll/temporaryServer';
import { isUuid, validateDeductionInput } from '@/shared/lib/payroll/temporaryAccess';

export async function POST(request, props) {
  const { id } = await props.params;
  const g = await guard(); if (g.error) return g.error;
  if (!isUuid(id)) return bad('Invalid id');
  const b = await readJson(request);
  const err = validateDeductionInput({ type: b.deduction_type, amount: b.amount, reason: b.reason, ref: b.evidence_ref });
  if (err) return bad(err, 'VALIDATION');
  return rpc('add_settlement_deduction', {
    p_settlement: id, p_type: b.deduction_type, p_amount: Number(b.amount), p_reason: String(b.reason),
    p_ref: typeof b.evidence_ref === 'string' ? b.evidence_ref : null, p_path: null, p_actor: g.user.id, p_role: g.role,
  }, 201);
}
