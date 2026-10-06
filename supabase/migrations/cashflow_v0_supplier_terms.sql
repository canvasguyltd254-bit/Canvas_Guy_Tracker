-- ============================================================================
-- Canvas Guy Tracker — Cashflow Stage 0: supplier credit terms + purchase due dates
--
-- Prerequisite for cashflow_v1_schema.sql. Run and verify this FIRST.
-- Do not proceed to Stage 1 until this is verified.
--
-- REV 3: adds due_date_terms_days (snapshot) and a request-mode marker
-- consumed by the trigger (P0 fixes from the second review).
--
-- REV 2 added due_date_source but that alone is not enough: it records
-- THAT a date came from supplier terms, not WHICH terms. If a supplier's
-- payment_terms_days changes after a purchase was made, re-labelling that
-- purchase using describeDueDateSource(source, supplier.payment_terms_days)
-- — the CURRENT terms — silently rewrites history ("Supplier terms · 30
-- days" becomes "Supplier terms · 60 days" on an old, untouched row).
-- due_date_terms_days snapshots the terms actually used, at write time, so
-- the label never has to ask the supplier what today's terms are.
--
-- REV 2 also had a second, sharper bug: on INSERT, "unrecorded" was not
-- actually a mode the trigger could see. The trigger always derived a date
-- from supplier terms whenever due_date arrived NULL — whether the caller
-- had asked for that or explicitly asked for "unrecorded". PATCH, which
-- sets due_date_source itself, DID honour "unrecorded" literally. Same UI
-- choice, two different outcomes depending on whether the purchase was new
-- or existing. Fixed here with due_date_request_mode: an internal,
-- non-whitelisted column that only route code (never client JSON) can set,
-- which the trigger reads to know a caller explicitly asked for supplier
-- terms, and clears before the row is written — see CHECK constraint below.
--
-- WHY THIS IS A SEPARATE MIGRATION
--   It alters two tables the Suppliers module writes to in production
--   (suppliers, supplier_purchases). Keeping it apart from the seven new
--   cashflow tables means a failure here leaves nothing cashflow-related
--   half-created, and this migration can be verified on its own before the
--   module schema is built on top of it.
--
-- WHAT IT DOES
--   1. suppliers.payment_terms_days        — nullable credit terms, 0–365
--   2. supplier_purchases.due_date              — nullable, >= purchase_date
--      supplier_purchases.due_date_source       — nullable, 'explicit' | 'supplier_terms'
--      supplier_purchases.due_date_terms_days   — nullable, the terms SNAPSHOT
--                                                  used when source = 'supplier_terms'
--      supplier_purchases.due_date_request_mode — internal, always NULL at rest;
--                                                  a same-transaction signal from
--                                                  route code to the trigger only
--   3. BEFORE INSERT trigger resolving due_date + due_date_source + the snapshot:
--        a. explicit due_date supplied           -> keep it, source = 'explicit'
--        b. due_date_request_mode = 'supplier_terms' and supplier has terms
--                                                 -> purchase_date + terms,
--                                                    source = 'supplier_terms',
--                                                    due_date_terms_days = terms used
--        c. otherwise (including "supplier has terms but mode wasn't requested")
--                                                 -> due_date, source, snapshot all NULL
--   4. Index on due_date for the forecast query
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   No backfill. Historical purchases keep due_date and due_date_source =
--   NULL. A backfilled guess would launder an assumption into a stored fact,
--   and the Cashflow UI could no longer tell the difference between a real
--   supplier term and a number this migration made up. NULL is what makes
--   the Payments Plan render "Assumed by Cashflow" instead of a confident date.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. suppliers.payment_terms_days
--
--    NULL  = no terms recorded for this supplier. Cashflow applies
--            cashflow_settings.default_supplier_terms_days and labels the
--            resulting date "Assumed by Cashflow".
--    0     = cash on delivery. A real, recorded answer — NOT the same as NULL.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS payment_terms_days integer;

COMMENT ON COLUMN public.suppliers.payment_terms_days IS
  'Credit terms in days. NULL = not recorded (Cashflow assumes a default and labels it as assumed). 0 = cash on delivery, a recorded answer.';

-- Range guard. 365 is generous but catches the common typos (a date typed
-- into a days field, a negative, a stray extra digit).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'suppliers_payment_terms_days_range'
      AND conrelid = 'public.suppliers'::regclass
  ) THEN
    ALTER TABLE public.suppliers
      ADD CONSTRAINT suppliers_payment_terms_days_range
      CHECK (payment_terms_days IS NULL
             OR (payment_terms_days >= 0 AND payment_terms_days <= 365));
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 2. supplier_purchases.due_date + due_date_source + due_date_terms_days
--    + due_date_request_mode
--
--    due_date               The date this purchase must be paid. Explicit
--                            user entry, or derived from supplier terms by
--                            the trigger below. NULL means neither was
--                            available — Cashflow shows "Assumed by Cashflow".
--
--    due_date_source        WHY due_date has the value it has. Recorded once,
--                            at write time, and never re-derived by comparing
--                            against the supplier's current terms (terms can
--                            change later; the source of a past decision
--                            cannot).
--                              'explicit'       — a person typed this date in.
--                              'supplier_terms' — computed from the supplier's
--                                                 terms as they stood at the time.
--                              NULL             — neither exists; due_date NULL too.
--
--    due_date_terms_days    WHICH terms were used, when due_date_source =
--                            'supplier_terms'. Without this, the UI's only
--                            option is to show the SUPPLIER'S CURRENT terms
--                            next to an old date — which is wrong the moment
--                            the supplier's terms change. This is a snapshot,
--                            frozen at write time, exactly like due_date_source
--                            itself. NULL whenever due_date_source is not
--                            'supplier_terms'.
--
--    due_date_request_mode  NOT a fact about the purchase — an internal,
--                            same-transaction signal from route code to the
--                            BEFORE INSERT trigger, so it can tell "derive
--                            from supplier terms" apart from "leave
--                            unrecorded" when due_date arrives NULL either
--                            way. Deliberately excluded from
--                            shared/lib/whitelist.js: only route code sets
--                            it, on the insert payload it builds itself,
--                            never from a client JSON body. The trigger
--                            clears it before the row is written, and a CHECK
--                            constraint enforces that no row can ever persist
--                            with it non-NULL — a bug in the trigger fails
--                            the insert loudly instead of leaking the marker
--                            into stored data.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.supplier_purchases
  ADD COLUMN IF NOT EXISTS due_date               date,
  ADD COLUMN IF NOT EXISTS due_date_source        text,
  ADD COLUMN IF NOT EXISTS due_date_terms_days    integer,
  ADD COLUMN IF NOT EXISTS due_date_request_mode  text;

COMMENT ON COLUMN public.supplier_purchases.due_date IS
  'Payment due date. Explicit user entry, else derived at INSERT from suppliers.payment_terms_days. NULL = no basis to derive one; Cashflow applies the settings default and marks the row as assumed.';

COMMENT ON COLUMN public.supplier_purchases.due_date_source IS
  'Why due_date has its value: explicit (typed in) or supplier_terms (derived from the supplier''s terms at write time). Recorded once, never re-derived — comparing against the supplier''s CURRENT terms is unsafe because terms can change after the purchase was made.';

COMMENT ON COLUMN public.supplier_purchases.due_date_terms_days IS
  'Snapshot of the credit-terms days actually used to derive due_date, recorded only when due_date_source = supplier_terms. Never re-read from suppliers.payment_terms_days after the fact — that value can change and would silently relabel old purchases.';

COMMENT ON COLUMN public.supplier_purchases.due_date_request_mode IS
  'Internal signal from route code to the BEFORE INSERT trigger only (''supplier_terms'' or NULL). Never set from client input, never a fact about the purchase, always NULL once the row exists — see the CHECK constraint below.';

-- due_date_source vocabulary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_date_source_valid'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases DROP CONSTRAINT supplier_purchases_due_date_source_valid;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_date_source_consistency'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases DROP CONSTRAINT supplier_purchases_due_date_source_consistency;
  END IF;
END $$;

-- The combined provenance constraint. This is what actually protects both
-- P0 fixes: it makes "a date with no recorded reason", "a reason with no
-- date", and "a supplier_terms source with no snapshot of which terms" all
-- impossible at the schema level — not just something every write path has
-- to remember to get right.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_date_provenance_valid'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases
      ADD CONSTRAINT supplier_purchases_due_date_provenance_valid
      CHECK (
        (due_date IS NULL     AND due_date_source IS NULL       AND due_date_terms_days IS NULL)
        OR (due_date IS NOT NULL AND due_date_source = 'explicit'       AND due_date_terms_days IS NULL)
        OR (due_date IS NOT NULL AND due_date_source = 'supplier_terms' AND due_date_terms_days IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_date_terms_days_range'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases
      ADD CONSTRAINT supplier_purchases_due_date_terms_days_range
      CHECK (due_date_terms_days IS NULL
             OR (due_date_terms_days >= 0 AND due_date_terms_days <= 365));
  END IF;
END $$;

-- The marker must never be observable at rest — only mid-transaction, by the
-- trigger. If a future edit to the trigger forgets to clear it, this turns
-- that bug into a failed insert instead of a silently persisted marker.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_date_request_mode_cleared'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases
      ADD CONSTRAINT supplier_purchases_due_date_request_mode_cleared
      CHECK (due_date_request_mode IS NULL);
  END IF;
END $$;

-- A due date before the purchase date is not a credit term, it is a typo.
-- All existing rows are NULL so this validates trivially on an existing table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_purchases_due_after_purchase'
      AND conrelid = 'public.supplier_purchases'::regclass
  ) THEN
    ALTER TABLE public.supplier_purchases
      ADD CONSTRAINT supplier_purchases_due_after_purchase
      CHECK (due_date IS NULL OR due_date >= purchase_date);
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Due-date resolution trigger
--
--    Resolution order, highest priority first:
--      a. NEW.due_date IS NOT NULL         -> the user typed this in.
--                                              source = 'explicit'. Never
--                                              overridden, regardless of
--                                              due_date_request_mode.
--      b. due_date_request_mode =
--         'supplier_terms'                 -> purchase_date + the supplier's
--                                              CURRENT terms. source =
--                                              'supplier_terms', and those
--                                              terms are snapshotted into
--                                              due_date_terms_days so a later
--                                              change to the supplier's terms
--                                              can never relabel this row.
--                                              Supplier has no terms recorded
--                                              at insert time -> RAISE
--                                              EXCEPTION rather than silently
--                                              falling through to (c); the API
--                                              routes validate this before
--                                              INSERT, so reaching here means
--                                              a race or a caller that bypassed
--                                              the API.
--      c. neither                          -> due_date, due_date_source and
--                                              due_date_terms_days all NULL.
--                                              This is also what happens when
--                                              the supplier DOES have terms
--                                              but due_date_request_mode was
--                                              not set to 'supplier_terms' —
--                                              "unrecorded" must mean
--                                              unrecorded, not "derive
--                                              whenever possible", so this
--                                              route behaves identically to
--                                              the PATCH route's "unrecorded"
--                                              mode.
--
--    due_date_request_mode is cleared to NULL on every path before RETURN,
--    on top of the CHECK constraint that forbids it from persisting non-NULL
--    at all — belt and suspenders against the marker ever leaking into
--    stored data.
--
--    BEFORE INSERT only, on purpose. Changing a supplier's terms later must
--    not silently rewrite the due date (or its source, or its snapshot) on
--    purchases already agreed under the old terms — those dates are a record
--    of an agreement, not a derived view. Editing a purchase's due date after
--    creation is an explicit user action through the API (which sets
--    due_date_source and due_date_terms_days itself, since this trigger does
--    not fire on UPDATE).
--
--    SECURITY DEFINER + fixed search_path to match repo convention and so the
--    suppliers lookup is not affected by the caller's RLS context.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_purchase_due_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terms integer;
BEGIN
  -- (a) Explicit value wins. The fact that a date arrived on the INSERT at
  --     all is itself the record of provenance — a caller with no date to
  --     give leaves the column unset and lets (b)/(c) run instead.
  IF NEW.due_date IS NOT NULL THEN
    NEW.due_date_source       := 'explicit';
    NEW.due_date_terms_days   := NULL;
    NEW.due_date_request_mode := NULL;
    RETURN NEW;
  END IF;

  -- (b) Caller explicitly asked for supplier-terms derivation. This is the
  --     ONLY path that derives a date — a caller that leaves the marker
  --     unset gets due_date left NULL even if the supplier happens to have
  --     terms recorded, exactly matching what "unrecorded" means on PATCH.
  IF NEW.due_date_request_mode = 'supplier_terms' THEN
    SELECT s.payment_terms_days
      INTO v_terms
      FROM public.suppliers s
     WHERE s.id = NEW.supplier_id;

    IF v_terms IS NULL THEN
      RAISE EXCEPTION
        'due_date_request_mode = supplier_terms but supplier % has no recorded payment_terms_days',
        NEW.supplier_id;
    END IF;

    NEW.due_date               := NEW.purchase_date + v_terms;
    NEW.due_date_source        := 'supplier_terms';
    NEW.due_date_terms_days    := v_terms;
    NEW.due_date_request_mode  := NULL;
    RETURN NEW;
  END IF;

  -- (c) No explicit date, no supplier-terms request. Leave everything NULL
  --     so Cashflow labels it assumed rather than presenting a fabricated
  --     date, or a reason, or a terms count, as if any of it were fact.
  NEW.due_date_source       := NULL;
  NEW.due_date_terms_days   := NULL;
  NEW.due_date_request_mode := NULL;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.resolve_purchase_due_date() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_resolve_purchase_due_date ON public.supplier_purchases;
CREATE TRIGGER trg_resolve_purchase_due_date
  BEFORE INSERT ON public.supplier_purchases
  FOR EACH ROW
  EXECUTE FUNCTION public.resolve_purchase_due_date();


-- ────────────────────────────────────────────────────────────────────────────
-- 4. Index
--
--    The forecast scans unpaid purchases by due date across a 13-week window.
--    Partial: fully paid purchases never appear in a cashflow projection.
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_supplier_purchases_due_date
  ON public.supplier_purchases (due_date)
  WHERE due_date IS NOT NULL AND payment_status <> 'Paid';


-- ────────────────────────────────────────────────────────────────────────────
-- 5. Post-migration report
--
--    Reports how much of the supplier book has real terms, AND — now that
--    provenance is tracked — the split between explicit and derived dates
--    among open purchases. Anything close to 0% termed suppliers means the
--    Payments Plan will launch showing "Assumed by Cashflow" on almost every
--    row — worth knowing before Stage 1, not after.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_suppliers_total   integer;
  v_suppliers_termed  integer;
  v_purchases_open    integer;
  v_purchases_dated   integer;
  v_purchases_explicit integer;
  v_purchases_terms    integer;
BEGIN
  SELECT count(*), count(payment_terms_days)
    INTO v_suppliers_total, v_suppliers_termed
    FROM public.suppliers;

  SELECT count(*), count(due_date)
    INTO v_purchases_open, v_purchases_dated
    FROM public.supplier_purchases
   WHERE payment_status <> 'Paid';

  SELECT
      count(*) FILTER (WHERE due_date_source = 'explicit'),
      count(*) FILTER (WHERE due_date_source = 'supplier_terms')
    INTO v_purchases_explicit, v_purchases_terms
    FROM public.supplier_purchases
   WHERE payment_status <> 'Paid';

  RAISE NOTICE '─────────────────────────────────────────────────────────';
  RAISE NOTICE 'cashflow_v0_supplier_terms applied.';
  RAISE NOTICE '  Suppliers with recorded terms  : % of %', v_suppliers_termed, v_suppliers_total;
  RAISE NOTICE '  Open purchases with a due date  : % of %', v_purchases_dated, v_purchases_open;
  RAISE NOTICE '    ├─ explicit                   : %', v_purchases_explicit;
  RAISE NOTICE '    └─ supplier_terms              : %', v_purchases_terms;
  RAISE NOTICE '';
  RAISE NOTICE '  Historical purchases were NOT backfilled — by design.';
  RAISE NOTICE '  Record terms on your suppliers before relying on the';
  RAISE NOTICE '  Payments Plan, or every row will read as assumed.';
  RAISE NOTICE '─────────────────────────────────────────────────────────';
END $$;

COMMIT;
