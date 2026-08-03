-- ─────────────────────────────────────────────────────────────────────────────
-- order_direct_expenses
-- Direct expenses charged against an order (or multiple orders via links).
-- These are NOT supplier purchases — they create no AP records.
-- P&L impact is immediate on recording; payment status is tracked separately.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_direct_expenses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core fields
  expense_date      DATE        NOT NULL,
  category          TEXT        NOT NULL,   -- see EXPENSE_CATEGORIES enum below
  description       TEXT        NOT NULL,
  payee_name        TEXT,                   -- optional
  amount            NUMERIC(14,2) NOT NULL CHECK (amount > 0),

  -- Payment tracking (separate from P&L impact)
  payment_status    TEXT        NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid','paid')),
  payment_method    TEXT
                    CHECK (payment_method IS NULL OR
                           payment_method IN ('cash','bank','chatpesa','mpesa')),
  payment_reference TEXT,

  -- Attachment
  receipt_url       TEXT,
  receipt_name      TEXT,

  -- Notes
  notes             TEXT,

  -- GL / accounting
  gl_account_code   TEXT,       -- mapped from category at insert time

  -- Audit / lifecycle
  created_by        UUID        REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft reversal (posted expenses are never hard-deleted)
  is_posted         BOOLEAN     NOT NULL DEFAULT false,
  reversed_at       TIMESTAMPTZ,
  reversed_by       UUID        REFERENCES auth.users(id),
  reversal_reason   TEXT,
  reversal_of       UUID        REFERENCES order_direct_expenses(id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- order_direct_expense_links
-- Junction table: one expense can be split across multiple orders.
-- The SUM of allocated_amount across all links must not exceed expense.amount.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_direct_expense_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id        UUID        NOT NULL REFERENCES order_direct_expenses(id) ON DELETE CASCADE,
  order_id          UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  allocated_amount  NUMERIC(14,2) NOT NULL CHECK (allocated_amount > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (expense_id, order_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ode_created_at   ON order_direct_expenses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ode_category     ON order_direct_expenses (category);
CREATE INDEX IF NOT EXISTS idx_ode_is_posted    ON order_direct_expenses (is_posted);
CREATE INDEX IF NOT EXISTS idx_odel_expense_id  ON order_direct_expense_links (expense_id);
CREATE INDEX IF NOT EXISTS idx_odel_order_id    ON order_direct_expense_links (order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_ode_updated_at ON order_direct_expenses;
CREATE TRIGGER trg_ode_updated_at
  BEFORE UPDATE ON order_direct_expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE order_direct_expenses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_direct_expense_links  ENABLE ROW LEVEL SECURITY;

-- Service role bypass (used by all API routes)
CREATE POLICY "service_role_all_ode"  ON order_direct_expenses
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all_odel" ON order_direct_expense_links
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users may read (navigation, P&L display)
CREATE POLICY "auth_read_ode"  ON order_direct_expenses
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_odel" ON order_direct_expense_links
  FOR SELECT TO authenticated USING (true);
