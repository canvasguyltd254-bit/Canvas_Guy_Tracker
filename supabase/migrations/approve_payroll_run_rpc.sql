-- ════════════════════════════════════════════════════════════
-- approve_payroll_run
--
-- Atomically approves a payroll run with strict SHA enforcement.
--
-- SHA rule: exactly one run per employee per calendar month may carry
-- sha_deduction > 0. Ownership is decided by a competing INSERT into
-- payroll_sha_claims (employee_id, month_start UNIQUE constraint).
--
-- Concurrency guarantee:
--   Two concurrent approvals for different runs in the same month both
--   attempt INSERT INTO payroll_sha_claims. The UNIQUE constraint ensures
--   exactly one succeeds. The loser receives a conflict and its SHA is
--   zeroed. No advisory locks or row-ordering needed — the constraint is
--   the serialisation mechanism.
--
-- "Committed owner always wins" is preserved:
--   Any run already approved/closed for this employee-month has already
--   inserted its sha_claims row. The current run's INSERT conflicts and
--   receives 0.
--
-- Reopen safety:
--   When a run is reopened, its sha_claims rows must be deleted so a
--   re-approval can re-race for ownership. See reopen route.
--
-- Returns jsonb: { total_gross, total_deductions, total_net, employee_count }
-- Raises exceptions for: run not found, wrong status, no entries,
--                         run_type mismatch (unless combined).
-- ════════════════════════════════════════════════════════════

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

  -- ── 2. Validate entries exist and run_type matches ────────
  IF NOT EXISTS (SELECT 1 FROM payroll_entries WHERE run_id = p_run_id) THEN
    RAISE EXCEPTION 'Cannot approve a run with no entries';
  END IF;

  IF v_run.run_type <> 'combined' THEN
    SELECT snapshot_type INTO v_mismatch_type
    FROM payroll_entries
    WHERE run_id = p_run_id
      AND snapshot_type <> v_run.run_type
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'Run type "%" does not match employee type "%". Use combined for mixed payrolls.',
        v_run.run_type, v_mismatch_type;
    END IF;
  END IF;

  -- ── 3. Month window ───────────────────────────────────────
  v_month_start := date_trunc('month', v_run.period_start)::date;

  -- ── 4. Lock all entries for this run ─────────────────────
  -- Prevents concurrent batch operations from reading stale values
  -- while we are rewriting sha_deduction / net_pay below.
  PERFORM id FROM payroll_entries
  WHERE run_id = p_run_id
  FOR UPDATE;

  -- ── 5. Per-entry SHA claim + totals ──────────────────────
  FOR v_entry IN
    SELECT * FROM payroll_entries
    WHERE run_id = p_run_id
    ORDER BY id   -- consistent order to avoid deadlock with other concurrent RPCs
  LOOP
    -- Attempt to claim SHA ownership for this employee-month.
    -- ON CONFLICT DO NOTHING means v_claimed = true only if OUR insert won.
    -- If another run (approved/closed) already owns this month, the row
    -- already exists and our insert is silently ignored → v_claimed = false.
    INSERT INTO payroll_sha_claims (employee_id, month_start, run_id)
    VALUES (v_entry.employee_id, v_month_start, p_run_id)
    ON CONFLICT ON CONSTRAINT payroll_sha_claims_employee_month_unique
    DO NOTHING;

    -- Did we just insert (claim owner), or did a conflict occur?
    GET DIAGNOSTICS v_claimed = ROW_COUNT;   -- 1 if inserted, 0 if conflict
    v_claimed := (v_claimed::int > 0);

    -- Apply SHA only if we own this month
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
