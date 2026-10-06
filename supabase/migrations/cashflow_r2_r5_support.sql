-- ============================================================================
-- Canvas Guy Tracker — Cashflow spec R2–R5 support columns
--
-- R2  order_payments.payment_method + banked_date  (unbanked cash/M-Pesa)
-- R4  cashflow_manual_obligations.statutory_type + paying_account_id
-- R5  cashflow_settings.concentration_threshold_pct
--     cashflow_settings.unbanked_warn_after_days   (R2 warning threshold)
--
-- Design rules kept from the Cashflow contract
--   * Nothing here writes payments, receipts or journals. These are
--     descriptive columns the forecast READS.
--   * Legacy rows stay NULL. NULL method / NULL banked_date is "unknown",
--     never silently defaulted to cash/bank — the engine surfaces the count.
--   * payment_method values are the CUSTOMER-receipt vocabulary from the spec
--     (cash, M-PESA, bank, cheque). They are stored lower-case as
--     'cash','mpesa','bank','cheque'.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

-- ── R2: how the customer paid, and when it reached the bank ────────────────
ALTER TABLE public.order_payments
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS banked_date    date;

ALTER TABLE public.order_payments
  DROP CONSTRAINT IF EXISTS order_payments_payment_method_check;
ALTER TABLE public.order_payments
  ADD  CONSTRAINT order_payments_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('cash','mpesa','bank','cheque'));

-- A banked date without a method would be unexplainable; and a bank/cheque
-- receipt IS banked by definition, so it does not need one.
ALTER TABLE public.order_payments
  DROP CONSTRAINT IF EXISTS order_payments_banked_date_needs_method;
ALTER TABLE public.order_payments
  ADD  CONSTRAINT order_payments_banked_date_needs_method
  CHECK (banked_date IS NULL OR payment_method IS NOT NULL);

COMMENT ON COLUMN public.order_payments.payment_method IS
  'cash | mpesa | bank | cheque. NULL = not recorded (legacy rows) — shown as unknown, never assumed.';
COMMENT ON COLUMN public.order_payments.banked_date IS
  'Date the money reached the bank. Only meaningful for cash/mpesa; NULL on those = still unbanked.';

-- Cashflow reads unbanked receipts; keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_order_payments_unbanked
  ON public.order_payments (payment_date)
  WHERE payment_method IN ('cash','mpesa') AND banked_date IS NULL AND reversed_at IS NULL;

-- ── R4: which statutory line is this, and which account pays it ────────────
ALTER TABLE public.cashflow_manual_obligations
  ADD COLUMN IF NOT EXISTS statutory_type    text,
  ADD COLUMN IF NOT EXISTS paying_account_id uuid
    REFERENCES public.accounting_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.cashflow_manual_obligations
  DROP CONSTRAINT IF EXISTS cashflow_manual_obligations_statutory_type_check;
ALTER TABLE public.cashflow_manual_obligations
  ADD  CONSTRAINT cashflow_manual_obligations_statutory_type_check
  CHECK (statutory_type IS NULL OR statutory_type IN ('paye','nssf','ahl','sha','vat','wht','other'));

ALTER TABLE public.cashflow_manual_obligations
  DROP CONSTRAINT IF EXISTS cashflow_manual_obligations_statutory_type_needs_flag;
ALTER TABLE public.cashflow_manual_obligations
  ADD  CONSTRAINT cashflow_manual_obligations_statutory_type_needs_flag
  CHECK (statutory_type IS NULL OR is_statutory = true);

COMMENT ON COLUMN public.cashflow_manual_obligations.statutory_type IS
  'Explicit tag (paye/nssf/ahl/sha/vat/wht/other). Matching is by this tag only — never inferred from the name.';
COMMENT ON COLUMN public.cashflow_manual_obligations.paying_account_id IS
  'The GL account the statutory payment is made from. NULL = not recorded; the forecast warns.';

-- ── R2 / R5 thresholds ──────────────────────────────────────────────────────
ALTER TABLE public.cashflow_settings
  ADD COLUMN IF NOT EXISTS unbanked_warn_after_days     integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS concentration_threshold_pct  integer NOT NULL DEFAULT 25;

ALTER TABLE public.cashflow_settings
  DROP CONSTRAINT IF EXISTS cashflow_settings_unbanked_warn_days_check;
ALTER TABLE public.cashflow_settings
  ADD  CONSTRAINT cashflow_settings_unbanked_warn_days_check
  CHECK (unbanked_warn_after_days BETWEEN 1 AND 90);

ALTER TABLE public.cashflow_settings
  DROP CONSTRAINT IF EXISTS cashflow_settings_concentration_pct_check;
ALTER TABLE public.cashflow_settings
  ADD  CONSTRAINT cashflow_settings_concentration_pct_check
  CHECK (concentration_threshold_pct BETWEEN 1 AND 100);

COMMIT;
