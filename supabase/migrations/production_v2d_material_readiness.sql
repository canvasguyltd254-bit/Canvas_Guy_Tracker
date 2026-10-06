-- ============================================================================
-- Canvas Guy Tracker — Production v2d: per-line material readiness
--
-- Until now the tracker only held ESTIMATES (what a job needs) and a
-- quantity-based "materials prepared" stage. Nothing recorded whether a given
-- material line is actually in hand, so a shortage could not be shown or
-- printed. This adds a per-line flag, set by the workshop:
--   unchecked (default) | ready | short
-- plus an optional note for short lines. A short line does NOT block a job by
-- itself — the attention helper reports "short with no blocker raised" until a
-- manager raises a blocker with an owner and expected date.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.production_material_estimates
  ADD COLUMN IF NOT EXISTS readiness            text        NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS short_note           text,
  ADD COLUMN IF NOT EXISTS readiness_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS readiness_updated_by uuid;

ALTER TABLE public.production_material_estimates
  DROP CONSTRAINT IF EXISTS production_material_estimates_readiness_check;
ALTER TABLE public.production_material_estimates
  ADD  CONSTRAINT production_material_estimates_readiness_check
  CHECK (readiness IN ('unchecked','ready','short'));

CREATE INDEX IF NOT EXISTS idx_pme_short
  ON public.production_material_estimates (job_id) WHERE readiness = 'short';

COMMIT;
