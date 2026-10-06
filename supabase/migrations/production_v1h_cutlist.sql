-- production_v1h_cutlist.sql
--
-- 1. Add delivery_date to production_plans
-- 2. Create job_cut_list_items  — per-job cut list (manual entry)
-- 3. Create cut_list_templates + cut_list_template_items  — reusable at job-type level
--
-- Run after: production_v1g_boq_classification.sql

BEGIN;

-- ── 1. delivery_date on production_plans ──────────────────────────────────────
-- Populated from the order's delivery_date when the plan is created.
-- Production manager can update it as the schedule changes.
-- The existing `notes` column (added in v1 schema) is already present.

ALTER TABLE public.production_plans
  ADD COLUMN IF NOT EXISTS delivery_date date;

COMMENT ON COLUMN public.production_plans.delivery_date
  IS 'Target client delivery date. Pre-filled from the linked order but editable by the production manager as the schedule evolves.';

-- ── 2. job_cut_list_items ─────────────────────────────────────────────────────
-- Manual cut list for a production job.
-- Each row is one piece/component to be cut.
-- Not derived from BoQ — entered separately per job.

CREATE TABLE IF NOT EXISTS public.job_cut_list_items (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid        NOT NULL REFERENCES public.production_jobs(id) ON DELETE CASCADE,

  piece_name           text        NOT NULL CHECK (length(trim(piece_name)) > 0),
  width_cm             numeric(10,2),           -- e.g. 84.00 cm
  height_cm            numeric(10,2),           -- height or length depending on piece
  thickness_mm         numeric(6,2),            -- e.g. 18.00 mm (MDF thickness)
  quantity             integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  material_description text,                    -- e.g. "Pine moulding", "MDF 18mm"
  notes                text,

  sort_order           integer     NOT NULL DEFAULT 0,

  created_by           uuid        REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.job_cut_list_items
  IS 'Manual cut list for a production job. One row per physical piece to be cut. Printed on the daily work sheet for the cutting stage.';

CREATE INDEX IF NOT EXISTS idx_job_cut_list_items_job
  ON public.job_cut_list_items (job_id, sort_order);

ALTER TABLE public.job_cut_list_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.job_cut_list_items
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_cut_list_items
  TO service_role;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_job_cut_list_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_cut_list_items_updated ON public.job_cut_list_items;
CREATE TRIGGER trg_job_cut_list_items_updated
  BEFORE UPDATE ON public.job_cut_list_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_job_cut_list_item();

-- ── 3. cut_list_templates ─────────────────────────────────────────────────────
-- Reusable cut list templates at the job-type level.
-- e.g. "Circular Mirror 80cm" → always the same frame rail + backer board.
-- Applying a template copies its items to the job's cut list.

CREATE TABLE IF NOT EXISTS public.cut_list_templates (
  id          uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text  NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  is_active   boolean NOT NULL DEFAULT true,

  created_by  uuid  REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cut_list_templates
  IS 'Reusable cut list templates at job-type level. Applying one copies its items to a job cut list. Designed for repeatable product types.';

CREATE INDEX IF NOT EXISTS idx_cut_list_templates_active
  ON public.cut_list_templates (is_active, name);

ALTER TABLE public.cut_list_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cut_list_templates
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cut_list_templates
  TO service_role;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_cut_list_template()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_list_templates_updated ON public.cut_list_templates;
CREATE TRIGGER trg_cut_list_templates_updated
  BEFORE UPDATE ON public.cut_list_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_cut_list_template();

-- ── 4. cut_list_template_items ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cut_list_template_items (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid        NOT NULL REFERENCES public.cut_list_templates(id) ON DELETE CASCADE,

  piece_name           text        NOT NULL CHECK (length(trim(piece_name)) > 0),
  width_cm             numeric(10,2),
  height_cm            numeric(10,2),
  thickness_mm         numeric(6,2),
  quantity             integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  material_description text,
  notes                text,

  sort_order           integer     NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.cut_list_template_items
  IS 'Line items for a cut list template. Copied verbatim to job_cut_list_items when the template is applied to a job.';

CREATE INDEX IF NOT EXISTS idx_cut_list_template_items_template
  ON public.cut_list_template_items (template_id, sort_order);

ALTER TABLE public.cut_list_template_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cut_list_template_items
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cut_list_template_items
  TO service_role;

-- ── 5. RPC: apply_cut_list_template ──────────────────────────────────────────
-- Copies template items to a job's cut list.
-- Appends (does NOT clear existing items) so partial overrides work.
-- Returns count of items inserted.

CREATE OR REPLACE FUNCTION public.apply_cut_list_template(
  p_job_id      uuid,
  p_template_id uuid,
  p_applied_by  uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer;
  v_max_sort integer;
BEGIN
  -- Guard: job must exist
  IF NOT EXISTS (SELECT 1 FROM public.production_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'Production job % not found', p_job_id;
  END IF;

  -- Guard: template must exist and be active
  IF NOT EXISTS (
    SELECT 1 FROM public.cut_list_templates
    WHERE id = p_template_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Cut list template % not found or is inactive', p_template_id;
  END IF;

  -- Get current max sort_order so appended items follow existing ones
  SELECT COALESCE(MAX(sort_order), -1)
  INTO   v_max_sort
  FROM   public.job_cut_list_items
  WHERE  job_id = p_job_id;

  INSERT INTO public.job_cut_list_items
    (job_id, piece_name, width_cm, height_cm, thickness_mm,
     quantity, material_description, notes, sort_order, created_by)
  SELECT
    p_job_id,
    ti.piece_name,
    ti.width_cm,
    ti.height_cm,
    ti.thickness_mm,
    ti.quantity,
    ti.material_description,
    ti.notes,
    v_max_sort + 1 + ti.sort_order,
    p_applied_by
  FROM public.cut_list_template_items ti
  WHERE ti.template_id = p_template_id
  ORDER BY ti.sort_order;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_cut_list_template(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_cut_list_template(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.apply_cut_list_template(uuid, uuid, uuid)
  IS 'Copies all items from a cut list template into a job''s cut list, appended after any existing items. Returns the number of items inserted.';

-- ── 6. Backfill delivery_date from linked orders ──────────────────────────────
-- Seed the plan's delivery_date from the order's due_date.
--
-- NOTE: `orders` has NO delivery_date column — its date columns are `due_date`
-- (the customer-facing deadline) and `payment_due_date`. `due_date` is the
-- correct seed: it is what the Plans UI already displays as "Order due".
-- The production manager then edits production_plans.delivery_date
-- independently as the schedule moves, which is the whole point of holding a
-- separate column here rather than reading through to the order.
--
-- Safe to run on an empty production_plans table too.

UPDATE public.production_plans pp
SET    delivery_date = o.due_date
FROM   public.orders o
WHERE  o.id = pp.order_id
  AND  o.due_date IS NOT NULL
  AND  pp.delivery_date IS NULL;

COMMIT;
