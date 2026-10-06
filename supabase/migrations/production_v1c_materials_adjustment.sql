-- ─────────────────────────────────────────────────────────────────────────────
-- Production V1C — material estimate adjustment column
--
-- Adds adjustment_quantity to production_material_estimates so managers can
-- apply a manual delta (positive = need more, negative = reduce) on top of the
-- formula-computed estimated_quantity before the job goes to QC.
--
-- The column is nullable; NULL and 0 both mean "no adjustment".
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.production_material_estimates
  ADD COLUMN IF NOT EXISTS adjustment_quantity numeric DEFAULT 0;

COMMENT ON COLUMN public.production_material_estimates.adjustment_quantity
  IS 'Manual quantity delta applied on top of estimated_quantity. Positive = need more; negative = reduce. NULL treated as 0.';

COMMIT;
