-- ============================================================
-- Migration: atomic_reverse_journal_entry RPC
--
-- Replaces the non-atomic JS multi-step reversal in reverseJournal.js.
-- All six steps now run inside one implicit PL/pgSQL transaction:
--   1. Lock the original journal row (FOR UPDATE)
--   2. Verify it is active and not yet reversed
--   3. Insert the reversal journal_entries header
--   4. Insert reversed journal_lines (signs flipped, must sum to zero)
--   5. Mark the original entry status = 'reversed'
--   6. Clear the source record's journal reference
--
-- If any step fails, the entire transaction rolls back — no partial state.
--
-- Returns: uuid of the new reversal journal_entry
-- Raises:  named exceptions consumed by reverseJournal.js
--
-- Security: EXECUTE revoked from PUBLIC; called only via the service role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.atomic_reverse_journal_entry(
  p_journal_id  uuid,
  p_reason      text,
  p_posted_by   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_entry       public.journal_entries%ROWTYPE;
  v_reversal_id uuid;
  v_line_sum    numeric := 0;
  v_line        public.journal_lines%ROWTYPE;
  v_count       integer;
BEGIN
  -- ── 1. Lock and load original entry ─────────────────────────
  SELECT * INTO v_entry
  FROM   public.journal_entries
  WHERE  id = p_journal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOURNAL_NOT_FOUND: Journal entry % does not exist', p_journal_id;
  END IF;

  -- ── 2. Guard: must be active ─────────────────────────────────
  IF v_entry.status <> 'active' THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: Journal entry % has already been reversed', p_journal_id;
  END IF;

  -- Belt-and-braces: also check for an existing reversal entry
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE  source_type = 'reversal'
    AND    source_id   = p_journal_id
  ) THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: A reversal entry for journal % already exists', p_journal_id;
  END IF;

  -- ── 3. Insert reversal header ─────────────────────────────────
  INSERT INTO public.journal_entries (
    entry_date,
    description,
    source_type,
    source_id,
    status,
    posted_by
  )
  VALUES (
    CURRENT_DATE,
    'REVERSAL of "' || v_entry.description || '". Reason: ' || TRIM(p_reason),
    'reversal',
    p_journal_id,
    'active',
    p_posted_by
  )
  RETURNING id INTO v_reversal_id;

  -- ── 4. Insert reversed lines ──────────────────────────────────
  FOR v_line IN
    SELECT * FROM public.journal_lines
    WHERE  journal_entry_id = p_journal_id
  LOOP
    v_line_sum := v_line_sum + (-v_line.amount);

    INSERT INTO public.journal_lines (journal_entry_id, account_id, amount, description)
    VALUES (
      v_reversal_id,
      v_line.account_id,
      -v_line.amount,
      'REVERSAL: ' || COALESCE(v_line.description, '')
    );
  END LOOP;

  -- Sanity check: reversed lines must still sum to zero
  IF ABS(v_line_sum) > 0.005 THEN
    RAISE EXCEPTION 'UNBALANCED_REVERSAL: reversed lines sum to % (original entry was unbalanced)', v_line_sum;
  END IF;

  -- Guard: original entry must have had at least one line
  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE journal_entry_id = p_journal_id) THEN
    RAISE EXCEPTION 'EMPTY_ENTRY: Journal entry % has no lines — cannot reverse', p_journal_id;
  END IF;

  -- ── 5. Mark original as reversed ─────────────────────────────
  UPDATE public.journal_entries
  SET    status = 'reversed'
  WHERE  id     = p_journal_id;

  -- ── 6. Clear source reference ─────────────────────────────────
  -- Allows the operational record to be edited/deleted/re-posted.
  IF v_entry.source_type = 'purchase' THEN
    UPDATE public.supplier_purchases
    SET    journal_entry_id = NULL
    WHERE  id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'SOURCE_NOT_FOUND: supplier_purchase % not found when clearing journal reference', v_entry.source_id;
    END IF;

  ELSIF v_entry.source_type = 'manual_payment' THEN
    UPDATE public.manual_supplier_payments
    SET    journal_entry_id = NULL
    WHERE  id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'SOURCE_NOT_FOUND: manual_supplier_payment % not found when clearing journal reference', v_entry.source_id;
    END IF;

  ELSIF v_entry.source_type = 'chatpesa_allocation' THEN
    UPDATE public.chatpesa_payment_allocations
    SET    journal_entry_id = NULL
    WHERE  id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'SOURCE_NOT_FOUND: chatpesa_payment_allocation % not found when clearing journal reference', v_entry.source_id;
    END IF;

  ELSIF v_entry.source_type = 'supplier_opening_balance' THEN
    UPDATE public.suppliers
    SET    opening_balance_journal_entry_id = NULL
    WHERE  id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'SOURCE_NOT_FOUND: supplier % not found when clearing opening balance journal reference', v_entry.source_id;
    END IF;

  -- 'reversal' source_type: the source is another journal_entry — no table to unlock
  END IF;

  RETURN v_reversal_id;
END;
$$;

-- Restrict to service role — mirrors post_journal_entry() access policy
REVOKE EXECUTE ON FUNCTION public.atomic_reverse_journal_entry(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.atomic_reverse_journal_entry(uuid, text, uuid) TO service_role;
