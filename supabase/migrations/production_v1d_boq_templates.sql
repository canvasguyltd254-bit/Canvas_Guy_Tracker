-- ─────────────────────────────────────────────────────────────────────────────
-- Production V1D — Bill of Quantities (BoQ) Templates
--
-- Adds two tables that let managers create, edit, and delete reusable material
-- templates.  Each template maps to a job category (e.g. "Wall Decoration") and
-- holds the full list of standard material line items.
--
-- The four default templates mirror the hardcoded MATERIAL_TEMPLATES constant in
-- the UI so existing jobs keep working even before any DB templates are saved.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.production_boq_templates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  category    text        NOT NULL,   -- used to auto-match job.category
  description text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_boq_templates
  IS 'Reusable Bill of Quantities templates. Each template maps to a product category and holds a standard list of material line items.';

CREATE TABLE IF NOT EXISTS public.production_boq_template_items (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid        NOT NULL REFERENCES public.production_boq_templates(id) ON DELETE CASCADE,
  sort_order        integer     NOT NULL DEFAULT 0,
  material_name     text        NOT NULL,
  specification     text,
  unit              text        NOT NULL,
  quantity_per_unit numeric     NOT NULL CHECK (quantity_per_unit > 0),
  waste_percentage  numeric     NOT NULL DEFAULT 0 CHECK (waste_percentage >= 0 AND waste_percentage < 100),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_boq_template_items
  IS 'Line items for a BoQ template. Sort order is user-controlled.';

CREATE INDEX IF NOT EXISTS idx_boq_template_items_template
  ON public.production_boq_template_items (template_id, sort_order);

-- ── RLS and permissions ───────────────────────────────────────────────────────
-- Both tables sit in public but must only be accessed via the API server
-- (service_role key). Anon and authenticated (Supabase JS client) roles are
-- fully revoked so no client-side query can bypass the API layer.

ALTER TABLE public.production_boq_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_boq_template_items  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.production_boq_templates
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.production_boq_template_items
  FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.production_boq_templates
  TO service_role;
GRANT ALL ON TABLE public.production_boq_template_items
  TO service_role;

-- ── Unique active-category index ──────────────────────────────────────────────
-- Prevents two active templates from sharing the same category (case-insensitive,
-- whitespace-trimmed). Archived (is_active = false) templates are exempt so history
-- is preserved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_boq_templates_active_category
  ON public.production_boq_templates (lower(btrim(category)))
  WHERE is_active = true;

-- ── RPC: replace_boq_template_items ───────────────────────────────────────────
-- Atomically replaces ALL items for a template in a single transaction.
-- Passing an empty array clears the item list (valid during editing).
--
-- Permissions: callable only by service_role (our API server).
-- The JS route layer enforces admin / production_manager role before calling this.

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
  -- ── Input validation ────────────────────────────────────────────────────────
  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'p_template_id is required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array';
  END IF;

  -- ── Template must exist ─────────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM production_boq_templates WHERE id = p_template_id
  ) THEN
    RAISE EXCEPTION 'Template % not found', p_template_id;
  END IF;

  -- ── Validate each item ──────────────────────────────────────────────────────
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

  -- ── Atomic delete + insert ──────────────────────────────────────────────────
  DELETE FROM production_boq_template_items WHERE template_id = p_template_id;

  IF v_len > 0 THEN
    INSERT INTO production_boq_template_items
      (template_id, sort_order, material_name, specification,
       unit, quantity_per_unit, waste_percentage, notes)
    SELECT
      p_template_id,
      (t.ord - 1)::integer,
      btrim(t.val->>'material_name'),
      NULLIF(btrim(t.val->>'specification'), ''),
      btrim(t.val->>'unit'),
      (t.val->>'quantity_per_unit')::numeric,
      COALESCE((t.val->>'waste_percentage')::numeric, 0),
      NULLIF(btrim(t.val->>'notes'), '')
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(val, ord);

    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  -- Touch updated_at on the parent template
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

-- ── RPC: apply_boq_template_to_job ────────────────────────────────────────────
-- Atomically loads a BoQ template into a job's material estimates.
--
-- p_mode = 'replace': deletes all existing estimates first, then inserts.
-- p_mode = 'append':  adds template items on top of any existing estimates.
--
-- Returns the number of material lines inserted.
--
-- Permissions: callable only by service_role (our API server).
-- The JS route layer enforces admin / production_manager role before calling this.

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
  -- ── Input validation ────────────────────────────────────────────────────────
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

  -- ── Lock and fetch the job ──────────────────────────────────────────────────
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

  -- ── Verify template exists and is active ────────────────────────────────────
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

  -- ── Replace mode: remove existing estimates ─────────────────────────────────
  IF p_mode = 'replace' THEN
    DELETE FROM production_material_estimates WHERE job_id = p_job_id;
  END IF;

  -- ── Insert template items as material estimates ─────────────────────────────
  INSERT INTO production_material_estimates
    (job_id, material_name, specification, unit,
     quantity_per_unit, planned_quantity, waste_percentage,
     notes, created_by)
  SELECT
    p_job_id,
    i.material_name,
    i.specification,
    i.unit,
    i.quantity_per_unit,
    v_job.planned_quantity,
    i.waste_percentage,
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

-- ── Seed default templates (idempotent) ───────────────────────────────────────

DO $$
DECLARE
  v_id uuid;
BEGIN

  -- ── Wall Decoration ─────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.production_boq_templates WHERE category = 'Wall Decoration') THEN
    INSERT INTO public.production_boq_templates (name, category, description)
    VALUES ('Wall Decoration', 'Wall Decoration', 'Standard canvas print + frame BoQ')
    RETURNING id INTO v_id;

    INSERT INTO public.production_boq_template_items
      (template_id, sort_order, material_name, specification, unit, quantity_per_unit, waste_percentage)
    VALUES
      (v_id,  1, 'Canvas Sheet',                  'Standard primed, gesso-coated',         'sheet',    1,    5),
      (v_id,  2, 'Canvas Print Time',              'Large-format inkjet / sublimation',     'hours',    0.5,  0),
      (v_id,  3, 'Frame Moulding',                 'Pine, finger-jointed, primed',          'metre',    2.2, 15),
      (v_id,  4, 'Backing Board',                  '3mm MDF or foam board',                 'sheet',    1,    5),
      (v_id,  5, 'Hanging Hardware',               'D-ring + picture wire + screws',        'set',      1,    0),
      (v_id,  6, 'Corner Fixings',                 'V-nails or staples',                    'set',      1,    0),
      (v_id,  7, 'Gesso Primer',                   'Brush-on, water-based',                 'litre',    0.15,10),
      (v_id,  8, 'Varnish / Sealant',              'UV-protective clear coat',              'litre',    0.1, 10),
      (v_id,  9, 'Sanding Paper 120-grit',         'Aluminium oxide sheet',                 'sheet',    1,    0),
      (v_id, 10, 'Sanding Paper 220-grit',         'Fine finish sheet',                     'sheet',    1,    0),
      (v_id, 11, 'Machine Time — Frame Saw',        'Cross-cut / mitre saw',                'hours',    0.25, 0),
      (v_id, 12, 'Machine Time — Pneumatic Nailer', 'Frame assembly',                       'hours',    0.15, 0),
      (v_id, 13, 'Packaging — Bubble Wrap',         'Anti-scratch wrap',                    'metre',    0.5,  5),
      (v_id, 14, 'Packaging — Cardboard Corner',    'Protective corner guards',             'set',      1,    0);
  END IF;

  -- ── Custom Frame ────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.production_boq_templates WHERE category = 'Custom Frame') THEN
    INSERT INTO public.production_boq_templates (name, category, description)
    VALUES ('Custom Frame', 'Custom Frame', 'Picture frame production BoQ')
    RETURNING id INTO v_id;

    INSERT INTO public.production_boq_template_items
      (template_id, sort_order, material_name, specification, unit, quantity_per_unit, waste_percentage)
    VALUES
      (v_id,  1, 'Frame Moulding',                    'Hardwood or pine — specify profile',  'metre',    2.5, 15),
      (v_id,  2, 'Acrylic Glazing',                   '2mm clear or non-reflective',          'sheet',    1,    5),
      (v_id,  3, 'MDF Backing',                       '3mm MDF board',                        'sheet',    1,    5),
      (v_id,  4, 'V-nails / Corner Fixings',          'Frame underpinner consumables',        'set',      1,    0),
      (v_id,  5, 'Hanging Hardware',                  'D-ring + wire + screws',               'set',      1,    0),
      (v_id,  6, 'Frame Finish / Stain',              'Spray or brush — specify colour',      'litre',    0.1, 10),
      (v_id,  7, 'Top Coat Lacquer',                  'Clear satin or gloss',                 'litre',    0.08,10),
      (v_id,  8, 'Sanding Paper 120-grit',            'Aluminium oxide',                      'sheet',    1,    0),
      (v_id,  9, 'Sanding Paper 220-grit',            'Fine finish',                          'sheet',    1,    0),
      (v_id, 10, 'Machine Time — Mitre Saw',           'Cutting moulding to length',          'hours',    0.3,  0),
      (v_id, 11, 'Machine Time — Frame Underpinner',   'Joining corners',                     'hours',    0.2,  0),
      (v_id, 12, 'Machine Time — Orbital Sander',      'Surface prep',                        'hours',    0.25, 0),
      (v_id, 13, 'Packaging — Bubble Wrap',            'Anti-scratch wrap',                   'metre',    0.4,  5),
      (v_id, 14, 'Packaging — Cardboard Corner',       'Protective corner guards',            'set',      1,    0);
  END IF;

  -- ── Furniture ───────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.production_boq_templates WHERE category = 'Furniture') THEN
    INSERT INTO public.production_boq_templates (name, category, description)
    VALUES ('Furniture', 'Furniture', 'Solid wood / MDF furniture production BoQ')
    RETURNING id INTO v_id;

    INSERT INTO public.production_boq_template_items
      (template_id, sort_order, material_name, specification, unit, quantity_per_unit, waste_percentage)
    VALUES
      (v_id,  1, 'Pine Timber (rough)',              '110×50mm or specify section',            'board-ft', 8,    15),
      (v_id,  2, 'MDF Panel 18mm',                  '2440×1220 standard sheet',               'sheet',    1,    10),
      (v_id,  3, 'MDF Panel 12mm',                  '2440×1220 standard sheet',               'sheet',    0.5,  10),
      (v_id,  4, 'Wood Screws 35mm',                'Countersunk self-tapping',               'packet',   0.5,   0),
      (v_id,  5, 'Wood Screws 50mm',                'Countersunk self-tapping',               'packet',   0.25,  0),
      (v_id,  6, 'Wood Glue',                       'PVA, interior grade',                    'litre',    0.3,   5),
      (v_id,  7, 'Wood Filler',                     'Solvent-based, sandable',                'tube',     0.25,  0),
      (v_id,  8, 'Edge Banding',                    'Iron-on PVC, 22mm or match MDF',         'metre',    2,    10),
      (v_id,  9, 'Sanding Paper 80-grit',           'Material removal / rough shaping',       'sheet',    2,     0),
      (v_id, 10, 'Sanding Paper 120-grit',          'Intermediate shaping',                   'sheet',    3,     0),
      (v_id, 11, 'Sanding Paper 220-grit',          'Pre-finish surface prep',                'sheet',    2,     0),
      (v_id, 12, 'Wood Stain',                      'Oil or water-based — specify tone',      'litre',    0.4,  10),
      (v_id, 13, 'Top Coat Varnish',                'Polyurethane satin or gloss',            'litre',    0.25, 10),
      (v_id, 14, 'Machine Time — Table Saw',         'Ripping & cross-cutting',               'hours',    1,     0),
      (v_id, 15, 'Machine Time — Planer/Thicknesser','Dimensioning rough timber',             'hours',    0.5,   0),
      (v_id, 16, 'Machine Time — Router',            'Joinery, profiling, rebates',           'hours',    0.5,   0),
      (v_id, 17, 'Machine Time — Orbital Sander',    'Surface sanding all stages',            'hours',    0.75,  0),
      (v_id, 18, 'Machine Time — Drill Press',       'Dowel holes / hardware fixing',         'hours',    0.25,  0),
      (v_id, 19, 'Packaging — Moving Blanket',       'Protective wrap for transit',           'piece',    1,     0),
      (v_id, 20, 'Packaging — Stretch Wrap',         'Pallet / crate wrap',                  'metre',    3,     5);
  END IF;

  -- ── Skirting ────────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.production_boq_templates WHERE category = 'Skirting') THEN
    INSERT INTO public.production_boq_templates (name, category, description)
    VALUES ('Skirting', 'Skirting', 'Skirting board supply & install BoQ')
    RETURNING id INTO v_id;

    INSERT INTO public.production_boq_template_items
      (template_id, sort_order, material_name, specification, unit, quantity_per_unit, waste_percentage)
    VALUES
      (v_id,  1, 'Skirting Profile',            'Pine, primed — specify height & profile',  'metre',    1.05, 5),
      (v_id,  2, 'Wood Filler',                 'Fine surface filler, sandable',             'tube',     0.05, 0),
      (v_id,  3, 'Finishing Nails 40mm',        'Lost-head, galvanised',                     'packet',   0.1,  0),
      (v_id,  4, 'Caulk / Sealant',             'Flexible paintable sealant',               'tube',     0.1,  0),
      (v_id,  5, 'Primer Coat',                 'Water-based timber primer',                 'litre',    0.06,10),
      (v_id,  6, 'Top Coat Paint',              'Satinwood — specify colour',               'litre',    0.05,10),
      (v_id,  7, 'Sanding Paper 120-grit',      'Between coats',                            'sheet',    0.5,  0),
      (v_id,  8, 'Sanding Paper 220-grit',      'Final de-nibbing',                         'sheet',    0.25, 0),
      (v_id,  9, 'Machine Time — Mitre Saw',    'Cutting lengths and returns',              'hours',    0.1,  0),
      (v_id, 10, 'Packaging — Cardboard Tube',  'Protective sleeve for long lengths',       'piece',    1,    0);
  END IF;

END;
$$;

COMMIT;
