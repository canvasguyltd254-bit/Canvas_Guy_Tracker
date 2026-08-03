-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration H: Fix unit_price for vat_inclusive orders
--
-- Run AFTER quotes_crm_migration_g.sql.
-- Safe to re-run (OR REPLACE + idempotent UPDATE).
--
-- Problem (introduced in Migration G):
--   Migration G stored unit_price = net_amount / quantity for ALL
--   pricing modes. But calcTotals() treats unit_price differently
--   depending on mode:
--
--     vat_exclusive / none:
--       net   = unit_price × qty          ← unit_price is NET price
--       vat   = net × 0.16
--       gross = net + vat
--
--     vat_inclusive:
--       gross = unit_price × qty          ← unit_price is GROSS price
--       net   = gross / 1.16
--       vat   = gross − net
--
--   So for vat_inclusive orders, unit_price must be gross_amount / qty
--   (not net_amount / qty). Storing the net price caused the form to
--   back-calculate a smaller net, inflating the apparent VAT and making
--   the ITEMS subtotal diverge from the stored total_value.
--
-- Fix:
--   • vat_inclusive  → unit_price = gross_amount / qty
--   • vat_exclusive  → unit_price = net_amount   / qty
--   • none / exempt  → unit_price = net_amount   / qty
--     (net = gross when exempt, so either column is fine)
--
-- Part 1: Correct Migration G's retroactive UPDATE for vat_inclusive rows.
-- Part 2: Updated RPC with mode-aware unit_price formula.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Retroactive fix
--    For vat_inclusive orders from quotes: set unit_price = gross / qty
--    For all other modes from quotes:      set unit_price = net   / qty
--    (Migration G already set net/qty for non-inclusive; we only need
--     to touch vat_inclusive rows, but the WHERE filter makes it safe
--     to run across all modes without double-applying.)
-- ────────────────────────────────────────────────────────────

UPDATE order_items oi
SET unit_price = CASE
  WHEN o.pricing_mode = 'vat_inclusive' AND oi.gross_amount IS NOT NULL AND oi.quantity > 0
    THEN ROUND(oi.gross_amount / oi.quantity::numeric, 2)
  WHEN oi.net_amount IS NOT NULL AND oi.quantity > 0
    THEN ROUND(oi.net_amount / oi.quantity::numeric, 2)
  ELSE oi.unit_price
END
FROM orders o
WHERE oi.order_id = o.id
  AND o.quote_id IS NOT NULL   -- only converted-from-quote orders
  AND (
    -- vat_inclusive: fix if unit_price ≠ gross/qty
    (o.pricing_mode = 'vat_inclusive'
      AND oi.gross_amount IS NOT NULL
      AND oi.quantity > 0
      AND ROUND(oi.unit_price::numeric, 2)
       <> ROUND(oi.gross_amount / oi.quantity::numeric, 2))
    OR
    -- all other modes: fix if unit_price ≠ net/qty
    (COALESCE(o.pricing_mode, 'none') <> 'vat_inclusive'
      AND oi.net_amount IS NOT NULL
      AND oi.quantity > 0
      AND ROUND(oi.unit_price::numeric, 2)
       <> ROUND(oi.net_amount / oi.quantity::numeric, 2))
  );


-- ────────────────────────────────────────────────────────────
-- 2. Replacement RPC — mode-aware unit_price on conversion
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
  v_pricing_mode  text;
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

  -- 5. Resolve pricing mode (used to pick correct unit_price formula below)
  v_pricing_mode := COALESCE(v_quote.pricing_mode, 'none');

  -- 6. Map QUOTATION payment_terms → order payment_terms + customer_type
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

  -- 7. Calculate payment_due_date (credit orders only)
  v_is_credit := (v_customer_type = 'commercial' AND v_payment_terms IN ('30_day', '60_day', 'custom'));

  v_payment_due := CASE
    WHEN v_payment_terms = '30_day' THEN CURRENT_DATE + 30
    WHEN v_payment_terms = '60_day' THEN CURRENT_DATE + 60
    ELSE NULL
  END;

  -- 8. INSERT the order
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
    v_pricing_mode,
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

  -- 9. Copy quote_items → order_items
  --
  --    unit_price is set so that calcTotals(items, pricingMode) on the
  --    order form reproduces the same net/vat/gross as the original quote:
  --
  --      vat_inclusive  → unit_price = gross_amount / qty
  --                        calcTotals: gross = unit_price × qty  ✓
  --                                    net   = gross / 1.16      ✓
  --
  --      vat_exclusive  → unit_price = net_amount / qty
  --      none / exempt  → unit_price = net_amount / qty
  --                        calcTotals: net   = unit_price × qty  ✓
  --                                    vat   = net × 0.16        ✓
  --
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
    -- Mode-aware unit_price so calcTotals() reproduces quote totals exactly
    CASE
      WHEN v_pricing_mode = 'vat_inclusive'
            AND qi.gross_amount IS NOT NULL
            AND qi.quantity > 0
        THEN ROUND(qi.gross_amount / qi.quantity::numeric, 2)
      WHEN qi.net_amount IS NOT NULL
            AND qi.quantity > 0
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

  -- 10. Link converted order back to the quotation
  UPDATE quotations
  SET converted_order_id = v_order_id,
      updated_at         = now()
  WHERE id = p_quote_id;

  -- 11. Mark linked enquiry as 'won'
  IF v_quote.enquiry_id IS NOT NULL THEN
    UPDATE enquiries
    SET stage      = 'won',
        updated_at = now()
    WHERE id = v_quote.enquiry_id
      AND stage NOT IN ('won', 'lost');
  END IF;

  -- 12. For credit orders: post invoice GL atomically in this same transaction
  IF v_is_credit THEN
    PERFORM post_credit_order_invoice(v_order_id, p_created_by);
  END IF;

  -- 13. Activity log
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
  'Atomically converts an accepted quotation to a new order. unit_price in order_items is set mode-aware: gross/qty for vat_inclusive (calcTotals treats unit_price as gross), net/qty for all other modes. Guarantees order form display matches quote totals for all VAT modes. Idempotent.';

COMMIT;
