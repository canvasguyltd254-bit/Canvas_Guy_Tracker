-- ============================================================
-- PAYROLL MODULE v2 — Security, atomicity, and batch-entry links
-- Run AFTER payroll_module.sql
-- ============================================================

-- ── 1. Enable RLS on all payroll tables ──────────────────────
-- Prevents direct Supabase client queries from authenticated browser
-- sessions from reading salary, identity, or banking data.
-- All API routes use serviceClient (service_role) which bypasses RLS.

ALTER TABLE employees                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_attendance            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_adjustments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_order_allocations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payment_batches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_statutory_deductions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_rules               ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_documents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_activities            ENABLE ROW LEVEL SECURITY;

-- Drop any existing permissive policies, then add deny-by-default.
-- service_role bypasses RLS automatically — no explicit policy needed for it.
-- Authenticated browser users (anon or JWT) get no direct access.

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'employees','payroll_runs','payroll_entries','payroll_attendance',
    'payroll_adjustments','payroll_order_allocations','payroll_payment_batches',
    'payroll_payments','payroll_statutory_deductions','statutory_rules',
    'employee_documents','payroll_activities'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Remove any leftover permissive policies
    EXECUTE format('DROP POLICY IF EXISTS "service_role_only" ON %I', tbl);
    -- No policy = deny all non-service-role access (RLS enabled + no policy = deny)
  END LOOP;
END $$;

-- ── 2. Add reopen_reason to payroll_runs ─────────────────────
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS reopen_reason text;

-- ── 3. payroll_batch_entry_links ─────────────────────────────
-- Tracks exactly which payroll_entries belong to a batch.
-- CSV export and reconciliation operate only on linked entries.

CREATE TABLE IF NOT EXISTS payroll_batch_entry_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   uuid NOT NULL REFERENCES payroll_payment_batches(id) ON DELETE CASCADE,
  entry_id   uuid NOT NULL REFERENCES payroll_entries(id) ON DELETE CASCADE,
  amount     numeric(10,2) NOT NULL,  -- balance owed at time of batch creation (snapshot)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_entry_links_batch ON payroll_batch_entry_links(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_entry_links_entry ON payroll_batch_entry_links(entry_id);

-- RLS on junction table
ALTER TABLE payroll_batch_entry_links ENABLE ROW LEVEL SECURITY;

-- ── 4. RPC: record_payroll_payment (atomic) ──────────────────
-- Inserts a payment and updates entry amount_paid + payment_status
-- in a single transaction. Returns the updated entry payment_status.

CREATE OR REPLACE FUNCTION record_payroll_payment(
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
AS $$
DECLARE
  v_entry      payroll_entries%ROWTYPE;
  v_new_paid   numeric;
  v_new_status text;
  v_payment_id uuid;
BEGIN
  -- Lock the entry row to prevent concurrent updates
  SELECT * INTO v_entry
  FROM payroll_entries
  WHERE id = p_entry_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found: %', p_entry_id;
  END IF;

  -- Overpayment guard
  IF p_amount > (v_entry.net_pay - v_entry.amount_paid) + 0.01 THEN
    RAISE EXCEPTION 'Payment % exceeds remaining balance %',
      p_amount, (v_entry.net_pay - v_entry.amount_paid);
  END IF;

  -- Insert payment
  INSERT INTO payroll_payments (
    batch_id, entry_id, employee_id, amount, payment_date,
    payment_method, phone, reference, status, notes, created_by
  ) VALUES (
    p_batch_id, p_entry_id, p_employee_id, p_amount, p_payment_date,
    p_payment_method, p_phone, p_reference, 'confirmed', p_notes, p_created_by
  ) RETURNING id INTO v_payment_id;

  -- Update entry
  v_new_paid   := v_entry.amount_paid + p_amount;
  v_new_status := CASE
    WHEN (v_entry.net_pay - v_new_paid) <= 0.01 THEN 'paid'
    ELSE 'part_paid'
  END;

  UPDATE payroll_entries
  SET amount_paid    = v_new_paid,
      payment_status = v_new_status
  WHERE id = p_entry_id;

  RETURN jsonb_build_object(
    'payment_id',    v_payment_id,
    'entry_status',  v_new_status,
    'amount_paid',   v_new_paid,
    'balance',       v_entry.net_pay - v_new_paid
  );
END;
$$;

-- ── 5. RPC: replace_order_allocations (atomic) ───────────────
-- Replaces all order allocations for an entry in one transaction.

CREATE OR REPLACE FUNCTION replace_order_allocations(
  p_entry_id   uuid,
  p_run_id     uuid,
  p_employee_id uuid,
  p_allocations jsonb,   -- [{order_id, allocated_amount, notes}]
  p_created_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_entry    payroll_entries%ROWTYPE;
  v_total    numeric := 0;
  v_alloc    jsonb;
  v_inserted int := 0;
BEGIN
  -- Lock entry
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found: %', p_entry_id;
  END IF;

  -- Block after payment started
  IF v_entry.amount_paid > 0 THEN
    RAISE EXCEPTION 'Cannot change allocations after payment has been recorded';
  END IF;

  -- Validate total
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_total := v_total + (v_alloc->>'allocated_amount')::numeric;
  END LOOP;

  IF abs(v_total - v_entry.gross_pay) > 1 THEN
    RAISE EXCEPTION 'Allocation total % does not match gross pay %', v_total, v_entry.gross_pay;
  END IF;

  -- Replace
  DELETE FROM payroll_order_allocations WHERE entry_id = p_entry_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO payroll_order_allocations (
      run_id, entry_id, employee_id, order_id, allocated_amount, notes, created_by
    ) VALUES (
      p_run_id, p_entry_id, p_employee_id,
      (v_alloc->>'order_id')::uuid,
      (v_alloc->>'allocated_amount')::numeric,
      v_alloc->>'notes',
      p_created_by
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'total', v_total);
END;
$$;

-- ── 6. RPC: reconcile_payment_batch (atomic) ─────────────────
-- Marks batch reconciled, creates payroll_payment records for each
-- linked entry, and updates entry amount_paid + payment_status.

CREATE OR REPLACE FUNCTION reconcile_payment_batch(
  p_batch_id     uuid,
  p_chatpesa_ref text,
  p_payment_date date,
  p_reconciled_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_batch    payroll_payment_batches%ROWTYPE;
  v_link     payroll_batch_entry_links%ROWTYPE;
  v_entry    payroll_entries%ROWTYPE;
  v_count    int := 0;
  v_total    numeric := 0;
  v_result   jsonb;
BEGIN
  -- Lock batch
  SELECT * INTO v_batch FROM payroll_payment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
  IF v_batch.status = 'reconciled' THEN RAISE EXCEPTION 'Batch already reconciled'; END IF;

  -- Process each linked entry
  FOR v_link IN
    SELECT * FROM payroll_batch_entry_links WHERE batch_id = p_batch_id
  LOOP
    -- Lock entry
    SELECT * INTO v_entry FROM payroll_entries WHERE id = v_link.entry_id FOR UPDATE;

    -- Skip if already fully paid
    CONTINUE WHEN v_entry.net_pay - v_entry.amount_paid <= 0.01;

    DECLARE
      v_pay_amount numeric := least(v_link.amount, v_entry.net_pay - v_entry.amount_paid);
      v_new_paid   numeric;
      v_new_status text;
    BEGIN
      -- Insert payment record
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

  -- Mark batch reconciled
  UPDATE payroll_payment_batches
  SET status         = 'reconciled',
      chatpesa_ref   = p_chatpesa_ref,
      reconciled_at  = now(),
      reconciled_by  = p_reconciled_by
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'payments_created', v_count,
    'total_paid',       v_total
  );
END;
$$;
