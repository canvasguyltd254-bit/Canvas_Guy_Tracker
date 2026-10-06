-- =============================================================================
-- production_v1e_stages.sql
--
-- Adds per-job production stage tracking on top of the existing QC-gate
-- qty buckets (in_production_qty / awaiting_qc_qty / accepted_qty …).
--
-- IMPORTANT — what this migration does NOT do:
--   • Does NOT replace create_production_plan or create_production_job.
--     Stage rows are created automatically by a trigger on production_jobs.
--   • Does NOT break any existing qty-bucket flow.
--     record_job_progress() is extended only for the 'accept' transition
--     to defer job completion to the Packaging stage when stages are active.
--
-- Five configurable stages per job (sort_order 1-5):
--   1. materials  — Materials Preparation        (skippable by manager)
--   2. assembly   — Cutting / Joining / Assembly (mandatory, cannot be disabled)
--   3. sanding    — Sanding                      (skippable by manager)
--   4. finishing  — Finishing / Painting         (mandatory, cannot be disabled)
--   5. packaging  — Packaging                    (mandatory, cannot be disabled)
--
-- QC remains a separate mandatory gate between Finishing and Packaging,
-- managed by the existing record_job_progress RPC.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  Add stage_key to production_operations
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_operations
  ADD COLUMN IF NOT EXISTS stage_key TEXT;

UPDATE production_operations SET stage_key = 'assembly'  WHERE code IN ('CUT','FAB','JOI','ASM','GLS','UPH');
UPDATE production_operations SET stage_key = 'sanding'   WHERE code = 'SAN';
UPDATE production_operations SET stage_key = 'finishing' WHERE code = 'FIN';
UPDATE production_operations SET stage_key = 'packaging' WHERE code = 'PKG';
-- QC intentionally has no stage_key (it is a gate, not a stage)


-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  production_job_stages
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_job_stages (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id                    UUID        NOT NULL REFERENCES production_jobs(id) ON DELETE CASCADE,
  stage_key                 TEXT        NOT NULL
    CHECK (stage_key IN ('materials','assembly','sanding','finishing','packaging')),
  stage_label               TEXT        NOT NULL,
  sort_order                INTEGER     NOT NULL,

  -- Configuration (locked once any qty movement is recorded)
  is_enabled                BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Status: not_started → active → completed | skipped
  status                    TEXT        NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','active','completed','skipped')),

  -- Quantity tracking
  -- planned_quantity mirrors the job's planned_quantity at stage creation;
  -- it is immutable after creation.
  planned_quantity          INTEGER     NOT NULL DEFAULT 0 CHECK (planned_quantity >= 0),

  -- completed_quantity = ALL units that have exited this stage, including
  -- rework re-passes.  Can therefore exceed planned_quantity when rework
  -- units traverse the stage a second time.
  completed_quantity        INTEGER     NOT NULL DEFAULT 0 CHECK (completed_quantity >= 0),

  -- Rework tracking — planned_quantity is NEVER increased for rework.
  rework_received_quantity  INTEGER     NOT NULL DEFAULT 0 CHECK (rework_received_quantity >= 0),
  rework_completed_quantity INTEGER     NOT NULL DEFAULT 0 CHECK (rework_completed_quantity >= 0),

  -- Stage is cleared when:
  --   completed_quantity >= planned_quantity + rework_received_quantity
  -- which is equivalent to:
  --   completed_quantity - planned_quantity >= rework_received_quantity
  -- i.e. the "excess" completed units cover all rework passes.

  started_at                TIMESTAMPTZ,
  started_by                UUID        REFERENCES auth.users(id),
  completed_at              TIMESTAMPTZ,
  completed_by              UUID        REFERENCES auth.users(id),
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (job_id, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_pjs_job_id ON production_job_stages (job_id);
CREATE INDEX IF NOT EXISTS idx_pjs_status ON production_job_stages (job_id, status);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3.  production_stage_progress_entries (immutable event ledger)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS production_stage_progress_entries (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id          UUID        NOT NULL REFERENCES production_jobs(id),
  stage_id        UUID        REFERENCES production_job_stages(id),

  event_type      TEXT        NOT NULL
    CHECK (event_type IN (
      'advance',            -- units completed this stage (first-pass)
      'rework_received',    -- QC sent units back to this stage
      'rework_completed',   -- rework done; units traverse stage again → next
      'stage_skipped',      -- stage disabled before work started
      'stage_reopened',     -- admin/manager reopened completed stage
      'materials_prepared'  -- Materials stage: materials confirmed ready
    )),

  quantity        INTEGER,
  operation_id    UUID        REFERENCES production_operations(id),
  employee_id     UUID        REFERENCES employees(id),
  from_stage_key  TEXT,
  to_stage_key    TEXT,
  notes           TEXT,
  recorded_by     UUID        REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pspe_job_id   ON production_stage_progress_entries (job_id);
CREATE INDEX IF NOT EXISTS idx_pspe_stage_id ON production_stage_progress_entries (stage_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4.  updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _pjs_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_pjs_updated_at ON production_job_stages;
CREATE TRIGGER trg_pjs_updated_at
  BEFORE UPDATE ON production_job_stages
  FOR EACH ROW EXECUTE FUNCTION _pjs_set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5.  RPC: create_job_stages
--     Helper — idempotent (ON CONFLICT DO NOTHING).
--     Called by the auto-trigger and by the backfill below.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_job_stages(
  p_job_id          UUID,
  p_planned_quantity INTEGER
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO production_job_stages
    (job_id, stage_key, stage_label, sort_order, planned_quantity)
  VALUES
    (p_job_id, 'materials', 'Materials Preparation',        1, p_planned_quantity),
    (p_job_id, 'assembly',  'Cutting / Joining / Assembly', 2, p_planned_quantity),
    (p_job_id, 'sanding',   'Sanding',                      3, p_planned_quantity),
    (p_job_id, 'finishing', 'Finishing / Painting',         4, p_planned_quantity),
    (p_job_id, 'packaging', 'Packaging',                    5, p_planned_quantity)
  ON CONFLICT (job_id, stage_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION create_job_stages(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_job_stages(UUID, INTEGER) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6.  Trigger: auto-create stage rows for every new production job
--     Replaces the need to modify create_production_plan or
--     create_production_job — those RPCs remain untouched.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _auto_create_job_stages()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM create_job_stages(NEW.id, NEW.planned_quantity);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_create_job_stages ON production_jobs;
CREATE TRIGGER trg_auto_create_job_stages
  AFTER INSERT ON production_jobs
  FOR EACH ROW EXECUTE FUNCTION _auto_create_job_stages();


-- ─────────────────────────────────────────────────────────────────────────────
-- 7.  RPC: confirm_materials_prepared
--     Records that N units of materials are confirmed ready.
--     Materials stage only — does not touch job qty buckets.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION confirm_materials_prepared(
  p_job_id       UUID,
  p_stage_id     UUID,
  p_quantity     INTEGER,
  p_employee_id  UUID    DEFAULT NULL,
  p_notes        TEXT    DEFAULT NULL,
  p_recorded_by  UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stage production_job_stages;
  v_available INTEGER;
  v_new_completed INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Require actor
  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer';
  END IF;

  -- Validate employee if supplied
  IF p_employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND is_active = TRUE) THEN
      RAISE EXCEPTION 'Employee % not found or inactive', p_employee_id;
    END IF;
  END IF;

  -- Lock the stage row
  SELECT * INTO v_stage
  FROM production_job_stages
  WHERE id = p_stage_id AND job_id = p_job_id AND stage_key = 'materials'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Materials stage not found for this job';
  END IF;
  IF NOT v_stage.is_enabled THEN
    RAISE EXCEPTION 'Materials stage is disabled for this job';
  END IF;
  IF v_stage.status = 'skipped' THEN
    RAISE EXCEPTION 'Materials stage has been skipped';
  END IF;

  v_available := v_stage.planned_quantity - v_stage.completed_quantity;
  IF p_quantity > v_available THEN
    RAISE EXCEPTION 'Cannot confirm % units — only % remain (planned % - completed %)',
      p_quantity, v_available, v_stage.planned_quantity, v_stage.completed_quantity;
  END IF;

  v_new_completed := v_stage.completed_quantity + p_quantity;

  UPDATE production_job_stages SET
    completed_quantity = v_new_completed,
    status = CASE
      WHEN v_new_completed >= planned_quantity THEN 'completed'
      ELSE 'active'
    END,
    started_at  = COALESCE(started_at, v_now),
    started_by  = COALESCE(started_by, p_recorded_by),
    completed_at = CASE WHEN v_new_completed >= planned_quantity THEN v_now ELSE completed_at END,
    completed_by = CASE WHEN v_new_completed >= planned_quantity THEN p_recorded_by ELSE completed_by END
  WHERE id = p_stage_id;

  -- Advance job status to Materials Ready only when all materials are confirmed.
  -- Partial confirmations do not change job status — workers cannot start
  -- assembly until the full planned_quantity of materials is ready.
  IF v_new_completed >= v_stage.planned_quantity THEN
    UPDATE production_jobs SET
      status = 'Materials Ready'
    WHERE id = p_job_id
      AND status IN ('Planned', 'Awaiting Materials');
  END IF;

  INSERT INTO production_stage_progress_entries
    (job_id, stage_id, event_type, quantity, employee_id, notes, recorded_by)
  VALUES
    (p_job_id, p_stage_id, 'materials_prepared', p_quantity, p_employee_id, p_notes, p_recorded_by);
END;
$$;

REVOKE ALL ON FUNCTION confirm_materials_prepared(UUID,UUID,INTEGER,UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_materials_prepared(UUID,UUID,INTEGER,UUID,TEXT,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8.  RPC: advance_stage
--     Records that N units have completed a production stage.
--
--     Stage-specific job-qty changes:
--       assembly  → in_production_qty += N (units entering the workshop)
--       finishing → in_production_qty -= N, awaiting_qc_qty += N (submit to QC)
--       packaging → checks job completion (see below)
--       others    → no job qty change
--
--     Rework downstream model:
--       complete_stage_rework() increments completed_quantity, making
--       rework-re-passed units visible to downstream stages through the
--       normal formula:  available = prev.completed_quantity - this.completed_quantity
--       (since completed_quantity can exceed planned_quantity after rework).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION advance_stage(
  p_job_id        UUID,
  p_stage_id      UUID,
  p_quantity      INTEGER,
  p_operation_id  UUID    DEFAULT NULL,
  p_employee_id   UUID    DEFAULT NULL,
  p_notes         TEXT    DEFAULT NULL,
  p_recorded_by   UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stage         production_job_stages;
  v_job           production_jobs;
  v_prev_stage    production_job_stages;
  v_mat_stage     production_job_stages;
  v_available     INTEGER;
  v_new_completed INTEGER;
  v_now           TIMESTAMPTZ := NOW();
BEGIN
  -- ── Basic guards ──────────────────────────────────────────────────────────

  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer';
  END IF;

  -- Validate employee if supplied
  IF p_employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND is_active = TRUE) THEN
      RAISE EXCEPTION 'Employee % not found or inactive', p_employee_id;
    END IF;
  END IF;

  -- Operation validation is deferred until after we know v_stage.stage_key.
  -- A single consolidated check (active + correct stage) runs below, after
  -- the stage row is locked. No early partial check to avoid misleading errors.

  -- ── Lock job and stage rows ───────────────────────────────────────────────

  SELECT * INTO v_job
  FROM production_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.status IN ('Cancelled', 'Completed') THEN
    RAISE EXCEPTION 'Cannot record progress on a % job', v_job.status;
  END IF;

  SELECT * INTO v_stage
  FROM production_job_stages
  WHERE id = p_stage_id AND job_id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found for this job';
  END IF;

  IF NOT v_stage.is_enabled THEN
    RAISE EXCEPTION 'Stage "%" is disabled for this job', v_stage.stage_label;
  END IF;

  IF v_stage.status = 'skipped' THEN
    RAISE EXCEPTION 'Stage "%" has been skipped', v_stage.stage_label;
  END IF;

  -- operation_id is mandatory for hands-on production stages
  IF v_stage.stage_key IN ('assembly', 'sanding', 'finishing') AND p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required for stage "%"', v_stage.stage_label;
  END IF;

  -- Validate operation belongs to this stage (now we know stage_key)
  IF p_operation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM production_operations
      WHERE id = p_operation_id
        AND stage_key = v_stage.stage_key
        AND is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'Operation % does not belong to stage "%" or is inactive',
        p_operation_id, v_stage.stage_label;
    END IF;
  END IF;

  -- ── Compute available quantity ────────────────────────────────────────────
  --
  -- Packaging draws from accepted_qty (not the previous production stage).
  -- All other stages: available = prev_enabled_stage.completed - this.completed
  -- For assembly (first mandatory production stage): available = planned - completed
  --   (but also capped so completed doesn't exceed planned on first pass;
  --    rework re-passes are handled by complete_stage_rework, not advance_stage)

  IF v_stage.stage_key = 'packaging' THEN
    v_available := v_job.accepted_qty - v_stage.completed_quantity;

  ELSIF v_stage.stage_key = 'assembly' THEN
    -- Assembly is the first mandatory production stage.
    -- Base availability: planned - already completed (first-pass units only).
    v_available := v_stage.planned_quantity - v_stage.completed_quantity;

    -- Materials gate: if the Materials stage is enabled for this job, workers
    -- cannot start assembly on materials that haven't been confirmed yet.
    -- Cap v_available to what has actually been prepared.
    SELECT * INTO v_mat_stage
    FROM production_job_stages
    WHERE job_id = p_job_id AND stage_key = 'materials' AND is_enabled = TRUE;

    IF FOUND THEN
      v_available := LEAST(v_available,
                           v_mat_stage.completed_quantity - v_stage.completed_quantity);
    END IF;

  ELSE
    -- sanding, finishing: draw from the nearest enabled predecessor
    SELECT * INTO v_prev_stage
    FROM production_job_stages
    WHERE job_id = p_job_id
      AND sort_order < v_stage.sort_order
      AND is_enabled = TRUE
      AND stage_key != 'materials'   -- materials is not a source for production stages
    ORDER BY sort_order DESC
    LIMIT 1;

    IF v_prev_stage IS NULL THEN
      -- No enabled predecessor (shouldn't happen since assembly is mandatory)
      v_available := v_stage.planned_quantity - v_stage.completed_quantity;
    ELSE
      -- completed_quantity in prev can exceed planned_quantity due to rework
      v_available := v_prev_stage.completed_quantity - v_stage.completed_quantity;
    END IF;

    -- Finishing is additionally capped by in_production_qty
    IF v_stage.stage_key = 'finishing' THEN
      v_available := LEAST(v_available, v_job.in_production_qty);
    END IF;
  END IF;

  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'Cannot advance % units through "%" — only % available',
      p_quantity, v_stage.stage_label, v_available;
  END IF;

  v_new_completed := v_stage.completed_quantity + p_quantity;

  -- ── Stage-specific job qty mutations ─────────────────────────────────────

  CASE v_stage.stage_key

    WHEN 'assembly' THEN
      -- Units enter the production pipeline
      UPDATE production_jobs SET
        in_production_qty = in_production_qty + p_quantity,
        status = CASE
          WHEN status IN ('Planned','Awaiting Materials','Materials Ready')
          THEN 'In Production'
          ELSE status
        END,
        actual_start = COALESCE(actual_start, v_now),
        updated_at = v_now
      WHERE id = p_job_id;

      -- Mirror into legacy progress ledger so the QC audit trail stays intact.
      INSERT INTO production_progress_entries (job_id, transition, quantity, notes, recorded_by)
      VALUES (p_job_id, 'start', p_quantity, p_notes, p_recorded_by);

    WHEN 'finishing' THEN
      -- Completing finishing = submit to QC
      UPDATE production_jobs SET
        in_production_qty = in_production_qty - p_quantity,
        awaiting_qc_qty   = awaiting_qc_qty   + p_quantity,
        status = CASE
          WHEN in_production_qty - p_quantity = 0 THEN 'Quality Control'
          ELSE status
        END,
        updated_at = v_now
      WHERE id = p_job_id;

      -- Mirror into legacy progress ledger.
      INSERT INTO production_progress_entries (job_id, transition, quantity, notes, recorded_by)
      VALUES (p_job_id, 'submit_qc', p_quantity, p_notes, p_recorded_by);

    WHEN 'packaging' THEN
      -- Check job completion: all units accounted for and packaged
      IF (v_new_completed >= v_job.accepted_qty)
        AND (v_job.awaiting_qc_qty = 0)
        AND (v_job.rework_qty      = 0)
        AND (v_job.in_production_qty = 0)
        AND (v_job.accepted_qty + v_job.scrapped_qty >= v_job.planned_quantity)
      THEN
        UPDATE production_jobs SET
          status       = 'Completed',
          completed_at = v_now,
          actual_finish = v_now,
          updated_at   = v_now
        WHERE id = p_job_id;
      END IF;

    ELSE
      -- materials, sanding: no job qty change
      NULL;
  END CASE;

  -- ── Update stage row ──────────────────────────────────────────────────────
  --
  -- Stage is cleared when all original units AND all rework units have
  -- passed through: completed >= planned + rework_received

  UPDATE production_job_stages SET
    completed_quantity = v_new_completed,
    status = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN 'completed'
      ELSE 'active'
    END,
    started_at   = COALESCE(started_at, v_now),
    started_by   = COALESCE(started_by, p_recorded_by),
    completed_at = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN v_now ELSE completed_at
    END,
    completed_by = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN p_recorded_by ELSE completed_by
    END
  WHERE id = p_stage_id;

  -- ── Event ledger ──────────────────────────────────────────────────────────

  INSERT INTO production_stage_progress_entries
    (job_id, stage_id, event_type, quantity, operation_id, employee_id, notes, recorded_by)
  VALUES
    (p_job_id, p_stage_id, 'advance', p_quantity,
     p_operation_id, p_employee_id, p_notes, p_recorded_by);
END;
$$;

REVOKE ALL ON FUNCTION advance_stage(UUID,UUID,INTEGER,UUID,UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_stage(UUID,UUID,INTEGER,UUID,UUID,TEXT,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9.  RPC: route_rework_to_stage
--     QC decision: send N awaiting-QC units to a specific stage for rework.
--     Atomically updates job qty buckets AND stage rework counters.
--     Use this instead of record_job_progress('rework') when stages are active.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION route_rework_to_stage(
  p_job_id       UUID,
  p_stage_key    TEXT,
  p_quantity     INTEGER,
  p_notes        TEXT    DEFAULT NULL,
  p_recorded_by  UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_job   production_jobs;
  v_stage production_job_stages;
  v_role  TEXT;
BEGIN
  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer';
  END IF;

  -- Role check: rework is a QC decision
  SELECT role INTO v_role FROM user_profiles WHERE id = p_recorded_by;
  IF v_role NOT IN ('admin', 'production_manager') THEN
    RAISE EXCEPTION 'Routing rework requires admin or production_manager role';
  END IF;

  -- Lock job row
  SELECT * INTO v_job FROM production_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  IF v_job.awaiting_qc_qty < p_quantity THEN
    RAISE EXCEPTION 'Cannot rework % units — only % awaiting QC',
      p_quantity, v_job.awaiting_qc_qty;
  END IF;

  -- Lock destination stage
  SELECT * INTO v_stage
  FROM production_job_stages
  WHERE job_id = p_job_id AND stage_key = p_stage_key FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage "%" not found for this job', p_stage_key;
  END IF;

  IF NOT v_stage.is_enabled THEN
    RAISE EXCEPTION 'Stage "%" is disabled — cannot route rework there', p_stage_key;
  END IF;

  -- Job qty: awaiting_qc → rework
  UPDATE production_jobs SET
    awaiting_qc_qty = awaiting_qc_qty - p_quantity,
    rework_qty      = rework_qty      + p_quantity,
    status = CASE
      WHEN status = 'Quality Control' AND awaiting_qc_qty - p_quantity = 0
      THEN 'In Production'
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = p_job_id;

  -- Stage rework credit
  UPDATE production_job_stages SET
    rework_received_quantity = rework_received_quantity + p_quantity,
    status = 'active'   -- reactivate if previously completed
  WHERE id = v_stage.id;

  -- Legacy progress entry (keeps existing audit trail intact)
  INSERT INTO production_progress_entries (job_id, transition, quantity, notes, recorded_by)
  VALUES (p_job_id, 'rework', p_quantity, p_notes, p_recorded_by);

  -- Stage event ledger
  INSERT INTO production_stage_progress_entries
    (job_id, stage_id, event_type, quantity, from_stage_key, to_stage_key, notes, recorded_by)
  VALUES
    (p_job_id, v_stage.id, 'rework_received', p_quantity,
     'qc', p_stage_key, p_notes, p_recorded_by);
END;
$$;

REVOKE ALL ON FUNCTION route_rework_to_stage(UUID,TEXT,INTEGER,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_rework_to_stage(UUID,TEXT,INTEGER,TEXT,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10.  RPC: complete_stage_rework
--      Worker has finished rework on N units at a stage.
--      Rework-re-passed units are credited to completed_quantity so that
--      downstream stages see them as available via the standard formula:
--        available(next) = prev.completed_quantity − next.completed_quantity
--      Since completed_quantity can exceed planned_quantity after rework,
--      no separate counter is needed.
--
--      Job qty: rework_qty -= N, in_production_qty += N
--      (units re-enter the production pipeline; they will advance through
--       any remaining downstream stages before Finishing submits to QC again)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION complete_stage_rework(
  p_job_id       UUID,
  p_stage_id     UUID,
  p_quantity     INTEGER,
  p_operation_id UUID    DEFAULT NULL,
  p_employee_id  UUID    DEFAULT NULL,
  p_notes        TEXT    DEFAULT NULL,
  p_recorded_by  UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stage     production_job_stages;
  v_job       production_jobs;
  v_available INTEGER;
  v_new_completed        INTEGER;
  v_new_rework_completed INTEGER;
  v_now       TIMESTAMPTZ := NOW();
BEGIN
  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer';
  END IF;

  IF p_employee_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee_id AND is_active = TRUE) THEN
      RAISE EXCEPTION 'Employee % not found or inactive', p_employee_id;
    END IF;
  END IF;

  SELECT * INTO v_job   FROM production_jobs WHERE id = p_job_id FOR UPDATE;
  SELECT * INTO v_stage FROM production_job_stages WHERE id = p_stage_id AND job_id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage not found for this job';
  END IF;

  -- operation_id is mandatory when rework returns through a hands-on production stage
  IF v_stage.stage_key IN ('assembly', 'sanding', 'finishing') AND p_operation_id IS NULL THEN
    RAISE EXCEPTION 'operation_id is required for rework at stage "%"', v_stage.stage_label;
  END IF;

  -- Validate operation belongs to THIS stage (checked after stage lock so stage_key is known)
  IF p_operation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM production_operations
      WHERE id = p_operation_id
        AND stage_key = v_stage.stage_key
        AND is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'Operation % does not belong to stage "%" or is inactive',
        p_operation_id, v_stage.stage_label;
    END IF;
  END IF;

  v_available := v_stage.rework_received_quantity - v_stage.rework_completed_quantity;

  IF v_available < p_quantity THEN
    RAISE EXCEPTION 'Cannot complete rework on % units — only % rework units outstanding at "%"',
      p_quantity, v_available, v_stage.stage_label;
  END IF;

  v_new_rework_completed := v_stage.rework_completed_quantity + p_quantity;
  -- Key: completed_quantity also advances so downstream stages see availability
  v_new_completed := v_stage.completed_quantity + p_quantity;

  -- Units leave rework bucket and re-enter production
  UPDATE production_jobs SET
    rework_qty        = rework_qty        - p_quantity,
    in_production_qty = in_production_qty + p_quantity,
    status = CASE
      WHEN status NOT IN ('In Production') THEN 'In Production'
      ELSE status
    END,
    updated_at = v_now
  WHERE id = p_job_id;

  -- Update stage: completed_quantity includes rework re-pass
  -- Stage is cleared when: completed >= planned + rework_received
  UPDATE production_job_stages SET
    rework_completed_quantity = v_new_rework_completed,
    completed_quantity        = v_new_completed,
    status = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN 'completed'
      ELSE status
    END,
    completed_at = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN v_now ELSE completed_at
    END,
    completed_by = CASE
      WHEN v_new_completed >= (planned_quantity + rework_received_quantity)
      THEN p_recorded_by ELSE completed_by
    END
  WHERE id = p_stage_id;

  -- Legacy progress entry (rework_start = units re-entering production)
  INSERT INTO production_progress_entries (job_id, transition, quantity, notes, recorded_by)
  VALUES (p_job_id, 'rework_start', p_quantity, p_notes, p_recorded_by);

  -- Stage event ledger
  INSERT INTO production_stage_progress_entries
    (job_id, stage_id, event_type, quantity, operation_id, employee_id, notes, recorded_by)
  VALUES
    (p_job_id, p_stage_id, 'rework_completed', p_quantity,
     p_operation_id, p_employee_id, p_notes, p_recorded_by);
END;
$$;

REVOKE ALL ON FUNCTION complete_stage_rework(UUID,UUID,INTEGER,UUID,UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_stage_rework(UUID,UUID,INTEGER,UUID,UUID,TEXT,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 11.  RPC: toggle_job_stage
--      Enable or disable a configurable stage.
--      Locked once any qty movement is recorded.
--      MANDATORY stages that cannot be disabled: assembly, finishing, packaging.
--      SKIPPABLE stages (manager can disable before movement): materials, sanding.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION toggle_job_stage(
  p_job_id     UUID,
  p_stage_key  TEXT,
  p_is_enabled BOOLEAN,
  p_toggled_by UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stage production_job_stages;
BEGIN
  SELECT * INTO v_stage
  FROM production_job_stages
  WHERE job_id = p_job_id AND stage_key = p_stage_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage "%" not found for this job', p_stage_key;
  END IF;

  -- Mandatory stages cannot be disabled
  IF p_stage_key IN ('assembly', 'finishing', 'packaging') AND NOT p_is_enabled THEN
    RAISE EXCEPTION '"%" is a mandatory stage and cannot be disabled',
      v_stage.stage_label;
  END IF;

  -- Lock after movement has started
  IF v_stage.completed_quantity > 0 OR v_stage.rework_received_quantity > 0 THEN
    RAISE EXCEPTION 'Stage "%" cannot be changed once qty movement has been recorded',
      v_stage.stage_label;
  END IF;

  UPDATE production_job_stages SET
    is_enabled = p_is_enabled,
    status = CASE
      WHEN NOT p_is_enabled THEN 'skipped'
      ELSE 'not_started'
    END
  WHERE id = v_stage.id;

  IF NOT p_is_enabled THEN
    INSERT INTO production_stage_progress_entries
      (job_id, stage_id, event_type, recorded_by)
    VALUES
      (p_job_id, v_stage.id, 'stage_skipped', p_toggled_by);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION toggle_job_stage(UUID,TEXT,BOOLEAN,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION toggle_job_stage(UUID,TEXT,BOOLEAN,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 12.  RPC: reopen_stage
--      Admin/manager only: revert a completed or skipped stage back to active.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION reopen_stage(
  p_job_id      UUID,
  p_stage_key   TEXT,
  p_notes       TEXT  DEFAULT NULL,
  p_recorded_by UUID  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stage production_job_stages;
  v_role  TEXT;
BEGIN
  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  -- Role check via user_profiles (consistent with record_job_progress)
  SELECT role INTO v_role FROM user_profiles WHERE id = p_recorded_by;
  IF v_role NOT IN ('admin', 'production_manager') THEN
    RAISE EXCEPTION 'Only admin or production_manager can reopen stages';
  END IF;

  SELECT * INTO v_stage
  FROM production_job_stages
  WHERE job_id = p_job_id AND stage_key = p_stage_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stage "%" not found for this job', p_stage_key;
  END IF;

  UPDATE production_job_stages SET
    status       = 'active',
    is_enabled   = TRUE,
    completed_at = NULL,
    completed_by = NULL
  WHERE id = v_stage.id;

  INSERT INTO production_stage_progress_entries
    (job_id, stage_id, event_type, notes, recorded_by)
  VALUES
    (p_job_id, v_stage.id, 'stage_reopened', p_notes, p_recorded_by);
END;
$$;

REVOKE ALL ON FUNCTION reopen_stage(UUID,TEXT,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reopen_stage(UUID,TEXT,TEXT,UUID) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 13.  Update record_job_progress — defer job completion to Packaging stage
--
--      The 'accept' transition previously auto-completed the job when
--      accepted_qty reached planned_quantity.  With stage tracking active,
--      job completion is instead triggered by advance_stage(packaging).
--      We suppress auto-complete when an enabled packaging stage exists.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_job              RECORD;
  v_role             text;
  v_not_started      integer;
  v_has_pkg_stage    boolean;
  v_has_stages       boolean;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id is required';
  END IF;

  IF p_recorded_by IS NULL THEN
    RAISE EXCEPTION 'p_recorded_by is required';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer, got %', p_quantity;
  END IF;

  IF p_transition NOT IN ('start','submit_qc','accept','rework','rework_start','scrap') THEN
    RAISE EXCEPTION 'Unknown transition: %', p_transition;
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = p_recorded_by;

  IF NOT FOUND OR v_role IS NULL THEN
    RAISE EXCEPTION 'User % was not found in user_profiles or has no role', p_recorded_by;
  END IF;

  IF p_transition IN ('accept', 'rework', 'scrap') THEN
    IF v_role NOT IN ('admin', 'production_manager') THEN
      RAISE EXCEPTION 'Transition "%" requires admin or production_manager role; caller role is "%"',
        p_transition, v_role;
    END IF;
  ELSE
    IF v_role NOT IN ('admin', 'production_manager', 'production_staff') THEN
      RAISE EXCEPTION 'Transition "%" requires a production role; caller role is "%"',
        p_transition, v_role;
    END IF;
  END IF;

  SELECT * INTO v_job FROM public.production_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production job % not found', p_job_id;
  END IF;

  IF v_job.status = 'Cancelled' THEN
    RAISE EXCEPTION 'Cannot record progress on a cancelled job';
  END IF;

  IF v_job.status = 'Completed' THEN
    RAISE EXCEPTION 'Job % is already completed', p_job_id;
  END IF;

  -- ── Stage-tracking guard ──────────────────────────────────────────────────
  --
  -- When production_job_stages rows exist, the stage RPCs own all qty movement
  -- for start/submit_qc/rework/rework_start transitions.  Allowing those same
  -- transitions here would double-count units in the qty buckets.
  -- Callers must use the dedicated stage RPCs instead:
  --   start        → advance_stage(assembly stage)
  --   submit_qc    → advance_stage(finishing stage)
  --   rework       → route_rework_to_stage
  --   rework_start → complete_stage_rework
  --
  -- 'accept' and 'scrap' are still handled here (they are QC decisions, not
  -- production-stage decisions, and stage RPCs do not own them).

  SELECT EXISTS(
    SELECT 1 FROM production_job_stages WHERE job_id = p_job_id LIMIT 1
  ) INTO v_has_stages;

  IF v_has_stages AND p_transition IN ('start', 'submit_qc', 'rework', 'rework_start') THEN
    RAISE EXCEPTION
      'Stage tracking is active for this job. Use the stage RPCs instead: '
      'start → advance_stage(assembly), submit_qc → advance_stage(finishing), '
      'rework → route_rework_to_stage, rework_start → complete_stage_rework';
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
        RAISE EXCEPTION 'Cannot start % units: only % units have not been started',
          p_quantity, v_not_started;
      END IF;

    WHEN 'submit_qc' THEN
      IF p_quantity > v_job.in_production_qty THEN
        RAISE EXCEPTION 'Cannot submit % units to QC: only % are in production',
          p_quantity, v_job.in_production_qty;
      END IF;

    WHEN 'accept' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION 'Cannot accept % units: only % are awaiting QC',
          p_quantity, v_job.awaiting_qc_qty;
      END IF;

    WHEN 'rework' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION 'Cannot send % units to rework: only % are awaiting QC',
          p_quantity, v_job.awaiting_qc_qty;
      END IF;

    WHEN 'rework_start' THEN
      IF p_quantity > v_job.rework_qty THEN
        RAISE EXCEPTION 'Cannot restart % units: only % are in rework',
          p_quantity, v_job.rework_qty;
      END IF;

    WHEN 'scrap' THEN
      IF p_quantity > v_job.awaiting_qc_qty THEN
        RAISE EXCEPTION 'Cannot scrap % units: only % are awaiting QC',
          p_quantity, v_job.awaiting_qc_qty;
      END IF;
  END CASE;

  -- ── Apply the bucket change ───────────────────────────────────────────────

  -- For 'accept': check whether an enabled packaging stage exists.
  -- If it does, job completion is deferred to advance_stage(packaging).
  IF p_transition = 'accept' THEN
    SELECT EXISTS (
      SELECT 1 FROM production_job_stages
      WHERE job_id = p_job_id AND stage_key = 'packaging' AND is_enabled = TRUE
    ) INTO v_has_pkg_stage;
  END IF;

  CASE p_transition
    WHEN 'start' THEN
      UPDATE public.production_jobs SET
        in_production_qty = in_production_qty + p_quantity,
        status = CASE
          WHEN status IN ('Planned','Awaiting Materials','Materials Ready')
          THEN 'In Production'
          ELSE status
        END,
        actual_start = COALESCE(actual_start, now()),
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'submit_qc' THEN
      UPDATE public.production_jobs SET
        in_production_qty = in_production_qty - p_quantity,
        awaiting_qc_qty   = awaiting_qc_qty   + p_quantity,
        status = CASE
          WHEN status = 'In Production' THEN 'Quality Control'
          ELSE status
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'accept' THEN
      UPDATE public.production_jobs SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        accepted_qty    = accepted_qty    + p_quantity,
        -- Only auto-complete if there is NO enabled packaging stage.
        -- With stages active, advance_stage(packaging) triggers completion.
        status = CASE
          WHEN (accepted_qty + p_quantity >= planned_quantity) AND NOT v_has_pkg_stage
          THEN 'Completed'
          ELSE status
        END,
        actual_finish = CASE
          WHEN (accepted_qty + p_quantity >= planned_quantity) AND NOT v_has_pkg_stage
          THEN now() ELSE actual_finish
        END,
        completed_at = CASE
          WHEN (accepted_qty + p_quantity >= planned_quantity) AND NOT v_has_pkg_stage
          THEN now() ELSE completed_at
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'rework' THEN
      UPDATE public.production_jobs SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        rework_qty      = rework_qty      + p_quantity,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'rework_start' THEN
      UPDATE public.production_jobs SET
        rework_qty        = rework_qty        - p_quantity,
        in_production_qty = in_production_qty + p_quantity,
        status = CASE
          WHEN status = 'Quality Control' THEN 'In Production'
          ELSE status
        END,
        updated_at = now()
      WHERE id = p_job_id;

    WHEN 'scrap' THEN
      UPDATE public.production_jobs SET
        awaiting_qc_qty = awaiting_qc_qty - p_quantity,
        scrapped_qty    = scrapped_qty    + p_quantity,
        updated_at = now()
      WHERE id = p_job_id;
  END CASE;

  -- ── Append the log entry ──────────────────────────────────────────────────

  INSERT INTO public.production_progress_entries (job_id, transition, quantity, notes, recorded_by)
  VALUES (p_job_id, p_transition, p_quantity, NULLIF(btrim(p_notes), ''), p_recorded_by);

END;
$$;

REVOKE ALL ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.record_job_progress(uuid, text, integer, text, uuid)
  IS 'Records a qty transition on a production job. When an enabled packaging stage exists the "accept" transition no longer auto-completes the job — completion is deferred to advance_stage(packaging).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 14.  RLS policies
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_job_stages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_stage_progress_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read stages"   ON production_job_stages;
DROP POLICY IF EXISTS "service_role all stages"     ON production_job_stages;
DROP POLICY IF EXISTS "authenticated read stage events" ON production_stage_progress_entries;
DROP POLICY IF EXISTS "service_role all stage events"   ON production_stage_progress_entries;

CREATE POLICY "authenticated read stages"
  ON production_job_stages FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "service_role all stages"
  ON production_job_stages FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY "authenticated read stage events"
  ON production_stage_progress_entries FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "service_role all stage events"
  ON production_stage_progress_entries FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);


-- ─────────────────────────────────────────────────────────────────────────────
-- 15.  Backfill: create stage rows only for jobs not yet in production
--      Jobs already In Production / QC / Completed / Cancelled are excluded
--      to avoid making them appear un-started from a stage perspective.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, planned_quantity
    FROM production_jobs
    WHERE status IN ('Planned', 'Awaiting Materials', 'Materials Ready')
  LOOP
    PERFORM create_job_stages(r.id, r.planned_quantity);
  END LOOP;
END;
$$;


COMMIT;
