-- ============================================================
-- Migration: allocate_chatpesa_split RPC
--
-- Replaces the race-prone JS-side guard + Supabase insert in
-- split-allocations/route.js with a single atomic PL/pgSQL function.
--
-- Problems this fixes:
--   1. Race condition — JS reads existing allocations, then inserts;
--      two concurrent requests can both pass the over-allocation guard
--      before either inserts.
--   2. Per-purchase aggregate bug — JS checks each allocation individually.
--      If two allocations target the same purchase, each passes the guard
--      separately, but together they overcharge.
--   3. match_status update — previously done in JS after the insert,
--      outside the allocation transaction.
--
-- All work (lock → validate → aggregate-check → insert → status update)
-- runs inside one implicit PL/pgSQL transaction.  A FOR UPDATE lock on
-- the transaction row blocks any concurrent attempt until we commit.
--
-- Returns: JSONB with inserted allocation rows + new match_status
-- Raises:  named exceptions consumed by split-allocations/route.js
--
-- Security: EXECUTE revoked from PUBLIC; called only via the service role.
-- ============================================================

CREATE OR REPLACE FUNCTION public.allocate_chatpesa_split(
  p_transaction_id  uuid,
  p_allocations     jsonb,    -- JSON array of allocation objects
  p_created_by      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_tx             public.chatpesa_transactions%ROWTYPE;
  v_tx_amount      numeric;
  v_already_alloc  numeric := 0;
  v_total_new      numeric := 0;
  v_purchase_id    uuid;
  v_purchase_alloc numeric;
  v_purchase_exist numeric;
  v_purchase_total numeric;
  v_match_status   text;
  v_matched_at     timestamptz;
  v_alloc          jsonb;
  v_row_id         uuid;
  v_row_type       text;
  v_row_amount     numeric;
  v_row_cat_id     uuid;
  v_row_petty      text;
  v_row_purchase   uuid;
  v_inserted       jsonb := '[]'::jsonb;
BEGIN
  -- ── 1. Lock the transaction row FOR UPDATE ────────────────────
  -- This blocks any concurrent call that also tries to allocate
  -- against the same transaction until this transaction commits.
  SELECT * INTO v_tx
  FROM   public.chatpesa_transactions
  WHERE  id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TX_NOT_FOUND: Transaction % does not exist', p_transaction_id;
  END IF;

  -- ── 2. Validate transaction state ────────────────────────────
  IF v_tx.tx_type <> 'debit' THEN
    RAISE EXCEPTION 'TX_NOT_DEBIT: Can only allocate debit transactions';
  END IF;
  IF v_tx.match_status = 'ignored' THEN
    RAISE EXCEPTION 'TX_IGNORED: Cannot allocate an ignored transaction';
  END IF;

  v_tx_amount := COALESCE(v_tx.amount, 0);

  -- ── 3. Sum existing allocations (under the lock) ─────────────
  -- Because we hold the FOR UPDATE lock, no concurrent transaction
  -- can insert new allocations for this tx between this read and our insert.
  SELECT COALESCE(SUM(amount), 0) INTO v_already_alloc
  FROM   public.chatpesa_payment_allocations
  WHERE  transaction_id = p_transaction_id;

  -- ── 4. Sum all incoming new allocations ──────────────────────
  SELECT COALESCE(SUM((elem->>'amount')::numeric), 0) INTO v_total_new
  FROM   jsonb_array_elements(p_allocations) AS elem;

  -- ── 5. Whole-transaction over-allocation guard ────────────────
  IF v_already_alloc + v_total_new > v_tx_amount + 0.01 THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: Transaction is %, already allocated %, adding % would exceed total',
      v_tx_amount::text, v_already_alloc::text, v_total_new::text;
  END IF;

  -- ── 6. Per-purchase aggregate guard ──────────────────────────
  -- Group ALL new allocations targeting the same purchase, sum them,
  -- then check combined new against the remaining balance on the purchase.
  --
  -- Critically: we lock each affected supplier_purchases row FOR UPDATE.
  -- This blocks concurrent operations (manual payments, other chatpesa splits,
  -- recalcPurchasePayment) from changing amount_paid between our check and
  -- our insert.  amount_paid is the cached total of ALL payment types
  -- (chatpesa + manual), so this guard correctly accounts for manual payments
  -- that were already recorded against the purchase.
  FOR v_purchase_id IN
    SELECT DISTINCT (elem->>'supplier_purchase_id')::uuid
    FROM   jsonb_array_elements(p_allocations) AS elem
    WHERE  elem->>'allocation_type' = 'supplier_purchase'
    AND   (elem->>'supplier_purchase_id') IS NOT NULL
  LOOP
    -- Sum of new allocations in this request for this purchase
    SELECT COALESCE(SUM((elem->>'amount')::numeric), 0) INTO v_purchase_alloc
    FROM   jsonb_array_elements(p_allocations) AS elem
    WHERE  elem->>'allocation_type' = 'supplier_purchase'
    AND   (elem->>'supplier_purchase_id')::uuid = v_purchase_id;

    -- Lock the purchase row and read total_amount + amount_paid atomically.
    -- amount_paid already includes chatpesa allocations AND manual payments,
    -- so no need to sum chatpesa_payment_allocations separately.
    SELECT COALESCE(total_amount, 0), COALESCE(amount_paid, 0)
    INTO   v_purchase_total, v_purchase_exist
    FROM   public.supplier_purchases
    WHERE  id = v_purchase_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PURCHASE_NOT_FOUND: supplier_purchase % does not exist', v_purchase_id;
    END IF;

    IF v_purchase_exist + v_purchase_alloc > v_purchase_total + 0.01 THEN
      RAISE EXCEPTION
        'PURCHASE_OVERPAID: Purchase % would be overpaid — total %, already paid %, adding %',
        v_purchase_id::text, v_purchase_total::text,
        v_purchase_exist::text, v_purchase_alloc::text;
    END IF;
  END LOOP;

  -- ── 7. Atomically insert all allocation rows ─────────────────
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO public.chatpesa_payment_allocations (
      transaction_id,
      allocation_type,
      amount,
      note,
      created_by,
      supplier_purchase_id,
      supplier_id,
      petty_cash_category,
      accounting_category_id
    ) VALUES (
      p_transaction_id,
      v_alloc->>'allocation_type',
      (v_alloc->>'amount')::numeric,
      NULLIF(TRIM(COALESCE(v_alloc->>'note', '')), ''),
      p_created_by,
      CASE WHEN v_alloc->>'allocation_type' = 'supplier_purchase'
           THEN (v_alloc->>'supplier_purchase_id')::uuid  ELSE NULL END,
      CASE WHEN v_alloc->>'allocation_type' = 'opening_balance'
           THEN (v_alloc->>'supplier_id')::uuid            ELSE NULL END,
      CASE WHEN v_alloc->>'allocation_type' = 'petty_cash'
           THEN v_alloc->>'petty_cash_category'            ELSE NULL END,
      CASE WHEN (v_alloc->>'accounting_category_id') IS NOT NULL
           THEN (v_alloc->>'accounting_category_id')::uuid ELSE NULL END
    )
    RETURNING
      id,
      allocation_type,
      amount,
      accounting_category_id,
      petty_cash_category,
      supplier_purchase_id
    INTO v_row_id, v_row_type, v_row_amount, v_row_cat_id, v_row_petty, v_row_purchase;

    v_inserted := v_inserted || jsonb_build_array(jsonb_build_object(
      'id',                     v_row_id,
      'allocation_type',        v_row_type,
      'amount',                 v_row_amount,
      'accounting_category_id', v_row_cat_id,
      'petty_cash_category',    v_row_petty,
      'supplier_purchase_id',   v_row_purchase
    ));
  END LOOP;

  -- ── 8. Compute new match_status ───────────────────────────────
  IF v_already_alloc + v_total_new >= v_tx_amount - 0.01 THEN
    v_match_status := 'matched';
    v_matched_at   := NOW();
  ELSE
    v_match_status := 'partial';
    v_matched_at   := NULL;
  END IF;

  -- ── 9. Update transaction (under the same lock) ───────────────
  UPDATE public.chatpesa_transactions
  SET    match_status = v_match_status,
         matched_at   = v_matched_at,
         matched_by   = CASE WHEN v_match_status = 'matched' THEN p_created_by ELSE NULL END
  WHERE  id = p_transaction_id;

  RETURN jsonb_build_object(
    'inserted',          v_inserted,
    'match_status',      v_match_status,
    'already_allocated', v_already_alloc,
    'total_new',         v_total_new
  );
END;
$$;

-- Restrict to service role — mirrors post_journal_entry() access policy
REVOKE EXECUTE ON FUNCTION public.allocate_chatpesa_split(uuid, jsonb, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.allocate_chatpesa_split(uuid, jsonb, uuid) TO service_role;
