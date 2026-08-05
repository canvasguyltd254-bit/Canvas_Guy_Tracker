-- ════════════════════════════════════════════════════════════
-- resolve_sha_deduction
--
-- Determines whether a payroll entry should carry the employee's
-- SHA (monthly statutory) deduction for that calendar month.
--
-- Rule: SHA belongs to exactly one run per employee per month —
-- the run whose period_start is earliest in that month. If two
-- runs share the same period_start, run_id (UUID) is used as a
-- deterministic tiebreaker so the result never depends on call order.
--
-- The current run is always included as a candidate, even if its
-- entry does not yet exist (covers the POST /entries creation case).
--
-- FOR SHARE on the runs rows prevents two concurrent calls from both
-- seeing themselves as the earliest run before either entry commits.
--
-- Returns: p_sha_amount if the current run is the earliest eligible
--          run in the month; 0 otherwise.
--
-- Safe to run: CREATE OR REPLACE; no destructive DDL.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_sha_deduction(
  p_employee_id uuid,
  p_run_id      uuid,
  p_sha_amount  numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_start date;
  v_month_start  date;
  v_month_end    date;
  v_earliest_run uuid;
BEGIN
  IF p_sha_amount IS NULL OR p_sha_amount <= 0 THEN
    RETURN 0;
  END IF;

  -- Fetch and lock the current run's period_start
  SELECT r.period_start INTO v_period_start
  FROM payroll_runs r
  WHERE r.id = p_run_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_month_start := date_trunc('month', v_period_start)::date;
  v_month_end   := (date_trunc('month', v_period_start) + interval '1 month')::date;

  -- Find the earliest eligible run in the month.
  -- A run is eligible if:
  --   (a) it IS the current run (may not have an entry yet), OR
  --   (b) it already has an entry for this employee
  -- Lock those run rows so concurrent callers queue behind this transaction.
  SELECT r.id INTO v_earliest_run
  FROM payroll_runs r
  WHERE r.period_start >= v_month_start
    AND r.period_start <  v_month_end
    AND (
      r.id = p_run_id
      OR EXISTS (
        SELECT 1
        FROM payroll_entries e
        WHERE e.run_id = r.id
          AND e.employee_id = p_employee_id
      )
    )
  ORDER BY r.period_start ASC, r.id ASC
  LIMIT 1
  FOR SHARE;

  RETURN CASE WHEN v_earliest_run = p_run_id THEN p_sha_amount ELSE 0 END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_sha_deduction(uuid, uuid, numeric) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.resolve_sha_deduction(uuid, uuid, numeric) TO service_role;
