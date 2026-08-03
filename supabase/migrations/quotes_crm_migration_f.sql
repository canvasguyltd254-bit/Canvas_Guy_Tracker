-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration F: Schema corrections + atomic conversion RPC
--
-- Run AFTER quotes_crm_migration_e.sql.
-- Safe to re-run (all DDL uses IF NOT EXISTS / OR REPLACE).
--
-- Fixes:
--   1. Add orders.project_description (missing from Migrations A–E)
--   2. Fix orders.pricing_mode CHECK constraint to allow 'none'
--      (Migration A CHECK only allowed 'vat_exclusive'|'vat_inclusive';
--       orders_pricing_mode.sql used ADD COLUMN IF NOT EXISTS which
--       silently no-ops when the column exists, leaving the old
--       constraint in place and blocking direct orders with mode 'none')
--   3. Replace convert_quote_to_order() RPC:
--      a. Use quotation.payment_terms (negotiated) instead of
--         customer.credit_terms (default) to set order payment_terms
--         and customer_type. Fixes bug where the negotiated term was
--         silently ignored and the order could be misclassified.
--      b. For credit orders, atomically call post_credit_order_invoice()
--         inside the same transaction so the order is never left in
--         Quote Approved without an invoice journal.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. orders.project_description
--    The convert RPC has always written this column; it was never
--    added in the migrations. Notes already exists in schema.sql.
-- ────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS project_description text;

COMMENT ON COLUMN orders.project_description
  IS 'Free-text project description copied from the source quotation at conversion, or entered directly for direct orders.';


-- ────────────────────────────────────────────────────────────
-- 2. Fix orders.pricing_mode CHECK constraint
--    Migration A added: CHECK (pricing_mode IN ('vat_exclusive','vat_inclusive'))
--    Direct orders need 'none'. Drop the old constraint and add a
--    wider one. We use a DO block to handle the case where the
--    constraint may already have the correct definition.
-- ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  -- Find the current CHECK constraint on orders.pricing_mode
  SELECT conname INTO v_constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'orders'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%pricing_mode%'
  LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', v_constraint_name);
  END IF;

  -- Add the corrected constraint (allows NULL for legacy rows, 'none', 'vat_exclusive', 'vat_inclusive')
  ALTER TABLE orders
    ADD CONSTRAINT orders_pricing_mode_check
      CHECK (pricing_mode IS NULL OR pricing_mode IN ('none', 'vat_exclusive', 'vat_inclusive'));

EXCEPTION WHEN duplicate_object THEN
  -- Constraint already exists with the same name — nothing to do
  NULL;
END;
$$;

-- Also ensure the column default is 'none' for new direct orders
ALTER TABLE orders
  ALTER COLUMN pricing_mode SET DEFAULT 'none';

COMMENT ON COLUMN orders.pricing_mode
  IS 'none = simple unit_price × qty (no VAT); vat_exclusive = net prices (VAT added on top); vat_inclusive = gross prices (VAT back-calculated). Copied from quotation at conversion; set directly for direct orders.';


-- ────────────────────────────────────────────────────────────
-- 3. Replacement convert_quote_to_order RPC
--
--    Key changes vs Migration C:
--      a) Derives payment_terms + customer_type from
--         v_quote.payment_terms (the negotiated term), not from
--         v_customer.credit_terms (the customer default).
--         Quote terms map:
--           cash_before  → cash_before / retail
--           deposit_50   → deposit_50  / retail
--           on_delivery  → on_delivery / retail
--           net_30       → 30_day      / commercial
--           net_60       → 60_day      / commercial
--         Any other value passes through as-is / retail.
--      b) For credit orders (commercial + 30_day/60_day), calls
--         post_credit_order_invoice() before returning. If that
--         call raises an exception the whole transaction rolls back
--         so the order is never left without its invoice journal.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id   uuid,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote         quotations%ROWTYPE;
  v_customer      customers%ROWTYPE;
  v_order_id      uuid;
  v_payment_terms text;
  v_customer_type text;
  v_payment_due   date;
  v_is_credit     boolean;
BEGIN
  -- 1. Lock the quotation row
  SELECT * INTO v_quote
  FROM quotations
  WHERE id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND: quotation % does not exist', p_quote_id;
  END IF;

  -- 2. Idempotency: if already converted, return existing order
  IF v_quote.converted_order_id IS NOT NULL THEN
    RETURN v_quote.converted_order_id;
  END IF;

  -- 3. Validate state
  IF v_quote.status <> 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_NOT_ACCEPTED: quotation status is %, expected accepted', v_quote.status;
  END IF;

  IF v_quote.customer_id IS NULL THEN
    RAISE EXCEPTION 'QUOTE_NO_CUSTOMER: quotation must have a linked customer before conversion';
  END IF;

  -- 4. Fetch customer
  SELECT * INTO v_customer
  FROM customers
  WHERE id = v_quote.customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: customer % not found', v_quote.customer_id;
  END IF;

  -- 5. Map QUOTATION payment_terms → order payment_terms + customer_type.
  --    The quotation carries the negotiated term; the customer's credit_terms
  --    are a default that may have been overridden in the quote.
  CASE v_quote.payment_terms
    WHEN 'net_30' THEN
      v_payment_terms := '30_day';
      v_customer_type := 'commercial';
    WHEN 'net_60' THEN
      v_payment_terms := '60_day';
      v_customer_type := 'commercial';
    WHEN 'deposit_50' THEN
      v_payment_terms := 'deposit_50';
      v_customer_type := 'retail';
    WHEN 'on_delivery' THEN
      v_payment_terms := 'on_delivery';
      v_customer_type := 'retail';
    ELSE  -- 'cash_before' and any future values
      v_payment_terms := COALESCE(v_quote.payment_terms, 'cash_before');
      v_customer_type := 'retail';
  END CASE;

  -- 6. Calculate payment_due_date (credit orders only)
  v_is_credit := (v_customer_type = 'commercial' AND v_payment_terms IN ('30_day', '60_day', 'custom'));

  v_payment_due := CASE
    WHEN v_payment_terms = '30_day' THEN CURRENT_DATE + 30
    WHEN v_payment_terms = '60_day' THEN CURRENT_DATE + 60
    ELSE NULL
  END;

  -- 7. INSERT the order
  INSERT INTO orders (
    client,
    contact_person,
    customer_id,
    customer_type,
    payment_terms,
    payment_due_date,
    tax_status,
    pricing_mode,
    subtotal_amount,
    vat_amount,
    total_value,
    quote_id,
    status,
    order_type,
    notes,
    project_description,
    created_by,
    created_at,
    updated_at
  )
  VALUES (
    v_customer.name,
    COALESCE(v_quote.prospect_contact, v_customer.contact_person),
    v_quote.customer_id,
    v_customer_type,
    v_payment_terms,
    v_payment_due,
    COALESCE(v_quote.tax_status, v_customer.tax_status),
    COALESCE(v_quote.pricing_mode, 'none'),
    v_quote.subtotal,
    v_quote.vat_amount,
    v_quote.total,
    p_quote_id,
    'Quote Approved',
    'order',
    v_quote.project_description,
    v_quote.project_description,
    p_created_by,
    now(),
    now()
  )
  RETURNING id INTO v_order_id;

  -- 8. Copy quote_items → order_items (VAT snapshot preserved)
  INSERT INTO order_items (
    order_id,
    category,
    description,
    quantity,
    size,
    unit_price,
    line_type,
    tax_treatment,
    vat_rate,
    net_amount,
    vat_amount,
    gross_amount,
    sort_order,
    created_at
  )
  SELECT
    v_order_id,
    COALESCE(qi.category, 'Other'),
    qi.description,
    qi.quantity,
    qi.size,
    qi.unit_price,
    COALESCE(qi.line_type, 'product'),
    qi.tax_treatment,
    qi.vat_rate,
    qi.net_amount,
    qi.vat_amount,
    qi.gross_amount,
    qi.sort_order,
    now()
  FROM quote_items qi
  WHERE qi.quote_id = p_quote_id
  ORDER BY qi.sort_order;

  -- 9. Link converted order back to the quotation
  UPDATE quotations
  SET converted_order_id = v_order_id,
      updated_at         = now()
  WHERE id = p_quote_id;

  -- 10. Mark linked enquiry as 'won'
  IF v_quote.enquiry_id IS NOT NULL THEN
    UPDATE enquiries
    SET stage      = 'won',
        updated_at = now()
    WHERE id = v_quote.enquiry_id
      AND stage NOT IN ('won', 'lost');
  END IF;

  -- 11. For credit orders: post invoice GL atomically in this same transaction.
  --     A failure here rolls back the entire conversion so no orphaned order exists.
  IF v_is_credit THEN
    PERFORM post_credit_order_invoice(v_order_id, p_created_by);
  END IF;

  -- 12. Activity log
  INSERT INTO quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES (
    'quotation', p_quote_id, 'converted',
    'Quotation converted to order' || CASE WHEN v_is_credit THEN ' (credit invoice posted)' ELSE '' END,
    p_created_by
  );

  RETURN v_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) TO service_role;

COMMENT ON FUNCTION convert_quote_to_order(uuid, uuid) IS
  'Atomically converts an accepted quotation to a new order. Uses negotiated quote.payment_terms (not customer default) to set order terms and customer_type. For credit orders, posts the invoice GL in the same transaction. Idempotent.';


COMMIT;
