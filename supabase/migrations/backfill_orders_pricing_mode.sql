-- Migration: backfill pre-CRM orders to vat_inclusive
--
-- All orders created before the CRM quote flow were entered with VAT-inclusive
-- unit prices (gross figures). The original migration defaulted pricing_mode to
-- 'none', which is incorrect for those records. This migration corrects them and
-- updates the column default so new orders start as vat_inclusive.

-- 1. Flip all existing 'none' orders to 'vat_inclusive'
UPDATE orders
SET pricing_mode = 'vat_inclusive'
WHERE pricing_mode = 'none';

-- 2. Change the column default so future inserts start as vat_inclusive
ALTER TABLE orders
  ALTER COLUMN pricing_mode SET DEFAULT 'vat_inclusive';

-- NOTE: quotations.pricing_mode is intentionally left unchanged.
-- The quotations CHECK constraint does not allow 'none', and new CRM quotes
-- default to 'vat_exclusive' — that is the correct behaviour for CRM-originated quotes.
