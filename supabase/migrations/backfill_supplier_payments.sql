-- ============================================================
-- Canvas Guy Tracker — Backfill: Legacy Supplier Payments
--
-- Run ONCE to create manual_supplier_payments records for any
-- supplier_purchases that have amount_paid > 0 but no matching
-- payment transaction in manual_supplier_payments or
-- chatpesa_payment_allocations.
--
-- After this runs, the statement and recalc will show correct
-- figures without any further data entry.
-- ============================================================

BEGIN;

-- 1. Insert a legacy manual_supplier_payments record for every
--    purchase that has amount_paid > 0 but zero payment records.
INSERT INTO manual_supplier_payments (
  supplier_id,
  supplier_purchase_id,
  payment_date,
  amount,
  payment_method,
  note,
  created_at
)
SELECT
  sp.supplier_id,
  sp.id                                          AS supplier_purchase_id,
  COALESCE(sp.purchase_date, CURRENT_DATE)       AS payment_date,
  sp.amount_paid                                 AS amount,
  'Cash'                                         AS payment_method,
  'Legacy payment — imported from purchase balance' AS note,
  now()                                          AS created_at
FROM supplier_purchases sp
WHERE sp.amount_paid > 0
  -- No manual payment already exists for this purchase
  AND NOT EXISTS (
    SELECT 1 FROM manual_supplier_payments mp
    WHERE mp.supplier_purchase_id = sp.id
  )
  -- No Chatpesa allocation already exists for this purchase
  AND NOT EXISTS (
    SELECT 1 FROM chatpesa_payment_allocations ca
    WHERE ca.supplier_purchase_id = sp.id
  );

-- 2. Recalculate amount_paid on every affected purchase so it
--    matches the sum of payment records (idempotent: SUM = amount_paid).
UPDATE supplier_purchases sp
SET
  amount_paid = (
    SELECT COALESCE(SUM(mp.amount), 0)
    FROM manual_supplier_payments mp
    WHERE mp.supplier_purchase_id = sp.id
  ) + (
    SELECT COALESCE(SUM(ca.amount), 0)
    FROM chatpesa_payment_allocations ca
    WHERE ca.supplier_purchase_id = sp.id
  ),
  payment_status = CASE
    WHEN (
      SELECT COALESCE(SUM(mp.amount), 0) FROM manual_supplier_payments mp WHERE mp.supplier_purchase_id = sp.id
    ) + (
      SELECT COALESCE(SUM(ca.amount), 0) FROM chatpesa_payment_allocations ca WHERE ca.supplier_purchase_id = sp.id
    ) <= 0
      THEN 'Unpaid'
    WHEN (
      SELECT COALESCE(SUM(mp.amount), 0) FROM manual_supplier_payments mp WHERE mp.supplier_purchase_id = sp.id
    ) + (
      SELECT COALESCE(SUM(ca.amount), 0) FROM chatpesa_payment_allocations ca WHERE ca.supplier_purchase_id = sp.id
    ) >= sp.total_amount
      THEN 'Paid'
    ELSE 'Part Paid'
  END
WHERE sp.amount_paid > 0
   OR EXISTS (SELECT 1 FROM manual_supplier_payments mp WHERE mp.supplier_purchase_id = sp.id)
   OR EXISTS (SELECT 1 FROM chatpesa_payment_allocations ca WHERE ca.supplier_purchase_id = sp.id);

COMMIT;

-- Verify: should return 0 rows (no orphaned amount_paid values remain)
SELECT id, total_amount, amount_paid, payment_status
FROM supplier_purchases
WHERE amount_paid > 0
  AND NOT EXISTS (SELECT 1 FROM manual_supplier_payments WHERE supplier_purchase_id = supplier_purchases.id)
  AND NOT EXISTS (SELECT 1 FROM chatpesa_payment_allocations WHERE supplier_purchase_id = supplier_purchases.id);
