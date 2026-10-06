-- ============================================================================
-- Canvas Guy Tracker — Production v3a: labour costing (release 1)
--
-- Canvas Guy pays by ATTENDANCE, not by the hour, so labour is costed the same way:
--
--   Weekday (Mon–Sat):  attendance_units x daily_rate
--   Weekday + overtime: attendance_units x daily_rate  +  attendance_units x overtime_allowance (KES 200)
--   Sunday:             attendance_units x sunday_rate (KES 1,000) — REPLACES the daily rate
--                       and never carries the overtime allowance
--
-- attendance_units is the share of the worker's day booked to this job (1 = a full
-- day). A day split across jobs is allocated proportionally, so a KES 200 overtime
-- allowance split 60/40 is KES 120 / KES 80, and a Sunday split 60/40 is 600 / 400.
-- Overtime is a flat allowance per shift, regardless of duration: NO overtime hours
-- and NO multiplier exist anywhere in this model.
--
-- Daily rate: day_rate (casual / skilled casual); permanent staff use
-- monthly_salary / monthly_working_days. A missing weekday rate gives NULL
-- ("rate missing"), never 0. Rates are SNAPSHOTTED when an assignment is costed or
-- time is recorded, so a later change to an employee's rate never alters them.
--
-- production_time_entries is an append-only ledger: facts are immutable; a mistake
-- is corrected by voiding the entry and recording a new one.
--
-- Wages are confidential: all tables are service_role only. The API decides who may
-- see rates and costs; production_staff never receives them.
--
-- Does NOT touch payroll tables. Release 2 reconciles time-entry labour with
-- payroll_order_allocations on the Order P&L (time entries win per worker/order).
--
-- Safe to re-run. (Drops the hours-based columns of the earlier draft of this
-- migration, which was never put into use.)
-- ============================================================================

BEGIN;

-- ── Settings (singleton) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.production_labour_settings (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  overtime_allowance         numeric(10,2) NOT NULL DEFAULT 200  CHECK (overtime_allowance >= 0),
  sunday_rate                numeric(10,2) NOT NULL DEFAULT 1000 CHECK (sunday_rate >= 0),
  monthly_working_days       numeric(4,1)  NOT NULL DEFAULT 26   CHECK (monthly_working_days > 0 AND monthly_working_days <= 31),
  require_overtime_reason    boolean       NOT NULL DEFAULT true,
  currency                   text          NOT NULL DEFAULT 'KES',
  updated_at                 timestamptz   NOT NULL DEFAULT now(),
  updated_by                 uuid
);
ALTER TABLE public.production_labour_settings
  ADD COLUMN IF NOT EXISTS overtime_allowance numeric(10,2) NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS sunday_rate        numeric(10,2) NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS monthly_working_days numeric(4,1) NOT NULL DEFAULT 26,
  ADD COLUMN IF NOT EXISTS require_overtime_reason boolean NOT NULL DEFAULT true,
  DROP COLUMN IF EXISTS standard_hours_per_day,
  DROP COLUMN IF EXISTS overtime_multiplier;
INSERT INTO public.production_labour_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.production_labour_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.production_labour_settings FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.production_labour_settings TO service_role;

-- ── Assignment planning + rate snapshot ─────────────────────────────────────
ALTER TABLE public.production_job_assignments DROP CONSTRAINT IF EXISTS pja_labour_plan_check;
ALTER TABLE public.production_job_assignments
  DROP COLUMN IF EXISTS planned_regular_hours,
  DROP COLUMN IF EXISTS planned_overtime_hours,
  DROP COLUMN IF EXISTS regular_hourly_rate_snapshot,
  DROP COLUMN IF EXISTS overtime_hourly_rate_snapshot;
ALTER TABLE public.production_job_assignments
  ADD COLUMN IF NOT EXISTS planned_attendance_units numeric(6,2),   -- weekday (Mon–Sat) days on this job
  ADD COLUMN IF NOT EXISTS planned_overtime_days    numeric(6,2),   -- how many of those days carry the overtime allowance
  ADD COLUMN IF NOT EXISTS planned_sunday_units     numeric(6,2),   -- Sunday days on this job
  ADD COLUMN IF NOT EXISTS daily_rate_snapshot      numeric(10,2),
  ADD COLUMN IF NOT EXISTS overtime_rate_snapshot   numeric(10,2),
  ADD COLUMN IF NOT EXISTS sunday_rate_snapshot     numeric(10,2),
  ADD COLUMN IF NOT EXISTS planned_labour_cost      numeric(12,2),
  ADD COLUMN IF NOT EXISTS rate_snapshot_at         timestamptz;

ALTER TABLE public.production_job_assignments ADD CONSTRAINT pja_labour_plan_check CHECK (
      (planned_attendance_units IS NULL OR planned_attendance_units >= 0)
  AND (planned_overtime_days    IS NULL OR planned_overtime_days    >= 0)
  AND (planned_sunday_units     IS NULL OR planned_sunday_units     >= 0)
  AND (daily_rate_snapshot IS NULL OR daily_rate_snapshot > 0));

-- ── Cost formula (single source of truth for SQL) ───────────────────────────
-- NULL when the rate needed for that kind of day is missing.
CREATE OR REPLACE FUNCTION public.production_labour_cost(
  p_units numeric, p_overtime boolean, p_sunday boolean,
  p_daily numeric, p_ot_rate numeric, p_sunday_rate numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_sunday THEN CASE WHEN p_sunday_rate IS NULL THEN NULL ELSE round(p_units * p_sunday_rate, 2) END
    WHEN p_daily IS NULL THEN NULL
    ELSE round(p_units * p_daily + CASE WHEN p_overtime THEN p_units * COALESCE(p_ot_rate, 0) ELSE 0 END, 2)
  END
$$;

-- ── Rates for an employee today ─────────────────────────────────────────────
-- { daily (null if missing), overtime_allowance, sunday_rate }
CREATE OR REPLACE FUNCTION public.production_employee_rates(p_employee uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s record; e record; v_daily numeric;
BEGIN
  SELECT * INTO s FROM production_labour_settings WHERE id = true;
  SELECT type, day_rate, monthly_salary INTO e FROM employees WHERE id = p_employee;
  IF FOUND THEN
    IF e.type = 'permanent' THEN
      IF e.monthly_salary IS NOT NULL AND e.monthly_salary > 0 THEN v_daily := round(e.monthly_salary / s.monthly_working_days, 2); END IF;
    ELSIF e.day_rate IS NOT NULL AND e.day_rate > 0 THEN
      v_daily := e.day_rate;
    END IF;
  END IF;
  RETURN jsonb_build_object('daily', v_daily, 'overtime_allowance', s.overtime_allowance, 'sunday_rate', s.sunday_rate);
END;
$$;
REVOKE ALL ON FUNCTION public.production_employee_rates(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.production_employee_rates(uuid) TO service_role;

-- ── Apply planned days + rate snapshot to one assignment ────────────────────
-- An existing snapshot is KEPT (a later rate change must not alter an existing
-- assignment); one is taken only when none exists yet (e.g. the rate was missing).
CREATE OR REPLACE FUNCTION public.production_apply_labour_plan(
  p_assignment_id uuid, p_worker jsonb, p_start date, p_end date, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a record; r jsonb; v_daily numeric; v_ot numeric; v_sun numeric;
  v_weekdays integer; v_sundays integer;
  v_units numeric; v_otd numeric; v_sunu numeric; v_has boolean; v_cost numeric;
BEGIN
  SELECT * INTO a FROM production_job_assignments WHERE id = p_assignment_id FOR UPDATE;
  v_has := (p_worker ? 'planned_attendance_units') OR (p_worker ? 'planned_overtime_days') OR (p_worker ? 'planned_sunday_units');

  IF v_has THEN
    v_units := COALESCE(NULLIF(btrim(p_worker->>'planned_attendance_units'), '')::numeric, 0);
    v_otd   := COALESCE(NULLIF(btrim(p_worker->>'planned_overtime_days'), '')::numeric, 0);
    v_sunu  := COALESCE(NULLIF(btrim(p_worker->>'planned_sunday_units'), '')::numeric, 0);
    IF v_units < 0 OR v_otd < 0 OR v_sunu < 0 THEN RAISE EXCEPTION 'Planned days cannot be negative'; END IF;
    SELECT count(*) FILTER (WHERE EXTRACT(DOW FROM d) <> 0), count(*) FILTER (WHERE EXTRACT(DOW FROM d) = 0)
      INTO v_weekdays, v_sundays FROM generate_series(p_start, p_end, interval '1 day') d;
    IF v_units > v_weekdays THEN RAISE EXCEPTION 'Planned attendance (% days) is more than the % working days scheduled', v_units, v_weekdays; END IF;
    IF v_sunu > v_sundays THEN RAISE EXCEPTION 'Planned Sunday days (%) exceed the % Sunday(s) in the scheduled dates', v_sunu, v_sundays; END IF;
    IF v_otd > ceil(v_units) THEN RAISE EXCEPTION 'Overtime days (%) cannot exceed the attendance days (%)', v_otd, v_units; END IF;
  ELSE
    v_units := a.planned_attendance_units; v_otd := a.planned_overtime_days; v_sunu := a.planned_sunday_units;
  END IF;

  v_daily := a.daily_rate_snapshot; v_ot := a.overtime_rate_snapshot; v_sun := a.sunday_rate_snapshot;
  IF v_ot IS NULL OR v_sun IS NULL OR v_daily IS NULL THEN
    r := public.production_employee_rates(a.employee_id);
    IF v_daily IS NULL THEN v_daily := NULLIF(r->>'daily','')::numeric; END IF;
    IF v_ot IS NULL THEN v_ot := NULLIF(r->>'overtime_allowance','')::numeric; END IF;
    IF v_sun IS NULL THEN v_sun := NULLIF(r->>'sunday_rate','')::numeric; END IF;
  END IF;

  -- Planned cost: weekday days at the daily rate, the flat allowance on the overtime days, Sundays at the Sunday rate.
  IF v_units IS NULL AND v_otd IS NULL AND v_sunu IS NULL THEN v_cost := NULL;
  ELSIF COALESCE(v_units, 0) > 0 AND v_daily IS NULL THEN v_cost := NULL;     -- rate missing
  ELSE
    v_cost := round(COALESCE(v_units,0) * COALESCE(v_daily,0) + COALESCE(v_otd,0) * COALESCE(v_ot,0) + COALESCE(v_sunu,0) * COALESCE(v_sun,0), 2);
  END IF;

  UPDATE production_job_assignments SET
    planned_attendance_units = v_units, planned_overtime_days = v_otd, planned_sunday_units = v_sunu,
    daily_rate_snapshot = v_daily, overtime_rate_snapshot = v_ot, sunday_rate_snapshot = v_sun,
    rate_snapshot_at = CASE WHEN a.rate_snapshot_at IS NULL AND (v_daily IS NOT NULL OR v_sun IS NOT NULL) THEN now() ELSE a.rate_snapshot_at END,
    planned_labour_cost = v_cost
  WHERE id = p_assignment_id;
END;
$$;
REVOKE ALL ON FUNCTION public.production_apply_labour_plan(uuid, jsonb, date, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.production_apply_labour_plan(uuid, jsonb, date, date, uuid) TO service_role;

-- ── assign_workers_to_stage: v2e body + labour plan per worker ──────────────
CREATE OR REPLACE FUNCTION public.assign_workers_to_stage(
  p_job_id        uuid,
  p_stage_id      uuid,
  p_operation_id  uuid,
  p_mode          text,
  p_workers       jsonb,        -- [{ employee_id, assigned_quantity, planned_attendance_units?, planned_overtime_days?, planned_sunday_units? }, ...]  ([] removes the group)
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
        PERFORM public.production_apply_labour_plan(v_row.id, v_elem, p_start, p_end, p_assigned_by);
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
        PERFORM public.production_apply_labour_plan(v_new_id, v_elem, p_start, p_end, p_assigned_by);
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

-- ── Time-entry ledger (actual labour) ───────────────────────────────────────
-- An earlier hours-based draft of this table (never used) is replaced; refuse if it holds data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'production_time_entries' AND column_name = 'regular_hours') THEN
    IF EXISTS (SELECT 1 FROM public.production_time_entries) THEN
      RAISE EXCEPTION 'production_time_entries holds hours-based rows; migrate or clear them before running this version';
    END IF;
    DROP TABLE public.production_time_entries;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.production_time_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid NOT NULL REFERENCES public.production_jobs(id),
  stage_id              uuid NOT NULL REFERENCES public.production_job_stages(id),
  operation_id          uuid REFERENCES public.production_operations(id),
  assignment_id         uuid NOT NULL REFERENCES public.production_job_assignments(id),
  employee_id           uuid NOT NULL REFERENCES public.employees(id),
  work_date             date NOT NULL,
  attendance_units      numeric(4,2) NOT NULL CHECK (attendance_units > 0 AND attendance_units <= 1),
  has_overtime          boolean NOT NULL DEFAULT false,
  is_sunday             boolean NOT NULL DEFAULT false,
  daily_rate_snapshot   numeric(10,2),
  overtime_rate_snapshot numeric(10,2),
  sunday_rate_snapshot  numeric(10,2),
  actual_labour_cost    numeric(12,2),
  overtime_reason       text,
  notes                 text,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','voided')),
  recorded_by           uuid,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  approved_by           uuid,
  approved_at           timestamptz,
  rejected_by           uuid,
  rejected_at           timestamptz,
  decision_note         text,
  voided_by             uuid,
  voided_at             timestamptz,
  void_reason           text,
  CHECK (NOT (is_sunday AND has_overtime))          -- the Sunday rate replaces the day; no overtime allowance on top
);
CREATE INDEX IF NOT EXISTS idx_pte_job      ON public.production_time_entries (job_id);
CREATE INDEX IF NOT EXISTS idx_pte_employee ON public.production_time_entries (employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_pte_status   ON public.production_time_entries (status);
-- One live entry per assignment per day; rejected/voided entries free the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pte_assignment_day
  ON public.production_time_entries (assignment_id, work_date) WHERE status IN ('draft','submitted','approved');

ALTER TABLE public.production_time_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.production_time_entries FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.production_time_entries TO service_role;

-- The facts of an entry are immutable. Only workflow columns may change.
CREATE OR REPLACE FUNCTION public.production_time_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Time entries cannot be deleted — void them instead'; END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.work_date IS DISTINCT FROM OLD.work_date
     OR NEW.attendance_units IS DISTINCT FROM OLD.attendance_units OR NEW.has_overtime IS DISTINCT FROM OLD.has_overtime
     OR NEW.is_sunday IS DISTINCT FROM OLD.is_sunday
     OR NEW.daily_rate_snapshot IS DISTINCT FROM OLD.daily_rate_snapshot
     OR NEW.overtime_rate_snapshot IS DISTINCT FROM OLD.overtime_rate_snapshot
     OR NEW.sunday_rate_snapshot IS DISTINCT FROM OLD.sunday_rate_snapshot
     OR NEW.actual_labour_cost IS DISTINCT FROM OLD.actual_labour_cost
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    -- The one allowed exception: costing a not-yet-approved entry whose rate was missing.
    IF NOT (OLD.status IN ('draft','submitted') AND OLD.actual_labour_cost IS NULL
            AND NEW.job_id = OLD.job_id AND NEW.assignment_id = OLD.assignment_id AND NEW.employee_id = OLD.employee_id
            AND NEW.work_date = OLD.work_date AND NEW.attendance_units = OLD.attendance_units
            AND NEW.has_overtime = OLD.has_overtime AND NEW.is_sunday = OLD.is_sunday) THEN
      RAISE EXCEPTION 'Time entries are immutable — void the entry and record a new one';
    END IF;
  END IF;
  IF OLD.status IN ('rejected','voided') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A % entry cannot change status', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_pte_guard ON public.production_time_entries;
CREATE TRIGGER trg_pte_guard BEFORE UPDATE OR DELETE ON public.production_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.production_time_entries_guard();

-- ── record_time_entry ───────────────────────────────────────────────────────
-- p_units is the share of the worker's day booked to this job (0 < units <= 1).
-- Whether the date is a Sunday is derived from the date — the caller cannot declare it.
CREATE OR REPLACE FUNCTION public.record_time_entry(
  p_assignment_id   uuid,
  p_work_date       date,
  p_units           numeric,
  p_has_overtime    boolean,
  p_overtime_reason text,
  p_notes           text,
  p_submit          boolean,
  p_actor           uuid,
  p_today           date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a record; j record; st record; s record; r jsonb;
  v_ot boolean := COALESCE(p_has_overtime, false);
  v_sun boolean; v_daily numeric; v_otr numeric; v_sunr numeric; v_cost numeric; v_other numeric; v_id uuid;
  v_ot_other boolean;
BEGIN
  SELECT * INTO s FROM production_labour_settings WHERE id = true;
  IF p_work_date IS NULL THEN RAISE EXCEPTION 'work_date is required'; END IF;
  IF p_today IS NOT NULL AND p_work_date > p_today THEN RAISE EXCEPTION 'Time cannot be recorded for a future date'; END IF;
  IF p_units IS NULL OR p_units <= 0 THEN RAISE EXCEPTION 'Enter the share of the day worked on this job'; END IF;
  IF p_units > 1 THEN RAISE EXCEPTION 'A worker cannot give more than one day (1.00) to a job in a day'; END IF;
  v_sun := EXTRACT(DOW FROM p_work_date) = 0;
  IF v_sun AND v_ot THEN RAISE EXCEPTION 'Sunday is a flat Sunday rate — the overtime allowance does not apply'; END IF;
  IF v_ot AND s.require_overtime_reason AND NULLIF(btrim(COALESCE(p_overtime_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'Overtime needs a reason';
  END IF;

  SELECT * INTO a FROM production_job_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found'; END IF;
  IF a.status NOT IN ('Assigned','In Progress','Completed') THEN
    RAISE EXCEPTION 'Time cannot be booked to a % assignment', lower(a.status);
  END IF;
  SELECT * INTO j FROM production_jobs WHERE id = a.job_id FOR UPDATE;
  IF j.status = 'Cancelled' THEN RAISE EXCEPTION 'Job is cancelled'; END IF;
  IF j.status = 'Completed' THEN RAISE EXCEPTION 'Job is completed — reopen it before recording time'; END IF;
  SELECT * INTO st FROM production_job_stages WHERE id = a.stage_id;
  IF st.id IS NULL OR NOT st.is_enabled THEN RAISE EXCEPTION 'Time cannot be booked to a disabled stage'; END IF;

  -- The same worker's day, across ALL jobs, cannot add up to more than one day; and the
  -- overtime flag is a property of the day, so every entry for that day must agree.
  SELECT COALESCE(sum(attendance_units), 0), bool_or(has_overtime) INTO v_other, v_ot_other
    FROM production_time_entries
   WHERE employee_id = a.employee_id AND work_date = p_work_date AND status IN ('draft','submitted','approved');
  IF v_other + p_units > 1 THEN
    RAISE EXCEPTION 'That worker already has % of a day booked on % — a day cannot exceed 1.00', v_other, p_work_date;
  END IF;
  IF v_ot_other IS NOT NULL AND v_ot_other <> v_ot THEN
    RAISE EXCEPTION 'Overtime applies to the whole day: other entries for that worker on % are marked %', p_work_date,
      CASE WHEN v_ot_other THEN 'with overtime' ELSE 'without overtime' END;
  END IF;
  IF EXISTS (SELECT 1 FROM production_time_entries WHERE assignment_id = p_assignment_id AND work_date = p_work_date
              AND status IN ('draft','submitted','approved')) THEN
    RAISE EXCEPTION 'There is already an entry for this assignment on % — void it first to correct it', p_work_date;
  END IF;

  -- Rate snapshot: the assignment's snapshot wins; otherwise take one now and store it there too.
  v_daily := a.daily_rate_snapshot; v_otr := a.overtime_rate_snapshot; v_sunr := a.sunday_rate_snapshot;
  IF v_daily IS NULL OR v_otr IS NULL OR v_sunr IS NULL THEN
    r := public.production_employee_rates(a.employee_id);
    IF v_daily IS NULL THEN v_daily := NULLIF(r->>'daily','')::numeric; END IF;
    IF v_otr   IS NULL THEN v_otr   := NULLIF(r->>'overtime_allowance','')::numeric; END IF;
    IF v_sunr  IS NULL THEN v_sunr  := NULLIF(r->>'sunday_rate','')::numeric; END IF;
    UPDATE production_job_assignments SET daily_rate_snapshot = v_daily, overtime_rate_snapshot = v_otr, sunday_rate_snapshot = v_sunr,
           rate_snapshot_at = COALESCE(rate_snapshot_at, now())
     WHERE id = a.id;
  END IF;
  v_cost := public.production_labour_cost(p_units, v_ot, v_sun, v_daily, v_otr, v_sunr);

  INSERT INTO production_time_entries
    (job_id, stage_id, operation_id, assignment_id, employee_id, work_date, attendance_units, has_overtime, is_sunday,
     daily_rate_snapshot, overtime_rate_snapshot, sunday_rate_snapshot, actual_labour_cost,
     overtime_reason, notes, status, recorded_by, submitted_at)
  VALUES (a.job_id, a.stage_id, a.operation_id, a.id, a.employee_id, p_work_date, p_units, v_ot, v_sun,
          v_daily, v_otr, v_sunr, v_cost,
          CASE WHEN v_ot THEN NULLIF(btrim(COALESCE(p_overtime_reason,'')), '') END, NULLIF(btrim(COALESCE(p_notes,'')), ''),
          CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END, p_actor, CASE WHEN p_submit THEN now() END)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'status', CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
                            'is_sunday', v_sun, 'rate_missing', v_cost IS NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.record_time_entry(uuid, date, numeric, boolean, text, text, boolean, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_time_entry(uuid, date, numeric, boolean, text, text, boolean, uuid, date) TO service_role;

-- ── transition_time_entry: submit / approve / reject / void ─────────────────
CREATE OR REPLACE FUNCTION public.transition_time_entry(
  p_entry_id uuid, p_action text, p_actor uuid, p_actor_role text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e record; a record; r jsonb; v_daily numeric; v_otr numeric; v_sunr numeric; v_cost numeric;
BEGIN
  IF p_action NOT IN ('submit','approve','reject','void') THEN RAISE EXCEPTION 'Unknown action'; END IF;
  SELECT * INTO e FROM production_time_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Time entry not found'; END IF;

  IF p_action = 'submit' THEN
    IF e.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be submitted (this one is %)', e.status; END IF;
    IF p_actor_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;
    UPDATE production_time_entries SET status = 'submitted', submitted_at = now() WHERE id = e.id;

  ELSIF p_action = 'approve' THEN
    IF p_actor_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;
    IF e.status <> 'submitted' THEN RAISE EXCEPTION 'Only a submitted entry can be approved (this one is %)', e.status; END IF;
    -- Separation of duties: a manager cannot approve their own entry; admin may.
    IF p_actor_role <> 'admin' AND e.recorded_by IS NOT DISTINCT FROM p_actor THEN
      RAISE EXCEPTION 'You cannot approve a time entry you recorded yourself';
    END IF;
    IF e.actual_labour_cost IS NULL THEN
      -- The rate was missing at entry time. Re-resolve it now; the facts of the entry stay as recorded.
      SELECT * INTO a FROM production_job_assignments WHERE id = e.assignment_id;
      v_daily := a.daily_rate_snapshot; v_otr := a.overtime_rate_snapshot; v_sunr := a.sunday_rate_snapshot;
      IF v_daily IS NULL THEN
        r := public.production_employee_rates(e.employee_id);
        v_daily := NULLIF(r->>'daily','')::numeric;
        v_otr := COALESCE(v_otr, NULLIF(r->>'overtime_allowance','')::numeric);
        v_sunr := COALESCE(v_sunr, NULLIF(r->>'sunday_rate','')::numeric);
      END IF;
      v_cost := public.production_labour_cost(e.attendance_units, e.has_overtime, e.is_sunday, v_daily, v_otr, v_sunr);
      IF v_cost IS NULL THEN RAISE EXCEPTION 'Rate missing for this worker — payroll must set a daily rate before the entry can be approved'; END IF;
      UPDATE production_time_entries SET daily_rate_snapshot = v_daily, overtime_rate_snapshot = v_otr, sunday_rate_snapshot = v_sunr,
             actual_labour_cost = v_cost WHERE id = e.id;
    END IF;
    UPDATE production_time_entries SET status = 'approved', approved_by = p_actor, approved_at = now(), decision_note = NULLIF(btrim(COALESCE(p_note,'')),'') WHERE id = e.id;

  ELSIF p_action = 'reject' THEN
    IF p_actor_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;
    IF e.status NOT IN ('draft','submitted') THEN RAISE EXCEPTION 'Only a draft or submitted entry can be rejected'; END IF;
    IF NULLIF(btrim(COALESCE(p_note,'')),'') IS NULL THEN RAISE EXCEPTION 'A rejection needs a reason'; END IF;
    UPDATE production_time_entries SET status = 'rejected', rejected_by = p_actor, rejected_at = now(), decision_note = btrim(p_note) WHERE id = e.id;

  ELSE -- void (reversal)
    IF p_actor_role <> 'admin' THEN RAISE EXCEPTION 'Only an admin can void a time entry'; END IF;
    IF e.status NOT IN ('submitted','approved') THEN RAISE EXCEPTION 'Only a submitted or approved entry can be voided'; END IF;
    IF NULLIF(btrim(COALESCE(p_note,'')),'') IS NULL THEN RAISE EXCEPTION 'Voiding needs a reason'; END IF;
    UPDATE production_time_entries SET status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_note) WHERE id = e.id;
  END IF;

  RETURN (SELECT to_jsonb(t) - 'daily_rate_snapshot' - 'overtime_rate_snapshot' - 'sunday_rate_snapshot' - 'actual_labour_cost'
            FROM production_time_entries t WHERE id = p_entry_id);
END;
$$;
REVOKE ALL ON FUNCTION public.transition_time_entry(uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_time_entry(uuid, text, uuid, text, text) TO service_role;

COMMIT;
