-- ============================================================================
-- Canvas Guy Tracker — Production v2a: stage-level worker assignments
--
-- 1. Operations: add the Material prep / Sanding / Finishing / Packaging
--    operations from the approved workflow and RETIRE the old "Cutting"
--    operation (hidden from pickers; history is kept — it is never re-pointed).
--    Old generic "Finishing", "Packaging" and "Quality Control" operations are
--    left untouched pending a decision.
-- 2. production_job_assignments gains: stage_id, assignment_mode,
--    planned_start_date, planned_end_date, planned_hours_per_day.
--    Legacy rows are back-filled (stage from the operation's stage_key,
--    mode = split_quantity, which matches the old "sum <= planned" rule).
-- 3. assign_workers_to_stage(): one atomic, validating RPC. The operation MUST
--    belong to the stage (enforced here, not just in the UI).
--
-- Capacity (8 h/day, Mon-Sat) is advisory: it is evaluated by the API/helper
-- and returned as warnings, never silently blocking and never stored.
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- ── 1. Operations ───────────────────────────────────────────────────────────
ALTER TABLE public.production_operations
  DROP CONSTRAINT IF EXISTS production_operations_stage_key_check;
ALTER TABLE public.production_operations
  ADD  CONSTRAINT production_operations_stage_key_check
  CHECK (stage_key IS NULL OR stage_key IN ('materials','assembly','sanding','finishing','packaging'));

INSERT INTO public.production_operations (code, name, sort_order, stage_key, is_active) VALUES
  ('MPK', 'Material picking',     5,  'materials', true),
  ('CLP', 'Cut-list preparation', 6,  'materials', true),
  ('CNC', 'CNC cutting',          7,  'materials', true),
  ('SIN', 'Surface inspection',   55, 'sanding',   true),
  ('OCT', 'One coat',             61, 'finishing', true),
  ('PU',  'PU',                   62, 'finishing', true),
  ('NC',  'NC',                   63, 'finishing', true),
  ('CUS', 'Custom finish',        64, 'finishing', true),
  ('WRP', 'Wrapping',             91, 'packaging', true),
  ('CRN', 'Corner protection',    92, 'packaging', true),
  ('BOX', 'Boxing',               93, 'packaging', true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, stage_key = EXCLUDED.stage_key, is_active = true;

-- Retire (never delete / re-point) the old Cutting operation.
UPDATE public.production_operations SET is_active = false WHERE code = 'CUT';

-- ── 2. Assignment columns ──────────────────────────────────────────────────
ALTER TABLE public.production_job_assignments
  ADD COLUMN IF NOT EXISTS stage_id              uuid REFERENCES public.production_job_stages(id),
  ADD COLUMN IF NOT EXISTS assignment_mode       text,
  ADD COLUMN IF NOT EXISTS planned_start_date    date,
  ADD COLUMN IF NOT EXISTS planned_end_date      date,
  ADD COLUMN IF NOT EXISTS planned_hours_per_day numeric(4,2);

-- Back-fill legacy rows. Operations without a stage_key (e.g. QC) stay NULL.
UPDATE public.production_job_assignments a
SET    stage_id = s.id
FROM   public.production_operations o,
       public.production_job_stages s
WHERE  a.stage_id IS NULL
  AND  o.id = a.operation_id
  AND  s.job_id = a.job_id
  AND  s.stage_key = o.stage_key;

UPDATE public.production_job_assignments
SET    assignment_mode = 'split_quantity'
WHERE  assignment_mode IS NULL;

-- DEFAULT keeps the legacy replace_job_assignments() working until the UI no
-- longer calls it; new code always passes the mode explicitly.
ALTER TABLE public.production_job_assignments
  ALTER COLUMN assignment_mode SET DEFAULT 'split_quantity',
  ALTER COLUMN assignment_mode SET NOT NULL;

ALTER TABLE public.production_job_assignments
  DROP CONSTRAINT IF EXISTS production_job_assignments_mode_check;
ALTER TABLE public.production_job_assignments
  ADD  CONSTRAINT production_job_assignments_mode_check
  CHECK (assignment_mode IN ('working_together','split_quantity'));

ALTER TABLE public.production_job_assignments
  DROP CONSTRAINT IF EXISTS production_job_assignments_dates_check;
ALTER TABLE public.production_job_assignments
  ADD  CONSTRAINT production_job_assignments_dates_check
  CHECK (
    (planned_start_date IS NULL AND planned_end_date IS NULL)
    OR (planned_start_date IS NOT NULL AND planned_end_date IS NOT NULL
        AND planned_end_date >= planned_start_date)
  );

ALTER TABLE public.production_job_assignments
  DROP CONSTRAINT IF EXISTS production_job_assignments_hpd_check;
ALTER TABLE public.production_job_assignments
  ADD  CONSTRAINT production_job_assignments_hpd_check
  CHECK (planned_hours_per_day IS NULL OR (planned_hours_per_day > 0 AND planned_hours_per_day <= 12));

CREATE INDEX IF NOT EXISTS idx_pja_stage    ON public.production_job_assignments (stage_id);
CREATE INDEX IF NOT EXISTS idx_pja_emp_dates
  ON public.production_job_assignments (employee_id, planned_start_date, planned_end_date)
  WHERE status <> 'Removed';

COMMENT ON COLUMN public.production_job_assignments.assignment_mode IS
  'working_together: every worker works on the same assigned quantity. split_quantity: worker quantities share the operation quantity (sum <= planned).';
COMMENT ON COLUMN public.production_job_assignments.planned_hours_per_day IS
  'Planned hours per working day (Mon-Sat). Used only for the advisory 8 h/day capacity check.';

-- ── 3. assign_workers_to_stage ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assign_workers_to_stage(
  p_job_id        uuid,
  p_stage_id      uuid,
  p_operation_id  uuid,
  p_mode          text,
  p_workers       jsonb,        -- [{ "employee_id": uuid, "assigned_quantity": int }, ...]
  p_start         date,
  p_end           date,
  p_hours_per_day numeric,
  p_assigned_by   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job      record;
  v_stage    record;
  v_elem     jsonb;
  v_emp      uuid;
  v_qty      integer;
  v_first    integer;
  v_sum      integer := 0;
  v_existing integer;
  v_ids      uuid[] := '{}';
  v_new_id   uuid;
  v_seen     uuid[] := '{}';
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('working_together','split_quantity') THEN
    RAISE EXCEPTION 'assignment_mode must be working_together or split_quantity';
  END IF;
  IF p_workers IS NULL OR jsonb_typeof(p_workers) <> 'array' OR jsonb_array_length(p_workers) = 0 THEN
    RAISE EXCEPTION 'Select at least one worker';
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Planned start and end dates are required and the end cannot be before the start';
  END IF;
  IF p_hours_per_day IS NULL OR p_hours_per_day <= 0 OR p_hours_per_day > 12 THEN
    RAISE EXCEPTION 'Hours per day must be between 0 and 12';
  END IF;

  SELECT * INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  IF v_job.status IN ('Cancelled','Completed') THEN
    RAISE EXCEPTION 'Cannot assign workers on a % job', lower(v_job.status);
  END IF;

  SELECT * INTO v_stage FROM production_job_stages WHERE id = p_stage_id AND job_id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage does not belong to this job'; END IF;
  IF NOT v_stage.is_enabled THEN RAISE EXCEPTION 'Stage "%" is disabled for this job', v_stage.stage_label; END IF;

  -- The operation MUST belong to the selected stage (and be active).
  IF NOT EXISTS (
    SELECT 1 FROM production_operations
    WHERE id = p_operation_id AND is_active = true AND stage_key = v_stage.stage_key
  ) THEN
    RAISE EXCEPTION 'That operation does not belong to the % stage (or is inactive)', v_stage.stage_label;
  END IF;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(p_workers) LOOP
    IF NULLIF(btrim(v_elem->>'employee_id'), '') IS NULL THEN RAISE EXCEPTION 'employee_id is required for every worker'; END IF;
    v_emp := (v_elem->>'employee_id')::uuid;
    IF v_emp = ANY (v_seen) THEN RAISE EXCEPTION 'The same worker was selected twice'; END IF;
    v_seen := v_seen || v_emp;

    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_emp AND is_active = true) THEN
      RAISE EXCEPTION 'Employee % does not exist or is inactive', v_emp;
    END IF;

    IF NULLIF(btrim(v_elem->>'assigned_quantity'), '') IS NULL
       OR (v_elem->>'assigned_quantity')::integer <= 0 THEN
      RAISE EXCEPTION 'Every worker needs an assigned quantity above 0';
    END IF;
    v_qty := (v_elem->>'assigned_quantity')::integer;
    IF v_qty > v_job.planned_quantity THEN
      RAISE EXCEPTION 'A worker''s quantity (%) cannot exceed the job quantity (%)', v_qty, v_job.planned_quantity;
    END IF;

    IF v_first IS NULL THEN v_first := v_qty; END IF;
    IF p_mode = 'working_together' AND v_qty <> v_first THEN
      RAISE EXCEPTION 'Working together: every worker must have the same quantity';
    END IF;
    v_sum := v_sum + v_qty;

    IF EXISTS (
      SELECT 1 FROM production_job_assignments
      WHERE job_id = p_job_id AND stage_id = p_stage_id AND operation_id = p_operation_id
        AND employee_id = v_emp AND status <> 'Removed'
    ) THEN
      RAISE EXCEPTION 'That worker is already assigned to this operation on this stage';
    END IF;
  END LOOP;

  IF p_mode = 'split_quantity' THEN
    SELECT COALESCE(SUM(assigned_quantity), 0) INTO v_existing
    FROM production_job_assignments
    WHERE job_id = p_job_id AND stage_id = p_stage_id AND operation_id = p_operation_id
      AND status <> 'Removed' AND assignment_mode = 'split_quantity';
    IF v_sum + v_existing > v_job.planned_quantity THEN
      RAISE EXCEPTION 'Split quantities add up to % (including % already assigned) — more than the % planned',
        v_sum + v_existing, v_existing, v_job.planned_quantity;
    END IF;
  END IF;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(p_workers) LOOP
    INSERT INTO production_job_assignments
      (job_id, stage_id, operation_id, employee_id, assigned_quantity, assignment_mode,
       planned_start_date, planned_end_date, planned_hours_per_day, assigned_by)
    VALUES
      (p_job_id, p_stage_id, p_operation_id, (v_elem->>'employee_id')::uuid,
       (v_elem->>'assigned_quantity')::integer, p_mode,
       p_start, p_end, p_hours_per_day, p_assigned_by)
    RETURNING id INTO v_new_id;
    v_ids := v_ids || v_new_id;
  END LOOP;

  RETURN jsonb_build_object('assignment_ids', to_jsonb(v_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.assign_workers_to_stage(uuid,uuid,uuid,text,jsonb,date,date,numeric,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_workers_to_stage(uuid,uuid,uuid,text,jsonb,date,date,numeric,uuid) TO service_role;

COMMIT;
