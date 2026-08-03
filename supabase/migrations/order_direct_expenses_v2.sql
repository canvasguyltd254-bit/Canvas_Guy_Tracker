-- ─────────────────────────────────────────────────────────────────────────────
-- order_direct_expenses v2 patch
--
-- 1. Add accounting_category_id  — FK to accounting_categories; used for GL
--    posting instead of the hardcoded gl_account_code field.
-- 2. Add journal_entry_id        — stores the journal_entries.id created when
--    the expense is first posted (and the reversal entry on reversal).
-- 3. Add for_direct_expenses flag to accounting_categories so the modal can
--    show a filtered subset of accounts.
-- 4. replace_expense_links RPC   — atomically replaces all allocation rows for
--    an expense inside a single transaction. Raises if expense is posted.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. New columns on order_direct_expenses
ALTER TABLE order_direct_expenses
  ADD COLUMN IF NOT EXISTS accounting_category_id UUID REFERENCES accounting_categories(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id        UUID;

-- 1b. Add for_direct_expenses flag to accounting_categories
ALTER TABLE accounting_categories
  ADD COLUMN IF NOT EXISTS for_direct_expenses BOOLEAN NOT NULL DEFAULT false;

-- 1c. Seed the flag for accounts that make sense for direct order expenses
--     (Cost of Sales + the most common operating lines)
UPDATE accounting_categories
   SET for_direct_expenses = true
  FROM accounting_accounts a
 WHERE accounting_categories.account_id = a.id
   AND a.code IN (
     '5140',  -- Direct Labour
     '5150',  -- Direct Transport
     '6030',  -- Transport & Fuel
     '6070',  -- Repairs & Maintenance
     '6100',  -- Casual Labour
     '6030',  -- Transport & Fuel (redundant but safe)
     '4600'   -- Delivery & Installation Income (credit side — skip; but keep for completeness)
   );

-- Also flag any account with for_petty_cash = true (those are already operational expenses)
UPDATE accounting_categories
   SET for_direct_expenses = true
 WHERE for_petty_cash = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. replace_expense_links
--
--    Atomically replaces ALL order_direct_expense_links for a given expense.
--    Validates:
--      - expense exists and is NOT reversed
--      - expense is NOT posted (immutable once posted)
--      - SUM(allocated_amounts) <= expense.amount
--      - no duplicate order_id in the supplied list
--    On success: deletes existing links, inserts new ones.
--    On failure: raises an exception (Postgres rolls back automatically).
--
--    p_links: JSON array of {order_id uuid, allocated_amount numeric}
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION replace_expense_links(
  p_expense_id  UUID,
  p_links       JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense     order_direct_expenses%ROWTYPE;
  v_link        JSONB;
  v_total_alloc NUMERIC := 0;
  v_order_id    UUID;
  v_alloc       NUMERIC;
BEGIN
  -- Lock the expense row to prevent concurrent modifications
  SELECT * INTO v_expense
    FROM order_direct_expenses
   WHERE id = p_expense_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_expense_id;
  END IF;

  IF v_expense.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot modify allocations on a reversed expense';
  END IF;

  IF v_expense.is_posted THEN
    RAISE EXCEPTION 'Cannot modify links on a posted expense — reverse and create a new expense instead';
  END IF;

  -- Validate total allocations
  SELECT COALESCE(SUM((l->>'allocated_amount')::NUMERIC), 0)
    INTO v_total_alloc
    FROM jsonb_array_elements(p_links) l;

  IF v_total_alloc > v_expense.amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocated (%) exceeds expense amount (%)',
      v_total_alloc, v_expense.amount;
  END IF;

  -- Validate no duplicate order_ids in the supplied list
  IF (
    SELECT COUNT(DISTINCT (l->>'order_id')::UUID)
      FROM jsonb_array_elements(p_links) l
  ) < jsonb_array_length(p_links) THEN
    RAISE EXCEPTION 'Duplicate order_id in links array';
  END IF;

  -- Atomically replace links
  DELETE FROM order_direct_expense_links WHERE expense_id = p_expense_id;

  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    v_order_id := (v_link->>'order_id')::UUID;
    v_alloc    := (v_link->>'allocated_amount')::NUMERIC;

    IF v_alloc IS NULL OR v_alloc <= 0 THEN
      RAISE EXCEPTION 'allocated_amount must be positive for order %', v_order_id;
    END IF;

    INSERT INTO order_direct_expense_links (expense_id, order_id, allocated_amount)
    VALUES (p_expense_id, v_order_id, v_alloc);
  END LOOP;
END;
$$;

-- Restrict direct execution to service_role only
REVOKE ALL ON FUNCTION replace_expense_links(UUID, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION replace_expense_links(UUID, JSONB) TO service_role;
