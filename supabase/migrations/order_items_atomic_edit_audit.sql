-- ============================================================
-- Canvas Guy Tracker — Atomic, audited order-item edits
--
-- Problem
--   The order form wrote order_items straight to Supabase from the browser
--   (looped writes, browser-computed total_value, no audit, no net/VAT/gross).
--   The CRM invoice then mixed quotation line totals with the live
--   orders.total_value, so the two disagreed after any order-side edit.
--
-- What this migration adds
--   1. order_item_adjustments — append-only audit log (before/after JSON,
--      shared event_id per Save, reason, invoice-posted flag, gross delta).
--   2. update_order_items_with_audit() — one atomic, service-role-only RPC:
--        * locks the order row
--        * rejects financial changes once invoice_journal_entry_id is set
--          (the authoritative accounting lock); metadata stays editable
--        * validates every submitted line, normalises line_type
--        * recomputes net / VAT / gross server-side
--        * applies inserts / updates / deletes
--        * recomputes orders.subtotal_amount / vat_amount / total_value
--          from the resulting rows (the client never supplies a total)
--        * writes audit rows in the same transaction
--
-- Errors raised (mapped to HTTP by PATCH /api/orders/:id):
--   INVOICE_POSTED       → 409    REASON_REQUIRED → 422
--   TOTAL_BELOW_PAYMENTS → 409    INVALID_ITEM    → 422
--   ORDER_NOT_FOUND      → 404
--
-- Safe to re-run.
-- ============================================================

BEGIN;

-- ── 1. Audit table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_item_adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL,                       -- shared by every row of one Save
  order_id           uuid NOT NULL,                       -- no FK: history must outlive deletes
  order_item_id      uuid,                                -- nullable: item may since be deleted
  adjustment_type    text NOT NULL
                       CHECK (adjustment_type IN ('item_added','item_removed','item_changed')),
  before_values      jsonb,
  after_values       jsonb,
  gross_delta        numeric(14,2) NOT NULL DEFAULT 0,
  reason             text NOT NULL,
  was_invoice_posted boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid
);

CREATE INDEX IF NOT EXISTS idx_order_item_adjustments_order
  ON public.order_item_adjustments (order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_item_adjustments_event
  ON public.order_item_adjustments (event_id);

COMMENT ON TABLE public.order_item_adjustments IS
  'Append-only audit of financial order-item changes. before_values/after_values hold the full row so history survives item deletion. Written only by update_order_items_with_audit().';

ALTER TABLE public.order_item_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_item_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.order_item_adjustments TO service_role;
-- No UPDATE / DELETE grant: the log is append-only.

-- ── 2. Atomic edit RPC ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_order_items_with_audit(
  p_order_id         uuid,
  p_items            jsonb,
  p_deleted_item_ids uuid[],
  p_reason           text,
  p_changed_by       uuid
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
  IF v_financial_changed AND v_posted THEN
    RAISE EXCEPTION 'INVOICE_POSTED: this order''s invoice has been posted to accounting; quantity, price, tax and charge changes require a credit/debit note or reversal and reissue'
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

  RETURN jsonb_build_object(
    'event_id', v_event,
    'financial_changed', v_financial_changed,
    'order', (SELECT to_jsonb(o) FROM public.orders o WHERE o.id = p_order_id),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.sort_order, i.created_at)
                       FROM public.order_items i WHERE i.order_id = p_order_id), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_items_with_audit(uuid, jsonb, uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_items_with_audit(uuid, jsonb, uuid[], text, uuid) TO service_role;

COMMIT;
