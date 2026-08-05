-- ════════════════════════════════════════════════════════════
-- payroll_sha_claims
--
-- One row per employee per calendar month records which payroll run
-- owns the SHA (monthly statutory) deduction for that month.
--
-- The UNIQUE constraint on (employee_id, month_start) is the atomic
-- enforcement mechanism: concurrent approvals race to INSERT; exactly
-- one succeeds, all others see a conflict and receive sha_deduction = 0.
--
-- month_start is always the first day of the month (DATE_TRUNC result).
-- run_id references the run that claimed SHA for this employee-month.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.payroll_sha_claims (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  month_start  date        NOT NULL,
  run_id       uuid        NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  claimed_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payroll_sha_claims_employee_month_unique UNIQUE (employee_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_sha_claims_run      ON public.payroll_sha_claims(run_id);
CREATE INDEX IF NOT EXISTS idx_sha_claims_employee ON public.payroll_sha_claims(employee_id, month_start);

ALTER TABLE public.payroll_sha_claims ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS; no anon/authenticated access needed
REVOKE ALL ON public.payroll_sha_claims FROM PUBLIC, anon, authenticated;
GRANT  ALL  ON public.payroll_sha_claims TO service_role;
