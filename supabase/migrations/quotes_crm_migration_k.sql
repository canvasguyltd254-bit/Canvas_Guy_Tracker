-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration K: Backfill quotation header totals to include charges
--
-- Problem:
--   quote.subtotal / vat_amount / total were computed from product
--   items only. Charge line items (delivery, design, etc.) were
--   stored as quote_items but not added to the header totals, so
--   the UI "TOTAL INCL. VAT" column and grand total were wrong.
--
-- Fix:
--   Recompute all three header fields from SUM of ALL quote_items
--   (both product and charge rows). Only touches rows where the
--   current total differs from the item sum by more than 0.01.
-- ============================================================

BEGIN;

UPDATE quotations q
SET
  subtotal   = ROUND((
    SELECT COALESCE(SUM(qi.net_amount), 0)
    FROM quote_items qi WHERE qi.quote_id = q.id
  )::numeric, 2),

  vat_amount = ROUND((
    SELECT COALESCE(SUM(qi.vat_amount), 0)
    FROM quote_items qi WHERE qi.quote_id = q.id
  )::numeric, 2),

  total      = ROUND((
    SELECT COALESCE(SUM(qi.gross_amount), 0)
    FROM quote_items qi WHERE qi.quote_id = q.id
  )::numeric, 2)

WHERE ABS(q.total - COALESCE((
  SELECT SUM(qi.gross_amount)
  FROM quote_items qi WHERE qi.quote_id = q.id
), 0)) > 0.01;

COMMIT;
