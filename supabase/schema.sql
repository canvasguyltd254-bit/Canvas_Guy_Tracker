-- ════════════════════════════════════════════════════════════
-- CANVAS GUY TRACKER — COMPLETE DATABASE SCHEMA
-- Paste entire file into Supabase SQL Editor → Run
-- Safe to rerun — uses DROP IF EXISTS for policies.
-- ════════════════════════════════════════════════════════════


-- ══════════════════════════
-- HELPER FUNCTION
-- ══════════════════════════

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_profiles WHERE id = auth.uid()),
    'viewer'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ══════════════════════════
-- 1. TABLES
-- ══════════════════════════

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_num text NOT NULL UNIQUE,
  client text NOT NULL,
  contact_person text,
  author text,
  items text,
  status text NOT NULL DEFAULT 'Inquiry',
  due_date date,
  assigned_to text,
  notes text,
  total_value numeric(12,2) DEFAULT 0,
  quote_number text,
  invoice_number text,
  order_type text NOT NULL DEFAULT 'standard',
  parent_order_id uuid REFERENCES public.orders(id),
  repair_reason text,
  deliverable_units integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'Other',
  description text,
  quantity integer NOT NULL DEFAULT 1,
  size text,
  finish_type text,
  finish_color text,
  wood_type text,
  unit_price numeric(12,2) DEFAULT 0,
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.order_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  name text NOT NULL,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  file_size integer,
  mime_type text,
  uploaded_at timestamptz DEFAULT now(),
  uploaded_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  description text NOT NULL,
  payment_date date NOT NULL DEFAULT current_date,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.order_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  content text NOT NULL,
  author_name text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.order_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  batch_number integer NOT NULL DEFAULT 1,
  delivery_date date NOT NULL DEFAULT current_date,
  quantity integer NOT NULL,
  description text,
  delivery_location text,
  delivered_by text,
  received_by text,
  notes text,
  delivery_sheet_path text,
  admin_authorized boolean DEFAULT false,
  admin_auth_reason text,
  authorized_by uuid REFERENCES auth.users(id),
  payment_status_at_delivery text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.order_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  description text NOT NULL,
  old_value text,
  new_value text,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  display_name text,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);


-- ══════════════════════════
-- 2. INDEXES
-- ══════════════════════════

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_parent ON public.orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_quote ON public.orders(quote_number) WHERE quote_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_invoice ON public.orders(invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_docs_order ON public.order_documents(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON public.order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_notes_order ON public.order_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_order_deliveries_order ON public.order_deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_order_activities_order ON public.order_activities(order_id);


-- ══════════════════════════
-- 3. ROW LEVEL SECURITY
-- ══════════════════════════

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- ── Drop existing policies (safe rerun) ──
DO $$ DECLARE pol RECORD; BEGIN
  FOR pol IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ── Orders ──
CREATE POLICY "orders_select" ON public.orders FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "orders_insert" ON public.orders FOR INSERT WITH CHECK (
  auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales')
);
CREATE POLICY "orders_update" ON public.orders FOR UPDATE USING (
  auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff')
);
CREATE POLICY "orders_delete" ON public.orders FOR DELETE USING (get_user_role() = 'admin');

-- ── Order Items ──
CREATE POLICY "items_select" ON public.order_items FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "items_insert" ON public.order_items FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "items_update" ON public.order_items FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "items_delete" ON public.order_items FOR DELETE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));

-- ── Documents ──
CREATE POLICY "docs_select" ON public.order_documents FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "docs_insert" ON public.order_documents FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() != 'viewer');
CREATE POLICY "docs_update" ON public.order_documents FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() != 'viewer');
CREATE POLICY "docs_delete" ON public.order_documents FOR DELETE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager'));

-- ── Payments ──
CREATE POLICY "pay_select" ON public.order_payments FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "pay_insert" ON public.order_payments FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','head_of_sales','sales'));
CREATE POLICY "pay_delete" ON public.order_payments FOR DELETE USING (get_user_role() = 'admin');

-- ── Notes ──
CREATE POLICY "notes_select" ON public.order_notes FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "notes_insert" ON public.order_notes FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() != 'viewer');

-- ── Deliveries ──
CREATE POLICY "del_select" ON public.order_deliveries FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "del_insert" ON public.order_deliveries FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','production_staff'));
CREATE POLICY "del_delete" ON public.order_deliveries FOR DELETE USING (get_user_role() = 'admin');

-- ── Activities ──
CREATE POLICY "act_select" ON public.order_activities FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "act_insert" ON public.order_activities FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- ── User Profiles ──
CREATE POLICY "profiles_select" ON public.user_profiles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "profiles_insert" ON public.user_profiles FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "profiles_update_own" ON public.user_profiles FOR UPDATE USING (auth.uid() = id);


-- ══════════════════════════
-- 4. STORAGE
-- ══════════════════════════

INSERT INTO storage.buckets (id, name, public)
  VALUES ('order-documents', 'order-documents', false)
  ON CONFLICT (id) DO NOTHING;

-- Drop existing storage policies safely
DO $$ DECLARE pol RECORD; BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN ('storage_upload','storage_view','storage_delete') LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "storage_upload" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'order-documents' AND auth.role() = 'authenticated');
CREATE POLICY "storage_view" ON storage.objects FOR SELECT
  USING (bucket_id = 'order-documents' AND auth.role() = 'authenticated');
CREATE POLICY "storage_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'order-documents' AND auth.role() = 'authenticated');


-- ══════════════════════════
-- 5. FUNCTIONS & TRIGGERS
-- ══════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON public.orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE OR REPLACE FUNCTION update_user_role(target_user_id uuid, new_role text)
RETURNS void AS $$
DECLARE caller_role text;
BEGIN
  SELECT role INTO caller_role FROM public.user_profiles WHERE id = auth.uid();
  IF caller_role != 'admin' THEN RAISE EXCEPTION 'Only admins can change roles'; END IF;
  IF new_role NOT IN ('admin','production_manager','sales','production_staff','viewer') THEN RAISE EXCEPTION 'Invalid role: %', new_role; END IF;
  UPDATE public.user_profiles SET role = new_role, updated_at = now() WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;



-- ══════════════════════════
-- 5b. ORDER NUMBER SEQUENCE
-- ══════════════════════════

-- Auto-generate order numbers (ORD-001, ORD-002, etc.)
DROP SEQUENCE IF EXISTS public.order_num_seq;
CREATE SEQUENCE public.order_num_seq START WITH 1;

-- Advance sequence past any existing orders
DO $$
DECLARE max_num integer;
BEGIN
  SELECT COALESCE(MAX(
    CASE WHEN order_num ~ '^ORD-[0-9]+$'
    THEN CAST(REPLACE(order_num, 'ORD-', '') AS integer)
    ELSE 0 END
  ), 0) INTO max_num FROM public.orders;
  IF max_num > 0 THEN
    PERFORM setval('public.order_num_seq', max_num);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION generate_order_num()
RETURNS text AS $$
  SELECT 'ORD-' || LPAD(nextval('public.order_num_seq')::text, 3, '0');
$$ LANGUAGE sql;

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
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION set_order_num();

ALTER TABLE public.orders ALTER COLUMN order_num SET DEFAULT '';

-- ══════════════════════════
-- 6. SEED USERS
-- ══════════════════════════

INSERT INTO public.user_profiles (id, email, role)
SELECT id, email, 'viewer' FROM auth.users
WHERE id NOT IN (SELECT id FROM public.user_profiles)
ON CONFLICT (id) DO NOTHING;

UPDATE public.user_profiles SET role = 'admin'
WHERE id = (SELECT id FROM auth.users ORDER BY created_at ASC LIMIT 1);


-- ════════════════════════════════════════════════════════════
-- DONE. Safe to rerun.
--
-- Workflow (standard):
-- Inquiry → Quote Approved → Deposit Paid → Material Check →
-- Production → Quality Control → Ready for Delivery →
-- Partially Delivered → Delivered → Closed
--
-- Workflow (repair/return):
-- Reported → Assessed → In Repair → QC → Redelivered → Closed
--
-- Roles: admin, production_manager, sales, production_staff, viewer
-- ════════════════════════════════════════════════════════════

-- ══════════════════════════
-- V7 ADDITIONS
-- ══════════════════════════

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS batch_delivery boolean NOT NULL DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'retail';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_terms text NOT NULL DEFAULT 'cash_before';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refund_reference text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS credit_approval_ref text;

CREATE TABLE IF NOT EXISTS public.client_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL UNIQUE,
  customer_type text NOT NULL DEFAULT 'retail',
  credit_limit numeric(12,2) DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.client_profiles ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN DROP POLICY IF EXISTS "cp_select" ON public.client_profiles; DROP POLICY IF EXISTS "cp_insert" ON public.client_profiles; DROP POLICY IF EXISTS "cp_update" ON public.client_profiles; DROP POLICY IF EXISTS "cp_delete" ON public.client_profiles; END $$;
CREATE POLICY "cp_select" ON public.client_profiles FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "cp_insert" ON public.client_profiles FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "cp_update" ON public.client_profiles FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "cp_delete" ON public.client_profiles FOR DELETE USING (get_user_role() = 'admin');

CREATE TABLE IF NOT EXISTS public.admin_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN DROP POLICY IF EXISTS "settings_select" ON public.admin_settings; DROP POLICY IF EXISTS "settings_upsert" ON public.admin_settings; END $$;
CREATE POLICY "settings_select" ON public.admin_settings FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "settings_upsert" ON public.admin_settings FOR ALL USING (get_user_role() = 'admin');

INSERT INTO public.admin_settings (key, value) VALUES
  ('batch_delivery_unit_threshold', '20'),
  ('batch_delivery_value_threshold', '500000')
ON CONFLICT (key) DO NOTHING;

-- ── Contacts Directory ──
CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  category text NOT NULL DEFAULT 'Supplier',
  contact_person text,
  phone text,
  email text,
  location text,
  products_services text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_contacts_category ON public.contacts(category);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON public.contacts(company_name);
DO $$ BEGIN DROP POLICY IF EXISTS "contacts_select" ON public.contacts; DROP POLICY IF EXISTS "contacts_insert" ON public.contacts; DROP POLICY IF EXISTS "contacts_update" ON public.contacts; DROP POLICY IF EXISTS "contacts_delete" ON public.contacts; END $$;
CREATE POLICY "contacts_select" ON public.contacts FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE USING (auth.role() = 'authenticated' AND get_user_role() IN ('admin','production_manager','sales'));
CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE USING (get_user_role() IN ('admin','production_manager'));
DROP TRIGGER IF EXISTS contacts_updated_at ON public.contacts;
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();



-- ══════════════════════════════════════════════════════════════
-- V7.1 ADDITIONS — CORRECTED
-- Drawings & Attachments module
-- Run this block in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════

-- Step 1: Create drawings table
CREATE TABLE IF NOT EXISTS public.drawings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  file_size     INTEGER,
  mime_type     TEXT,
  drawing_type  TEXT DEFAULT 'general',
  notes         TEXT,
  uploaded_by   UUID NOT NULL REFERENCES auth.users(id),
  uploaded_at   TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  public.drawings IS 'Order drawings, DXF files, and attachments. Soft-deleted via deleted_at.';
COMMENT ON COLUMN public.drawings.file_path IS 'Storage path in bucket order-drawings (e.g. orders/{id}/drawings/{filename})';
COMMENT ON COLUMN public.drawings.drawing_type IS 'dxf | specification | general';
COMMENT ON COLUMN public.drawings.deleted_at IS 'Soft delete: NULL = active, NOT NULL = deleted';

-- Step 2: Indexes
CREATE INDEX IF NOT EXISTS idx_drawings_order_id     ON public.drawings(order_id);
CREATE INDEX IF NOT EXISTS idx_drawings_order_active  ON public.drawings(order_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_drawings_uploaded_by   ON public.drawings(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_drawings_uploaded_at   ON public.drawings(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_drawings_deleted_at    ON public.drawings(deleted_at);

-- Step 3: RLS
ALTER TABLE public.drawings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drawings_select" ON public.drawings;
DROP POLICY IF EXISTS "drawings_insert" ON public.drawings;
DROP POLICY IF EXISTS "drawings_update" ON public.drawings;
DROP POLICY IF EXISTS "drawings_delete" ON public.drawings;

-- All authenticated users with any role can view
CREATE POLICY "drawings_select" ON public.drawings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = drawings.order_id
        AND public.get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff','viewer')
    )
  );

-- Upload: admin, production_manager, head_of_sales, sales, production_staff
CREATE POLICY "drawings_insert" ON public.drawings
  FOR INSERT WITH CHECK (
    public.get_user_role() IN ('admin','production_manager','head_of_sales','sales','production_staff')
    AND uploaded_by = auth.uid()
  );

-- Soft-delete (UPDATE deleted_at): admin, production_manager only
CREATE POLICY "drawings_update" ON public.drawings
  FOR UPDATE
  USING      (public.get_user_role() IN ('admin','production_manager'))
  WITH CHECK (public.get_user_role() IN ('admin','production_manager'));

-- Hard delete: admin only
CREATE POLICY "drawings_delete" ON public.drawings
  FOR DELETE USING (public.get_user_role() = 'admin');

-- Step 4: updated_at trigger
DROP TRIGGER IF EXISTS drawings_updated_at ON public.drawings;
CREATE TRIGGER drawings_updated_at
  BEFORE UPDATE ON public.drawings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Step 5: Helper function — drawing count per order (for dashboard)
CREATE OR REPLACE FUNCTION public.get_order_drawing_count(p_order_id UUID)
RETURNS INTEGER
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.drawings
  WHERE order_id = p_order_id
    AND deleted_at IS NULL;
$$;

-- ══════════════════════════════════════════════════════════════
-- MANUAL STEPS (Supabase Dashboard — cannot be done via SQL)
-- ══════════════════════════════════════════════════════════════
-- 1. Storage > Create Bucket > name: "order-drawings" > make PRIVATE
-- 2. Storage > order-drawings > Policies > allow authenticated signed URL reads
-- 3. Add SUPABASE_SERVICE_KEY to .env.local (server-side API route only)
-- ══════════════════════════════════════════════════════════════
