-- ════════════════════════════════════════════════════════════════════════
-- convert_inbound_email_to_enquiry — atomic queue-row-to-enquiry conversion
--
-- Replaces what would otherwise be a two-step JS insert-then-update
-- (create the enquiry, then mark the inbound_emails row converted) with a
-- single transaction, following this project's standard pattern for any
-- write that must not partially succeed (see create_payroll_batch,
-- reversal RPCs, etc.). Without this, a crash between the two steps could
-- leave an inbound_emails row silently missed by "pending" filters forever
-- (if it updates first) or let the same email be converted twice into two
-- separate enquiries (if it inserts first and the update never runs).
--
-- brand is deliberately NOT a parameter — it is read from the locked
-- inbound_emails row itself, so the enquiry's brand can never drift from
-- which mailbox the message actually arrived in.
--
-- Safe to run: CREATE OR REPLACE; no destructive DDL.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.convert_inbound_email_to_enquiry(
  p_inbound_email_id uuid,
  p_enq_num          text,
  p_customer_id      uuid,
  p_prospect_name    text,
  p_prospect_contact text,
  p_category         text,
  p_description      text,
  p_estimated_value  integer,
  p_assigned_to      uuid,
  p_created_by       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row         inbound_emails%ROWTYPE;
  v_enquiry_id  uuid;
BEGIN
  -- Lock the queue row so a concurrent convert/dismiss call on the same
  -- row queues behind this one rather than racing it.
  SELECT * INTO v_row
  FROM inbound_emails
  WHERE id = p_inbound_email_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'inbound_emails row % not found', p_inbound_email_id;
  END IF;

  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'inbound_emails row % is already %, not pending', p_inbound_email_id, v_row.status;
  END IF;

  IF p_customer_id IS NULL AND (p_prospect_name IS NULL OR btrim(p_prospect_name) = '') THEN
    RAISE EXCEPTION 'Must provide either an existing customer_id or a prospect_name';
  END IF;

  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'description must not be empty';
  END IF;

  INSERT INTO enquiries (
    enq_num, customer_id, prospect_name, prospect_contact,
    source, brand, category, description, estimated_value,
    assigned_to, stage, created_by
  ) VALUES (
    p_enq_num, p_customer_id, p_prospect_name, p_prospect_contact,
    'email', v_row.brand, p_category, p_description, COALESCE(p_estimated_value, 0),
    p_assigned_to, 'new', p_created_by
  )
  RETURNING id INTO v_enquiry_id;

  UPDATE inbound_emails
  SET status = 'converted',
      converted_enquiry_id = v_enquiry_id,
      reviewed_by = p_created_by,
      reviewed_at = now()
  WHERE id = p_inbound_email_id;

  INSERT INTO quote_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('enquiry', v_enquiry_id, 'created', format('Enquiry %s created from inbound email', p_enq_num), p_created_by);

  RETURN jsonb_build_object('enquiry_id', v_enquiry_id, 'enq_num', p_enq_num);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.convert_inbound_email_to_enquiry(uuid,text,uuid,text,text,text,text,integer,uuid,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.convert_inbound_email_to_enquiry(uuid,text,uuid,text,text,text,text,integer,uuid,uuid) TO service_role;
