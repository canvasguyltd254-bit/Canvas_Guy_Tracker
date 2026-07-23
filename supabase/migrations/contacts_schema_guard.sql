-- Migration: contacts schema guard
--
-- schema.sql defines an older contacts structure (company_name, category, location).
-- customers_module.sql defines the newer structure (contact_type, name, company, address)
-- using CREATE TABLE IF NOT EXISTS, which silently does nothing if the old table exists.
--
-- This migration ensures the correct structure is in place regardless of which
-- schema file ran first.
--
-- SAFE ORDER — data is never dropped before it is copied:
--   Step 1: ADD new columns (nullable — constraints added AFTER copy)
--   Step 2: COPY data from legacy columns into new columns
--           company_name → name
--           location     → address
--           category     → contact_type  ('Transporter' → 'Transporter', else → 'General')
--   Step 3: VALIDATE — fail fast if any row is left without name or contact_type
--   Step 4: ADD NOT NULL constraints, CHECK constraint, and indexes
--   Step 5: DROP legacy columns (data already preserved above)
--
-- Production state (confirmed 2026-07-21):
--   contacts has: id, contact_type, name, company, phone, email, address, notes, created_at, updated_at
--   Steps 1–5 are all IF NOT EXISTS / IF EXISTS — full no-op on production.

-- ── Step 1: Add new columns (nullable first) ──────────────────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS contact_type text,
  ADD COLUMN IF NOT EXISTS name         text,
  ADD COLUMN IF NOT EXISTS company      text,
  ADD COLUMN IF NOT EXISTS phone        text,
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS address      text,
  ADD COLUMN IF NOT EXISTS notes        text,
  ADD COLUMN IF NOT EXISTS created_at   timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz DEFAULT now();

-- ── Step 2: Copy data from legacy columns ────────────────────────────────
-- Each block is wrapped in a column-existence check so this migration is a
-- full no-op on production (where legacy columns have already been removed).
-- On a clean deploy from schema.sql the legacy columns exist and data is copied.

-- company_name → name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND   table_name   = 'contacts'
    AND   column_name  = 'company_name'
  ) THEN
    UPDATE public.contacts
    SET    name = company_name
    WHERE  company_name IS NOT NULL
    AND    name IS NULL;
  END IF;
END $$;

-- Default for rows with no company_name (or when column was absent)
UPDATE public.contacts
SET    name = 'Unknown'
WHERE  name IS NULL;

-- location → address
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND   table_name   = 'contacts'
    AND   column_name  = 'location'
  ) THEN
    UPDATE public.contacts
    SET    address = location
    WHERE  location IS NOT NULL
    AND    address IS NULL;
  END IF;
END $$;

-- category → contact_type
-- Old default was 'Supplier'; new valid values: 'General', 'Transporter'
-- Mapping: 'Transporter' (case-insensitive) → 'Transporter'; everything else → 'General'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND   table_name   = 'contacts'
    AND   column_name  = 'category'
  ) THEN
    UPDATE public.contacts
    SET    contact_type = CASE
      WHEN LOWER(TRIM(category)) = 'transporter' THEN 'Transporter'
      ELSE 'General'
    END
    WHERE  category IS NOT NULL
    AND    contact_type IS NULL;
  END IF;
END $$;

-- Default contact_type for rows with no legacy category (or when column was absent)
UPDATE public.contacts
SET    contact_type = 'General'
WHERE  contact_type IS NULL;

-- products_services → append to notes (no new column maps to this value, so preserve it)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND   table_name   = 'contacts'
    AND   column_name  = 'products_services'
  ) THEN
    UPDATE public.contacts
    SET    notes = CASE
      WHEN notes IS NULL OR TRIM(notes) = ''
        THEN products_services
      WHEN products_services IS NULL OR TRIM(products_services) = ''
        THEN notes
      ELSE notes || E'\n\nProducts/Services: ' || products_services
    END
    WHERE  products_services IS NOT NULL
    AND    TRIM(products_services) <> '';
  END IF;
END $$;

-- contact_person → append to notes (no new column maps to this value, so preserve it)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND   table_name   = 'contacts'
    AND   column_name  = 'contact_person'
  ) THEN
    UPDATE public.contacts
    SET    notes = CASE
      WHEN notes IS NULL OR TRIM(notes) = ''
        THEN 'Contact person: ' || contact_person
      WHEN contact_person IS NULL OR TRIM(contact_person) = ''
        THEN notes
      ELSE notes || E'\nContact person: ' || contact_person
    END
    WHERE  contact_person IS NOT NULL
    AND    TRIM(contact_person) <> '';
  END IF;
END $$;

-- ── Step 3: Validate ─────────────────────────────────────────────────────

DO $$
DECLARE
  v_nameless  integer;
  v_typeless  integer;
  v_bad_type  integer;
BEGIN
  SELECT COUNT(*) INTO v_nameless
  FROM   public.contacts
  WHERE  name IS NULL OR TRIM(name) = '';

  SELECT COUNT(*) INTO v_typeless
  FROM   public.contacts
  WHERE  contact_type IS NULL;

  SELECT COUNT(*) INTO v_bad_type
  FROM   public.contacts
  WHERE  contact_type NOT IN ('General', 'Transporter');

  IF v_typeless > 0 THEN
    RAISE EXCEPTION
      'contacts migration: % rows still have NULL contact_type after migration — aborting',
      v_typeless;
  END IF;

  IF v_bad_type > 0 THEN
    RAISE EXCEPTION
      'contacts migration: % rows have invalid contact_type (not General/Transporter) — aborting',
      v_bad_type;
  END IF;

  IF v_nameless > 0 THEN
    -- Warn but do not abort — rows were defaulted to 'Unknown' above
    RAISE WARNING
      'contacts migration: % rows have null/empty name (defaulted to Unknown)',
      v_nameless;
  END IF;
END $$;

-- ── Step 4: Apply NOT NULL, CHECK constraint, and indexes ────────────────

ALTER TABLE public.contacts
  ALTER COLUMN contact_type SET NOT NULL,
  ALTER COLUMN name SET NOT NULL;

-- ADD CONSTRAINT is idempotent only if we guard it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'contacts_contact_type_check'
    AND    conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_contact_type_check
        CHECK (contact_type IN ('General', 'Transporter'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_contact_type ON public.contacts (contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_name         ON public.contacts (name);

-- ── Step 5: Drop legacy columns (data already preserved above) ───────────

ALTER TABLE public.contacts
  DROP COLUMN IF EXISTS company_name,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS location,
  DROP COLUMN IF EXISTS products_services,
  DROP COLUMN IF EXISTS contact_person;
