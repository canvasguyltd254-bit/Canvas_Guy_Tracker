-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration E: Production spec fields on quote_items
--
-- Run AFTER Migration D.
--
-- Changes:
--   1. ALTER quote_items — add category, finish_type, finish_color,
--      wood_type (all nullable, matching order_items columns)
--   2. REPLACE convert_quote_to_order — copy new columns to
--      order_items instead of hardcoding category = 'Other'
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Add production spec columns to quote_items
--    All nullable — sales can leave specs blank on early drafts.
--    The convert RPC will copy whatever is set; order_items
--    can always be updated post-conversion.
-- ────────────────────────────────────────────────────────────

ALTER TABLE quote_items
  ADD COLUMN IF NOT EXISTS category    text,
  ADD COLUMN IF NOT EXISTS finish_type text,
  ADD COLUMN IF NOT EXISTS finish_color text,
  ADD COLUMN IF NOT EXISTS wood_type   text;

COMMENT ON COLUMN quote_items.category     IS 'Canvas Guy product category — mirrors order_items.category. e.g. Wall Decoration Canvas, Mirrors, Furniture.';
COMMENT ON COLUMN quote_items.finish_type  IS 'Finish applied: Stain, PU Hard Finish, One Coat, NC, None.';
COMMENT ON COLUMN quote_items.finish_color IS 'Colour or stain shade, e.g. Dark Walnut.';
COMMENT ON COLUMN quote_items.wood_type    IS 'Timber species or board material, e.g. Mahogany, MDF.';


-- ────────────────────────────────────────────────────────────
-- 2. Replace convert_quote_to_order
--    Now copies category / finish_type / finish_color / wood_type
--    from quote_items. Falls back to 'Other' only when category
--    is NULL (pre-migration rows or intentionally unset).
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

  -- 4. Fetch customer for credit terms mapping
  SELECT * INTO v_customer
  FROM customers
  WHERE id = v_quote.customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: customer % not found', v_quote.customer_id;
  END IF;

  -- 5. Map customer credit_terms → order payment_terms and customer_type
  CASE v_customer.credit_terms
    WHEN '30 Days' THEN
      v_payment_terms := '30_day';
      v_customer_type := 'commercial';
    WHEN '60 Days' THEN
      v_payment_terms := '60_day';
      v_customer_type := 'commercial';
    WHEN '7 Days' THEN
      v_payment_terms := 'cash_before';
      v_customer_type := 'retail';
    ELSE
      v_payment_terms := 'cash_before';
      v_customer_type := 'retail';
  END CASE;

  -- 6. Calculate payment_due_date from credit terms
  v_payment_due := CURRENT_DATE + CASE v_customer.credit_terms
    WHEN '30 Days' THEN 30
    WHEN '60 Days' THEN 60
    WHEN '7 Days'  THEN 7
    ELSE 0
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
    CASE WHEN v_payment_terms = 'cash_before' THEN NULL ELSE v_payment_due END,
    v_quote.tax_status,
    v_quote.pricing_mode,
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
  --    category: use what was set on the quote item; fall back to 'Other'
  --    finish_type, finish_color, wood_type: copy directly (may be NULL)
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
    qi.unit_price,
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

  -- 9. Link converted order back to the quotation
  UPDATE quotations
  SET converted_order_id = v_order_id,
      updated_at         = now()
  WHERE id = p_quote_id;

  -- 10. Mark linked enquiry as 'won' (if any)
  IF v_quote.enquiry_id IS NOT NULL THEN
    UPDATE enquiries
    SET stage      = 'won',
        updated_at = now()
    WHERE id = v_quote.enquiry_id
      AND stage NOT IN ('won', 'lost');
  END IF;

  -- 11. Activity log
  INSERT INTO quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('quotation', p_quote_id, 'converted', 'Quotation converted to order', p_created_by);

  RETURN v_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid) TO service_role;

COMMENT ON FUNCTION convert_quote_to_order(uuid, uuid) IS
  'Atomically converts an accepted quotation to a new order. Copies all items including production spec fields (category, finish_type, finish_color, wood_type). Falls back to category=Other for items where category was not set. Idempotent.';

COMMIT;
