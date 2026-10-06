-- ============================================================================
-- Canvas Guy Tracker — mailbox credentials entered from the CRM screen
--
-- One row per brand. The password is stored ENCRYPTED (AES-256-GCM, key in the
-- EMAIL_CREDENTIALS_KEY environment variable, never in the database), so a
-- database dump or a leaked read of this table does not expose the mailbox
-- password. The table is service_role only: no browser client can read it,
-- and the API never returns the password — only whether one is set.
--
-- Environment variables (EMAIL_<BRAND>_HOST/USER/PASS) remain a fallback when
-- a brand has no row here.
-- Safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.email_mailbox_settings (
  brand              text PRIMARY KEY CHECK (brand IN ('canvas_guy', 'seating_company')),
  host               text NOT NULL CHECK (btrim(host) <> ''),
  port               integer NOT NULL DEFAULT 993 CHECK (port IN (993, 143)),
  secure             boolean NOT NULL DEFAULT true,
  username           text NOT NULL CHECK (btrim(username) <> ''),
  password_encrypted text NOT NULL CHECK (password_encrypted LIKE 'v1:%'),
  updated_by         uuid REFERENCES auth.users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.email_mailbox_settings.password_encrypted IS
  'AES-256-GCM ciphertext, format v1:<iv>:<tag>:<data> (base64). Decrypted only server-side with EMAIL_CREDENTIALS_KEY.';

ALTER TABLE public.email_mailbox_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_mailbox_settings FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.email_mailbox_settings TO service_role;

COMMIT;
