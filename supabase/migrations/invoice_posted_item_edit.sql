-- ============================================================
-- Canvas Guy Tracker — Admin correction of line items on a POSTED invoice
-- Run AFTER order_items_atomic_edit_audit.sql and accounting_foundation.sql.
-- Safe to re-run.
--
-- BEFORE
--   Once an order's invoice was posted (invoice_journal_entry_id set), every quantity,
--   price or charge change was refused with INVOICE_POSTED.
--
-- NOW
--   An ADMIN can change line items on a posted invoice. Nobody else can (the API passes
--   p_allow_posted = true only for admin; everyone else still gets INVOICE_POSTED).
--
--   The original invoice journal is NEVER edited. Instead, in the same transaction as the
--   item change, post_invoice_correction() posts a CORRECTING JOURNAL for the difference
--   (what the ledger holds for this invoice vs. what the current items imply):
--       AR (1100), Sales (4000), Delivery (4600), Design (4700), Other income (4990), VAT (2010).
--   A quantity reduction therefore credits AR and debits revenue and VAT, exactly like a
--   credit note; an increase does the reverse. The invoice number does not change.
--   The ledger converges on the current items each time, so repeated edits stay consistent.
--
--   Still enforced: a reason is required; the new total may not fall below payments already
--   received (TOTAL_BELOW_PAYMENTS); every edit is written to order_item_adjustments
--   (before/after, reason, gross delta, was_invoice_posted = true) and to the new
--   order_invoice_corrections table, which links the edit to its correcting journal.
--
-- NOT handled: accounting periods / locked months (the system has none), and tax authority
-- e-invoicing (eTIMS). If invoices are transmitted to KRA, the compliant route is a credit
-- note, not an amended invoice; this correction is the ledger side only.
-- ============================================================

BEGIN;

-- 1. Link between an edit and the journal that corrected the ledger for it.
CREATE TABLE IF NOT EXISTS public.order_invoice_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL UNIQUE,          -- = order_item_adjustments.event_id of the edit
  order_id         uuid NOT NULL,                 -- no FK: history must outlive deletes
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  gross_delta      numeric(14,2) NOT NULL,        -- change to the amount owed on the invoice
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid
);
CREATE INDEX IF NOT EXISTS idx_order_invoice_corrections_order
  ON public.order_invoice_corrections (order_id, created_at);

COMMENT ON TABLE public.order_invoice_corrections IS
  'Append-only. One row per admin edit of a posted invoice, linking it to the correcting journal entry. Written only by post_invoice_correction().';

ALTER TABLE public.order_invoice_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_invoice_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.order_invoice_corrections TO service_role;

-- 2. Post the difference between the ledger and the current items.
CREATE OR REPLACE FUNCTION public.post_invoice_correction(
  p_order_id  uuid,
  p_event_id  uuid,
  p_reason    text,
  p_posted_by uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order   public.orders%ROWTYPE;
  v_ids     uuid[];
  v_ar_id   uuid; v_vat_id uuid; v_sales_id uuid; v_deliv_id uuid; v_design_id uuid; v_other_id uuid;
  -- what the ledger currently holds for this invoice (DR positive, CR negative)
  b_ar numeric; b_sales numeric; b_deliv numeric; b_design numeric; b_other numeric; b_vat numeric;
  -- what the current items imply
  t_gross numeric; t_prod numeric; t_deliv numeric; t_design numeric; t_other numeric; t_vat numeric;
  d_ar numeric; d_sales numeric; d_deliv numeric; d_design numeric; d_other numeric; d_vat numeric;
  v_lines   jsonb := '[]'::jsonb;
  v_jid     uuid;
  v_label   text;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_order.invoice_journal_entry_id IS NULL THEN RETURN NULL; END IF;

  SELECT id INTO v_ar_id     FROM public.accounting_accounts WHERE code = '1100' LIMIT 1;
  SELECT id INTO v_vat_id    FROM public.accounting_accounts WHERE code = '2010' LIMIT 1;
  SELECT id INTO v_sales_id  FROM public.accounting_accounts WHERE code = '4000' LIMIT 1;
  SELECT id INTO v_deliv_id  FROM public.accounting_accounts WHERE code = '4600' LIMIT 1;
  SELECT id INTO v_design_id FROM public.accounting_accounts WHERE code = '4700' LIMIT 1;
  SELECT id INTO v_other_id  FROM public.accounting_accounts WHERE code = '4990' LIMIT 1;

  -- The invoice journal plus every earlier correction, active entries only.
  SELECT array_agg(id) INTO v_ids
  FROM public.journal_entries
  WHERE status = 'active'
    AND ( id = v_order.invoice_journal_entry_id
          OR id IN (SELECT journal_entry_id FROM public.order_invoice_corrections WHERE order_id = p_order_id) );

  SELECT
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '1100'), 0),
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '4000'), 0),
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '4600'), 0),
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '4700'), 0),
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '4990'), 0),
    COALESCE(SUM(jl.amount) FILTER (WHERE a.code = '2010'), 0)
  INTO b_ar, b_sales, b_deliv, b_design, b_other, b_vat
  FROM public.journal_lines jl
  JOIN public.accounting_accounts a ON a.id = jl.account_id
  WHERE jl.journal_entry_id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]));

  -- Same bucket rules as post_credit_order_invoice / post_deposit_paid_journals.
  SELECT
    COALESCE(SUM(gross_amount), 0),
    COALESCE(SUM(net_amount) FILTER (WHERE line_type = 'product'), 0),
    COALESCE(SUM(net_amount) FILTER (WHERE line_type IN ('delivery','installation')), 0),
    COALESCE(SUM(net_amount) FILTER (WHERE line_type = 'design'), 0),
    COALESCE(SUM(net_amount) FILTER (WHERE line_type NOT IN ('product','delivery','installation','design')), 0),
    COALESCE(SUM(vat_amount), 0)
  INTO t_gross, t_prod, t_deliv, t_design, t_other, t_vat
  FROM public.order_items WHERE order_id = p_order_id;

  d_ar     :=  t_gross  - b_ar;
  d_sales  := -t_prod   - b_sales;
  d_deliv  := -t_deliv  - b_deliv;
  d_design := -t_design - b_design;
  d_other  := -t_other  - b_other;
  d_vat    := -t_vat    - b_vat;

  IF abs(d_ar) < 0.005 AND abs(d_sales) < 0.005 AND abs(d_deliv) < 0.005
     AND abs(d_design) < 0.005 AND abs(d_other) < 0.005 AND abs(d_vat) < 0.005 THEN
    RETURN NULL;                                     -- the ledger already matches the items
  END IF;

  v_label := COALESCE(v_order.order_num, p_order_id::text);

  IF abs(d_ar) >= 0.005 THEN
    IF v_ar_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 1100 Accounts Receivable' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_ar_id, 'amount', d_ar,
                 'description', 'Invoice correction (receivable) — ' || v_label));
  END IF;
  IF abs(d_sales) >= 0.005 THEN
    IF v_sales_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4000 Direct Sales' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_sales_id, 'amount', d_sales,
                 'description', 'Invoice correction (sales) — ' || v_label));
  END IF;
  IF abs(d_deliv) >= 0.005 THEN
    IF v_deliv_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4600 Delivery & Installation' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_deliv_id, 'amount', d_deliv,
                 'description', 'Invoice correction (delivery & installation) — ' || v_label));
  END IF;
  IF abs(d_design) >= 0.005 THEN
    IF v_design_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4700 Design Services' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_design_id, 'amount', d_design,
                 'description', 'Invoice correction (design) — ' || v_label));
  END IF;
  IF abs(d_other) >= 0.005 THEN
    IF v_other_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 4990 Other Income' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_other_id, 'amount', d_other,
                 'description', 'Invoice correction (other income) — ' || v_label));
  END IF;
  IF abs(d_vat) >= 0.005 THEN
    IF v_vat_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: 2010 VAT Payable' USING ERRCODE = 'P0001'; END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id', v_vat_id, 'amount', d_vat,
                 'description', 'Invoice correction (VAT) — ' || v_label));
  END IF;

  -- post_journal_entry raises UNBALANCED_JOURNAL if the items do not add up (net + VAT <> gross);
  -- that rolls the whole edit back, so the books are never left half-corrected.
  v_jid := public.post_journal_entry(
    p_entry_date  := CURRENT_DATE,
    p_description := 'Invoice correction — ' || v_label
                     || COALESCE(' (' || v_order.invoice_number || ')', '')
                     || ': ' || left(COALESCE(p_reason, ''), 200),
    p_source_type := 'order_invoice_correction',
    p_source_id   := p_event_id,
    p_posted_by   := p_posted_by,
    p_lines       := v_lines
  );

  INSERT INTO public.order_invoice_corrections (event_id, order_id, journal_entry_id, gross_delta, reason, created_by)
  VALUES (p_event_id, p_order_id, v_jid, d_ar, COALESCE(p_reason, ''), p_posted_by);

  INSERT INTO public.order_activities (order_id, activity_type, description, created_by)
  VALUES (p_order_id, 'invoice_corrected',
          'Invoice ' || COALESCE(v_order.invoice_number, '') || ' corrected by an admin: '
            || CASE WHEN d_ar < 0 THEN 'reduced' ELSE 'increased' END || ' by KES '
            || to_char(abs(d_ar), 'FM999,999,999,990.00') || '. Reason: ' || left(COALESCE(p_reason, ''), 300),
          p_posted_by);

  RETURN v_jid;
END;
$$;

REVOKE ALL ON FUNCTION public.post_invoice_correction(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_invoice_correction(uuid, uuid, text, uuid) TO service_role;

-- 3. The edit function, now with an explicit admin-only switch for posted invoices.
--    A new signature: drop the old one so the two cannot both match a call.
DROP FUNCTION IF EXISTS public.update_order_items_with_audit(uuid, jsonb, uuid[], text, uuid);

CREATE OR REPLACE FUNCTION public.update_order_items_with_audit(
  p_order_id         uuid,
  p_items            jsonb,
  p_deleted_item_ids uuid[],
  p_reason           text,
  p_changed_by       uuid,
  p_allow_posted     boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_vat      CONSTANT numeric := 0.16;
  v_order    public.orders%ROWTYPE;
  v_posted   boolean;
  v_event    uuid := gen_random_uuid();
  v_reason   text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_mode     text;
  v_exempt_o boolean;
  v_elem     jsonb;
  v_old      public.order_items%ROWTYPE;
  v_id       uuid;
  v_cat      text;
  v_ltype    text;
  v_is_chg   boolean;
  v_qty      integer;
  v_price    numeric;
  v_treat    text;
  v_gross    numeric;
  v_net      numeric;
  v_vat      numeric;
  v_financial_changed boolean := false;
  v_changed  boolean;
  v_before   jsonb;
  v_after    jsonb;
  v_row      public.order_items%ROWTYPE;
  v_count    integer;
  v_seen     uuid[] := ARRAY[]::uuid[];
  v_new_total numeric;
  v_paid     numeric;
  v_corr     uuid;
BEGIN
  IF p_changed_by IS NULL THEN
    RAISE EXCEPTION 'INVALID_ITEM: changed_by is required' USING ERRCODE = 'P0001';
  END IF;

  -- Lock first: serialises concurrent saves and the invoice-posting flow.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_posted   := v_order.invoice_journal_entry_id IS NOT NULL;
  v_mode     := COALESCE(v_order.pricing_mode, 'vat_inclusive');
  v_exempt_o := COALESCE(v_order.tax_status, 'taxable') = 'exempt';

  p_items            := COALESCE(p_items, '[]'::jsonb);
  p_deleted_item_ids := COALESCE(p_deleted_item_ids, ARRAY[]::uuid[]);

  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ITEM: items must be an array' USING ERRCODE = 'P0001';
  END IF;

  -- ── Pass 1: validate + classify (nothing written yet) ──────────────────
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_id := NULLIF(v_elem->>'id', '')::uuid;

    v_cat := NULLIF(btrim(COALESCE(v_elem->>'category', '')), '');
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_old FROM public.order_items WHERE id = v_id AND order_id = p_order_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_ITEM: item % does not belong to this order', v_id USING ERRCODE = 'P0001';
      END IF;
      IF v_id = ANY (v_seen) THEN
        RAISE EXCEPTION 'INVALID_ITEM: item % submitted twice', v_id USING ERRCODE = 'P0001';
      END IF;
      IF v_id = ANY (p_deleted_item_ids) THEN
        RAISE EXCEPTION 'INVALID_ITEM: item % is both updated and deleted', v_id USING ERRCODE = 'P0001';
      END IF;
      v_seen := v_seen || v_id;
      v_cat  := COALESCE(v_cat, v_old.category);
    ELSE
      v_old := NULL;
    END IF;

    IF v_cat IS NULL THEN
      RAISE EXCEPTION 'INVALID_ITEM: category is required' USING ERRCODE = 'P0001';
    END IF;

    v_is_chg := v_cat IN ('Delivery Fee','Design Fee','Installation Fee','Packaging','Other Charge','Rush Fee','Discount');

    BEGIN
      v_price := COALESCE(NULLIF(v_elem->>'unit_price', '')::numeric, 0);
      v_qty   := CASE WHEN v_is_chg THEN 1
                      ELSE COALESCE(NULLIF(v_elem->>'quantity', '')::integer, 1) END;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'INVALID_ITEM: quantity/unit_price must be numeric' USING ERRCODE = 'P0001';
    END;

    IF v_qty < 1 THEN
      RAISE EXCEPTION 'INVALID_ITEM: quantity must be at least 1' USING ERRCODE = 'P0001';
    END IF;
    -- Discounts are the only legitimately negative line.
    IF v_price < 0 AND v_cat <> 'Discount' THEN
      RAISE EXCEPTION 'INVALID_ITEM: unit_price cannot be negative' USING ERRCODE = 'P0001';
    END IF;

    v_treat := COALESCE(NULLIF(v_elem->>'tax_treatment', ''), v_old.tax_treatment, 'standard');
    IF v_treat NOT IN ('standard','exempt') THEN
      RAISE EXCEPTION 'INVALID_ITEM: tax_treatment must be standard or exempt' USING ERRCODE = 'P0001';
    END IF;

    IF v_id IS NULL THEN
      v_financial_changed := true;                                   -- an add
    ELSIF v_old.category   IS DISTINCT FROM v_cat
       OR v_old.quantity   IS DISTINCT FROM v_qty
       OR COALESCE(v_old.unit_price, 0) IS DISTINCT FROM v_price
       OR COALESCE(v_old.tax_treatment, 'standard') IS DISTINCT FROM v_treat THEN
      v_financial_changed := true;                                   -- a change
    END IF;
  END LOOP;

  -- Deletes (must belong to this order)
  IF array_length(p_deleted_item_ids, 1) IS NOT NULL THEN
    SELECT count(*) INTO v_count
    FROM public.order_items
    WHERE order_id = p_order_id AND id = ANY (p_deleted_item_ids);
    IF v_count <> (SELECT count(DISTINCT x) FROM unnest(p_deleted_item_ids) x) THEN
      RAISE EXCEPTION 'INVALID_ITEM: one or more deleted items do not belong to this order' USING ERRCODE = 'P0001';
    END IF;
    v_financial_changed := true;
  END IF;

  -- ── Accounting lock + reason ───────────────────────────────────────────
  IF v_financial_changed AND v_posted AND NOT COALESCE(p_allow_posted, false) THEN
    RAISE EXCEPTION 'INVOICE_POSTED: this order''s invoice has been posted to accounting; only an admin can correct quantities, prices or charges on a posted invoice (a correcting journal is posted for the difference)'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_financial_changed AND v_reason IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: an edit reason is required when financial items change' USING ERRCODE = 'P0001';
  END IF;

  -- ── Pass 2: apply ──────────────────────────────────────────────────────
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_id := NULLIF(v_elem->>'id', '')::uuid;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_old FROM public.order_items WHERE id = v_id;
    ELSE
      v_old := NULL;
    END IF;

    v_cat    := COALESCE(NULLIF(btrim(COALESCE(v_elem->>'category','')), ''), v_old.category);
    v_is_chg := v_cat IN ('Delivery Fee','Design Fee','Installation Fee','Packaging','Other Charge','Rush Fee','Discount');
    v_ltype  := CASE v_cat
                  WHEN 'Delivery Fee'     THEN 'delivery'
                  WHEN 'Design Fee'       THEN 'design'
                  WHEN 'Installation Fee' THEN 'installation'
                  WHEN 'Packaging'        THEN 'packaging'
                  WHEN 'Other Charge'     THEN 'other'
                  WHEN 'Rush Fee'         THEN 'other'
                  WHEN 'Discount'         THEN 'other'
                  ELSE 'product' END;
    v_price  := COALESCE(NULLIF(v_elem->>'unit_price','')::numeric, 0);
    v_qty    := CASE WHEN v_is_chg THEN 1 ELSE COALESCE(NULLIF(v_elem->>'quantity','')::integer, 1) END;
    v_treat  := COALESCE(NULLIF(v_elem->>'tax_treatment',''), v_old.tax_treatment, 'standard');

    v_changed := v_old.id IS NULL
      OR v_old.category IS DISTINCT FROM v_cat
      OR v_old.quantity IS DISTINCT FROM v_qty
      OR COALESCE(v_old.unit_price, 0) IS DISTINCT FROM v_price
      OR COALESCE(v_old.tax_treatment, 'standard') IS DISTINCT FROM v_treat;

    IF NOT v_changed AND COALESCE(v_old.gross_amount, 0) > 0 THEN
      -- Financially untouched row with stored amounts: keep them exactly.
      v_gross := v_old.gross_amount; v_net := v_old.net_amount; v_vat := v_old.vat_amount;
    ELSIF v_exempt_o OR v_treat = 'exempt' THEN
      v_gross := round(v_price * v_qty, 2); v_net := v_gross; v_vat := 0;
    ELSIF v_is_chg OR v_mode = 'vat_inclusive' THEN
      -- Charges are stored as a flat gross figure; inclusive lines are gross too.
      v_gross := round(v_price * v_qty, 2);
      v_net   := round(v_gross / (1 + c_vat), 2);
      v_vat   := v_gross - v_net;
    ELSE
      v_net   := round(v_price * v_qty, 2);
      v_vat   := round(v_net * c_vat, 2);
      v_gross := v_net + v_vat;
    END IF;

    IF v_old.id IS NULL THEN
      INSERT INTO public.order_items
        (order_id, category, description, quantity, size, finish_type, finish_color,
         wood_type, unit_price, sort_order, line_type, tax_treatment, vat_rate,
         net_amount, vat_amount, gross_amount)
      VALUES
        (p_order_id, v_cat, v_elem->>'description', v_qty, v_elem->>'size',
         v_elem->>'finish_type', v_elem->>'finish_color', v_elem->>'wood_type',
         v_price, COALESCE(NULLIF(v_elem->>'sort_order','')::integer, 0), v_ltype, v_treat,
         CASE WHEN v_exempt_o OR v_treat = 'exempt' THEN 0 ELSE c_vat END,
         v_net, v_vat, v_gross)
      RETURNING * INTO v_row;

      INSERT INTO public.order_item_adjustments
        (event_id, order_id, order_item_id, adjustment_type, before_values, after_values,
         gross_delta, reason, was_invoice_posted, created_by)
      VALUES (v_event, p_order_id, v_row.id, 'item_added', NULL, to_jsonb(v_row),
              v_gross, v_reason, v_posted, p_changed_by);
    ELSE
      v_before := to_jsonb(v_old);
      UPDATE public.order_items SET
        category      = v_cat,
        description   = CASE WHEN v_elem ? 'description'  THEN v_elem->>'description'  ELSE description  END,
        quantity      = v_qty,
        size          = CASE WHEN v_elem ? 'size'         THEN v_elem->>'size'         ELSE size         END,
        finish_type   = CASE WHEN v_elem ? 'finish_type'  THEN v_elem->>'finish_type'  ELSE finish_type  END,
        finish_color  = CASE WHEN v_elem ? 'finish_color' THEN v_elem->>'finish_color' ELSE finish_color END,
        wood_type     = CASE WHEN v_elem ? 'wood_type'    THEN v_elem->>'wood_type'    ELSE wood_type    END,
        unit_price    = v_price,
        sort_order    = CASE WHEN v_elem ? 'sort_order'   THEN COALESCE(NULLIF(v_elem->>'sort_order','')::integer, 0) ELSE sort_order END,
        line_type     = CASE WHEN v_changed THEN v_ltype ELSE line_type END,
        tax_treatment = v_treat,
        vat_rate      = CASE WHEN v_changed THEN (CASE WHEN v_exempt_o OR v_treat = 'exempt' THEN 0 ELSE c_vat END) ELSE vat_rate END,
        net_amount    = v_net,
        vat_amount    = v_vat,
        gross_amount  = v_gross
      WHERE id = v_old.id
      RETURNING * INTO v_row;

      IF v_changed THEN
        INSERT INTO public.order_item_adjustments
          (event_id, order_id, order_item_id, adjustment_type, before_values, after_values,
           gross_delta, reason, was_invoice_posted, created_by)
        VALUES (v_event, p_order_id, v_row.id, 'item_changed', v_before, to_jsonb(v_row),
                v_gross - COALESCE(v_old.gross_amount, 0), v_reason, v_posted, p_changed_by);
      END IF;
    END IF;
  END LOOP;

  -- Deletes: capture the full before-state first.
  IF array_length(p_deleted_item_ids, 1) IS NOT NULL THEN
    INSERT INTO public.order_item_adjustments
      (event_id, order_id, order_item_id, adjustment_type, before_values, after_values,
       gross_delta, reason, was_invoice_posted, created_by)
    SELECT v_event, p_order_id, oi.id, 'item_removed', to_jsonb(oi), NULL,
           -COALESCE(oi.gross_amount, 0), v_reason, v_posted, p_changed_by
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id AND oi.id = ANY (p_deleted_item_ids);

    DELETE FROM public.order_items
    WHERE order_id = p_order_id AND id = ANY (p_deleted_item_ids);
  END IF;

  SELECT count(*) INTO v_count FROM public.order_items WHERE order_id = p_order_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'INVALID_ITEM: an order must keep at least one line item' USING ERRCODE = 'P0001';
  END IF;

  -- ── Totals from the resulting rows ─────────────────────────────────────
  IF v_financial_changed THEN
    SELECT COALESCE(sum(gross_amount), 0) INTO v_new_total
    FROM public.order_items WHERE order_id = p_order_id;

    -- Never let an edit push the total below money already received: that would
    -- create an overpayment with no refund / credit-note workflow behind it.
    SELECT COALESCE(sum(amount), 0) INTO v_paid
    FROM public.order_payments
    WHERE order_id = p_order_id AND reversed_at IS NULL;

    IF v_new_total < v_paid THEN
      RAISE EXCEPTION 'TOTAL_BELOW_PAYMENTS: the edited total (KES %) is lower than payments already received (KES %). Reverse or refund the excess payment first, or issue a credit note.',
        to_char(v_new_total, 'FM999,999,999,990.00'), to_char(v_paid, 'FM999,999,999,990.00')
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.orders o SET
      subtotal_amount = t.net,
      vat_amount      = t.vat,
      total_value     = t.gross
    FROM (
      SELECT COALESCE(sum(net_amount),0)   AS net,
             COALESCE(sum(vat_amount),0)   AS vat,
             COALESCE(sum(gross_amount),0) AS gross
      FROM public.order_items WHERE order_id = p_order_id
    ) t
    WHERE o.id = p_order_id;
  END IF;

  -- Posted invoice (admin only, checked above): post the difference to the ledger in this
  -- same transaction. The original invoice journal is left untouched.
  IF v_financial_changed AND v_posted THEN
    v_corr := public.post_invoice_correction(p_order_id, v_event, v_reason, p_changed_by);
  END IF;

  RETURN jsonb_build_object(
    'event_id', v_event,
    'financial_changed', v_financial_changed,
    'invoice_correction_journal_id', v_corr,
    'order', (SELECT to_jsonb(o) FROM public.orders o WHERE o.id = p_order_id),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order, i.created_at)
                       FROM public.order_items i WHERE i.order_id = p_order_id), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_items_with_audit(uuid, jsonb, uuid[], text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_items_with_audit(uuid, jsonb, uuid[], text, uuid, boolean) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
