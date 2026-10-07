-- ============================================================================
-- Canvas Guy Tracker — immutable customer identity on issued invoices
--
-- MODEL (traced, not assumed): an invoice is a 1:1 attribute of an order.
--   * identified by order id (CRM "invoice id" == orders.id)
--   * issued by exactly two RPCs — post_deposit_paid_journals (non-credit,
--     at Deposit Paid) and post_credit_order_invoice (credit, at Quote
--     Approved) — which stamp invoice_number / invoice_issued_at /
--     invoice_journal_entry_id in ONE UPDATE; both are idempotent
--   * also settable by hand: orders.invoice_number is in the insert/update
--     whitelists (legacy / manual numbering), with no journal behind it
--   * no versions, no partial invoices, no cancel-and-reissue: reversing the
--     invoice journal does not clear the order's invoice fields
-- => snapshot columns on `orders` are sufficient. If credit notes / reissue
--    are ever introduced, move these columns to an invoice_documents table.
--
-- CAPTURE happens in a BEFORE trigger on orders, in the SAME statement that
-- first stamps invoice_number or invoice_journal_entry_id. It therefore:
--   * commits or rolls back with the issuing RPC (no issue-then-patch window)
--   * covers both RPCs and any future issuing path with no per-route code
--   * reads the customer row itself — nothing is trusted from the browser
-- Snapshot columns supplied by a caller are IGNORED at capture time.
--
-- IMMUTABILITY: once captured, the snapshot cannot be changed by an ordinary
-- UPDATE. Corrections need a controlled amendment (not built here).
--
-- LEGACY: invoices issued before this migration get
--   source = 'legacy_order_snapshot', name = orders.client,
--   captured_at = invoice_issued_at (else created_at); every other field NULL.
-- The CURRENT customer record is never written into a legacy snapshot.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS invoice_customer_id_snapshot             uuid,
  ADD COLUMN IF NOT EXISTS invoice_customer_name_snapshot           text,
  ADD COLUMN IF NOT EXISTS invoice_customer_contact_person_snapshot text,
  ADD COLUMN IF NOT EXISTS invoice_customer_address_snapshot        text,
  ADD COLUMN IF NOT EXISTS invoice_customer_email_snapshot          text,
  ADD COLUMN IF NOT EXISTS invoice_customer_phone_snapshot          text,
  ADD COLUMN IF NOT EXISTS invoice_customer_tax_id_snapshot         text,
  ADD COLUMN IF NOT EXISTS invoice_customer_snapshot_at             timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_customer_snapshot_source         text;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_invoice_snapshot_source_check;
ALTER TABLE public.orders ADD  CONSTRAINT orders_invoice_snapshot_source_check
  CHECK (invoice_customer_snapshot_source IS NULL OR invoice_customer_snapshot_source IN
         ('customer_at_issue', 'order_snapshot_at_issue', 'legacy_order_snapshot'));

-- A snapshot is all-or-nothing: timestamp, source and name travel together.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_invoice_snapshot_complete_check;
ALTER TABLE public.orders ADD  CONSTRAINT orders_invoice_snapshot_complete_check
  CHECK (
    (invoice_customer_snapshot_at IS NULL
       AND invoice_customer_snapshot_source IS NULL
       AND invoice_customer_name_snapshot IS NULL)
    OR
    (invoice_customer_snapshot_at IS NOT NULL
       AND invoice_customer_snapshot_source IS NOT NULL
       AND invoice_customer_name_snapshot IS NOT NULL)
  );

COMMENT ON COLUMN public.orders.invoice_customer_snapshot_source IS
  'customer_at_issue = copied from the linked customer when the invoice was issued; order_snapshot_at_issue = walk-in order (no customer record), name from orders.client; legacy_order_snapshot = invoice pre-dates this feature, name from orders.client, full issued details were not captured.';

-- ── capture + immutability trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.orders_invoice_customer_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c            record;
  v_issued     boolean;
  v_linked     boolean := false;
  v_legacy_ok  boolean := COALESCE(current_setting('app.invoice_snapshot_legacy', true), '') = 'on';
BEGIN
  -- Already captured → immutable. (UPDATE only; an INSERT has no OLD.)
  IF TG_OP = 'UPDATE' AND OLD.invoice_customer_snapshot_at IS NOT NULL THEN
    IF NEW.invoice_customer_id_snapshot             IS DISTINCT FROM OLD.invoice_customer_id_snapshot
    OR NEW.invoice_customer_name_snapshot           IS DISTINCT FROM OLD.invoice_customer_name_snapshot
    OR NEW.invoice_customer_contact_person_snapshot IS DISTINCT FROM OLD.invoice_customer_contact_person_snapshot
    OR NEW.invoice_customer_address_snapshot        IS DISTINCT FROM OLD.invoice_customer_address_snapshot
    OR NEW.invoice_customer_email_snapshot          IS DISTINCT FROM OLD.invoice_customer_email_snapshot
    OR NEW.invoice_customer_phone_snapshot          IS DISTINCT FROM OLD.invoice_customer_phone_snapshot
    OR NEW.invoice_customer_tax_id_snapshot         IS DISTINCT FROM OLD.invoice_customer_tax_id_snapshot
    OR NEW.invoice_customer_snapshot_at             IS DISTINCT FROM OLD.invoice_customer_snapshot_at
    OR NEW.invoice_customer_snapshot_source         IS DISTINCT FROM OLD.invoice_customer_snapshot_source THEN
      RAISE EXCEPTION 'INVOICE_SNAPSHOT_IMMUTABLE: the customer identity on an issued invoice cannot be changed; use a controlled invoice amendment'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Migration-time legacy backfill sets the snapshot explicitly.
  IF v_legacy_ok AND NEW.invoice_customer_snapshot_source = 'legacy_order_snapshot' THEN
    RETURN NEW;
  END IF;

  -- Not yet captured. Ignore anything a caller put in the snapshot columns.
  NEW.invoice_customer_id_snapshot             := NULL;
  NEW.invoice_customer_name_snapshot           := NULL;
  NEW.invoice_customer_contact_person_snapshot := NULL;
  NEW.invoice_customer_address_snapshot        := NULL;
  NEW.invoice_customer_email_snapshot          := NULL;
  NEW.invoice_customer_phone_snapshot          := NULL;
  NEW.invoice_customer_tax_id_snapshot         := NULL;
  NEW.invoice_customer_snapshot_at             := NULL;
  NEW.invoice_customer_snapshot_source         := NULL;

  v_issued := NEW.invoice_journal_entry_id IS NOT NULL
           OR NULLIF(btrim(COALESCE(NEW.invoice_number, '')), '') IS NOT NULL;
  IF NOT v_issued THEN
    RETURN NEW;           -- unissued: no snapshot; readers use the live customer
  END IF;

  -- First issue: capture now, from the database, in this same statement.
  IF NEW.customer_id IS NOT NULL THEN
    SELECT id, name, contact_person, address, email, phone, kra_pin
      INTO c FROM customers WHERE id = NEW.customer_id;
    v_linked := FOUND;
  END IF;

  IF v_linked AND NULLIF(btrim(COALESCE(c.name, '')), '') IS NOT NULL THEN
    NEW.invoice_customer_id_snapshot             := c.id;
    NEW.invoice_customer_name_snapshot           := c.name;
    NEW.invoice_customer_contact_person_snapshot := c.contact_person;
    NEW.invoice_customer_address_snapshot        := c.address;
    NEW.invoice_customer_email_snapshot          := c.email;
    NEW.invoice_customer_phone_snapshot          := c.phone;
    NEW.invoice_customer_tax_id_snapshot         := c.kra_pin;
    NEW.invoice_customer_snapshot_source         := 'customer_at_issue';
  ELSE
    -- Walk-in / unlinked order: the only identity we hold is the order's own.
    NEW.invoice_customer_name_snapshot           := COALESCE(NULLIF(btrim(COALESCE(NEW.client, '')), ''), 'Unknown customer');
    NEW.invoice_customer_contact_person_snapshot := NEW.contact_person;
    NEW.invoice_customer_snapshot_source         := 'order_snapshot_at_issue';
  END IF;
  NEW.invoice_customer_snapshot_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_invoice_customer_snapshot ON public.orders;
CREATE TRIGGER trg_orders_invoice_customer_snapshot
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_invoice_customer_snapshot();

-- ── legacy backfill: documented fallback, never the current customer ────────
-- Rows already issued (invoice_number or journal present) with no snapshot.
SELECT set_config('app.invoice_snapshot_legacy', 'on', true);

UPDATE public.orders o
   SET invoice_customer_name_snapshot   = COALESCE(NULLIF(btrim(COALESCE(o.client, '')), ''), 'Unknown customer'),
       invoice_customer_snapshot_at     = COALESCE(o.invoice_issued_at, o.created_at),
       invoice_customer_snapshot_source = 'legacy_order_snapshot'
 WHERE o.invoice_customer_snapshot_at IS NULL
   AND (o.invoice_journal_entry_id IS NOT NULL
        OR NULLIF(btrim(COALESCE(o.invoice_number, '')), '') IS NOT NULL);

SELECT set_config('app.invoice_snapshot_legacy', 'off', true);

-- ── post-migration report ───────────────────────────────────────────────────
DO $$
DECLARE v_legacy integer; v_issued integer;
BEGIN
  SELECT count(*) INTO v_legacy FROM public.orders WHERE invoice_customer_snapshot_source = 'legacy_order_snapshot';
  SELECT count(*) INTO v_issued FROM public.orders
   WHERE invoice_journal_entry_id IS NOT NULL OR NULLIF(btrim(COALESCE(invoice_number,'')),'') IS NOT NULL;
  RAISE NOTICE 'invoice_customer_snapshot applied: % issued order(s), % marked legacy_order_snapshot', v_issued, v_legacy;
END $$;

COMMIT;
