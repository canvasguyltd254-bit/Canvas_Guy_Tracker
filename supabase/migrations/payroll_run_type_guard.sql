-- ════════════════════════════════════════════════════════════
-- payroll_run_type_guard
--
-- Closes a gap: a worker's pay-basis type was only checked at approval, and
-- only for non-combined runs. A combined run accepted any type, and the
-- entries API did not compare worker type with run type when adding.
--
-- Rule (mirrors shared/lib/payroll/runTypes.js — keep in step):
--   casual / permanent / skilled_casual run -> that type only
--   combined run -> casual, permanent or skilled_casual only
--   anything else (unknown / future type) -> never, in any run
--
-- Enforcement, in depth:
--   1. payroll_run_type_allows()            the single rule
--   2. trigger on payroll_entries           blocks bad entries at INSERT (and
--                                           when snapshot_type / run_id change)
--   3. trigger on payroll_runs              blocks switching run_type when it
--                                           would invalidate existing entries
--   4. approve_payroll_run()                re-validates every entry, combined
--                                           runs included
--
-- Idempotent. Existing data is NOT modified or blocked: violations already
-- in the database are reported with a NOTICE, and are then stopped at approval.
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The rule ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_run_type_allows(p_run_type text, p_entry_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_entry_type IS NULL THEN false
    WHEN p_run_type = 'combined'
      THEN p_entry_type IN ('casual', 'permanent', 'skilled_casual')
    WHEN p_run_type IN ('casual', 'permanent', 'skilled_casual')
      THEN p_entry_type = p_run_type
    ELSE false
  END;
$$;

-- ── 2. Entries trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_entries_run_type_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_type text;
BEGIN
  SELECT run_type INTO v_run_type FROM payroll_runs WHERE id = NEW.run_id;

  IF NOT public.payroll_run_type_allows(v_run_type, NEW.snapshot_type) THEN
    RAISE EXCEPTION 'RUN_TYPE_MISMATCH: a % run cannot include a % employee',
      COALESCE(v_run_type, 'unknown'), COALESCE(NEW.snapshot_type, 'untyped')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_entries_run_type_guard ON public.payroll_entries;
CREATE TRIGGER trg_payroll_entries_run_type_guard
  BEFORE INSERT OR UPDATE OF snapshot_type, run_id ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.payroll_entries_run_type_guard();

-- ── 3. Run trigger: no run_type switch that strands entries ───
CREATE OR REPLACE FUNCTION public.payroll_runs_run_type_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bad text;
BEGIN
  IF NEW.run_type IS DISTINCT FROM OLD.run_type THEN
    SELECT snapshot_type INTO v_bad
    FROM payroll_entries
    WHERE run_id = NEW.id
      AND NOT public.payroll_run_type_allows(NEW.run_type, snapshot_type)
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'RUN_TYPE_MISMATCH: cannot change run to % while it contains % employees',
        NEW.run_type, COALESCE(v_bad, 'untyped')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_runs_run_type_guard ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_run_type_guard
  BEFORE UPDATE OF run_type ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_run_type_guard();

-- ── 4. Approval re-validates every entry, combined included ──
-- Only step 2 differs from approve_payroll_run_rpc.sql; the SHA-claim logic
-- and totals are unchanged.
CREATE OR REPLACE FUNCTION public.approve_payroll_run(
  p_run_id           uuid,
  p_approved_by      uuid,
  p_approved_by_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run              payroll_runs%ROWTYPE;
  v_month_start      date;
  v_entry            payroll_entries%ROWTYPE;
  v_claimed          boolean;
  v_sha              numeric;
  v_total_ded        numeric;
  v_net              numeric;
  v_total_gross      numeric := 0;
  v_total_deductions numeric := 0;
  v_total_net        numeric := 0;
  v_employee_count   int     := 0;
  v_mismatch_type    text;
BEGIN
  -- ── 1. Lock the run row ───────────────────────────────────
  SELECT * INTO v_run
  FROM payroll_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run not found: %', p_run_id;
  END IF;

  IF v_run.status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft runs can be approved (current status: %)', v_run.status;
  END IF;

  -- ── 2. Validate entries exist and every entry is eligible ──
  IF NOT EXISTS (SELECT 1 FROM payroll_entries WHERE run_id = p_run_id) THEN
    RAISE EXCEPTION 'Cannot approve a run with no entries';
  END IF;

  SELECT snapshot_type INTO v_mismatch_type
  FROM payroll_entries
  WHERE run_id = p_run_id
    AND NOT public.payroll_run_type_allows(v_run.run_type, snapshot_type)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'RUN_TYPE_MISMATCH: run type "%" cannot include employee type "%". Remove the entry before approving.',
      v_run.run_type, COALESCE(v_mismatch_type, 'untyped');
  END IF;

  -- ── 3. Month window ───────────────────────────────────────
  v_month_start := date_trunc('month', v_run.period_start)::date;

  -- ── 4. Lock all entries for this run ─────────────────────
  PERFORM id FROM payroll_entries
  WHERE run_id = p_run_id
  FOR UPDATE;

  -- ── 5. Per-entry SHA claim + totals ──────────────────────
  FOR v_entry IN
    SELECT * FROM payroll_entries
    WHERE run_id = p_run_id
    ORDER BY id
  LOOP
    INSERT INTO payroll_sha_claims (employee_id, month_start, run_id)
    VALUES (v_entry.employee_id, v_month_start, p_run_id)
    ON CONFLICT ON CONSTRAINT payroll_sha_claims_employee_month_unique
    DO NOTHING;

    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    v_claimed := (v_claimed::int > 0);

    v_sha := CASE WHEN v_claimed THEN COALESCE(v_entry.snapshot_sha, 0) ELSE 0 END;

    v_total_ded := v_sha
                 + COALESCE(v_entry.advance_deduction, 0)
                 + COALESCE(v_entry.damage_deduction,  0)
                 + COALESCE(v_entry.other_deductions,  0);

    v_net := GREATEST(0, COALESCE(v_entry.gross_pay, 0) - v_total_ded);

    UPDATE payroll_entries
    SET sha_deduction    = v_sha,
        total_deductions = v_total_ded,
        net_pay          = v_net
    WHERE id = v_entry.id;

    v_total_gross      := v_total_gross      + COALESCE(v_entry.gross_pay, 0);
    v_total_deductions := v_total_deductions + v_total_ded;
    v_total_net        := v_total_net        + v_net;
    v_employee_count   := v_employee_count   + 1;
  END LOOP;

  -- ── 6. Approve the run ────────────────────────────────────
  UPDATE payroll_runs
  SET status           = 'approved',
      approved_by      = p_approved_by,
      approved_at      = now(),
      approved_by_name = p_approved_by_name,
      total_gross      = v_total_gross,
      total_deductions = v_total_deductions,
      total_net        = v_total_net,
      employee_count   = v_employee_count,
      reopen_reason    = NULL
  WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'total_gross',      v_total_gross,
    'total_deductions', v_total_deductions,
    'total_net',        v_total_net,
    'employee_count',   v_employee_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_payroll_run(uuid, uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.approve_payroll_run(uuid, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.payroll_run_type_allows(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.payroll_run_type_allows(text, text) TO service_role;

-- ── 5. Report (do not fix) violations already in the data ────
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT pr.run_num, pr.run_type, pr.status, pe.snapshot_name, pe.snapshot_type
    FROM payroll_entries pe
    JOIN payroll_runs pr ON pr.id = pe.run_id
    WHERE NOT public.payroll_run_type_allows(pr.run_type, pe.snapshot_type)
    ORDER BY pr.run_num, pe.snapshot_name
  LOOP
    n := n + 1;
    RAISE NOTICE 'Existing mismatch: run % (%, %) contains % (%)',
      r.run_num, r.run_type, r.status, r.snapshot_name, r.snapshot_type;
  END LOOP;
  IF n = 0 THEN
    RAISE NOTICE 'payroll_run_type_guard: no existing run/entry type mismatches found.';
  ELSE
    RAISE NOTICE 'payroll_run_type_guard: % existing mismatch(es) listed above; left unchanged for manual review. Draft runs with them cannot be approved until fixed.', n;
  END IF;
END $$;

COMMIT;
