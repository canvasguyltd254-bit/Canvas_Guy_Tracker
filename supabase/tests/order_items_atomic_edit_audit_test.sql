-- ============================================================
-- Database-level checks for update_order_items_with_audit()
-- Run on STAGING (SQL Editor). Everything is rolled back at the end.
-- Any failed check raises an exception naming the case.
-- If your orders / order_payments tables have extra NOT NULL columns,
-- add them to the two INSERTs below.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user  uuid := gen_random_uuid();
  v_order uuid;
  v_item  uuid;
  v_res   jsonb;
  v_msg   text;
BEGIN
  INSERT INTO public.orders (client, status, pricing_mode, tax_status, total_value)
  VALUES ('__TEST__', 'Inquiry', 'vat_inclusive', 'taxable', 0)
  RETURNING id INTO v_order;

  -- Seed: one product 100,000 gross
  v_res := public.update_order_items_with_audit(
    v_order,
    '[{"category":"Chairs","description":"Chair","quantity":1,"unit_price":100000}]'::jsonb,
    ARRAY[]::uuid[], 'seed', v_user);
  SELECT id INTO v_item FROM public.order_items WHERE order_id = v_order;

  IF (SELECT total_value FROM public.orders WHERE id = v_order) <> 100000 THEN
    RAISE EXCEPTION 'CASE total: order total should equal sum of line gross (100000)';
  END IF;

  -- 80,000 paid
  INSERT INTO public.order_payments (order_id, amount, payment_date)
  VALUES (v_order, 80000, current_date);

  -- CASE 1: lowering total to 60,000 (below paid 80,000) must be refused
  BEGIN
    PERFORM public.update_order_items_with_audit(
      v_order,
      jsonb_build_array(jsonb_build_object('id', v_item, 'category','Chairs','quantity',1,'unit_price',60000)),
      ARRAY[]::uuid[], 'discount', v_user);
    RAISE EXCEPTION 'CASE 1 FAILED: total below payments was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'TOTAL_BELOW_PAYMENTS%' THEN RAISE; END IF;
  END;
  IF (SELECT total_value FROM public.orders WHERE id = v_order) <> 100000 THEN
    RAISE EXCEPTION 'CASE 1 FAILED: refused edit must leave the total untouched';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_item_adjustments WHERE reason = 'discount') THEN
    RAISE EXCEPTION 'CASE 1 FAILED: refused edit must not leave audit rows';
  END IF;

  -- CASE 2: lowering exactly to the paid amount (80,000) is allowed
  PERFORM public.update_order_items_with_audit(
    v_order,
    jsonb_build_array(jsonb_build_object('id', v_item, 'category','Chairs','quantity',1,'unit_price',80000)),
    ARRAY[]::uuid[], 'agreed reduction', v_user);
  IF (SELECT total_value FROM public.orders WHERE id = v_order) <> 80000 THEN
    RAISE EXCEPTION 'CASE 2 FAILED: total should be 80000';
  END IF;

  -- A reversed payment must not count: reverse it, then 60,000 is fine
  UPDATE public.order_payments SET reversed_at = now() WHERE order_id = v_order;
  PERFORM public.update_order_items_with_audit(
    v_order,
    jsonb_build_array(jsonb_build_object('id', v_item, 'category','Chairs','quantity',1,'unit_price',60000)),
    ARRAY[]::uuid[], 'after reversal', v_user);

  -- CASE 3: reason required for financial change
  BEGIN
    PERFORM public.update_order_items_with_audit(
      v_order, '[{"category":"Packaging","description":"Pack","unit_price":500}]'::jsonb,
      ARRAY[]::uuid[], '   ', v_user);
    RAISE EXCEPTION 'CASE 3 FAILED: missing reason was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'REASON_REQUIRED%' THEN RAISE; END IF;
  END;

  -- CASE 4: charge is stored with a non-product line_type
  PERFORM public.update_order_items_with_audit(
    v_order, '[{"category":"Packaging","description":"Pack","unit_price":500}]'::jsonb,
    ARRAY[]::uuid[], 'add packaging', v_user);
  IF (SELECT line_type FROM public.order_items WHERE order_id = v_order AND category = 'Packaging') <> 'packaging' THEN
    RAISE EXCEPTION 'CASE 4 FAILED: Packaging must be line_type packaging';
  END IF;
  IF (SELECT total_value FROM public.orders WHERE id = v_order)
     <> (SELECT sum(gross_amount) FROM public.order_items WHERE order_id = v_order) THEN
    RAISE EXCEPTION 'CASE 4 FAILED: order total must equal sum of line gross';
  END IF;

  -- CASE 5: posted invoice blocks financial change but allows metadata
  UPDATE public.orders SET invoice_journal_entry_id = gen_random_uuid() WHERE id = v_order;
  BEGIN
    PERFORM public.update_order_items_with_audit(
      v_order,
      jsonb_build_array(jsonb_build_object('id', v_item, 'category','Chairs','quantity',2,'unit_price',60000)),
      ARRAY[]::uuid[], 'try', v_user);
    RAISE EXCEPTION 'CASE 5 FAILED: financial change after posting was accepted';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'INVOICE_POSTED%' THEN RAISE; END IF;
  END;
  PERFORM public.update_order_items_with_audit(
    v_order,
    jsonb_build_array(jsonb_build_object('id', v_item, 'category','Chairs','quantity',1,'unit_price',60000,'description','Renamed chair')),
    ARRAY[]::uuid[], NULL, v_user);
  IF (SELECT description FROM public.order_items WHERE id = v_item) <> 'Renamed chair' THEN
    RAISE EXCEPTION 'CASE 5 FAILED: metadata-only edit after posting should work';
  END IF;

  -- CASE 6: audit rows carry before/after, reason and user
  IF NOT EXISTS (
    SELECT 1 FROM public.order_item_adjustments
    WHERE order_id = v_order AND reason = 'agreed reduction' AND created_by = v_user
      AND before_values IS NOT NULL AND after_values IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'CASE 6 FAILED: audit row missing before/after/reason/user';
  END IF;

  RAISE NOTICE 'order_items_atomic_edit_audit: all cases passed';
END;
$$;

ROLLBACK;
