-- Migration: backfill invoice_number for orders that have been invoiced
--            but never received their invoice_number field.
--
-- SCOPE: orders where the invoice GL journal WAS posted
--        (invoice_journal_entry_id IS NOT NULL)
--        but invoice_number is somehow NULL — e.g. because the GL RPC ran
--        successfully but a subsequent step that wrote the number back failed.
--
-- EXCLUDED: orders with no journal entry yet (invoice not yet triggered).
--           Those are pending invoices and correctly have no number yet.
--           The GL RPCs (post_deposit_paid_journals / post_credit_order_invoice)
--           will assign next_inv_num() atomically when the financial trigger fires.
--
-- invoice_issued_at is sourced from journal_entries.posted_at — the actual
-- moment the invoice was posted to the GL — not from orders.created_at.

DO $$
DECLARE
  r   RECORD;
  inv TEXT;
BEGIN
  FOR r IN
    SELECT o.id, je.posted_at
    FROM   orders o
    JOIN   journal_entries je ON je.id = o.invoice_journal_entry_id
    WHERE  o.invoice_number IS NULL
      AND  o.invoice_journal_entry_id IS NOT NULL
    ORDER  BY je.posted_at ASC   -- oldest first so numbers reflect posting order
  LOOP
    inv := next_inv_num();
    UPDATE orders
    SET
      invoice_number    = inv,
      invoice_issued_at = r.posted_at
    WHERE id = r.id;
  END LOOP;
END;
$$;
