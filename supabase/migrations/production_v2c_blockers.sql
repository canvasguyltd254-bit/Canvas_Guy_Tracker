-- ============================================================================
-- Canvas Guy Tracker — Production v2c: blockers with ownership
--
-- production_job_blockers is the record of truth for WHY a job is blocked:
-- reason, owner (employee), expected resolution date, supplier / PO reference,
-- notes, and who resolved it and when. Several blockers may be open on a job.
--
-- production_jobs.blocker_reason is kept as a denormalised mirror (the reason
-- of the most recent open blocker, NULL when none) so every existing reader —
-- home dashboard, job list, status modal — keeps working with one source of
-- truth underneath. It is written ONLY by the two functions below.
--
-- Raising / resolving a blocker never changes job status, stage status,
-- quantities or planned dates. After a resolve the caller is told whether the
-- job has stage schedules so the UI can prompt "review dates?".
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.production_job_blockers (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid        NOT NULL REFERENCES public.production_jobs(id) ON DELETE CASCADE,
  stage_id                 uuid        REFERENCES public.production_job_stages(id) ON DELETE SET NULL,
  reason                   text        NOT NULL CHECK (length(btrim(reason)) > 0),
  owner_employee_id        uuid        REFERENCES public.employees(id) ON DELETE SET NULL,
  expected_resolution_date date,
  supplier_po_ref          text,
  notes                    text,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz,
  resolved_by              uuid,
  resolution_note          text
);

CREATE INDEX IF NOT EXISTS idx_pjb_job_open
  ON public.production_job_blockers (job_id) WHERE resolved_at IS NULL;

ALTER TABLE public.production_job_blockers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.production_job_blockers FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.production_job_blockers TO service_role;

-- ── raise_job_blocker ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.raise_job_blocker(
  p_job_id   uuid,
  p_stage_id uuid,
  p_reason   text,
  p_owner    uuid,
  p_expected date,
  p_ref      text,
  p_notes    text,
  p_actor    uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job record;
  v_id  uuid;
BEGIN
  SELECT id, status INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.status IN ('Completed','Cancelled') THEN
    RAISE EXCEPTION 'Job is % and cannot be blocked', v_job.status USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A blocker needs a reason' USING ERRCODE = 'P0001';
  END IF;
  IF p_stage_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM production_job_stages WHERE id = p_stage_id AND job_id = p_job_id) THEN
    RAISE EXCEPTION 'Stage does not belong to this job' USING ERRCODE = 'P0001';
  END IF;
  IF p_owner IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM employees WHERE id = p_owner AND is_active) THEN
    RAISE EXCEPTION 'Owner must be an active employee' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO production_job_blockers
         (job_id, stage_id, reason, owner_employee_id, expected_resolution_date, supplier_po_ref, notes, created_by)
  VALUES (p_job_id, p_stage_id, btrim(p_reason), p_owner, p_expected, NULLIF(btrim(p_ref), ''), NULLIF(btrim(p_notes), ''), p_actor)
  RETURNING id INTO v_id;

  UPDATE production_jobs SET blocker_reason = btrim(p_reason), updated_at = now() WHERE id = p_job_id;

  RETURN jsonb_build_object('blocker_id', v_id);
END;
$$;

-- ── resolve_job_blocker ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_job_blocker(
  p_blocker_id uuid,
  p_note       text,
  p_actor      uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id    uuid;
  v_resolved  timestamptz;
  v_remaining int;
  v_latest    text;
  v_sched     int;
BEGIN
  SELECT job_id INTO v_job_id FROM production_job_blockers WHERE id = p_blocker_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blocker not found' USING ERRCODE = 'P0002'; END IF;

  PERFORM 1 FROM production_jobs WHERE id = v_job_id FOR UPDATE;

  SELECT resolved_at INTO v_resolved FROM production_job_blockers WHERE id = p_blocker_id FOR UPDATE;
  IF v_resolved IS NOT NULL THEN
    RAISE EXCEPTION 'Blocker is already resolved' USING ERRCODE = 'P0001';
  END IF;

  UPDATE production_job_blockers
     SET resolved_at = now(), resolved_by = p_actor, resolution_note = NULLIF(btrim(p_note), '')
   WHERE id = p_blocker_id;

  SELECT count(*) INTO v_remaining FROM production_job_blockers WHERE job_id = v_job_id AND resolved_at IS NULL;
  SELECT reason INTO v_latest FROM production_job_blockers
   WHERE job_id = v_job_id AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1;

  UPDATE production_jobs SET blocker_reason = v_latest, updated_at = now() WHERE id = v_job_id;

  SELECT count(*) INTO v_sched FROM production_job_stage_schedules WHERE job_id = v_job_id;

  RETURN jsonb_build_object(
    'job_id', v_job_id,
    'remaining_open', v_remaining,
    'has_schedules', v_sched > 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.raise_job_blocker(uuid, uuid, text, uuid, date, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_job_blocker(uuid, uuid, text, uuid, date, text, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_job_blocker(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_job_blocker(uuid, text, uuid) TO service_role;

-- Existing jobs that already carry a free-text blocker_reason: give each one an
-- open record (no owner / date — the attention helper will say so) so the
-- mirror and the table agree from day one.
INSERT INTO public.production_job_blockers (job_id, reason, notes)
SELECT j.id, btrim(j.blocker_reason), 'Imported from the job''s existing blocker note'
  FROM public.production_jobs j
 WHERE j.blocker_reason IS NOT NULL AND length(btrim(j.blocker_reason)) > 0
   AND j.status NOT IN ('Completed','Cancelled')
   AND NOT EXISTS (SELECT 1 FROM public.production_job_blockers b WHERE b.job_id = j.id);

COMMIT;
