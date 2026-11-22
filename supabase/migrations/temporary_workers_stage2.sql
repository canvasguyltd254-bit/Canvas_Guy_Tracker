-- ════════════════════════════════════════════════════════════════════════════
-- Temporary workers — Stage 2 (simplification). Run AFTER stage1, 1b and 1c. Idempotent.
--
-- A temporary worker is engaged for ONE project at an agreed daily rate. Days present are marked directly on the engagement
-- (like the Payroll attendance grid) by head of sales / production manager / admin. Production assigns tasks as it likes; paying
-- no longer depends on Production assignments, time entries, approvals or rate snapshots.
--
--   • temporary_worker_attendance: one active row per worker per day (Full = 1, Half = 0.5). Corrections void the row (with who/when),
--     they never delete it. A day in an active settlement cannot be voided.
--   • Settlements are built from unsettled active days × the engagement's agreed rate (flat: no overtime / Sunday rates).
--   • Separation of duties is kept: the approver cannot be the preparer or anyone who MARKED a day in the settlement
--     (an admin may override with a written reason, recorded on the settlement).
--   • Retired: the Production link (link_assignment_to_engagement), the time-entry triggers, and stage1d's assign function.
--
-- ORDER: stage1 → 1b → 1c → stage2. Do not re-run 1/1b/1c AFTER this file without re-running this file again: they recreate the
-- retired Production link and the old overlap rule. Existing time-entry-based settlements (there should be none: real use had not
-- started) keep working as history; new work uses marked days only.
--
-- LOCK ORDER (unchanged): payroll-run lock → employee advisory lock(s) in ascending id order → engagement row → attendance rows.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── Retire the Production coupling ──────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_pte_tw_insert_guard ON public.production_time_entries;
DROP TRIGGER IF EXISTS trg_pte_tw_void_guard   ON public.production_time_entries;
DROP FUNCTION IF EXISTS public.tw_time_entry_insert_guard();
DROP FUNCTION IF EXISTS public.tw_time_entry_void_guard();
DROP FUNCTION IF EXISTS public.link_assignment_to_engagement(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.assign_engagement_worker(uuid, uuid, uuid, uuid, integer, date, date, numeric, uuid, text);

-- Kenyan calendar day (the database clock is UTC; between 00:00 and 03:00 EAT "today" would otherwise be yesterday).
CREATE OR REPLACE FUNCTION public.tw_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date $$;

-- ── Attendance ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_attendance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id  uuid NOT NULL REFERENCES public.temporary_worker_engagements(id),
  employee_id    uuid NOT NULL REFERENCES public.employees(id),
  work_date      date NOT NULL,
  units          numeric(3,2) NOT NULL CHECK (units IN (0.5, 1)),
  marked_by      uuid NOT NULL,
  marked_at      timestamptz NOT NULL DEFAULT now(),
  active         boolean NOT NULL DEFAULT true,
  voided_by      uuid,
  voided_at      timestamptz,
  void_reason    text,
  CONSTRAINT twa_void_fields CHECK (
    CASE WHEN active THEN voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
         ELSE voided_by IS NOT NULL AND voided_at IS NOT NULL AND NULLIF(btrim(COALESCE(void_reason,'')), '') IS NOT NULL END)
);
-- A worker is present at most once per day, across every version of their engagements: a day is never paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_twa_employee_day_active ON public.temporary_worker_attendance (employee_id, work_date) WHERE active;
CREATE INDEX IF NOT EXISTS idx_twa_engagement ON public.temporary_worker_attendance (engagement_id, work_date);

ALTER TABLE public.temporary_worker_attendance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.temporary_worker_attendance FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.temporary_worker_attendance TO service_role;

-- Settlement lines now point at an attendance day (the old production time-entry column stays for history, nullable).
ALTER TABLE public.temporary_worker_settlement_lines ALTER COLUMN time_entry_id DROP NOT NULL;
ALTER TABLE public.temporary_worker_settlement_lines ADD COLUMN IF NOT EXISTS attendance_id uuid REFERENCES public.temporary_worker_attendance(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'twl_one_source') THEN
    ALTER TABLE public.temporary_worker_settlement_lines
      ADD CONSTRAINT twl_one_source CHECK ((time_entry_id IS NOT NULL) <> (attendance_id IS NOT NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_twl_attendance_active ON public.temporary_worker_settlement_lines (attendance_id) WHERE active;

-- Attendance rows: identity is immutable; the only change is voiding (never reversed, never while in an active settlement).
CREATE OR REPLACE FUNCTION public.tw_attendance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_num text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Attendance is never deleted — void the day with a reason'; END IF;
  IF (to_jsonb(NEW) - 'active' - 'voided_by' - 'voided_at' - 'void_reason') IS DISTINCT FROM
     (to_jsonb(OLD) - 'active' - 'voided_by' - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION 'A recorded day cannot be edited — void it and mark it again';
  END IF;
  IF NOT OLD.active THEN RAISE EXCEPTION 'A voided day is final'; END IF;
  IF NOT NEW.active THEN
    SELECT s.settlement_num INTO v_num
      FROM temporary_worker_settlement_lines l JOIN temporary_worker_settlements s ON s.id = l.settlement_id
     WHERE l.attendance_id = OLD.id AND l.active LIMIT 1;
    IF v_num IS NOT NULL THEN
      RAISE EXCEPTION 'This day is in temporary-worker settlement % — void that settlement first (a paid settlement cannot be voided)', v_num;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twa_guard ON public.temporary_worker_attendance;
CREATE TRIGGER trg_twa_guard BEFORE UPDATE OR DELETE ON public.temporary_worker_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tw_attendance_guard();

-- New days: the engagement must be active and belong to this worker, the day must be inside the engagement (not before it started,
-- not in the future) and not inside the worker's own payroll run. Employee lock first, then the engagement row (shared).
CREATE OR REPLACE FUNCTION public.tw_attendance_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; v_run text;
BEGIN
  PERFORM tw_lock_employee(NEW.employee_id);
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = NEW.engagement_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF e.employee_id <> NEW.employee_id THEN RAISE EXCEPTION 'The day''s worker does not match the engagement''s worker'; END IF;
  IF e.status <> 'active' THEN RAISE EXCEPTION 'Engagement % is %, so days can no longer be marked', e.engagement_num, e.status; END IF;
  IF NEW.work_date < e.start_date THEN RAISE EXCEPTION '% is before the engagement started (%)', NEW.work_date, e.start_date; END IF;
  IF NEW.work_date > tw_today() THEN RAISE EXCEPTION '% is in the future — a day can only be marked once it has happened', NEW.work_date; END IF;
  SELECT r.run_num INTO v_run FROM payroll_entries pe JOIN payroll_runs r ON r.id = pe.run_id
   WHERE pe.employee_id = NEW.employee_id AND r.period_start <= NEW.work_date AND r.period_end >= NEW.work_date LIMIT 1;
  IF v_run IS NOT NULL THEN
    RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: % falls inside payroll run % for this worker — the same day cannot be paid twice', NEW.work_date, v_run
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twa_insert_guard ON public.temporary_worker_attendance;
CREATE TRIGGER trg_twa_insert_guard BEFORE INSERT ON public.temporary_worker_attendance
  FOR EACH ROW EXECUTE FUNCTION public.tw_attendance_insert_guard();

-- Mark days: [{ "date": "2026-11-10", "units": 1 | 0.5 | 0 }]. 1/0.5 = present, 0 = clear the day (voids it).
-- Re-marking a day with different units voids the old row and writes a new one (history kept).
CREATE OR REPLACE FUNCTION public.mark_temporary_attendance(p_engagement uuid, p_days jsonb, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_emp uuid; e record; x jsonb; v_date date; v_units numeric; v_old record;
  v_seen date[] := '{}'; n_new integer := 0; n_chg integer := 0; n_clr integer := 0; v_min date; v_max date;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_days IS NULL OR jsonb_typeof(p_days) <> 'array' OR jsonb_array_length(p_days) = 0 THEN RAISE EXCEPTION 'Choose at least one day'; END IF;
  IF jsonb_array_length(p_days) > 62 THEN RAISE EXCEPTION 'Mark at most 62 days at a time'; END IF;
  SELECT employee_id INTO v_emp FROM temporary_worker_engagements WHERE id = p_engagement;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  PERFORM tw_lock_employee(v_emp);
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_engagement FOR SHARE;
  IF e.status <> 'active' THEN RAISE EXCEPTION 'Engagement % is %, so days can no longer be marked', e.engagement_num, e.status; END IF;

  FOR x IN SELECT value FROM jsonb_array_elements(p_days) LOOP
    IF (x->>'date') IS NULL OR (x->>'date') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Every day needs a valid date'; END IF;
    BEGIN v_date := (x->>'date')::date;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'Every day needs a valid date'; END;
    IF (x->>'units') IS NULL OR (x->>'units') !~ '^\d+(\.\d+)?$' THEN RAISE EXCEPTION 'Each day must be Full (1), Half (0.5) or cleared (0)'; END IF;
    v_units := (x->>'units')::numeric;
    IF v_units NOT IN (0, 0.5, 1) THEN RAISE EXCEPTION 'Each day must be Full (1), Half (0.5) or cleared (0)'; END IF;
    IF v_date = ANY (v_seen) THEN RAISE EXCEPTION 'The same day was listed twice (%)', v_date; END IF;
    v_seen := v_seen || v_date;
    v_min := LEAST(COALESCE(v_min, v_date), v_date); v_max := GREATEST(COALESCE(v_max, v_date), v_date);

    SELECT * INTO v_old FROM temporary_worker_attendance WHERE employee_id = v_emp AND work_date = v_date AND active FOR UPDATE;
    IF FOUND AND v_old.engagement_id <> p_engagement THEN
      RAISE EXCEPTION '% is already marked under another version of this engagement', v_date;
    END IF;
    IF v_units = 0 THEN
      IF FOUND THEN
        UPDATE temporary_worker_attendance SET active = false, voided_by = p_actor, voided_at = now(), void_reason = 'Cleared by ' || p_role WHERE id = v_old.id;
        n_clr := n_clr + 1;
      END IF;
    ELSE
      IF FOUND THEN
        IF v_old.units = v_units THEN CONTINUE; END IF;
        UPDATE temporary_worker_attendance SET active = false, voided_by = p_actor, voided_at = now(),
               void_reason = 'Changed from ' || trim_scale(v_old.units) || ' to ' || trim_scale(v_units) || ' day' WHERE id = v_old.id;
        n_chg := n_chg + 1;
      ELSE
        n_new := n_new + 1;
      END IF;
      INSERT INTO temporary_worker_attendance (engagement_id, employee_id, work_date, units, marked_by)
      VALUES (p_engagement, v_emp, v_date, v_units, p_actor);
    END IF;
  END LOOP;
  IF n_new + n_chg + n_clr > 0 THEN
    PERFORM tw_log('temp_engagement', p_engagement, 'attendance_marked',
      n_new || ' marked, ' || n_chg || ' changed, ' || n_clr || ' cleared (' || v_min || ' to ' || v_max || ')', p_actor);
  END IF;
  RETURN jsonb_build_object('marked', n_new, 'changed', n_chg, 'cleared', n_clr);
END $$;

-- ── Overlap with payroll: protected days now come from marked attendance ────
CREATE OR REPLACE FUNCTION public.tw_engagement_overlap(p_employee uuid, p_start date, p_end date) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text;
BEGIN
  SELECT e.engagement_num INTO v FROM temporary_worker_engagements e
   WHERE e.employee_id = p_employee AND e.status IN ('planned','active')
     AND e.start_date <= p_end AND COALESCE(e.expected_end_date, 'infinity'::date) >= p_start
   LIMIT 1;
  IF v IS NOT NULL THEN RETURN v; END IF;
  SELECT g.engagement_num INTO v
    FROM temporary_worker_attendance a JOIN temporary_worker_engagements g ON g.id = a.engagement_id
   WHERE a.employee_id = p_employee AND a.active AND a.work_date BETWEEN p_start AND p_end
   LIMIT 1;
  RETURN v;
END $$;

-- ── Due summaries (single and bulk) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.temporary_engagement_due(p_engagement uuid, p_cutoff date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_units numeric; v_gross numeric; v_thr numeric; v_status text; v_total numeric; v_max numeric; v_emp uuid; v_order uuid; v_rate numeric;
BEGIN
  SELECT status, max_days, employee_id, order_id, agreed_daily_rate INTO v_status, v_max, v_emp, v_order, v_rate
    FROM temporary_worker_engagements WHERE id = p_engagement;
  SELECT settlement_threshold_units INTO v_thr FROM temporary_worker_settings WHERE id = true;
  SELECT COALESCE(sum(a.units), 0), COALESCE(sum(round(a.units * v_rate, 2)), 0) INTO v_units, v_gross
    FROM temporary_worker_attendance a
   WHERE a.engagement_id = p_engagement AND a.active AND (p_cutoff IS NULL OR a.work_date <= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.attendance_id = a.id AND l.active);
  SELECT COALESCE(sum(a.units), 0) INTO v_total
    FROM temporary_worker_attendance a JOIN temporary_worker_engagements s ON s.id = a.engagement_id
   WHERE s.employee_id = v_emp AND s.order_id = v_order AND a.active;
  RETURN jsonb_build_object('eligible_units', v_units, 'eligible_gross', v_gross, 'threshold_units', v_thr,
    'due', v_units >= COALESCE(v_thr, 3), 'close_out_due', v_status IN ('completed','cancelled') AND v_units > 0,
    'total_units', v_total, 'max_days', v_max, 'max_days_reached', v_max IS NOT NULL AND v_total >= v_max);
END $$;

CREATE OR REPLACE FUNCTION public.temporary_engagements_due(p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH thr AS (SELECT COALESCE((SELECT settlement_threshold_units FROM temporary_worker_settings WHERE id = true), 3) AS t),
  elig AS (
    SELECT a.engagement_id AS eid, sum(a.units) AS u, sum(round(a.units * g.agreed_daily_rate, 2)) AS gr
      FROM temporary_worker_attendance a JOIN temporary_worker_engagements g ON g.id = a.engagement_id
     WHERE a.engagement_id = ANY (p_ids) AND a.active
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.attendance_id = a.id AND l.active)
     GROUP BY a.engagement_id),
  tot AS (
    SELECT g.id AS eid, sum(a.units) AS u
      FROM temporary_worker_engagements g
      JOIN temporary_worker_engagements s ON s.employee_id = g.employee_id AND s.order_id = g.order_id
      JOIN temporary_worker_attendance a ON a.engagement_id = s.id AND a.active
     WHERE g.id = ANY (p_ids)
     GROUP BY g.id)
  SELECT COALESCE(jsonb_object_agg(g.id::text, jsonb_build_object(
           'eligible_units', COALESCE(el.u, 0), 'eligible_gross', COALESCE(el.gr, 0), 'threshold_units', (SELECT t FROM thr),
           'due', COALESCE(el.u, 0) >= (SELECT t FROM thr),
           'close_out_due', g.status IN ('completed','cancelled') AND COALESCE(el.u, 0) > 0,
           'total_units', COALESCE(tt.u, 0), 'max_days', g.max_days,
           'max_days_reached', g.max_days IS NOT NULL AND COALESCE(tt.u, 0) >= g.max_days)), '{}'::jsonb)
    FROM temporary_worker_engagements g
    LEFT JOIN elig el ON el.eid = g.id
    LEFT JOIN tot tt ON tt.eid = g.id
   WHERE g.id = ANY (p_ids)
$$;

-- ── Prepare a settlement from unsettled marked days ─────────────────────────
CREATE OR REPLACE FUNCTION public.prepare_temporary_settlement(
  p_engagement uuid, p_cutoff date, p_kind text, p_reason text, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  eng record; st record; r record;
  v_lines jsonb := '[]'::jsonb; v_units numeric := 0; v_gross numeric := 0; v_amt numeric;
  v_min date; v_max date; v_id uuid;
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
    SELECT a.* FROM temporary_worker_attendance a
     WHERE a.engagement_id = p_engagement AND a.active AND a.work_date <= p_cutoff
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.attendance_id = a.id AND l.active)
     ORDER BY a.work_date, a.id
       FOR UPDATE OF a
  LOOP
    v_amt := round(r.units * eng.agreed_daily_rate, 2);
    v_units := v_units + r.units; v_gross := v_gross + v_amt;
    v_min := LEAST(COALESCE(v_min, r.work_date), r.work_date); v_max := GREATEST(COALESCE(v_max, r.work_date), r.work_date);
    v_lines := v_lines || jsonb_build_object('attendance_id', r.id, 'work_date', r.work_date, 'units', r.units, 'amount', v_amt);
  END LOOP;

  IF v_units = 0 THEN RAISE EXCEPTION 'There are no marked, unsettled days to settle up to %', p_cutoff; END IF;
  IF p_kind = 'threshold' AND v_units < st.settlement_threshold_units THEN
    RAISE EXCEPTION 'Only % days are marked — the settlement threshold is %. Use an early settlement with a reason, or wait.', v_units, st.settlement_threshold_units;
  END IF;

  INSERT INTO temporary_worker_settlements
    (engagement_id, employee_id, period_start, period_end, cutoff_date, units_included, base_amount, overtime_amount, sunday_amount,
     gross_amount, net_amount, kind, reason, prepared_by)
  VALUES (p_engagement, eng.employee_id, v_min, v_max, p_cutoff, v_units, v_gross, 0, 0, v_gross, v_gross, p_kind,
          NULLIF(btrim(COALESCE(p_reason,'')), ''), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO temporary_worker_settlement_lines
    (settlement_id, attendance_id, work_date, attendance_units, base_amount, overtime_amount, sunday_amount, line_amount)
  SELECT v_id, (x->>'attendance_id')::uuid, (x->>'work_date')::date, (x->>'units')::numeric,
         (x->>'amount')::numeric, 0, 0, (x->>'amount')::numeric
    FROM jsonb_array_elements(v_lines) x;
  PERFORM tw_log('temp_settlement', v_id, 'created', 'Settlement prepared (' || p_kind || '): ' || v_units || ' days, gross ' || v_gross, p_actor);
  RETURN jsonb_build_object('id', v_id, 'units', v_units, 'gross', v_gross, 'lines', jsonb_array_length(v_lines));
END $$;

-- ── Approve: same rules; separation of duties now looks at who MARKED the days ──
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

  IF EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l JOIN temporary_worker_attendance a ON a.id = l.attendance_id
              WHERE l.settlement_id = p_id AND l.active AND NOT a.active) THEN
    RAISE EXCEPTION 'An included day was voided — void this settlement and prepare it again';
  END IF;

  -- Separation of duties: not the preparer, not anyone who marked a day in it. Admin may override with a reason.
  v_conflict := s.prepared_by = p_actor OR EXISTS (
    SELECT 1 FROM temporary_worker_settlement_lines l JOIN temporary_worker_attendance a ON a.id = l.attendance_id
     WHERE l.settlement_id = p_id AND l.active AND a.marked_by IS NOT DISTINCT FROM p_actor);
  IF v_conflict THEN
    IF p_role <> 'admin' THEN RAISE EXCEPTION 'You cannot approve a settlement you prepared or whose days you marked'; END IF;
    IF tw_blank(p_override_reason) THEN RAISE EXCEPTION 'An admin approving their own work must give an override reason'; END IF;
    v_override := true;
  END IF;

  v_rolling := COALESCE((SELECT sum(gross_amount) FROM temporary_worker_settlements
                          WHERE employee_id = s.employee_id AND id <> s.id AND status IN ('approved','paid')
                            AND approved_at >= now() - make_interval(days => COALESCE(st.rolling_window_days, 7))), 0);
  v_needs_admin := tw_over_limit(s.gross_amount) OR tw_over_limit(s.gross_amount + v_rolling);
  IF v_needs_admin AND p_role <> 'admin' THEN
    RAISE EXCEPTION 'This settlement (or this worker''s recent settlements together) is above the approval limit, or the limit is not set — an admin must approve it';
  END IF;

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

-- ── Pay: unchanged except the "days still valid" check ──────────────────────
CREATE OR REPLACE FUNCTION public.pay_temporary_settlement(p_id uuid, p_actor uuid, p_role text, p_received_by text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record; sh record; v_sheet uuid; v_name text := btrim(COALESCE(p_received_by, ''));
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
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
  IF EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l JOIN temporary_worker_attendance a ON a.id = l.attendance_id
              WHERE l.settlement_id = p_id AND l.active AND NOT a.active) THEN
    RAISE EXCEPTION 'An included day was voided';
  END IF;
  UPDATE temporary_worker_settlements SET status = 'paid', paid_by = p_actor, paid_at = now(), received_by_full_name = v_name,
         payment_note = NULLIF(btrim(COALESCE(p_note,'')), '') WHERE id = p_id;
  PERFORM tw_log('temp_settlement', p_id, 'paid', 'Paid in cash KES ' || s.net_amount || ' to ' || v_name || ' (sheet ' || sh.sheet_num || ')', p_actor);
  RETURN jsonb_build_object('id', p_id, 'status', 'paid', 'net_amount', s.net_amount);
END $$;

-- ── Grants: service_role only ───────────────────────────────────────────────
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND (p.proname LIKE 'tw\_%' OR p.proname IN (
              'mark_temporary_attendance','prepare_temporary_settlement','approve_temporary_settlement','pay_temporary_settlement',
              'temporary_engagement_due','temporary_engagements_due'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
