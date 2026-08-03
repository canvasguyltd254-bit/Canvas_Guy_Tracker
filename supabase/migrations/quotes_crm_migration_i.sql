-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration I: Fix charge line items on conversion
--
-- Run AFTER quotes_crm_migration_h.sql.
-- Safe to re-run (OR REPLACE + idempotent UPDATEs).
--
-- Problem:
--   Charges (Delivery Fee, Design Fee, etc.) are saved in quote_items
--   with line_type = 'delivery'|'design'|… and category = NULL.
--
--   Two bugs on conversion to order_items:
--
--   Bug 1 — Category: RPC COALESCE(qi.category, 'Other') → 'Other'.
--   The order form detects charges via CHARGE_TYPE_SET = {
--     'Delivery Fee', 'Design Fee', 'Installation Fee', 'Packaging', 'Other Charge'
--   }. 'Other' is NOT in that set, so charges are treated as product
--   items, run through calcTotals() with VAT math, and displayed wrong.
--
--   Bug 2 — unit_price: The order form accumulates charges as a flat sum:
--     chargesSubtotal = chargeItems.reduce((s, i) => s + i.unit_price, 0)
--   Charges are always entered as gross amounts (unit_price = gross_amount).
--   Migrations G/H overwrote unit_price = net_amount/qty for non-inclusive
--   modes, understating the displayed charge amount.
--
-- Fix:
--   For charge rows (line_type != 'product'):
--     category  = mapped from line_type ('delivery' → 'Delivery Fee', etc.)
--     unit_price = gross_amount  (flat display amount, no VAT re-computation)
--
--   For product rows (line_type = 'product' or NULL):
--     category  = original category (fallback 'Other' only for products)
--     unit_price = mode-aware effective price (from Migration H) — unchanged
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Retroactive fix — correct existing converted orders
-- ────────────────────────────────────────────────────────────

-- 1a. Fix category for charge rows (line_type != 'product')
UPDATE order_items oi
SET category = CASE oi.line_type
  WHEN 'delivery'     THEN 'Delivery Fee'
  WHEN 'design'       THEN 'Design Fee'
  WHEN 'installation' THEN 'Installation Fee'
  WHEN 'packaging'    THEN 'Packaging'
  ELSE 'Other Charge'
END
FROM orders o
WHERE oi.order_id    = o.id
  AND o.quote_id     IS NOT NULL
  AND oi.line_type   IS NOT NULL
  AND oi.line_type  <> 'product'
  AND oi.category   NOT IN ('Delivery Fee','Design Fee','Installation Fee','Packaging','Other Charge');

-- 1b. Fix unit_price for charge rows: restore to gross_amount
--     (Migrations G/H incorrectly set it to net_amount/qty)
UPDATE order_items oi
SET unit_price = COALESCE(oi.gross_amount, oi.net_amount, oi.unit_price)
FROM orders o
WHERE oi.order_id   = o.id
  AND o.quote_id    IS NOT NULL
  AND oi.line_type  IS NOT NULL
  AND oi.line_type <> 'product'
  AND oi.gross_amount IS NOT NULL
  AND ROUND(oi.unit_price::numeric, 2) <> ROUND(oi.gross_amount::numeric, 2);


-- ────────────────────────────────────────────────────────────
-- 2. Replacement RPC — correct category + unit_price for charges
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
  SELECT * INTO v_quote FROM quotations WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND: quotation % does not exist', p_quote_id;
  END IF;

  -- 2. Idempotency
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
  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: customer % not found', v_quote.customer_id;
  END IF;

  -- 5. Resolve pricing mode
  v_pricing_mode := COALESCE(v_quote.pricing_mode, 'none');

  -- 6. Map quote payment_terms → order payment_terms + customer_type
  CASE v_quote.payment_terms
    WHEN 'net_30'      THEN v_payment_terms := '30_day';    v_customer_type := 'commercial';
    WHEN 'net_60'      THEN v_payment_terms := '60_day';    v_customer_type := 'commercial';
    WHEN 'deposit_50'  THEN v_payment_terms := 'deposit_50'; v_customer_type := 'retail';
    WHEN 'on_delivery' THEN v_payment_terms := 'on_delivery'; v_customer_type := 'retail';
    ELSE v_payment_terms := COALESCE(v_quote.payment_terms, 'cash_before'); v_customer_type := 'retail';
  END CASE;

  -- 7. Payment due date
  v_is_credit := (v_customer_type = 'commercial' AND v_payment_terms IN ('30_day', '60_day', 'custom'));
  v_payment_due := CASE
    WHEN v_payment_terms = '30_day' THEN CURRENT_DATE + 30
    WHEN v_payment_terms = '60_day' THEN CURRENT_DATE + 60
    ELSE NULL
  END;

  -- 8. INSERT order header
  INSERT INTO orders (
    client, contact_person, customer_id, customer_type,
    payment_terms, payment_due_date, tax_status, pricing_mode,
    subtotal_amount, vat_amount, total_value,
    quote_id, status, order_type, notes, project_description,
    created_by, created_at, updated_at
  ) VALUES (
    v_customer.name,
    COALESCE(v_quote.prospect_contact, v_customer.contact_person),
    v_quote.customer_id, v_customer_type, v_payment_terms, v_payment_due,
    COALESCE(v_quote.tax_status, v_customer.tax_status),
    v_pricing_mode,
    v_quote.subtotal, v_quote.vat_amount, v_quote.total,
    p_quote_id, 'Quote Approved', 'order',
    v_quote.project_description, v_quote.project_description,
    p_created_by, now(), now()
  ) RETURNING id INTO v_order_id;

  -- 9. Copy quote_items → order_items
  --
  --    PRODUCT rows (line_type = 'product' or NULL):
  --      category  = original category (fallback 'Other' for unset products)
  --      unit_price = mode-aware effective price so calcTotals() matches:
  --                   vat_inclusive  → gross_amount / qty
  --                   vat_exclusive / none → net_amount / qty
  --
  --    CHARGE rows (line_type != 'product'):
  --      category  = mapped from line_type to CHARGE_TYPE_SET value so
  --                   isChargeItem() in the order form recognises them
  --      unit_price = gross_amount  (flat charge amount; the order form
  --                   sums charge unit_prices directly, no VAT re-math)
  --
  INSERT INTO order_items (
    order_id, category, description, quantity, size,
    finish_type, finish_color, wood_type,
    unit_price,
    line_type, tax_treatment, vat_rate,
    net_amount, vat_amount, gross_amount,
    sort_order, created_at
  )
  SELECT
    v_order_id,

    -- category
    CASE
      WHEN COALESCE(qi.line_type, 'product') = 'product'
        THEN COALESCE(qi.category, 'Other')        -- product fallback
      ELSE CASE qi.line_type                        -- charge: map to CHARGE_TYPE_SET
        WHEN 'delivery'     THEN 'Delivery Fee'
        WHEN 'design'       THEN 'Design Fee'
        WHEN 'installation' THEN 'Installation Fee'
        WHEN 'packaging'    THEN 'Packaging'
        ELSE                     'Other Charge'
      END
    END,

    qi.description,
    qi.quantity,
    qi.size,
    qi.finish_type,
    qi.finish_color,
    qi.wood_type,

    -- unit_price
    CASE
      WHEN COALESCE(qi.line_type, 'product') <> 'product'
        -- Charge: use gross_amount as flat price (order form sums these directly)
        THEN COALESCE(qi.gross_amount, qi.net_amount, qi.unit_price)

      WHEN v_pricing_mode = 'vat_inclusive'
            AND qi.gross_amount IS NOT NULL AND qi.quantity > 0
        -- Product, inclusive: unit_price = gross/qty so calcTotals back-calcs VAT correctly
        THEN ROUND(qi.gross_amount / qi.quantity::numeric, 2)

      WHEN qi.net_amount IS NOT NULL AND qi.quantity > 0
        -- Product, exclusive/none: unit_price = net/qty so calcTotals × qty = net_amount
        THEN ROUND(qi.net_amount / qi.quantity::numeric, 2)

      ELSE qi.unit_price
    END,

    qi.line_type,
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
  SET converted_order_id = v_order_id, updated_at = now()
  WHERE id = p_quote_id;

  -- 11. Mark linked enquiry as 'won'
  IF v_quote.enquiry_id IS NOT NULL THEN
    UPDATE enquiries SET stage = 'won', updated_at = now()
    WHERE id = v_quote.enquiry_id AND stage NOT IN ('won', 'lost');
  END IF;

  -- 12. For credit orders: post invoice GL atomically
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
  'Atomically converts an accepted quotation to a new order. '
  'Charge rows (line_type != product) get category mapped from line_type so the order form recognises them, and unit_price = gross_amount for direct flat-sum display. '
  'Product rows get mode-aware unit_price: gross/qty (vat_inclusive) or net/qty (exclusive/none). Idempotent.';

COMMIT;
