-- ============================================================
-- Canvas Guy Tracker — Suppliers Module Migration
-- Run this in Supabase SQL Editor (or via supabase db push)
-- ============================================================

-- 1. SUPPLIERS
-- Core supplier profile
CREATE TABLE IF NOT EXISTS suppliers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  contact_person   text,
  phone            text,
  email            text,
  materials_supplied text,        -- free-text: "Timber, MDF, Veneer"
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);

-- RLS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read
CREATE POLICY "suppliers_select" ON suppliers
  FOR SELECT USING (auth.role() = 'authenticated');

-- Admin + production_manager can insert
CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

-- Admin + production_manager can update
CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

-- Admin only can delete
CREATE POLICY "suppliers_delete" ON suppliers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- 2. SUPPLIER_PURCHASES
-- Each purchase belongs to a supplier, optionally linked to a customer order
CREATE TABLE IF NOT EXISTS supplier_purchases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id      uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  order_id         uuid REFERENCES orders(id) ON DELETE SET NULL,  -- optional link
  purchase_date    date NOT NULL DEFAULT CURRENT_DATE,
  items_bought     text,                       -- description of what was bought
  total_amount     numeric(12,2) NOT NULL DEFAULT 0,
  invoice_path     text,                       -- storage path for invoice attachment
  invoice_name     text,                       -- original file name
  amount_paid      numeric(12,2) NOT NULL DEFAULT 0,
  payment_status   text NOT NULL DEFAULT 'Unpaid'
                     CHECK (payment_status IN ('Unpaid', 'Part Paid', 'Paid')),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),

  -- Ensure amount_paid never exceeds total_amount
  CONSTRAINT paid_lte_total CHECK (amount_paid <= total_amount),
  -- Ensure amounts are non-negative
  CONSTRAINT total_non_negative CHECK (total_amount >= 0),
  CONSTRAINT paid_non_negative  CHECK (amount_paid  >= 0)
);

-- Index for common lookups
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_supplier ON supplier_purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_order    ON supplier_purchases(order_id);
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_status   ON supplier_purchases(payment_status);
CREATE INDEX IF NOT EXISTS idx_supplier_purchases_date     ON supplier_purchases(purchase_date DESC);

-- RLS
ALTER TABLE supplier_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supplier_purchases_select" ON supplier_purchases
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "supplier_purchases_insert" ON supplier_purchases
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_purchases_update" ON supplier_purchases
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_purchases_delete" ON supplier_purchases
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- 3. SUPPLIER_ATTACHMENTS
-- Generic attachments on a supplier profile (certificates, contracts, etc.)
CREATE TABLE IF NOT EXISTS supplier_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  name         text NOT NULL,
  file_path    text NOT NULL,
  file_size    bigint,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  uuid REFERENCES auth.users(id)
);

ALTER TABLE supplier_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "supplier_attachments_select" ON supplier_attachments
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "supplier_attachments_insert" ON supplier_attachments
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager', 'head_of_sales')
    )
  );

CREATE POLICY "supplier_attachments_delete" ON supplier_attachments
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'production_manager')
    )
  );

-- ============================================================
-- STORAGE BUCKET: supplier-files
-- Run separately in Supabase dashboard or via CLI:
--
--   insert into storage.buckets (id, name, public)
--   values ('supplier-files', 'supplier-files', false);
--
-- Then add these storage policies:
--
-- Policy: authenticated users can upload
--   (storage.foldername(name))[1] = 'suppliers'
--     or 'purchases'
--
-- Policy: authenticated users can read their own uploads
-- ============================================================

-- Storage bucket insert (uncomment if running via SQL editor with storage access)
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('supplier-files', 'supplier-files', false)
-- ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies
-- These must match what the API route uses (service role bypasses them anyway)
