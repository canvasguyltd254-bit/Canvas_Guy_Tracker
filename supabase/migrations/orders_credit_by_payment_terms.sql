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
--   Review of the fix found the surrounding controls were also bypassable:
--     - advance_order_status accepted ANY status -> ANY status
--     - credit exposure was a counter that only ever grew, and an approval for a
--       client with no credit profile (or limit 0) passed unchecked
--     - RLS lets browser sessions write orders, client_profiles and order_payments
--       directly (status, payment_terms, credit limit, fake payments ...)
--
-- CHANGE
--   1. Credit order = payment_terms IN ('30_day','60_day','custom'). Customer type
--      is not part of the rule. (Mirrors shared/lib/isCreditOrder.js.)
--   2. Legal forward transitions only (INVALID_TRANSITION).
--   3. Quote Approved -> Material Check (skips Deposit Paid) needs a credit order,
--      an approval reference, and a credit profile with a limit above 0 that has
--      room. It FAILS CLOSED:
--        DEPOSIT_REQUIRED / CREDIT_APPROVAL_REQUIRED /
--        CREDIT_PROFILE_REQUIRED / CREDIT_LIMIT_NOT_SET / CREDIT_LIMIT_EXCEEDED
--   4. Deposit Paid needs at least one unreversed payment on the order, for every
--      order (DEPOSIT_PAYMENT_REQUIRED).
--   5. Credit exposure is OUTSTANDING credit, not a lifetime counter:
--      sum over the client's credit-approved orders of (order total - unreversed
--      payments), cancelled orders excluded. It is recomputed whenever a payment,
--      an order total, an approval or a send-back/cancel changes it, so paying
--      reduces exposure and nothing can be counted twice.
--      orders.credit_exposure_counted is now just the "credit-approved" marker.
--   6. The credit invoice journal is posted at Quote Approved (as before) AND, if it
--      was never posted, when the order leaves Quote Approved.
--   7. Guard triggers. Browser sessions (role authenticated / anon):
--        orders          may change ONLY quote_number and batch_delivery; may insert
--                        only a fresh 'Inquiry' with no credit/refund/invoice links
--        client_profiles may not change credit_limit / current_exposure / name /
--                        type; may insert only with limit 0 and exposure 0
--        order_payments  may not insert, update or delete
--      The API (service role) and the SECURITY DEFINER functions are unaffected.
--
-- EXISTING DATA: client_profiles.current_exposure is overwritten with the live
-- outstanding figure (previously a lifetime sum). Clients with no profile, or a
-- limit of 0, cannot get credit approved until an admin sets a limit
-- (Admin -> Clients, or PATCH /api/admin/clients/:name/credit-limit).
-- ============================================================

ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS current_exposure numeric(14,2) NOT NULL DEFAULT 0;

-- 1. "Credit-approved" marker (amount at approval; live amounts come from total_value).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'orders'
                   AND column_name = 'credit_exposure_counted') THEN
    ALTER TABLE orders ADD COLUMN credit_exposure_counted numeric(14,2) NOT NULL DEFAULT 0;
    -- Orders credit-approved before this migration and still past Quote Approved.
    UPDATE orders SET credit_exposure_counted = COALESCE(total_value, 0)
    WHERE  credit_approval_ref IS NOT NULL
      AND  status NOT IN ('Inquiry', 'Quote Approved', 'Cancelled / Refunded');
  END IF;
END $$;

COMMENT ON COLUMN orders.credit_exposure_counted IS
  'Non-zero = this order was credit-approved and counts toward the client''s outstanding credit exposure. Cleared on send-back to Quote Approved or cancellation.';

-- 2. Live outstanding credit for a client (optionally excluding one order).
CREATE OR REPLACE FUNCTION client_credit_outstanding(p_client text, p_exclude uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(GREATEST(0, COALESCE(o.total_value, 0) - COALESCE(p.paid, 0))), 0)
  FROM   orders o
  LEFT   JOIN LATERAL (
           SELECT SUM(amount) AS paid
           FROM   order_payments
           WHERE  order_id = o.id AND reversed_at IS NULL
         ) p ON true
  WHERE  o.client = p_client
    AND  o.credit_exposure_counted > 0
    AND  o.status <> 'Cancelled / Refunded'
    AND  (p_exclude IS NULL OR o.id <> p_exclude);
$$;

REVOKE EXECUTE ON FUNCTION client_credit_outstanding(text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION client_credit_outstanding(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION refresh_client_exposure(p_client text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE client_profiles
  SET    current_exposure = client_credit_outstanding(p_client)
  WHERE  client_name = p_client;
$$;

REVOKE EXECUTE ON FUNCTION refresh_client_exposure(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION refresh_client_exposure(text) TO service_role;

-- Keep the stored figure in step with orders and payments.
CREATE OR REPLACE FUNCTION orders_refresh_exposure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM refresh_client_exposure(NEW.client);
  IF OLD.client IS DISTINCT FROM NEW.client THEN PERFORM refresh_client_exposure(OLD.client); END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_refresh_exposure ON orders;
CREATE TRIGGER trg_orders_refresh_exposure
  AFTER UPDATE OF total_value, status, client, credit_exposure_counted ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_refresh_exposure();

CREATE OR REPLACE FUNCTION order_payments_refresh_exposure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_client text;
BEGIN
  SELECT client INTO v_client FROM orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  IF v_client IS NOT NULL THEN PERFORM refresh_client_exposure(v_client); END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_payments_refresh_exposure ON order_payments;
CREATE TRIGGER trg_order_payments_refresh_exposure
  AFTER INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION order_payments_refresh_exposure();

-- 3. Withdraw an order's credit approval (send-back to Quote Approved, cancellation).
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

  -- The orders trigger recomputes the client's exposure.
  UPDATE orders SET credit_exposure_counted = 0 WHERE id = p_order_id;
  RETURN v_order.credit_exposure_counted;
END;
$$;

REVOKE EXECUTE ON FUNCTION release_order_credit_exposure(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION release_order_credit_exposure(uuid) TO service_role;

-- 4. The status function.
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
  v_others             numeric;
  v_this_paid          numeric;
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

  -- ── Credit skip guard (fails closed) ───────────────────────────────────────
  IF v_is_credit_skip THEN
    IF NOT v_is_credit THEN
      RAISE EXCEPTION 'DEPOSIT_REQUIRED';
    END IF;
    IF v_credit_approval IS NULL THEN
      RAISE EXCEPTION 'CREDIT_APPROVAL_REQUIRED';
    END IF;

    -- Lock the client's profile so concurrent approvals for one client queue up.
    SELECT credit_limit INTO v_limit
    FROM   client_profiles
    WHERE  client_name = v_order.client
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDIT_PROFILE_REQUIRED';
    END IF;
    IF COALESCE(v_limit, 0) <= 0 THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_NOT_SET';
    END IF;

    v_others := client_credit_outstanding(v_order.client, p_order_id);
    SELECT COALESCE(SUM(amount), 0) INTO v_this_paid
    FROM   order_payments WHERE order_id = p_order_id AND reversed_at IS NULL;

    IF v_others + GREATEST(0, COALESCE(v_order.total_value, 0) - v_this_paid) > v_limit THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED: outstanding % + this order % exceeds limit %',
        v_others, GREATEST(0, COALESCE(v_order.total_value, 0) - v_this_paid), v_limit;
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
  -- The orders trigger recomputes the client's outstanding exposure from this.

  UPDATE orders
  SET    status                  = p_new_status,
         credit_approval_ref     = COALESCE(v_credit_approval, credit_approval_ref),
         refund_reference        = COALESCE(v_refund_ref,      refund_reference),
         credit_exposure_counted = CASE WHEN v_is_credit_skip THEN COALESCE(v_order.total_value, 0)
                                        WHEN p_new_status = 'Cancelled / Refunded' THEN 0
                                        ELSE credit_exposure_counted END,
         updated_at              = NOW()
  WHERE  id = p_order_id;

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
  '(credit terms + approval ref + credit profile with a limit + room under it), deposit proof, and live outstanding exposure.';

-- 5. Guard triggers: browsers may not write workflow / credit / payment data directly.
--    They are named aaa_* so they fire before any other BEFORE trigger on the table
--    and see exactly what the browser sent.
--    current_user is 'authenticated' / 'anon' for browser (PostgREST) sessions; inside the
--    SECURITY DEFINER functions it is the function owner; for the API it is service_role.

CREATE OR REPLACE FUNCTION orders_guard_workflow_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_browser_may_change text[] := ARRAY['quote_number', 'batch_delivery', 'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'Inquiry'
       OR NEW.credit_approval_ref IS NOT NULL
       OR NEW.refund_reference IS NOT NULL
       OR COALESCE(NEW.credit_exposure_counted, 0) <> 0
       OR NEW.invoice_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'ORDER_COLUMN_LOCKED: a new order starts as Inquiry with no credit, refund or invoice links';
    END IF;
  ELSIF (to_jsonb(NEW) - v_browser_may_change) IS DISTINCT FROM (to_jsonb(OLD) - v_browser_may_change) THEN
    RAISE EXCEPTION 'ORDER_COLUMN_LOCKED: only the quote number and batch delivery can be saved directly; everything else goes through the order workflow';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_guard_workflow_columns ON orders;      -- earlier name
DROP TRIGGER IF EXISTS aaa_orders_guard_workflow_columns ON orders;
CREATE TRIGGER aaa_orders_guard_workflow_columns
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard_workflow_columns();

CREATE OR REPLACE FUNCTION client_profiles_guard_credit_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_browser_may_change text[] := ARRAY['notes', 'updated_at'];
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.credit_limit, 0) <> 0 OR COALESCE(NEW.current_exposure, 0) <> 0 THEN
      RAISE EXCEPTION 'CREDIT_COLUMN_LOCKED: credit limits are set by an admin, and exposure is calculated';
    END IF;
  ELSIF (to_jsonb(NEW) - v_browser_may_change) IS DISTINCT FROM (to_jsonb(OLD) - v_browser_may_change) THEN
    RAISE EXCEPTION 'CREDIT_COLUMN_LOCKED: credit limits are set by an admin, and exposure is calculated';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_client_profiles_guard_credit_columns ON client_profiles;
CREATE TRIGGER aaa_client_profiles_guard_credit_columns
  BEFORE INSERT OR UPDATE ON client_profiles
  FOR EACH ROW EXECUTE FUNCTION client_profiles_guard_credit_columns();

CREATE OR REPLACE FUNCTION order_payments_guard_browser_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'PAYMENT_WRITE_LOCKED: payments are recorded through the payments workflow, not directly';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_order_payments_guard_browser_writes ON order_payments;
CREATE TRIGGER aaa_order_payments_guard_browser_writes
  BEFORE INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION order_payments_guard_browser_writes();

-- 6. Recompute every client's exposure from live data (replaces the old lifetime counter).
UPDATE client_profiles SET current_exposure = client_credit_outstanding(client_name);

NOTIFY pgrst, 'reload schema';
