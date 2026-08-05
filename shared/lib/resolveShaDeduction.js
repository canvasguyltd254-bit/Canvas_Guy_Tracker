/**
 * resolveShaDeduction
 *
 * Delegates to the PostgreSQL resolve_sha_deduction() RPC, which:
 *  - Determines SHA ownership by earliest period_start in the calendar month
 *  - Uses run_id as a deterministic tiebreaker for equal period_start values
 *  - Holds FOR SHARE locks on run rows to prevent concurrent races
 *
 * Returns the employee's SHA amount if this run is the earliest eligible
 * run in the month; 0 otherwise.
 */

import { serviceClient } from '@/shared/lib/api-auth';

export async function resolveShaDeduction(shaAmount, employeeId, currentRunId) {
  if (!shaAmount || shaAmount <= 0) return 0;

  const { data, error } = await serviceClient.rpc('resolve_sha_deduction', {
    p_employee_id: employeeId,
    p_run_id:      currentRunId,
    p_sha_amount:  shaAmount,
  });

  if (error) {
    console.error('resolve_sha_deduction RPC error:', error.message);
    // Fail safe: do not apply SHA if we cannot determine ownership
    return 0;
  }

  return Number(data) || 0;
}
