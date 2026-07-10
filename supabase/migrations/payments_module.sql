-- ============================================================
-- Canvas Guy Tracker — Payments / Reconciliation Module
-- Run AFTER suppliers_module.sql
-- ============================================================

-- 1. Add opening balance fields to suppliers
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS opening_balance       numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_balance_date  date,
  ADD COLUMN IF NOT EXISTS opening_balance_notes text;

-- 2. CHATPESA_IMPORTS — one row per CSV upload session
CREATE TABLE IF NOT EXISTS chatpesa_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by         uuid REFERENCES auth.users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  statement_from      timestamptz,
  statement_to        timestamptz,
  account_ref         text,                        -- e.g. "CP966518"
  account_name        text,                        -- e.g. "Canvas Guy Limited"
  reconciliation_week date,                        -- Monday of the statement week
  row_count           int NOT NULL DEFAULT 0,
  debit_count         int NOT NULL DEFAULT 0,
  credit_count        int NOT NULL DEFAULT 0,
  refund_count        int NOT NULL DEFAULT 0,
  duplicate_count     int NOT NULL DEFAULT 0,
  total_debits        numeric(12,2) NOT NULL DEFAULT 0,
  notes               text
);

ALTER TABLE chatpesa_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chatpesa_imports_select" ON chatpesa_imports FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "chatpesa_imports_insert" ON chatpesa_imports FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);

-- 3. CHATPESA_TRANSACTIONS — one row per CSV data row
CREATE TABLE IF NOT EXISTS chatpesa_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id             uuid NOT NULL REFERENCES chatpesa_imports(id) ON DELETE CASCADE,
  chatpesa_id           bigint NOT NULL,             -- "ID" column — dedup key
  tx_type               text NOT NULL
                          CHECK (tx_type IN ('debit','credit','refund')),
  match_status          text NOT NULL DEFAULT 'unmatched'
                          CHECK (match_status IN ('unmatched','partial','matched','ignored','credit','refund')),
  source                text,                        -- "transaction - mpesa" etc.
  source_id             text,
  account_name          text,
  account_number        text,
  description           text,
  confirm_code          text,
  amount                numeric(12,2) NOT NULL DEFAULT 0,
  balance_after         numeric(12,2),
  transaction_date      date NOT NULL,
  transaction_time      time,
  -- Fuzzy match suggestion
  suggested_supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  suggested_confidence  numeric(4,3),               -- 0.000 to 1.000
  -- Reconciliation tracking
  matched_at            timestamptz,
  matched_by            uuid REFERENCES auth.users(id),
  ignored_at            timestamptz,
  ignored_by            uuid REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chatpesa_tx_unique_id ON chatpesa_transactions(chatpesa_id);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_import   ON chatpesa_transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_status   ON chatpesa_transactions(match_status);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_date     ON chatpesa_transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_supplier ON chatpesa_transactions(suggested_supplier_id);

ALTER TABLE chatpesa_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chatpesa_transactions_select" ON chatpesa_transactions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "chatpesa_transactions_insert" ON chatpesa_transactions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "chatpesa_transactions_update" ON chatpesa_transactions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);

-- 4. CHATPESA_PAYMENT_ALLOCATIONS — splits one transaction across destinations
CREATE TABLE IF NOT EXISTS chatpesa_payment_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        uuid NOT NULL REFERENCES chatpesa_transactions(id) ON DELETE CASCADE,
  allocation_type       text NOT NULL
                          CHECK (allocation_type IN ('supplier_purchase','opening_balance','petty_cash')),
  -- For supplier_purchase
  supplier_purchase_id  uuid REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
  -- For opening_balance
  supplier_id           uuid REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- For petty_cash
  petty_cash_category   text,
  -- Common
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  note                  text,
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Exactly one destination must be set
  CONSTRAINT allocation_destination CHECK (
    (allocation_type = 'supplier_purchase' AND supplier_purchase_id IS NOT NULL) OR
    (allocation_type = 'opening_balance'   AND supplier_id IS NOT NULL) OR
    (allocation_type = 'petty_cash'        AND petty_cash_category IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_alloc_transaction ON chatpesa_payment_allocations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_alloc_purchase    ON chatpesa_payment_allocations(supplier_purchase_id);
CREATE INDEX IF NOT EXISTS idx_alloc_supplier    ON chatpesa_payment_allocations(supplier_id);

ALTER TABLE chatpesa_payment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allocations_select" ON chatpesa_payment_allocations FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "allocations_insert" ON chatpesa_payment_allocations FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "allocations_delete" ON chatpesa_payment_allocations FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);

-- 5. MANUAL_SUPPLIER_PAYMENTS — cash / M-Pesa / bank transfer
CREATE TABLE IF NOT EXISTS manual_supplier_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id           uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_purchase_id  uuid REFERENCES supplier_purchases(id) ON DELETE SET NULL,
  payment_date          date NOT NULL DEFAULT CURRENT_DATE,
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method        text NOT NULL DEFAULT 'Cash'
                          CHECK (payment_method IN ('Cash','M-Pesa','Bank Transfer','Other')),
  reference             text,
  note                  text,
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_payments_supplier  ON manual_supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_manual_payments_purchase  ON manual_supplier_payments(supplier_purchase_id);
CREATE INDEX IF NOT EXISTS idx_manual_payments_date      ON manual_supplier_payments(payment_date DESC);

ALTER TABLE manual_supplier_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_payments_select" ON manual_supplier_payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "manual_payments_insert" ON manual_supplier_payments FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "manual_payments_delete" ON manual_supplier_payments FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);
