-- ─────────────────────────────────────────────────────────────────────────────
-- web_form_enquiries.sql
--
-- Website enquiry forms (Shopify, via App Proxy) → CRM enquiries.
--
--   web_form_submissions                 one row per form submission received
--   create_enquiry_from_web_form(...)    ONE transaction: de-duplicate, match the
--                                        customer, create the enquiry, write the
--                                        history row, record the submission
--
-- Guarantees enforced HERE (not in app code):
--   * The same submission is never turned into two enquiries (unique key on
--     provider + shop + external id); a retry returns the existing enquiry.
--   * Customers are matched on phone, then email, and ONLY when exactly one
--     customer matches. Two or more matches never merge: the enquiry is created
--     as a prospect and flagged match_status = 'ambiguous' for a person to review.
--   * Basic flood protection: at most 30 submissions per 10 minutes overall and
--     3 per hour per phone/email. Over the limit raises RATE_LIMITED.
--   * If any step fails nothing is saved (the submission row is part of the same
--     transaction).
--
-- Requires: email_intake_v1.sql (enquiries.brand) and quotes_crm_migration_a/b.
-- Idempotent and transactional.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'enquiries' AND column_name = 'brand'
  ) THEN
    RAISE EXCEPTION 'Apply email_intake_v1.sql first (enquiries.brand is missing).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.web_form_submissions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text        NOT NULL CHECK (provider IN ('shopify')),
  shop_domain         text        NOT NULL,
  external_id         text        NOT NULL,
  brand               text        NOT NULL CHECK (brand IN ('canvas_guy', 'seating_company')),
  contact_phone       text,
  contact_email       text,
  match_status        text        NOT NULL
                        CHECK (match_status IN ('matched_phone', 'matched_email', 'new_prospect', 'ambiguous')),
  enquiry_id          uuid        REFERENCES public.enquiries(id) ON DELETE SET NULL,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_form_submissions_unique UNIQUE (provider, shop_domain, external_id)
);

COMMENT ON TABLE public.web_form_submissions IS
  'One row per website form submission. The unique key makes retries safe. payload holds the sanitised fields as submitted.';

CREATE INDEX IF NOT EXISTS idx_web_form_submissions_received
  ON public.web_form_submissions (received_at DESC);

-- Service-role only: no policies, so RLS blocks every other role.
ALTER TABLE public.web_form_submissions ENABLE ROW LEVEL SECURITY;

-- Errors (message = code): BAD_INPUT → 400, RATE_LIMITED → 429.
CREATE OR REPLACE FUNCTION public.create_enquiry_from_web_form(
  p_provider    text,
  p_shop_domain text,
  p_external_id text,
  p_brand       text,
  p_name        text,
  p_phone       text,
  p_email       text,
  p_category    text,
  p_description text,
  p_payload     jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing   public.web_form_submissions%ROWTYPE;
  v_phone9     text;
  v_email      text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_matches    uuid[];
  v_customer   uuid;
  v_status     text;
  v_enq_id     uuid;
  v_enq_num    text;
  v_contact    text;
BEGIN
  IF p_provider IS DISTINCT FROM 'shopify'
     OR coalesce(btrim(p_shop_domain), '') = ''
     OR coalesce(btrim(p_external_id), '') = ''
     OR p_brand NOT IN ('canvas_guy', 'seating_company')
     OR coalesce(btrim(p_name), '') = ''
     OR coalesce(btrim(p_description), '') = '' THEN
    RAISE EXCEPTION 'BAD_INPUT';
  END IF;

  -- A retry of a submission we already hold: return the same enquiry.
  SELECT * INTO v_existing FROM public.web_form_submissions
  WHERE provider = p_provider AND shop_domain = p_shop_domain AND external_id = p_external_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'duplicate', true,
      'enquiry_id', v_existing.enquiry_id,
      'enq_num', (SELECT enq_num FROM public.enquiries WHERE id = v_existing.enquiry_id),
      'match_status', v_existing.match_status);
  END IF;

  -- Flood protection (cheap; the proxy signature only proves the request came via Shopify).
  IF (SELECT count(*) FROM public.web_form_submissions WHERE received_at > now() - interval '10 minutes') >= 30 THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;
  IF (SELECT count(*) FROM public.web_form_submissions
      WHERE received_at > now() - interval '1 hour'
        AND ((p_phone IS NOT NULL AND contact_phone = p_phone)
          OR (v_email IS NOT NULL AND contact_email = v_email))) >= 3 THEN
    RAISE EXCEPTION 'RATE_LIMITED';
  END IF;

  -- Customer match: phone (last 9 digits), then email. Exactly one match or none.
  v_phone9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  IF length(v_phone9) = 9 THEN
    SELECT array_agg(id) INTO v_matches FROM (
      SELECT id FROM public.customers
      WHERE right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) = v_phone9
      LIMIT 2) m;
    IF coalesce(array_length(v_matches, 1), 0) = 1 THEN
      v_customer := v_matches[1]; v_status := 'matched_phone';
    ELSIF coalesce(array_length(v_matches, 1), 0) > 1 THEN
      v_status := 'ambiguous';
    END IF;
  END IF;

  IF v_status IS NULL AND v_email IS NOT NULL THEN
    SELECT array_agg(id) INTO v_matches FROM (
      SELECT id FROM public.customers WHERE lower(btrim(email)) = v_email LIMIT 2) m;
    IF coalesce(array_length(v_matches, 1), 0) = 1 THEN
      v_customer := v_matches[1]; v_status := 'matched_email';
    ELSIF coalesce(array_length(v_matches, 1), 0) > 1 THEN
      v_status := 'ambiguous';
    END IF;
  END IF;

  v_status := coalesce(v_status, 'new_prospect');
  v_contact := nullif(concat_ws(' · ', nullif(btrim(coalesce(p_phone, '')), ''), v_email), '');
  v_enq_num := public.next_enq_num();

  INSERT INTO public.enquiries (
    enq_num, customer_id, prospect_name, prospect_contact,
    source, brand, category, description, estimated_value, stage
  ) VALUES (
    v_enq_num, v_customer,
    CASE WHEN v_customer IS NULL THEN btrim(p_name) END,
    CASE WHEN v_customer IS NULL THEN v_contact END,
    'website', p_brand, nullif(btrim(coalesce(p_category, '')), ''), p_description, 0, 'new'
  ) RETURNING id INTO v_enq_id;

  INSERT INTO public.web_form_submissions
    (provider, shop_domain, external_id, brand, contact_phone, contact_email, match_status, enquiry_id, payload)
  VALUES
    (p_provider, p_shop_domain, p_external_id, p_brand, nullif(btrim(coalesce(p_phone, '')), ''), v_email,
     v_status, v_enq_id, coalesce(p_payload, '{}'::jsonb));

  INSERT INTO public.quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('enquiry', v_enq_id, 'created',
    format('Enquiry %s received from the website form%s', v_enq_num,
      CASE v_status
        WHEN 'matched_phone' THEN ' (existing customer, matched by phone)'
        WHEN 'matched_email' THEN ' (existing customer, matched by email)'
        WHEN 'ambiguous'     THEN ' (several customers share this phone/email: check before linking)'
        ELSE ' (new prospect)' END),
    NULL);

  RETURN jsonb_build_object(
    'duplicate', false, 'enquiry_id', v_enq_id, 'enq_num', v_enq_num, 'match_status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.create_enquiry_from_web_form(text, text, text, text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_enquiry_from_web_form(text, text, text, text, text, text, text, text, text, jsonb)
  TO service_role;

COMMIT;
