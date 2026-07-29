-- ════════════════════════════════════════════════════════════
-- UPDATE MIGRATION — run this on your existing Supabase DB
-- Combines: payroll_allocations_item_links + payroll_rpc_security_fix
-- Safe to run: uses IF NOT EXISTS / CREATE OR REPLACE throughout
-- ════════════════════════════════════════════════════════════

-- 1. Add order_item_id to payroll_order_allocations
ALTER TABLE payroll_order_allocations
  ADD COLUMN IF NOT EXISTS order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL;

-- 2. Add exported_entry_ids to payroll_payment_batches
ALTER TABLE payroll_payment_batches
  ADD COLUMN IF NOT EXISTS exported_entry_ids uuid[];

-- 3. replace_order_allocations — no net_pay cap for skilled_casual
CREATE OR REPLACE FUNCTION public.replace_order_allocations(
  p_entry_id    uuid,
  p_run_id      uuid,
  p_employee_id uuid,
  p_allocations jsonb,
  p_created_by  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry    payroll_entries%ROWTYPE;
  v_total    numeric := 0;
  v_alloc    jsonb;
  v_inserted int := 0;
  v_item_id  uuid;
BEGIN
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found: %', p_entry_id;
  END IF;

  IF v_entry.amount_paid > 0 THEN
    RAISE EXCEPTION 'Cannot change allocations after payment has been recorded';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_total := v_total + (v_alloc->>'allocated_amount')::numeric;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Total allocation must be greater than zero';
  END IF;

  -- No net_pay cap: skilled_casual gross_pay = sum of allocations (no ceiling)

  DELETE FROM payroll_order_allocations WHERE entry_id = p_entry_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_item_id := CASE
      WHEN (v_alloc->>'order_item_id') IS NOT NULL
       AND (v_alloc->>'order_item_id') <> ''
      THEN (v_alloc->>'order_item_id')::uuid
      ELSE NULL
    END;

    INSERT INTO payroll_order_allocations (
      run_id, entry_id, employee_id,
      order_id, order_item_id,
      allocated_amount, notes, created_by
    ) VALUES (
      p_run_id, p_entry_id, p_employee_id,
      (v_alloc->>'order_id')::uuid,
      v_item_id,
      (v_alloc->>'allocated_amount')::numeric,
      v_alloc->>'notes',
      p_created_by
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_order_allocations(uuid,uuid,uuid,jsonb,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.replace_order_allocations(uuid,uuid,uuid,jsonb,uuid) TO service_role;

-- 4. record_payroll_payment — overpayment guard
CREATE OR REPLACE FUNCTION public.record_payroll_payment(
  p_entry_id       uuid,
  p_batch_id       uuid,
  p_employee_id    uuid,
  p_amount         numeric,
  p_payment_date   date,
  p_payment_method text,
  p_phone          text,
  p_reference      text,
  p_notes          text,
  p_created_by     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry      payroll_entries%ROWTYPE;
  v_new_paid   numeric;
  v_new_status text;
  v_payment_id uuid;
BEGIN
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found: %', p_entry_id; END IF;

  IF p_amount > (v_entry.net_pay - v_entry.amount_paid) + 0.01 THEN
    RAISE EXCEPTION 'Payment % exceeds remaining balance %',
      p_amount, (v_entry.net_pay - v_entry.amount_paid);
  END IF;

  INSERT INTO payroll_payments (
    batch_id, entry_id, employee_id, amount, payment_date,
    payment_method, phone, reference, status, notes, created_by
  ) VALUES (
    p_batch_id, p_entry_id, p_employee_id, p_amount, p_payment_date,
    p_payment_method, p_phone, p_reference, 'confirmed', p_notes, p_created_by
  ) RETURNING id INTO v_payment_id;

  v_new_paid   := v_entry.amount_paid + p_amount;
  v_new_status := CASE
    WHEN (v_entry.net_pay - v_new_paid) <= 0.01 THEN 'paid'
    ELSE 'part_paid'
  END;

  UPDATE payroll_entries
  SET amount_paid = v_new_paid, payment_status = v_new_status
  WHERE id = p_entry_id;

  RETURN jsonb_build_object(
    'payment_id',   v_payment_id,
    'entry_status', v_new_status,
    'amount_paid',  v_new_paid,
    'balance',      v_entry.net_pay - v_new_paid
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_payroll_payment(uuid,uuid,uuid,numeric,date,text,text,text,text,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_payroll_payment(uuid,uuid,uuid,numeric,date,text,text,text,text,uuid) TO service_role;

-- 5. reconcile_payment_batch — skips entries not in exported_entry_ids
CREATE OR REPLACE FUNCTION public.reconcile_payment_batch(
  p_batch_id      uuid,
  p_chatpesa_ref  text,
  p_payment_date  date,
  p_reconciled_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch   payroll_payment_batches%ROWTYPE;
  v_link    payroll_batch_entry_links%ROWTYPE;
  v_entry   payroll_entries%ROWTYPE;
  v_skipped uuid[];
  v_count   int := 0;
  v_total   numeric := 0;
BEGIN
  SELECT * INTO v_batch FROM payroll_payment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF v_batch.status = 'reconciled' THEN RAISE EXCEPTION 'Batch already reconciled'; END IF;

  v_skipped := COALESCE(
    ARRAY(
      SELECT e.id
      FROM payroll_batch_entry_links bel
      JOIN payroll_entries e ON e.id = bel.entry_id
      WHERE bel.batch_id = p_batch_id
        AND v_batch.exported_entry_ids IS NOT NULL
        AND NOT (e.id = ANY(v_batch.exported_entry_ids))
    ),
    '{}'::uuid[]
  );

  FOR v_link IN SELECT * FROM payroll_batch_entry_links WHERE batch_id = p_batch_id LOOP
    CONTINUE WHEN v_link.entry_id = ANY(v_skipped);

    SELECT * INTO v_entry FROM payroll_entries WHERE id = v_link.entry_id FOR UPDATE;
    CONTINUE WHEN v_entry.net_pay - v_entry.amount_paid <= 0.01;

    DECLARE
      v_pay_amount numeric := least(v_link.amount, v_entry.net_pay - v_entry.amount_paid);
      v_new_paid   numeric;
      v_new_status text;
    BEGIN
      INSERT INTO payroll_payments (
        batch_id, entry_id, employee_id, amount, payment_date,
        payment_method, reference, status, created_by
      ) VALUES (
        p_batch_id, v_link.entry_id, v_entry.employee_id,
        v_pay_amount, p_payment_date,
        v_batch.payment_method, p_chatpesa_ref, 'confirmed', p_reconciled_by
      );

      v_new_paid   := v_entry.amount_paid + v_pay_amount;
      v_new_status := CASE WHEN (v_entry.net_pay - v_new_paid) <= 0.01 THEN 'paid' ELSE 'part_paid' END;

      UPDATE payroll_entries
      SET amount_paid = v_new_paid, payment_status = v_new_status
      WHERE id = v_link.entry_id;

      v_count := v_count + 1;
      v_total := v_total + v_pay_amount;
    END;
  END LOOP;

  UPDATE payroll_payment_batches
  SET status        = 'reconciled',
      chatpesa_ref  = p_chatpesa_ref,
      reconciled_at = now(),
      reconciled_by = p_reconciled_by
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'payments_created', v_count,
    'total_paid',       v_total,
    'skipped_count',    array_length(v_skipped, 1)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_payment_batch(uuid,text,date,uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.reconcile_payment_batch(uuid,text,date,uuid) TO service_role;
