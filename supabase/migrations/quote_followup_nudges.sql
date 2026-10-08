-- ─────────────────────────────────────────────────────────────────────────────
-- quote_followup_nudges.sql
--
-- Support for "chase a sent quote": know WHEN it was sent and WHEN someone last
-- contacted the client, so the CRM can flag quotes that have gone quiet.
--
--   quotations.sent_at                  first time the quote moved to 'sent'
--   quotations.last_contact_at          last time a person logged contact
--   quotations.follow_up_snoozed_until  hide the nudge until this date
--   followups.auto_source               marks follow-up tasks the system created
--   followups.completed_reason          why a task was closed (see below)
--
-- Contact is recorded as a quote_activities row (activity_type 'contact_logged');
-- last_contact_at is a denormalised copy so the list does not read the whole log.
--
-- Guarantees enforced HERE (not in app code):
--   * sent_at is set on the first move to 'sent' (including INSERT as 'sent') and
--     can never be overwritten afterwards (trigger quotations_set_sent_at).
--   * Logging contact / snoozing is ONE transaction (record_quote_followup_action):
--     lock + validate the quote, update it, write the history row, close the
--     system-made task. If any step fails, nothing changes.
--   * At most one OPEN quote_nudge task per quotation.
--
-- Adding a new kind of system-made task later: add its value to
-- followups_auto_source_known below (drop + re-add the CHECK in a new migration).
--
-- Idempotent and transactional: safe to run twice; fails as a whole or not at all.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS sent_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS last_contact_at         timestamptz,
  ADD COLUMN IF NOT EXISTS follow_up_snoozed_until date;

COMMENT ON COLUMN public.quotations.sent_at IS 'First time the quotation moved to sent. NULL for drafts. Never overwritten once set (trigger).';
COMMENT ON COLUMN public.quotations.last_contact_at IS 'Most recent logged contact with the client (call, WhatsApp, email, visit). NULL = never.';
COMMENT ON COLUMN public.quotations.follow_up_snoozed_until IS 'Follow-up nudges are hidden until this date.';

ALTER TABLE public.followups
  ADD COLUMN IF NOT EXISTS auto_source      text,
  ADD COLUMN IF NOT EXISTS completed_reason text;

COMMENT ON COLUMN public.followups.auto_source IS 'Set (quote_nudge) when the system created the task; NULL for tasks a person made.';
COMMENT ON COLUMN public.followups.completed_reason IS 'Why the task was closed: contact_logged | snoozed | accepted | rejected | expired | superseded. NULL = completed by hand.';

-- Known system-made task kinds only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'followups_auto_source_known') THEN
    ALTER TABLE public.followups
      ADD CONSTRAINT followups_auto_source_known
      CHECK (auto_source IS NULL OR auto_source IN ('quote_nudge'));
  END IF;
END $$;

-- ── sent_at: set once, never overwritten ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.quotations_set_sent_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sent_at IS NOT NULL THEN
    NEW.sent_at := OLD.sent_at;                 -- preserve, whatever the caller sent
  ELSIF NEW.status = 'sent' AND NEW.sent_at IS NULL THEN
    NEW.sent_at := now();                       -- first send (insert or update)
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quotations_set_sent_at ON public.quotations;
CREATE TRIGGER quotations_set_sent_at
  BEFORE INSERT OR UPDATE ON public.quotations
  FOR EACH ROW EXECUTE FUNCTION public.quotations_set_sent_at();

-- ── Backfill (before the trigger could matter: only fills NULLs) ─────────────
-- 1: first transition to sent, from the activity log.
UPDATE public.quotations q
SET    sent_at = a.first_sent
FROM  (
  SELECT entity_id, MIN(created_at) AS first_sent
  FROM   public.quote_activities
  WHERE  entity_type   = 'quotation'
    AND  activity_type = 'status_change'
    AND  description LIKE '%→ sent'
  GROUP  BY entity_id
) a
WHERE  q.id = a.entity_id
  AND  q.sent_at IS NULL;

-- 2: 'sent' quotes with no log entry: best available date is the last update.
UPDATE public.quotations
SET    sent_at = COALESCE(updated_at, created_at)
WHERE  status = 'sent'
  AND  sent_at IS NULL;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- At most ONE open system-made nudge per quotation, so the daily job can run
-- twice (or overlap) without duplicates. People's own tasks are not constrained.
-- Replaces the earlier, broader index of the same name.
DROP INDEX IF EXISTS public.uq_followups_open_auto_per_quote;
CREATE UNIQUE INDEX uq_followups_open_auto_per_quote
  ON public.followups (quotation_id)
  WHERE auto_source = 'quote_nudge' AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_quotations_sent_followup
  ON public.quotations (status, sent_at)
  WHERE status = 'sent';

-- ── Atomic contact / snooze ──────────────────────────────────────────────────
-- Errors (SQLSTATE P0001, message = code) the API maps to HTTP statuses:
--   QUOTE_NOT_FOUND  → 404     QUOTE_NOT_CHASEABLE → 422
--   BAD_METHOD       → 400     BAD_ACTION          → 400
CREATE OR REPLACE FUNCTION public.record_quote_followup_action(
  p_quotation_id uuid,
  p_action       text,
  p_method       text,
  p_note         text,
  p_days         integer,
  p_user_id      uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  q       public.quotations%ROWTYPE;
  v_now   timestamptz := now();
  v_label text;
  v_note  text := left(btrim(coalesce(p_note, '')), 500);
  v_days  integer;
  v_until date;
BEGIN
  IF p_action NOT IN ('contact', 'snooze') THEN
    RAISE EXCEPTION 'BAD_ACTION';
  END IF;

  SELECT * INTO q FROM public.quotations WHERE id = p_quotation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'QUOTE_NOT_FOUND'; END IF;

  IF q.status <> 'sent' OR q.converted_order_id IS NOT NULL OR q.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_NOT_CHASEABLE';
  END IF;

  IF p_action = 'contact' THEN
    v_label := CASE lower(coalesce(p_method, ''))
      WHEN 'call'     THEN 'Call'
      WHEN 'whatsapp' THEN 'WhatsApp'
      WHEN 'email'    THEN 'Email'
      WHEN 'visit'    THEN 'Visit'
      WHEN 'other'    THEN 'Other'
      ELSE NULL END;
    IF v_label IS NULL THEN RAISE EXCEPTION 'BAD_METHOD'; END IF;

    UPDATE public.quotations
    SET    last_contact_at = v_now, follow_up_snoozed_until = NULL, updated_at = v_now
    WHERE  id = p_quotation_id;

    INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
    VALUES ('quotation', p_quotation_id, 'contact_logged',
            v_label || CASE WHEN v_note <> '' THEN ': ' || v_note ELSE '' END, p_user_id);

    UPDATE public.followups
    SET    completed_at = v_now, completed_by = p_user_id, completed_reason = 'contact_logged'
    WHERE  quotation_id = p_quotation_id AND auto_source = 'quote_nudge' AND completed_at IS NULL;

    RETURN jsonb_build_object('last_contact_at', v_now);
  END IF;

  -- snooze: until N Nairobi calendar days from today (1..14, default 3)
  v_days  := least(greatest(coalesce(p_days, 3), 1), 14);
  v_until := (v_now AT TIME ZONE 'Africa/Nairobi')::date + v_days;

  UPDATE public.quotations
  SET    follow_up_snoozed_until = v_until, updated_at = v_now
  WHERE  id = p_quotation_id;

  INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('quotation', p_quotation_id, 'follow_up_snoozed',
          'Follow-up reminder snoozed until ' || v_until::text, p_user_id);

  -- The open system task would otherwise keep nagging; the daily job creates a
  -- fresh one once the snooze date passes and the quote is still due.
  UPDATE public.followups
  SET    completed_at = v_now, completed_by = p_user_id, completed_reason = 'snoozed'
  WHERE  quotation_id = p_quotation_id AND auto_source = 'quote_nudge' AND completed_at IS NULL;

  RETURN jsonb_build_object('follow_up_snoozed_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.record_quote_followup_action(uuid, text, text, text, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_quote_followup_action(uuid, text, text, text, integer, uuid)
  TO service_role;

COMMIT;
