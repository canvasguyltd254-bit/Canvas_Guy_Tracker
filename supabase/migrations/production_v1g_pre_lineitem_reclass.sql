-- production_v1g_pre_lineitem_reclass.sql
--
-- PREREQUISITE for production_v1g_boq_classification.sql
-- Run order:  this file  →  v1g  →  v1h
--
-- ── Why this exists ──────────────────────────────────────────────────────────
-- v1g's pre-flight aborts when order_items rows still carry line_type='product'
-- while holding a Canvas Guy charge category. It refuses to guess, by design.
--
-- But clearing that blocker was impossible as shipped: the CHECK constraint on
-- line_type only permits ('product','delivery','design'), while the pre-flight
-- blocks on FIVE charge categories. 'Installation Fee', 'Packaging' and
-- 'Other Charge' had no legal destination — any attempted fix would violate
-- the constraint. quotes_crm_migration_i already maps line_type→category for
-- all five types, so the constraint simply was never widened to match intent.
--
-- This migration closes that gap, then reclassifies the blocked rows.
--
-- ── Safety notes ─────────────────────────────────────────────────────────────
-- * line_type is NOT consumed by the GL / accountingService. It governs which
--   order lines become production jobs, plus CRM quotation display. Widening it
--   therefore carries no accounting risk. (Distinct from boq_line_type, which
--   does map to GL accounts — that column is untouched here.)
-- * Matching is on EXACT category equality, never on keywords in a description,
--   so a product called "Installation Kit" cannot be swept up.
-- * The reclassification is reported row-by-row via RAISE NOTICE, and any row
--   that already has a production job is called out loudly before it changes.
-- * Wrapped in a single transaction — a failure rolls the whole file back.
--
-- INSPECT BEFORE RUNNING. See the SELECT in the header comment of Step 2.

BEGIN;

-- ── 1. Widen line_type CHECK on order_items and quote_items ──────────────────
-- Constraints were created inline and auto-named by Postgres. Drop by
-- discovered name so this works regardless of the generated identifier.

DO $$
DECLARE
  v_con  text;
  v_tbl  text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['order_items', 'quote_items'] LOOP
    -- Skip cleanly if the table does not exist in this environment
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_tbl
    ) THEN
      RAISE NOTICE 'Table %.% not present — skipped.', 'public', v_tbl;
      CONTINUE;
    END IF;

    SELECT con.conname INTO v_con
    FROM   pg_constraint con
    JOIN   pg_class      rel ON rel.oid = con.conrelid
    JOIN   pg_namespace  nsp ON nsp.oid = rel.relnamespace
    WHERE  nsp.nspname = 'public'
      AND  rel.relname = v_tbl
      AND  con.contype = 'c'
      AND  pg_get_constraintdef(con.oid) ILIKE '%line_type%';

    IF v_con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_tbl, v_con);
      RAISE NOTICE 'Dropped old line_type constraint % on %.', v_con, v_tbl;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (line_type IN (%L,%L,%L,%L,%L,%L))',
      v_tbl, v_tbl || '_line_type_check',
      'product', 'delivery', 'design', 'installation', 'packaging', 'other'
    );
    RAISE NOTICE 'Widened line_type constraint on % to 6 values.', v_tbl;
  END LOOP;
END;
$$;


-- ── 2. Reclassify charge rows still marked as products ──────────────────────
--
-- To review the affected rows BEFORE running this file, execute:
--
--   SELECT oi.id, o.order_num, oi.category, oi.description,
--          oi.quantity, oi.unit_price,
--          (SELECT count(*) FROM production_jobs pj
--             WHERE pj.order_item_id = oi.id AND pj.status <> 'Cancelled')
--            AS active_jobs
--   FROM   order_items oi
--   JOIN   orders o ON o.id = oi.order_id
--   WHERE  oi.line_type = 'product'
--     AND  oi.category IN ('Delivery Fee','Design Fee','Installation Fee',
--                          'Packaging','Other Charge')
--   ORDER  BY o.order_num, oi.category;
--
-- Any row returning active_jobs > 0 is a charge line that wrongly acquired a
-- production job. v1g Step 6 cancels those jobs. If a row there is genuinely a
-- product that was mis-categorised, fix its category FIRST and it will then be
-- left alone by this migration.

DO $$
DECLARE
  r            record;
  v_updated    integer := 0;
  v_with_jobs  integer := 0;
BEGIN
  FOR r IN
    SELECT oi.id, oi.category, oi.description, o.order_num,
           (SELECT count(*) FROM public.production_jobs pj
              WHERE pj.order_item_id = oi.id AND pj.status <> 'Cancelled')
             AS active_jobs
    FROM   public.order_items oi
    JOIN   public.orders o ON o.id = oi.order_id
    WHERE  oi.line_type = 'product'
      AND  oi.category IN ('Delivery Fee','Design Fee','Installation Fee',
                           'Packaging','Other Charge')
    ORDER  BY o.order_num, oi.category
  LOOP
    IF r.active_jobs > 0 THEN
      v_with_jobs := v_with_jobs + 1;
      RAISE NOTICE 'ATTENTION  % / % (%) has % active production job(s) — v1g Step 6 will cancel them.',
        r.order_num, r.category, left(coalesce(r.description,''), 40), r.active_jobs;
    END IF;

    UPDATE public.order_items
    SET    line_type = CASE category
                         WHEN 'Delivery Fee'     THEN 'delivery'
                         WHEN 'Design Fee'       THEN 'design'
                         WHEN 'Installation Fee' THEN 'installation'
                         WHEN 'Packaging'        THEN 'packaging'
                         ELSE                         'other'
                       END
    WHERE  id = r.id;

    v_updated := v_updated + 1;
    RAISE NOTICE 'Reclassified  % / %  →  %',
      r.order_num, r.category, left(coalesce(r.description,''), 40);
  END LOOP;

  RAISE NOTICE '---';
  RAISE NOTICE 'Reclassified % charge row(s); % of them had active production jobs.',
    v_updated, v_with_jobs;
END;
$$;


-- ── 3. Verify v1g's pre-flight will now pass ────────────────────────────────
-- Same two predicates v1g tests. Abort here rather than let v1g fail later.

DO $$
DECLARE
  v_negative integer;
  v_charge   integer;
BEGIN
  SELECT COUNT(*) INTO v_negative
  FROM   public.order_items
  WHERE  line_type = 'product' AND unit_price <= 0;

  SELECT COUNT(*) INTO v_charge
  FROM   public.order_items
  WHERE  line_type = 'product'
    AND  category IN ('Delivery Fee','Design Fee','Installation Fee',
                      'Packaging','Other Charge');

  IF v_charge > 0 THEN
    RAISE EXCEPTION 'Reclassification incomplete: % charge row(s) remain.', v_charge;
  END IF;

  IF v_negative > 0 THEN
    RAISE EXCEPTION
      '% zero/negative-price row(s) still have line_type = ''product''. '
      'These are discounts, rebates or corrections and need a human decision — '
      'inspect them, set an appropriate line_type, then re-run. '
      'Query: SELECT id, category, description, unit_price FROM order_items '
      'WHERE line_type = ''product'' AND unit_price <= 0;',
      v_negative;
  END IF;

  RAISE NOTICE 'v1g pre-flight predicates now clean — safe to run v1g.';
END;
$$;

COMMIT;
