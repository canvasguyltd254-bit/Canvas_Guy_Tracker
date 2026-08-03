-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration G: Fix order_items unit_price on conversion
--
-- Run AFTER quotes_crm_migration_f.sql.
-- Safe to re-run (all DDL uses OR REPLACE / idempotent UPDATE).
--
-- Problem:
--   Migration F's convert_quote_to_order() copies qi.unit_price
--   (the pre-discount list price) into order_items. The order form
--   recomputes totals with calcTotals(items, 'none') = unit_price × qty,
--   which gives the pre-discount total, not the actual quoted total.
--
--   Example (QT-2026-0005):
--     Quote total  = KES 125,400  (after discount on some items)
--     Order ITEMS  = KES 135,000  (6 × 22,500 + ... re-computed from unit_price)
--
-- Fix:
--   Store the effective per-unit price in order_items:
--     unit_price := net_amount / quantity
--   This guarantees unit_price × quantity = net_amount in every row,
--   so calcTotals() and the stored total_value always agree.
--
-- Part 1: Retroactive data fix for already-converted orders.
-- Part 2: Replacement RPC using the corrected unit_price formula.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Retroactive fix
--    Update every order_item that came from a quote conversion
--    where the stored unit_price × quantity ≠ net_amount.
--    Only touches rows where net_amount IS NOT NULL and
--    quantity > 0 so the division is safe.
-- ────────────────────────────────────────────────────────────

UPDATE order_items oi
SET    unit_price = ROUND(oi.net_amount / oi.quantity::numeric, 2)
FROM   orders o
WHERE  oi.order_id = o.id
  AND  o.quote_id  IS NOT NULL          -- converted from a quotation
  AND  oi.net_amount IS NOT NULL
  AND  oi.quantity   > 0
  -- only rows where the mismatch actually exists (avoids unnecessary writes)
  AND  ROUND(oi.unit_price::numeric, 2)
    <> ROUND(oi.net_amount / oi.quantity::numeric, 2);


-- ────────────────────────────────────────────────────────────
-- 2. Replacement RPC — effective unit_price on conversion
--    Identical to Migration F except the order_items INSERT
--    now stores  net_amount / quantity  as unit_price so that
--    unit_price × quantity = net_amount for every row.
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

  -- 5. Map QUOTATION payment_terms → order payment_terms + customer_type
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
    ELSE
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

  -- 8. Copy quote_items → order_items
  --    IMPORTANT: unit_price is set to net_amount / quantity (effective
  --    per-unit price after discounts) so that unit_price × qty = net_amount.
  --    This ensures calcTotals() on the order form agrees with the
  --    stored total_value copied from the quote.
  INSERT INTO order_items (
    order_id,
    category,
    description,
    quantity,
    size,
    finish_type,
    finish_color,
    wood_type,
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
    qi.finish_type,
    qi.finish_color,
    qi.wood_type,
    -- Effective per-unit price: guarantees unit_price × qty = net_amount
    CASE
      WHEN qi.quantity > 0 AND qi.net_amount IS NOT NULL
        THEN ROUND(qi.net_amount / qi.quantity::numeric, 2)
      ELSE qi.unit_price
    END,
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
  'Atomically converts an accepted quotation to a new order. Stores net_amount/quantity as unit_price in order_items so the order form total always matches the quote total. Idempotent.';


COMMIT;
