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

-- 3. Same treatment for quotations — pre-CRM quotes were also VAT-inclusive
UPDATE quotations
SET pricing_mode = 'vat_inclusive'
WHERE pricing_mode = 'none' OR pricing_mode IS NULL;

-- Quotations table may have been created with a different default; ensure consistency
ALTER TABLE quotations
  ALTER COLUMN pricing_mode SET DEFAULT 'vat_inclusive';
