-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration C: Atomic PostgreSQL RPCs
--
-- Run AFTER Migration B.
-- All RPCs are SECURITY DEFINER, callable by service_role only.
--
-- RPCs:
--   1. convert_quote_to_order(quote_id, created_by)
--      Converts an accepted quotation to a new order, copies items,
--      links back, marks enquiry won. Idempotent.
--
--   2. post_deposit_paid_journals(order_id, posted_by)
--      Fires at Deposit Paid for NON-credit orders.
--      Posts invoice GL + one receipt journal per unposted deposit
--      payment, atomically. Generates INV number.
--
--   3. post_credit_order_invoice(order_id, posted_by)
--      Fires at Quote Approved for CREDIT orders.
--      Posts invoice GL only (no payments yet). Generates INV number.
--
--   4. post_customer_payment(payment_id, posted_by)
--      Posts a single customer receipt after the invoice is live.
--      DR 1020 Bank / CR 1100 AR. Idempotent.
--
--   5. reverse_customer_payment(payment_id, reason, reversed_by)
--      Creates a reversal journal, marks the payment reversed.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. convert_quote_to_order
-- ============================================================

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
  v_quote       quotations%ROWTYPE;
  v_customer    customers%ROWTYPE;
  v_order_id    uuid;
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
  --    This mirrors the tracker's isCreditOrder() logic in PostgreSQL.
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
    ELSE -- 'COD' and anything else
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

  -- 7. INSERT the order (auto_order_num trigger fires and sets order_num)
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
    'Other',                   -- quote_items have no category; user can update post-conversion
    qi.description,
    qi.quantity,
    qi.size,
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
      AND stage NOT IN ('won', 'lost');  -- don't downgrade if already terminal
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
  'Atomically converts an accepted quotation to a new order. Copies all items with VAT snapshot, computes payment terms from customer credit_terms, marks enquiry won, logs activity. Idempotent: returns existing order_id if already converted.';


-- ============================================================
-- 2. post_deposit_paid_journals
--
--    Fires when a NON-credit order advances to "Deposit Paid".
--    Posts in a single transaction:
--      a) Invoice journal: DR AR / CR Revenue accounts / CR VAT
--      b) Receipt journal per unposted deposit payment: DR Bank / CR AR
--    Generates invoice_number, sets invoice_issued_at and
--    invoice_journal_entry_id on the order.
-- ============================================================

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

  -- Revenue aggregates by line_type
  v_product_net     numeric(14,2) := 0;
  v_delivery_net    numeric(14,2) := 0;
  v_design_net      numeric(14,2) := 0;
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
    COALESCE(SUM(CASE WHEN line_type = 'product'  THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'delivery' THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'design'   THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(vat_amount), 0),
    COALESCE(SUM(gross_amount), v_order.total_value)
  INTO v_product_net, v_delivery_net, v_design_net, v_total_vat, v_total_gross
  FROM order_items
  WHERE order_id = p_order_id;

  -- If no VAT-aware items exist, put everything under Direct Sales
  IF (v_product_net + v_delivery_net + v_design_net) = 0 THEN
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

REVOKE EXECUTE ON FUNCTION post_deposit_paid_journals(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION post_deposit_paid_journals(uuid, uuid) TO service_role;

COMMENT ON FUNCTION post_deposit_paid_journals(uuid, uuid) IS
  'Fires at Deposit Paid for non-credit orders. Atomically posts the invoice GL and one receipt journal per unposted deposit payment. Generates the INV number and stamps the order. Idempotent.';


-- ============================================================
-- 3. post_credit_order_invoice
--
--    Fires when a CREDIT ORDER advances to "Quote Approved".
--    Posts only the invoice journal (no payments yet — credit
--    customers pay later). Generates INV number.
-- ============================================================

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

  v_product_net     numeric(14,2) := 0;
  v_delivery_net    numeric(14,2) := 0;
  v_design_net      numeric(14,2) := 0;
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
    COALESCE(SUM(CASE WHEN line_type = 'product'  THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'delivery' THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN line_type = 'design'   THEN net_amount ELSE 0 END), 0),
    COALESCE(SUM(vat_amount), 0),
    COALESCE(SUM(gross_amount), v_order.total_value)
  INTO v_product_net, v_delivery_net, v_design_net, v_total_vat, v_total_gross
  FROM order_items WHERE order_id = p_order_id;

  IF (v_product_net + v_delivery_net + v_design_net) = 0 THEN
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

REVOKE EXECUTE ON FUNCTION post_credit_order_invoice(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION post_credit_order_invoice(uuid, uuid) TO service_role;

COMMENT ON FUNCTION post_credit_order_invoice(uuid, uuid) IS
  'Fires at Quote Approved for credit orders. Posts the invoice GL only (no payments). Generates INV number and stamps the order. Idempotent.';


-- ============================================================
-- 4. post_customer_payment
--
--    Posts a single customer receipt AFTER the invoice is live
--    (i.e., invoice_journal_entry_id IS NOT NULL on the order).
--    Use for payments added post-Deposit Paid / post-Quote Approved.
--
--    DR 1020 Default Bank
--    CR 1100 Accounts Receivable
-- ============================================================

CREATE OR REPLACE FUNCTION post_customer_payment(
  p_payment_id uuid,
  p_posted_by  uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment     order_payments%ROWTYPE;
  v_order       orders%ROWTYPE;
  v_bank_id     uuid;
  v_ar_id       uuid;
  v_journal_id  uuid;
BEGIN
  -- 1. Lock payment row
  SELECT * INTO v_payment
  FROM order_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: payment % does not exist', p_payment_id;
  END IF;

  -- 2. Idempotency
  IF v_payment.journal_entry_id IS NOT NULL THEN
    RETURN v_payment.journal_entry_id;
  END IF;

  -- 3. Cannot reverse an already-reversed payment
  IF v_payment.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_REVERSED: payment % has already been reversed', p_payment_id;
  END IF;

  -- 4. Fetch the order — invoice must be live
  SELECT * INTO v_order
  FROM orders WHERE id = v_payment.order_id;

  IF v_order.invoice_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_POSTED: order % invoice has not been posted yet — post the invoice first', v_payment.order_id;
  END IF;

  -- 5. Fetch account IDs
  SELECT id INTO v_bank_id FROM accounting_accounts WHERE code = '1020' LIMIT 1;
  SELECT id INTO v_ar_id   FROM accounting_accounts WHERE code = '1100' LIMIT 1;

  IF v_bank_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1020 Default Bank'; END IF;
  IF v_ar_id   IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1100 Accounts Receivable'; END IF;

  -- 6. Post journal
  v_journal_id := post_journal_entry(
    p_entry_date  := v_payment.payment_date,
    p_description := 'Customer receipt — ' || COALESCE(v_order.invoice_number, v_order.order_num, ''),
    p_source_type := 'order_payment',
    p_source_id   := p_payment_id,
    p_posted_by   := p_posted_by,
    p_lines       := jsonb_build_array(
      jsonb_build_object('account_id', v_bank_id, 'amount',  v_payment.amount,
                         'description', 'Bank receipt — ' || COALESCE(v_order.invoice_number, '')),
      jsonb_build_object('account_id', v_ar_id,   'amount', -v_payment.amount,
                         'description', 'AR cleared — ' || COALESCE(v_order.invoice_number, ''))
    )
  );

  -- 7. Link journal to payment
  UPDATE order_payments
  SET journal_entry_id = v_journal_id
  WHERE id = p_payment_id;

  RETURN v_journal_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION post_customer_payment(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION post_customer_payment(uuid, uuid) TO service_role;

COMMENT ON FUNCTION post_customer_payment(uuid, uuid) IS
  'Posts a single customer receipt (DR Bank / CR AR) for a payment made after the invoice is live. Idempotent.';


-- ============================================================
-- 5. reverse_customer_payment
--
--    Creates a reversal journal, marks the payment reversed.
--    The original journal_entry is also marked reversed.
-- ============================================================

CREATE OR REPLACE FUNCTION reverse_customer_payment(
  p_payment_id   uuid,
  p_reason       text,
  p_reversed_by  uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment          order_payments%ROWTYPE;
  v_order            orders%ROWTYPE;
  v_bank_id          uuid;
  v_ar_id            uuid;
  v_reversal_jid     uuid;
BEGIN
  -- 1. Lock payment
  SELECT * INTO v_payment
  FROM order_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: payment % does not exist', p_payment_id;
  END IF;

  -- 2. Must be posted
  IF v_payment.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_POSTED: payment % has not been posted to GL', p_payment_id;
  END IF;

  -- 3. Cannot reverse twice
  IF v_payment.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: payment % has already been reversed', p_payment_id;
  END IF;

  -- 4. Validate reason
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a reason must be provided when reversing a payment';
  END IF;

  -- 5. Fetch order
  SELECT * INTO v_order FROM orders WHERE id = v_payment.order_id;

  -- 6. Fetch accounts
  SELECT id INTO v_bank_id FROM accounting_accounts WHERE code = '1020' LIMIT 1;
  SELECT id INTO v_ar_id   FROM accounting_accounts WHERE code = '1100' LIMIT 1;

  IF v_bank_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1020 Default Bank'; END IF;
  IF v_ar_id   IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1100 Accounts Receivable'; END IF;

  -- 7. Post reversal journal (opposite signs)
  v_reversal_jid := post_journal_entry(
    p_entry_date  := CURRENT_DATE,
    p_description := 'Reversal: customer receipt — ' || COALESCE(v_order.invoice_number, '') || ' — ' || trim(p_reason),
    p_source_type := 'order_payment_reversal',
    p_source_id   := p_payment_id,
    p_posted_by   := p_reversed_by,
    p_lines       := jsonb_build_array(
      jsonb_build_object('account_id', v_ar_id,   'amount',  v_payment.amount,
                         'description', 'AR re-opened — reversal of ' || COALESCE(v_order.invoice_number, '')),
      jsonb_build_object('account_id', v_bank_id, 'amount', -v_payment.amount,
                         'description', 'Bank reversed — ' || trim(p_reason))
    )
  );

  -- 8. Mark original journal as reversed
  UPDATE journal_entries
  SET status = 'reversed'
  WHERE id = v_payment.journal_entry_id;

  -- 9. Stamp the payment row
  UPDATE order_payments SET
    reversed_at               = now(),
    reversal_journal_entry_id = v_reversal_jid,
    reversal_reason           = trim(p_reason),
    reversed_by               = p_reversed_by
  WHERE id = p_payment_id;

  RETURN v_reversal_jid;
END;
$$;

REVOKE EXECUTE ON FUNCTION reverse_customer_payment(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION reverse_customer_payment(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION reverse_customer_payment(uuid, text, uuid) IS
  'Creates a reversal journal for a posted customer payment and marks the payment reversed. Blocks double-reversal.';


COMMIT;
