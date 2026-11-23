-- ============================================================
-- Orders: credit terms (30_day / 60_day / custom) bypass the Deposit Paid gate
-- Run AFTER quotes_crm_migration_d.sql (and the later CRM migrations).
-- Safe to re-run.
--
-- PROBLEM
--   advance_order_status() treated an order as "credit" only when
--     customer_type IN ('commercial','reseller') AND payment_terms IN (credit terms).
--   customer_type defaults to 'retail' and cannot be edited after creation, so an
--   order given 30-day / 60-day / custom terms for a retail-typed customer could
--   never skip Deposit Paid, and the invoice GL fired at the wrong stage.
--
-- CHANGE
--   1. v_is_credit = payment_terms IN ('30_day','60_day','custom'). Customer type
--      no longer matters. (Mirrors shared/lib/isCreditOrder.js.)
--   2. Server-side guard for the credit skip. Quote Approved -> Material Check is
--      only allowed for a credit order AND with a credit approval reference.
--      Before, this was enforced only by the browser, so a direct API call could
--      skip the deposit on a cash order.
--        DEPOSIT_REQUIRED          non-credit order tried to skip Deposit Paid
--        CREDIT_APPROVAL_REQUIRED  credit skip without an approval reference
--   3. The credit invoice journal is posted at Quote Approved (as before) AND, if
--      it was never posted, when the order leaves Quote Approved. This covers
--      orders whose terms were changed to credit after they were approved.
--
-- Credit LIMIT checks are unchanged: they run in the browser from client_profiles
-- (customers without a client_profiles row have no limit and no exposure tracking).
-- ============================================================

CREATE OR REPLACE FUNCTION advance_order_status(
  p_order_id    uuid,
  p_new_status  text,
  p_posted_by   uuid,
  p_extra       jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order              orders%ROWTYPE;
  v_old_status         text;
  v_is_credit          boolean;
  v_gl_posted          boolean := false;
  v_credit_terms       text[]  := ARRAY['30_day','60_day','custom'];
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
  v_credit_approval := NULLIF(btrim(p_extra->>'credit_approval_ref'), '');
  v_refund_ref      := p_extra->>'refund_reference';

  IF v_old_status = p_new_status THEN
    RAISE EXCEPTION 'SAME_STATUS';
  END IF;

  -- Credit order = credit payment terms. Customer type is not part of the rule.
  v_is_credit := COALESCE(v_order.payment_terms = ANY(v_credit_terms), false);

  -- ── Credit skip guard ──────────────────────────────────────────────────────
  -- Quote Approved -> Material Check skips Deposit Paid. Only a credit order with
  -- an approval reference may do it.
  IF v_old_status = 'Quote Approved' AND p_new_status = 'Material Check' THEN
    IF NOT v_is_credit THEN
      RAISE EXCEPTION 'DEPOSIT_REQUIRED';
    END IF;
    IF v_credit_approval IS NULL THEN
      RAISE EXCEPTION 'CREDIT_APPROVAL_REQUIRED';
    END IF;
  END IF;

  -- ── GL side-effects (inside the same transaction) ──────────────────────────

  -- Non-credit: post invoice + deposit journals at Deposit Paid
  IF p_new_status = 'Deposit Paid' AND NOT v_is_credit AND v_order.invoice_journal_entry_id IS NULL THEN
    PERFORM post_deposit_paid_journals(p_order_id, p_posted_by);
    v_gl_posted := true;
  END IF;

  -- Credit order: post the invoice journal at Quote Approved, or (if it was never
  -- posted, e.g. terms were switched to credit after approval) when leaving it.
  IF v_is_credit
     AND v_order.invoice_journal_entry_id IS NULL
     AND ( p_new_status = 'Quote Approved'
           OR (v_old_status = 'Quote Approved' AND p_new_status = 'Material Check') ) THEN
    PERFORM post_credit_order_invoice(p_order_id, p_posted_by);
    v_gl_posted := true;
  END IF;

  -- ── Status update ──────────────────────────────────────────────────────────

  UPDATE orders
  SET    status              = p_new_status,
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

REVOKE EXECUTE ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION advance_order_status(uuid, text, uuid, jsonb) IS
  'Atomically advance order status and post GL journals in one transaction. '
  'Credit order = payment_terms IN (30_day, 60_day, custom), any customer type. '
  'Quote Approved -> Material Check (skipping Deposit Paid) requires a credit order and an approval reference.';

NOTIFY pgrst, 'reload schema';
