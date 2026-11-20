-- ============================================================================
-- Canvas Guy Tracker — Temporary workers, Stage 1 (spec: docs/specs/temporary-workers.md v2.1)
--
-- Cash-paid temporary labour, settled after approved Production attendance.
-- Reuses the Production time-entry ledger as the single source of actual labour;
-- a settlement only decides what is payable and what was paid. No GL posting.
--
-- Safety properties enforced IN THE DATABASE (not only in the API):
--   * one attendance day can never be paid twice (partial unique index on active lines)
--   * PAID IS FINAL: a paid settlement, its lines and its deductions can never change,
--     and an entry in an active settlement can never be voided
--   * fail-closed approval limit (NULL / missing = admin only); sheet total and rolling
--     7-day split-payment protection
--   * approver != preparer and != every attendance recorder (admin override needs a reason)
--   * payer != preparer; payment needs payout sheet, signed receipt, receiver full name
--   * statutory deduction types are impossible; operational deductions are itemised
--   * status-consistency CHECKs and legal-transition triggers
--
-- All tables and functions are service_role only. Safe to re-run.
-- Requires: payroll_module.sql, production_v3a_labour_costing.sql, production_v3b_time_entry_day_lock.sql
-- ============================================================================

BEGIN;

-- ── Settings (single row) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_settings (
  id                         boolean PRIMARY KEY DEFAULT true CHECK (id),
  settlement_threshold_units numeric(5,2)  NOT NULL DEFAULT 3.00 CHECK (settlement_threshold_units > 0),
  admin_approval_limit_kes   numeric(12,2) DEFAULT 10000 CHECK (admin_approval_limit_kes IS NULL OR admin_approval_limit_kes >= 0),  -- NULL = fail-closed (admin only)
  rolling_window_days        integer       NOT NULL DEFAULT 7 CHECK (rolling_window_days >= 0),
  deduction_single_limit_kes numeric(12,2) NOT NULL DEFAULT 1000 CHECK (deduction_single_limit_kes >= 0),
  deduction_total_pct        numeric(5,2)  NOT NULL DEFAULT 25 CHECK (deduction_total_pct >= 0 AND deduction_total_pct <= 100),
  damage_deductions_enabled  boolean       NOT NULL DEFAULT true,
  updated_by                 uuid,
  updated_at                 timestamptz   NOT NULL DEFAULT now()
);
INSERT INTO public.temporary_worker_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS public.tw_engagement_seq;
CREATE SEQUENCE IF NOT EXISTS public.tw_settlement_seq;
CREATE SEQUENCE IF NOT EXISTS public.tw_sheet_seq;

-- ── Engagements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_engagements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_num      text NOT NULL UNIQUE DEFAULT ('TE-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.tw_engagement_seq')::text, 4, '0')),
  employee_id         uuid NOT NULL REFERENCES public.employees(id),
  order_id            uuid NOT NULL REFERENCES public.orders(id),
  agreed_daily_rate   numeric(10,2) NOT NULL CHECK (agreed_daily_rate > 0),
  start_date          date NOT NULL,
  expected_end_date   date,
  max_days            numeric(6,2) CHECK (max_days IS NULL OR max_days > 0),
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id       uuid REFERENCES public.temporary_worker_engagements(id),
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_by           uuid,
  closed_at           timestamptz,
  close_reason        text,
  CONSTRAINT twe_dates CHECK (expected_end_date IS NULL OR expected_end_date >= start_date),
  CONSTRAINT twe_status_fields CHECK (
    CASE WHEN status IN ('completed','cancelled')
         THEN closed_by IS NOT NULL AND closed_at IS NOT NULL AND NULLIF(btrim(COALESCE(close_reason,'')), '') IS NOT NULL
         ELSE closed_by IS NULL AND closed_at IS NULL AND close_reason IS NULL END)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_twe_active_per_worker_order
  ON public.temporary_worker_engagements (employee_id, order_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_twe_employee ON public.temporary_worker_engagements (employee_id);

ALTER TABLE public.production_job_assignments
  ADD COLUMN IF NOT EXISTS temporary_engagement_id uuid REFERENCES public.temporary_worker_engagements(id);
CREATE INDEX IF NOT EXISTS idx_pja_temp_engagement ON public.production_job_assignments (temporary_engagement_id)
  WHERE temporary_engagement_id IS NOT NULL;

-- ── Payout sheets (before settlements, which reference them) ────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_payout_sheets (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_num                   text NOT NULL UNIQUE DEFAULT ('PS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.tw_sheet_seq')::text, 4, '0')),
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','printed','signed','cancelled')),
  total_gross                 numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_gross >= 0),
  total_deductions            numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_deductions >= 0),
  total_net                   numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_net >= 0),
  admin_approved_by           uuid,
  admin_approved_at           timestamptz,
  printed_at                  timestamptz,
  signed_receipt_path         text,
  signed_receipt_uploaded_by  uuid,
  signed_receipt_uploaded_at  timestamptz,
  cancelled_by                uuid,
  cancelled_at                timestamptz,
  cancel_reason               text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tws_sheet_totals CHECK (total_net = total_gross - total_deductions),
  CONSTRAINT tws_sheet_admin_pair CHECK ((admin_approved_by IS NULL) = (admin_approved_at IS NULL)),
  CONSTRAINT tws_sheet_status_fields CHECK (
    CASE status
      WHEN 'open'      THEN printed_at IS NULL AND signed_receipt_path IS NULL AND signed_receipt_uploaded_by IS NULL
                            AND signed_receipt_uploaded_at IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'printed'   THEN printed_at IS NOT NULL AND signed_receipt_path IS NULL AND signed_receipt_uploaded_by IS NULL
                            AND signed_receipt_uploaded_at IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'signed'    THEN printed_at IS NOT NULL AND NULLIF(btrim(COALESCE(signed_receipt_path,'')), '') IS NOT NULL
                            AND signed_receipt_uploaded_by IS NOT NULL AND signed_receipt_uploaded_at IS NOT NULL
                            AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND NULLIF(btrim(COALESCE(cancel_reason,'')), '') IS NOT NULL
                            AND signed_receipt_path IS NULL     -- evidence path is copied to the audit log on cancel; a cancelled sheet can never be "signed"
    END)
);

-- ── Settlements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_settlements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_num         text NOT NULL UNIQUE DEFAULT ('TW-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.tw_settlement_seq')::text, 4, '0')),
  engagement_id          uuid NOT NULL REFERENCES public.temporary_worker_engagements(id),
  employee_id            uuid NOT NULL REFERENCES public.employees(id),
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  cutoff_date            date NOT NULL,
  units_included         numeric(6,2) NOT NULL CHECK (units_included > 0),
  base_amount            numeric(12,2) NOT NULL CHECK (base_amount >= 0),
  overtime_amount        numeric(12,2) NOT NULL CHECK (overtime_amount >= 0),
  sunday_amount          numeric(12,2) NOT NULL CHECK (sunday_amount >= 0),
  gross_amount           numeric(12,2) NOT NULL CHECK (gross_amount > 0),
  deductions_total       numeric(12,2) NOT NULL DEFAULT 0 CHECK (deductions_total >= 0),
  net_amount             numeric(12,2) NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('threshold','close_out','early')),
  reason                 text,
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','voided')),
  prepared_by            uuid NOT NULL,
  prepared_at            timestamptz NOT NULL DEFAULT now(),
  approved_by            uuid,
  approved_at            timestamptz,
  approved_by_role       text CHECK (approved_by_role IS NULL OR approved_by_role IN ('admin','production_manager','head_of_sales')),
  approval_override      boolean NOT NULL DEFAULT false,
  override_reason        text,
  payout_sheet_id        uuid REFERENCES public.temporary_worker_payout_sheets(id),
  paid_by                uuid,
  paid_at                timestamptz,
  received_by_full_name  text,
  payment_note           text,
  voided_by              uuid,
  voided_at              timestamptz,
  void_reason            text,
  CONSTRAINT tws_period CHECK (period_end >= period_start AND cutoff_date >= period_end),
  CONSTRAINT tws_components CHECK (gross_amount = base_amount + overtime_amount + sunday_amount),
  CONSTRAINT tws_net CHECK (net_amount = gross_amount - deductions_total AND deductions_total <= gross_amount),
  CONSTRAINT tws_early_reason CHECK (kind <> 'early' OR NULLIF(btrim(COALESCE(reason,'')), '') IS NOT NULL),
  CONSTRAINT tws_override CHECK (
    (approval_override AND NULLIF(btrim(COALESCE(override_reason,'')), '') IS NOT NULL)
    OR (NOT approval_override AND override_reason IS NULL)),
  CONSTRAINT tws_receiver_name CHECK (received_by_full_name IS NULL OR btrim(received_by_full_name) ~ '^\S+(\s+\S+)+$'),
  CONSTRAINT tws_payment_fields_only_when_paid CHECK (
    status = 'paid' OR (paid_by IS NULL AND paid_at IS NULL AND received_by_full_name IS NULL AND payment_note IS NULL)),
  CONSTRAINT tws_status_fields CHECK (
    CASE status
      WHEN 'draft'    THEN approved_by IS NULL AND approved_at IS NULL AND approved_by_role IS NULL AND NOT approval_override
                           AND payout_sheet_id IS NULL AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'approved' THEN approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by_role IS NOT NULL
                           AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'paid'     THEN approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by_role IS NOT NULL
                           AND payout_sheet_id IS NOT NULL AND paid_by IS NOT NULL AND paid_at IS NOT NULL
                           AND received_by_full_name IS NOT NULL AND paid_by <> prepared_by
                           AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'voided'   THEN voided_by IS NOT NULL AND voided_at IS NOT NULL AND NULLIF(btrim(COALESCE(void_reason,'')), '') IS NOT NULL
                           AND payout_sheet_id IS NULL
    END)
);
CREATE INDEX IF NOT EXISTS idx_tws_engagement ON public.temporary_worker_settlements (engagement_id);
CREATE INDEX IF NOT EXISTS idx_tws_employee   ON public.temporary_worker_settlements (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_tws_sheet      ON public.temporary_worker_settlements (payout_sheet_id);

-- ── Settlement lines ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_settlement_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id    uuid NOT NULL REFERENCES public.temporary_worker_settlements(id),
  time_entry_id    uuid NOT NULL REFERENCES public.production_time_entries(id),
  work_date        date NOT NULL,
  job_id           uuid,
  stage_id         uuid,
  attendance_units numeric(4,2) NOT NULL CHECK (attendance_units > 0),
  base_amount      numeric(12,2) NOT NULL CHECK (base_amount >= 0),
  overtime_amount  numeric(12,2) NOT NULL CHECK (overtime_amount >= 0),
  sunday_amount    numeric(12,2) NOT NULL CHECK (sunday_amount >= 0),
  line_amount      numeric(12,2) NOT NULL CHECK (line_amount > 0),
  active           boolean NOT NULL DEFAULT true,
  CONSTRAINT twl_components CHECK (line_amount = base_amount + overtime_amount + sunday_amount)
);
-- One day of work is never paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_twl_entry_active ON public.temporary_worker_settlement_lines (time_entry_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_twl_settlement ON public.temporary_worker_settlement_lines (settlement_id);

-- ── Deductions (operational only; statutory types cannot exist) ─────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_settlement_deductions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id         uuid NOT NULL REFERENCES public.temporary_worker_settlements(id),
  deduction_type        text NOT NULL CHECK (deduction_type IN ('damage','cash_advance','tools_or_materials','other')),
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  reason                text NOT NULL CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  evidence_ref          text,
  evidence_path         text,
  recorded_by           uuid NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  approved_by           uuid,
  approved_at           timestamptz,
  approved_by_role      text CHECK (approved_by_role IS NULL OR approved_by_role IN ('admin','production_manager','head_of_sales')),
  worker_acknowledged_at timestamptz,
  active                boolean NOT NULL DEFAULT true,
  voided_by             uuid,
  voided_at             timestamptz,
  void_reason           text,
  CONSTRAINT twd_reference CHECK (
    CASE deduction_type
      WHEN 'damage'             THEN NULLIF(btrim(COALESCE(evidence_ref,'')), '') IS NOT NULL OR NULLIF(btrim(COALESCE(evidence_path,'')), '') IS NOT NULL
      WHEN 'cash_advance'       THEN NULLIF(btrim(COALESCE(evidence_ref,'')), '') IS NOT NULL      -- advance voucher / reference
      WHEN 'tools_or_materials' THEN NULLIF(btrim(COALESCE(evidence_ref,'')), '') IS NOT NULL      -- issue slip / reference
      WHEN 'other'              THEN char_length(btrim(reason)) >= 20                               -- detailed reason; attachment optional
    END),
  CONSTRAINT twd_approval_trio CHECK ((approved_by IS NULL) = (approved_at IS NULL) AND (approved_by IS NULL) = (approved_by_role IS NULL)),
  CONSTRAINT twd_approver_not_recorder CHECK (approved_by IS NULL OR approved_by <> recorded_by),
  CONSTRAINT twd_void_fields CHECK (
    CASE WHEN active THEN voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
         ELSE voided_by IS NOT NULL AND voided_at IS NOT NULL AND NULLIF(btrim(COALESCE(void_reason,'')), '') IS NOT NULL END)
);
CREATE INDEX IF NOT EXISTS idx_twd_settlement ON public.temporary_worker_settlement_deductions (settlement_id);

-- ── Service-role only ───────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['temporary_worker_settings','temporary_worker_engagements','temporary_worker_payout_sheets',
                           'temporary_worker_settlements','temporary_worker_settlement_lines','temporary_worker_settlement_deductions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Helpers
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tw_is_run_role(p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_role IN ('admin','production_manager','head_of_sales'), false) $$;

-- Fail-closed: a missing settings row or a NULL limit means "over the limit" for every amount.
CREATE OR REPLACE FUNCTION public.tw_over_limit(p_amount numeric) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_amount > (SELECT admin_approval_limit_kes FROM temporary_worker_settings WHERE id = true), true)
$$;

CREATE OR REPLACE FUNCTION public.tw_log(p_type text, p_id uuid, p_activity text, p_desc text, p_actor uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO payroll_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES (p_type, p_id, p_activity, p_desc, p_actor)
$$;

CREATE OR REPLACE FUNCTION public.tw_blank(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(btrim(COALESCE(p, '')), '') IS NULL $$;

-- A single deduction above the limit, or active deductions above the % of gross, need an admin.
CREATE OR REPLACE FUNCTION public.tw_deduction_needs_admin(p_deduction uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT d.amount > st.deduction_single_limit_kes
        OR (SELECT COALESCE(sum(x.amount), 0) FROM temporary_worker_settlement_deductions x
             WHERE x.settlement_id = d.settlement_id AND x.active) > s.gross_amount * st.deduction_total_pct / 100
      FROM temporary_worker_settlement_deductions d
      JOIN temporary_worker_settlements s ON s.id = d.settlement_id
      CROSS JOIN temporary_worker_settings st
     WHERE d.id = p_deduction AND st.id = true), true)
$$;

CREATE OR REPLACE FUNCTION public.tw_recompute_settlement(p_settlement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_sum numeric;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO v_sum FROM temporary_worker_settlement_deductions WHERE settlement_id = p_settlement AND active;
  UPDATE temporary_worker_settlements SET deductions_total = v_sum, net_amount = gross_amount - v_sum WHERE id = p_settlement;
END $$;

CREATE OR REPLACE FUNCTION public.tw_recompute_sheet(p_sheet uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE temporary_worker_payout_sheets SET
    total_gross      = COALESCE((SELECT sum(gross_amount)     FROM temporary_worker_settlements WHERE payout_sheet_id = p_sheet AND status IN ('approved','paid')), 0),
    total_deductions = COALESCE((SELECT sum(deductions_total) FROM temporary_worker_settlements WHERE payout_sheet_id = p_sheet AND status IN ('approved','paid')), 0),
    total_net        = COALESCE((SELECT sum(net_amount)       FROM temporary_worker_settlements WHERE payout_sheet_id = p_sheet AND status IN ('approved','paid')), 0)
  WHERE id = p_sheet
$$;

-- Overlap with ordinary payroll: planned/active engagement dates vs a worker's payroll runs.
CREATE OR REPLACE FUNCTION public.tw_payroll_overlap(p_employee uuid, p_start date, p_end date) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.run_num FROM payroll_entries pe JOIN payroll_runs r ON r.id = pe.run_id
   WHERE pe.employee_id = p_employee AND r.period_start <= COALESCE(p_end, 'infinity'::date) AND r.period_end >= p_start
   LIMIT 1
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Guard triggers (the database, not the API, is the last line of defence)
-- ════════════════════════════════════════════════════════════════════════════

-- Engagements: identity and rate are immutable (a rate change is a new version); terminal states are frozen.
CREATE OR REPLACE FUNCTION public.tw_engagements_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Engagements cannot be deleted'; END IF;
  IF NEW.engagement_num IS DISTINCT FROM OLD.engagement_num OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.agreed_daily_rate IS DISTINCT FROM OLD.agreed_daily_rate
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An engagement''s worker, project and rate cannot change — revise it into a new version';
  END IF;
  IF OLD.status IN ('completed','cancelled') AND (to_jsonb(NEW) - 'notes') IS DISTINCT FROM (to_jsonb(OLD) - 'notes') THEN
    RAISE EXCEPTION 'A % engagement is closed; only its notes may change', OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'planned' AND NEW.status IN ('active','cancelled'))
    OR (OLD.status = 'active'  AND NEW.status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'Illegal engagement status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twe_guard ON public.temporary_worker_engagements;
CREATE TRIGGER trg_twe_guard BEFORE UPDATE OR DELETE ON public.temporary_worker_engagements
  FOR EACH ROW EXECUTE FUNCTION public.tw_engagements_guard();

-- Payout sheets: open -> printed -> signed; cancelled is terminal from any non-cancelled state.
CREATE OR REPLACE FUNCTION public.tw_sheets_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payout sheets cannot be deleted'; END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled payout sheet is final: it cannot be reused or signed'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open'    AND NEW.status IN ('printed','cancelled'))
    OR (OLD.status = 'printed' AND NEW.status IN ('signed','cancelled'))
    OR (OLD.status = 'signed'  AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'Illegal payout sheet status change % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.sheet_num IS DISTINCT FROM OLD.sheet_num OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Payout sheet identity cannot change';
  END IF;
  IF OLD.status = 'signed' AND NEW.status = 'signed' AND
     (NEW.total_gross IS DISTINCT FROM OLD.total_gross OR NEW.total_net IS DISTINCT FROM OLD.total_net
      OR NEW.total_deductions IS DISTINCT FROM OLD.total_deductions OR NEW.signed_receipt_path IS DISTINCT FROM OLD.signed_receipt_path) THEN
    RAISE EXCEPTION 'A signed payout sheet cannot change';
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = OLD.id AND status = 'paid') THEN
    RAISE EXCEPTION 'A payout sheet with a paid settlement cannot be cancelled';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twps_guard ON public.temporary_worker_payout_sheets;
CREATE TRIGGER trg_twps_guard BEFORE UPDATE OR DELETE ON public.temporary_worker_payout_sheets
  FOR EACH ROW EXECUTE FUNCTION public.tw_sheets_guard();

-- Settlements: legal transitions only; PAID and VOIDED are final; figures fixed after draft.
CREATE OR REPLACE FUNCTION public.tw_settlements_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_sum numeric; v_sheet_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Settlements cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'A settlement must start as a draft'; END IF;
    IF NEW.deductions_total <> 0 THEN RAISE EXCEPTION 'A new settlement has no deductions'; END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('paid','voided') THEN
    RAISE EXCEPTION 'A % settlement is final and cannot be changed', OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft'    AND NEW.status IN ('approved','voided'))
    OR (OLD.status = 'approved' AND NEW.status IN ('paid','voided'))) THEN
    RAISE EXCEPTION 'Illegal settlement status change % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.settlement_num IS DISTINCT FROM OLD.settlement_num OR NEW.engagement_id IS DISTINCT FROM OLD.engagement_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.cutoff_date IS DISTINCT FROM OLD.cutoff_date
     OR NEW.units_included IS DISTINCT FROM OLD.units_included OR NEW.base_amount IS DISTINCT FROM OLD.base_amount
     OR NEW.overtime_amount IS DISTINCT FROM OLD.overtime_amount OR NEW.sunday_amount IS DISTINCT FROM OLD.sunday_amount
     OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
     OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at THEN
    RAISE EXCEPTION 'Settlement figures and identity cannot be edited';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.deductions_total IS DISTINCT FROM OLD.deductions_total OR NEW.net_amount IS DISTINCT FROM OLD.net_amount) THEN
    RAISE EXCEPTION 'Deductions and net pay are fixed once a settlement is approved';
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO v_sum FROM temporary_worker_settlement_deductions WHERE settlement_id = NEW.id AND active;
  IF NEW.deductions_total <> v_sum THEN
    RAISE EXCEPTION 'deductions_total (%) must equal the sum of active deductions (%)', NEW.deductions_total, v_sum;
  END IF;

  IF NEW.payout_sheet_id IS DISTINCT FROM OLD.payout_sheet_id AND NEW.payout_sheet_id IS NOT NULL THEN
    SELECT status INTO v_sheet_status FROM temporary_worker_payout_sheets WHERE id = NEW.payout_sheet_id;
    IF v_sheet_status IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'Settlements can only be added to an open payout sheet'; END IF;
    IF OLD.status <> 'approved' THEN RAISE EXCEPTION 'Only approved settlements can be put on a payout sheet'; END IF;
  END IF;
  IF NEW.status = 'paid' THEN
    SELECT status INTO v_sheet_status FROM temporary_worker_payout_sheets WHERE id = NEW.payout_sheet_id;
    IF v_sheet_status IS DISTINCT FROM 'signed' THEN RAISE EXCEPTION 'Payment needs a signed payout sheet'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_tws_guard ON public.temporary_worker_settlements;
CREATE TRIGGER trg_tws_guard BEFORE INSERT OR UPDATE OR DELETE ON public.temporary_worker_settlements
  FOR EACH ROW EXECUTE FUNCTION public.tw_settlements_guard();

-- Lines: lines of a paid settlement can never change; lines are never deleted; they go inactive only when the settlement is voided.
CREATE OR REPLACE FUNCTION public.tw_lines_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM temporary_worker_settlements WHERE id = NEW.settlement_id;
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Lines can only be added while the settlement is a draft'; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM temporary_worker_settlements WHERE id = OLD.settlement_id;
  IF v_status = 'paid' THEN RAISE EXCEPTION 'Paid work is final: lines of a paid settlement cannot change'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Settlement lines are never deleted'; END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN RAISE EXCEPTION 'Settlement lines are immutable'; END IF;
  IF NEW.active IS DISTINCT FROM OLD.active AND NOT (OLD.active AND NOT NEW.active AND v_status = 'voided') THEN
    RAISE EXCEPTION 'A line can only be released when its settlement is voided';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twl_guard ON public.temporary_worker_settlement_lines;
CREATE TRIGGER trg_twl_guard BEFORE INSERT OR UPDATE OR DELETE ON public.temporary_worker_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION public.tw_lines_guard();

-- Deductions: only while the settlement is a draft; after approval only the worker-acknowledgement stamp may move; never once paid.
CREATE OR REPLACE FUNCTION public.tw_deductions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Deductions are never deleted — void them while the settlement is a draft'; END IF;
  SELECT status INTO v_status FROM temporary_worker_settlements WHERE id = COALESCE(NEW.settlement_id, OLD.settlement_id);
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Deductions can only be added while the settlement is a draft'; END IF;
    IF NEW.approved_by IS NOT NULL OR NOT NEW.active THEN RAISE EXCEPTION 'A new deduction is active and unapproved'; END IF;
    RETURN NEW;
  END IF;
  IF v_status IN ('paid','voided') THEN RAISE EXCEPTION 'Deductions of a % settlement cannot change', v_status; END IF;
  IF v_status = 'approved' THEN
    IF (to_jsonb(NEW) - 'worker_acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'worker_acknowledged_at') THEN
      RAISE EXCEPTION 'Deductions are fixed once the settlement is approved';
    END IF;
    RETURN NEW;
  END IF;
  -- draft
  IF NEW.settlement_id IS DISTINCT FROM OLD.settlement_id OR NEW.deduction_type IS DISTINCT FROM OLD.deduction_type
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.evidence_path IS DISTINCT FROM OLD.evidence_path
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.worker_acknowledged_at IS DISTINCT FROM OLD.worker_acknowledged_at THEN
    RAISE EXCEPTION 'A recorded deduction cannot be edited — void it and add a new one';
  END IF;
  IF NOT OLD.active AND NEW.active THEN RAISE EXCEPTION 'A voided deduction cannot be reactivated'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twd_guard ON public.temporary_worker_settlement_deductions;
CREATE TRIGGER trg_twd_guard BEFORE INSERT OR UPDATE OR DELETE ON public.temporary_worker_settlement_deductions
  FOR EACH ROW EXECUTE FUNCTION public.tw_deductions_guard();

-- Time entries: an approved entry that sits in an ACTIVE settlement cannot leave 'approved' (void/reject).
-- If that settlement is paid there is no way out: paid work is never freed.
CREATE OR REPLACE FUNCTION public.tw_time_entry_void_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_num text;
BEGIN
  SELECT s.settlement_num INTO v_num
    FROM temporary_worker_settlement_lines l JOIN temporary_worker_settlements s ON s.id = l.settlement_id
   WHERE l.time_entry_id = OLD.id AND l.active LIMIT 1;
  IF v_num IS NOT NULL THEN
    RAISE EXCEPTION 'This time entry is in temporary-worker settlement % — void that settlement first (a paid settlement cannot be voided)', v_num;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_pte_tw_void_guard ON public.production_time_entries;
CREATE TRIGGER trg_pte_tw_void_guard BEFORE UPDATE ON public.production_time_entries
  FOR EACH ROW WHEN (OLD.status = 'approved' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.tw_time_entry_void_guard();

-- Payroll side of the overlap guard: a worker with a planned/active engagement cannot join an overlapping run.
CREATE OR REPLACE FUNCTION public.tw_payroll_entry_overlap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; v_num text;
BEGIN
  SELECT period_start, period_end INTO r FROM payroll_runs WHERE id = NEW.run_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT e.engagement_num INTO v_num FROM temporary_worker_engagements e
   WHERE e.employee_id = NEW.employee_id AND e.status IN ('planned','active')
     AND e.start_date <= r.period_end AND COALESCE(e.expected_end_date, 'infinity'::date) >= r.period_start
   LIMIT 1;
  IF v_num IS NOT NULL THEN
    RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker has temporary engagement % overlapping this payroll period', v_num
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payroll_entries_tw_overlap ON public.payroll_entries;
CREATE TRIGGER trg_payroll_entries_tw_overlap BEFORE INSERT OR UPDATE OF employee_id, run_id ON public.payroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.tw_payroll_entry_overlap_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- Functions (each is one atomic unit; roles are re-checked here, not only in the API)
-- ════════════════════════════════════════════════════════════════════════════

-- ── Settings (admin only) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_temporary_worker_settings(p_changes jsonb, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'Only an admin can change temporary-worker settings'; END IF;
  INSERT INTO temporary_worker_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  UPDATE temporary_worker_settings SET
    settlement_threshold_units = COALESCE(NULLIF(p_changes->>'settlement_threshold_units','')::numeric, settlement_threshold_units),
    admin_approval_limit_kes   = CASE WHEN p_changes ? 'admin_approval_limit_kes' THEN NULLIF(p_changes->>'admin_approval_limit_kes','')::numeric ELSE admin_approval_limit_kes END,
    rolling_window_days        = COALESCE(NULLIF(p_changes->>'rolling_window_days','')::integer, rolling_window_days),
    deduction_single_limit_kes = COALESCE(NULLIF(p_changes->>'deduction_single_limit_kes','')::numeric, deduction_single_limit_kes),
    deduction_total_pct        = COALESCE(NULLIF(p_changes->>'deduction_total_pct','')::numeric, deduction_total_pct),
    damage_deductions_enabled  = COALESCE(NULLIF(p_changes->>'damage_deductions_enabled','')::boolean, damage_deductions_enabled),
    updated_by = p_actor, updated_at = now()
  WHERE id = true;
  PERFORM tw_log('temp_settings', gen_random_uuid(), 'settings_changed', 'Temporary-worker settings changed: ' || p_changes::text, p_actor);
  RETURN (SELECT to_jsonb(t) FROM temporary_worker_settings t WHERE id = true);
END $$;

-- ── Engagements ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_temporary_engagement(
  p_employee uuid, p_order uuid, p_rate numeric, p_start date, p_end date, p_max_days numeric,
  p_notes text, p_activate boolean, p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_run text;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN RAISE EXCEPTION 'Agreed daily rate must be above 0'; END IF;
  IF p_start IS NULL THEN RAISE EXCEPTION 'Start date is required'; END IF;
  IF p_end IS NOT NULL AND p_end < p_start THEN RAISE EXCEPTION 'End date cannot be before the start date'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_employee AND is_active) THEN
    RAISE EXCEPTION 'Worker not found or inactive. Ask an administrator to register this worker.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = p_order) THEN RAISE EXCEPTION 'Project not found'; END IF;
  v_run := tw_payroll_overlap(p_employee, p_start, p_end);
  IF v_run IS NOT NULL THEN RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker is in payroll run % for an overlapping period', v_run; END IF;
  INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, expected_end_date, max_days, notes, status, created_by)
  VALUES (p_employee, p_order, p_rate, p_start, p_end, p_max_days, NULLIF(btrim(COALESCE(p_notes,'')), ''),
          CASE WHEN p_activate THEN 'active' ELSE 'planned' END, p_actor)
  RETURNING id INTO v_id;
  PERFORM tw_log('temp_engagement', v_id, 'created', 'Temporary engagement created', p_actor);
  RETURN v_id;
END $$;

-- Eligible (unsettled, approved) work for an engagement up to a cutoff.
CREATE OR REPLACE FUNCTION public.temporary_engagement_due(p_engagement uuid, p_cutoff date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_units numeric; v_gross numeric; v_thr numeric; v_status text;
BEGIN
  SELECT status INTO v_status FROM temporary_worker_engagements WHERE id = p_engagement;
  SELECT settlement_threshold_units INTO v_thr FROM temporary_worker_settings WHERE id = true;
  SELECT COALESCE(sum(e.attendance_units), 0), COALESCE(sum(e.actual_labour_cost), 0) INTO v_units, v_gross
    FROM production_time_entries e JOIN production_job_assignments a ON a.id = e.assignment_id
   WHERE a.temporary_engagement_id = p_engagement AND e.status = 'approved' AND e.actual_labour_cost IS NOT NULL
     AND (p_cutoff IS NULL OR e.work_date <= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.time_entry_id = e.id AND l.active);
  RETURN jsonb_build_object('eligible_units', v_units, 'eligible_gross', v_gross, 'threshold_units', v_thr,
    'due', v_units >= COALESCE(v_thr, 3), 'close_out_due', v_status IN ('completed','cancelled') AND v_units > 0);
END $$;

CREATE OR REPLACE FUNCTION public.set_engagement_status(p_id uuid, p_status text, p_reason text, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; v_run text;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF p_status = 'active' THEN
    IF e.status <> 'planned' THEN RAISE EXCEPTION 'Only a planned engagement can be activated'; END IF;
    v_run := tw_payroll_overlap(e.employee_id, e.start_date, e.expected_end_date);
    IF v_run IS NOT NULL THEN RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker is in payroll run % for an overlapping period', v_run; END IF;
    UPDATE temporary_worker_engagements SET status = 'active' WHERE id = p_id;
  ELSIF p_status IN ('completed','cancelled') THEN
    IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required to close an engagement'; END IF;
    IF e.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Engagement is already closed'; END IF;
    IF p_status = 'completed' AND e.status <> 'active' THEN RAISE EXCEPTION 'Only an active engagement can be completed'; END IF;
    UPDATE temporary_worker_engagements SET status = p_status, closed_by = p_actor, closed_at = now(), close_reason = btrim(p_reason) WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Unknown engagement status';
  END IF;
  PERFORM tw_log('temp_engagement', p_id, p_status, 'Engagement ' || p_status || COALESCE(': ' || NULLIF(btrim(COALESCE(p_reason,'')), ''), ''), p_actor);
  RETURN temporary_engagement_due(p_id);   -- the caller prompts a close-out settlement when units remain
END $$;

-- A rate change closes this version and opens a new one; existing assignments keep the old rate.
CREATE OR REPLACE FUNCTION public.revise_engagement_rate(p_id uuid, p_new_rate numeric, p_reason text, p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; v_new uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_new_rate IS NULL OR p_new_rate <= 0 THEN RAISE EXCEPTION 'Agreed daily rate must be above 0'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required for a rate change'; END IF;
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR e.status <> 'active' THEN RAISE EXCEPTION 'Only an active engagement can be revised'; END IF;
  UPDATE temporary_worker_engagements SET status = 'completed', closed_by = p_actor, closed_at = now(),
         close_reason = 'Rate revised: ' || btrim(p_reason) WHERE id = p_id;
  INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, expected_end_date, max_days, notes, status, version, supersedes_id, created_by)
  VALUES (e.employee_id, e.order_id, p_new_rate, current_date, e.expected_end_date, e.max_days, e.notes, 'active', e.version + 1, e.id, p_actor)
  RETURNING id INTO v_new;
  PERFORM tw_log('temp_engagement', v_new, 'revised', 'Rate revised from ' || e.agreed_daily_rate || ' to ' || p_new_rate || ': ' || btrim(p_reason), p_actor);
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION public.link_assignment_to_engagement(p_assignment uuid, p_engagement uuid, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a record; e record; j record;
BEGIN
  IF p_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_engagement FOR UPDATE;
  IF NOT FOUND OR e.status <> 'active' THEN RAISE EXCEPTION 'Engagement must be active'; END IF;
  SELECT * INTO a FROM production_job_assignments WHERE id = p_assignment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found'; END IF;
  SELECT order_id INTO j FROM production_jobs WHERE id = a.job_id;
  IF j.order_id IS DISTINCT FROM e.order_id THEN RAISE EXCEPTION 'The assignment''s project does not match the engagement''s project'; END IF;
  IF a.employee_id <> e.employee_id THEN RAISE EXCEPTION 'The assignment''s worker does not match the engagement''s worker'; END IF;
  IF a.status NOT IN ('Assigned','In Progress') THEN RAISE EXCEPTION 'Only an active assignment can be linked'; END IF;
  IF a.temporary_engagement_id IS NOT NULL AND a.temporary_engagement_id <> p_engagement THEN
    RAISE EXCEPTION 'This assignment is already linked to another engagement';
  END IF;
  IF EXISTS (SELECT 1 FROM production_time_entries WHERE assignment_id = p_assignment AND status IN ('draft','submitted','approved')) THEN
    RAISE EXCEPTION 'Time has already been recorded on this assignment; a rate change needs a new engagement version and a new assignment';
  END IF;
  UPDATE production_job_assignments SET temporary_engagement_id = p_engagement, daily_rate_snapshot = e.agreed_daily_rate,
         rate_snapshot_at = now() WHERE id = p_assignment;
  PERFORM tw_log('temp_engagement', p_engagement, 'assignment_linked', 'Assignment ' || p_assignment || ' linked', p_actor);
END $$;

-- ── Prepare a settlement ────────────────────────────────────────────────────
-- Takes EVERY eligible approved entry up to the cutoff, oldest first. The caller cannot pick entries.
CREATE OR REPLACE FUNCTION public.prepare_temporary_settlement(
  p_engagement uuid, p_cutoff date, p_kind text, p_reason text, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  eng record; st record; r record;
  v_lines jsonb := '[]'::jsonb; v_units numeric := 0;
  v_base numeric := 0; v_ot numeric := 0; v_sun numeric := 0; v_gross numeric := 0;
  v_b numeric; v_o numeric; v_s numeric; v_min date; v_max date; v_id uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('threshold','close_out','early') THEN RAISE EXCEPTION 'Unknown settlement kind'; END IF;
  IF p_cutoff IS NULL THEN RAISE EXCEPTION 'A cutoff date is required'; END IF;
  IF p_kind = 'early' AND tw_blank(p_reason) THEN RAISE EXCEPTION 'An early settlement needs a reason'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tw_engagement:' || p_engagement::text));
  SELECT * INTO eng FROM temporary_worker_engagements WHERE id = p_engagement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF eng.status = 'planned' THEN RAISE EXCEPTION 'Activate the engagement first'; END IF;
  IF p_kind = 'close_out' AND eng.status = 'active' THEN RAISE EXCEPTION 'A close-out settlement needs a completed or cancelled engagement'; END IF;
  SELECT * INTO st FROM temporary_worker_settings WHERE id = true;

  FOR r IN
    SELECT e.* FROM production_time_entries e JOIN production_job_assignments a ON a.id = e.assignment_id
     WHERE a.temporary_engagement_id = p_engagement AND e.status = 'approved' AND e.actual_labour_cost IS NOT NULL
       AND e.work_date <= p_cutoff
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.time_entry_id = e.id AND l.active)
     ORDER BY e.work_date, e.recorded_at, e.id
       FOR UPDATE OF e
  LOOP
    -- Components come from the entry's own immutable snapshots and must reconcile to actual_labour_cost.
    IF r.is_sunday THEN
      v_b := 0; v_o := 0; v_s := r.actual_labour_cost;
      IF abs(v_s - r.attendance_units * COALESCE(r.sunday_rate_snapshot, 0)) > 0.01 THEN
        RAISE EXCEPTION 'Time entry % does not reconcile to its Sunday rate — resolve it before settling', r.id;
      END IF;
    ELSE
      v_b := round(r.attendance_units * COALESCE(r.daily_rate_snapshot, 0), 2); v_s := 0;
      v_o := r.actual_labour_cost - v_b;
      IF v_o < 0 OR (NOT r.has_overtime AND v_o <> 0)
         OR (r.has_overtime AND abs(v_o - r.attendance_units * COALESCE(r.overtime_rate_snapshot, 0)) > 0.01) THEN
        RAISE EXCEPTION 'Time entry % does not reconcile to its rate snapshots — resolve it before settling', r.id;
      END IF;
    END IF;
    v_units := v_units + r.attendance_units; v_base := v_base + v_b; v_ot := v_ot + v_o; v_sun := v_sun + v_s;
    v_gross := v_gross + r.actual_labour_cost;
    v_min := LEAST(COALESCE(v_min, r.work_date), r.work_date); v_max := GREATEST(COALESCE(v_max, r.work_date), r.work_date);
    v_lines := v_lines || jsonb_build_object('time_entry_id', r.id, 'work_date', r.work_date, 'job_id', r.job_id, 'stage_id', r.stage_id,
                 'units', r.attendance_units, 'base', v_b, 'ot', v_o, 'sun', v_s, 'amount', r.actual_labour_cost);
  END LOOP;

  IF v_units = 0 THEN RAISE EXCEPTION 'There is no approved, unsettled work to settle up to %', p_cutoff; END IF;
  IF p_kind = 'threshold' AND v_units < st.settlement_threshold_units THEN
    RAISE EXCEPTION 'Only % approved attendance units — the settlement threshold is %. Use an early settlement with a reason, or wait.', v_units, st.settlement_threshold_units;
  END IF;

  INSERT INTO temporary_worker_settlements
    (engagement_id, employee_id, period_start, period_end, cutoff_date, units_included, base_amount, overtime_amount, sunday_amount,
     gross_amount, net_amount, kind, reason, prepared_by)
  VALUES (p_engagement, eng.employee_id, v_min, v_max, p_cutoff, v_units, v_base, v_ot, v_sun, v_gross, v_gross, p_kind,
          NULLIF(btrim(COALESCE(p_reason,'')), ''), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO temporary_worker_settlement_lines
    (settlement_id, time_entry_id, work_date, job_id, stage_id, attendance_units, base_amount, overtime_amount, sunday_amount, line_amount)
  SELECT v_id, (x->>'time_entry_id')::uuid, (x->>'work_date')::date, (x->>'job_id')::uuid, (x->>'stage_id')::uuid,
         (x->>'units')::numeric, (x->>'base')::numeric, (x->>'ot')::numeric, (x->>'sun')::numeric, (x->>'amount')::numeric
    FROM jsonb_array_elements(v_lines) x;
  PERFORM tw_log('temp_settlement', v_id, 'created', 'Settlement prepared (' || p_kind || '): ' || v_units || ' units, gross ' || v_gross, p_actor);
  RETURN jsonb_build_object('id', v_id, 'units', v_units, 'gross', v_gross, 'lines', jsonb_array_length(v_lines));
END $$;

-- ── Deductions ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_settlement_deduction(
  p_settlement uuid, p_type text, p_amount numeric, p_reason text, p_ref text, p_path text, p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; st record; v_id uuid; v_total numeric;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = p_settlement FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement not found'; END IF;
  IF s.status <> 'draft' THEN RAISE EXCEPTION 'Deductions can only be added while the settlement is a draft'; END IF;
  SELECT * INTO st FROM temporary_worker_settings WHERE id = true;
  IF p_type = 'damage' AND NOT COALESCE(st.damage_deductions_enabled, false) THEN RAISE EXCEPTION 'Damage deductions are switched off in settings'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Deduction amount must be above 0'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required for every deduction'; END IF;
  IF p_type = 'other' AND char_length(btrim(p_reason)) < 20 THEN RAISE EXCEPTION 'For an "other" deduction the reason must be at least 20 characters'; END IF;
  IF p_type = 'damage' AND tw_blank(p_ref) AND tw_blank(p_path) THEN RAISE EXCEPTION 'A damage deduction needs an evidence reference or attachment'; END IF;
  IF p_type = 'cash_advance' AND tw_blank(p_ref) THEN RAISE EXCEPTION 'A cash advance needs the advance voucher reference'; END IF;
  IF p_type = 'tools_or_materials' AND tw_blank(p_ref) THEN RAISE EXCEPTION 'Tools or materials need the issue-slip reference'; END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_total FROM temporary_worker_settlement_deductions WHERE settlement_id = p_settlement AND active;
  IF v_total + p_amount > s.gross_amount THEN RAISE EXCEPTION 'Deductions (%) would exceed the gross pay (%)', v_total + p_amount, s.gross_amount; END IF;
  INSERT INTO temporary_worker_settlement_deductions (settlement_id, deduction_type, amount, reason, evidence_ref, evidence_path, recorded_by)
  VALUES (p_settlement, p_type, p_amount, btrim(p_reason), upper(NULLIF(btrim(COALESCE(p_ref,'')), '')), NULLIF(btrim(COALESCE(p_path,'')), ''), p_actor)
  RETURNING id INTO v_id;
  PERFORM tw_recompute_settlement(p_settlement);
  PERFORM tw_log('temp_deduction', v_id, 'created', p_type || ' deduction ' || p_amount || ' on ' || s.settlement_num, p_actor);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.approve_settlement_deduction(p_id uuid, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; s record; v_sid uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT settlement_id INTO v_sid FROM temporary_worker_settlement_deductions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deduction not found'; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = v_sid FOR UPDATE;
  SELECT * INTO d FROM temporary_worker_settlement_deductions WHERE id = p_id FOR UPDATE;
  IF s.status <> 'draft' THEN RAISE EXCEPTION 'Deductions can only be approved while the settlement is a draft'; END IF;
  IF NOT d.active THEN RAISE EXCEPTION 'That deduction was voided'; END IF;
  IF d.recorded_by = p_actor THEN RAISE EXCEPTION 'A deduction must be approved by someone other than the person who recorded it'; END IF;
  IF tw_deduction_needs_admin(p_id) AND p_role <> 'admin' THEN
    RAISE EXCEPTION 'This deduction is above the single-deduction limit or the share-of-gross limit — an admin must approve it';
  END IF;
  IF d.approved_by IS NOT NULL AND NOT (d.approved_by_role <> 'admin' AND p_role = 'admin') THEN
    RAISE EXCEPTION 'This deduction is already approved';
  END IF;
  UPDATE temporary_worker_settlement_deductions SET approved_by = p_actor, approved_at = now(), approved_by_role = p_role WHERE id = p_id;
  PERFORM tw_log('temp_deduction', p_id, 'approved', 'Deduction approved by ' || p_role, p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.void_settlement_deduction(p_id uuid, p_reason text, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; v_sid uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT settlement_id INTO v_sid FROM temporary_worker_settlement_deductions WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deduction not found'; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = v_sid FOR UPDATE;
  IF s.status <> 'draft' THEN RAISE EXCEPTION 'Deductions can only be voided while the settlement is a draft'; END IF;
  UPDATE temporary_worker_settlement_deductions SET active = false, voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
   WHERE id = p_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That deduction is already voided'; END IF;
  PERFORM tw_recompute_settlement(s.id);
  PERFORM tw_log('temp_deduction', p_id, 'voided', 'Deduction voided: ' || btrim(p_reason), p_actor);
END $$;

-- ── Approve a settlement ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_temporary_settlement(p_id uuid, p_actor uuid, p_role text, p_override_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s record; st record; d record;
  v_conflict boolean; v_override boolean := false; v_rolling numeric; v_needs_admin boolean;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement not found'; END IF;
  IF s.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft settlement can be approved (this one is %)', s.status; END IF;
  SELECT * INTO st FROM temporary_worker_settings WHERE id = true;

  -- The work must still be approved and unvoided.
  IF EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l JOIN production_time_entries e ON e.id = l.time_entry_id
              WHERE l.settlement_id = p_id AND l.active AND e.status <> 'approved') THEN
    RAISE EXCEPTION 'An included time entry is no longer approved — void this settlement and prepare it again';
  END IF;

  -- Separation of duties: not the preparer, not any attendance recorder. Admin may override with a reason.
  v_conflict := s.prepared_by = p_actor OR EXISTS (
    SELECT 1 FROM temporary_worker_settlement_lines l JOIN production_time_entries e ON e.id = l.time_entry_id
     WHERE l.settlement_id = p_id AND l.active AND e.recorded_by IS NOT DISTINCT FROM p_actor);
  IF v_conflict THEN
    IF p_role <> 'admin' THEN RAISE EXCEPTION 'You cannot approve a settlement you prepared or whose attendance you recorded'; END IF;
    IF tw_blank(p_override_reason) THEN RAISE EXCEPTION 'An admin approving their own work must give an override reason'; END IF;
    v_override := true;
  END IF;

  -- Fail-closed limit on gross, including the same worker's other recent settlements (anti-splitting).
  v_rolling := COALESCE((SELECT sum(gross_amount) FROM temporary_worker_settlements
                          WHERE employee_id = s.employee_id AND id <> s.id AND status IN ('approved','paid')
                            AND approved_at >= now() - make_interval(days => COALESCE(st.rolling_window_days, 7))), 0);
  v_needs_admin := tw_over_limit(s.gross_amount) OR tw_over_limit(s.gross_amount + v_rolling);
  IF v_needs_admin AND p_role <> 'admin' THEN
    RAISE EXCEPTION 'This settlement (or this worker''s recent settlements together) is above the approval limit, or the limit is not set — an admin must approve it';
  END IF;

  -- Every active deduction must be approved, by an admin where the limits require it.
  FOR d IN SELECT * FROM temporary_worker_settlement_deductions WHERE settlement_id = p_id AND active LOOP
    IF d.approved_by IS NULL THEN RAISE EXCEPTION 'Every deduction must be approved before the settlement'; END IF;
    IF tw_deduction_needs_admin(d.id) AND d.approved_by_role <> 'admin' THEN
      RAISE EXCEPTION 'A deduction above the limits still needs admin approval';
    END IF;
  END LOOP;

  UPDATE temporary_worker_settlements SET status = 'approved', approved_by = p_actor, approved_at = now(), approved_by_role = p_role,
         approval_override = v_override, override_reason = CASE WHEN v_override THEN btrim(p_override_reason) END
   WHERE id = p_id;
  PERFORM tw_log('temp_settlement', p_id, CASE WHEN v_override THEN 'approved_override' ELSE 'approved' END,
                 'Settlement approved by ' || p_role || CASE WHEN v_override THEN ' (override: ' || btrim(p_override_reason) || ')' ELSE '' END, p_actor);
  RETURN jsonb_build_object('id', p_id, 'status', 'approved', 'override', v_override);
END $$;

-- ── Payout sheets ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_payout_sheet(p_settlement_ids uuid[], p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ids uuid[]; v_n integer; v_ok integer; v_sheet uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_settlement_ids) x;
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n = 0 THEN RAISE EXCEPTION 'Choose at least one settlement'; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_ok FROM temporary_worker_settlements WHERE id = ANY (v_ids) AND status = 'approved' AND payout_sheet_id IS NULL;
  IF v_ok <> v_n THEN RAISE EXCEPTION 'Every settlement must be approved, unpaid and not already on a payout sheet'; END IF;
  INSERT INTO temporary_worker_payout_sheets (created_by) VALUES (p_actor) RETURNING id INTO v_sheet;
  UPDATE temporary_worker_settlements SET payout_sheet_id = v_sheet WHERE id = ANY (v_ids);
  PERFORM tw_recompute_sheet(v_sheet);
  PERFORM tw_log('temp_sheet', v_sheet, 'created', 'Payout sheet created with ' || v_n || ' settlement(s)', p_actor);
  RETURN v_sheet;
END $$;

CREATE OR REPLACE FUNCTION public.approve_payout_sheet(p_id uuid, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record;
BEGIN
  IF p_role <> 'admin' THEN RAISE EXCEPTION 'Only an admin can approve a payout sheet above the limit'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status NOT IN ('open','printed','signed') THEN RAISE EXCEPTION 'A % payout sheet cannot be approved', sh.status; END IF;
  UPDATE temporary_worker_payout_sheets SET admin_approved_by = p_actor, admin_approved_at = now() WHERE id = p_id;
  PERFORM tw_log('temp_sheet', p_id, 'admin_approved', 'Payout sheet approved by admin', p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.mark_sheet_printed(p_id uuid, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status <> 'open' THEN RAISE EXCEPTION 'Only an open payout sheet can be printed (this one is %)', sh.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id) THEN RAISE EXCEPTION 'The payout sheet is empty'; END IF;
  IF tw_over_limit(sh.total_net) AND sh.admin_approved_by IS NULL THEN
    RAISE EXCEPTION 'This payout sheet is above the approval limit (or the limit is not set) — an admin must approve it before it is printed';
  END IF;
  UPDATE temporary_worker_payout_sheets SET status = 'printed', printed_at = now() WHERE id = p_id;
  PERFORM tw_log('temp_sheet', p_id, 'printed', 'Payout sheet printed', p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.attach_signed_receipt(p_id uuid, p_path text, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_path) THEN RAISE EXCEPTION 'The signed receipt file is required'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status <> 'printed' THEN RAISE EXCEPTION 'Print the payout sheet before attaching the signed copy (this one is %)', sh.status; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND status <> 'approved') THEN
    RAISE EXCEPTION 'Every settlement on the sheet must still be approved and unpaid';
  END IF;
  UPDATE temporary_worker_payout_sheets SET status = 'signed', signed_receipt_path = btrim(p_path),
         signed_receipt_uploaded_by = p_actor, signed_receipt_uploaded_at = now() WHERE id = p_id;
  -- The signed sheet lists every deduction: that is the worker's acknowledgement.
  UPDATE temporary_worker_settlement_deductions SET worker_acknowledged_at = now()
   WHERE active AND settlement_id IN (SELECT id FROM temporary_worker_settlements WHERE payout_sheet_id = p_id);
  PERFORM tw_log('temp_sheet', p_id, 'signed', 'Signed receipt attached', p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.cancel_payout_sheet(p_id uuid, p_reason text, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required to cancel a payout sheet'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status = 'cancelled' THEN RAISE EXCEPTION 'Payout sheet is already cancelled'; END IF;
  IF sh.status = 'signed' AND p_role <> 'admin' THEN RAISE EXCEPTION 'Only an admin can cancel a signed payout sheet'; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND status = 'paid') THEN
    RAISE EXCEPTION 'A payout sheet with a paid settlement cannot be cancelled';
  END IF;
  -- The cancelled sheet's acknowledgement no longer stands.
  UPDATE temporary_worker_settlement_deductions SET worker_acknowledged_at = NULL
   WHERE worker_acknowledged_at IS NOT NULL AND settlement_id IN (SELECT id FROM temporary_worker_settlements WHERE payout_sheet_id = p_id);
  UPDATE temporary_worker_settlements SET payout_sheet_id = NULL WHERE payout_sheet_id = p_id;
  UPDATE temporary_worker_payout_sheets SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(),
         cancel_reason = btrim(p_reason), signed_receipt_path = NULL WHERE id = p_id;
  PERFORM tw_log('temp_sheet', p_id, 'cancelled', 'Payout sheet cancelled: ' || btrim(p_reason), p_actor);
  IF sh.signed_receipt_path IS NOT NULL THEN
    PERFORM tw_log('temp_sheet', p_id, 'cancelled_receipt_retained', 'Signed receipt retained in storage at ' || sh.signed_receipt_path, p_actor);
  END IF;
END $$;

-- ── Pay ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pay_temporary_settlement(p_id uuid, p_actor uuid, p_role text, p_received_by text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; sh record; v_sheet uuid; v_name text := btrim(COALESCE(p_received_by, ''));
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  -- Lock order: sheet first, then settlement (matches cancel_payout_sheet).
  SELECT payout_sheet_id INTO v_sheet FROM temporary_worker_settlements WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement not found'; END IF;
  IF v_sheet IS NOT NULL THEN SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = v_sheet FOR SHARE; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = p_id FOR UPDATE;
  IF s.payout_sheet_id IS DISTINCT FROM v_sheet THEN RAISE EXCEPTION 'The settlement''s payout sheet changed — try again'; END IF;
  IF s.status = 'paid' THEN RAISE EXCEPTION 'This settlement is already paid'; END IF;
  IF s.status <> 'approved' THEN RAISE EXCEPTION 'Only an approved settlement can be paid (this one is %)', s.status; END IF;
  IF s.payout_sheet_id IS NULL THEN RAISE EXCEPTION 'Put the settlement on a payout sheet first'; END IF;
  IF sh.status <> 'signed' THEN RAISE EXCEPTION 'The payout sheet must be signed and attached before payment (it is %)', sh.status; END IF;
  IF tw_over_limit(sh.total_net) AND sh.admin_approved_by IS NULL THEN RAISE EXCEPTION 'The payout sheet needs admin approval before payment'; END IF;
  IF p_actor = s.prepared_by THEN RAISE EXCEPTION 'The person who prepared a settlement cannot pay it'; END IF;
  IF v_name !~ '^\S+(\s+\S+)+$' THEN RAISE EXCEPTION 'Enter the receiver''s full name (at least two names)'; END IF;
  IF (tw_over_limit(s.gross_amount) OR tw_over_limit(s.net_amount)) AND tw_blank(p_note) THEN
    RAISE EXCEPTION 'A payment note is required for a payment above the approval limit';
  END IF;
  IF EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l JOIN production_time_entries e ON e.id = l.time_entry_id
              WHERE l.settlement_id = p_id AND l.active AND e.status <> 'approved') THEN
    RAISE EXCEPTION 'An included time entry is no longer approved';
  END IF;
  UPDATE temporary_worker_settlements SET status = 'paid', paid_by = p_actor, paid_at = now(), received_by_full_name = v_name,
         payment_note = NULLIF(btrim(COALESCE(p_note,'')), '') WHERE id = p_id;
  PERFORM tw_log('temp_settlement', p_id, 'paid', 'Paid in cash KES ' || s.net_amount || ' to ' || v_name || ' (sheet ' || sh.sheet_num || ')', p_actor);
  RETURN jsonb_build_object('id', p_id, 'status', 'paid', 'net_amount', s.net_amount);
END $$;

-- ── Void ────────────────────────────────────────────────────────────────────
-- draft: any run role. approved-unpaid: admin only. PAID: refused for everyone.
CREATE OR REPLACE FUNCTION public.void_temporary_settlement(p_id uuid, p_reason text, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; sh record; v_sheet uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required to void a settlement'; END IF;
  SELECT payout_sheet_id INTO v_sheet FROM temporary_worker_settlements WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement not found'; END IF;
  IF v_sheet IS NOT NULL THEN SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = v_sheet FOR UPDATE; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = p_id FOR UPDATE;
  IF s.payout_sheet_id IS DISTINCT FROM v_sheet THEN RAISE EXCEPTION 'The settlement''s payout sheet changed — try again'; END IF;
  IF s.status = 'paid' THEN RAISE EXCEPTION 'A paid settlement is final and cannot be voided'; END IF;
  IF s.status = 'voided' THEN RAISE EXCEPTION 'Settlement is already voided'; END IF;
  IF s.status = 'approved' AND p_role <> 'admin' THEN RAISE EXCEPTION 'Only an admin can void an approved settlement'; END IF;
  IF v_sheet IS NOT NULL THEN
    IF sh.status = 'signed' THEN RAISE EXCEPTION 'This settlement is on a signed payout sheet — cancel the sheet first'; END IF;
  END IF;
  UPDATE temporary_worker_settlements SET status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason),
         payout_sheet_id = NULL WHERE id = p_id;
  UPDATE temporary_worker_settlement_lines SET active = false WHERE settlement_id = p_id AND active;
  IF v_sheet IS NOT NULL THEN PERFORM tw_recompute_sheet(v_sheet); END IF;
  PERFORM tw_log('temp_settlement', p_id, 'voided', 'Settlement voided: ' || btrim(p_reason), p_actor);
END $$;

-- ── Grants: service_role only ───────────────────────────────────────────────
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND (p.proname LIKE 'tw\_%' OR p.proname IN (
              'set_temporary_worker_settings','create_temporary_engagement','temporary_engagement_due','set_engagement_status',
              'revise_engagement_rate','link_assignment_to_engagement','prepare_temporary_settlement','add_settlement_deduction',
              'approve_settlement_deduction','void_settlement_deduction','approve_temporary_settlement','create_payout_sheet',
              'approve_payout_sheet','mark_sheet_printed','attach_signed_receipt','cancel_payout_sheet','pay_temporary_settlement',
              'void_temporary_settlement'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
