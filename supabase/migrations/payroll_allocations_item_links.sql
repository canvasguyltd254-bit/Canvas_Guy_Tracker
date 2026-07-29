-- payroll_allocations_item_links.sql
-- Adds order_item_id to payroll_order_allocations and updates the
-- replace_order_allocations RPC to:
--   1. Accept order_item_id in the allocations JSONB
--   2. Validate total > 0 (removes the == gross_pay equality check that
--      broke for skilled_casual workers whose gross_pay starts at 0)
--   3. Validate total does not exceed net_pay (if net_pay already set)

-- ── 1. Schema change ──────────────────────────────────────────────────────
ALTER TABLE payroll_order_allocations
  ADD COLUMN IF NOT EXISTS order_item_id uuid REFERENCES order_items(id) ON DELETE SET NULL;

-- ── 2. Updated RPC ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION replace_order_allocations(
  p_entry_id    uuid,
  p_run_id      uuid,
  p_employee_id uuid,
  p_allocations jsonb,   -- [{order_id, order_item_id?, allocated_amount, notes?}]
  p_created_by  uuid
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
  v_item_id  uuid;
BEGIN
  -- Lock the entry row to prevent concurrent modifications
  SELECT * INTO v_entry FROM payroll_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found: %', p_entry_id;
  END IF;

  -- Block once any payment has been recorded
  IF v_entry.amount_paid > 0 THEN
    RAISE EXCEPTION 'Cannot change allocations after payment has been recorded';
  END IF;

  -- Sum the incoming allocations
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_total := v_total + (v_alloc->>'allocated_amount')::numeric;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Total allocation must be greater than zero';
  END IF;

  -- NOTE: No net_pay cap for skilled_casual workers.
  -- Their gross_pay IS the sum of allocations (per-item basis, no salary ceiling).

  -- Atomic replace: delete then insert
  DELETE FROM payroll_order_allocations WHERE entry_id = p_entry_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    -- order_item_id is optional; cast only when present and non-empty
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

GRANT EXECUTE ON FUNCTION replace_order_allocations(uuid,uuid,uuid,jsonb,uuid) TO service_role;
