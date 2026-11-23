-- ============================================================
-- Orders: credit terms (30_day / 60_day / custom) bypass the Deposit Paid gate,
-- and the financial gates are enforced in the database.
-- Run AFTER quotes_crm_migration_d.sql, customers_module.sql and the later CRM migrations.
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
--     - an approval for a client with no limit passed unchecked
--     - RLS lets browser sessions write orders, payments and customer credit fields
--       directly (status, payment_terms, credit limit, fake payments ...)
--
-- CHANGE
--   1. Credit order = payment_terms IN ('30_day','60_day','custom'). Customer type
--      is not part of the rule. (Mirrors shared/lib/isCreditOrder.js.)
--   2. Legal forward transitions only (INVALID_TRANSITION).
--   3. Quote Approved -> Material Check (skips Deposit Paid) needs a credit order,
--      an approval reference, an order linked to a CUSTOMER record, and that
--      customer's credit limit (Customers screen) must be above 0 with room left.
--      It FAILS CLOSED:
--        DEPOSIT_REQUIRED / CREDIT_APPROVAL_REQUIRED / CUSTOMER_REQUIRED /
--        CREDIT_LIMIT_NOT_SET / CREDIT_LIMIT_EXCEEDED
--   4. ONE credit limit: customers.credit_limit. (client_profiles.credit_limit is no
--      longer read by the gate.) Exposure = what the customer actually owes:
--        opening balance (if positive)
--        + unpaid balance of the customer's orders that are past Quote Approved
--          (Deposit Paid onward), cancelled orders excluded.
--      Enquiries and unapproved quotes do not count. Paying reduces it.
--      See customer_credit_position().
--   5. Deposit Paid needs at least one unreversed payment on the order, for every
--      order (DEPOSIT_PAYMENT_REQUIRED).
--   6. The credit invoice journal is posted at Quote Approved (as before) AND, if it
--      was never posted, when the order leaves Quote Approved.
--   7. Guard triggers. Browser sessions (role authenticated / anon):
--        orders          may change ONLY quote_number and batch_delivery; may insert
--                        only a fresh 'Inquiry' with no credit/refund/invoice links
--        customers       may not change credit_limit / opening_balance(+date);
--                        may insert only with limit 0 and opening balance 0
--        order_payments  may not insert, update or delete
--      The API (service role) and the SECURITY DEFINER functions are unaffected.
--
-- After running: set each credit customer's limit on the Customers screen (admin only),
-- and make sure credit orders are linked to that customer (order -> Customer profile).
-- ============================================================

-- 0. Remove objects from an earlier draft that tracked exposure on client_profiles.
DROP TRIGGER IF EXISTS trg_orders_refresh_exposure          ON orders;
DROP TRIGGER IF EXISTS trg_order_payments_refresh_exposure  ON order_payments;
DROP TRIGGER IF EXISTS aaa_client_profiles_guard_credit_columns ON client_profiles;
DROP FUNCTION IF EXISTS orders_refresh_exposure();
DROP FUNCTION IF EXISTS order_payments_refresh_exposure();
DROP FUNCTION IF EXISTS client_profiles_guard_credit_columns();
DROP FUNCTION IF EXISTS refresh_client_exposure(text);
DROP FUNCTION IF EXISTS client_credit_outstanding(text, uuid);
DROP FUNCTION IF EXISTS release_order_credit_exposure(uuid);
ALTER TABLE orders DROP COLUMN IF EXISTS credit_exposure_counted;

-- 1. What a customer owes, and their limit. Single source for the gate and the UI.
CREATE OR REPLACE FUNCTION customer_credit_position(p_customer_id uuid, p_exclude_order uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_c      customers%ROWTYPE;
  v_opening numeric;
  v_orders  numeric;
BEGIN
  SELECT * INTO v_c FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_opening := GREATEST(0, COALESCE(v_c.opening_balance, 0));

  SELECT COALESCE(SUM(GREATEST(0, COALESCE(o.total_value, 0) - COALESCE(p.paid, 0))), 0)
  INTO   v_orders
  FROM   orders o
  LEFT   JOIN LATERAL (
           SELECT SUM(amount) AS paid
           FROM   order_payments
           WHERE  order_id = o.id AND reversed_at IS NULL
         ) p ON true
  WHERE  o.customer_id = p_customer_id
    AND  o.status NOT IN ('Inquiry', 'Quote Approved', 'Cancelled / Refunded')
    AND  (p_exclude_order IS NULL OR o.id <> p_exclude_order);

  RETURN jsonb_build_object(
    'customer_name',   v_c.name,
    'limit',           COALESCE(v_c.credit_limit, 0),
    'opening_balance', v_opening,
    'owed_on_orders',  v_orders,
    'outstanding',     v_opening + v_orders
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION customer_credit_position(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION customer_credit_position(uuid, uuid) TO service_role;

-- 2. The status function.
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
  v_pos                jsonb;
  v_this               numeric;
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
    IF v_order.customer_id IS NULL THEN
      RAISE EXCEPTION 'CUSTOMER_REQUIRED';
    END IF;

    -- Lock the customer so concurrent approvals for one customer queue up.
    SELECT credit_limit INTO v_limit
    FROM   customers
    WHERE  id = v_order.customer_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CUSTOMER_REQUIRED';
    END IF;
    IF COALESCE(v_limit, 0) <= 0 THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_NOT_SET';
    END IF;

    -- What the customer owes on everything else, plus what is still unpaid on this order.
    v_pos  := customer_credit_position(v_order.customer_id, p_order_id);
    v_this := GREATEST(0, COALESCE(v_order.total_value, 0) - COALESCE(
                (SELECT SUM(amount) FROM order_payments
                  WHERE order_id = p_order_id AND reversed_at IS NULL), 0));

    IF (v_pos->>'outstanding')::numeric + v_this > v_limit THEN
      RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED: owed % + this order % exceeds limit %',
        (v_pos->>'outstanding')::numeric, v_this, v_limit;
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
  SET    status              = p_new_status,
         credit_approval_ref = COALESCE(v_credit_approval, credit_approval_ref),
         refund_reference    = COALESCE(v_refund_ref,      refund_reference),
         updated_at          = NOW()
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
  '(credit terms + approval ref + linked customer with a limit + room under it), and deposit proof.';

-- 3. Guard triggers: browsers may not write workflow / credit / payment data directly.
--    Named aaa_* so they fire before any other BEFORE trigger and see exactly what the browser sent.
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

CREATE OR REPLACE FUNCTION customers_guard_credit_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.credit_limit, 0) <> 0
       OR COALESCE(NEW.opening_balance, 0) <> 0
       OR NEW.opening_balance_date IS NOT NULL THEN
      RAISE EXCEPTION 'CREDIT_COLUMN_LOCKED: credit limit and opening balance are set by an admin';
    END IF;
  ELSIF NEW.credit_limit          IS DISTINCT FROM OLD.credit_limit
     OR NEW.opening_balance       IS DISTINCT FROM OLD.opening_balance
     OR NEW.opening_balance_date  IS DISTINCT FROM OLD.opening_balance_date THEN
    RAISE EXCEPTION 'CREDIT_COLUMN_LOCKED: credit limit and opening balance are set by an admin';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aaa_customers_guard_credit_columns ON customers;
CREATE TRIGGER aaa_customers_guard_credit_columns
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_guard_credit_columns();

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

NOTIFY pgrst, 'reload schema';
