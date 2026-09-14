-- Migration: backfill orders where pricing_mode IS NULL
--
-- The previous backfill (backfill_orders_pricing_mode.sql) targeted rows where
-- pricing_mode = 'none', but missed rows where the column was left NULL.
-- These are legacy direct orders entered before pricing_mode existed; their
-- unit prices are VAT-inclusive, matching the 'vat_inclusive' semantics.
--
-- SCOPE: direct orders only (quote_id IS NULL). CRM-originated orders that
-- have a quote_id inherit pricing_mode from their quotation, so they are
-- left unchanged even if the orders row is somehow NULL.

BEGIN;

UPDATE public.orders
SET
  pricing_mode = 'vat_inclusive',
  updated_at   = now()
WHERE pricing_mode IS NULL
  AND quote_id IS NULL;

-- Ensure the column default covers any edge case where the NOT NULL
-- constraint is not present (the CHECK constraint allows NULL on some
-- older schema versions; the default closes that gap going forward).
ALTER TABLE public.orders
  ALTER COLUMN pricing_mode SET DEFAULT 'vat_inclusive';

COMMIT;
