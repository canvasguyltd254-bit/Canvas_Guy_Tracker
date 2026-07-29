-- ============================================================
-- PAYROLL MODULE — Canvas Guy Tracker
-- Run this migration once in Supabase SQL editor
-- ============================================================

-- ── 1. employees ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_num    text UNIQUE NOT NULL,          -- e.g. EMP-001
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('casual', 'permanent', 'skilled_casual')),

  -- Rate fields — only the relevant one is set per type
  day_rate        numeric(10,2),                 -- casual / skilled_casual (daily)
  monthly_salary  numeric(10,2),                 -- permanent
  piece_rate      numeric(10,2),                 -- skilled_casual per piece (optional)

  -- Statutory
  sha_amount      numeric(10,2) NOT NULL DEFAULT 0,  -- fixed KES deducted each payment
  nssf_number     text,
  id_number       text,

  -- Payment info
  phone           text,                          -- M-Pesa number (07xx or 01xx)
  bank_account    text,
  bank_name       text,
  bank_branch     text,
  paybill_number  text,                          -- for Chatpesa paybill payments

  -- Admin
  hire_date       date,
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 2. statutory_rules ───────────────────────────────────────
-- Effective-dated rules so rates can change without code deploys
CREATE TABLE IF NOT EXISTS statutory_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type       text NOT NULL CHECK (rule_type IN ('sha', 'nssf', 'paye', 'ahl', 'nita')),
  effective_from  date NOT NULL,
  effective_to    date,                          -- NULL = currently active
  rate            numeric(8,4),                 -- percentage (e.g. 2.75 for 2.75%)
  fixed_amount    numeric(10,2),                -- fixed KES (overrides rate if set)
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Seed current SHA fixed rate (update amount as needed)
INSERT INTO statutory_rules (rule_type, effective_from, fixed_amount, description)
VALUES ('sha', '2024-10-01', 300.00, 'SHA/SHIF fixed deduction per payment (update as needed)')
ON CONFLICT DO NOTHING;

-- ── 3. payroll_runs ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_num         text UNIQUE NOT NULL,          -- e.g. PR-2025-W23
  period_type     text NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  run_type        text NOT NULL CHECK (run_type IN ('casual', 'permanent', 'skilled_casual', 'combined')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'closed')),
  notes           text,

  -- Approval snapshot
  approved_by     uuid REFERENCES auth.users(id),
  approved_at     timestamptz,
  approved_by_name text,

  -- Totals (computed and snapshotted on approval)
  total_gross     numeric(12,2),
  total_deductions numeric(12,2),
  total_net       numeric(12,2),
  employee_count  integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 4. payroll_entries ───────────────────────────────────────
-- One row per employee per run — immutable snapshot after approval
CREATE TABLE IF NOT EXISTS payroll_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id),

  -- Snapshot of employee data at run time (immutable record)
  snapshot_name       text NOT NULL,
  snapshot_type       text NOT NULL,
  snapshot_day_rate   numeric(10,2),
  snapshot_salary     numeric(10,2),
  snapshot_sha        numeric(10,2) NOT NULL DEFAULT 0,

  -- Earnings
  days_worked         integer DEFAULT 0,          -- casual / skilled_casual
  overtime_hours      numeric(6,2) DEFAULT 0,
  overtime_rate       numeric(10,2) DEFAULT 200,  -- KES per hour
  overtime_amount     numeric(10,2) DEFAULT 0,
  gross_pay           numeric(12,2) NOT NULL DEFAULT 0,

  -- Deductions
  sha_deduction       numeric(10,2) NOT NULL DEFAULT 0,
  advance_deduction   numeric(10,2) NOT NULL DEFAULT 0,
  damage_deduction    numeric(10,2) NOT NULL DEFAULT 0,
  other_deductions    numeric(10,2) NOT NULL DEFAULT 0,
  total_deductions    numeric(10,2) NOT NULL DEFAULT 0,

  -- Net
  net_pay             numeric(12,2) NOT NULL DEFAULT 0,

  -- Payment tracking (updated as payments recorded)
  amount_paid         numeric(12,2) NOT NULL DEFAULT 0,
  balance             numeric(12,2) GENERATED ALWAYS AS (net_pay - amount_paid) STORED,
  payment_status      text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'part_paid', 'paid')),

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, employee_id)
);

-- ── 5. payroll_attendance ────────────────────────────────────
-- Daily attendance grid for casual / skilled_casual
CREATE TABLE IF NOT EXISTS payroll_attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  work_date       date NOT NULL,
  present         boolean NOT NULL DEFAULT false,
  overtime_hours  numeric(4,2) DEFAULT 0,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id),

  UNIQUE (run_id, employee_id, work_date)
);

-- ── 6. payroll_adjustments ───────────────────────────────────
-- Advances, damages, overtime bonuses, and other manual adjustments
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  entry_id        uuid REFERENCES payroll_entries(id),
  adj_type        text NOT NULL CHECK (adj_type IN ('advance', 'damage', 'overtime', 'bonus', 'other')),
  amount          numeric(10,2) NOT NULL,         -- positive = deduction for advance/damage; positive = addition for bonus
  is_deduction    boolean NOT NULL DEFAULT true,  -- true = subtract from net_pay
  description     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 7. payroll_order_allocations ─────────────────────────────
-- Skilled casual gross labour cost → order (mirrors purchase_order_links)
CREATE TABLE IF NOT EXISTS payroll_order_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  entry_id        uuid NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  order_id        uuid NOT NULL REFERENCES orders(id),
  allocated_amount numeric(10,2) NOT NULL,        -- portion of gross_pay for this order
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 8. payroll_payment_batches ───────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_payment_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_num       text UNIQUE NOT NULL,           -- e.g. BATCH-2025-001
  run_id          uuid REFERENCES payroll_runs(id),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'reconciled')),
  payment_method  text NOT NULL DEFAULT 'mpesa' CHECK (payment_method IN ('mpesa', 'cash', 'bank', 'mixed')),
  total_amount    numeric(12,2),
  chatpesa_ref    text,                           -- reference from Chatpesa after upload
  notes           text,
  exported_at     timestamptz,
  reconciled_at   timestamptz,
  reconciled_by   uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 9. payroll_payments ──────────────────────────────────────
-- Individual payments (may be partial)
CREATE TABLE IF NOT EXISTS payroll_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid REFERENCES payroll_payment_batches(id),
  entry_id        uuid NOT NULL REFERENCES payroll_entries(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  amount          numeric(10,2) NOT NULL,
  payment_date    date,
  payment_method  text NOT NULL DEFAULT 'mpesa' CHECK (payment_method IN ('mpesa', 'cash', 'bank')),
  phone           text,                           -- snapshot of M-Pesa number at time of payment
  reference       text,                           -- M-Pesa confirmation or bank ref
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── 10. payroll_statutory_deductions ─────────────────────────
CREATE TABLE IF NOT EXISTS payroll_statutory_deductions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  rule_id         uuid REFERENCES statutory_rules(id),
  deduction_type  text NOT NULL,
  amount          numeric(10,2) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 11. employee_documents ───────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name            text NOT NULL,
  file_path       text NOT NULL,                  -- storage path in 'employee-documents' bucket
  doc_type        text DEFAULT 'other',           -- id, contract, certificate, other
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     uuid REFERENCES auth.users(id)
);

-- ── 12. payroll_activities ───────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     text NOT NULL,                  -- 'run', 'employee', 'batch', 'payment'
  entity_id       uuid NOT NULL,
  activity_type   text NOT NULL,                  -- 'created', 'approved', 'payment_added', 'exported', etc.
  description     text NOT NULL,
  old_value       text,
  new_value       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status ON payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_run ON payroll_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_employee ON payroll_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_payment_status ON payroll_entries(payment_status);
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_run ON payroll_attendance(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_employee ON payroll_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_entry ON payroll_payments(entry_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_batch ON payroll_payments(batch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_run ON payroll_adjustments(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_allocations_order ON payroll_order_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_type ON employees(type);
CREATE INDEX IF NOT EXISTS idx_payroll_activities_entity ON payroll_activities(entity_type, entity_id);

-- ── RLS — disable for now (service role handles all API calls) ──
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_attendance DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_adjustments DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_order_allocations DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payment_batches DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_statutory_deductions DISABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_activities DISABLE ROW LEVEL SECURITY;

-- ── Sequence helper — auto employee numbers ──────────────────
CREATE SEQUENCE IF NOT EXISTS employee_num_seq START 1;

CREATE OR REPLACE FUNCTION next_employee_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'EMP-' || LPAD(nextval('employee_num_seq')::text, 3, '0');
END;
$$;

-- ── Sequence helper — auto run numbers ──────────────────────
CREATE SEQUENCE IF NOT EXISTS payroll_run_seq START 1;

CREATE OR REPLACE FUNCTION next_payroll_run_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'PR-' || TO_CHAR(now(), 'YYYY') || '-' || LPAD(nextval('payroll_run_seq')::text, 4, '0');
END;
$$;

-- ── Sequence helper — auto batch numbers ────────────────────
CREATE SEQUENCE IF NOT EXISTS payroll_batch_seq START 1;

CREATE OR REPLACE FUNCTION next_payroll_batch_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'BATCH-' || TO_CHAR(now(), 'YYYY') || '-' || LPAD(nextval('payroll_batch_seq')::text, 3, '0');
END;
$$;
