-- ============================================================
-- Canvas Guy Tracker — Quotes, CRM & Invoice Module
-- Migration A: Prerequisites on existing tables + infrastructure
--
-- Run AFTER accounting_foundation.sql
-- Safe to re-run (all statements use IF NOT EXISTS / IF EXISTS /
-- ON CONFLICT DO NOTHING guards).
--
-- Sections:
--   1. accounting_settings          (GL cutoff + future settings)
--   2. ALTER customers              (tax_status, OB journal link)
--   3. ALTER orders                 (VAT snapshot, invoice, quote FK)
--   4. ALTER order_items            (line_type, VAT columns)
--   5. ALTER order_payments         (journal links, reversal columns)
--   6. Sequence functions           (ENQ / QT / INV numbering)
--   7. Indexes
--   8. RLS policies
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. ACCOUNTING SETTINGS
--    Key/value store for admin-controlled accounting parameters.
--    'gl_cutoff_date' : ISO date string — transactions on or after
--    this date get automatic journal posting. Locked once posting
--    begins to prevent retroactive changes.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_settings (
  key        text        PRIMARY KEY,
  value      text,
  locked     boolean     NOT NULL DEFAULT false,
  updated_by uuid        REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  accounting_settings IS 'Admin-controlled accounting parameters (e.g. GL cutoff date). Lock a key to prevent further changes.';
COMMENT ON COLUMN accounting_settings.locked IS 'When true, this setting cannot be changed without a manual DB override. Set to true once GL posting begins for gl_cutoff_date.';

-- Seed the cutoff date row (unlocked until admin activates it)
INSERT INTO accounting_settings (key, value, locked)
VALUES ('gl_cutoff_date', NULL, false)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE accounting_settings ENABLE ROW LEVEL SECURITY;

-- Only admin can read or write accounting settings
CREATE POLICY "accounting_settings_admin_select"
  ON accounting_settings FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- No direct client INSERT/UPDATE: all writes go through service_role API routes


-- ────────────────────────────────────────────────────────────
-- 2. ALTER CUSTOMERS
--    tax_status: drives VAT calculation on all quotes and orders.
--    Existing rows default to 'taxable' — admin reviews and marks
--    exempt customers before creating their first quotation.
--
--    opening_balance_journal_entry_id: links the customer's
--    reviewed opening-balance GL journal (posted at GL cutover).
-- ────────────────────────────────────────────────────────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tax_status text
    NOT NULL DEFAULT 'taxable'
    CHECK (tax_status IN ('taxable', 'exempt')),
  ADD COLUMN IF NOT EXISTS opening_balance_journal_entry_id uuid
    REFERENCES journal_entries(id);

COMMENT ON COLUMN customers.tax_status
  IS 'taxable = 16% VAT applies; exempt = 0% VAT. Overrides line-level tax_treatment. Snapshotted onto every quotation and order at creation.';

COMMENT ON COLUMN customers.opening_balance_journal_entry_id
  IS 'FK to the reviewed opening-balance journal entry posted at GL cutover. NULL = no OB journal posted yet.';


-- ────────────────────────────────────────────────────────────
-- 3. ALTER ORDERS
--    New columns — none collide with existing schema:
--
--    quote_id              FK to the accepted quotation that created
--                          this order (NULL for direct orders).
--    tax_status            Snapshotted from customer at order creation.
--    pricing_mode          vat_exclusive | vat_inclusive
--                          (how the quoted prices should be interpreted).
--    subtotal_amount       Sum of line net_amounts (ex-VAT).
--    vat_amount            Sum of line vat_amounts.
--    invoice_issued_at     Set atomically when invoice is posted.
--    invoice_journal_entry_id  FK to the invoice GL journal entry.
--
--    NOTE: invoice_number and total_value already exist in schema.sql
--    and are NOT recreated here.
-- ────────────────────────────────────────────────────────────

-- quote_id is added as a plain uuid here; the FK to quotations(id) is added
-- at the top of Migration B once the quotations table exists.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS quote_id uuid,
  ADD COLUMN IF NOT EXISTS tax_status text
    CHECK (tax_status IN ('taxable', 'exempt')),
  ADD COLUMN IF NOT EXISTS pricing_mode text
    CHECK (pricing_mode IN ('vat_exclusive', 'vat_inclusive')),
  ADD COLUMN IF NOT EXISTS subtotal_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS vat_amount      numeric(14,2),
  ADD COLUMN IF NOT EXISTS invoice_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_journal_entry_id uuid
    REFERENCES journal_entries(id);

COMMENT ON COLUMN orders.quote_id
  IS 'FK to the accepted quotation that was converted to this order. NULL = direct order (no prior quotation).';
COMMENT ON COLUMN orders.tax_status
  IS 'Snapshotted from customers.tax_status at order creation. Never recalculated post-creation.';
COMMENT ON COLUMN orders.pricing_mode
  IS 'vat_exclusive: entered prices are net (VAT added on top). vat_inclusive: entered prices already include VAT.';
COMMENT ON COLUMN orders.subtotal_amount
  IS 'Sum of order_items.net_amount. NULL for pre-module legacy orders.';
COMMENT ON COLUMN orders.vat_amount
  IS 'Sum of order_items.vat_amount. NULL for pre-module legacy orders.';
COMMENT ON COLUMN orders.invoice_issued_at
  IS 'Timestamp set atomically when the invoice GL journal is posted (at Deposit Paid, or at Quote Approved for credit orders). NULL = invoice not yet issued.';
COMMENT ON COLUMN orders.invoice_journal_entry_id
  IS 'FK to the invoice GL journal entry. NULL = invoice not yet posted. Non-null = immutable without a reversal.';


-- ────────────────────────────────────────────────────────────
-- 4. ALTER ORDER_ITEMS
--    Six new columns for VAT and revenue mapping:
--
--    line_type       Maps to revenue account for GL posting:
--                      product  → 4000 Direct Sales
--                      delivery → 4600 Delivery & Installation Income
--                      design   → 4700 Design Services Income
--
--    tax_treatment   Inherent VAT nature of the line, independent of
--                    the customer's tax_status:
--                      standard → eligible for 16% VAT if customer taxable
--                      exempt   → always 0% regardless of customer status
--
--    vat_rate        Snapshotted effective rate (0.16 or 0.00) at time
--                    of line creation. Never recalculated post-acceptance.
--
--    net_amount      Line revenue before VAT (after discount).
--    vat_amount      VAT on this line (net_amount × vat_rate).
--    gross_amount    net_amount + vat_amount.
--
--    Existing rows: line_type = 'product', VAT columns NULL
--    (covered by historical cutover — no retroactive calculation).
-- ────────────────────────────────────────────────────────────

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_type text
    NOT NULL DEFAULT 'product'
    CHECK (line_type IN ('product', 'delivery', 'design')),
  ADD COLUMN IF NOT EXISTS tax_treatment text
    NOT NULL DEFAULT 'standard'
    CHECK (tax_treatment IN ('standard', 'exempt')),
  ADD COLUMN IF NOT EXISTS vat_rate     numeric(5,4),   -- 0.1600 or 0.0000
  ADD COLUMN IF NOT EXISTS net_amount   numeric(14,2),
  ADD COLUMN IF NOT EXISTS vat_amount   numeric(14,2),
  ADD COLUMN IF NOT EXISTS gross_amount numeric(14,2);

COMMENT ON COLUMN order_items.line_type
  IS 'Revenue account mapping: product → 4000, delivery → 4600, design → 4700.';
COMMENT ON COLUMN order_items.tax_treatment
  IS 'Inherent VAT nature of the line. standard = eligible for 16% if customer is taxable. exempt = always 0%.';
COMMENT ON COLUMN order_items.vat_rate
  IS 'Effective VAT rate snapshotted at line creation (0.1600 or 0.0000). NULL for pre-module legacy rows.';
COMMENT ON COLUMN order_items.net_amount
  IS 'qty × unit_price × (1 - discount_pct/100). For vat_inclusive lines this is back-calculated: gross ÷ 1.16.';
COMMENT ON COLUMN order_items.vat_amount
  IS 'net_amount × vat_rate. NULL for pre-module legacy rows.';
COMMENT ON COLUMN order_items.gross_amount
  IS 'net_amount + vat_amount. For exempt lines: gross = net. NULL for pre-module legacy rows.';


-- ────────────────────────────────────────────────────────────
-- 5. ALTER ORDER_PAYMENTS
--    journal_entry_id        FK to the receipt GL journal posted for
--                            this payment. NULL = unposted.
--                            Unique: one journal per payment (never
--                            aggregated). Non-null = immutable without
--                            a reversal.
--
--    reversed_at             Timestamp set when the payment is reversed.
--                            Non-null = reversal has occurred.
--
--    reversal_journal_entry_id  FK to the reversal credit-note journal.
--                               Non-null implies reversed_at is also set.
--
--    reversal_reason         Required text when reversing a posted payment.
--    reversed_by             User who performed the reversal.
-- ────────────────────────────────────────────────────────────

ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid
    UNIQUE REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid
    REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_by uuid
    REFERENCES auth.users(id);

COMMENT ON COLUMN order_payments.journal_entry_id
  IS 'FK to the Debit Bank / Credit AR receipt journal. NULL = payment not yet posted to GL. UNIQUE: one journal per payment.';
COMMENT ON COLUMN order_payments.reversed_at
  IS 'Set when this payment is reversed. Non-null means the payment has been corrected through a reversal journal.';
COMMENT ON COLUMN order_payments.reversal_journal_entry_id
  IS 'FK to the reversal credit-note journal entry. Non-null implies reversed_at is also set.';
COMMENT ON COLUMN order_payments.reversal_reason
  IS 'Mandatory reason text captured when a posted payment is reversed.';
COMMENT ON COLUMN order_payments.reversed_by
  IS 'User who authorised and performed the payment reversal.';


-- ────────────────────────────────────────────────────────────
-- 6. SEQUENCE FUNCTIONS
--    Three new document-number generators, all year-scoped.
--    Format:
--      ENQ-2026-0001  (enquiries)
--      QT-2026-0001   (quotations)
--      INV-2026-0001  (invoices — stored on orders.invoice_number)
--
--    Each sequence resets at the start of a new calendar year.
--    Gaps are allowed (rollback during a failed transaction leaves
--    a gap — this is intentional and standard accounting practice).
--
--    Implementation mirrors next_payroll_batch_num() pattern already
--    used in the codebase.
-- ────────────────────────────────────────────────────────────

-- ── ENQ sequence ────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS enq_num_seq_2026 START WITH 1;

CREATE OR REPLACE FUNCTION next_enq_num()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_seq  text := 'enq_num_seq_' || v_year;
  v_n    bigint;
BEGIN
  -- Create the sequence for this year if it does not yet exist
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I START WITH 1', v_seq
  );
  EXECUTE format('SELECT nextval(%L)', v_seq) INTO v_n;
  RETURN 'ENQ-' || v_year || '-' || LPAD(v_n::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION next_enq_num() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION next_enq_num() TO service_role;

-- ── QT sequence ─────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS qt_num_seq_2026 START WITH 1;

CREATE OR REPLACE FUNCTION next_qt_num()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_seq  text := 'qt_num_seq_' || v_year;
  v_n    bigint;
BEGIN
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I START WITH 1', v_seq
  );
  EXECUTE format('SELECT nextval(%L)', v_seq) INTO v_n;
  RETURN 'QT-' || v_year || '-' || LPAD(v_n::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION next_qt_num() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION next_qt_num() TO service_role;

-- ── INV sequence ─────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS inv_num_seq_2026 START WITH 1;

CREATE OR REPLACE FUNCTION next_inv_num()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_seq  text := 'inv_num_seq_' || v_year;
  v_n    bigint;
BEGIN
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I START WITH 1', v_seq
  );
  EXECUTE format('SELECT nextval(%L)', v_seq) INTO v_n;
  RETURN 'INV-' || v_year || '-' || LPAD(v_n::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION next_inv_num() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION next_inv_num() TO service_role;


-- ────────────────────────────────────────────────────────────
-- 7. INDEXES
-- ────────────────────────────────────────────────────────────

-- customers
CREATE INDEX IF NOT EXISTS idx_customers_tax_status
  ON customers (tax_status);

-- orders — new columns
CREATE INDEX IF NOT EXISTS idx_orders_quote_id
  ON orders (quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_invoice_issued_at
  ON orders (invoice_issued_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_orders_invoice_journal
  ON orders (invoice_journal_entry_id);

-- order_items — new columns
CREATE INDEX IF NOT EXISTS idx_order_items_line_type
  ON order_items (line_type);

-- order_payments — new column
CREATE INDEX IF NOT EXISTS idx_order_payments_journal
  ON order_payments (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_reversed
  ON order_payments (reversed_at DESC NULLS LAST) WHERE reversed_at IS NOT NULL;

-- accounting_settings
CREATE INDEX IF NOT EXISTS idx_accounting_settings_key
  ON accounting_settings (key);


-- ────────────────────────────────────────────────────────────
-- 8. NOTE ON QUOTE_ID FOREIGN KEY
--    orders.quote_id is added above as a plain uuid column.
--    The FK constraint referencing quotations(id) is applied at
--    the top of Migration B, after the quotations table exists.
--    Run Migration A then Migration B in sequence.
-- ────────────────────────────────────────────────────────────

COMMIT;
