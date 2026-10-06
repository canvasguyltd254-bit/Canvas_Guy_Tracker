-- ─────────────────────────────────────────────────────────────────────────────
-- Production V1 — Phase 1A schema
--
-- Tables
--   job_num_sequences           per-year counter for JOB-YYYY-NNNN
--   production_operations       configurable operation lookup (Cutting, QC …)
--   production_plans            one plan per order; imports order items as jobs
--   production_jobs             unit of production work with cached qty buckets
--   production_job_assignments  worker ↔ job ↔ operation links (no qty history)
--   production_job_drawings     links jobs to order drawings (same-order guard)
--   production_material_estimates  lightweight estimated BoQ; no inventory
--
-- RPCs (service_role only, SECURITY DEFINER)
--   next_job_num()
--   create_production_plan(order_id, notes, created_by)
--   create_production_job(plan_id, order_item_id, planned_quantity, …)
--   update_production_job_quantity(job_id, planned_quantity, updated_by)
--   replace_job_assignments(job_id, assignments jsonb, assigned_by)
--   link_job_drawing(job_id, drawing_id, linked_by)
--
-- No progress entries (Phase 1B). No inventory (Phase 2).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Job number sequence ────────────────────────────────────────────────────
-- Counter restarts at 1 each calendar year.
-- next_job_num() is the only permitted writer.
CREATE TABLE IF NOT EXISTS public.job_num_sequences (
  year     integer PRIMARY KEY,
  last_num integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.job_num_sequences
  IS 'Per-calendar-year counter for production job numbers. Written only by next_job_num().';

CREATE OR REPLACE FUNCTION public.next_job_num()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year integer := EXTRACT(YEAR FROM now())::integer;
  v_num  integer;
BEGIN
  -- INSERT … ON CONFLICT DO UPDATE is atomic under concurrent load.
  INSERT INTO public.job_num_sequences (year, last_num)
  VALUES (v_year, 1)
  ON CONFLICT (year) DO UPDATE
    SET last_num = public.job_num_sequences.last_num + 1
  RETURNING last_num INTO v_num;

  RETURN 'JOB-' || v_year::text || '-' || LPAD(v_num::text, 4, '0');
END;
$$;

REVOKE ALL     ON FUNCTION public.next_job_num() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.next_job_num() TO service_role;

COMMENT ON FUNCTION public.next_job_num()
  IS 'Generates the next globally-unique job number (JOB-YYYY-NNNN). Sequence resets each calendar year. Never call directly from application code — call only from production RPCs.';


-- ── 1. Operations lookup ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.production_operations (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_operations
  IS 'Configurable list of production operations. Referenced by job assignments. Add/deactivate rows via admin; do not delete rows with existing assignment history.';

INSERT INTO public.production_operations (code, name, sort_order) VALUES
  ('CUT', 'Cutting',       10),
  ('FAB', 'Fabrication',   20),
  ('JOI', 'Joinery',       30),
  ('UPH', 'Upholstery',    40),
  ('SAN', 'Sanding',       50),
  ('FIN', 'Finishing',     60),
  ('ASM', 'Assembly',      70),
  ('GLS', 'Glass Fitting', 80),
  ('PKG', 'Packaging',     90),
  ('QC',  'Quality Control', 100)
ON CONFLICT (code) DO NOTHING;


-- ── 2. Production plans ───────────────────────────────────────────────────────
-- One plan per order (enforced by UNIQUE on order_id).
-- Completion requires every non-cancelled job to be Completed.
CREATE TABLE IF NOT EXISTS public.production_plans (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL UNIQUE REFERENCES public.orders(id),

  status           text        NOT NULL DEFAULT 'Draft'
                     CHECK (status IN ('Draft', 'Active', 'Paused', 'Completed', 'Cancelled')),
  notes            text,

  -- Required when status = 'Cancelled'
  cancelled_reason text,
  cancelled_at     timestamptz,
  cancelled_by     uuid        REFERENCES auth.users(id),

  -- Soft archive — not an operational status.
  -- Archived plans are hidden from daily views but never deleted.
  archived_at      timestamptz,
  archived_by      uuid        REFERENCES auth.users(id),

  created_by       uuid        REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_plans
  IS 'One production plan per order. Created by create_production_plan() which auto-imports order items as jobs.';
COMMENT ON COLUMN public.production_plans.status
  IS 'Draft | Active | Paused | Completed | Cancelled. Completed is manual and requires all non-cancelled jobs to be Completed.';
COMMENT ON COLUMN public.production_plans.archived_at
  IS 'Soft-archive metadata. Does not affect operational status. Archived plans are hidden from daily views but retain all history.';


-- ── 3. Production jobs ────────────────────────────────────────────────────────
-- One job per order item on initial plan creation.
-- Additional jobs can be created (splitting) as long as SUM(active planned_quantity)
-- ≤ order_item.quantity (enforced by create_production_job RPC).
CREATE TABLE IF NOT EXISTS public.production_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_num       text        NOT NULL UNIQUE,
  plan_id       uuid        NOT NULL REFERENCES public.production_plans(id),
  order_id      uuid        NOT NULL REFERENCES public.orders(id),
  order_item_id uuid        REFERENCES public.order_items(id),

  -- Snapshot of order_item fields at plan creation time.
  -- The FK (order_item_id) provides traceability; these fields are what production works from.
  category      text,
  description   text,
  size          text,
  finish_type   text,
  finish_color  text,
  wood_type     text,

  -- Workshop-only instructions not captured by the structured attributes above.
  production_instructions text,

  -- Planned quantity: set at job creation; cannot exceed available order_item quantity.
  -- Managed by create_production_job / update_production_job_quantity RPCs.
  planned_quantity  integer NOT NULL CHECK (planned_quantity > 0),

  -- ── Cached quantity buckets ──────────────────────────────────────────────
  -- Updated atomically by the progress RPC (Phase 1B) only.
  -- Application code must NEVER write these columns directly.
  in_production_qty integer NOT NULL DEFAULT 0 CHECK (in_production_qty >= 0),
  awaiting_qc_qty   integer NOT NULL DEFAULT 0 CHECK (awaiting_qc_qty   >= 0),
  rework_qty        integer NOT NULL DEFAULT 0 CHECK (rework_qty         >= 0),
  accepted_qty      integer NOT NULL DEFAULT 0 CHECK (accepted_qty       >= 0),
  scrapped_qty      integer NOT NULL DEFAULT 0 CHECK (scrapped_qty       >= 0),

  -- Active-quantity ceiling.
  -- scrapped_qty is intentionally excluded: scrapped units must be reproduced,
  -- so they do not consume planned capacity.
  CONSTRAINT active_qty_within_plan CHECK (
    accepted_qty + in_production_qty + awaiting_qc_qty + rework_qty <= planned_quantity
  ),
  CONSTRAINT accepted_within_plan CHECK (
    accepted_qty <= planned_quantity
  ),

  status        text        NOT NULL DEFAULT 'Planned'
                  CHECK (status IN (
                    'Planned',
                    'Awaiting Materials',
                    'Materials Ready',
                    'In Production',
                    'Quality Control',
                    'Completed',
                    'Paused',
                    'Cancelled'
                  )),

  -- Sort order within the plan / shop floor board
  priority      integer     NOT NULL DEFAULT 0,

  -- Scheduling (informational; no capacity engine in V1)
  planned_start  date,
  planned_finish date,
  actual_start   timestamptz,
  actual_finish  timestamptz,   -- set when status → Completed

  -- Pause / block
  blocker_reason text,

  -- Cancellation
  cancelled_at     timestamptz,
  cancelled_by     uuid        REFERENCES auth.users(id),
  cancelled_reason text,

  -- Auto-set by progress RPC when accepted_qty reaches planned_quantity
  completed_at  timestamptz,

  created_by    uuid        REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_jobs
  IS 'A unit of production work derived from an order item. Quantity constraints are enforced by transactional RPCs, not CHECK constraints (cross-row). Cached quantity buckets are written only by the progress RPC.';
COMMENT ON COLUMN public.production_jobs.in_production_qty
  IS 'Units started and currently being worked on. Source bucket for submit_to_qc transitions.';
COMMENT ON COLUMN public.production_jobs.awaiting_qc_qty
  IS 'Units submitted to QC awaiting a disposition (Accept / Rework / Scrap).';
COMMENT ON COLUMN public.production_jobs.rework_qty
  IS 'Units returned from QC for rework. Re-enter in_production_qty when rework_started.';
COMMENT ON COLUMN public.production_jobs.accepted_qty
  IS 'Units QC-accepted. When accepted_qty = planned_quantity the job auto-completes.';
COMMENT ON COLUMN public.production_jobs.scrapped_qty
  IS 'Units QC-scrapped. Excluded from active ceiling — scrap must be replaced by additional production.';


-- ── 4. Worker assignments ─────────────────────────────────────────────────────
-- Links employees to jobs for specific operations.
-- Does NOT store completed or rejected quantities — those live in progress entries (Phase 1B).
-- Replaced atomically via replace_job_assignments RPC.
CREATE TABLE IF NOT EXISTS public.production_job_assignments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid        NOT NULL REFERENCES public.production_jobs(id),
  employee_id       uuid        NOT NULL REFERENCES public.employees(id),
  operation_id      uuid        NOT NULL REFERENCES public.production_operations(id),

  -- Total quantity this worker is responsible for on this operation.
  -- SUM across active assignments must not exceed job.planned_quantity (enforced by RPC).
  assigned_quantity integer     NOT NULL CHECK (assigned_quantity > 0),

  planned_hours     numeric(8,2),
  notes             text,

  -- Lifecycle — transitions recorded here for timeline display
  status            text        NOT NULL DEFAULT 'Assigned'
                      CHECK (status IN ('Assigned', 'In Progress', 'Completed', 'Removed')),
  assigned_by       uuid        REFERENCES auth.users(id),
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_job_assignments
  IS 'Worker–operation assignments for a job. Replaced as a unit by replace_job_assignments(). No completed-quantity tracking here — that belongs to progress entries (Phase 1B).';


-- ── 5. Drawing links ──────────────────────────────────────────────────────────
-- Links production jobs to order drawings.
-- link_job_drawing() enforces that drawing.order_id = job.order_id.
CREATE TABLE IF NOT EXISTS public.production_job_drawings (
  job_id     uuid        NOT NULL REFERENCES public.production_jobs(id),
  drawing_id uuid        NOT NULL REFERENCES public.drawings(id),
  linked_by  uuid        REFERENCES auth.users(id),
  linked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, drawing_id)
);

COMMENT ON TABLE public.production_job_drawings
  IS 'Join table linking production jobs to order drawings. Same-order guard enforced by link_job_drawing() RPC.';


-- ── 6. Material estimates ─────────────────────────────────────────────────────
-- V1: planning only. No inventory, stock availability, or actual consumption.
-- estimated_quantity and estimated_total_cost are generated columns.
CREATE TABLE IF NOT EXISTS public.production_material_estimates (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES public.production_jobs(id),

  material_name text        NOT NULL,
  specification text,                    -- grade, dimensions, colour, etc.
  unit          text        NOT NULL,    -- sheet, metre, piece, kg, litre …

  -- Estimate inputs
  quantity_per_unit  numeric(12,4) NOT NULL DEFAULT 1
                       CHECK (quantity_per_unit > 0),
  planned_quantity   integer       NOT NULL CHECK (planned_quantity > 0),
  waste_percentage   numeric(5,2)  NOT NULL DEFAULT 0
                       CHECK (waste_percentage >= 0 AND waste_percentage < 100),

  -- Computed fields (GENERATED ALWAYS — never set directly)
  estimated_quantity numeric(12,4) GENERATED ALWAYS AS (
    ROUND(
      (quantity_per_unit * planned_quantity * (1 + waste_percentage / 100.0))::numeric,
      4
    )
  ) STORED,

  estimated_unit_cost  numeric(14,2),

  estimated_total_cost numeric(14,2) GENERATED ALWAYS AS (
    CASE WHEN estimated_unit_cost IS NOT NULL
    THEN ROUND(
           (quantity_per_unit * planned_quantity * (1 + waste_percentage / 100.0)
            * estimated_unit_cost)::numeric,
           2
         )
    ELSE NULL END
  ) STORED,

  preferred_supplier_id uuid REFERENCES public.suppliers(id),
  notes                 text,

  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_material_estimates
  IS 'Estimated material requirements per production job. V1 planning tool only — no inventory integration, stock levels, or actual consumption. Phase 2 will add the material catalogue and issue/return tracking.';
COMMENT ON COLUMN public.production_material_estimates.planned_quantity
  IS 'Defaults to job.planned_quantity at creation but can be set independently (e.g. bulk purchase quantities).';
COMMENT ON COLUMN public.production_material_estimates.estimated_quantity
  IS 'quantity_per_unit × planned_quantity × (1 + waste_pct / 100). Generated column — do not set directly.';
COMMENT ON COLUMN public.production_material_estimates.estimated_total_cost
  IS 'estimated_quantity × estimated_unit_cost. Generated column. NULL when unit cost is not yet known.';


-- ── 7. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_prod_plans_order_id
  ON public.production_plans (order_id);
CREATE INDEX IF NOT EXISTS idx_prod_plans_status
  ON public.production_plans (status) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_prod_jobs_plan_id
  ON public.production_jobs (plan_id);
CREATE INDEX IF NOT EXISTS idx_prod_jobs_order_id
  ON public.production_jobs (order_id);
CREATE INDEX IF NOT EXISTS idx_prod_jobs_order_item_id
  ON public.production_jobs (order_item_id);
CREATE INDEX IF NOT EXISTS idx_prod_jobs_status
  ON public.production_jobs (status) WHERE status != 'Cancelled';
CREATE INDEX IF NOT EXISTS idx_prod_jobs_planned_finish
  ON public.production_jobs (planned_finish) WHERE status NOT IN ('Completed', 'Cancelled');

CREATE INDEX IF NOT EXISTS idx_prod_assignments_job_id
  ON public.production_job_assignments (job_id);
CREATE INDEX IF NOT EXISTS idx_prod_assignments_employee_id
  ON public.production_job_assignments (employee_id);

CREATE INDEX IF NOT EXISTS idx_prod_drawings_job_id
  ON public.production_job_drawings (job_id);

CREATE INDEX IF NOT EXISTS idx_prod_materials_job_id
  ON public.production_material_estimates (job_id);


-- ── 8. RPC: create_production_plan ───────────────────────────────────────────
-- Creates a Draft plan for an order and imports its line items as Planned jobs.
-- Guards: order must exist, not suspended, no existing plan.
-- Each order_item becomes one job with planned_quantity = item.quantity.
CREATE OR REPLACE FUNCTION public.create_production_plan(
  p_order_id   uuid,
  p_notes      text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS uuid   -- returns new plan id
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

  -- Create the plan
  INSERT INTO public.production_plans (order_id, status, notes, created_by)
  VALUES (p_order_id, 'Draft', p_notes, p_created_by)
  RETURNING id INTO v_plan_id;

  -- Import each order item as a Planned job, snapshotting item fields
  FOR v_item IN
    SELECT id, category, description, size,
           finish_type, finish_color, wood_type, quantity
    FROM   public.order_items
    WHERE  order_id = p_order_id
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
  IS 'Creates a Draft production plan for an order, importing each order_item as a Planned job. Idempotency guard: raises if a plan already exists.';


-- ── 9. RPC: create_production_job ────────────────────────────────────────────
-- Creates an additional job within an existing plan (e.g. splitting by finish or batch).
-- Quantity guard: SUM(active planned_quantity for order_item) + new qty ≤ item.quantity.
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
RETURNS uuid   -- returns new job id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id      uuid;
  v_item_quantity integer;
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

  -- Lock the order_item row to prevent concurrent over-allocation
  SELECT quantity INTO v_item_quantity
  FROM   public.order_items
  WHERE  id = p_order_item_id
    AND  order_id = v_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item % not found on order %', p_order_item_id, v_order_id;
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
  IS 'Creates an additional production job within a plan. Locks the order_item row and validates that total active allocations do not exceed the ordered quantity.';


-- ── 10. RPC: update_production_job_quantity ───────────────────────────────────
-- Adjusts planned_quantity on an existing job.
-- Guards: new qty ≥ active bucket total; new qty ≤ available order_item capacity.
CREATE OR REPLACE FUNCTION public.update_production_job_quantity(
  p_job_id           uuid,
  p_planned_quantity integer,
  p_updated_by       uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job           RECORD;
  v_in_progress   integer;
  v_item_quantity integer;
  v_allocated     integer;
  v_available     integer;
BEGIN
  IF p_planned_quantity <= 0 THEN
    RAISE EXCEPTION 'planned_quantity must be greater than 0';
  END IF;

  -- Lock the job row
  SELECT * INTO v_job
  FROM   public.production_jobs
  WHERE  id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot modify planned_quantity on a cancelled job';
  END IF;

  IF v_job.status = 'Completed' THEN
    RAISE EXCEPTION 'Cannot modify planned_quantity on a completed job';
  END IF;

  -- New quantity cannot drop below units already active in progress buckets
  v_in_progress := v_job.accepted_qty + v_job.in_production_qty
                   + v_job.awaiting_qc_qty + v_job.rework_qty;
  IF p_planned_quantity < v_in_progress THEN
    RAISE EXCEPTION
      'New planned_quantity % is less than units already in progress (%) — reduce in-progress work first',
      p_planned_quantity, v_in_progress;
  END IF;

  -- Check cross-job capacity for the order item
  IF v_job.order_item_id IS NOT NULL THEN
    SELECT quantity INTO v_item_quantity
    FROM   public.order_items
    WHERE  id = v_job.order_item_id
    FOR UPDATE;

    SELECT COALESCE(SUM(planned_quantity), 0)
    INTO   v_allocated
    FROM   public.production_jobs
    WHERE  order_item_id = v_job.order_item_id
      AND  status        != 'Cancelled'
      AND  id            != p_job_id;   -- exclude this job

    v_available := v_item_quantity - v_allocated;

    IF p_planned_quantity > v_available THEN
      RAISE EXCEPTION
        'Cannot set planned_quantity to %: only % units available for this order item (ordered %, other jobs %)',
        p_planned_quantity, v_available, v_item_quantity, v_allocated;
    END IF;
  END IF;

  UPDATE public.production_jobs
  SET    planned_quantity = p_planned_quantity,
         updated_at       = now()
  WHERE  id = p_job_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.update_production_job_quantity(uuid, integer, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.update_production_job_quantity(uuid, integer, uuid) TO service_role;

COMMENT ON FUNCTION public.update_production_job_quantity(uuid, integer, uuid)
  IS 'Adjusts planned_quantity on a non-cancelled, non-completed job. Validates against active bucket total and sibling job allocations.';


-- ── 11. RPC: replace_job_assignments ─────────────────────────────────────────
-- Atomically replaces all assignments for a job.
-- p_assignments: JSON array of objects with keys:
--   employee_id       uuid    (required)
--   operation_id      uuid    (required)
--   assigned_quantity integer (required, > 0)
--   planned_hours     numeric (optional)
--   notes             text    (optional)
CREATE OR REPLACE FUNCTION public.replace_job_assignments(
  p_job_id      uuid,
  p_assignments jsonb,
  p_assigned_by uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job  RECORD;
  v_elem jsonb;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id is required';
  END IF;

  IF p_assignments IS NULL
     OR jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSON array';
  END IF;

  SELECT *
  INTO v_job
  FROM public.production_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  IF v_job.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot assign workers to a cancelled job';
  END IF;

  IF v_job.status = 'Completed' THEN
    RAISE EXCEPTION 'Cannot reassign workers on a completed job';
  END IF;

  -- Validate every submitted assignment.
  FOR v_elem IN
    SELECT value
    FROM jsonb_array_elements(p_assignments)
  LOOP
    IF NULLIF(btrim(v_elem->>'employee_id'), '') IS NULL THEN
      RAISE EXCEPTION
        'employee_id is required for every assignment';
    END IF;

    IF NULLIF(btrim(v_elem->>'operation_id'), '') IS NULL THEN
      RAISE EXCEPTION
        'operation_id is required for every assignment';
    END IF;

    IF NULLIF(btrim(v_elem->>'assigned_quantity'), '') IS NULL
       OR (v_elem->>'assigned_quantity')::integer <= 0 THEN
      RAISE EXCEPTION
        'assigned_quantity must be a positive integer for every assignment';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.employees
      WHERE id = (v_elem->>'employee_id')::uuid
        AND is_active = true
    ) THEN
      RAISE EXCEPTION
        'Employee % does not exist or is inactive',
        v_elem->>'employee_id';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.production_operations
      WHERE id = (v_elem->>'operation_id')::uuid
        AND is_active = true
    ) THEN
      RAISE EXCEPTION
        'Operation % does not exist or is inactive',
        v_elem->>'operation_id';
    END IF;
  END LOOP;

  -- Each production operation may cover the full job quantity.
  -- Only assignments within the same operation are added together.
  IF EXISTS (
    SELECT
      (value->>'operation_id')::uuid
    FROM jsonb_array_elements(p_assignments)
    GROUP BY (value->>'operation_id')::uuid
    HAVING SUM((value->>'assigned_quantity')::integer)
           > v_job.planned_quantity
  ) THEN
    RAISE EXCEPTION
      'One or more operations exceed the job planned quantity of %',
      v_job.planned_quantity;
  END IF;

  -- Hard-delete existing assignments (no completed-quantity history here;
  -- progress entries handle that)
  DELETE FROM public.production_job_assignments
  WHERE job_id = p_job_id;

  INSERT INTO public.production_job_assignments (
    job_id,
    employee_id,
    operation_id,
    assigned_quantity,
    planned_hours,
    notes,
    assigned_by
  )
  SELECT
    p_job_id,
    (value->>'employee_id')::uuid,
    (value->>'operation_id')::uuid,
    (value->>'assigned_quantity')::integer,
    NULLIF(btrim(value->>'planned_hours'), '')::numeric,
    NULLIF(btrim(value->>'notes'), ''),
    p_assigned_by
  FROM jsonb_array_elements(p_assignments);

  UPDATE public.production_jobs
  SET updated_at = now()
  WHERE id = p_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_job_assignments(uuid, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.replace_job_assignments(uuid, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.replace_job_assignments(uuid, jsonb, uuid)
  IS 'Atomically replaces all worker assignments on a job. Validates per-operation assigned_quantity ≤ planned_quantity. Hard-deletes prior assignments (no completed-quantity state to preserve at this layer).';


-- ── 12. RPC: link_job_drawing ─────────────────────────────────────────────────
-- Links a drawing to a production job.
-- Guards: drawing must belong to the same order as the job.
-- ON CONFLICT DO NOTHING makes repeated calls idempotent.
CREATE OR REPLACE FUNCTION public.link_job_drawing(
  p_job_id     uuid,
  p_drawing_id uuid,
  p_linked_by  uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_order_id     uuid;
  v_drawing_order_id uuid;
BEGIN
  SELECT order_id INTO v_job_order_id
  FROM   public.production_jobs
  WHERE  id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production job % not found', p_job_id;
  END IF;

  -- Exclude soft-deleted drawings
  SELECT order_id INTO v_drawing_order_id
  FROM   public.drawings
  WHERE  id = p_drawing_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Drawing % not found or has been deleted', p_drawing_id;
  END IF;

  IF v_job_order_id != v_drawing_order_id THEN
    RAISE EXCEPTION
      'Drawing % belongs to a different order and cannot be linked to job %',
      p_drawing_id, p_job_id;
  END IF;

  INSERT INTO public.production_job_drawings (job_id, drawing_id, linked_by)
  VALUES (p_job_id, p_drawing_id, p_linked_by)
  ON CONFLICT (job_id, drawing_id) DO NOTHING;
END;
$$;

REVOKE ALL     ON FUNCTION public.link_job_drawing(uuid, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.link_job_drawing(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.link_job_drawing(uuid, uuid, uuid)
  IS 'Links a drawing to a production job. Enforces same-order constraint. Idempotent — safe to call twice. Rejects soft-deleted drawings.';


COMMIT;
