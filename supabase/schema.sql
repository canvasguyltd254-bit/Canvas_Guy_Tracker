-- ════════════════════════════════════════════════════════════
-- CANVAS GUY TRACKER — COMPLETE DATABASE SCHEMA v8
-- Generated 2026-07-29. Consolidates schema.sql + all migrations.
--
-- ⚠  DANGER — DO NOT RERUN ON AN EXISTING PRODUCTION DATABASE ⚠
--
-- This file is the canonical source of truth for a FRESH deployment.
-- On an existing database run only the specific migration files that
-- have not yet been applied, in order.
--
-- Roles: admin, production_manager, head_of_sales, sales,
--        production_staff, viewer
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- 0. HELPER FUNCTIONS
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_profiles WHERE id = auth.uid()),
    'viewer'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;


-- ══════════════════════════════════════════════════════════════
-- 1. CORE TABLES
-- ══════════════════════════════════════════════════════════════

-- ── user_profiles ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text,
  display_name text,
  role         text NOT NULL DEFAULT 'viewer',
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- ── orders ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_num               text NOT NULL UNIQUE,
  client                  text NOT NULL,
  contact_person          text,
  author                  text,
  items                   text,
  status                  text NOT NULL DEFAULT 'Inquiry',
  due_date                date,
  assigned_to             text,
  notes                   text,
  total_value             numeric(12,2) DEFAULT 0,
  quote_number            text,
  invoice_number          text,
  order_type              text NOT NULL DEFAULT 'standard',
  parent_order_id         uuid REFERENCES public.orders(id),
  repair_reason           text,
  deliverable_units       integer,
  batch_delivery          boolean NOT NULL DEFAULT false,
  customer_type           text NOT NULL DEFAULT 'retail',
  payment_terms           text NOT NULL DEFAULT 'cash_before',
  refund_reference        text,
  credit_approval_ref     text,
  delivery_address        text,
  delivery_contact        text,
  delivery_instructions   text,
  customer_id             uuid,   -- FK added after customers table created below
  payment_due_date        date,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now(),
  created_by              uuid REFERENCES auth.users(id)
);

-- ── order_items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  category     text NOT NULL DEFAULT 'Other',
  description  text,
  quantity     integer NOT NULL DEFAULT 1,
  size         text,
  finish_type  text,
  finish_color text,
  wood_type    text,
  unit_price   numeric(12,2) DEFAULT 0,
  notes        text,
  sort_order   integer DEFAULT 0,
  created_at   timestamptz DEFAULT now()
);

-- ── order_documents ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  doc_type    text NOT NULL,
  file_path   text NOT NULL,
  file_size   integer,
  mime_type   text,
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by uuid REFERENCES auth.users(id)
);

-- ── order_payments ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  amount       numeric(12,2) NOT NULL,
  description  text NOT NULL,
  payment_date date NOT NULL DEFAULT current_date,
  created_at   timestamptz DEFAULT now(),
  created_by   uuid REFERENCES auth.users(id)
);

-- ── order_notes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  content     text NOT NULL,
  author_name text,
  created_at  timestamptz DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id)
);

-- ── order_deliveries ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_deliveries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_number             integer NOT NULL DEFAULT 1,
  delivery_date            date NOT NULL DEFAULT current_date,
  quantity                 integer NOT NULL,
  description              text,
  delivery_location        text,
  delivered_by             text,
  received_by              text,
  notes                    text,
  delivery_sheet_path      text,
  admin_authorized         boolean DEFAULT false,
  admin_auth_reason        text,
  authorized_by            uuid REFERENCES auth.users(id),
  payment_status_at_delivery text,
  created_at               timestamptz DEFAULT now(),
  created_by               uuid REFERENCES auth.users(id)
);

-- ── order_activities ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  description   text NOT NULL,
  old_value     text,
  new_value     text,
  created_at    timestamptz DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id)
);

-- ── drawings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.drawings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  file_path    text NOT NULL,
  file_size    integer,
  mime_type    text,
  drawing_type text DEFAULT 'general',
  notes        text,
  uploaded_by  uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at  timestamptz DEFAULT now(),
  deleted_at   timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- ── delivery_batches ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_number         integer NOT NULL,
  status               text NOT NULL DEFAULT 'Quality Control'
                         CHECK (status IN (
                           'Quality Control','Planned','Picking','Loaded',
                           'Out for Delivery','Delivered','Signed',
                           'Cancelled','Rejected','Returned'
                         )),
  planned_date         date,
  actual_delivery_date date,
  driver               text,
  vehicle              text,
  delivery_location    text,
  notes                text,
  signed_copy_path     text,
  cancelled_at         timestamptz,
  cancelled_reason     text,
  created_by           uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, batch_number)
);

-- ── delivery_batch_items ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_batch_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES public.delivery_batches(id) ON DELETE CASCADE,
  order_item_id      uuid NOT NULL REFERENCES public.order_items(id),
  quantity_planned   integer NOT NULL CHECK (quantity_planned > 0),
  quantity_delivered integer NOT NULL DEFAULT 0 CHECK (quantity_delivered >= 0),
  quantity_rejected  integer NOT NULL DEFAULT 0 CHECK (quantity_rejected >= 0),
  rejection_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_batch_item_quantities
    CHECK (quantity_delivered + quantity_rejected <= quantity_planned),
  UNIQUE (batch_id, order_item_id)
);

-- ── client_profiles ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name  text NOT NULL UNIQUE,
  customer_type text NOT NULL DEFAULT 'retail',
  credit_limit numeric(12,2) DEFAULT 0,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

-- ── admin_settings ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

-- ── contacts ──────────────────────────────────────────────────
-- contact_type: 'General' | 'Transporter'
-- (Customers and Suppliers have their own tables)
CREATE TABLE IF NOT EXISTS public.contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_type text NOT NULL CHECK (contact_type IN ('General','Transporter')),
  name         text NOT NULL,
  company      text,
  phone        text,
  email        text,
  address      text,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  created_by   uuid REFERENCES auth.users(id)
);


-- ══════════════════════════════════════════════════════════════
-- 2. SUPPLIERS MODULE
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.suppliers (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            text NOT NULL,
  contact_person                  text,
  phone                           text,
  email                           text,
  materials_supplied              text,
  notes                           text,
  opening_balance                 numeric(12,2) NOT NULL DEFAULT 0,
  opening_balance_date            date,
  opening_balance_notes           text,
  opening_balance_journal_entry_id uuid,   -- FK added after journal_entries below
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.supplier_purchases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id             uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  purchase_date           date NOT NULL DEFAULT CURRENT_DATE,
  items_bought            text,
  total_amount            numeric(12,2) NOT NULL DEFAULT 0,
  invoice_path            text,
  invoice_name            text,
  amount_paid             numeric(12,2) NOT NULL DEFAULT 0,
  payment_status          text NOT NULL DEFAULT 'Unpaid'
                            CHECK (payment_status IN ('Unpaid','Part Paid','Paid')),
  notes                   text,
  accounting_category_id  uuid,   -- FK added after accounting_categories below
  journal_entry_id        uuid UNIQUE,   -- FK added after journal_entries below
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES auth.users(id),
  CONSTRAINT paid_lte_total CHECK (amount_paid <= total_amount),
  CONSTRAINT total_non_negative CHECK (total_amount >= 0),
  CONSTRAINT paid_non_negative  CHECK (amount_paid  >= 0)
);

CREATE TABLE IF NOT EXISTS public.supplier_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  file_path   text NOT NULL,
  file_size   bigint,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid REFERENCES auth.users(id)
);

-- purchase_order_links (many-to-many: purchases ↔ orders)
CREATE TABLE IF NOT EXISTS public.purchase_order_links (
  purchase_id uuid NOT NULL REFERENCES public.supplier_purchases(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount      numeric(12,2),   -- NULL = informational only; set = allocated share
  PRIMARY KEY (purchase_id, order_id)
);


-- ══════════════════════════════════════════════════════════════
-- 3. PAYMENTS MODULE (Chatpesa + Manual)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.chatpesa_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by         uuid REFERENCES auth.users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  statement_from      timestamptz,
  statement_to        timestamptz,
  account_ref         text,
  account_name        text,
  reconciliation_week date,
  row_count           int NOT NULL DEFAULT 0,
  debit_count         int NOT NULL DEFAULT 0,
  credit_count        int NOT NULL DEFAULT 0,
  refund_count        int NOT NULL DEFAULT 0,
  duplicate_count     int NOT NULL DEFAULT 0,
  total_debits        numeric(12,2) NOT NULL DEFAULT 0,
  notes               text
);

CREATE TABLE IF NOT EXISTS public.chatpesa_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id             uuid NOT NULL REFERENCES public.chatpesa_imports(id) ON DELETE CASCADE,
  chatpesa_id           bigint NOT NULL,
  tx_type               text NOT NULL CHECK (tx_type IN ('debit','credit','refund')),
  match_status          text NOT NULL DEFAULT 'unmatched'
                          CHECK (match_status IN ('unmatched','partial','matched','ignored','credit','refund')),
  source                text,
  source_id             text,
  account_name          text,
  account_number        text,
  description           text,
  confirm_code          text,
  amount                numeric(12,2) NOT NULL DEFAULT 0,
  balance_after         numeric(12,2),
  transaction_date      date NOT NULL,
  transaction_time      time,
  suggested_supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  suggested_confidence  numeric(4,3),
  matched_at            timestamptz,
  matched_by            uuid REFERENCES auth.users(id),
  ignored_at            timestamptz,
  ignored_by            uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.chatpesa_payment_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id         uuid NOT NULL REFERENCES public.chatpesa_transactions(id) ON DELETE CASCADE,
  allocation_type        text NOT NULL
                           CHECK (allocation_type IN ('supplier_purchase','opening_balance','petty_cash')),
  supplier_purchase_id   uuid REFERENCES public.supplier_purchases(id) ON DELETE RESTRICT,
  supplier_id            uuid REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  petty_cash_category    text,
  amount                 numeric(12,2) NOT NULL CHECK (amount > 0),
  note                   text,
  accounting_category_id uuid,   -- FK added after accounting_categories below
  journal_entry_id       uuid UNIQUE,   -- FK added after journal_entries below
  created_by             uuid REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_destination CHECK (
    (allocation_type = 'supplier_purchase' AND supplier_purchase_id IS NOT NULL) OR
    (allocation_type = 'opening_balance'   AND supplier_id IS NOT NULL) OR
    (allocation_type = 'petty_cash'        AND petty_cash_category IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.manual_supplier_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id          uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  supplier_purchase_id uuid REFERENCES public.supplier_purchases(id) ON DELETE SET NULL,
  payment_date         date NOT NULL DEFAULT CURRENT_DATE,
  amount               numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method       text NOT NULL DEFAULT 'Cash'
                         CHECK (payment_method IN ('Cash','M-Pesa','Bank Transfer','Other')),
  reference            text,
  note                 text,
  journal_entry_id     uuid UNIQUE,   -- FK added after journal_entries below
  created_by           uuid REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);


-- ══════════════════════════════════════════════════════════════
-- 4. ACCOUNTING FOUNDATION
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.accounting_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('Asset','Liability','Equity','Revenue','Expense')),
  subtype    text,
  is_leaf    boolean NOT NULL DEFAULT true,
  is_active  boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accounting_categories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounting_accounts(id),
  label          text NOT NULL,
  for_purchases  boolean NOT NULL DEFAULT true,
  for_petty_cash boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date  date NOT NULL,
  description text NOT NULL,
  source_type text NOT NULL,
  source_id   uuid NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed')),
  posted_by   uuid REFERENCES auth.users(id),
  posted_at   timestamptz NOT NULL DEFAULT now()
);

-- Remove non-partial unique constraint if it exists from older deploys
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_source_id_key;

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES public.accounting_accounts(id),
  amount           numeric(14,2) NOT NULL CHECK (amount <> 0),
  description      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.accounting_posting_errors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type      text,
  source_id        uuid,
  error_message    text NOT NULL,
  attempted_by     uuid REFERENCES auth.users(id),
  attempted_at     timestamptz NOT NULL DEFAULT now(),
  resolved         boolean NOT NULL DEFAULT false,
  resolved_at      timestamptz,
  resolution_notes text
);

-- Now add deferred FKs that needed accounting tables to exist first
ALTER TABLE public.supplier_purchases
  ADD COLUMN IF NOT EXISTS accounting_category_id uuid REFERENCES public.accounting_categories(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id        uuid UNIQUE REFERENCES public.journal_entries(id);

ALTER TABLE public.chatpesa_payment_allocations
  ADD COLUMN IF NOT EXISTS accounting_category_id uuid REFERENCES public.accounting_categories(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id        uuid UNIQUE REFERENCES public.journal_entries(id);

ALTER TABLE public.manual_supplier_payments
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid UNIQUE REFERENCES public.journal_entries(id);

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS opening_balance_journal_entry_id uuid REFERENCES public.journal_entries(id);


-- ══════════════════════════════════════════════════════════════
-- 5. CUSTOMERS MODULE
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  contact_person       text,
  phone                text,
  email                text,
  address              text,
  kra_pin              text,
  credit_limit         numeric(12,2) NOT NULL DEFAULT 0,
  credit_terms         text NOT NULL DEFAULT 'COD'
                         CHECK (credit_terms IN ('COD','7 Days','30 Days','60 Days')),
  opening_balance      numeric(12,2) NOT NULL DEFAULT 0,
  opening_balance_date date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.customer_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  content     text NOT NULL,
  author_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id)
);

-- Add customer_id FK to orders now that customers exists
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_id      uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_due_date date;


-- ══════════════════════════════════════════════════════════════
-- 6. PAYROLL MODULE
-- ══════════════════════════════════════════════════════════════

-- ── employees ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_num   text UNIQUE NOT NULL,
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('casual','permanent','skilled_casual')),
  day_rate       numeric(10,2),
  monthly_salary numeric(10,2),
  piece_rate     numeric(10,2),
  sha_amount     numeric(10,2) NOT NULL DEFAULT 0,
  nssf_number    text,
  id_number      text,
  phone          text,
  bank_account   text,
  bank_name      text,
  bank_branch    text,
  paybill_number text,
  hire_date      date,
  is_active      boolean NOT NULL DEFAULT true,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES auth.users(id)
);

-- ── statutory_rules ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.statutory_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type      text NOT NULL CHECK (rule_type IN ('sha','nssf','paye','ahl','nita')),
  effective_from date NOT NULL,
  effective_to   date,
  rate           numeric(8,4),
  fixed_amount   numeric(10,2),
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── payroll_runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_num          text UNIQUE NOT NULL,
  period_type      text NOT NULL CHECK (period_type IN ('weekly','monthly')),
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  run_type         text NOT NULL CHECK (run_type IN ('casual','permanent','skilled_casual','combined')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','closed')),
  reopen_reason    text,
  notes            text,
  approved_by      uuid REFERENCES auth.users(id),
  approved_at      timestamptz,
  approved_by_name text,
  total_gross      numeric(12,2),
  total_deductions numeric(12,2),
  total_net        numeric(12,2),
  employee_count   integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);

-- ── payroll_entries ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES public.employees(id),
  snapshot_name     text NOT NULL,
  snapshot_type     text NOT NULL,
  snapshot_day_rate numeric(10,2),
  snapshot_salary   numeric(10,2),
  snapshot_sha      numeric(10,2) NOT NULL DEFAULT 0,
  days_worked       integer DEFAULT 0,
  overtime_hours    numeric(6,2) DEFAULT 0,
  overtime_rate     numeric(10,2) DEFAULT 200,
  overtime_amount   numeric(10,2) DEFAULT 0,
  gross_pay         numeric(12,2) NOT NULL DEFAULT 0,
  sha_deduction     numeric(10,2) NOT NULL DEFAULT 0,
  advance_deduction numeric(10,2) NOT NULL DEFAULT 0,
  damage_deduction  numeric(10,2) NOT NULL DEFAULT 0,
  other_deductions  numeric(10,2) NOT NULL DEFAULT 0,
  total_deductions  numeric(10,2) NOT NULL DEFAULT 0,
  net_pay           numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid       numeric(12,2) NOT NULL DEFAULT 0,
  balance           numeric(12,2) GENERATED ALWAYS AS (net_pay - amount_paid) STORED,
  payment_status    text NOT NULL DEFAULT 'unpaid'
                      CHECK (payment_status IN ('unpaid','part_paid','paid')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)
);

-- ── payroll_attendance ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_attendance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES public.employees(id),
  work_date      date NOT NULL,
  present        boolean NOT NULL DEFAULT false,
  overtime_hours numeric(4,2) DEFAULT 0,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id),
  UNIQUE (run_id, employee_id, work_date)
);

-- ── payroll_adjustments ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES public.employees(id),
  entry_id     uuid REFERENCES public.payroll_entries(id),
  adj_type     text NOT NULL CHECK (adj_type IN ('advance','damage','overtime','bonus','other')),
  amount       numeric(10,2) NOT NULL,
  is_deduction boolean NOT NULL DEFAULT true,
  description  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES auth.users(id)
);

-- ── payroll_order_allocations ─────────────────────────────────
-- Skilled-casual gross labour cost allocated to a specific order item
CREATE TABLE IF NOT EXISTS public.payroll_order_allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  entry_id         uuid NOT NULL REFERENCES public.payroll_entries(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES public.employees(id),
  order_id         uuid NOT NULL REFERENCES public.orders(id),
  order_item_id    uuid REFERENCES public.order_items(id) ON DELETE SET NULL,
  allocated_amount numeric(10,2) NOT NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);

-- ── payroll_payment_batches ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_payment_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_num        text UNIQUE NOT NULL,
  run_id           uuid REFERENCES public.payroll_runs(id),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','exported','reconciled')),
  payment_method   text NOT NULL DEFAULT 'mpesa'
                     CHECK (payment_method IN ('mpesa','cash','bank','mixed')),
  total_amount     numeric(12,2),
  chatpesa_ref     text,
  exported_entry_ids uuid[],   -- tracks which entries were included in the CSV export
  notes            text,
  exported_at      timestamptz,
  reconciled_at    timestamptz,
  reconciled_by    uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);

-- ── payroll_batch_entry_links ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_batch_entry_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   uuid NOT NULL REFERENCES public.payroll_payment_batches(id) ON DELETE CASCADE,
  entry_id   uuid NOT NULL REFERENCES public.payroll_entries(id) ON DELETE CASCADE,
  amount     numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entry_id)
);

-- ── payroll_payments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid REFERENCES public.payroll_payment_batches(id),
  entry_id       uuid NOT NULL REFERENCES public.payroll_entries(id),
  employee_id    uuid NOT NULL REFERENCES public.employees(id),
  amount         numeric(10,2) NOT NULL,
  payment_date   date,
  payment_method text NOT NULL DEFAULT 'mpesa'
                   CHECK (payment_method IN ('mpesa','cash','bank')),
  phone          text,
  reference      text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','failed')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES auth.users(id)
);

-- ── payroll_statutory_deductions ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_statutory_deductions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES public.payroll_entries(id) ON DELETE CASCADE,
  rule_id        uuid REFERENCES public.statutory_rules(id),
  deduction_type text NOT NULL,
  amount         numeric(10,2) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── employee_documents ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  name        text NOT NULL,
  file_path   text NOT NULL,
  doc_type    text DEFAULT 'other',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid REFERENCES auth.users(id)
);

-- ── payroll_activities ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  activity_type text NOT NULL,
  description   text NOT NULL,
  old_value     text,
  new_value     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id)
);


-- ══════════════════════════════════════════════════════════════
-- 7. INDEXES
-- ══════════════════════════════════════════════════════════════

-- orders
CREATE INDEX IF NOT EXISTS idx_orders_status     ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_parent      ON public.orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_quote       ON public.orders(quote_number)    WHERE quote_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_invoice     ON public.orders(invoice_number)  WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created     ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON public.orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_due ON public.orders(payment_due_date);
-- order sub-tables
CREATE INDEX IF NOT EXISTS idx_order_items_order        ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_docs_order         ON public.order_documents(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_order     ON public.order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_notes_order        ON public.order_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_order_deliveries_order   ON public.order_deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_order_activities_order   ON public.order_activities(order_id);
-- drawings
CREATE INDEX IF NOT EXISTS idx_drawings_order_id    ON public.drawings(order_id);
CREATE INDEX IF NOT EXISTS idx_drawings_order_active ON public.drawings(order_id, deleted_at);
-- delivery batches
CREATE INDEX IF NOT EXISTS idx_delivery_batches_order_id   ON public.delivery_batches(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_batches_status     ON public.delivery_batches(status);
CREATE INDEX IF NOT EXISTS idx_delivery_batch_items_batch  ON public.delivery_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_batch_items_item   ON public.delivery_batch_items(order_item_id);
-- suppliers
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_supplier ON public.supplier_purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_status   ON public.supplier_purchases(payment_status);
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_date     ON public.supplier_purchases(purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_pol_purchase                ON public.purchase_order_links(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pol_order                   ON public.purchase_order_links(order_id);
-- chatpesa
CREATE UNIQUE INDEX IF NOT EXISTS idx_chatpesa_tx_unique_id ON public.chatpesa_transactions(chatpesa_id);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_import            ON public.chatpesa_transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_status            ON public.chatpesa_transactions(match_status);
CREATE INDEX IF NOT EXISTS idx_chatpesa_tx_date              ON public.chatpesa_transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_alloc_transaction             ON public.chatpesa_payment_allocations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_alloc_purchase                ON public.chatpesa_payment_allocations(supplier_purchase_id);
CREATE INDEX IF NOT EXISTS idx_manual_payments_supplier      ON public.manual_supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_manual_payments_purchase      ON public.manual_supplier_payments(supplier_purchase_id);
-- accounting
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_active_source
  ON public.journal_entries(source_type, source_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_journal_entries_source    ON public.journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_posted    ON public.journal_entries(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_entries_date      ON public.journal_entries(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry       ON public.journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account     ON public.journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_posting_errors_source     ON public.accounting_posting_errors(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_posting_errors_unresolved ON public.accounting_posting_errors(resolved) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS idx_acc_accounts_code         ON public.accounting_accounts(code);
CREATE INDEX IF NOT EXISTS idx_acc_accounts_type         ON public.accounting_accounts(type, subtype);
CREATE INDEX IF NOT EXISTS idx_acc_categories_account    ON public.accounting_categories(account_id);
-- customers
CREATE INDEX IF NOT EXISTS idx_customers_name         ON public.customers(name);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON public.customer_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_type  ON public.contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_name          ON public.contacts(name);
-- payroll
CREATE INDEX IF NOT EXISTS idx_payroll_runs_status           ON public.payroll_runs(status);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period           ON public.payroll_runs(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_run           ON public.payroll_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_employee      ON public.payroll_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_payment_status ON public.payroll_entries(payment_status);
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_run        ON public.payroll_attendance(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_attendance_employee   ON public.payroll_attendance(employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_entry        ON public.payroll_payments(entry_id);
CREATE INDEX IF NOT EXISTS idx_payroll_payments_batch        ON public.payroll_payments(batch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_run       ON public.payroll_adjustments(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_allocations_order     ON public.payroll_order_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_batch_entry_links_batch       ON public.payroll_batch_entry_links(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_entry_links_entry       ON public.payroll_batch_entry_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_employees_active              ON public.employees(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_type                ON public.employees(type);
CREATE INDEX IF NOT EXISTS idx_payroll_activities_entity     ON public.payroll_activities(entity_type, entity_id);


-- ══════════════════════════════════════════════════════════════
-- 8. ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════

-- Enable RLS
ALTER TABLE public.orders                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_documents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payments                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_notes                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_deliveries              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_activities              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawings                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_batches              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_batch_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_purchases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_attachments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_links          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatpesa_imports              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatpesa_transactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatpesa_payment_allocations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_supplier_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_posting_errors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_notes                ENABLE ROW LEVEL SECURITY;
-- Payroll: RLS enabled, no policies → deny all browser-direct access.
-- All reads/writes go through serviceClient (service_role bypasses RLS).
ALTER TABLE public.employees                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statutory_rules               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_attendance            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_adjustments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_order_allocations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_payment_batches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_batch_entry_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_statutory_deductions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_activities            ENABLE ROW LEVEL SECURITY;

-- Drop + recreate all policies (safe on fresh deploy)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ── orders ────────────────────────────────────────────────────
CREATE POLICY "orders_select" ON public.orders FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "orders_insert" ON public.orders FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales')
);
CREATE POLICY "orders_update" ON public.orders FOR UPDATE USING (
  auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff')
);
CREATE POLICY "orders_delete" ON public.orders FOR DELETE USING (get_user_role() = 'admin');

-- ── order_items ───────────────────────────────────────────────
CREATE POLICY "items_select" ON public.order_items FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "items_insert" ON public.order_items FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "items_update" ON public.order_items FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "items_delete" ON public.order_items FOR DELETE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));

-- ── order_documents ───────────────────────────────────────────
CREATE POLICY "docs_select" ON public.order_documents FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "docs_insert" ON public.order_documents FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() != 'viewer');
CREATE POLICY "docs_update" ON public.order_documents FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() != 'viewer');
CREATE POLICY "docs_delete" ON public.order_documents FOR DELETE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager'));

-- ── order_payments ────────────────────────────────────────────
CREATE POLICY "pay_select" ON public.order_payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "pay_insert" ON public.order_payments FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "pay_delete" ON public.order_payments FOR DELETE USING (get_user_role() = 'admin');

-- ── order_notes ───────────────────────────────────────────────
CREATE POLICY "notes_select" ON public.order_notes FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "notes_insert" ON public.order_notes FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() != 'viewer');

-- ── order_deliveries ──────────────────────────────────────────
CREATE POLICY "del_select" ON public.order_deliveries FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "del_insert" ON public.order_deliveries FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','production_staff'));
CREATE POLICY "del_delete" ON public.order_deliveries FOR DELETE USING (get_user_role() = 'admin');

-- ── order_activities ──────────────────────────────────────────
CREATE POLICY "act_select" ON public.order_activities FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "act_insert" ON public.order_activities FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- ── user_profiles ─────────────────────────────────────────────
CREATE POLICY "profiles_select"     ON public.user_profiles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "profiles_insert"     ON public.user_profiles FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "profiles_update_own" ON public.user_profiles FOR UPDATE USING (auth.uid() = id);

-- ── drawings ──────────────────────────────────────────────────
CREATE POLICY "drawings_select" ON public.drawings FOR SELECT USING (
  get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff','viewer')
);
CREATE POLICY "drawings_insert" ON public.drawings FOR INSERT WITH CHECK (
  get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff')
  AND uploaded_by = auth.uid()
);
CREATE POLICY "drawings_update" ON public.drawings FOR UPDATE
  USING (get_user_role() IN ('admin','production_manager'))
  WITH CHECK (get_user_role() IN ('admin','production_manager'));
CREATE POLICY "drawings_delete" ON public.drawings FOR DELETE USING (get_user_role() = 'admin');

-- ── delivery_batches ──────────────────────────────────────────
CREATE POLICY "batches_read"       ON public.delivery_batches FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "batches_insert"     ON public.delivery_batches FOR INSERT WITH CHECK (get_user_role() IN ('admin','production_manager'));
CREATE POLICY "batches_update"     ON public.delivery_batches FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "batches_delete"     ON public.delivery_batches FOR DELETE USING (get_user_role() = 'admin');
CREATE POLICY "batch_items_read"   ON public.delivery_batch_items FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "batch_items_insert" ON public.delivery_batch_items FOR INSERT WITH CHECK (get_user_role() IN ('admin','production_manager'));
CREATE POLICY "batch_items_update" ON public.delivery_batch_items FOR UPDATE USING (get_user_role() IN ('admin','production_manager'));
CREATE POLICY "batch_items_delete" ON public.delivery_batch_items FOR DELETE USING (get_user_role() = 'admin');

-- ── client_profiles ───────────────────────────────────────────
CREATE POLICY "cp_select" ON public.client_profiles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "cp_insert" ON public.client_profiles FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "cp_update" ON public.client_profiles FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "cp_delete" ON public.client_profiles FOR DELETE USING (get_user_role() = 'admin');

-- ── admin_settings ────────────────────────────────────────────
CREATE POLICY "settings_select" ON public.admin_settings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "settings_upsert" ON public.admin_settings FOR ALL USING (get_user_role() = 'admin');

-- ── contacts ──────────────────────────────────────────────────
CREATE POLICY "contacts_select" ON public.contacts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE USING (auth.role() = 'authenticated');
CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);

-- ── suppliers ─────────────────────────────────────────────────
CREATE POLICY "suppliers_select" ON public.suppliers FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "suppliers_insert" ON public.suppliers FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "suppliers_update" ON public.suppliers FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "suppliers_delete" ON public.suppliers FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ── supplier_purchases ────────────────────────────────────────
CREATE POLICY "supplier_purchases_select" ON public.supplier_purchases FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "supplier_purchases_insert" ON public.supplier_purchases FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "supplier_purchases_update" ON public.supplier_purchases FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "supplier_purchases_delete" ON public.supplier_purchases FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ── supplier_attachments ──────────────────────────────────────
CREATE POLICY "supplier_attachments_select" ON public.supplier_attachments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "supplier_attachments_insert" ON public.supplier_attachments FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "supplier_attachments_delete" ON public.supplier_attachments FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);

-- ── purchase_order_links ──────────────────────────────────────
CREATE POLICY "pol_pol_select" ON public.purchase_order_links FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "pol_pol_insert" ON public.purchase_order_links FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "pol_pol_update" ON public.purchase_order_links FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "pol_pol_delete" ON public.purchase_order_links FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);

-- ── chatpesa ──────────────────────────────────────────────────
CREATE POLICY "chatpesa_imports_select" ON public.chatpesa_imports FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "chatpesa_imports_insert" ON public.chatpesa_imports FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "chatpesa_transactions_select" ON public.chatpesa_transactions FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "chatpesa_transactions_insert" ON public.chatpesa_transactions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "chatpesa_transactions_update" ON public.chatpesa_transactions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "allocations_select" ON public.chatpesa_payment_allocations FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "allocations_insert" ON public.chatpesa_payment_allocations FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "allocations_delete" ON public.chatpesa_payment_allocations FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);
CREATE POLICY "manual_payments_select" ON public.manual_supplier_payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "manual_payments_insert" ON public.manual_supplier_payments FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);
CREATE POLICY "manual_payments_delete" ON public.manual_supplier_payments FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);

-- ── accounting ────────────────────────────────────────────────
CREATE POLICY "accounts_select_authenticated"    ON public.accounting_accounts          FOR SELECT TO authenticated USING (true);
CREATE POLICY "categories_select_authenticated"  ON public.accounting_categories        FOR SELECT TO authenticated USING (true);
CREATE POLICY "journal_entries_accounting_roles" ON public.journal_entries              FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);
CREATE POLICY "journal_lines_accounting_roles"   ON public.journal_lines                FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager'))
);
CREATE POLICY "posting_errors_admin_only"        ON public.accounting_posting_errors    FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ── customers ─────────────────────────────────────────────────
CREATE POLICY "customers_select" ON public.customers FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "customers_insert" ON public.customers FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales','sales'))
);
CREATE POLICY "customers_update" ON public.customers FOR UPDATE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales','sales'))
);
CREATE POLICY "customers_delete" ON public.customers FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "customer_notes_select" ON public.customer_notes FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "customer_notes_insert" ON public.customer_notes FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "customer_notes_delete" ON public.customer_notes FOR DELETE USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','production_manager','head_of_sales'))
);

-- Payroll tables: no policies = deny all browser-direct access (service_role bypasses RLS)


-- ══════════════════════════════════════════════════════════════
-- 9. TRIGGERS
-- ══════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS orders_updated_at         ON public.orders;
DROP TRIGGER IF EXISTS contacts_updated_at        ON public.contacts;
DROP TRIGGER IF EXISTS drawings_updated_at        ON public.drawings;
DROP TRIGGER IF EXISTS trg_delivery_batches_updated_at ON public.delivery_batches;
DROP TRIGGER IF EXISTS trg_set_delivery_batch_number   ON public.delivery_batches;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER drawings_updated_at
  BEFORE UPDATE ON public.drawings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_delivery_batches_updated_at
  BEFORE UPDATE ON public.delivery_batches FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION public.set_delivery_batch_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.batch_number IS NULL THEN
    SELECT COALESCE(MAX(batch_number), 0) + 1
      INTO NEW.batch_number
      FROM public.delivery_batches
     WHERE order_id = NEW.order_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_delivery_batch_number
  BEFORE INSERT ON public.delivery_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_delivery_batch_number();


-- ══════════════════════════════════════════════════════════════
-- 10. FULFILLMENT VIEWS
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.order_item_fulfillment AS
SELECT
  oi.id                                                         AS order_item_id,
  oi.order_id,
  oi.category,
  oi.description,
  oi.size,
  COALESCE(oi.quantity, 1)                                      AS ordered_qty,
  COALESCE(SUM(CASE WHEN db.status NOT IN ('Cancelled','Rejected','Returned') THEN dbi.quantity_planned ELSE 0 END), 0) AS batched_qty,
  COALESCE(SUM(CASE WHEN db.status IN ('Delivered','Signed')   THEN dbi.quantity_delivered ELSE 0 END), 0) AS delivered_qty,
  COALESCE(oi.quantity, 1) -
    COALESCE(SUM(CASE WHEN db.status NOT IN ('Cancelled','Rejected','Returned') THEN dbi.quantity_planned ELSE 0 END), 0) AS remaining_qty
FROM public.order_items oi
LEFT JOIN public.delivery_batch_items dbi ON dbi.order_item_id = oi.id
LEFT JOIN public.delivery_batches     db  ON db.id = dbi.batch_id
WHERE oi.category NOT IN ('Delivery Fee','Installation Fee','Design Fee','Rush Fee','Discount')
GROUP BY oi.id, oi.order_id, oi.category, oi.description, oi.size, oi.quantity;

CREATE OR REPLACE VIEW public.order_fulfillment_summary AS
SELECT
  f.order_id,
  SUM(f.ordered_qty)   AS total_ordered_qty,
  SUM(f.batched_qty)   AS total_batched_qty,
  SUM(f.delivered_qty) AS total_delivered_qty,
  SUM(f.remaining_qty) AS total_remaining_qty,
  BOOL_AND(f.remaining_qty = 0) AND SUM(f.batched_qty) > 0 AS all_items_delivered,
  SUM(f.delivered_qty) > 0 AND NOT (BOOL_AND(f.remaining_qty = 0) AND SUM(f.batched_qty) > 0) AS partially_delivered
FROM public.order_item_fulfillment f
GROUP BY f.order_id;


-- ══════════════════════════════════════════════════════════════
-- 11. USER MANAGEMENT FUNCTIONS & TRIGGERS
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, display_name, role)
  VALUES (NEW.id, NEW.email, split_part(NEW.email, '@', 1), 'viewer')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE OR REPLACE FUNCTION update_user_role(target_user_id uuid, new_role text)
RETURNS void AS $$
DECLARE caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.user_profiles WHERE id = auth.uid();
  IF caller_role != 'admin' THEN RAISE EXCEPTION 'Only admins can change roles'; END IF;
  IF new_role NOT IN ('admin','production_manager','head_of_sales','sales','production_staff','viewer')
    THEN RAISE EXCEPTION 'Invalid role: %', new_role; END IF;
  UPDATE public.user_profiles SET role = new_role, updated_at = now() WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.get_order_drawing_count(p_order_id UUID)
RETURNS INTEGER LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER FROM public.drawings
  WHERE order_id = p_order_id AND deleted_at IS NULL;
$$;


-- ══════════════════════════════════════════════════════════════
-- 12. ORDER NUMBER SEQUENCE
-- ══════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS public.order_num_seq START WITH 1;

DO $$
DECLARE max_num integer;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN order_num ~ '^ORD-[0-9]+$'
    THEN CAST(REPLACE(order_num, 'ORD-', '') AS integer) ELSE 0 END
  ), 0) INTO max_num FROM public.orders;
  IF max_num > 0 THEN PERFORM setval('public.order_num_seq', max_num); END IF;
END $$;

CREATE OR REPLACE FUNCTION generate_order_num()
RETURNS text AS $$ SELECT 'ORD-' || LPAD(nextval('public.order_num_seq')::text, 3, '0'); $$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION set_order_num()
RETURNS trigger AS $$
BEGIN
  IF NEW.order_num IS NULL OR NEW.order_num = '' THEN
    NEW.order_num := generate_order_num();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auto_order_num ON public.orders;
CREATE TRIGGER auto_order_num
  BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION set_order_num();

ALTER TABLE public.orders ALTER COLUMN order_num SET DEFAULT '';


-- ══════════════════════════════════════════════════════════════
-- 13. PAYROLL SEQUENCES & HELPERS
-- ══════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS public.employee_num_seq START 1;
CREATE SEQUENCE IF NOT EXISTS public.payroll_run_seq  START 1;
CREATE SEQUENCE IF NOT EXISTS public.payroll_batch_seq START 1;

CREATE OR REPLACE FUNCTION next_employee_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN RETURN 'EMP-' || LPAD(nextval('employee_num_seq')::text, 3, '0'); END;
$$;

CREATE OR REPLACE FUNCTION next_payroll_run_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN RETURN 'PR-' || TO_CHAR(now(), 'YYYY') || '-' || LPAD(nextval('payroll_run_seq')::text, 4, '0'); END;
$$;

CREATE OR REPLACE FUNCTION next_payroll_batch_num()
RETURNS text LANGUAGE plpgsql AS $$
BEGIN RETURN 'BATCH-' || TO_CHAR(now(), 'YYYY') || '-' || LPAD(nextval('payroll_batch_seq')::text, 3, '0'); END;
$$;


-- ══════════════════════════════════════════════════════════════
-- 14. RPC FUNCTIONS (SECURITY DEFINER, service_role only)
-- ══════════════════════════════════════════════════════════════

-- ── post_journal_entry ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_journal_entry(
  p_entry_date   date,
  p_description  text,
  p_source_type  text,
  p_source_id    uuid,
  p_posted_by    uuid,
  p_lines        jsonb
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_sum      numeric(14,2);
  v_line     jsonb;
BEGIN
  SELECT COALESCE(SUM((elem->>'amount')::numeric), 0)
  INTO v_sum FROM jsonb_array_elements(p_lines) AS elem;
  IF ABS(v_sum) > 0.005 THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: lines sum to % (must be 0)', v_sum USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE source_type = p_source_type AND source_id = p_source_id AND status = 'active') THEN
    RAISE EXCEPTION 'DUPLICATE_POSTING: % % already has an active journal entry', p_source_type, p_source_id USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO journal_entries (entry_date, description, source_type, source_id, posted_by)
  VALUES (p_entry_date, p_description, p_source_type, p_source_id, p_posted_by)
  RETURNING id INTO v_entry_id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO journal_lines (journal_entry_id, account_id, amount, description)
    VALUES (v_entry_id, (v_line->>'account_id')::uuid, (v_line->>'amount')::numeric, v_line->>'description');
  END LOOP;
  RETURN v_entry_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.post_journal_entry(date,text,text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.post_journal_entry(date,text,text,uuid,uuid,jsonb) TO service_role;

-- ── atomic_reverse_journal_entry ──────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_reverse_journal_entry(
  p_journal_id uuid,
  p_reason     text,
  p_posted_by  uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_entry       public.journal_entries%ROWTYPE;
  v_reversal_id uuid;
  v_line_sum    numeric := 0;
  v_line        public.journal_lines%ROWTYPE;
  v_count       integer;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_journal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNAL_NOT_FOUND: Journal entry % does not exist', p_journal_id; END IF;
  IF v_entry.status <> 'active' THEN RAISE EXCEPTION 'ALREADY_REVERSED: Journal entry % has already been reversed', p_journal_id; END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE source_type = 'reversal' AND source_id = p_journal_id) THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: A reversal entry for journal % already exists', p_journal_id;
  END IF;
  INSERT INTO public.journal_entries (entry_date, description, source_type, source_id, status, posted_by)
  VALUES (CURRENT_DATE, 'REVERSAL of "' || v_entry.description || '". Reason: ' || TRIM(p_reason), 'reversal', p_journal_id, 'active', p_posted_by)
  RETURNING id INTO v_reversal_id;
  FOR v_line IN SELECT * FROM public.journal_lines WHERE journal_entry_id = p_journal_id LOOP
    v_line_sum := v_line_sum + (-v_line.amount);
    INSERT INTO public.journal_lines (journal_entry_id, account_id, amount, description)
    VALUES (v_reversal_id, v_line.account_id, -v_line.amount, 'REVERSAL: ' || COALESCE(v_line.description, ''));
  END LOOP;
  IF ABS(v_line_sum) > 0.005 THEN RAISE EXCEPTION 'UNBALANCED_REVERSAL: reversed lines sum to %', v_line_sum; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE journal_entry_id = p_journal_id) THEN
    RAISE EXCEPTION 'EMPTY_ENTRY: Journal entry % has no lines', p_journal_id;
  END IF;
  UPDATE public.journal_entries SET status = 'reversed' WHERE id = p_journal_id;
  IF v_entry.source_type = 'purchase' THEN
    UPDATE public.supplier_purchases SET journal_entry_id = NULL WHERE id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND: supplier_purchase %', v_entry.source_id; END IF;
  ELSIF v_entry.source_type = 'manual_payment' THEN
    UPDATE public.manual_supplier_payments SET journal_entry_id = NULL WHERE id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND: manual_supplier_payment %', v_entry.source_id; END IF;
  ELSIF v_entry.source_type = 'chatpesa_allocation' THEN
    UPDATE public.chatpesa_payment_allocations SET journal_entry_id = NULL WHERE id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND: chatpesa_payment_allocation %', v_entry.source_id; END IF;
  ELSIF v_entry.source_type = 'supplier_opening_balance' THEN
    UPDATE public.suppliers SET opening_balance_journal_entry_id = NULL WHERE id = v_entry.source_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND: supplier %', v_entry.source_id; END IF;
  END IF;
  RETURN v_reversal_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.atomic_reverse_journal_entry(uuid,text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.atomic_reverse_journal_entry(uuid,text,uuid) TO service_role;

-- ── allocate_chatpesa_split ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_chatpesa_split(
  p_transaction_id uuid,
  p_allocations    jsonb,
  p_created_by     uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_tx             public.chatpesa_transactions%ROWTYPE;
  v_tx_amount      numeric;
  v_already_alloc  numeric := 0;
  v_total_new      numeric := 0;
  v_purchase_id    uuid;
  v_purchase_alloc numeric;
  v_purchase_exist numeric;
  v_purchase_total numeric;
  v_match_status   text;
  v_matched_at     timestamptz;
  v_alloc          jsonb;
  v_row_id         uuid;
  v_row_type       text;
  v_row_amount     numeric;
  v_row_cat_id     uuid;
  v_row_petty      text;
  v_row_purchase   uuid;
  v_inserted       jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_tx FROM public.chatpesa_transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TX_NOT_FOUND: Transaction % does not exist', p_transaction_id; END IF;
  IF v_tx.tx_type <> 'debit' THEN RAISE EXCEPTION 'TX_NOT_DEBIT: Can only allocate debit transactions'; END IF;
  IF v_tx.match_status = 'ignored' THEN RAISE EXCEPTION 'TX_IGNORED: Cannot allocate an ignored transaction'; END IF;
  v_tx_amount := COALESCE(v_tx.amount, 0);
  SELECT COALESCE(SUM(amount), 0) INTO v_already_alloc FROM public.chatpesa_payment_allocations WHERE transaction_id = p_transaction_id;
  SELECT COALESCE(SUM((elem->>'amount')::numeric), 0) INTO v_total_new FROM jsonb_array_elements(p_allocations) AS elem;
  IF v_already_alloc + v_total_new > v_tx_amount + 0.01 THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: Transaction is %, already allocated %, adding % would exceed total',
      v_tx_amount::text, v_already_alloc::text, v_total_new::text;
  END IF;
  FOR v_purchase_id IN
    SELECT DISTINCT (elem->>'supplier_purchase_id')::uuid FROM jsonb_array_elements(p_allocations) AS elem
    WHERE elem->>'allocation_type' = 'supplier_purchase' AND (elem->>'supplier_purchase_id') IS NOT NULL
  LOOP
    SELECT COALESCE(SUM((elem->>'amount')::numeric), 0) INTO v_purchase_alloc
    FROM jsonb_array_elements(p_allocations) AS elem
    WHERE elem->>'allocation_type' = 'supplier_purchase' AND (elem->>'supplier_purchase_id')::uuid = v_purchase_id;
    SELECT COALESCE(total_amount, 0), COALESCE(amount_paid, 0)
    INTO v_purchase_total, v_purchase_exist FROM public.supplier_purchases WHERE id = v_purchase_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND: supplier_purchase % does not exist', v_purchase_id; END IF;
    IF v_purchase_exist + v_purchase_alloc > v_purchase_total + 0.01 THEN
      RAISE EXCEPTION 'PURCHASE_OVERPAID: Purchase % would be overpaid — total %, already paid %, adding %',
        v_purchase_id::text, v_purchase_total::text, v_purchase_exist::text, v_purchase_alloc::text;
    END IF;
  END LOOP;
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO public.chatpesa_payment_allocations (
      transaction_id, allocation_type, amount, note, created_by,
      supplier_purchase_id, supplier_id, petty_cash_category, accounting_category_id
    ) VALUES (
      p_transaction_id,
      v_alloc->>'allocation_type',
      (v_alloc->>'amount')::numeric,
      NULLIF(TRIM(COALESCE(v_alloc->>'note', '')), ''),
      p_created_by,
      CASE WHEN v_alloc->>'allocation_type' = 'supplier_purchase' THEN (v_alloc->>'supplier_purchase_id')::uuid ELSE NULL END,
      CASE WHEN v_alloc->>'allocation_type' = 'opening_balance'   THEN (v_alloc->>'supplier_id')::uuid           ELSE NULL END,
      CASE WHEN v_alloc->>'allocation_type' = 'petty_cash'        THEN v_alloc->>'petty_cash_category'           ELSE NULL END,
      CASE WHEN (v_alloc->>'accounting_category_id') IS NOT NULL  THEN (v_alloc->>'accounting_category_id')::uuid ELSE NULL END
    )
    RETURNING id, allocation_type, amount, accounting_category_id, petty_cash_category, supplier_purchase_id
    INTO v_row_id, v_row_type, v_row_amount, v_row_cat_id, v_row_petty, v_row_purchase;
    v_inserted := v_inserted || jsonb_build_array(jsonb_build_object(
      'id', v_row_id, 'allocation_type', v_row_type, 'amount', v_row_amount,
      'accounting_category_id', v_row_cat_id, 'petty_cash_category', v_row_petty, 'supplier_purchase_id', v_row_purchase
    ));
  END LOOP;
  IF v_already_alloc + v_total_new >= v_tx_amount - 0.01 THEN
    v_match_status := 'matched'; v_matched_at := NOW();
  ELSE
    v_match_status := 'partial'; v_matched_at := NULL;
  END IF;
  UPDATE public.chatpesa_transactions
  SET match_status = v_match_status, matched_at = v_matched_at,
      matched_by = CASE WHEN v_match_status = 'matched' THEN p_created_by ELSE NULL END
  WHERE id = p_transaction_id;
  RETURN jsonb_build_object('inserted', v_inserted, 'match_status', v_match_status,
    'already_allocated', v_already_alloc, 'total_new', v_total_new);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.allocate_chatpesa_split(uuid,jsonb,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.allocate_chatpesa_split(uuid,jsonb,uuid) TO service_role;

-- ── replace_purchase_order_links ──────────────────────────────
CREATE OR REPLACE FUNCTION public.replace_purchase_order_links(p_purchase_id uuid, p_links jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  DELETE FROM public.purchase_order_links WHERE purchase_id = p_purchase_id;
  IF jsonb_array_length(p_links) > 0 THEN
    INSERT INTO public.purchase_order_links (purchase_id, order_id, amount)
    SELECT p_purchase_id, (link->>'order_id')::uuid,
      CASE WHEN (link->>'amount') IS NOT NULL AND (link->>'amount') <> ''
           THEN (link->>'amount')::numeric(12,2) ELSE NULL END
    FROM jsonb_array_elements(p_links) AS link;
  END IF;
END;
$$;

-- ── replace_order_allocations (skilled_casual, no pay cap) ────
CREATE OR REPLACE FUNCTION public.replace_order_allocations(
  p_entry_id    uuid,
  p_run_id      uuid,
  p_employee_id uuid,
  p_allocations jsonb,
  p_created_by  uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry    payroll_entries%ROWTYPE;
  v_total    numeric := 0;
  v_alloc    jsonb;
  v_inserted int := 0;
  v_item_id  uuid;
BEGIN
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found: %', p_entry_id; END IF;
  IF v_entry.amount_paid > 0 THEN
    RAISE EXCEPTION 'Cannot change allocations after payment has been recorded';
  END IF;
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_total := v_total + (v_alloc->>'allocated_amount')::numeric;
  END LOOP;
  IF v_total <= 0 THEN RAISE EXCEPTION 'Total allocation must be greater than zero'; END IF;
  -- No net_pay cap: skilled_casual gross_pay = sum of allocations (per-item, no ceiling)
  DELETE FROM payroll_order_allocations WHERE entry_id = p_entry_id;
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_item_id := CASE
      WHEN (v_alloc->>'order_item_id') IS NOT NULL AND (v_alloc->>'order_item_id') <> ''
      THEN (v_alloc->>'order_item_id')::uuid ELSE NULL END;
    INSERT INTO payroll_order_allocations (
      run_id, entry_id, employee_id, order_id, order_item_id, allocated_amount, notes, created_by
    ) VALUES (
      p_run_id, p_entry_id, p_employee_id,
      (v_alloc->>'order_id')::uuid, v_item_id,
      (v_alloc->>'allocated_amount')::numeric, v_alloc->>'notes', p_created_by
    );
    v_inserted := v_inserted + 1;
  END LOOP;
  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.replace_order_allocations(uuid,uuid,uuid,jsonb,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.replace_order_allocations(uuid,uuid,uuid,jsonb,uuid) TO service_role;

-- ── record_payroll_payment ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_payroll_payment(
  p_entry_id       uuid,
  p_batch_id       uuid,
  p_employee_id    uuid,
  p_amount         numeric,
  p_payment_date   date,
  p_payment_method text,
  p_phone          text,
  p_reference      text,
  p_notes          text,
  p_created_by     uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry      payroll_entries%ROWTYPE;
  v_new_paid   numeric;
  v_new_status text;
  v_payment_id uuid;
BEGIN
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found: %', p_entry_id; END IF;
  IF p_amount > (v_entry.net_pay - v_entry.amount_paid) + 0.01 THEN
    RAISE EXCEPTION 'Payment % exceeds remaining balance %', p_amount, (v_entry.net_pay - v_entry.amount_paid);
  END IF;
  INSERT INTO payroll_payments (
    batch_id, entry_id, employee_id, amount, payment_date,
    payment_method, phone, reference, status, notes, created_by
  ) VALUES (
    p_batch_id, p_entry_id, p_employee_id, p_amount, p_payment_date,
    p_payment_method, p_phone, p_reference, 'confirmed', p_notes, p_created_by
  ) RETURNING id INTO v_payment_id;
  v_new_paid   := v_entry.amount_paid + p_amount;
  v_new_status := CASE WHEN (v_entry.net_pay - v_new_paid) <= 0.01 THEN 'paid' ELSE 'part_paid' END;
  UPDATE payroll_entries SET amount_paid = v_new_paid, payment_status = v_new_status WHERE id = p_entry_id;
  RETURN jsonb_build_object(
    'payment_id', v_payment_id, 'entry_status', v_new_status,
    'amount_paid', v_new_paid, 'balance', v_entry.net_pay - v_new_paid
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_payroll_payment(uuid,uuid,uuid,numeric,date,text,text,text,text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_payroll_payment(uuid,uuid,uuid,numeric,date,text,text,text,text,uuid) TO service_role;

-- ── reconcile_payment_batch ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_payment_batch(
  p_batch_id      uuid,
  p_chatpesa_ref  text,
  p_payment_date  date,
  p_reconciled_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch   payroll_payment_batches%ROWTYPE;
  v_link    payroll_batch_entry_links%ROWTYPE;
  v_entry   payroll_entries%ROWTYPE;
  v_count   int := 0;
  v_total   numeric := 0;
BEGIN
  SELECT * INTO v_batch FROM payroll_payment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF v_batch.status = 'reconciled' THEN RAISE EXCEPTION 'Batch already reconciled'; END IF;
  FOR v_link IN SELECT * FROM payroll_batch_entry_links WHERE batch_id = p_batch_id LOOP
    -- Skip entries that were not in the CSV export (no valid phone)
    CONTINUE WHEN v_batch.exported_entry_ids IS NOT NULL
      AND NOT (v_link.entry_id = ANY(v_batch.exported_entry_ids));
    SELECT * INTO v_entry FROM payroll_entries WHERE id = v_link.entry_id FOR UPDATE;
    CONTINUE WHEN v_entry.net_pay - v_entry.amount_paid <= 0.01;
    DECLARE
      v_pay_amount numeric := least(v_link.amount, v_entry.net_pay - v_entry.amount_paid);
      v_new_paid   numeric;
      v_new_status text;
    BEGIN
      INSERT INTO payroll_payments (
        batch_id, entry_id, employee_id, amount, payment_date,
        payment_method, reference, status, created_by
      ) VALUES (
        p_batch_id, v_link.entry_id, v_entry.employee_id,
        v_pay_amount, p_payment_date,
        v_batch.payment_method, p_chatpesa_ref, 'confirmed', p_reconciled_by
      );
      v_new_paid   := v_entry.amount_paid + v_pay_amount;
      v_new_status := CASE WHEN (v_entry.net_pay - v_new_paid) <= 0.01 THEN 'paid' ELSE 'part_paid' END;
      UPDATE payroll_entries SET amount_paid = v_new_paid, payment_status = v_new_status WHERE id = v_link.entry_id;
      v_count := v_count + 1;
      v_total := v_total + v_pay_amount;
    END;
  END LOOP;
  UPDATE payroll_payment_batches
  SET status = 'reconciled', chatpesa_ref = p_chatpesa_ref,
      reconciled_at = now(), reconciled_by = p_reconciled_by
  WHERE id = p_batch_id;
  RETURN jsonb_build_object('payments_created', v_count, 'total_paid', v_total);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reconcile_payment_batch(uuid,text,date,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reconcile_payment_batch(uuid,text,date,uuid) TO service_role;


-- ══════════════════════════════════════════════════════════════
-- 15. STORAGE BUCKETS
-- ══════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES ('order-documents', 'order-documents', false)
ON CONFLICT (id) DO NOTHING;

DO $$ DECLARE pol RECORD; BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname IN ('storage_upload','storage_view','storage_delete') LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "storage_upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'order-documents' AND auth.role() = 'authenticated');
CREATE POLICY "storage_view"   ON storage.objects FOR SELECT
  USING (bucket_id = 'order-documents' AND auth.role() = 'authenticated');
CREATE POLICY "storage_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'order-documents' AND auth.role() = 'authenticated');


-- ══════════════════════════════════════════════════════════════
-- 16. SEED DATA
-- ══════════════════════════════════════════════════════════════

INSERT INTO public.admin_settings (key, value) VALUES
  ('batch_delivery_unit_threshold',  '20'),
  ('batch_delivery_value_threshold', '500000')
ON CONFLICT (key) DO NOTHING;

-- SHA statutory rule (current fixed deduction)
INSERT INTO public.statutory_rules (rule_type, effective_from, fixed_amount, description)
VALUES ('sha', '2024-10-01', 300.00, 'SHA/SHIF fixed deduction per payment')
ON CONFLICT DO NOTHING;

-- Chart of Accounts (76 accounts)
INSERT INTO public.accounting_accounts (code, name, type, subtype, is_leaf, sort_order) VALUES
('1000','Cash on Hand','Asset',NULL,true,10),
('1010','Chatpesa / M-Pesa Float','Asset',NULL,true,20),
('1020','Default Bank','Asset',NULL,true,30),
('1100','Accounts Receivable','Asset',NULL,true,40),
('1110','Other Receivables','Asset',NULL,true,50),
('1200','Inventory','Asset',NULL,true,60),
('1210','Production in Progress','Asset',NULL,true,70),
('1220','Prepayments & Deposits','Asset',NULL,true,80),
('1300','Website & Digital Assets','Asset',NULL,true,90),
('1400','Furniture & Fittings','Asset',NULL,true,100),
('1410','Large Format Printer','Asset',NULL,true,110),
('1420','Workshop Machines','Asset',NULL,true,120),
('1430','Tools & Equipment','Asset',NULL,true,130),
('1440','Workshop Construction','Asset',NULL,true,140),
('1500','Withholding Tax Receivable','Asset',NULL,true,150),
('2000','Accounts Payable','Liability',NULL,true,200),
('2010','VAT / GST Payable','Liability',NULL,true,210),
('2020','Income Tax Payable','Liability',NULL,true,220),
('2100','ABSA Loan','Liability',NULL,true,230),
('2110','Interdivisional Loan','Liability',NULL,true,240),
('2120','Other Loans Payable','Liability',NULL,true,250),
('3000','Opening Balance Equity','Equity',NULL,true,300),
('3100','Retained Earnings','Equity',NULL,true,310),
('4000','Direct Sales','Revenue',NULL,true,400),
('4100','Agent Sales','Revenue',NULL,true,410),
('4200','Website Sales','Revenue',NULL,true,420),
('4300','Outsourced Sales','Revenue',NULL,true,430),
('4400','Inventory Sales','Revenue',NULL,true,440),
('4500','Furniture Sales','Revenue',NULL,true,450),
('4600','Delivery & Installation Income','Revenue',NULL,true,460),
('4700','Design Services Income','Revenue',NULL,true,470),
('4800','Interest Received','Revenue',NULL,true,480),
('4990','Other Income','Revenue',NULL,true,490),
('5010','Timber','Expense','Cost of Sales',true,510),
('5020','Boards & MDF','Expense','Cost of Sales',true,520),
('5030','Hardware & Fittings','Expense','Cost of Sales',true,530),
('5040','Fabric & Upholstery','Expense','Cost of Sales',true,540),
('5050','Foam & Padding','Expense','Cost of Sales',true,550),
('5060','Canvas & Print Media','Expense','Cost of Sales',true,560),
('5070','Ink & Solvents','Expense','Cost of Sales',true,570),
('5080','Frames','Expense','Cost of Sales',true,580),
('5090','Mirrors & Glass','Expense','Cost of Sales',true,590),
('5100','Metal & Welding Supplies','Expense','Cost of Sales',true,600),
('5110','Workshop Consumables','Expense','Cost of Sales',true,610),
('5120','Packaging','Expense','Cost of Sales',true,620),
('5130','Outsourced Production','Expense','Cost of Sales',true,630),
('5140','Direct Labour','Expense','Cost of Sales',true,640),
('5150','Direct Transport','Expense','Cost of Sales',true,650),
('5160','Additional Works','Expense','Cost of Sales',true,660),
('5165','Finishing Materials – Paints & Coatings','Expense','Cost of Sales',true,665),
('6000','Rent','Expense','Operating Expense',true,700),
('6010','Electricity & Water','Expense','Operating Expense',true,710),
('6020','Internet & Telephone','Expense','Operating Expense',true,720),
('6030','Transport & Fuel','Expense','Operating Expense',true,730),
('6040','Staff Meals & Welfare','Expense','Operating Expense',true,740),
('6050','Staff Airtime','Expense','Operating Expense',true,750),
('6060','Office Supplies & Stationery','Expense','Operating Expense',true,760),
('6070','Repairs & Maintenance','Expense','Operating Expense',true,770),
('6080','Marketing & Advertising','Expense','Operating Expense',true,780),
('6090','Bank Charges & Fees','Expense','Operating Expense',true,790),
('6100','Casual Labour','Expense','Operating Expense',true,800),
('6110','Software & Subscriptions','Expense','Operating Expense',true,810),
('6120','Licenses & Permits','Expense','Operating Expense',true,820),
('6130','Professional Fees','Expense','Operating Expense',true,830),
('6140','Travel & Accommodation','Expense','Operating Expense',true,840),
('6150','Cleaning & Sanitation','Expense','Operating Expense',true,850),
('6160','Security','Expense','Operating Expense',true,860),
('6170','Insurance','Expense','Operating Expense',true,870),
('6180','Depreciation','Expense','Operating Expense',true,880),
('6190','Equipment Hire','Expense','Operating Expense',true,890),
('6200','Printing & Photocopying','Expense','Operating Expense',true,900),
('6210','Staff Salaries','Expense','Operating Expense',true,910),
('6220','NHIF / NSSF / PAYE','Expense','Operating Expense',true,920),
('6230','Miscellaneous / Sundry','Expense','Operating Expense',true,930),
('6240','Drawings / Owner Withdrawals','Expense','Operating Expense',true,940),
('6250','Rounding Expense','Expense','Operating Expense',true,950)
ON CONFLICT (code) DO NOTHING;

-- Accounting categories (populate only if empty)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounting_categories LIMIT 1) THEN
    INSERT INTO public.accounting_categories (account_id, label, for_purchases, for_petty_cash, sort_order)
    SELECT a.id, a.name, true, false, a.sort_order
    FROM public.accounting_accounts a WHERE a.subtype = 'Cost of Sales' AND a.is_active;
    INSERT INTO public.accounting_categories (account_id, label, for_purchases, for_petty_cash, sort_order)
    SELECT a.id, a.name, true,
      (a.code IN ('6030','6040','6050','6060','6070','6090','6100','6110','6120','6130','6150','6160','6190','6200','6230')),
      a.sort_order
    FROM public.accounting_accounts a WHERE a.subtype = 'Operating Expense' AND a.is_active;
  END IF;
END $$;

-- Seed users
INSERT INTO public.user_profiles (id, email, role)
SELECT id, email, 'viewer' FROM auth.users
WHERE id NOT IN (SELECT id FROM public.user_profiles)
ON CONFLICT (id) DO NOTHING;

UPDATE public.user_profiles SET role = 'admin'
WHERE id = (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1);


-- ══════════════════════════════════════════════════════════════
-- 17. ORDER NUMBER SEQUENCE ADVANCE
-- (advance past any rows already in the table)
-- ══════════════════════════════════════════════════════════════

DO $$
DECLARE max_num integer;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN order_num ~ '^ORD-[0-9]+$'
    THEN CAST(REPLACE(order_num, 'ORD-', '') AS integer) ELSE 0 END
  ), 0) INTO max_num FROM public.orders;
  IF max_num > 0 THEN PERFORM setval('public.order_num_seq', max_num); END IF;
END $$;


-- ══════════════════════════════════════════════════════════════
-- DONE.
--
-- Manual steps (Supabase Dashboard — cannot be done via SQL):
--   1. Storage > Create Buckets: 'order-drawings', 'supplier-files',
--      'employee-documents' — all PRIVATE
--   2. Add SUPABASE_SERVICE_KEY to .env.local (server-side only)
--
-- Order workflow:
--   Inquiry → Quote Approved → Deposit Paid → Material Check →
--   Production → Quality Control → Ready for Delivery →
--   Partially Delivered → Delivered → Closed
--
-- Payroll workflow:
--   draft → approved → closed  (reopenable with reason)
--   Batch: draft → exported → reconciled
-- ══════════════════════════════════════════════════════════════

COMMIT;
