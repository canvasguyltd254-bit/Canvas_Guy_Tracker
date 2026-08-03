-- Migration: add pricing_mode to orders
-- Allows direct orders to specify VAT treatment, matching the CRM quote flow.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (pricing_mode IN ('none', 'vat_exclusive', 'vat_inclusive'));

COMMENT ON COLUMN orders.pricing_mode IS
  'none = unit_price × qty (no VAT), vat_exclusive = net prices (VAT added on top), vat_inclusive = gross prices (VAT back-calculated)';
