-- ============================================================================
-- Canvas Guy Tracker — Email Intake Stage 1: brand tag on enquiries +
-- inbound_emails holding queue
--
-- Scope (deliberately narrow): read-only ingestion of enquiry emails from
-- two cPanel/IMAP mailboxes (Canvas Guy, The Seating Company) into a
-- holding queue. Nothing here sends email, replies, or auto-creates an
-- enquiry — a human converts or dismisses each row explicitly. This
-- mirrors the Cashflow module's own rule: automation surfaces facts, a
-- person still makes the call before anything enters a live pipeline.
--
-- Table order:
--   1. enquiries.brand           (new column, existing table)
--   2. inbound_emails            (new table — the holding queue)
--
-- WHAT THIS MIGRATION DOES NOT DO
--   - Does not touch orders, quotations, or any other CRM table.
--   - Does not backfill brand on existing enquiries — brand is unknown for
--     rows created before this feature, and NULL stays visibly unknown
--     rather than being guessed.
--   - Does not create any enquiry rows. inbound_emails is inert until an
--     admin/head_of_sales/sales user calls the convert endpoint.
--
-- SECURITY
--   inbound_emails: RLS enabled, ALL revoked from PUBLIC/anon/authenticated,
--   ALL granted to service_role only — identical treatment to every other
--   table in this project. Every read/write goes through the Next.js API
--   routes, which enforce roles themselves (ROLES_CRM = admin, head_of_sales,
--   sales for the queue; the poll endpoint uses a shared secret instead of
--   a user session, since Vercel Cron carries no login).
--
-- IDEMPOTENT: safe to re-run. ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
-- EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS throughout.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. enquiries.brand — which of the two businesses this enquiry belongs to
--
--    Nullable on purpose: enquiries created before this migration, or via
--    walk-in/referral/whatsapp sources that don't (yet) carry brand
--    information, stay NULL rather than being guessed. Only email-sourced
--    enquiries created via the new convert endpoint are guaranteed to have
--    a value, since it is set automatically from which mailbox the
--    original message arrived in.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.enquiries
  ADD COLUMN IF NOT EXISTS brand text
    CHECK (brand IN ('canvas_guy', 'seating_company'));

COMMENT ON COLUMN public.enquiries.brand IS
  'Which business this enquiry is for: canvas_guy or seating_company. NULL for enquiries created before this column existed, or from sources that do not carry brand information. Never inferred after the fact — set once, at creation, from the actual source (e.g. which mailbox an email arrived in).';


-- ────────────────────────────────────────────────────────────────────────────
-- 2. inbound_emails — holding queue for enquiry emails, pending human review
--
--    One row per inbound message from either mailbox. A row is either
--    'pending' (needs a human decision), 'converted' (became an enquiry —
--    converted_enquiry_id is set), or 'dismissed' (a human decided it was
--    not a real enquiry — spam, an auto-reply that slipped through, an
--    existing conversation, etc.). Nothing here writes to enquiries by
--    itself; the API route that flips a row to 'converted' does that in
--    the same request, never a trigger or background job.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_emails (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  brand                 text        NOT NULL
                          CHECK (brand IN ('canvas_guy', 'seating_company')),
  mailbox               text        NOT NULL,   -- e.g. info@canvasguy.co.ke

  message_id            text        NOT NULL,   -- the email's Message-ID header
  from_address          text,
  from_name             text,
  subject               text,
  body_text             text,
  received_at           timestamptz,

  status                text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'converted', 'dismissed')),

  converted_enquiry_id  uuid        REFERENCES public.enquiries(id) ON DELETE SET NULL,
  reviewed_by           uuid        REFERENCES auth.users(id),
  reviewed_at           timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),

  -- A row can only be 'converted' if it actually has a linked enquiry, and
  -- vice versa — no silently orphaned state either way.
  CONSTRAINT inbound_emails_converted_has_enquiry CHECK (
    (status = 'converted') = (converted_enquiry_id IS NOT NULL)
  ),

  -- A reviewed row (converted or dismissed) must record who and when.
  CONSTRAINT inbound_emails_reviewed_is_recorded CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR
    (status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.inbound_emails IS
  'Holding queue for enquiry emails pulled from the two brand mailboxes. Pending rows wait for a human to convert (creates an enquiries row) or dismiss. Never auto-converts — this table is inert on its own.';
COMMENT ON COLUMN public.inbound_emails.mailbox IS
  'The actual mailbox address polled (e.g. info@canvasguy.co.ke), independent of brand — kept so a misconfigured mailbox-to-brand mapping is visible and auditable.';
COMMENT ON COLUMN public.inbound_emails.message_id IS
  'The email Message-ID header. Paired with mailbox in the unique index below so the same message is never queued twice, even across repeated polls.';

-- One row per physical message per mailbox — the actual de-dup key.
-- Not a bare UNIQUE(message_id): Message-ID is normally globally unique,
-- but treating (mailbox, message_id) as the key costs nothing and removes
-- any dependency on that assumption holding across mail servers.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_dedup
  ON public.inbound_emails (mailbox, message_id);

CREATE INDEX IF NOT EXISTS inbound_emails_status
  ON public.inbound_emails (status, received_at DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Security — identical treatment to every other table in this project
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inbound_emails FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.inbound_emails TO service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 4. Post-migration diagnostic report
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_brand_col_exists boolean;
  v_inbound_rows      integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enquiries' AND column_name = 'brand'
  ) INTO v_brand_col_exists;

  SELECT count(*) INTO v_inbound_rows FROM public.inbound_emails;

  RAISE NOTICE '─────────────────────────────────────────────────────────';
  RAISE NOTICE 'email_intake_v1 applied.';
  RAISE NOTICE '  enquiries.brand column present : %', v_brand_col_exists;
  RAISE NOTICE '  inbound_emails rows             : % (0 expected — nothing seeded)', v_inbound_rows;
  RAISE NOTICE '';
  RAISE NOTICE '  No enquiry rows were created or modified by this migration.';
  RAISE NOTICE '  inbound_emails is empty and inert until the poll endpoint';
  RAISE NOTICE '  (Stage 2) starts writing to it.';
  RAISE NOTICE '─────────────────────────────────────────────────────────';
END $$;

COMMIT;
