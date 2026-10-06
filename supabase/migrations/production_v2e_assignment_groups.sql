-- ============================================================================
-- Canvas Guy Tracker — Production v2e: assignment GROUPS
--
-- (job, stage, operation) is ONE assignment group with ONE mode. Saving a group
-- replaces its whole membership atomically:
--   * workers in the list are created or updated (quantity, dates, hours, mode)
--   * active workers NOT in the list are marked status = 'Removed'
--     (never deleted — history is kept) with removed_at / removed_by
--   * an empty list removes the whole group
-- Validation covers the WHOLE group, not just the current request:
--   working_together — every worker has the same quantity (<= job quantity)
--   split_quantity   — the quantities add up to at most the job quantity
-- Start / end dates must be working days (no Sunday). Whether the dates sit
-- inside the stage's own schedule is advisory and returned, not enforced.
--
-- production_assignment_events records created / updated / removed with the old
-- and new values.
--
-- apply_stage_schedules() gains an optional list of assignment date changes so
-- that, when a stage is rescheduled, the manager can choose to move the workers'
-- dates with it. Never done silently: the API asks first.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.production_job_assignments
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid;

CREATE TABLE IF NOT EXISTS public.production_assignment_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid        NOT NULL REFERENCES public.production_job_assignments(id) ON DELETE CASCADE,
  job_id        uuid        NOT NULL,
  event         text        NOT NULL CHECK (event IN ('created','updated','removed')),
  old_values    jsonb,
  new_values    jsonb,
  actor         uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pae_assignment ON public.production_assignment_events (assignment_id);
CREATE INDEX IF NOT EXISTS idx_pae_job        ON public.production_assignment_events (job_id);
ALTER TABLE public.production_assignment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.production_assignment_events FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.production_assignment_events TO service_role;

-- ── assign_workers_to_stage: save one assignment group ─────────────────────
CREATE OR REPLACE FUNCTION public.assign_workers_to_stage(
  p_job_id        uuid,
  p_stage_id      uuid,
  p_operation_id  uuid,
  p_mode          text,
  p_workers       jsonb,        -- [{ "employee_id": uuid, "assigned_quantity": int }, ...]  ([] removes the group)
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
  v_sched    record;
  v_elem     jsonb;
  v_emp      uuid;
  v_qty      integer;
  v_first    integer;
  v_sum      integer := 0;
  v_seen     uuid[]  := '{}';
  v_ids      uuid[]  := '{}';
  v_removed  uuid[]  := '{}';
  v_row      record;
  v_new_id   uuid;
  v_exists   boolean;
  v_old      jsonb;
  v_n        integer;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('working_together','split_quantity') THEN
    RAISE EXCEPTION 'assignment_mode must be working_together or split_quantity';
  END IF;
  IF p_workers IS NULL OR jsonb_typeof(p_workers) <> 'array' THEN
    RAISE EXCEPTION 'workers must be a list';
  END IF;
  v_n := jsonb_array_length(p_workers);

  SELECT * INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  IF v_job.status IN ('Cancelled','Completed') THEN
    RAISE EXCEPTION 'Cannot assign workers on a % job', lower(v_job.status);
  END IF;

  SELECT * INTO v_stage FROM production_job_stages WHERE id = p_stage_id AND job_id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage does not belong to this job'; END IF;
  IF NOT v_stage.is_enabled THEN RAISE EXCEPTION 'Stage "%" is disabled for this job', v_stage.stage_label; END IF;

  -- Operation must belong to the stage. An inactive (retired) operation may still be
  -- edited/removed, but not newly assigned to.
  IF NOT EXISTS (SELECT 1 FROM production_operations WHERE id = p_operation_id AND stage_key = v_stage.stage_key) THEN
    RAISE EXCEPTION 'That operation does not belong to the % stage', v_stage.stage_label;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM production_job_assignments
     WHERE job_id = p_job_id AND stage_id = p_stage_id AND operation_id = p_operation_id
       AND status IN ('Assigned','In Progress')
  ) INTO v_exists;

  IF v_n = 0 AND NOT v_exists THEN
    RAISE EXCEPTION 'There is no assignment on this operation to remove';
  END IF;

  IF v_n > 0 THEN
    IF NOT EXISTS (SELECT 1 FROM production_operations WHERE id = p_operation_id AND is_active = true) AND NOT v_exists THEN
      RAISE EXCEPTION 'That operation is no longer active';
    END IF;
    IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
      RAISE EXCEPTION 'Planned start and end dates are required and the end cannot be before the start';
    END IF;
    IF EXTRACT(DOW FROM p_start) = 0 OR EXTRACT(DOW FROM p_end) = 0 THEN
      RAISE EXCEPTION 'Assignment dates cannot fall on a Sunday';
    END IF;
    IF p_hours_per_day IS NULL OR p_hours_per_day <= 0 OR p_hours_per_day > 12 THEN
      RAISE EXCEPTION 'Hours per day must be between 0 and 12';
    END IF;

    -- Validate the WHOLE desired group.
    FOR v_elem IN SELECT value FROM jsonb_array_elements(p_workers) LOOP
      IF NULLIF(btrim(v_elem->>'employee_id'), '') IS NULL THEN RAISE EXCEPTION 'employee_id is required for every worker'; END IF;
      v_emp := (v_elem->>'employee_id')::uuid;
      IF v_emp = ANY (v_seen) THEN RAISE EXCEPTION 'The same worker was selected twice'; END IF;
      v_seen := v_seen || v_emp;
      IF NOT EXISTS (SELECT 1 FROM employees WHERE id = v_emp AND is_active = true) THEN
        RAISE EXCEPTION 'Employee % does not exist or is inactive', v_emp;
      END IF;
      IF NULLIF(btrim(v_elem->>'assigned_quantity'), '') IS NULL OR (v_elem->>'assigned_quantity')::integer <= 0 THEN
        RAISE EXCEPTION 'Every worker needs an assigned quantity above 0';
      END IF;
      v_qty := (v_elem->>'assigned_quantity')::integer;
      IF v_qty > v_job.planned_quantity THEN
        RAISE EXCEPTION 'A worker''s quantity (%) cannot exceed the job quantity (%)', v_qty, v_job.planned_quantity;
      END IF;
      IF v_first IS NULL THEN v_first := v_qty; END IF;
      IF p_mode = 'working_together' AND v_qty <> v_first THEN
        RAISE EXCEPTION 'Working together: every worker in the group must have the same quantity';
      END IF;
      v_sum := v_sum + v_qty;
    END LOOP;
    IF p_mode = 'split_quantity' AND v_sum > v_job.planned_quantity THEN
      RAISE EXCEPTION 'Split quantities add up to % — more than the % planned for this job', v_sum, v_job.planned_quantity;
    END IF;

    -- Upsert the listed workers.
    FOR v_elem IN SELECT value FROM jsonb_array_elements(p_workers) LOOP
      v_emp := (v_elem->>'employee_id')::uuid;
      v_qty := (v_elem->>'assigned_quantity')::integer;
      SELECT * INTO v_row FROM production_job_assignments
       WHERE job_id = p_job_id AND stage_id = p_stage_id AND operation_id = p_operation_id
         AND employee_id = v_emp AND status IN ('Assigned','In Progress')
       FOR UPDATE;
      IF FOUND THEN
        v_old := jsonb_build_object('assigned_quantity', v_row.assigned_quantity, 'assignment_mode', v_row.assignment_mode,
                   'planned_start_date', v_row.planned_start_date, 'planned_end_date', v_row.planned_end_date,
                   'planned_hours_per_day', v_row.planned_hours_per_day);
        UPDATE production_job_assignments
           SET assigned_quantity = v_qty, assignment_mode = p_mode,
               planned_start_date = p_start, planned_end_date = p_end,
               planned_hours_per_day = p_hours_per_day, updated_at = now()
         WHERE id = v_row.id;
        IF v_old IS DISTINCT FROM jsonb_build_object('assigned_quantity', v_qty, 'assignment_mode', p_mode,
             'planned_start_date', p_start, 'planned_end_date', p_end, 'planned_hours_per_day', p_hours_per_day) THEN
          INSERT INTO production_assignment_events (assignment_id, job_id, event, old_values, new_values, actor)
          VALUES (v_row.id, p_job_id, 'updated', v_old,
                  jsonb_build_object('assigned_quantity', v_qty, 'assignment_mode', p_mode, 'planned_start_date', p_start,
                                     'planned_end_date', p_end, 'planned_hours_per_day', p_hours_per_day), p_assigned_by);
        END IF;
        v_ids := v_ids || v_row.id;
      ELSE
        INSERT INTO production_job_assignments
          (job_id, employee_id, operation_id, assigned_quantity, assigned_by, status,
           stage_id, assignment_mode, planned_start_date, planned_end_date, planned_hours_per_day)
        VALUES (p_job_id, v_emp, p_operation_id, v_qty, p_assigned_by, 'Assigned',
                p_stage_id, p_mode, p_start, p_end, p_hours_per_day)
        RETURNING id INTO v_new_id;
        INSERT INTO production_assignment_events (assignment_id, job_id, event, new_values, actor)
        VALUES (v_new_id, p_job_id, 'created',
                jsonb_build_object('employee_id', v_emp, 'assigned_quantity', v_qty, 'assignment_mode', p_mode,
                                   'planned_start_date', p_start, 'planned_end_date', p_end, 'planned_hours_per_day', p_hours_per_day),
                p_assigned_by);
        v_ids := v_ids || v_new_id;
      END IF;
    END LOOP;
  END IF;

  -- Mark every other active member of the group Removed (history kept).
  FOR v_row IN
    SELECT * FROM production_job_assignments
     WHERE job_id = p_job_id AND stage_id = p_stage_id AND operation_id = p_operation_id
       AND status IN ('Assigned','In Progress') AND NOT (id = ANY (v_ids))
     FOR UPDATE
  LOOP
    UPDATE production_job_assignments
       SET status = 'Removed', removed_at = now(), removed_by = p_assigned_by, updated_at = now()
     WHERE id = v_row.id;
    INSERT INTO production_assignment_events (assignment_id, job_id, event, old_values, actor)
    VALUES (v_row.id, p_job_id, 'removed',
            jsonb_build_object('employee_id', v_row.employee_id, 'assigned_quantity', v_row.assigned_quantity,
                               'assignment_mode', v_row.assignment_mode, 'planned_start_date', v_row.planned_start_date,
                               'planned_end_date', v_row.planned_end_date), p_assigned_by);
    v_removed := v_removed || v_row.id;
  END LOOP;

  SELECT planned_start_date, planned_end_date INTO v_sched
    FROM production_job_stage_schedules WHERE job_stage_id = p_stage_id;

  RETURN jsonb_build_object(
    'assignment_ids', to_jsonb(v_ids),
    'removed_ids', to_jsonb(v_removed),
    'stage_scheduled', v_sched.planned_start_date IS NOT NULL,
    'stage_start', v_sched.planned_start_date,
    'stage_end', v_sched.planned_end_date,
    'outside_stage_schedule', CASE
        WHEN v_n = 0 OR v_sched.planned_start_date IS NULL THEN false
        ELSE (p_start < v_sched.planned_start_date OR p_end > v_sched.planned_end_date) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assign_workers_to_stage(uuid, uuid, uuid, text, jsonb, date, date, numeric, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_workers_to_stage(uuid, uuid, uuid, text, jsonb, date, date, numeric, uuid) TO service_role;

-- ── apply_stage_schedules: optional assignment date changes ────────────────
DROP FUNCTION IF EXISTS public.apply_stage_schedules(uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.apply_stage_schedules(
  p_job_id             uuid,
  p_changes            jsonb,
  p_actor              uuid  DEFAULT NULL,
  p_assignment_changes jsonb DEFAULT NULL    -- [{ "assignment_id": uuid, "start": date, "end": date }]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job     record;
  v_item    jsonb;
  v_stage   record;
  v_a       record;
  v_start   date;
  v_end     date;
  v_seen    uuid[] := ARRAY[]::uuid[];
  v_applied int := 0;
  v_moved   int := 0;
  v_min     date;
  v_max     date;
  v_old     jsonb;
BEGIN
  SELECT id, status INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.status IN ('Completed','Cancelled') THEN
    RAISE EXCEPTION 'Job is % and cannot be rescheduled', v_job.status USING ERRCODE = 'P0001';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'No schedule changes supplied' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    BEGIN
      v_start := (v_item->>'start')::date;
      v_end   := (v_item->>'end')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid date in schedule change' USING ERRCODE = 'P0001';
    END;
    IF v_start IS NULL OR v_end IS NULL OR v_end < v_start THEN
      RAISE EXCEPTION 'Stage end date must be on or after its start date' USING ERRCODE = 'P0001';
    END IF;
    IF EXTRACT(DOW FROM v_start) = 0 OR EXTRACT(DOW FROM v_end) = 0 THEN
      RAISE EXCEPTION 'Stage dates cannot fall on a Sunday' USING ERRCODE = 'P0001';
    END IF;

    SELECT id, job_id, is_enabled, status, stage_label INTO v_stage
      FROM production_job_stages WHERE id = (v_item->>'stage_id')::uuid FOR UPDATE;
    IF NOT FOUND OR v_stage.job_id <> p_job_id THEN
      RAISE EXCEPTION 'Stage does not belong to this job' USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_stage.is_enabled THEN
      RAISE EXCEPTION 'Stage "%" is not enabled for this job', v_stage.stage_label USING ERRCODE = 'P0001';
    END IF;
    IF v_stage.status IN ('completed','skipped') THEN
      RAISE EXCEPTION 'Stage "%" is already % and cannot be rescheduled', v_stage.stage_label, v_stage.status
        USING ERRCODE = 'P0001';
    END IF;
    IF v_stage.id = ANY (v_seen) THEN
      RAISE EXCEPTION 'Stage listed twice in one change' USING ERRCODE = 'P0001';
    END IF;
    v_seen := v_seen || v_stage.id;

    INSERT INTO production_job_stage_schedules
           (job_id, job_stage_id, planned_start_date, planned_end_date, created_by)
    VALUES (p_job_id, v_stage.id, v_start, v_end, p_actor)
    ON CONFLICT (job_stage_id) DO UPDATE
       SET planned_start_date = EXCLUDED.planned_start_date,
           planned_end_date   = EXCLUDED.planned_end_date,
           updated_at         = now();
    v_applied := v_applied + 1;
  END LOOP;

  -- Optional: move workers' assignment dates (only for stages being rescheduled here).
  IF p_assignment_changes IS NOT NULL AND jsonb_typeof(p_assignment_changes) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_assignment_changes) LOOP
      BEGIN
        v_start := (v_item->>'start')::date;
        v_end   := (v_item->>'end')::date;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Invalid date in assignment change' USING ERRCODE = 'P0001';
      END;
      IF v_start IS NULL OR v_end IS NULL OR v_end < v_start THEN
        RAISE EXCEPTION 'Assignment end date must be on or after its start date' USING ERRCODE = 'P0001';
      END IF;
      IF EXTRACT(DOW FROM v_start) = 0 OR EXTRACT(DOW FROM v_end) = 0 THEN
        RAISE EXCEPTION 'Assignment dates cannot fall on a Sunday' USING ERRCODE = 'P0001';
      END IF;
      SELECT * INTO v_a FROM production_job_assignments WHERE id = (v_item->>'assignment_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_a.job_id <> p_job_id OR v_a.stage_id IS NULL OR NOT (v_a.stage_id = ANY (v_seen)) THEN
        RAISE EXCEPTION 'Assignment does not belong to a stage being rescheduled' USING ERRCODE = 'P0001';
      END IF;
      IF v_a.status NOT IN ('Assigned','In Progress') THEN
        RAISE EXCEPTION 'Assignment is % and cannot be moved', v_a.status USING ERRCODE = 'P0001';
      END IF;
      v_old := jsonb_build_object('planned_start_date', v_a.planned_start_date, 'planned_end_date', v_a.planned_end_date);
      UPDATE production_job_assignments
         SET planned_start_date = v_start, planned_end_date = v_end, updated_at = now()
       WHERE id = v_a.id;
      INSERT INTO production_assignment_events (assignment_id, job_id, event, old_values, new_values, actor)
      VALUES (v_a.id, p_job_id, 'updated', v_old,
              jsonb_build_object('planned_start_date', v_start, 'planned_end_date', v_end, 'reason', 'stage rescheduled'), p_actor);
      v_moved := v_moved + 1;
    END LOOP;
  END IF;

  SELECT min(planned_start_date), max(planned_end_date) INTO v_min, v_max
    FROM production_job_stage_schedules WHERE job_id = p_job_id;
  UPDATE production_jobs
     SET planned_start = v_min, planned_finish = v_max, updated_at = now()
   WHERE id = p_job_id;

  RETURN jsonb_build_object('applied', v_applied, 'assignments_moved', v_moved, 'planned_start', v_min, 'planned_finish', v_max);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stage_schedules(uuid, jsonb, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stage_schedules(uuid, jsonb, uuid, jsonb) TO service_role;

COMMIT;
