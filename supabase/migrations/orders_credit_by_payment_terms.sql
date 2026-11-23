-- ============================================================
-- Orders: credit terms (30_day / 60_day / custom) bypass the Deposit Paid gate,
-- and the financial gates are enforced in the database.
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
--   While fixing it, review found the surrounding controls were also bypassable:
--     - advance_order_status accepted ANY status -> ANY status
--     - credit exposure was added on every call that carried an approval ref
--     - RLS lets Sales / Production Staff UPDATE orders directly from the browser
--       (status, payment_terms, credit_approval_ref ...), skipping the API entirely
--
-- CHANGE
--   1. Credit order = payment_terms IN ('30_day','60_day','custom'). Customer type
--      is not part of the rule. (Mirrors shared/lib/isCreditOrder.js.)
--   2. Legal transitions only. A forward move must be one of the listed edges;
--      anything else raises INVALID_TRANSITION. (Send-back stays a separate,
--      role-checked path in the API route.)
--   3. Quote Approved -> Material Check (skips Deposit Paid) needs a credit order,
--      an approval reference and room under the client's credit limit:
--        DEPOSIT_REQUIRED / CREDIT_APPROVAL_REQUIRED / CREDIT_LIMIT_EXCEEDED
--   4. Deposit Paid needs at least one unreversed payment on the order, for every
--      order (DEPOSIT_PAYMENT_REQUIRED). Before, an order that already had an
--      invoice journal could reach Deposit Paid with no payment at all.
--   5. Credit exposure is counted once per order (orders.credit_exposure_counted)
--      and released on send-back to Quote Approved or on cancellation. An approval
--      ref on any other transition is ignored.
--   6. The credit invoice journal is posted at Quote Approved (as before) AND, if it
--      was never posted, when the order leaves Quote Approved.
--   7. Guard trigger: browser sessions (role authenticated / anon) can no longer
--      write status, payment_terms, credit_approval_ref, refund_reference,
--      credit_exposure_counted or invoice_journal_entry_id on orders. The API
--      (service role) and the SECURITY DEFINER functions are unaffected.
--
-- NOT changed here: who may approve credit. That is a role rule and lives in
-- app/api/orders/[id]/status/route.js (admin, or head_of_sales up to the cap).
-- ============================================================

-- 1. Per-order record of the exposure already added to client_profiles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'orders'
                   AND column_name = 'credit_exposure_counted') THEN
    ALTER TABLE orders ADD COLUMN credit_exposure_counted numeric(14,2) NOT NULL DEFAULT 0;
    -- Orders approved before this migration were counted once at approval time.
    UPDATE orders SET credit_exposure_counted = COALESCE(total_value, 0)
    WHERE  credit_approval_ref IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN orders.credit_exposure_counted IS
  'Amount already added to client_profiles.current_exposure for this order. Makes approval idempotent; released on send-back or cancel.';

-- 2. Release a counted exposure (send-back to Quote Approved, cancellation).
CREATE OR REPLACE FUNCTION release_order_credit_exposure(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF COALESCE(v_order.credit_exposure_counted, 0) <= 0 THEN RETURN 0; END IF;

  UPDATE client_profiles
  SET    current_exposure = GREATEST(0, COALESCE(current_exposure, 0) - v_order.credit_exposure_counted)
  WHERE  client_name = v_order.client;

  UPDATE orders SET credit_exposure_counted = 0 WHERE id = p_order_id;
  RETURN v_order.credit_exposure_counted;
END;
$$;

REVOKE EXECUTE ON FUNCTION release_order_credit_exposure(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION release_order_credit_exposure(uuid) TO service_role;

-- 3. The status function.
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
  v_is_credit_skip     boolean;
  v_gl_posted          boolean := false;
  v_credit_terms       text[]  := ARRAY['30_day','60_day','custom'];
  v_credit_approval    text;
  v_refund_ref         text;
  v_allowed            boolean;
  v_limit              numeric;
  v_exposure           numeric;
  v_delta              numeric := 0;
BEGIN
  -- Lock the row for the duration of this transaction
  SELECT * INTO v_order
  FROM   orders
  WHERE  id = p_order_id
  FOR    UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  v_old_status := v_order.status;
  v_refund_ref := NULLIF(btrim(p_extra->>'refund_reference'), '');

  IF v_old_status = p_new_status THEN
    RAISE EXCEPTION 'SAME_STATUS';
  END IF;

  -- Credit order = credit payment terms. Customer type is not part of the rule.
  v_is_credit := COALESCE(v_order.payment_terms = ANY(v_credit_terms), false);

  -- ── Legal forward transitions ──────────────────────────────────────────────
  IF v_order.order_type IN ('repair', 'return') THEN
    v_allowed := (v_old_status, p_new_status) IN (
      ('Reported','Assessed'), ('Assessed','In Repair'), ('In Repair','QC'),
      ('QC','Redelivered'),    ('Redelivered','Closed')
    );
  ELSE
    v_allowed := (v_old_status, p_new_status) IN (
      ('Inquiry','Quote Approved'),
      ('Quote Approved','Deposit Paid'),
      ('Quote Approved','Material Check'),        -- credit skip, guarded below
      ('Quote Approved','Cancelled / Refunded'),
      ('Deposit Paid','Material Check'),
      ('Material Check','Production'),
      ('Production','Quality Control'),
      ('Quality Control','Ready for Delivery'),
      ('Ready for Delivery','Delivered'),
      ('Ready for Delivery','Partially Delivered'),
      ('Partially Delivered','Delivered'),
      ('Delivered','Closed')
    );
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', v_old_status, p_new_status;
  END IF;

  -- The approval reference only counts on the credit skip itself.
  v_is_credit_skip := (v_old_status = 'Quote Approved' AND p_new_status = 'Material Check');
  v_credit_approval := CASE WHEN v_is_credit_skip THEN NULLIF(btrim(p_extra->>'credit_approval_ref'), '') END;

  -- ── Credit skip guard ──────────────────────────────────────────────────────
  IF v_is_credit_skip THEN
    IF NOT v_is_credit THEN
      RAISE EXCEPTION 'DEPOSIT_REQUIRED';
    END IF;
    IF v_credit_approval IS NULL THEN
      RAISE EXCEPTION 'CREDIT_APPROVAL_REQUIRED';
    END IF;

    -- Count this order's exposure once. delta = what is not yet counted.
    v_delta := COALESCE(v_order.total_value, 0) - COALESCE(v_order.credit_exposure_counted, 0);

    SELECT credit_limit, COALESCE(current_exposure, 0)
    INTO   v_limit, v_exposure
    FROM   client_profiles
    WHERE  client_name = v_order.client
    FOR UPDATE;

    IF FOUND AND COALESCE(v_limit, 0) > 0 AND v_exposure + v_delta > v_limit THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED: exposure % + order % exceeds limit %',
        v_exposure, v_delta, v_limit;
    END IF;
  END IF;

  -- ── Deposit proof ──────────────────────────────────────────────────────────
  IF p_new_status = 'Deposit Paid' THEN
    IF NOT EXISTS (SELECT 1 FROM order_payments
                   WHERE order_id = p_order_id AND reversed_at IS NULL) THEN
      RAISE EXCEPTION 'DEPOSIT_PAYMENT_REQUIRED';
    END IF;
  END IF;

  IF p_new_status = 'Cancelled / Refunded' AND v_refund_ref IS NULL THEN
    RAISE EXCEPTION 'REFUND_REFERENCE_REQUIRED';
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
     AND ( p_new_status = 'Quote Approved' OR v_is_credit_skip ) THEN
    PERFORM post_credit_order_invoice(p_order_id, p_posted_by);
    v_gl_posted := true;
  END IF;

  -- ── Status update ──────────────────────────────────────────────────────────

  UPDATE orders
  SET    status                  = p_new_status,
         credit_approval_ref     = COALESCE(v_credit_approval, credit_approval_ref),
         refund_reference        = COALESCE(v_refund_ref,      refund_reference),
         credit_exposure_counted = CASE WHEN v_is_credit_skip THEN COALESCE(v_order.total_value, 0)
                                        ELSE credit_exposure_counted END,
         updated_at              = NOW()
  WHERE  id = p_order_id;

  -- ── Credit exposure (once per order) ───────────────────────────────────────
  IF v_is_credit_skip AND v_delta <> 0 THEN
    UPDATE client_profiles
    SET    current_exposure = GREATEST(0, COALESCE(current_exposure, 0) + v_delta)
    WHERE  client_name = v_order.client;
  END IF;

  -- A cancelled order no longer carries credit exposure.
  IF p_new_status = 'Cancelled / Refunded' THEN
    PERFORM release_order_credit_exposure(p_order_id);
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
  'Atomically advance order status and post GL journals. Enforces legal transitions, the credit skip '
  '(credit terms + approval ref + credit limit), deposit proof, and once-only credit exposure.';

-- 4. Browsers may not write financial/workflow columns on orders directly.
--    RLS lets Sales and Production Staff UPDATE orders from the browser; without this
--    they could set status or payment_terms and skip every check above.
CREATE OR REPLACE FUNCTION orders_guard_workflow_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- current_user is 'authenticated' / 'anon' for browser (PostgREST) sessions. Inside the
  -- SECURITY DEFINER functions it is the function owner, and for the API's service-role
  -- client it is service_role; both pass.
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.status                  IS DISTINCT FROM OLD.status
    OR NEW.payment_terms           IS DISTINCT FROM OLD.payment_terms
    OR NEW.credit_approval_ref     IS DISTINCT FROM OLD.credit_approval_ref
    OR NEW.refund_reference        IS DISTINCT FROM OLD.refund_reference
    OR NEW.credit_exposure_counted IS DISTINCT FROM OLD.credit_exposure_counted
    OR NEW.invoice_journal_entry_id IS DISTINCT FROM OLD.invoice_journal_entry_id THEN
      RAISE EXCEPTION 'ORDER_COLUMN_LOCKED: status, payment terms and credit fields are changed through the order workflow, not directly';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_guard_workflow_columns ON orders;
CREATE TRIGGER trg_orders_guard_workflow_columns
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_workflow_columns();

NOTIFY pgrst, 'reload schema';
