-- ============================================================
-- Canvas Guy Tracker — Accounting Foundation
--
-- Creates double-entry bookkeeping infrastructure on top of
-- existing supplier tables WITHOUT touching purchases/payments.
--
-- Stage 1 deliverables:
--   1. accounting_accounts   (Chart of Accounts — 75 accounts)
--   2. accounting_categories (curated dropdown seed)
--   3. journal_entries       (one header per economic event)
--   4. journal_lines         (signed debit/credit lines)
--   5. accounting_posting_errors (failed-posting audit log)
--   6. post_journal_entry()  (Postgres RPC — atomic, balanced)
--   7. ALTER TABLE on supplier_purchases, manual_supplier_payments,
--      chatpesa_payment_allocations (nullable FKs)
--   8. Indexes + RLS policies
--
-- Run once (idempotent for tables; accounts seed uses ON CONFLICT).
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. ACCOUNTING ACCOUNTS (Chart of Accounts)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_accounts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('Asset','Liability','Equity','Revenue','Expense')),
  subtype     text        NULL,       -- 'Cost of Sales' | 'Operating Expense' | NULL
  is_leaf     boolean     NOT NULL DEFAULT true,   -- false = header/group (not selectable)
  is_active   boolean     NOT NULL DEFAULT true,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  accounting_accounts IS 'Chart of Accounts — one row per bookkeeping account';
COMMENT ON COLUMN accounting_accounts.subtype IS 'Cost of Sales | Operating Expense — used to group P&L buckets';
COMMENT ON COLUMN accounting_accounts.is_leaf IS 'Only leaf accounts are selectable in dropdowns or postable';

-- ────────────────────────────────────────────────────────────
-- 2. ACCOUNTING CATEGORIES (curated dropdown lists for forms)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_categories (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES accounting_accounts(id),
  label           text        NOT NULL,
  for_purchases   boolean     NOT NULL DEFAULT true,
  for_petty_cash  boolean     NOT NULL DEFAULT false,
  sort_order      integer     NOT NULL DEFAULT 0,
  is_active       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  accounting_categories IS 'Curated subset of accounts shown in Purchase Category / Petty Cash Category dropdowns';
COMMENT ON COLUMN accounting_categories.for_purchases  IS 'Visible in "Purchase Category" dropdown on the purchase form';
COMMENT ON COLUMN accounting_categories.for_petty_cash IS 'Visible in "Petty Cash Category" dropdown on Chatpesa allocation form';

-- ────────────────────────────────────────────────────────────
-- 3. JOURNAL ENTRIES (one header per economic event)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_entries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date   date        NOT NULL,
  description  text        NOT NULL,
  source_type  text        NOT NULL,
  source_id    uuid        NOT NULL,
  -- 'active'   = live entry, participates in uniqueness check
  -- 'reversed' = cancelled by a reversal entry; excluded from uniqueness so
  --              a corrected re-post can create a new active entry for the
  --              same (source_type, source_id) pair
  status       text        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'reversed')),
  posted_by    uuid        REFERENCES auth.users(id),
  posted_at    timestamptz NOT NULL DEFAULT now()
  -- No inline UNIQUE here: uniqueness is enforced by the PARTIAL index
  -- idx_journal_entries_active_source (source_type, source_id) WHERE status='active'
);

COMMENT ON TABLE  journal_entries IS 'One journal header per posted economic event';
COMMENT ON COLUMN journal_entries.source_type IS 'purchase | manual_payment | chatpesa_allocation | supplier_opening_balance | reversal';
COMMENT ON COLUMN journal_entries.source_id   IS 'For normal entries: FK to originating row. For reversals: the journal_entry.id being reversed.';
COMMENT ON COLUMN journal_entries.status      IS 'active = live. reversed = cancelled. Only active entries are covered by the unique index.';

-- Safe upgrade: add status column if the table already existed without it
-- (i.e. an earlier version of this migration was applied before status was introduced).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reversed'));

-- Remove any pre-existing non-partial unique constraint on (source_type, source_id)
-- so the partial index below becomes the sole uniqueness mechanism.
ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_source_id_key;

-- ────────────────────────────────────────────────────────────
-- 4. JOURNAL LINES (individual debit / credit lines)
--
--    Signed model: positive amount = debit, negative = credit
--    Balanced entry invariant: SUM(amount) = 0
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_lines (
  id               uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid           NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id       uuid           NOT NULL REFERENCES accounting_accounts(id),
  amount           numeric(14,2)  NOT NULL CHECK (amount <> 0),  -- zero lines disallowed
  description      text,
  created_at       timestamptz    NOT NULL DEFAULT now()
);

COMMENT ON TABLE  journal_lines IS 'Individual debit/credit lines. Positive = debit, negative = credit. SUM per entry must be 0.';
COMMENT ON COLUMN journal_lines.amount IS 'Positive = debit, negative = credit. Zero is disallowed by CHECK constraint.';

-- ────────────────────────────────────────────────────────────
-- 5. ACCOUNTING POSTING ERRORS (failed-posting audit log)
--
--    Captures failures where no journal entry was created —
--    these cannot be stored as journal_entries.status='error'
--    because no entry row exists yet.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_posting_errors (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type       text,
  source_id         uuid,
  error_message     text        NOT NULL,
  attempted_by      uuid        REFERENCES auth.users(id),
  attempted_at      timestamptz NOT NULL DEFAULT now(),
  resolved          boolean     NOT NULL DEFAULT false,
  resolved_at       timestamptz,
  resolution_notes  text
);

COMMENT ON TABLE accounting_posting_errors IS 'Audit log of failed journal postings — reviewed in /accounting/review';

-- ────────────────────────────────────────────────────────────
-- 6. ALTER existing tables — add nullable FK columns
--
--    journal_entry_id: written back AFTER the journal commits
--    accounting_category_id: user selection drives DR account
-- ────────────────────────────────────────────────────────────

ALTER TABLE supplier_purchases
  ADD COLUMN IF NOT EXISTS accounting_category_id uuid REFERENCES accounting_categories(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id        uuid UNIQUE REFERENCES journal_entries(id);

ALTER TABLE manual_supplier_payments
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid UNIQUE REFERENCES journal_entries(id);

ALTER TABLE chatpesa_payment_allocations
  ADD COLUMN IF NOT EXISTS accounting_category_id uuid REFERENCES accounting_categories(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id        uuid UNIQUE REFERENCES journal_entries(id);

-- suppliers: one journal per opening balance (source_type = 'supplier_opening_balance')
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS opening_balance_journal_entry_id uuid REFERENCES journal_entries(id);

-- ────────────────────────────────────────────────────────────
-- 7. INDEXES
-- ────────────────────────────────────────────────────────────

-- Partial unique index: only active entries occupy the (source_type, source_id) slot.
-- Reversed entries are excluded so a corrected re-post can succeed after reversal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_active_source
  ON journal_entries (source_type, source_id)
  WHERE status = 'active';

-- Non-unique covering index for fast look-ups across all statuses (reversal guard, audit)
CREATE INDEX IF NOT EXISTS idx_journal_entries_source    ON journal_entries           (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_posted    ON journal_entries           (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date      ON journal_entries           (entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry       ON journal_lines             (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account     ON journal_lines             (account_id);
CREATE INDEX IF NOT EXISTS idx_posting_errors_source     ON accounting_posting_errors (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_posting_errors_unresolved ON accounting_posting_errors (resolved) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS idx_acc_accounts_code         ON accounting_accounts       (code);
CREATE INDEX IF NOT EXISTS idx_acc_accounts_type         ON accounting_accounts       (type, subtype);
CREATE INDEX IF NOT EXISTS idx_acc_categories_account    ON accounting_categories     (account_id);

-- ────────────────────────────────────────────────────────────
-- 8. RLS POLICIES
-- ────────────────────────────────────────────────────────────

ALTER TABLE accounting_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries              ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines                ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_posting_errors    ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read accounts + categories (needed for dropdowns)
CREATE POLICY "accounts_select_authenticated"
  ON accounting_accounts FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_select_authenticated"
  ON accounting_categories FOR SELECT TO authenticated USING (true);

-- Journal entries/lines: admin and production_manager only
-- (General Ledger is a financial record — not visible to all staff)
CREATE POLICY "journal_entries_accounting_roles"
  ON journal_entries FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'production_manager')
    )
  );

CREATE POLICY "journal_lines_accounting_roles"
  ON journal_lines FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'production_manager')
    )
  );

-- Posting errors: admin only
CREATE POLICY "posting_errors_admin_only"
  ON accounting_posting_errors FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- NOTE: No client-side INSERT/UPDATE policies for journal tables.
-- All writes go through the service_role client in API routes or the
-- post_journal_entry() RPC function (SECURITY DEFINER).

-- ────────────────────────────────────────────────────────────
-- 9. RPC: post_journal_entry
--
--    Atomically inserts journal_entries + journal_lines.
--    Validates:
--      - Lines must sum to zero (balanced entry)
--      - No duplicate source (before UNIQUE constraint fires,
--        for a cleaner error message)
--
--    Returns: journal_entries.id (uuid) on success
--    Raises:  EXCEPTION on validation failure or duplicate
--
--    SECURITY DEFINER so it can bypass RLS and always write
--    to journal tables regardless of calling user's role.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION post_journal_entry(
  p_entry_date   date,
  p_description  text,
  p_source_type  text,
  p_source_id    uuid,
  p_posted_by    uuid,
  p_lines        jsonb      -- array of {account_id, amount, description?}
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_sum      numeric(14,2);
  v_line     jsonb;
BEGIN
  -- 1. Validate: lines must sum to exactly zero
  SELECT COALESCE(SUM((elem->>'amount')::numeric), 0)
  INTO   v_sum
  FROM   jsonb_array_elements(p_lines) AS elem;

  IF ABS(v_sum) > 0.005 THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: lines sum to % (must be 0)', v_sum
      USING ERRCODE = 'P0001';
  END IF;

  -- 2. Duplicate-source guard (cleaner message than UNIQUE violation)
  --    Only blocks if an ACTIVE entry exists; reversed entries are allowed to
  --    coexist so a corrected re-post can succeed after a reversal.
  IF EXISTS (
    SELECT 1 FROM journal_entries
    WHERE  source_type = p_source_type AND source_id = p_source_id
      AND  status = 'active'
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_POSTING: % % already has an active journal entry', p_source_type, p_source_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 3. Insert journal header
  INSERT INTO journal_entries (entry_date, description, source_type, source_id, posted_by)
  VALUES (p_entry_date, p_description, p_source_type, p_source_id, p_posted_by)
  RETURNING id INTO v_entry_id;

  -- 4. Insert lines
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO journal_lines (journal_entry_id, account_id, amount, description)
    VALUES (
      v_entry_id,
      (v_line->>'account_id')::uuid,
      (v_line->>'amount')::numeric,
       v_line->>'description'
    );
  END LOOP;

  RETURN v_entry_id;
END;
$$;

-- SECURITY: Postgres grants EXECUTE to PUBLIC by default for new functions.
-- Revoke that first, then grant only to service_role.
-- This ensures the function cannot be called via the anon or authenticated Supabase
-- client keys — only through API routes that use the service_role key.
REVOKE EXECUTE ON FUNCTION post_journal_entry(
  date, text, text, uuid, uuid, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION post_journal_entry(
  date, text, text, uuid, uuid, jsonb
) TO service_role;

COMMENT ON FUNCTION post_journal_entry IS
  'Atomically creates a balanced journal entry. '
  'Validates SUM(lines)=0 and blocks duplicate source. '
  'Raises UNBALANCED_JOURNAL or DUPLICATE_POSTING on error. '
  'Returns the new journal_entries.id.';

-- ────────────────────────────────────────────────────────────
-- 10. SEED: Chart of Accounts (75 accounts)
--     ON CONFLICT (code) DO NOTHING — safe to re-run
-- ────────────────────────────────────────────────────────────

INSERT INTO accounting_accounts (code, name, type, subtype, is_leaf, sort_order) VALUES

-- ── ASSETS ──────────────────────────────────────────────────
('1000', 'Cash on Hand',                    'Asset', NULL, true,  10),
('1010', 'Chatpesa / M-Pesa Float',         'Asset', NULL, true,  20),
('1020', 'Default Bank',                     'Asset', NULL, true,  30),
('1100', 'Accounts Receivable',             'Asset', NULL, true,  40),
('1110', 'Other Receivables',               'Asset', NULL, true,  50),
('1200', 'Inventory',                       'Asset', NULL, true,  60),
('1210', 'Production in Progress',          'Asset', NULL, true,  70),
('1220', 'Prepayments & Deposits',          'Asset', NULL, true,  80),
('1300', 'Website & Digital Assets',        'Asset', NULL, true,  90),
('1400', 'Furniture & Fittings',            'Asset', NULL, true, 100),
('1410', 'Large Format Printer',            'Asset', NULL, true, 110),
('1420', 'Workshop Machines',               'Asset', NULL, true, 120),
('1430', 'Tools & Equipment',               'Asset', NULL, true, 130),
('1440', 'Workshop Construction',           'Asset', NULL, true, 140),
('1500', 'Withholding Tax Receivable',      'Asset', NULL, true, 150),

-- ── LIABILITIES ─────────────────────────────────────────────
('2000', 'Accounts Payable',                'Liability', NULL, true, 200),
('2010', 'VAT / GST Payable',              'Liability', NULL, true, 210),
('2020', 'Income Tax Payable',              'Liability', NULL, true, 220),
('2100', 'ABSA Loan',                       'Liability', NULL, true, 230),
('2110', 'Interdivisional Loan',            'Liability', NULL, true, 240),
('2120', 'Other Loans Payable',             'Liability', NULL, true, 250),

-- ── EQUITY ──────────────────────────────────────────────────
('3000', 'Opening Balance Equity',          'Equity', NULL, true, 300),
('3100', 'Retained Earnings',               'Equity', NULL, true, 310),

-- ── REVENUE ─────────────────────────────────────────────────
('4000', 'Direct Sales',                    'Revenue', NULL, true, 400),
('4100', 'Agent Sales',                     'Revenue', NULL, true, 410),
('4200', 'Website Sales',                   'Revenue', NULL, true, 420),
('4300', 'Outsourced Sales',                'Revenue', NULL, true, 430),
('4400', 'Inventory Sales',                 'Revenue', NULL, true, 440),
('4500', 'Furniture Sales',                 'Revenue', NULL, true, 450),
('4600', 'Delivery & Installation Income',  'Revenue', NULL, true, 460),
('4700', 'Design Services Income',          'Revenue', NULL, true, 470),
('4800', 'Interest Received',               'Revenue', NULL, true, 480),
('4990', 'Other Income',                    'Revenue', NULL, true, 490),

-- ── COST OF SALES ────────────────────────────────────────────
('5010', 'Timber',                          'Expense', 'Cost of Sales', true, 510),
('5020', 'Boards & MDF',                    'Expense', 'Cost of Sales', true, 520),
('5030', 'Hardware & Fittings',             'Expense', 'Cost of Sales', true, 530),
('5040', 'Fabric & Upholstery',             'Expense', 'Cost of Sales', true, 540),
('5050', 'Foam & Padding',                  'Expense', 'Cost of Sales', true, 550),
('5060', 'Canvas & Print Media',            'Expense', 'Cost of Sales', true, 560),
('5070', 'Ink & Solvents',                  'Expense', 'Cost of Sales', true, 570),
('5080', 'Frames',                          'Expense', 'Cost of Sales', true, 580),
('5090', 'Mirrors & Glass',                 'Expense', 'Cost of Sales', true, 590),
('5100', 'Metal & Welding Supplies',        'Expense', 'Cost of Sales', true, 600),
('5110', 'Workshop Consumables',            'Expense', 'Cost of Sales', true, 610),
('5120', 'Packaging',                       'Expense', 'Cost of Sales', true, 620),
('5130', 'Outsourced Production',           'Expense', 'Cost of Sales', true, 630),
('5140', 'Direct Labour',                   'Expense', 'Cost of Sales', true, 640),
('5150', 'Direct Transport',                'Expense', 'Cost of Sales', true, 650),
('5160', 'Additional Works',                'Expense', 'Cost of Sales', true, 660),

-- ── OPERATING EXPENSES ───────────────────────────────────────
('6000', 'Rent',                            'Expense', 'Operating Expense', true, 700),
('6010', 'Electricity & Water',             'Expense', 'Operating Expense', true, 710),
('6020', 'Internet & Telephone',            'Expense', 'Operating Expense', true, 720),
('6030', 'Transport & Fuel',                'Expense', 'Operating Expense', true, 730),
('6040', 'Staff Meals & Welfare',           'Expense', 'Operating Expense', true, 740),
('6050', 'Staff Airtime',                   'Expense', 'Operating Expense', true, 750),
('6060', 'Office Supplies & Stationery',    'Expense', 'Operating Expense', true, 760),
('6070', 'Repairs & Maintenance',           'Expense', 'Operating Expense', true, 770),
('6080', 'Marketing & Advertising',         'Expense', 'Operating Expense', true, 780),
('6090', 'Bank Charges & Fees',             'Expense', 'Operating Expense', true, 790),
('6100', 'Casual Labour',                   'Expense', 'Operating Expense', true, 800),
('6110', 'Software & Subscriptions',        'Expense', 'Operating Expense', true, 810),
('6120', 'Licenses & Permits',              'Expense', 'Operating Expense', true, 820),
('6130', 'Professional Fees',               'Expense', 'Operating Expense', true, 830),
('6140', 'Travel & Accommodation',          'Expense', 'Operating Expense', true, 840),
('6150', 'Cleaning & Sanitation',           'Expense', 'Operating Expense', true, 850),
('6160', 'Security',                        'Expense', 'Operating Expense', true, 860),
('6170', 'Insurance',                       'Expense', 'Operating Expense', true, 870),
('6180', 'Depreciation',                    'Expense', 'Operating Expense', true, 880),
('6190', 'Equipment Hire',                  'Expense', 'Operating Expense', true, 890),
('6200', 'Printing & Photocopying',         'Expense', 'Operating Expense', true, 900),
('6210', 'Staff Salaries',                  'Expense', 'Operating Expense', true, 910),
('6220', 'NHIF / NSSF / PAYE',             'Expense', 'Operating Expense', true, 920),
('6230', 'Miscellaneous / Sundry',          'Expense', 'Operating Expense', true, 930),
('6240', 'Drawings / Owner Withdrawals',    'Expense', 'Operating Expense', true, 940),
('6250', 'Rounding Expense',                'Expense', 'Operating Expense', true, 950)

ON CONFLICT (code) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- 11. SEED: Accounting Categories
--
--  Cost of Sales accounts → for_purchases only
--  Operating Expense accounts → for_purchases, and
--    petty-cash-friendly ones also get for_petty_cash = true
--
--  Only runs if accounting_categories is empty (idempotent).
-- ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounting_categories LIMIT 1) THEN

    -- Cost of Sales → purchase categories
    INSERT INTO accounting_categories (account_id, label, for_purchases, for_petty_cash, sort_order)
    SELECT a.id, a.name, true, false, a.sort_order
    FROM   accounting_accounts a
    WHERE  a.subtype = 'Cost of Sales' AND a.is_active;

    -- Operating Expenses → purchase categories;
    -- subset also shown as petty cash options
    INSERT INTO accounting_categories (account_id, label, for_purchases, for_petty_cash, sort_order)
    SELECT
      a.id,
      a.name,
      true,
      -- codes commonly paid from petty cash / Chatpesa
      (a.code IN ('6030','6040','6050','6060','6070','6090','6100',
                  '6110','6120','6130','6150','6160','6190','6200','6230')),
      a.sort_order
    FROM  accounting_accounts a
    WHERE a.subtype = 'Operating Expense' AND a.is_active;

  END IF;
END;
$$;

COMMIT;
