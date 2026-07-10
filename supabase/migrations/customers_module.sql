-- ============================================================
-- Canvas Guy Tracker — Customers & Contacts Module
-- Run AFTER suppliers_module.sql
-- ============================================================

-- 1. CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
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

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customers_select" ON customers
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "customers_insert" ON customers
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin','production_manager','head_of_sales','sales'))
  );

CREATE POLICY "customers_update" ON customers
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin','production_manager','head_of_sales','sales'))
  );

CREATE POLICY "customers_delete" ON customers
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 2. CUSTOMER NOTES
CREATE TABLE IF NOT EXISTS customer_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  content     text NOT NULL,
  author_name text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_notes_select" ON customer_notes
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "customer_notes_insert" ON customer_notes
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "customer_notes_delete" ON customer_notes
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin','production_manager','head_of_sales'))
  );

-- 3. CONTACTS (General + Transporter only — customers/suppliers have their own tables)
CREATE TABLE IF NOT EXISTS contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_type text NOT NULL CHECK (contact_type IN ('General','Transporter')),
  name         text NOT NULL,
  company      text,
  phone        text,
  email        text,
  address      text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contacts_select" ON contacts
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "contacts_insert" ON contacts
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "contacts_update" ON contacts
  FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "contacts_delete" ON contacts
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid()
            AND role IN ('admin','production_manager','head_of_sales'))
  );

-- 4. ALTER ORDERS — add customer link and payment deadline
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_due_date date;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id    ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_due    ON orders(payment_due_date);
