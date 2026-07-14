-- Migration: add 'Finishing Materials – Paints & Coatings' to Cost of Sales
--
-- Account code 5165 sits between 5160 (Additional Works) and the Operating
-- Expenses block. Sort order 665 keeps it in sequence.
--
-- Run in Supabase SQL Editor:
--   1. Inserts the account (idempotent via ON CONFLICT DO NOTHING).
--   2. Inserts the purchase/cost category linked to that account.
--   3. Safe to re-run — both inserts are guarded.

-- ── 1. Accounting account ──────────────────────────────────────────────────

INSERT INTO public.accounting_accounts
  (code, name, type, subtype, is_active, sort_order)
VALUES
  ('5165', 'Finishing Materials – Paints & Coatings', 'Expense', 'Cost of Sales', true, 665)
ON CONFLICT (code) DO NOTHING;

-- ── 2. Accounting category (makes it appear in purchase dropdowns) ─────────

INSERT INTO public.accounting_categories
  (account_id, label, for_purchases, for_petty_cash, sort_order)
SELECT
  a.id,
  'Finishing Materials – Paints & Coatings',
  true,   -- shows in purchase/supplier expense dropdowns
  false,  -- not a petty cash category
  665
FROM public.accounting_accounts a
WHERE a.code = '5165'
  AND NOT EXISTS (
    SELECT 1 FROM public.accounting_categories c WHERE c.account_id = a.id
  );
