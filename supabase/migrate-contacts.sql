-- ════════════════════════════════════════════════════════════
-- CANVAS GUY TRACKER — CONTACTS DIRECTORY MIGRATION
-- Run in Supabase SQL Editor on existing database
-- ════════════════════════════════════════════════════════════

-- ── Contacts table ──
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

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_contacts_category ON public.contacts(category);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON public.contacts(company_name);

-- ── RLS Policies ──
-- Everyone authenticated can view
DO $$ BEGIN
  DROP POLICY IF EXISTS "contacts_select" ON public.contacts;
  DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
  DROP POLICY IF EXISTS "contacts_update" ON public.contacts;
  DROP POLICY IF EXISTS "contacts_delete" ON public.contacts;
END $$;

CREATE POLICY "contacts_select" ON public.contacts
  FOR SELECT USING (auth.role() = 'authenticated');

-- Admin, PM, Sales can add
CREATE POLICY "contacts_insert" ON public.contacts
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated'
    AND get_user_role() IN ('admin','production_manager','sales')
  );

-- Admin, PM, Sales can edit
CREATE POLICY "contacts_update" ON public.contacts
  FOR UPDATE USING (
    auth.role() = 'authenticated'
    AND get_user_role() IN ('admin','production_manager','sales')
  );

-- Only Admin and PM can delete
CREATE POLICY "contacts_delete" ON public.contacts
  FOR DELETE USING (
    get_user_role() IN ('admin','production_manager')
  );

-- ── Auto-update updated_at ──
DROP TRIGGER IF EXISTS contacts_updated_at ON public.contacts;
CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════════════════════
-- DONE.
-- New: contacts table for supplier & service provider directory
-- Permissions:
--   SELECT: all authenticated
--   INSERT/UPDATE: admin, production_manager, sales
--   DELETE: admin, production_manager
-- ════════════════════════════════════════════════════════════
