-- ============================================================================
-- Canvas Guy Tracker — Production v2b: stage schedules + production due date
--
-- 1. production_jobs.production_due_date — the date production must FINISH by.
--    Separate from orders.due_date (customer delivery). Back-filled once from
--    planned_finish where that is set and production_due_date is empty; jobs
--    with neither stay NULL and show "No production due set" (nothing invented).
-- 2. production_job_stage_schedules — ONE schedule row per job stage
--    (UNIQUE job_stage_id). Planned dates only: nothing here ever writes
--    quantities, stage status or events. blocker_* columns are reserved for
--    the blockers piece and are not written by apply_stage_schedules().
-- 3. apply_stage_schedules() — atomic upsert of a list of stage date changes.
--    The date-impact decision (shift / keep / review each) is made by the API
--    and passed in as an explicit list; this function validates and applies it
--    and re-derives production_jobs.planned_start / planned_finish.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.production_jobs
  ADD COLUMN IF NOT EXISTS production_due_date date;

UPDATE public.production_jobs
   SET production_due_date = planned_finish::date
 WHERE production_due_date IS NULL
   AND planned_finish IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.production_job_stage_schedules (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid        NOT NULL REFERENCES public.production_jobs(id) ON DELETE CASCADE,
  job_stage_id             uuid        NOT NULL REFERENCES public.production_job_stages(id) ON DELETE CASCADE,
  planned_start_date       date        NOT NULL,
  planned_end_date         date        NOT NULL,
  status                   text        NOT NULL DEFAULT 'scheduled'
                                       CHECK (status IN ('scheduled','blocked')),
  blocker_reason           text,
  blocker_owner_id         uuid,
  expected_resolution_date date,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pjss_dates_ordered CHECK (planned_end_date >= planned_start_date),
  CONSTRAINT pjss_one_per_stage UNIQUE (job_stage_id)
);

CREATE INDEX IF NOT EXISTS idx_pjss_job   ON public.production_job_stage_schedules (job_id);
CREATE INDEX IF NOT EXISTS idx_pjss_dates ON public.production_job_stage_schedules (planned_start_date, planned_end_date);

ALTER TABLE public.production_job_stage_schedules ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only (every API route self-authenticates).
REVOKE ALL ON public.production_job_stage_schedules FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.production_job_stage_schedules TO service_role;

-- ── apply_stage_schedules ───────────────────────────────────────────────────
-- p_changes: [{ "stage_id": uuid, "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }, ...]
-- Rules enforced here (not just in the API):
--   * job exists and is not Completed/Cancelled
--   * every stage belongs to the job and is_enabled
--   * start <= end, neither falls on a Sunday
--   * a stage that is already 'completed'/'skipped' cannot be rescheduled
--   * no duplicate stage in one call
-- Touches ONLY production_job_stage_schedules and production_jobs.planned_*.
CREATE OR REPLACE FUNCTION public.apply_stage_schedules(
  p_job_id  uuid,
  p_changes jsonb,
  p_actor   uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job     record;
  v_item    jsonb;
  v_stage   record;
  v_start   date;
  v_end     date;
  v_seen    uuid[] := ARRAY[]::uuid[];
  v_applied int := 0;
  v_min     date;
  v_max     date;
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

  -- Keep the job-level planned window consistent with its stage schedules.
  SELECT min(planned_start_date), max(planned_end_date) INTO v_min, v_max
    FROM production_job_stage_schedules WHERE job_id = p_job_id;
  UPDATE production_jobs
     SET planned_start = v_min, planned_finish = v_max, updated_at = now()
   WHERE id = p_job_id;

  RETURN jsonb_build_object('applied', v_applied, 'planned_start', v_min, 'planned_finish', v_max);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stage_schedules(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stage_schedules(uuid, jsonb, uuid) TO service_role;

COMMIT;
