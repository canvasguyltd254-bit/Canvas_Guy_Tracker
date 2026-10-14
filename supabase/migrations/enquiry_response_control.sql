-- ─────────────────────────────────────────────────────────────────────────────
-- enquiry_response_control.sql
--
-- First-reply control for enquiries (built for website enquiries, usable for all).
--
--   enquiries.first_contact_at / first_contact_by / first_contact_method
--                          WHO reached out first, WHEN and HOW. Set ONLY by
--                          mark_enquiry_contacted(); nothing else stops the clock.
--   enquiries.reply_due_at the first-reply deadline, calculated here in the database
--                          so the CRM list, Home dashboard and any report read ONE
--                          answer. Set automatically for website enquiries.
--   business_deadline()    working-hours arithmetic: 08:00-18:00 Nairobi, Mon-Sat,
--                          Sundays excluded.
--   mark_enquiry_contacted()  ONE transaction: record first contact, move a New
--                          enquiry to Contacted, write the history row.
--
-- Rule: first reply is due ONE BUSINESS HOUR after the enquiry arrives. A lead that
-- arrives outside working hours starts counting at 08:00 on the next working day.
--   Saturday 17:40  -> Monday 08:40
--   Tuesday 07:15   -> Tuesday 09:00
--   Sunday 12:00    -> Monday 09:00
-- Public holidays are not modelled yet (a working-calendar table can feed
-- business_deadline() later).
--
-- Moving an enquiry to "contacted" by editing its stage does NOT count as contact:
-- a quote can be started from a New enquiry without anyone speaking to the customer.
--
-- Errors (message = code): ENQUIRY_NOT_FOUND -> 404, ENQUIRY_CLOSED -> 422,
-- BAD_METHOD -> 400, BAD_INPUT -> 400.
-- Idempotent and transactional.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.enquiries') IS NULL OR to_regclass('public.quote_activities') IS NULL THEN
    RAISE EXCEPTION 'enquiries / quote_activities are missing: apply the CRM migrations first.';
  END IF;
END $$;

ALTER TABLE public.enquiries
  ADD COLUMN IF NOT EXISTS first_contact_at     timestamptz,
  ADD COLUMN IF NOT EXISTS first_contact_by     uuid,
  ADD COLUMN IF NOT EXISTS first_contact_method text,
  ADD COLUMN IF NOT EXISTS reply_due_at         timestamptz;

ALTER TABLE public.enquiries DROP CONSTRAINT IF EXISTS enquiries_first_contact_method_known;
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_first_contact_method_known
  CHECK (first_contact_method IS NULL OR first_contact_method IN ('call', 'whatsapp', 'email', 'visit', 'other'));

-- Recorded together or not at all.
ALTER TABLE public.enquiries DROP CONSTRAINT IF EXISTS enquiries_first_contact_complete;
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_first_contact_complete
  CHECK ((first_contact_at IS NULL AND first_contact_method IS NULL AND first_contact_by IS NULL)
      OR (first_contact_at IS NOT NULL AND first_contact_method IS NOT NULL));

COMMENT ON COLUMN public.enquiries.first_contact_at IS
  'When a person first reached out to the customer. Set only by mark_enquiry_contacted().';
COMMENT ON COLUMN public.enquiries.reply_due_at IS
  'First-reply deadline (business_deadline(created_at, 60)). NULL = no reply clock applies.';

-- Open, timed enquiries awaiting a reply (Home dashboard + list badge).
CREATE INDEX IF NOT EXISTS idx_enquiries_awaiting_reply
  ON public.enquiries (reply_due_at)
  WHERE first_contact_at IS NULL AND reply_due_at IS NOT NULL;

-- ── Working-hours deadline ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.business_deadline(p_from timestamptz, p_minutes integer DEFAULT 60)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_local     timestamp;
  v_remaining double precision;   -- seconds still to add
  v_close     timestamp;
  v_avail     double precision;   -- seconds left before closing today
  v_guard     integer := 0;
BEGIN
  IF p_from IS NULL OR p_minutes IS NULL OR p_minutes < 0 THEN
    RAISE EXCEPTION 'BAD_INPUT';
  END IF;

  v_local := p_from AT TIME ZONE 'Africa/Nairobi';
  v_remaining := p_minutes * 60;

  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 400 THEN RAISE EXCEPTION 'BAD_INPUT'; END IF;

    IF extract(dow FROM v_local) = 0 THEN                 -- Sunday: closed
      v_local := date_trunc('day', v_local) + interval '1 day 8 hours';
      CONTINUE;
    END IF;
    IF v_local::time >= time '18:00' THEN                 -- after closing
      v_local := date_trunc('day', v_local) + interval '1 day 8 hours';
      CONTINUE;
    END IF;
    IF v_local::time < time '08:00' THEN                  -- before opening
      v_local := date_trunc('day', v_local) + interval '8 hours';
    END IF;

    v_close := date_trunc('day', v_local) + interval '18 hours';
    v_avail := extract(epoch FROM (v_close - v_local));

    IF v_remaining <= v_avail THEN
      v_local := v_local + v_remaining * interval '1 second';
      EXIT;
    END IF;

    v_remaining := v_remaining - v_avail;
    v_local := date_trunc('day', v_local) + interval '1 day 8 hours';
  END LOOP;

  RETURN v_local AT TIME ZONE 'Africa/Nairobi';
END;
$$;

REVOKE ALL ON FUNCTION public.business_deadline(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_deadline(timestamptz, integer) TO service_role;

-- ── Deadline set automatically for website enquiries ────────────────────────
-- A trigger (not a change to create_enquiry_from_web_form) so any current or future
-- website intake path gets the same rule, and migration order does not matter.
CREATE OR REPLACE FUNCTION public.enquiries_set_reply_due()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source = 'website' AND NEW.reply_due_at IS NULL AND NEW.first_contact_at IS NULL THEN
    NEW.reply_due_at := public.business_deadline(coalesce(NEW.created_at, now()), 60);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enquiries_set_reply_due ON public.enquiries;
CREATE TRIGGER enquiries_set_reply_due
  BEFORE INSERT ON public.enquiries
  FOR EACH ROW EXECUTE FUNCTION public.enquiries_set_reply_due();

-- Backfill: website enquiries still New and never contacted. Anything already
-- worked is left without a clock: we do not invent a contact time we never recorded.
UPDATE public.enquiries
SET    reply_due_at = public.business_deadline(created_at, 60)
WHERE  source = 'website' AND stage = 'new' AND first_contact_at IS NULL AND reply_due_at IS NULL;

-- ── Record first contact ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_enquiry_contacted(
  p_enquiry_id uuid,
  p_method     text,
  p_note       text,
  p_user_id    uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_method text := lower(btrim(coalesce(p_method, '')));
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_enq    public.enquiries%ROWTYPE;
  v_now    timestamptz := now();
  v_label  text;
BEGIN
  IF v_method NOT IN ('call', 'whatsapp', 'email', 'visit', 'other') THEN
    RAISE EXCEPTION 'BAD_METHOD';
  END IF;
  IF p_enquiry_id IS NULL THEN RAISE EXCEPTION 'BAD_INPUT'; END IF;

  SELECT * INTO v_enq FROM public.enquiries WHERE id = p_enquiry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENQUIRY_NOT_FOUND'; END IF;

  -- Two people logging the same first contact: the first one wins, the second is told.
  IF v_enq.first_contact_at IS NOT NULL THEN
    RETURN jsonb_build_object('already', true, 'stage', v_enq.stage,
      'first_contact_at', v_enq.first_contact_at, 'first_contact_method', v_enq.first_contact_method);
  END IF;

  IF v_enq.stage NOT IN ('new', 'contacted', 'quoted') THEN
    RAISE EXCEPTION 'ENQUIRY_CLOSED';
  END IF;

  UPDATE public.enquiries
  SET first_contact_at     = v_now,
      first_contact_by     = p_user_id,
      first_contact_method = v_method,
      stage                = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
      updated_at           = v_now
  WHERE id = p_enquiry_id;

  v_label := CASE v_method WHEN 'call' THEN 'Call' WHEN 'whatsapp' THEN 'WhatsApp'
                           WHEN 'email' THEN 'Email' WHEN 'visit' THEN 'Visit' ELSE 'Other' END;

  INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('enquiry', p_enquiry_id, 'contact_logged',
    'First contact: ' || v_label || coalesce(' - ' || v_note, '')
      || CASE WHEN v_enq.stage = 'new' THEN ' (stage: new -> contacted)' ELSE '' END,
    p_user_id);

  RETURN jsonb_build_object('already', false,
    'stage', CASE WHEN v_enq.stage = 'new' THEN 'contacted' ELSE v_enq.stage END,
    'first_contact_at', v_now, 'first_contact_method', v_method);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_enquiry_contacted(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_enquiry_contacted(uuid, text, text, uuid) TO service_role;

COMMIT;
