-- production_v1i_gl_line_type_coverage.sql
--
-- P0 FIX — GL posting silently dropped revenue for line types outside
-- product / delivery / design, producing an UNBALANCED_JOURNAL failure.
--
-- ── What went wrong ──────────────────────────────────────────────────────────
-- production_v1g_pre_lineitem_reclass.sql widened order_items.line_type to six
-- values and reclassified charge rows into 'installation', 'packaging' and
-- 'other'. The comment in that file asserted line_type was not consumed by the
-- GL. That was wrong: it is consumed here, in SQL, by two RPCs —
--   post_deposit_paid_journals()   (deposit-paid invoice + receipt)
--   post_credit_order_invoice()    (credit-order invoice)
-- Both aggregate revenue with a hardcoded three-way CASE on line_type, while
-- DR Accounts Receivable uses SUM(gross_amount) over ALL rows. So a line typed
-- 'installation', 'packaging' or 'other' is debited but never credited, the
-- entry no longer sums to zero, and post_journal_entry raises
-- UNBALANCED_JOURNAL. The order cannot post its invoice at all.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--   'installation'  → 4600 Delivery & Installation Income (the account name
--                     already covers it, alongside 'delivery')
--   everything else → 4990 Other Income, via a NOT IN catch-all rather than an
--                     enumeration, so a line type added later cannot
--                     reintroduce this failure.
-- The catch-all guard is `<> 0`, not `> 0`, so a negative line (a discount)
-- still posts instead of silently unbalancing the entry.
--
-- Safe to re-run: both functions are CREATE OR REPLACE.
-- Run after: production_v1g_pre_lineitem_reclass.sql

BEGIN;

-- ── 0. Report orders that cannot currently post ──────────────────────────────
-- Informational only; does not block. These are orders holding a line type the
-- old RPCs could not credit. After this migration they post correctly.

DO $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT o.order_num,
           oi.line_type,
           COUNT(*)            AS lines,
           SUM(oi.net_amount)  AS net
    FROM   public.order_items oi
    JOIN   public.orders o ON o.id = oi.order_id
    WHERE  oi.line_type NOT IN ('product','delivery','design')
    GROUP  BY o.order_num, oi.line_type
    ORDER  BY o.order_num
  LOOP
    v_n := v_n + 1;
    RAISE NOTICE 'Affected: % — % × % (net %)', r.order_num, r.lines, r.line_type, r.net;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE 'No order_items carry a line type outside product/delivery/design.';
  ELSE
    RAISE NOTICE '--- % order/line-type group(s) above were unpostable; fixed by this migration.', v_n;
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION post_deposit_paid_journals(
  p_order_id  uuid,
  p_posted_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order           orders%ROWTYPE;
  v_invoice_num     text;
  v_invoice_jid     uuid;
  v_payment         record;
  v_receipt_jid     uuid;

  -- Account IDs (fetched once)
  v_ar_id           uuid;   -- 1100 Accounts Receivable
  v_bank_id         uuid;   -- 1020 Default Bank
  v_vat_id          uuid;   -- 2010 VAT/GST Payable
  v_sales_id        uuid;   -- 4000 Direct Sales
  v_delivery_id     uuid;   -- 4600 Delivery & Installation Income
  v_design_id       uuid;   -- 4700 Design Services Income
  v_other_id        uuid;   -- 4990 Other Income (catch-all)

  -- Revenue aggregates by line_type
  v_product_net     numeric(14,2) := 0;
  v_delivery_net    numeric(14,2) := 0;
  v_design_net      numeric(14,2) := 0;
  v_other_net       numeric(14,2) := 0;
  v_total_vat       numeric(14,2) := 0;
  v_total_gross     numeric(14,2) := 0;

  -- Dynamic invoice lines
  v_invoice_lines   jsonb;
  v_receipt_count   int := 0;
BEGIN
  -- 1. Lock the order row
  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order % does not exist', p_order_id;
  END IF;

  -- 2. Idempotency guard
  IF v_order.invoice_journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'invoice_number', v_order.invoice_number,
      'invoice_journal_entry_id', v_order.invoice_journal_entry_id,
      'status', 'already_posted'
    );
  END IF;

  -- 3. Must have at least one unposted deposit payment
  IF NOT EXISTS (
    SELECT 1 FROM order_payments
    WHERE order_id = p_order_id
      AND journal_entry_id IS NULL
      AND reversed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NO_UNPOSTED_PAYMENTS: order % has no unposted deposit payments to post', p_order_id;
  END IF;

  -- 4. Aggregate revenue by line_type
  --    For orders created before this module (NULL vat columns), fall back to total_value
  SELECT
    COALESCE(SUM(CASE WHEN line_type = 'product'                    THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type IN ('delivery','installation') THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'design'                     THEN net_amount ELSE 0 END), 0),
    -- Catch-all: any line_type outside the four above (packaging, other, discount,
    -- and anything added later) MUST still be credited somewhere, or DR AR will not
    -- equal CR revenue and post_journal_entry raises UNBALANCED_JOURNAL.
    COALESCE(SUM(CASE WHEN line_type NOT IN ('product','delivery','installation','design')
                      THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(vat_amount), 0),
    COALESCE(SUM(gross_amount), v_order.total_value)
  INTO v_product_net, v_delivery_net, v_design_net, v_other_net, v_total_vat, v_total_gross
  FROM order_items
  WHERE order_id = p_order_id;

  -- If no VAT-aware items exist, put everything under Direct Sales
  IF (v_product_net + v_delivery_net + v_design_net + v_other_net) = 0 THEN
    v_product_net  := COALESCE(v_order.subtotal_amount, v_order.total_value);
    v_total_vat    := COALESCE(v_order.vat_amount, 0);
    v_total_gross  := COALESCE(v_order.total_value, 0);
  END IF;

  -- 5. Fetch account IDs
  SELECT id INTO v_ar_id       FROM accounting_accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_bank_id     FROM accounting_accounts WHERE code = '1020' LIMIT 1;
  SELECT id INTO v_vat_id      FROM accounting_accounts WHERE code = '2010' LIMIT 1;
  SELECT id INTO v_sales_id    FROM accounting_accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_delivery_id FROM accounting_accounts WHERE code = '4600' LIMIT 1;
  SELECT id INTO v_design_id   FROM accounting_accounts WHERE code = '4700' LIMIT 1;
  SELECT id INTO v_other_id    FROM accounting_accounts WHERE code = '4990' LIMIT 1;

  IF v_ar_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1100 Accounts Receivable'; END IF;
  IF v_bank_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1020 Default Bank'; END IF;

  -- 6. Build invoice journal lines
  --    DR 1100 AR = total gross
  --    CR 4000/4600/4700 Revenue = respective net amounts
  --    CR 2010 VAT = total VAT (only if VAT > 0)
  v_invoice_lines := '[]'::jsonb;
  v_invoice_lines := v_invoice_lines || jsonb_build_array(
    jsonb_build_object('account_id', v_ar_id, 'amount', v_total_gross,
                       'description', 'Invoice — ' || COALESCE(v_order.order_num, 'ORDER'))
  );

  IF v_product_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_sales_id, 'amount', -v_product_net,
                         'description', 'Direct Sales — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_delivery_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_delivery_id, 'amount', -v_delivery_net,
                         'description', 'Delivery & Installation — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_design_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_design_id, 'amount', -v_design_net,
                         'description', 'Design Services — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_other_net <> 0 THEN
    IF v_other_id IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4990 Other Income — required to post line types outside product/delivery/installation/design';
    END IF;
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_other_id, 'amount', -v_other_net,
                         'description', 'Other income — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_total_vat > 0 AND v_vat_id IS NOT NULL THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_vat_id, 'amount', -v_total_vat,
                         'description', 'VAT — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  -- 7. Post invoice journal
  v_invoice_jid := post_journal_entry(
    p_entry_date  := CURRENT_DATE,
    p_description := 'Customer invoice — ' || COALESCE(v_order.order_num, p_order_id::text),
    p_source_type := 'order_invoice',
    p_source_id   := p_order_id,
    p_posted_by   := p_posted_by,
    p_lines       := v_invoice_lines
  );

  -- 8. Generate invoice number
  v_invoice_num := next_inv_num();

  -- 9. Update order with invoice fields (status updated by the calling route after this RPC)
  UPDATE orders SET
    invoice_number            = v_invoice_num,
    invoice_issued_at         = now(),
    invoice_journal_entry_id  = v_invoice_jid,
    updated_at                = now()
  WHERE id = p_order_id;

  -- 10. Post receipt journal for each unposted deposit payment
  FOR v_payment IN
    SELECT id, amount, payment_date
    FROM order_payments
    WHERE order_id = p_order_id
      AND journal_entry_id IS NULL
      AND reversed_at IS NULL
    ORDER BY payment_date, created_at
  LOOP
    v_receipt_jid := post_journal_entry(
      p_entry_date  := v_payment.payment_date,
      p_description := 'Customer deposit receipt — ' || COALESCE(v_invoice_num, ''),
      p_source_type := 'order_payment',
      p_source_id   := v_payment.id,
      p_posted_by   := p_posted_by,
      p_lines       := jsonb_build_array(
        jsonb_build_object('account_id', v_bank_id, 'amount',  v_payment.amount,
                           'description', 'Bank receipt — ' || COALESCE(v_invoice_num, '')),
        jsonb_build_object('account_id', v_ar_id,   'amount', -v_payment.amount,
                           'description', 'AR cleared — ' || COALESCE(v_invoice_num, ''))
      )
    );

    UPDATE order_payments
    SET journal_entry_id = v_receipt_jid
    WHERE id = v_payment.id;

    v_receipt_count := v_receipt_count + 1;
  END LOOP;

  -- 11. Activity log
  INSERT INTO order_activities (order_id, activity_type, description, created_by)
  VALUES (
    p_order_id,
    'invoice_posted',
    'Invoice ' || v_invoice_num || ' posted — ' || v_receipt_count || ' deposit payment(s) cleared',
    p_posted_by
  );

  RETURN jsonb_build_object(
    'invoice_number',           v_invoice_num,
    'invoice_journal_entry_id', v_invoice_jid,
    'receipts_posted',          v_receipt_count,
    'status',                   'posted'
  );
END;
$$;

CREATE OR REPLACE FUNCTION post_credit_order_invoice(
  p_order_id  uuid,
  p_posted_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order           orders%ROWTYPE;
  v_invoice_num     text;
  v_invoice_jid     uuid;

  v_ar_id           uuid;
  v_vat_id          uuid;
  v_sales_id        uuid;
  v_delivery_id     uuid;
  v_design_id       uuid;
  v_other_id        uuid;   -- 4990 Other Income (catch-all)

  v_product_net     numeric(14,2) := 0;
  v_delivery_net    numeric(14,2) := 0;
  v_design_net      numeric(14,2) := 0;
  v_other_net       numeric(14,2) := 0;
  v_total_vat       numeric(14,2) := 0;
  v_total_gross     numeric(14,2) := 0;

  v_invoice_lines   jsonb;
BEGIN
  -- 1. Lock order
  SELECT * INTO v_order
  FROM orders WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: order % does not exist', p_order_id;
  END IF;

  -- 2. Idempotency
  IF v_order.invoice_journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'invoice_number', v_order.invoice_number,
      'invoice_journal_entry_id', v_order.invoice_journal_entry_id,
      'status', 'already_posted'
    );
  END IF;

  -- 3. Aggregate revenue
  SELECT
    COALESCE(SUM(CASE WHEN line_type = 'product'                    THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type IN ('delivery','installation') THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'design'                     THEN net_amount ELSE 0 END), 0),
    -- Catch-all: any line_type outside the four above (packaging, other, discount,
    -- and anything added later) MUST still be credited somewhere, or DR AR will not
    -- equal CR revenue and post_journal_entry raises UNBALANCED_JOURNAL.
    COALESCE(SUM(CASE WHEN line_type NOT IN ('product','delivery','installation','design')
                      THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(vat_amount), 0),
    COALESCE(SUM(gross_amount), v_order.total_value)
  INTO v_product_net, v_delivery_net, v_design_net, v_other_net, v_total_vat, v_total_gross
  FROM order_items WHERE order_id = p_order_id;

  IF (v_product_net + v_delivery_net + v_design_net + v_other_net) = 0 THEN
    v_product_net  := COALESCE(v_order.subtotal_amount, v_order.total_value);
    v_total_vat    := COALESCE(v_order.vat_amount, 0);
    v_total_gross  := COALESCE(v_order.total_value, 0);
  END IF;

  -- 4. Fetch account IDs
  SELECT id INTO v_ar_id       FROM accounting_accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_vat_id      FROM accounting_accounts WHERE code = '2010' LIMIT 1;
  SELECT id INTO v_sales_id    FROM accounting_accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_delivery_id FROM accounting_accounts WHERE code = '4600' LIMIT 1;
  SELECT id INTO v_design_id   FROM accounting_accounts WHERE code = '4700' LIMIT 1;
  SELECT id INTO v_other_id    FROM accounting_accounts WHERE code = '4990' LIMIT 1;

  IF v_ar_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1100 Accounts Receivable'; END IF;

  -- 5. Build invoice lines
  v_invoice_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_ar_id, 'amount', v_total_gross,
                       'description', 'Credit invoice — ' || COALESCE(v_order.order_num, p_order_id::text))
  );

  IF v_product_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_sales_id, 'amount', -v_product_net,
                         'description', 'Direct Sales — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_delivery_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_delivery_id, 'amount', -v_delivery_net,
                         'description', 'Delivery & Installation — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_design_net > 0 THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_design_id, 'amount', -v_design_net,
                         'description', 'Design Services — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_other_net <> 0 THEN
    IF v_other_id IS NULL THEN
      RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4990 Other Income — required to post line types outside product/delivery/installation/design';
    END IF;
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_other_id, 'amount', -v_other_net,
                         'description', 'Other income — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  IF v_total_vat > 0 AND v_vat_id IS NOT NULL THEN
    v_invoice_lines := v_invoice_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_vat_id, 'amount', -v_total_vat,
                         'description', 'VAT — ' || COALESCE(v_order.order_num, 'ORDER'))
    );
  END IF;

  -- 6. Post invoice journal
  v_invoice_jid := post_journal_entry(
    p_entry_date  := CURRENT_DATE,
    p_description := 'Credit customer invoice — ' || COALESCE(v_order.order_num, p_order_id::text),
    p_source_type := 'order_invoice',
    p_source_id   := p_order_id,
    p_posted_by   := p_posted_by,
    p_lines       := v_invoice_lines
  );

  -- 7. Generate invoice number
  v_invoice_num := next_inv_num();

  -- 8. Stamp order
  UPDATE orders SET
    invoice_number           = v_invoice_num,
    invoice_issued_at        = now(),
    invoice_journal_entry_id = v_invoice_jid,
    updated_at               = now()
  WHERE id = p_order_id;

  -- 9. Activity log
  INSERT INTO order_activities (order_id, activity_type, description, created_by)
  VALUES (
    p_order_id,
    'invoice_posted',
    'Credit invoice ' || v_invoice_num || ' posted at Quote Approved',
    p_posted_by
  );

  RETURN jsonb_build_object(
    'invoice_number',           v_invoice_num,
    'invoice_journal_entry_id', v_invoice_jid,
    'status',                   'posted'
  );
END;
$$;
-- ── P1 FIX: atomic cut list template replacement ─────────────────────────────
-- PUT /cut-list-templates/:id/items previously issued DELETE then INSERT as two
-- separate round trips. If the insert failed — constraint, timeout, dropped
-- connection — the delete had already committed and the template was left
-- EMPTY, with the user's previous items unrecoverable.
--
-- Mirrors replace_boq_template_items() from production_v1d_boq_templates.sql:
-- one function, one transaction, so a failure rolls the delete back too.

CREATE OR REPLACE FUNCTION public.replace_cut_list_template_items(
  p_template_id uuid,
  p_items       jsonb    -- ordered array of item objects
)
RETURNS integer          -- number of rows inserted
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_len   integer;
  v_item  jsonb;
  v_i     integer;
BEGIN
  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'p_template_id is required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cut_list_templates WHERE id = p_template_id) THEN
    RAISE EXCEPTION 'Cut list template % not found', p_template_id;
  END IF;

  -- Validate everything BEFORE deleting anything, so an invalid payload cannot
  -- destroy the existing items.
  v_len := jsonb_array_length(p_items);
  FOR v_i IN 0 .. (v_len - 1) LOOP
    v_item := p_items -> v_i;
    IF NULLIF(btrim(v_item->>'piece_name'), '') IS NULL THEN
      RAISE EXCEPTION 'Item % is missing piece_name', v_i + 1;
    END IF;
    IF (v_item->>'quantity') IS NOT NULL
       AND (v_item->>'quantity')::numeric <= 0 THEN
      RAISE EXCEPTION 'Item % quantity must be greater than 0', v_i + 1;
    END IF;
  END LOOP;

  DELETE FROM cut_list_template_items WHERE template_id = p_template_id;

  IF v_len > 0 THEN
    INSERT INTO cut_list_template_items (
      template_id, piece_name, width_cm, height_cm, thickness_mm,
      quantity, material_description, notes, sort_order
    )
    SELECT
      p_template_id,
      btrim(it->>'piece_name'),
      NULLIF(it->>'width_cm','')::numeric,
      NULLIF(it->>'height_cm','')::numeric,
      NULLIF(it->>'thickness_mm','')::numeric,
      COALESCE(NULLIF(it->>'quantity','')::integer, 1),
      NULLIF(btrim(COALESCE(it->>'material_description','')), ''),
      NULLIF(btrim(COALESCE(it->>'notes','')), ''),
      COALESCE(NULLIF(it->>'sort_order','')::integer, (ord - 1)::integer)
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(it, ord);

    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE cut_list_templates
  SET    updated_at = now()
  WHERE  id = p_template_id;

  RETURN v_count;
END;
$$;

REVOKE ALL     ON FUNCTION public.replace_cut_list_template_items(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.replace_cut_list_template_items(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.replace_cut_list_template_items(uuid, jsonb)
  IS 'Atomically replaces a cut list template''s items. Validates the whole payload before deleting, so a bad request cannot empty the template. Returns rows inserted.';


COMMIT;
