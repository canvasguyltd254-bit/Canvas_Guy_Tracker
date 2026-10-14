-- ─────────────────────────────────────────────────────────────────────────────
-- web_enquiry_match_resolution.sql
--
-- Lets a person settle a website enquiry whose phone/email matched SEVERAL
-- customers (web_form_submissions.match_status = 'ambiguous').
--
--   web_form_submissions.resolved_at / resolved_by    who settled it and when
--   match_status gains 'manually_linked', 'kept_as_prospect'
--   web_enquiry_candidates(enquiry)                   customers that share the
--                                                     submission's phone or email
--   resolve_web_enquiry_customer(...)                 ONE transaction: lock, validate,
--                                                     link or keep, audit
--
-- Concurrency: the enquiry row and the submission row are locked FOR UPDATE, in that
-- order, before anything is read or written. If two people resolve the same enquiry,
-- the second waits, then finds it already resolved and gets ALREADY_RESOLVED. It can
-- never overwrite the first decision.
--
-- The website contact's name and phone/email are copied into the history row before
-- the prospect fields are cleared, so nothing about who actually wrote in is lost.
--
-- Errors (message = code): BAD_ACTION -> 400, CUSTOMER_REQUIRED -> 400,
-- ENQUIRY_NOT_FOUND -> 404, NOT_WEB_ENQUIRY -> 404, CUSTOMER_NOT_CANDIDATE -> 422,
-- ALREADY_RESOLVED -> 409, NOT_AMBIGUOUS -> 409.
-- Requires web_form_enquiries.sql. Idempotent and transactional.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.web_form_submissions') IS NULL THEN
    RAISE EXCEPTION 'Apply web_form_enquiries.sql first (web_form_submissions is missing).';
  END IF;
END $$;

ALTER TABLE public.web_form_submissions
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;

-- Replace the match_status CHECK (whatever the original constraint was called).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.web_form_submissions'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%match_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.web_form_submissions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.web_form_submissions ADD CONSTRAINT web_form_submissions_match_status_known
  CHECK (match_status IN ('matched_phone', 'matched_email', 'new_prospect', 'ambiguous',
                          'manually_linked', 'kept_as_prospect'));

-- A manual decision always carries its timestamp; an automatic status never does.
ALTER TABLE public.web_form_submissions DROP CONSTRAINT IF EXISTS web_form_submissions_resolution_complete;
ALTER TABLE public.web_form_submissions ADD CONSTRAINT web_form_submissions_resolution_complete
  CHECK ((match_status IN ('manually_linked', 'kept_as_prospect')) = (resolved_at IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_web_form_submissions_ambiguous
  ON public.web_form_submissions (received_at DESC) WHERE match_status = 'ambiguous';

-- ── Candidate customers ─────────────────────────────────────────────────────
-- Same keys the intake used: last 9 digits of the phone, or the email (case/space blind).
-- Also returns order history (non-suspended orders) so the person choosing can tell
-- an active customer from a stale duplicate. The return type changed, so drop first.
DO $$
BEGIN
  IF to_regclass('public.orders') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'suspended_at') THEN
    RAISE EXCEPTION 'orders.customer_id / orders.suspended_at are required (apply the customers and suspension migrations first).';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.web_enquiry_candidates(uuid);
CREATE FUNCTION public.web_enquiry_candidates(p_enquiry_id uuid)
RETURNS TABLE (id uuid, name text, phone text, email text, order_count integer, last_order_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.name, c.phone, c.email,
         coalesce(o.n, 0)::integer, o.last_at
  FROM public.web_form_submissions s
  JOIN public.customers c ON (
        (length(right(regexp_replace(coalesce(s.contact_phone, ''), '\D', '', 'g'), 9)) = 9
         AND right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9)
           = right(regexp_replace(coalesce(s.contact_phone, ''), '\D', '', 'g'), 9))
     OR (s.contact_email IS NOT NULL AND lower(btrim(coalesce(c.email, ''))) = s.contact_email))
  LEFT JOIN LATERAL (
        SELECT count(*) AS n, max(ord.created_at) AS last_at
        FROM public.orders ord
        WHERE ord.customer_id = c.id AND ord.suspended_at IS NULL) o ON true
  WHERE s.enquiry_id = p_enquiry_id
  ORDER BY c.name
  LIMIT 20;
$$;

REVOKE ALL ON FUNCTION public.web_enquiry_candidates(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_enquiry_candidates(uuid) TO service_role;

-- ── Resolve ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_web_enquiry_customer(
  p_enquiry_id  uuid,
  p_action      text,        -- 'link' | 'keep_prospect'
  p_customer_id uuid,        -- required for 'link'
  p_user_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_enq   public.enquiries%ROWTYPE;
  v_sub   public.web_form_submissions%ROWTYPE;
  v_cust  public.customers%ROWTYPE;
  v_now   timestamptz := now();
  v_who   text;
BEGIN
  IF p_action NOT IN ('link', 'keep_prospect') THEN RAISE EXCEPTION 'BAD_ACTION'; END IF;
  IF p_action = 'link' AND p_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED'; END IF;
  IF p_enquiry_id IS NULL THEN RAISE EXCEPTION 'BAD_INPUT'; END IF;

  -- Lock order is always enquiry, then submission.
  SELECT * INTO v_enq FROM public.enquiries WHERE id = p_enquiry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENQUIRY_NOT_FOUND'; END IF;

  SELECT * INTO v_sub FROM public.web_form_submissions WHERE enquiry_id = p_enquiry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_WEB_ENQUIRY'; END IF;

  IF v_sub.match_status IN ('manually_linked', 'kept_as_prospect') OR v_enq.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_RESOLVED';
  END IF;
  IF v_sub.match_status <> 'ambiguous' THEN RAISE EXCEPTION 'NOT_AMBIGUOUS'; END IF;

  v_who := concat_ws(' · ', nullif(btrim(coalesce(v_enq.prospect_name, '')), ''),
                            nullif(btrim(coalesce(v_enq.prospect_contact, '')), ''));

  IF p_action = 'link' THEN
    SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_CANDIDATE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.web_enquiry_candidates(p_enquiry_id) k WHERE k.id = p_customer_id) THEN
      RAISE EXCEPTION 'CUSTOMER_NOT_CANDIDATE';
    END IF;

    UPDATE public.enquiries
    SET customer_id = p_customer_id, prospect_name = NULL, prospect_contact = NULL, updated_at = v_now
    WHERE id = p_enquiry_id;

    UPDATE public.web_form_submissions
    SET match_status = 'manually_linked', resolved_at = v_now, resolved_by = p_user_id
    WHERE id = v_sub.id;

    INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
    VALUES ('enquiry', p_enquiry_id, 'customer_resolved',
      format('Linked to customer %s. Website contact was: %s', v_cust.name, coalesce(nullif(v_who, ''), 'not recorded')),
      p_user_id);
  ELSE
    UPDATE public.web_form_submissions
    SET match_status = 'kept_as_prospect', resolved_at = v_now, resolved_by = p_user_id
    WHERE id = v_sub.id;

    UPDATE public.enquiries SET updated_at = v_now WHERE id = p_enquiry_id;

    INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
    VALUES ('enquiry', p_enquiry_id, 'customer_resolved',
      format('Kept as a new prospect (not linked to an existing customer): %s', coalesce(nullif(v_who, ''), 'not recorded')),
      p_user_id);
  END IF;

  RETURN jsonb_build_object('match_status',
    CASE WHEN p_action = 'link' THEN 'manually_linked' ELSE 'kept_as_prospect' END,
    'customer_id', CASE WHEN p_action = 'link' THEN p_customer_id END,
    'resolved_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_web_enquiry_customer(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_web_enquiry_customer(uuid, text, uuid, uuid) TO service_role;

COMMIT;
