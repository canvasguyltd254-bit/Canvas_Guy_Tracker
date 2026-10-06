-- production_v1g_boq_classification.sql
--
-- 1. Reclassify obvious non-product order_items rows using name/description heuristics
--    (all rows already have line_type = 'product'; only GL-mapped types are written)
-- 2. Add boq_line_type enum + column to production_material_estimates
-- 3. Add cost_source_type enum + column to production_material_estimates
-- 4. Re-create create_production_plan with strict line_type = 'product' (no COALESCE)
-- 5. Re-create create_production_job with strict line_type = 'product'
-- 6. Update one-time cleanup block to use strict filter
-- 7. Add boq_line_type to production_boq_template_items + update RPCs
-- 10. Backfill seeded template items with correct boq_line_type
--
-- Run after: production_v1f_plan_product_filter.sql

BEGIN;

-- ── 0. Pre-flight: block migration if any candidate non-product rows exist ───
--
-- All order_items rows carry line_type = 'product' (NOT NULL DEFAULT).
-- Before Step 6 (cleanup) runs and cancels production jobs for non-product
-- lines, an admin MUST manually reclassify any rows that should not be
-- treated as products.  This block aborts the entire migration if suspicious
-- rows are detected, so the admin is forced to fix them first.
--
-- To clear a blocker, reclassify the row manually, then re-run the migration:
--   UPDATE public.order_items SET line_type = 'delivery' WHERE id = '<uuid>';
--   UPDATE public.order_items SET line_type = 'design'   WHERE id = '<uuid>';

DO $$
DECLARE
  v_negative_count   integer;
  v_charge_count     integer;
BEGIN
  -- Negative-price rows: likely discounts, rebates, or charge corrections
  SELECT COUNT(*) INTO v_negative_count
  FROM   public.order_items
  WHERE  line_type = 'product'
    AND  unit_price <= 0;

  -- Category-based candidates: Canvas Guy charge categories that map to non-product line types.
  -- quotes_crm_migration_i assigned these exact category strings to charge rows
  -- (line_type != 'product') when converting from quote_items.  Any row still carrying
  -- line_type = 'product' with one of these categories is almost certainly mis-classified.
  SELECT COUNT(*) INTO v_charge_count
  FROM   public.order_items
  WHERE  line_type = 'product'
    AND  category IN (
           'Delivery Fee',     -- maps to line_type = 'delivery'
           'Design Fee',       -- maps to line_type = 'design'
           'Installation Fee', -- maps to line_type = 'installation'
           'Packaging',        -- maps to line_type = 'packaging'
           'Other Charge'      -- catch-all non-product charge
         );

  IF v_negative_count > 0 OR v_charge_count > 0 THEN
    RAISE EXCEPTION
      'v1g pre-flight failed: % negative-price row(s) and % charge-category row(s) '
      'still have line_type = ''product''.  '
      'Manually reclassify these rows (see Step 1 comments) before re-running this migration.',
      v_negative_count, v_charge_count;
  END IF;

  RAISE NOTICE 'v1g pre-flight passed: no candidate non-product rows found.';
END;
$$;


-- ── 1. order_items.line_type — manual review required ────────────────────────
--
-- The line_type column was added as NOT NULL DEFAULT 'product' in
-- quotes_crm_migration_a, so ALL existing rows already have line_type =
-- 'product'.  Automatic keyword-based reclassification is intentionally
-- omitted: a product named "Installation Kit", "Service Panel", or
-- "Delivery Tray" would be silently moved to a non-product type, cancelling
-- its production job — an irreversible data corruption.
--
-- After running this migration an admin should review non-product charges
-- and reclassify them manually:
--
--   -- Negative-price rows (likely discounts or rebates):
--   SELECT id, category, description, unit_price
--   FROM   public.order_items
--   WHERE  line_type = 'product' AND unit_price <= 0;
--
--   -- Canvas Guy charge-category rows (verify before updating):
--   SELECT id, category, description
--   FROM   public.order_items
--   WHERE  line_type = 'product'
--     AND  category IN ('Delivery Fee','Design Fee','Installation Fee','Packaging','Other Charge');
--
--   -- To reclassify a confirmed non-product row:
--   UPDATE public.order_items
--   SET    line_type = 'delivery'   -- or 'design'
--   WHERE  id = '<uuid>';

DO $$
BEGIN
  RAISE NOTICE
    'v1g: No automatic reclassification of order_items.line_type. '
    'Review candidate rows manually — see the comments in Step 1 of this migration.';
END;
$$;


-- ── 2. boq_line_type enum + column ───────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'boq_line_type' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.boq_line_type AS ENUM (
      'material',
      'consumable',
      'packaging',
      'internal_labour',
      'machine_time',
      'outsourced_service'
    );
  END IF;
END;
$$;

ALTER TABLE public.production_material_estimates
  ADD COLUMN IF NOT EXISTS boq_line_type public.boq_line_type DEFAULT 'material';

COMMENT ON COLUMN public.production_material_estimates.boq_line_type
  IS 'Classifies how this BoQ line should be sourced and costed: material/consumable/packaging require a supplier or stock source; internal_labour/machine_time are always in-house; outsourced_service requires a supplier.';


-- ── 3. cost_source_type enum + column ────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'cost_source_type' AND typnamespace = 'public'::regnamespace
  ) THEN
    CREATE TYPE public.cost_source_type AS ENUM (
      'supplier',   -- cost comes from an external supplier (preferred_supplier_id must be set)
      'in_house',   -- produced / done internally (no supplier)
      'stock',      -- drawn from existing inventory (no external purchase)
      'manual'      -- manually entered estimate with no source link
    );
  END IF;
END;
$$;

ALTER TABLE public.production_material_estimates
  ADD COLUMN IF NOT EXISTS cost_source_type public.cost_source_type;

-- Back-fill: rows with a preferred_supplier_id set → supplier; otherwise leave NULL
-- (NULL means "source not yet chosen", which the UI treats as "uncosted")
UPDATE public.production_material_estimates
SET    cost_source_type = 'supplier'
WHERE  preferred_supplier_id IS NOT NULL
  AND  cost_source_type IS NULL;

-- Rows classified as internal_labour or machine_time must ALWAYS be in_house.
-- Run unconditionally: a previous partial migration run could have left some of
-- these rows with cost_source_type = 'supplier' (set by the backfill above, if
-- a supplier was attached before re-classification).  Without this, the
-- pme_inhouse_no_supplier constraint added in Step 3c would fail.
UPDATE public.production_material_estimates
SET    cost_source_type       = 'in_house',
       preferred_supplier_id  = NULL
WHERE  boq_line_type IN ('internal_labour', 'machine_time');

COMMENT ON COLUMN public.production_material_estimates.cost_source_type
  IS 'Where this cost comes from. NULL means the source has not yet been selected (row is uncosted). supplier requires preferred_supplier_id; in_house and stock must have preferred_supplier_id = NULL.';


-- ── 3c. Integrity constraints (always-upgrade) ──────────────────────────────
-- Enforce referential rules between boq_line_type, cost_source_type, and
-- preferred_supplier_id at the database level.
-- Each constraint is DROPPED (if it exists from any prior run) then re-added,
-- so the latest definition is always applied — even when a stale version was
-- installed by an earlier attempt at this migration.

-- In-house types (internal_labour, machine_time) must have:
--   • no supplier attached (preferred_supplier_id IS NULL)
--   • cost_source_type either unset (NULL = not yet costed) or 'in_house'
-- This prevents impossible states like machine_time with cost_source_type = 'stock'.
ALTER TABLE public.production_material_estimates
  DROP CONSTRAINT IF EXISTS pme_inhouse_no_supplier;
ALTER TABLE public.production_material_estimates
  ADD CONSTRAINT pme_inhouse_no_supplier
    CHECK (
      boq_line_type NOT IN ('internal_labour', 'machine_time')
      OR (
        preferred_supplier_id IS NULL
        AND (cost_source_type IS NULL OR cost_source_type = 'in_house')
      )
    );

ALTER TABLE public.production_material_estimates
  DROP CONSTRAINT IF EXISTS pme_supplier_requires_id;
ALTER TABLE public.production_material_estimates
  ADD CONSTRAINT pme_supplier_requires_id
    CHECK (
      cost_source_type IS NULL
      OR cost_source_type != 'supplier'
      OR preferred_supplier_id IS NOT NULL
    );

-- outsourced_service rows:
--   • When cost_source_type is NULL, the row is uncosted (allowed — user will configure it).
--   • Once cost_source_type is set, it must be 'supplier' and preferred_supplier_id must be set.
-- Allowing the uncosted state prevents the DB from rejecting the row immediately
-- when the user sets boq_line_type before choosing a supplier.
ALTER TABLE public.production_material_estimates
  DROP CONSTRAINT IF EXISTS pme_outsourced_requires_supplier;
ALTER TABLE public.production_material_estimates
  ADD CONSTRAINT pme_outsourced_requires_supplier
    CHECK (
      boq_line_type != 'outsourced_service'
      OR cost_source_type IS NULL
      OR (cost_source_type = 'supplier' AND preferred_supplier_id IS NOT NULL)
    );


-- ── 4. Re-create create_production_plan — strict line_type = product ─────────
--
-- Removes all COALESCE/fallback logic now that legacy NULLs have been classified.

CREATE OR REPLACE FUNCTION public.create_production_plan(
  p_order_id   uuid,
  p_notes      text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_item    RECORD;
  v_job_num text;
BEGIN
  -- Order must exist
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order_id) THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  -- Order must not be suspended
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE  id = p_order_id AND suspended_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot create a production plan for a suspended order';
  END IF;

  -- One plan per order
  IF EXISTS (SELECT 1 FROM public.production_plans WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'A production plan already exists for order %', p_order_id;
  END IF;

  -- Order must have at least one product line item (strict: no COALESCE fallback)
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items
    WHERE  order_id = p_order_id
      AND  line_type = 'product'
  ) THEN
    RAISE EXCEPTION 'Order % has no product line items to produce.', p_order_id;
  END IF;

  INSERT INTO public.production_plans (order_id, status, notes, created_by)
  VALUES (p_order_id, 'Draft', p_notes, p_created_by)
  RETURNING id INTO v_plan_id;

  -- Import PRODUCT lines only — strict equality, no fallback.
  FOR v_item IN
    SELECT id, category, description, size,
           finish_type, finish_color, wood_type, quantity
    FROM   public.order_items
    WHERE  order_id = p_order_id
      AND  line_type = 'product'
    ORDER  BY sort_order ASC, created_at ASC
  LOOP
    v_job_num := public.next_job_num();

    INSERT INTO public.production_jobs (
      job_num, plan_id, order_id, order_item_id,
      category, description, size,
      finish_type, finish_color, wood_type,
      planned_quantity, status, created_by
    ) VALUES (
      v_job_num, v_plan_id, p_order_id, v_item.id,
      v_item.category, v_item.description, v_item.size,
      v_item.finish_type, v_item.finish_color, v_item.wood_type,
      v_item.quantity, 'Planned', p_created_by
    );
  END LOOP;

  RETURN v_plan_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.create_production_plan(uuid, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_production_plan(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION public.create_production_plan(uuid, text, uuid)
  IS 'Creates a Draft production plan for an order, importing product line items only '
     '(strict line_type = ''product''; no COALESCE fallback — legacy NULLs must be classified first). '
     'Guards: order must exist, not suspended, no existing plan, at least one product item.';


-- ── 5. Re-create create_production_job — strict line_type = product ───────────

CREATE OR REPLACE FUNCTION public.create_production_job(
  p_plan_id                 uuid,
  p_order_item_id           uuid,
  p_planned_quantity        integer,
  p_category                text    DEFAULT NULL,
  p_description             text    DEFAULT NULL,
  p_size                    text    DEFAULT NULL,
  p_finish_type             text    DEFAULT NULL,
  p_finish_color            text    DEFAULT NULL,
  p_wood_type               text    DEFAULT NULL,
  p_production_instructions text    DEFAULT NULL,
  p_priority                integer DEFAULT 0,
  p_planned_start           date    DEFAULT NULL,
  p_planned_finish          date    DEFAULT NULL,
  p_created_by              uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id      uuid;
  v_item_quantity integer;
  v_line_type     text;
  v_allocated     integer;
  v_available     integer;
  v_job_id        uuid;
  v_job_num       text;
BEGIN
  IF p_planned_quantity <= 0 THEN
    RAISE EXCEPTION 'planned_quantity must be greater than 0';
  END IF;

  -- Resolve order_id from plan
  SELECT order_id INTO v_order_id
  FROM   public.production_plans
  WHERE  id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production plan % not found', p_plan_id;
  END IF;

  -- Lock the order_item row and capture quantity + line_type (strict, no COALESCE)
  SELECT quantity, line_type
  INTO   v_item_quantity, v_line_type
  FROM   public.order_items
  WHERE  id = p_order_item_id
    AND  order_id = v_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item % not found on order %', p_order_item_id, v_order_id;
  END IF;

  -- Reject non-product line items (strict: no COALESCE fallback)
  IF v_line_type IS DISTINCT FROM 'product' THEN
    RAISE EXCEPTION 'Only product line items can be added to production (got: %)', COALESCE(v_line_type, 'NULL');
  END IF;

  -- Sum active (non-cancelled) allocations for this order item
  SELECT COALESCE(SUM(planned_quantity), 0)
  INTO   v_allocated
  FROM   public.production_jobs
  WHERE  order_item_id = p_order_item_id
    AND  status != 'Cancelled';

  v_available := v_item_quantity - v_allocated;

  IF p_planned_quantity > v_available THEN
    RAISE EXCEPTION
      'Cannot allocate % units: ordered %, already allocated %, available %',
      p_planned_quantity, v_item_quantity, v_allocated, v_available;
  END IF;

  v_job_num := public.next_job_num();

  INSERT INTO public.production_jobs (
    job_num, plan_id, order_id, order_item_id,
    category, description, size,
    finish_type, finish_color, wood_type,
    production_instructions,
    planned_quantity, priority,
    planned_start, planned_finish,
    created_by
  ) VALUES (
    v_job_num, p_plan_id, v_order_id, p_order_item_id,
    p_category, p_description, p_size,
    p_finish_type, p_finish_color, p_wood_type,
    p_production_instructions,
    p_planned_quantity, p_priority,
    p_planned_start, p_planned_finish,
    p_created_by
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.create_production_job(uuid,uuid,integer,text,text,text,text,text,text,text,integer,date,date,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_production_job(uuid,uuid,integer,text,text,text,text,text,text,text,integer,date,date,uuid) TO service_role;

COMMENT ON FUNCTION public.create_production_job(uuid,uuid,integer,text,text,text,text,text,text,text,integer,date,date,uuid)
  IS 'Creates an additional production job within a plan. '
     'Rejects non-product order items (strict line_type = ''product''; no COALESCE fallback). '
     'Locks the order_item row and validates that total active allocations '
     'do not exceed the ordered quantity.';


-- ── 6. One-time cleanup: cancel or delete remaining non-product jobs ──────────
--
-- Now that all NULL line_types have been classified, we use strict equality.
-- Any job still linked to a non-product item was missed by the v1f cleanup.

DO $$
DECLARE
  v_job         RECORD;
  v_has_activity boolean;
BEGIN
  FOR v_job IN
    SELECT pj.id
    FROM   public.production_jobs   pj
    JOIN   public.order_items       oi ON oi.id = pj.order_item_id
    WHERE  oi.line_type <> 'product'      -- strict: no COALESCE fallback
      AND  pj.cancelled_at IS NULL
  LOOP
    SELECT (
      EXISTS (SELECT 1 FROM public.production_progress_entries       WHERE job_id = v_job.id)
      OR
      EXISTS (SELECT 1 FROM public.production_material_estimates     WHERE job_id = v_job.id)
      OR
      EXISTS (SELECT 1 FROM public.production_job_assignments        WHERE job_id = v_job.id)
      OR
      EXISTS (
        SELECT 1
        FROM   public.production_stage_progress_entries spe
        JOIN   public.production_job_stages             s ON s.id = spe.stage_id
        WHERE  s.job_id = v_job.id
      )
    ) INTO v_has_activity;

    IF v_has_activity THEN
      UPDATE public.production_jobs
      SET    status           = 'Cancelled',
             cancelled_at     = NOW(),
             cancelled_reason = 'Non-product charge — classified and removed from production'
      WHERE  id = v_job.id;
    ELSE
      DELETE FROM public.production_jobs WHERE id = v_job.id;
    END IF;
  END LOOP;
END;
$$;


-- ── 7. Add boq_line_type to BoQ template items (P1) ──────────────────────────
--
-- production_boq_template_items didn't have boq_line_type when v1d was written.
-- Adding it now so apply_boq_template_to_job can copy it into estimates.

ALTER TABLE public.production_boq_template_items
  ADD COLUMN IF NOT EXISTS boq_line_type public.boq_line_type NOT NULL DEFAULT 'material';

COMMENT ON COLUMN public.production_boq_template_items.boq_line_type
  IS 'BoQ classification for this template item; copied to production_material_estimates when the template is applied to a job.';


-- ── 8. Update replace_boq_template_items — persist boq_line_type ─────────────

CREATE OR REPLACE FUNCTION public.replace_boq_template_items(
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

  IF NOT EXISTS (
    SELECT 1 FROM production_boq_templates WHERE id = p_template_id
  ) THEN
    RAISE EXCEPTION 'Template % not found', p_template_id;
  END IF;

  v_len := jsonb_array_length(p_items);
  FOR v_i IN 0 .. (v_len - 1) LOOP
    v_item := p_items -> v_i;
    IF NULLIF(btrim(v_item->>'material_name'), '') IS NULL THEN
      RAISE EXCEPTION 'Item % is missing material_name', v_i + 1;
    END IF;
    IF NULLIF(btrim(v_item->>'unit'), '') IS NULL THEN
      RAISE EXCEPTION 'Item % is missing unit', v_i + 1;
    END IF;
    IF (v_item->>'quantity_per_unit') IS NULL
       OR (v_item->>'quantity_per_unit')::numeric <= 0 THEN
      RAISE EXCEPTION 'Item % quantity_per_unit must be > 0', v_i + 1;
    END IF;
  END LOOP;

  DELETE FROM production_boq_template_items WHERE template_id = p_template_id;

  IF v_len > 0 THEN
    INSERT INTO production_boq_template_items
      (template_id, sort_order, material_name, specification,
       unit, quantity_per_unit, waste_percentage, boq_line_type, notes)
    SELECT
      p_template_id,
      (t.ord - 1)::integer,
      btrim(t.val->>'material_name'),
      NULLIF(btrim(t.val->>'specification'), ''),
      btrim(t.val->>'unit'),
      (t.val->>'quantity_per_unit')::numeric,
      COALESCE((t.val->>'waste_percentage')::numeric, 0),
      COALESCE((t.val->>'boq_line_type')::public.boq_line_type, 'material'),
      NULLIF(btrim(t.val->>'notes'), '')
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(val, ord);

    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  UPDATE production_boq_templates
  SET updated_at = now()
  WHERE id = p_template_id;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_boq_template_items(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_boq_template_items(uuid, jsonb)
  TO service_role;


-- ── 9. Update apply_boq_template_to_job — copy boq_line_type ─────────────────

CREATE OR REPLACE FUNCTION public.apply_boq_template_to_job(
  p_job_id      uuid,
  p_template_id uuid,
  p_mode        text,    -- 'append' | 'replace'
  p_applied_by  uuid
)
RETURNS integer          -- number of material lines inserted
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job      RECORD;
  v_tpl_cnt  integer;
  v_count    integer;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id is required';
  END IF;
  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'p_template_id is required';
  END IF;
  IF p_mode NOT IN ('append', 'replace') THEN
    RAISE EXCEPTION 'mode must be "append" or "replace", got "%"', p_mode;
  END IF;
  IF p_applied_by IS NULL THEN
    RAISE EXCEPTION 'p_applied_by is required';
  END IF;

  SELECT id, planned_quantity, status
  INTO v_job
  FROM production_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;
  IF v_job.status IN ('Cancelled', 'Completed') THEN
    RAISE EXCEPTION
      'Cannot apply a BoQ template to a % job',
      lower(v_job.status);
  END IF;

  SELECT COUNT(*) INTO v_tpl_cnt
  FROM production_boq_template_items
  WHERE template_id = p_template_id;

  IF NOT EXISTS (
    SELECT 1 FROM production_boq_templates
    WHERE id = p_template_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Template % not found or is not active', p_template_id;
  END IF;

  IF v_tpl_cnt = 0 THEN
    RAISE EXCEPTION 'Template has no items — add items to the template first';
  END IF;

  IF p_mode = 'replace' THEN
    DELETE FROM production_material_estimates WHERE job_id = p_job_id;
  END IF;

  -- Copy boq_line_type from template items so estimates are pre-classified.
  -- In-house types (internal_labour, machine_time) auto-receive cost_source_type = 'in_house'
  -- so they satisfy the pme_inhouse_no_supplier constraint without a follow-up PATCH.
  INSERT INTO production_material_estimates
    (job_id, material_name, specification, unit,
     quantity_per_unit, planned_quantity, waste_percentage,
     boq_line_type, cost_source_type, notes, created_by)
  SELECT
    p_job_id,
    i.material_name,
    i.specification,
    i.unit,
    i.quantity_per_unit,
    v_job.planned_quantity,
    i.waste_percentage,
    COALESCE(i.boq_line_type, 'material'),
    CASE
      WHEN COALESCE(i.boq_line_type, 'material') IN ('internal_labour', 'machine_time')
        THEN 'in_house'::public.cost_source_type
      ELSE NULL::public.cost_source_type
    END,
    i.notes,
    p_applied_by
  FROM production_boq_template_items i
  WHERE i.template_id = p_template_id
  ORDER BY i.sort_order;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_boq_template_to_job(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_boq_template_to_job(uuid, uuid, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.apply_boq_template_to_job(uuid, uuid, text, uuid)
  IS 'Loads a BoQ template into a job''s material estimates, copying boq_line_type from template items. '
     'p_mode "replace" clears existing estimates first; "append" adds on top.';


-- ── 10. Backfill boq_line_type for seeded rows ───────────────────────────────
--
-- 10a. production_boq_template_items
--      When v1d was applied, this table had no boq_line_type column.
--      Now that the column exists (Step 7), all seeded rows defaulted to
--      'material'.  Classify the known non-material rows.
--
--      Patterns:
--        "Machine Time — <machine>" / "Canvas Print Time" → machine_time
--        "Packaging — <type>"                             → packaging
--      (No internal_labour rows exist in the current seed data.)

UPDATE public.production_boq_template_items
SET    boq_line_type = 'machine_time'
WHERE  boq_line_type = 'material'
  AND  (
         LOWER(material_name) LIKE '%machine time%'
      OR LOWER(material_name) LIKE '%print time%'
  );

UPDATE public.production_boq_template_items
SET    boq_line_type = 'packaging'
WHERE  boq_line_type = 'material'
  AND  LOWER(material_name) LIKE '%packaging%';


-- 10b. production_material_estimates
--      Existing estimates were created before boq_line_type existed (or before
--      apply_boq_template_to_job was updated to set cost_source_type).
--      Backfill the same patterns used in 10a, and also set cost_source_type
--      for in-house rows so they satisfy the pme_inhouse_no_supplier constraint.

UPDATE public.production_material_estimates
SET    boq_line_type     = 'machine_time',
       cost_source_type  = 'in_house',
       preferred_supplier_id = NULL
WHERE  boq_line_type = 'material'
  AND  (
         LOWER(material_name) LIKE '%machine time%'
      OR LOWER(material_name) LIKE '%print time%'
  );

UPDATE public.production_material_estimates
SET    boq_line_type = 'packaging'
WHERE  boq_line_type = 'material'
  AND  LOWER(material_name) LIKE '%packaging%';

-- Also fix any in-house type estimates that already have boq_line_type set
-- but are missing cost_source_type (e.g. applied before this migration).
UPDATE public.production_material_estimates
SET    cost_source_type       = 'in_house',
       preferred_supplier_id  = NULL
WHERE  boq_line_type IN ('internal_labour', 'machine_time')
  AND  cost_source_type IS NULL;

DO $$
DECLARE
  v_tpl_machine  integer; v_tpl_packaging  integer;
  v_est_machine  integer; v_est_packaging  integer; v_est_inhouse integer;
BEGIN
  SELECT COUNT(*) INTO v_tpl_machine   FROM public.production_boq_template_items WHERE boq_line_type = 'machine_time';
  SELECT COUNT(*) INTO v_tpl_packaging FROM public.production_boq_template_items WHERE boq_line_type = 'packaging';
  SELECT COUNT(*) INTO v_est_machine   FROM public.production_material_estimates  WHERE boq_line_type = 'machine_time';
  SELECT COUNT(*) INTO v_est_packaging FROM public.production_material_estimates  WHERE boq_line_type = 'packaging';
  SELECT COUNT(*) INTO v_est_inhouse   FROM public.production_material_estimates
    WHERE boq_line_type IN ('internal_labour','machine_time') AND cost_source_type = 'in_house';
  RAISE NOTICE
    'v1g backfill — templates: % machine_time, % packaging. '
    'Estimates: % machine_time, % packaging; % in-house rows have cost_source_type = in_house.',
    v_tpl_machine, v_tpl_packaging, v_est_machine, v_est_packaging, v_est_inhouse;
END;
$$;


COMMIT;
