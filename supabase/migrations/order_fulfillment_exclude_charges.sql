-- ============================================================
-- Canvas Guy Tracker — Exclude charge lines from delivery fulfillment
--
-- Problem
--   order_item_fulfillment (the source of the batch picker and the
--   remaining-quantity guard) excluded an obsolete category list:
--     Delivery Fee, Installation Fee, Design Fee, Rush Fee, Discount
--   but the app creates charges with these categories:
--     Delivery Fee, Design Fee, Installation Fee, Packaging, Other Charge
--   so Packaging and Other Charge lines appeared as deliverable items.
--
--   Also, charges typed directly on the order side are inserted WITHOUT a
--   line_type, so they carry the column default 'product'. line_type alone
--   therefore cannot be trusted to identify them; the category must be
--   checked as well. A row is deliverable only if line_type = 'product'
--   AND its category is not a charge category. (Mirrors
--   shared/lib/orderLineTypes.js — keep the two lists identical.)
--
-- What this migration does
--   1. Creates a review view of every charge row currently sitting in a
--      delivery batch (delivery_batch_charge_exceptions).
--   2. Backfills line_type on UNPOSTED orders' charge rows so the GL/invoice
--      mapping sees them as charges. Posted invoices are left untouched.
--   3. Removes charge rows from OPEN batches only (Quality Control, Planned,
--      Picking, Loaded) and logs each removal to order_activities.
--      Out for Delivery / Delivered / Signed / Rejected / Returned /
--      Cancelled batches are completed or in-flight delivery evidence and
--      are NEVER modified — they remain visible in the review view.
--   4. Redefines order_item_fulfillment.
--
-- Safe to re-run.
-- ============================================================

BEGIN;

-- ── 1. Review view: charge rows that are (still) inside delivery batches ───
CREATE OR REPLACE VIEW public.delivery_batch_charge_exceptions AS
SELECT
  o.order_num,
  db.order_id,
  db.id            AS batch_id,
  db.batch_number,
  db.status        AS batch_status,
  dbi.id           AS batch_item_id,
  oi.id            AS order_item_id,
  oi.category,
  oi.line_type,
  oi.description,
  dbi.quantity_planned,
  dbi.quantity_delivered,
  (db.status IN ('Quality Control','Planned','Picking','Loaded')) AS is_open_batch
FROM public.delivery_batch_items dbi
JOIN public.delivery_batches db ON db.id = dbi.batch_id
JOIN public.order_items      oi ON oi.id = dbi.order_item_id
JOIN public.orders           o  ON o.id  = db.order_id
WHERE oi.line_type <> 'product'
   OR oi.category IN ('Delivery Fee','Design Fee','Installation Fee',
                      'Packaging','Other Charge','Rush Fee','Discount');

COMMENT ON VIEW public.delivery_batch_charge_exceptions IS
  'Charge lines (delivery/design/installation/packaging/other) that are recorded inside a delivery batch. Open-batch rows are removed by order_fulfillment_exclude_charges.sql; rows in completed or in-flight batches are preserved as delivery history and listed here for manual review.';

-- Administrative review only: it exposes order numbers, descriptions and
-- delivery data. The view owner (SQL Editor / postgres) can still query it.
REVOKE ALL ON public.delivery_batch_charge_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.delivery_batch_charge_exceptions TO service_role;

-- ── 2. Backfill line_type on unposted orders' charge rows ──────────────────
UPDATE public.order_items oi
SET    line_type = CASE oi.category
         WHEN 'Delivery Fee'     THEN 'delivery'
         WHEN 'Design Fee'       THEN 'design'
         WHEN 'Installation Fee' THEN 'installation'
         WHEN 'Packaging'        THEN 'packaging'
         ELSE                         'other'
       END
FROM   public.orders o
WHERE  oi.order_id = o.id
  AND  o.invoice_journal_entry_id IS NULL
  AND  oi.line_type = 'product'
  AND  oi.category IN ('Delivery Fee','Design Fee','Installation Fee',
                       'Packaging','Other Charge','Rush Fee','Discount');

-- ── 3. Remove charge rows from OPEN batches only, with an activity trail ───
DO $$
DECLARE
  r              record;
  v_removed      integer := 0;
  v_preserved    integer;
BEGIN
  FOR r IN
    SELECT *
    FROM   public.delivery_batch_charge_exceptions
    WHERE  is_open_batch
  LOOP
    DELETE FROM public.delivery_batch_items WHERE id = r.batch_item_id;

    INSERT INTO public.order_activities (order_id, activity_type, description)
    VALUES (
      r.order_id,
      'batch_charge_removed',
      format('Charge line "%s" (%s) removed from open batch %s — charges are not deliverable items.',
             COALESCE(r.description, r.category), r.category, r.batch_number)
    );

    v_removed := v_removed + 1;
  END LOOP;

  SELECT count(*) INTO v_preserved FROM public.delivery_batch_charge_exceptions;

  RAISE NOTICE 'Charge rows removed from open batches: %', v_removed;
  RAISE NOTICE 'Charge rows preserved in completed/in-flight batches (review with: SELECT * FROM delivery_batch_charge_exceptions): %', v_preserved;
END;
$$;

-- ── 4. Redefine the fulfillment view ───────────────────────────────────────
CREATE OR REPLACE VIEW public.order_item_fulfillment AS
SELECT
  oi.id                                                         AS order_item_id,
  oi.order_id,
  oi.category,
  oi.description,
  oi.size,
  COALESCE(oi.quantity, 1)                                      AS ordered_qty,
  COALESCE(SUM(CASE WHEN db.status NOT IN ('Cancelled','Rejected','Returned') THEN dbi.quantity_planned ELSE 0 END), 0) AS batched_qty,
  COALESCE(SUM(CASE WHEN db.status IN ('Delivered','Signed')   THEN dbi.quantity_delivered ELSE 0 END), 0) AS delivered_qty,
  COALESCE(oi.quantity, 1) -
    COALESCE(SUM(CASE WHEN db.status NOT IN ('Cancelled','Rejected','Returned') THEN dbi.quantity_planned ELSE 0 END), 0) AS remaining_qty
FROM public.order_items oi
LEFT JOIN public.delivery_batch_items dbi ON dbi.order_item_id = oi.id
LEFT JOIN public.delivery_batches     db  ON db.id = dbi.batch_id
WHERE oi.line_type = 'product'
  -- COALESCE: a NULL category must not make NOT IN evaluate to NULL and
  -- silently drop a real product from the picker.
  AND COALESCE(oi.category, '') NOT IN ('Delivery Fee','Design Fee','Installation Fee',
                                        'Packaging','Other Charge','Rush Fee','Discount')
GROUP BY oi.id, oi.order_id, oi.category, oi.description, oi.size, oi.quantity;

COMMIT;
