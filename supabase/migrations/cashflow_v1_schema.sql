-- ============================================================================
-- Canvas Guy Tracker — Cashflow Stage 1: settings, schedules, obligations,
-- budgets, and purchase-to-BoQ links (seven tables)
--
-- Prerequisite: cashflow_v0_supplier_terms.sql, run and verified. This
-- migration does not touch suppliers.payment_terms_days or any
-- supplier_purchases due_date* column — requirement #10 below.
--
-- Table order (fixed, per the reviewed Stage 1 contract):
--   1. cashflow_settings
--   2. cashflow_setting_accounts
--   3. cashflow_manual_obligations
--   4. cashflow_schedules            (+ 4 partial unique indexes)
--   5. cashflow_schedule_installments
--   6. cashflow_budgets              (+ 2 partial unique indexes)
--   7. purchase_boq_links
--
-- WHAT THIS MIGRATION DOES NOT DO (by design, per the Stage 1 contract)
--   - No forecast tables, materialized views, or stored weekly projections.
--     Forecasts are computed on request by the Stage 2 engine, not persisted.
--   - No payment-writing RPC. Cashflow is planning/reporting only — it must
--     never create supplier payments, payroll payments, customer receipts,
--     or journal entries.
--   - No seeded obligation amounts. PAYE, NSSF and AHL remain
--     human-maintained estimates until payroll calculates them; SHA may be
--     derived from payroll later. Guessing a number here would be exactly
--     the kind of fabricated fact this project has been built to avoid.
--
-- SECURITY
--   All seven tables: RLS enabled, ALL revoked from PUBLIC/anon/authenticated,
--   ALL granted to service_role only. There are no CREATE POLICY statements
--   here on purpose — every read and write goes through the Next.js API
--   routes (service_role client), which enforce admin/head_of_sales roles
--   themselves. Production roles get no access in Phase 1: BoQ commitments
--   in purchase_boq_links expose supplier pricing.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS
-- throughout. Because the whole file runs inside one transaction, a failure
-- anywhere rolls back everything created in this run — "IF NOT EXISTS" only
-- matters for re-running this file after a prior COMPLETE success.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. cashflow_settings — singleton configuration row
--
--    cash_account_ids is deliberately NOT a column here. Which GL accounts
--    count as "available cash" belongs in the child table below
--    (cashflow_setting_accounts), one row per account, so each can carry its
--    own reconciliation state.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_settings (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key                    boolean NOT NULL DEFAULT true
                                     CHECK (singleton_key = true),

  horizon_weeks                    integer NOT NULL DEFAULT 13
                                     CHECK (horizon_weeks BETWEEN 1 AND 52),
  week_starts_on                   integer NOT NULL DEFAULT 1
                                     CHECK (week_starts_on = 1),

  default_supplier_terms_days      integer NOT NULL DEFAULT 30
                                     CHECK (default_supplier_terms_days BETWEEN 0 AND 365),
  cash_reserve_threshold           numeric(14,2) NOT NULL DEFAULT 250000
                                     CHECK (cash_reserve_threshold >= 0),

  override_stale_after_days        integer NOT NULL DEFAULT 30
                                     CHECK (override_stale_after_days BETWEEN 1 AND 365),
  schedule_review_stale_after_days integer NOT NULL DEFAULT 7
                                     CHECK (schedule_review_stale_after_days BETWEEN 1 AND 365),
  reconciliation_stale_after_days  integer NOT NULL DEFAULT 7
                                     CHECK (reconciliation_stale_after_days BETWEEN 1 AND 365),

  created_at                       timestamptz NOT NULL DEFAULT now(),
  created_by                       uuid REFERENCES auth.users(id),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  updated_by                       uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_settings_singleton UNIQUE (singleton_key)
);

COMMENT ON TABLE public.cashflow_settings IS
  'Singleton configuration for the Cashflow module. Exactly one row (enforced by the singleton_key UNIQUE constraint + CHECK singleton_key = true). Which GL accounts count as cash lives in cashflow_setting_accounts, not here.';


-- ────────────────────────────────────────────────────────────────────────────
-- 2. cashflow_setting_accounts — which GL accounts constitute available cash
--
--    A pool (account) is provisional when: it has never been reconciled; its
--    reconciliation is stale per cashflow_settings.reconciliation_stale_after_days;
--    or unresolved accounting_posting_errors affect it. That last check reads
--    from accounting_posting_errors at query time — it is not a column here.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_setting_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_id          uuid NOT NULL
                         REFERENCES public.cashflow_settings(id)
                         ON DELETE CASCADE,
  account_id           uuid NOT NULL
                         REFERENCES public.accounting_accounts(id)
                         ON DELETE RESTRICT,

  is_enabled           boolean NOT NULL DEFAULT true,

  last_reconciled_at   timestamptz,
  last_reconciled_by   uuid REFERENCES auth.users(id),
  reconciled_balance   numeric(14,2),

  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth.users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_setting_accounts_unique
    UNIQUE (settings_id, account_id),

  CONSTRAINT cashflow_reconciliation_complete CHECK (
    (last_reconciled_at IS NULL
      AND last_reconciled_by IS NULL
      AND reconciled_balance IS NULL)
    OR
    (last_reconciled_at IS NOT NULL
      AND last_reconciled_by IS NOT NULL
      AND reconciled_balance IS NOT NULL)
  )
);

COMMENT ON TABLE public.cashflow_setting_accounts IS
  'The GL accounts (accounting_accounts) that make up "available cash" for Cashflow. Seeded below from account codes 1000/1010/1020. last_reconciled_at/_by/reconciled_balance are all-or-nothing (cashflow_reconciliation_complete) — a half-recorded reconciliation is not a fact.';


-- ────────────────────────────────────────────────────────────────────────────
-- 3. cashflow_manual_obligations — recurring or one-off obligations not
--    reliably derived from another module (rent, statutory payments, etc.)
--
--    Recurring occurrences (e.g. every month's rent) are generated by the
--    Stage 2 forecast engine at read time — they are NOT materialized as rows
--    here. day_of_month beyond a given month's length resolves to that
--    month's last calendar day (e.g. day_of_month = 31 in February -> the 28th
--    or 29th), which the engine implements, not this table.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_manual_obligations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (btrim(name) <> ''),
  payee             text,
  category_id       uuid
                      REFERENCES public.accounting_categories(id)
                      ON DELETE SET NULL,

  amount            numeric(14,2) NOT NULL CHECK (amount > 0),
  is_statutory      boolean NOT NULL DEFAULT false,

  recurrence        text NOT NULL DEFAULT 'once'
                      CHECK (
                        recurrence IN ('once', 'monthly', 'quarterly', 'annual')
                      ),
  day_of_month      integer
                      CHECK (day_of_month BETWEEN 1 AND 31),
  first_due_date    date NOT NULL,
  ends_on           date,
  is_active         boolean NOT NULL DEFAULT true,

  default_priority  text NOT NULL DEFAULT 'important'
                      CHECK (
                        default_priority IN (
                          'must_pay',
                          'important',
                          'can_wait'
                        )
                      ),

  notes             text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES auth.users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_obligation_date_range CHECK (
    ends_on IS NULL OR ends_on >= first_due_date
  ),

  CONSTRAINT cashflow_obligation_recurrence_day CHECK (
    (recurrence = 'once' AND day_of_month IS NULL)
    OR
    (recurrence <> 'once' AND day_of_month IS NOT NULL)
  ),

  CONSTRAINT cashflow_statutory_priority CHECK (
    is_statutory = false OR default_priority = 'must_pay'
  )
);

COMMENT ON TABLE public.cashflow_manual_obligations IS
  'Recurring or one-off obligations not reliably derivable from another module (rent, statutory payments, subscriptions). No rows are seeded by this migration — every obligation here is a deliberate human entry, especially statutory ones (PAYE/NSSF/AHL), which stay human-maintained estimates until payroll calculates them.';


-- ────────────────────────────────────────────────────────────────────────────
-- 4. cashflow_schedules — planning metadata for exactly one source occurrence
--
--    A schedule attaches to exactly one of: a supplier purchase, a customer
--    order, a payroll run, or one occurrence of a manual obligation
--    (cashflow_schedules_one_source). obligation_occurrence_date is what makes
--    "one occurrence" concrete — holding October's rent must not hold every
--    future occurrence of the same obligation, so the pair
--    (obligation_id, obligation_occurrence_date) is what a schedule attaches
--    to, not the obligation alone (cashflow_schedule_occurrence_identity,
--    cashflow_schedule_one_per_occurrence below).
--
--    When a schedule has installments (cashflow_schedule_installments), the
--    forecast engine uses the installment dates/amounts and does NOT also
--    treat this row's planned_amount as a further, separate outflow.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_schedules (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  supplier_purchase_id       uuid
                               REFERENCES public.supplier_purchases(id)
                               ON DELETE CASCADE,
  order_id                   uuid
                               REFERENCES public.orders(id)
                               ON DELETE CASCADE,
  payroll_run_id             uuid
                               REFERENCES public.payroll_runs(id)
                               ON DELETE CASCADE,
  obligation_id              uuid
                               REFERENCES public.cashflow_manual_obligations(id)
                               ON DELETE CASCADE,

  obligation_occurrence_date date,

  planned_date               date NOT NULL,
  planned_amount             numeric(14,2)
                               CHECK (planned_amount IS NULL OR planned_amount >= 0),
  minimum_amount              numeric(14,2)
                               CHECK (minimum_amount IS NULL OR minimum_amount >= 0),

  priority                   text NOT NULL DEFAULT 'important'
                               CHECK (
                                 priority IN (
                                   'must_pay',
                                   'important',
                                   'can_wait',
                                   'on_hold'
                                 )
                               ),

  confidence_override        text
                               CHECK (
                                 confidence_override IS NULL
                                 OR confidence_override IN (
                                   'confirmed',
                                   'likely',
                                   'uncertain'
                                 )
                               ),

  hold_reason                text,
  notes                      text,

  budget_category_id         uuid
                               REFERENCES public.accounting_categories(id)
                               ON DELETE SET NULL,

  last_reviewed_at           timestamptz,
  last_reviewed_by           uuid REFERENCES auth.users(id),

  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid REFERENCES auth.users(id),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_schedules_one_source CHECK (
      (supplier_purchase_id IS NOT NULL)::integer
    + (order_id             IS NOT NULL)::integer
    + (payroll_run_id       IS NOT NULL)::integer
    + (obligation_id        IS NOT NULL)::integer
    = 1
  ),

  CONSTRAINT cashflow_schedule_occurrence_identity CHECK (
    (
      obligation_id IS NOT NULL
      AND obligation_occurrence_date IS NOT NULL
    )
    OR
    (
      obligation_id IS NULL
      AND obligation_occurrence_date IS NULL
    )
  ),

  CONSTRAINT cashflow_schedule_hold_reason CHECK (
    priority <> 'on_hold'
    OR btrim(COALESCE(hold_reason, '')) <> ''
  ),

  CONSTRAINT cashflow_schedule_minimum_amount CHECK (
    minimum_amount IS NULL
    OR planned_amount IS NULL
    OR minimum_amount <= planned_amount
  )
);

COMMENT ON TABLE public.cashflow_schedules IS
  'Planning metadata for exactly one source occurrence (cashflow_schedules_one_source): a supplier purchase, a customer order, a payroll run, or one dated occurrence of a manual obligation. Not a ledger of actual payments — those stay in their own modules.';

-- Four schedule partial unique indexes — these replace a single nullable-
-- column UNIQUE constraint, which would not reliably prevent duplicate
-- schedules across the four mutually-exclusive source columns.

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_schedule_one_per_purchase
  ON public.cashflow_schedules (supplier_purchase_id)
  WHERE supplier_purchase_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_schedule_one_per_order
  ON public.cashflow_schedules (order_id)
  WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_schedule_one_per_run
  ON public.cashflow_schedules (payroll_run_id)
  WHERE payroll_run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_schedule_one_per_occurrence
  ON public.cashflow_schedules (
    obligation_id,
    obligation_occurrence_date
  )
  WHERE obligation_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- 5. cashflow_schedule_installments — splits one schedule into partial
--    planned payments or receipts
--
--    status here is a PLANNING state (planned/cancelled), never a payment
--    state — actual payment status is derived from the source module
--    (supplier_purchases, payroll, order_payments) at read time. The API
--    (Stage 3) must prevent the sum of active installments from exceeding
--    the source's outstanding amount; anything not covered by active
--    installments stays visibly "Unplanned" rather than assumed paid or
--    assumed absent.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_schedule_installments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        uuid NOT NULL
                       REFERENCES public.cashflow_schedules(id)
                       ON DELETE CASCADE,

  installment_number integer NOT NULL CHECK (installment_number > 0),
  planned_date       date NOT NULL,
  planned_amount     numeric(14,2) NOT NULL CHECK (planned_amount > 0),

  status             text NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'cancelled')),
  notes              text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES auth.users(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_installment_sequence_unique
    UNIQUE (schedule_id, installment_number)
);

COMMENT ON TABLE public.cashflow_schedule_installments IS
  'Partial planned payments/receipts under one schedule. status is a planning state only (planned/cancelled) — Cashflow never marks a supplier, payroll or customer transaction as paid; that fact lives in its own module.';


-- ────────────────────────────────────────────────────────────────────────────
-- 6. cashflow_budgets — general overhead and order-specific budgets
--
--    current_budget = original_amount + approved_adjustments is DERIVED, not
--    stored, so it can never drift out of sync with its inputs. The fuller
--    budget vocabulary (Original, Approved adjustments, Current, Committed,
--    Incurred, Paid, Available) is computed by the Stage 3 API from this
--    table plus other modules — "Incurred" is not the same thing as "Paid".
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cashflow_budgets (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id              uuid NOT NULL
                             REFERENCES public.accounting_categories(id)
                             ON DELETE RESTRICT,

  period_month             date NOT NULL,
  order_id                 uuid
                             REFERENCES public.orders(id)
                             ON DELETE CASCADE,

  original_amount          numeric(14,2) NOT NULL DEFAULT 0
                             CHECK (original_amount >= 0),
  approved_adjustments     numeric(14,2) NOT NULL DEFAULT 0,

  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES auth.users(id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES auth.users(id),

  CONSTRAINT cashflow_budget_month_start CHECK (
    period_month = date_trunc('month', period_month)::date
  ),

  CONSTRAINT cashflow_budget_current_nonnegative CHECK (
    original_amount + approved_adjustments >= 0
  )
);

COMMENT ON TABLE public.cashflow_budgets IS
  'General overhead budgets (order_id IS NULL) and order-specific budgets (order_id IS NOT NULL), one row per category per month per (optional) order. current_budget = original_amount + approved_adjustments is computed by the API, never stored as a column.';

-- Two budget partial unique indexes — together with the four schedule
-- indexes above, these are the six required partial unique indexes for
-- Stage 1. purchase_boq_links_unique and cashflow_setting_accounts_unique
-- and cashflow_installment_sequence_unique are ordinary (non-partial)
-- UNIQUE constraints and are not counted among these six.

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_budgets_general
  ON public.cashflow_budgets (category_id, period_month)
  WHERE order_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cashflow_budgets_per_order
  ON public.cashflow_budgets (
    category_id,
    period_month,
    order_id
  )
  WHERE order_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- 7. purchase_boq_links — explicitly nets real purchases against specific
--    production BoQ commitments
--
--    Manual allocation only, Phase 1: never infer links using job, supplier
--    or description matching (the Cashflow module's non-negotiable rule #6).
--    A purchase may satisfy several BoQ lines; a BoQ line may be fulfilled by
--    several purchases. The API (Stage 3/5) must enforce that the sum
--    allocated to BoQ lines never exceeds the purchase total, and that
--    amount_fulfilled never silently exceeds the relevant BoQ commitment.
--    Until links exist for a job, Cashflow shows gross committed BoQ with an
--    overlap warning rather than a false netted number. Draft production
--    plans stay excluded from official committed totals and may appear
--    separately as "Pipeline estimate".
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.purchase_boq_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id           uuid NOT NULL
                          REFERENCES public.supplier_purchases(id)
                          ON DELETE CASCADE,
  material_estimate_id  uuid NOT NULL
                          REFERENCES public.production_material_estimates(id)
                          ON DELETE RESTRICT,

  amount_fulfilled      numeric(14,2) NOT NULL
                          CHECK (amount_fulfilled > 0),

  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES auth.users(id),

  CONSTRAINT purchase_boq_links_unique
    UNIQUE (purchase_id, material_estimate_id)
);

COMMENT ON TABLE public.purchase_boq_links IS
  'Manual allocation of a supplier purchase against a production BoQ line (production_material_estimates). Never inferred by name/supplier/job matching — every row here is a deliberate human link. Sum-vs-purchase-total and sum-vs-BoQ-commitment limits are enforced in the API, not by a table constraint, since both depend on data outside this table.';


-- ────────────────────────────────────────────────────────────────────────────
-- 8. Security — identical treatment for all seven tables
--
--    RLS enabled with zero policies, ALL revoked from PUBLIC/anon/authenticated,
--    ALL granted to service_role. This means no role except service_role
--    (used exclusively by the Next.js API routes) can read or write these
--    tables at all — not "read but not write", not "read own rows only".
--    Authorization (admin/head_of_sales read, admin write, no production
--    access) is enforced in the API routes themselves, in Stage 3.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cashflow_settings',
    'cashflow_setting_accounts',
    'cashflow_manual_obligations',
    'cashflow_schedules',
    'cashflow_schedule_installments',
    'cashflow_budgets',
    'purchase_boq_links'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9. Seed the settings singleton
--
--    ON CONFLICT on the singleton_key UNIQUE constraint makes this safe to
--    re-run: exactly one row, ever, all defaults from the table definition
--    above (13-week horizon, Monday-start weeks, 30-day default supplier
--    terms, etc.) — nothing here overrides those defaults with a guess.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.cashflow_settings (singleton_key)
VALUES (true)
ON CONFLICT (singleton_key) DO NOTHING;


-- ────────────────────────────────────────────────────────────────────────────
-- 10. Seed configured cash accounts (codes 1000, 1010, 1020)
--
--     Resolves each code to its accounting_accounts.id at migration time —
--     nothing is hardcoded, so this stays correct even if those UUIDs differ
--     across environments. A missing code is FATAL: Cashflow cannot safely
--     launch with an incomplete cash pool, and a WARNING-and-skip would let
--     this migration succeed while silently excluding Cash, M-Pesa, or Bank
--     from opening cash. All three codes are confirmed present in this
--     database, so this is a fail-closed guard against staging environments,
--     restored databases, or future installations that might not have them —
--     not an expected path here.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_settings_id uuid;
  v_account_id  uuid;
  v_code        text;
BEGIN
  SELECT id INTO v_settings_id FROM public.cashflow_settings WHERE singleton_key = true LIMIT 1;

  IF v_settings_id IS NULL THEN
    RAISE EXCEPTION 'cashflow_settings singleton row not found — step 9 above must run first';
  END IF;

  FOREACH v_code IN ARRAY ARRAY['1000', '1010', '1020'] LOOP
    SELECT id INTO v_account_id FROM public.accounting_accounts WHERE code = v_code LIMIT 1;

    IF v_account_id IS NULL THEN
      RAISE EXCEPTION
        'Required cash account accounting_accounts.code = % was not found. Cashflow schema installation aborted.',
        v_code;
    END IF;

    INSERT INTO public.cashflow_setting_accounts (settings_id, account_id)
    VALUES (v_settings_id, v_account_id)
    ON CONFLICT (settings_id, account_id) DO NOTHING;
  END LOOP;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 11. Post-migration diagnostic report
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_settings_rows     integer;
  v_cash_accounts     integer;
  v_schedules         integer;
  v_obligations       integer;
  v_budgets           integer;
  v_boq_links         integer;
BEGIN
  SELECT count(*) INTO v_settings_rows FROM public.cashflow_settings;
  SELECT count(*) INTO v_cash_accounts FROM public.cashflow_setting_accounts;
  SELECT count(*) INTO v_schedules     FROM public.cashflow_schedules;
  SELECT count(*) INTO v_obligations   FROM public.cashflow_manual_obligations;
  SELECT count(*) INTO v_budgets       FROM public.cashflow_budgets;
  SELECT count(*) INTO v_boq_links     FROM public.purchase_boq_links;

  RAISE NOTICE '─────────────────────────────────────────────────────────';
  RAISE NOTICE 'cashflow_v1_schema applied.';
  RAISE NOTICE '  cashflow_settings rows          : % (must be 1)', v_settings_rows;
  RAISE NOTICE '  cashflow_setting_accounts rows  : % (must be exactly 3: codes 1000/1010/1020)', v_cash_accounts;
  RAISE NOTICE '  cashflow_schedules rows         : %', v_schedules;
  RAISE NOTICE '  cashflow_manual_obligations rows: % (0 expected — none seeded)', v_obligations;
  RAISE NOTICE '  cashflow_budgets rows           : %', v_budgets;
  RAISE NOTICE '  purchase_boq_links rows         : %', v_boq_links;
  RAISE NOTICE '';
  RAISE NOTICE '  No forecast tables, materialized views or payment-writing';
  RAISE NOTICE '  RPCs were created. Stage 0 supplier-terms columns were not';
  RAISE NOTICE '  touched. Stage 2 (the forecast engine) can now begin.';
  RAISE NOTICE '─────────────────────────────────────────────────────────';
END $$;

COMMIT;
