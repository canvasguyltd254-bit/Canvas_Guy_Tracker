-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration J: Recompute order totals from order_items
--
-- Run AFTER quotes_crm_migration_i.sql.
--
-- Problem:
--   For some converted orders, order.total_value was stored as the
--   NET subtotal (e.g. 110,689.65) instead of the GROSS total
--   (e.g. 128,400). This happened because v_quote.total was
--   incorrectly stored in the original quotation.
--
--   subtotal_amount and vat_amount may also be stale.
--
-- Fix:
--   Recompute all three amounts from the actual order_items rows,
--   which were already corrected by Migrations G–I.
--   Only touches orders that came from a quotation (quote_id IS NOT NULL).
-- ============================================================

BEGIN;

UPDATE orders o
SET
  subtotal_amount = ROUND((
    SELECT COALESCE(SUM(oi.net_amount), 0)
    FROM order_items oi WHERE oi.order_id = o.id
  )::numeric, 2),

  vat_amount = ROUND((
    SELECT COALESCE(SUM(oi.vat_amount), 0)
    FROM order_items oi WHERE oi.order_id = o.id
  )::numeric, 2),

  total_value = ROUND((
    SELECT COALESCE(SUM(oi.gross_amount), 0)
    FROM order_items oi WHERE oi.order_id = o.id
  )::numeric, 2)

WHERE o.quote_id IS NOT NULL
  -- Only touch rows where total_value differs from the sum of gross_amounts
  AND ABS(o.total_value - COALESCE((
    SELECT SUM(oi.gross_amount)
    FROM order_items oi WHERE oi.order_id = o.id
  ), 0)) > 0.01;

COMMIT;
