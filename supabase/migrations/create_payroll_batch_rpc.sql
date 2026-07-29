-- ════════════════════════════════════════════════════════════
-- create_payroll_batch — atomic batch + entry-link creation
--
-- Replaces the two-step JS create-then-link pattern with a single
-- transaction so a partial failure cannot leave an orphaned batch.
--
-- The function also enforces:
--   • Each entry must belong to an approved or closed run
--   • No entry may appear in another open (draft/exported) batch
--   • Allocation amounts must be > 0 and ≤ the entry's remaining balance
--   • Total of allocations is ≤ amount_available
--
-- Safe to run: CREATE OR REPLACE; no destructive DDL.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_payroll_batch(
  p_run_id           uuid,
  p_payment_method   text,
  p_notes            text,
  p_amount_available numeric,
  p_created_by       uuid,
  p_links            jsonb   -- [{ "entry_id": uuid, "amount": numeric }]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch_num   text;
  v_batch_id    uuid;
  v_total       numeric := 0;
  v_link        jsonb;
  v_entry_id    uuid;
  v_amount      numeric;
  v_entry       payroll_entries%ROWTYPE;
  v_run_status  text;
  v_link_count  int := 0;
BEGIN
  -- ── 1. Validate run is approved ─────────────────────────────
  SELECT status INTO v_run_status
  FROM payroll_runs
  WHERE id = p_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run not found: %', p_run_id;
  END IF;
  IF v_run_status <> 'approved' THEN
    RAISE EXCEPTION 'Run must be approved (current status: %)', v_run_status;
  END IF;

  -- ── 2. Validate links array ──────────────────────────────────
  IF jsonb_array_length(p_links) = 0 THEN
    RAISE EXCEPTION 'links array must not be empty';
  END IF;

  -- Check for duplicate entry_ids within the submitted links
  IF (
    SELECT COUNT(DISTINCT v->>'entry_id') FROM jsonb_array_elements(p_links) v
  ) < jsonb_array_length(p_links) THEN
    RAISE EXCEPTION 'Duplicate entry_id values in links';
  END IF;

  -- ── 3. Validate each link and accumulate total ───────────────
  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    v_entry_id := (v_link->>'entry_id')::uuid;
    v_amount   := (v_link->>'amount')::numeric;

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Link amount must be > 0 (entry %)', v_entry_id;
    END IF;

    -- Lock the entry row first so concurrent requests queue behind us rather
    -- than both passing the open-batch check below simultaneously.
    SELECT e.* INTO v_entry
    FROM payroll_entries e
    WHERE e.id = v_entry_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Entry % not found', v_entry_id;
    END IF;

    -- Entry's run must be approved or closed
    DECLARE v_run_ok boolean; BEGIN
      SELECT r.status IN ('approved', 'closed') INTO v_run_ok
      FROM payroll_runs r WHERE r.id = v_entry.run_id;
      IF NOT v_run_ok THEN
        RAISE EXCEPTION 'Entry % run is not approved/closed', v_entry_id;
      END IF;
    END;

    -- Amount must not exceed remaining balance
    DECLARE v_balance numeric := v_entry.net_pay - v_entry.amount_paid; BEGIN
      IF v_amount > v_balance + 0.01 THEN
        RAISE EXCEPTION 'Allocation % exceeds balance % for entry %',
          v_amount, v_balance, v_entry_id;
      END IF;
    END;

    -- Entry must not already be in another open batch.
    -- The FOR UPDATE lock above ensures we see the committed state of any
    -- concurrent batch that is creating links for the same entry.
    IF EXISTS (
      SELECT 1
      FROM payroll_batch_entry_links bel
      JOIN payroll_payment_batches   b ON b.id = bel.batch_id
      WHERE bel.entry_id = v_entry_id
        AND b.status IN ('draft', 'exported')
    ) THEN
      RAISE EXCEPTION 'Entry % is already in an open batch', v_entry_id;
    END IF;

    v_total      := v_total + v_amount;
    v_link_count := v_link_count + 1;
  END LOOP;

  -- Total allocations must not exceed amount_available (exact: server computes allocations,
  -- so any mismatch is a bug not a rounding artefact).
  IF v_total > p_amount_available THEN
    RAISE EXCEPTION 'Total allocations % exceed amount_available %', v_total, p_amount_available;
  END IF;

  -- ── 4. Generate batch number ─────────────────────────────────
  SELECT next_payroll_batch_num() INTO v_batch_num;

  -- ── 5. Insert batch header ───────────────────────────────────
  INSERT INTO payroll_payment_batches (
    batch_num, run_id, status, payment_method,
    total_amount, notes, created_by
  ) VALUES (
    v_batch_num, p_run_id, 'draft', p_payment_method,
    v_total, p_notes, p_created_by
  )
  RETURNING id INTO v_batch_id;

  -- ── 6. Insert entry links ────────────────────────────────────
  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    INSERT INTO payroll_batch_entry_links (batch_id, entry_id, amount)
    VALUES (
      v_batch_id,
      (v_link->>'entry_id')::uuid,
      (v_link->>'amount')::numeric
    );
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id',     v_batch_id,
    'batch_num',    v_batch_num,
    'total_amount', v_total,
    'entry_count',  v_link_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_payroll_batch(uuid,text,text,numeric,uuid,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_payroll_batch(uuid,text,text,numeric,uuid,jsonb) TO service_role;
