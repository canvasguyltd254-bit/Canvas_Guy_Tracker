BEGIN;
-- ============================================================
-- SUSPENSION COLUMNS
-- Suspension is separate from operational workflow status.
-- ============================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS suspension_reason text;
-- ============================================================
-- PERMANENT LIFECYCLE AUDIT
-- No FK to orders/quotations: deletion must not erase the audit.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_lifecycle_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL
    CHECK (entity_type IN ('order', 'quotation')),
  entity_id   uuid NOT NULL,
  entity_ref  text NOT NULL,
  action      text NOT NULL
    CHECK (action IN ('suspended', 'unsuspended', 'deleted')),
  actor_id    uuid REFERENCES auth.users(id),
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_entity
  ON public.order_lifecycle_audit(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_created
  ON public.order_lifecycle_audit(created_at DESC);
-- ============================================================
-- SUSPEND ORDER
-- ============================================================
CREATE OR REPLACE FUNCTION public.suspend_order(
  p_order_id uuid,
  p_reason   text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'P0006';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_order.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_SUSPENDED' USING ERRCODE = 'P0004';
  END IF;
  UPDATE public.orders
  SET suspended_at = now(),
      suspended_by = p_actor_id,
      suspension_reason = btrim(p_reason)
  WHERE id = p_order_id;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    reason,
    metadata
  )
  VALUES (
    'order',
    p_order_id,
    v_order.order_num,
    'suspended',
    p_actor_id,
    btrim(p_reason),
    jsonb_build_object(
      'status', v_order.status,
      'client', v_order.client,
      'suspended_at', now()
    )
  );
  RETURN jsonb_build_object(
    'suspended', true,
    'order_num', v_order.order_num
  );
END;
$$;
-- ============================================================
-- UNSUSPEND ORDER
-- ============================================================
CREATE OR REPLACE FUNCTION public.unsuspend_order(
  p_order_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_order.suspended_at IS NULL THEN
    RAISE EXCEPTION 'NOT_SUSPENDED' USING ERRCODE = 'P0005';
  END IF;
  UPDATE public.orders
  SET suspended_at = NULL,
      suspended_by = NULL,
      suspension_reason = NULL
  WHERE id = p_order_id;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    metadata
  )
  VALUES (
    'order',
    p_order_id,
    v_order.order_num,
    'unsuspended',
    p_actor_id,
    jsonb_build_object(
      'status', v_order.status,
      'previous_reason', v_order.suspension_reason,
      'previous_suspended_at', v_order.suspended_at,
      'unsuspended_at', now()
    )
  );
  RETURN jsonb_build_object(
    'suspended', false,
    'order_num', v_order.order_num
  );
END;
$$;
-- ============================================================
-- SUSPEND QUOTATION
-- ============================================================
CREATE OR REPLACE FUNCTION public.suspend_quotation(
  p_quote_id uuid,
  p_reason   text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.quotations%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'P0006';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_quote
  FROM public.quotations
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_quote.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_SUSPENDED' USING ERRCODE = 'P0004';
  END IF;
  UPDATE public.quotations
  SET suspended_at = now(),
      suspended_by = p_actor_id,
      suspension_reason = btrim(p_reason)
  WHERE id = p_quote_id;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    reason,
    metadata
  )
  VALUES (
    'quotation',
    p_quote_id,
    v_quote.quote_num,
    'suspended',
    p_actor_id,
    btrim(p_reason),
    jsonb_build_object(
      'status', v_quote.status,
      'revision', v_quote.revision,
      'suspended_at', now()
    )
  );
  RETURN jsonb_build_object(
    'suspended', true,
    'quote_num', v_quote.quote_num
  );
END;
$$;
-- ============================================================
-- UNSUSPEND QUOTATION
-- ============================================================
CREATE OR REPLACE FUNCTION public.unsuspend_quotation(
  p_quote_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.quotations%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_quote
  FROM public.quotations
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_quote.suspended_at IS NULL THEN
    RAISE EXCEPTION 'NOT_SUSPENDED' USING ERRCODE = 'P0005';
  END IF;
  UPDATE public.quotations
  SET suspended_at = NULL,
      suspended_by = NULL,
      suspension_reason = NULL
  WHERE id = p_quote_id;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    metadata
  )
  VALUES (
    'quotation',
    p_quote_id,
    v_quote.quote_num,
    'unsuspended',
    p_actor_id,
    jsonb_build_object(
      'status', v_quote.status,
      'revision', v_quote.revision,
      'previous_reason', v_quote.suspension_reason,
      'previous_suspended_at', v_quote.suspended_at,
      'unsuspended_at', now()
    )
  );
  RETURN jsonb_build_object(
    'suspended', false,
    'quote_num', v_quote.quote_num
  );
END;
$$;
-- ============================================================
-- ORDER DELETE ELIGIBILITY
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_order_deletable(
  p_order_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order    public.orders%ROWTYPE;
  v_blockers jsonb := '[]'::jsonb;
  v_count    integer;
BEGIN
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_order.status NOT IN ('Inquiry', 'Quote Approved') THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'STATUS_TOO_ADVANCED',
      'detail', v_order.status
    );
  END IF;
  -- Preserve quotation conversion history.
  IF v_order.quote_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_SOURCE_QUOTATION'
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.quotations
  WHERE converted_order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_CONVERTED_QUOTATION',
      'count', v_count
    );
  END IF;
  -- Include reversed payments: they remain audit history.
  SELECT count(*)
  INTO v_count
  FROM public.order_payments
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_PAYMENTS',
      'count', v_count
    );
  END IF;
  IF v_order.invoice_number IS NOT NULL
     OR v_order.invoice_issued_at IS NOT NULL
     OR v_order.invoice_journal_entry_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_INVOICE'
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.purchase_order_links
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_PURCHASE_LINKS',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.order_direct_expense_links
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_EXPENSE_LINKS',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.payroll_order_allocations
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_PAYROLL_ALLOCATIONS',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.delivery_batches
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_DELIVERY_BATCHES',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.order_deliveries
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_DELIVERIES',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.orders
  WHERE parent_order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_CHILD_ORDERS',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.drawings
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_DRAWINGS',
      'count', v_count
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.order_documents
  WHERE order_id = p_order_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_DOCUMENTS',
      'count', v_count
    );
  END IF;
  RETURN jsonb_build_object(
    'canDelete', jsonb_array_length(v_blockers) = 0,
    'status', v_order.status,
    'suspended', v_order.suspended_at IS NOT NULL,
    'blockers', v_blockers
  );
END;
$$;
-- ============================================================
-- HARD DELETE ORDER
-- ============================================================
CREATE OR REPLACE FUNCTION public.hard_delete_order(
  p_order_id     uuid,
  p_confirmation text,
  p_reason       text,
  p_actor_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_check jsonb;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'P0006';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_confirmation IS DISTINCT FROM v_order.order_num THEN
    RAISE EXCEPTION 'CONFIRMATION_MISMATCH' USING ERRCODE = 'P0002';
  END IF;
  v_check := public.check_order_deletable(p_order_id);
  IF NOT (v_check->>'canDelete')::boolean THEN
    RAISE EXCEPTION 'NOT_DELETABLE: %', v_check->'blockers'
      USING ERRCODE = 'P0003';
  END IF;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    reason,
    metadata
  )
  VALUES (
    'order',
    p_order_id,
    v_order.order_num,
    'deleted',
    p_actor_id,
    btrim(p_reason),
    jsonb_build_object(
      'status', v_order.status,
      'client', v_order.client,
      'deleted_at', now()
    )
  );
  DELETE FROM public.order_items
  WHERE order_id = p_order_id;
  DELETE FROM public.order_notes
  WHERE order_id = p_order_id;
  DELETE FROM public.order_activities
  WHERE order_id = p_order_id;
  DELETE FROM public.orders
  WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_DELETE_FAILED' USING ERRCODE = 'P0008';
  END IF;
  RETURN jsonb_build_object(
    'deleted', true,
    'order_num', v_order.order_num
  );
END;
$$;
-- ============================================================
-- QUOTATION DELETE ELIGIBILITY
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_quotation_deletable(
  p_quote_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote    public.quotations%ROWTYPE;
  v_blockers jsonb := '[]'::jsonb;
  v_count    integer;
BEGIN
  SELECT *
  INTO v_quote
  FROM public.quotations
  WHERE id = p_quote_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_quote.status <> 'draft' THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'STATUS_NOT_DRAFT',
      'detail', v_quote.status
    );
  END IF;
  IF v_quote.converted_order_id IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'ALREADY_CONVERTED'
    );
  END IF;
  SELECT count(*)
  INTO v_count
  FROM public.orders
  WHERE quote_id = p_quote_id;
  IF v_count > 0 THEN
    v_blockers := v_blockers || jsonb_build_object(
      'code', 'HAS_LINKED_ORDERS',
      'count', v_count
    );
  END IF;
  RETURN jsonb_build_object(
    'canDelete', jsonb_array_length(v_blockers) = 0,
    'status', v_quote.status,
    'suspended', v_quote.suspended_at IS NOT NULL,
    'blockers', v_blockers
  );
END;
$$;
-- ============================================================
-- HARD DELETE QUOTATION
-- ============================================================
CREATE OR REPLACE FUNCTION public.hard_delete_quotation(
  p_quote_id      uuid,
  p_confirmation  text,
  p_reason        text,
  p_actor_id      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote public.quotations%ROWTYPE;
  v_check jsonb;
BEGIN
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = 'P0006';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = 'P0007';
  END IF;
  SELECT *
  INTO v_quote
  FROM public.quotations
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF p_confirmation IS DISTINCT FROM v_quote.quote_num THEN
    RAISE EXCEPTION 'CONFIRMATION_MISMATCH' USING ERRCODE = 'P0002';
  END IF;
  v_check := public.check_quotation_deletable(p_quote_id);
  IF NOT (v_check->>'canDelete')::boolean THEN
    RAISE EXCEPTION 'NOT_DELETABLE: %', v_check->'blockers'
      USING ERRCODE = 'P0003';
  END IF;
  INSERT INTO public.order_lifecycle_audit (
    entity_type,
    entity_id,
    entity_ref,
    action,
    actor_id,
    reason,
    metadata
  )
  VALUES (
    'quotation',
    p_quote_id,
    v_quote.quote_num,
    'deleted',
    p_actor_id,
    btrim(p_reason),
    jsonb_build_object(
      'status', v_quote.status,
      'revision', v_quote.revision,
      'deleted_at', now()
    )
  );
  DELETE FROM public.quote_items
  WHERE quote_id = p_quote_id;
  DELETE FROM public.quote_activities
  WHERE entity_type = 'quotation'
    AND entity_id = p_quote_id;
  DELETE FROM public.quotations
  WHERE id = p_quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_DELETE_FAILED' USING ERRCODE = 'P0008';
  END IF;
  RETURN jsonb_build_object(
    'deleted', true,
    'quote_num', v_quote.quote_num
  );
END;
$$;
-- ============================================================
-- SECURITY
-- ============================================================
REVOKE ALL ON FUNCTION public.suspend_order(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unsuspend_order(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.suspend_quotation(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unsuspend_quotation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_order_deletable(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hard_delete_order(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_quotation_deletable(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hard_delete_quotation(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_lifecycle_audit
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_order(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unsuspend_order(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.suspend_quotation(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unsuspend_quotation(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.check_order_deletable(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.hard_delete_order(uuid, text, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.check_quotation_deletable(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.hard_delete_quotation(
  uuid, text, text, uuid
) TO service_role;
GRANT SELECT, INSERT ON TABLE public.order_lifecycle_audit
  TO service_role;
-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_orders_suspended_at
  ON public.orders(suspended_at);
CREATE INDEX IF NOT EXISTS idx_quotations_suspended_at
  ON public.quotations(suspended_at);
COMMIT;
