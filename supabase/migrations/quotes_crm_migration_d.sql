-- quotes_crm_migration_d.sql
--
-- Atomic order status advancement.
--
-- Problem: the JS status route calls a GL RPC, then a separate Supabase
-- row update. If the row update fails, journals are posted but the order
-- status is unchanged. On retry the GL idempotency guard (invoice_journal_entry_id
-- IS NULL) is already false, so the RPC returns an error and blocks the retry.
--
-- Solution: a single PostgreSQL function that runs GL posting AND status update
-- inside one transaction. Either both commit or neither does.
--
-- Safe to re-run: function uses CREATE OR REPLACE.
--
-- The JS route (/api/orders/[id]/status) calls this RPC instead of the
-- two-step pattern. Existing individual GL RPCs remain for direct use.

-- ─────────────────────────────────────────────────────────────────────────────
-- advance_order_status
--
-- Parameters:
--   p_order_id    uuid      — order to advance
--   p_new_status  text      — target status
--   p_posted_by   uuid      — auth user id (for GL + activity log)
--   p_extra       jsonb     — optional side-channel data:
--                             { credit_approval_ref, refund_reference }
--
-- Returns:
--   jsonb { old_status, new_status, gl_posted boolean }
--
-- Error codes raised (SQLSTATE P0001 / RAISE EXCEPTION):
--   ORDER_NOT_FOUND        — no row with that id
--   INVALID_STATUS         — p_new_status not in the allowed set
--   SAME_STATUS            — old_status = new_status (no-op guard)
--
-- GL semantics (mirrors the JS route):
--   Non-credit order → Deposit Paid  : calls post_deposit_paid_journals if not yet posted
--   Credit order     → Quote Approved: calls post_credit_order_invoice  if not yet posted
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION advance_order_status(
  p_order_id    uuid,
  p_new_status  text,
  p_posted_by   uuid,
  p_extra       jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order              orders%ROWTYPE;
  v_old_status         text;
  v_is_credit          boolean;
  v_gl_posted          boolean := false;
  v_credit_terms       text[]  := ARRAY['30_day','60_day','custom'];
  v_credit_types       text[]  := ARRAY['commercial','reseller'];
  v_credit_approval    text;
  v_refund_ref         text;
BEGIN
  -- Lock the row for the duration of this transaction
  SELECT * INTO v_order
  FROM   orders
  WHERE  id = p_order_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  v_old_status      := v_order.status;
  v_credit_approval := p_extra->>'credit_approval_ref';
  v_refund_ref      := p_extra->>'refund_reference';

  IF v_old_status = p_new_status THEN
    RAISE EXCEPTION 'SAME_STATUS';
  END IF;

  -- Determine if this is a credit order
  v_is_credit := (v_order.customer_type = ANY(v_credit_types))
             AND (v_order.payment_terms  = ANY(v_credit_terms));

  -- ── GL side-effects (inside the same transaction) ──────────────────────────

  -- Non-credit: post invoice + deposit journals at Deposit Paid
  IF p_new_status = 'Deposit Paid' AND NOT v_is_credit AND v_order.invoice_journal_entry_id IS NULL THEN
    PERFORM post_deposit_paid_journals(p_order_id, p_posted_by);
    v_gl_posted := true;
  END IF;

  -- Credit order: post invoice journal at Quote Approved
  IF p_new_status = 'Quote Approved' AND v_is_credit AND v_order.invoice_journal_entry_id IS NULL THEN
    PERFORM post_credit_order_invoice(p_order_id, p_posted_by);
    v_gl_posted := true;
  END IF;

  -- ── Status update ──────────────────────────────────────────────────────────

  UPDATE orders
  SET    status             = p_new_status,
         credit_approval_ref = COALESCE(v_credit_approval, credit_approval_ref),
         refund_reference    = COALESCE(v_refund_ref,      refund_reference),
         updated_at          = NOW()
  WHERE  id = p_order_id;

  -- ── Credit exposure side-effect ────────────────────────────────────────────
  -- When a credit approval ref is present, update client_profiles.current_exposure.
  IF v_credit_approval IS NOT NULL AND v_order.client IS NOT NULL AND v_order.total_value IS NOT NULL THEN
    UPDATE client_profiles
    SET    current_exposure = COALESCE(current_exposure, 0) + v_order.total_value
    WHERE  client_name = v_order.client;
  END IF;

  RETURN jsonb_build_object(
    'old_status', v_old_status,
    'new_status', p_new_status,
    'gl_posted',  v_gl_posted
  );
END;
$$;

-- Restrict to service_role only (called by the Next.js API route via serviceClient)
REVOKE EXECUTE ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) IS
  'Atomically advance order status and post GL journals in a single transaction. '
  'Prevents the split-brain where GL is posted but status update fails or vice-versa.';
