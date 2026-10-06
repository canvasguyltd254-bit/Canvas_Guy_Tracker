-- ============================================================================
-- production_v2f_material_actuals.sql
--
-- The tracker held only ESTIMATES. This adds what was actually used, per
-- material line, so the internal pack can show estimate vs actual:
--   issued_quantity    quantity actually issued to the job (same unit as the line)
--   actual_unit_cost   optional unit cost entered by a manager
-- Actual cost = issued_quantity x actual_unit_cost. Either missing => the pack
-- prints "Not recorded" (never 0). Single latest value per line (advisory,
-- no history). Written only by the manager-only route; readable only by
-- managers (the workshop readiness endpoint never selects these columns).
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.production_material_estimates
  ADD COLUMN IF NOT EXISTS issued_quantity   numeric,
  ADD COLUMN IF NOT EXISTS actual_unit_cost  numeric,
  ADD COLUMN IF NOT EXISTS actuals_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS actuals_updated_by uuid;

ALTER TABLE public.production_material_estimates
  DROP CONSTRAINT IF EXISTS production_material_estimates_actuals_check;
ALTER TABLE public.production_material_estimates
  ADD  CONSTRAINT production_material_estimates_actuals_check
  CHECK ((issued_quantity IS NULL OR issued_quantity >= 0)
     AND (actual_unit_cost IS NULL OR actual_unit_cost >= 0));

COMMIT;
