-- ─────────────────────────────────────────────────────────────────────────────
-- order_direct_expenses v3 patch
--
-- 1. Add expense_category column — business-facing label (Sales Commission,
--    Fine, etc.), separate from the GL account label stored in `category`.
-- 2. Clean up bad for_direct_expenses seed (remove revenue account 4600).
-- 3. create_direct_expense RPC — atomically inserts expense + all order links
--    in a single transaction. Returns the new expense UUID.
--    GL posting happens in JS after the RPC; is_posted is set to true only
--    after the journal entry is confirmed.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Business-facing expense category field
ALTER TABLE order_direct_expenses
  ADD COLUMN IF NOT EXISTS expense_category TEXT;

-- 2. Remove revenue account 4600 from direct-expense flag (wrong account type)
UPDATE accounting_categories
   SET for_direct_expenses = false
  FROM accounting_accounts a
 WHERE accounting_categories.account_id = a.id
   AND a.code = '4600';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. create_direct_expense
--
--    Atomically:
--      a) Inserts the expense row (is_posted = false)
--      b) Inserts all order_direct_expense_links rows
--    Returns the new expense UUID.
--    Caller (JS) posts the GL journal after, then updates
--    is_posted = true and journal_entry_id.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_direct_expense(
  p_expense_date           DATE,
  p_expense_category       TEXT,
  p_gl_label               TEXT,
  p_description            TEXT,
  p_payee_name             TEXT,
  p_amount                 NUMERIC,
  p_payment_status         TEXT,
  p_payment_method         TEXT,
  p_payment_reference      TEXT,
  p_receipt_url            TEXT,
  p_notes                  TEXT,
  p_accounting_category_id UUID,
  p_created_by             UUID,
  p_links                  JSONB   -- [{order_id uuid, allocated_amount numeric}]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id  UUID;
  v_link        JSONB;
  v_total_alloc NUMERIC;
  v_order_id    UUID;
  v_alloc       NUMERIC;
BEGIN
  -- Validate total allocations ≤ expense amount
  SELECT COALESCE(SUM((l->>'allocated_amount')::NUMERIC), 0)
    INTO v_total_alloc
    FROM jsonb_array_elements(p_links) l;

  IF v_total_alloc > p_amount + 0.01 THEN
    RAISE EXCEPTION 'Total allocated (%) exceeds expense amount (%)',
      v_total_alloc, p_amount;
  END IF;

  -- Validate no duplicate order_ids
  IF (
    SELECT COUNT(DISTINCT (l->>'order_id')::UUID)
      FROM jsonb_array_elements(p_links) l
  ) < jsonb_array_length(p_links) THEN
    RAISE EXCEPTION 'Duplicate order_id in links array';
  END IF;

  -- Insert expense; is_posted starts false — JS sets it true after GL confirms
  INSERT INTO order_direct_expenses (
    expense_date, expense_category, category,
    description, payee_name,
    amount, payment_status, payment_method, payment_reference,
    receipt_url, notes,
    accounting_category_id, created_by,
    is_posted
  ) VALUES (
    p_expense_date, p_expense_category, p_gl_label,
    p_description, NULLIF(p_payee_name, ''),
    p_amount, p_payment_status, NULLIF(p_payment_method, ''), NULLIF(p_payment_reference, ''),
    NULLIF(p_receipt_url, ''), NULLIF(p_notes, ''),
    p_accounting_category_id, p_created_by,
    false
  )
  RETURNING id INTO v_expense_id;

  -- Insert all order links
  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    v_order_id := (v_link->>'order_id')::UUID;
    v_alloc    := (v_link->>'allocated_amount')::NUMERIC;

    IF v_alloc IS NULL OR v_alloc <= 0 THEN
      RAISE EXCEPTION 'allocated_amount must be positive for order %', v_order_id;
    END IF;

    INSERT INTO order_direct_expense_links (expense_id, order_id, allocated_amount)
    VALUES (v_expense_id, v_order_id, v_alloc);
  END LOOP;

  RETURN v_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION create_direct_expense(
  DATE, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, UUID, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION create_direct_expense(
  DATE, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT,
  UUID, UUID, JSONB
) TO service_role;
