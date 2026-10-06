-- ─────────────────────────────────────────────────────────────────────────────
-- Production V1B — Progress entries
--
-- Extends Phase 1A with an immutable progress log and the
-- record_job_progress() RPC that is the ONLY permitted writer to the
-- five qty buckets on production_jobs.
--
-- New table
--   production_progress_entries  — append-only log of qty transitions
--
-- New RPC
--   record_job_progress(job_id, transition, quantity, notes, recorded_by)
--
-- Transition types
--   start        not-started → in_production_qty   (also sets actual_start)
--   submit_qc    in_production_qty → awaiting_qc_qty
--   accept       awaiting_qc_qty  → accepted_qty   (auto-completes job when full)
--   rework       awaiting_qc_qty  → rework_qty
--   rework_start rework_qty       → in_production_qty
--   scrap        awaiting_qc_qty  → scrapped_qty
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Progress entries table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.production_progress_entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES public.production_jobs(id),

  transition    text        NOT NULL CHECK (transition IN (
                              'start',
                              'submit_qc',
                              'accept',
                              'rework',
                              'rework_start',
                              'scrap'
                            )),

  quantity      integer     NOT NULL CHECK (quantity > 0),
  notes         text,

  recorded_by   uuid        REFERENCES auth.users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.production_progress_entries
  IS 'Immutable log of quantity transitions on a production job. Never update or delete rows — the buckets on production_jobs are always derivable from this log.';

CREATE INDEX IF NOT EXISTS idx_prog_entries_job_id
  ON public.production_progress_entries (job_id);

CREATE INDEX IF NOT EXISTS idx_prog_entries_recorded_at
  ON public.production_progress_entries (recorded_at DESC);


-- ── record_job_progress RPC ───────────────────────────────────────────────────
--
-- Validates source bucket depth, updates the two qty columns atomically,
-- logs the entry, and auto-completes the job when accepted_qty ≥ planned_quantity.
-- Also auto-advances job.status on first start/accept transitions.
--
CREATE OR REPLACE FUNCTION public.record_job_progress(
  p_job_id      uuid,
  p_transition  text,
  p_quantity    integer,
  p_notes       text,
  p_recorded_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job         RECORD;
  v_role        text;
  v_not_started integer;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id is required';
  END IF;

  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION
      'quantity must be a positive integer, got %',
      p_quantity;
  END IF;

  IF p_transition NOT IN (
    'start',
    'submit_qc',
    'accept',
    'rework',
    'rework_start',
    'scrap'
  ) THEN
    RAISE EXCEPTION
      'Unknown transition: %',
      p_transition;
  END IF;

  SELECT role
  INTO v_role
  FROM public.user_profiles
  WHERE id = p_recorded_by;

  IF NOT FOUND OR v_role IS NULL THEN
    RAISE EXCEPTION
      'User % was not found in user_profiles or has no role',
      p_recorded_by;
  END IF;

  -- Only production managers and administrators can make QC decisions.
  IF p_transition IN ('accept', 'rework', 'scrap') THEN
    IF v_role NOT IN ('admin', 'production_manager') THEN
      RAISE EXCEPTION
        'Transition "%" requires admin or production_manager role; caller role is "%"',
        p_transition,
        v_role;
    END IF;
  ELSE
    -- Workshop transitions may also be performed by production staff.
    IF v_role NOT IN (
      'admin',
      'production_manager',
      'production_staff'
    ) THEN
      RAISE EXCEPTION
        'Transition "%" requires a production role; caller role is "%"',
        p_transition,
        v_role;
    END IF;
  END IF;

  SELECT *
  INTO v_job
  FROM public.production_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Production job % not found',
      p_job_id;
  END IF;

  IF v_job.status = 'Cancelled' THEN
    RAISE EXCEPTION
      'Cannot record progress on a cancelled job';
  END IF;

  IF v_job.status = 'Completed' THEN
    RAISE EXCEPTION
      'Job % is already completed',
      p_job_id;
  END IF;

  -- ── Source bucket depth check ─────────────────────────────────────────────

  CASE p_transition
    WHEN 'start' THEN
      v_not_started :=
        v_job.planned_quantity
        - v_job.in_production_qty
        - v_job.awaiting_qc_qty
        - v_job.rework_qty
        - v_job.accepted_qty
        - v_job.scrapped_qty;

      IF p_quantity > v_not_started THEN
        RAISE EXCEPTION
          'Cannot start % units: only % units have not been started',
          p_quantity,
          v_not_started;
      END IF;

    WHEN 'submit_qc' THEN
      IF p_quantity > v_job.in_production_qty THEN
        RAISE EXCEPTION
          'Cannot submit % units to QC: only % are in production',
          p_quantity,
          v_job.in_production_qty;
      END IF;

    WHEN 'accept' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION
          'Cannot accept % units: only % are awaiting QC',
          p_quantity,
          v_job.awaiting_qc_qty;
      END IF;

    WHEN 'rework' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION
          'Cannot send % units to rework: only % are awaiting QC',
          p_quantity,
          v_job.awaiting_qc_qty;
      END IF;

    WHEN 'rework_start' THEN
      IF p_quantity > v_job.rework_qty THEN
        RAISE EXCEPTION
          'Cannot restart % units: only % are in rework',
          p_quantity,
          v_job.rework_qty;
      END IF;

    WHEN 'scrap' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION
          'Cannot scrap % units: only % are awaiting QC',
          p_quantity,
          v_job.awaiting_qc_qty;
      END IF;
  END CASE;

  -- ── Apply the bucket change ───────────────────────────────────────────────

  CASE p_transition
    WHEN 'start' THEN
      UPDATE public.production_jobs
      SET
        in_production_qty = in_production_qty + p_quantity,
        status = CASE
          WHEN status IN (
            'Planned',
            'Awaiting Materials',
            'Materials Ready'
          )
          THEN 'In Production'
          ELSE status
        END,
        actual_start = COALESCE(actual_start, now()),
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'submit_qc' THEN
      UPDATE public.production_jobs
      SET
        in_production_qty = in_production_qty - p_quantity,
        awaiting_qc_qty = awaiting_qc_qty + p_quantity,
        status = CASE
          WHEN status = 'In Production'
          THEN 'Quality Control'
          ELSE status
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'accept' THEN
      UPDATE public.production_jobs
      SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        accepted_qty = accepted_qty + p_quantity,
        status = CASE
          WHEN accepted_qty + p_quantity >= planned_quantity
          THEN 'Completed'
          ELSE status
        END,
        actual_finish = CASE
          WHEN accepted_qty + p_quantity >= planned_quantity
          THEN now()
          ELSE actual_finish
        END,
        completed_at = CASE
          WHEN accepted_qty + p_quantity >= planned_quantity
          THEN now()
          ELSE completed_at
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'rework' THEN
      UPDATE public.production_jobs
      SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        rework_qty = rework_qty + p_quantity,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'rework_start' THEN
      UPDATE public.production_jobs
      SET
        rework_qty = rework_qty - p_quantity,
        in_production_qty = in_production_qty + p_quantity,
        status = CASE
          WHEN status = 'Quality Control'
          THEN 'In Production'
          ELSE status
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'scrap' THEN
      UPDATE public.production_jobs
      SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        scrapped_qty = scrapped_qty + p_quantity,
        updated_at = now()
      WHERE id = p_job_id;
  END CASE;

  -- ── Append the log entry ──────────────────────────────────────────────────

  INSERT INTO public.production_progress_entries (
    job_id,
    transition,
    quantity,
    notes,
    recorded_by
  )
  VALUES (
    p_job_id,
    p_transition,
    p_quantity,
    NULLIF(btrim(p_notes), ''),
    p_recorded_by
  );

END;
$$;

REVOKE ALL ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  IS 'Records a quantity transition on a production job, updating the cached qty buckets atomically and appending an immutable progress entry. Auto-completes the job when accepted_qty reaches planned_quantity.';

COMMIT;
