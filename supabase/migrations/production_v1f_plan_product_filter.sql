-- production_v1f_plan_product_filter.sql
--
-- 1. Replace create_production_plan  — import product lines only
-- 2. Replace create_production_job   — reject non-product order items
-- 3. One-time cleanup                — cancel or delete existing non-product jobs
--
-- Run after: production_v1e_stages.sql

BEGIN;

-- ── 1. create_production_plan (product lines only) ────────────────────────────
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

  -- Order must have at least one product line item to produce
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items
    WHERE  order_id = p_order_id
      AND  COALESCE(line_type, 'product') = 'product'
  ) THEN
    RAISE EXCEPTION 'Order % has no product line items to produce.', p_order_id;
  END IF;

  INSERT INTO public.production_plans (order_id, status, notes, created_by)
  VALUES (p_order_id, 'Draft', p_notes, p_created_by)
  RETURNING id INTO v_plan_id;

  -- Import PRODUCT lines only.
  -- COALESCE(line_type, 'product') treats legacy rows with NULL line_type as products.
  FOR v_item IN
    SELECT id, category, description, size,
           finish_type, finish_color, wood_type, quantity
    FROM   public.order_items
    WHERE  order_id = p_order_id
      AND  COALESCE(line_type, 'product') = 'product'
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
     '(COALESCE(line_type, ''product'') = ''product''). '
     'Guards: order must exist, not suspended, no existing plan.';


-- ── 2. create_production_job (reject non-product items) ───────────────────────
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

  -- Lock the order_item row and capture quantity + line_type
  SELECT quantity, COALESCE(line_type, 'product')
  INTO   v_item_quantity, v_line_type
  FROM   public.order_items
  WHERE  id = p_order_item_id
    AND  order_id = v_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item % not found on order %', p_order_item_id, v_order_id;
  END IF;

  -- Reject non-product line items (delivery fees, charges, etc.)
  IF v_line_type <> 'product' THEN
    RAISE EXCEPTION 'Only product line items can be added to production.';
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
     'Rejects non-product order items (delivery fees, charges). '
     'Locks the order_item row and validates that total active allocations '
     'do not exceed the ordered quantity.';


-- ── 3. One-time cleanup: cancel or delete existing non-product jobs ───────────
--
-- Jobs where the linked order_item is a non-product charge (e.g. Delivery Fee):
--   • No activity → hard delete (they were never worked on)
--   • Has any activity → cancel with a reason (preserve the audit trail)
--
-- "Activity" means: progress entries, stage progress entries, material estimates,
-- or worker assignments.  Stage progress entries are reached via job_id → stage → entry.

DO $$
DECLARE
  v_job         RECORD;
  v_has_activity boolean;
BEGIN
  FOR v_job IN
    SELECT pj.id
    FROM   public.production_jobs   pj
    JOIN   public.order_items       oi ON oi.id = pj.order_item_id
    WHERE  COALESCE(oi.line_type, 'product') <> 'product'
      AND  pj.cancelled_at IS NULL   -- skip already-cancelled rows
  LOOP
    -- Check for any recorded activity on this job (including per-stage history)
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
        JOIN   public.production_job_stages             s   ON s.id = spe.stage_id
        WHERE  s.job_id = v_job.id
      )
    ) INTO v_has_activity;

    IF v_has_activity THEN
      -- Preserve audit trail: soft-cancel with explanatory reason
      UPDATE public.production_jobs
      SET    status           = 'Cancelled',
             cancelled_at     = NOW(),
             cancelled_reason = 'Non-product charge imported in error'
      WHERE  id = v_job.id;
    ELSE
      -- No activity: clean slate, hard delete
      -- (FK cascades handle production_job_stages and other child rows)
      DELETE FROM public.production_jobs WHERE id = v_job.id;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
