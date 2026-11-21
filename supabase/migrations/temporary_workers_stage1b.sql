-- ════════════════════════════════════════════════════════════════════════════
-- Temporary workers — Stage 1b (corrective). Run AFTER temporary_workers_stage1.sql.
-- Idempotent: CREATE OR REPLACE / IF NOT EXISTS throughout.
--
-- Fixes found in external review of Stage 1–3:
--   1. Overlap race: engagement vs payroll could both pass their checks and both commit.
--      One per-employee advisory lock now serialises every path that can create an overlap.
--   2. Closed/revised engagements still accepted attendance (trigger added).
--   3. planned_labour_cost went stale when an assignment was linked to an engagement.
--   4. A batch payout sheet could be left half-paid and un-fixable: one settlement per sheet.
--   5. Bulk due-summary replaces one RPC per engagement.
--   6. Damage deductions are off by default until the legal review is complete.
--
-- LOCK ORDER (everywhere):  assignment row  →  payroll-run advisory lock  →  employee advisory lock(s), employees
-- in ascending id order  →  engagement row.  Keep it when adding code.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 6. Damage deductions default OFF ────────────────────────────────────────
ALTER TABLE public.temporary_worker_settings ALTER COLUMN damage_deductions_enabled SET DEFAULT false;
-- Flip the existing row only if a damage deduction has never been recorded (inactive ones count).
UPDATE public.temporary_worker_settings SET damage_deductions_enabled = false, updated_at = now()
 WHERE id = true AND damage_deductions_enabled
   AND NOT EXISTS (SELECT 1 FROM public.temporary_worker_settlement_deductions WHERE deduction_type = 'damage');

-- ── 4. One settlement per payout sheet (enforced by the database) ───────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_tws_one_per_sheet
  ON public.temporary_worker_settlements (payout_sheet_id) WHERE payout_sheet_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_payout_sheet(p_settlement_ids uuid[], p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ids uuid[]; v_n integer; v_sheet uuid; s record;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_settlement_ids) x;
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n = 0 THEN RAISE EXCEPTION 'Choose a settlement'; END IF;
  IF v_n <> 1 THEN RAISE EXCEPTION 'A payout sheet covers exactly one settlement — create a separate sheet for each worker'; END IF;
  SELECT * INTO s FROM temporary_worker_settlements WHERE id = v_ids[1] FOR UPDATE;
  IF NOT FOUND OR s.status <> 'approved' OR s.payout_sheet_id IS NOT NULL THEN
    RAISE EXCEPTION 'The settlement must be approved, unpaid and not already on a payout sheet';
  END IF;
  INSERT INTO temporary_worker_payout_sheets (created_by) VALUES (p_actor) RETURNING id INTO v_sheet;
  UPDATE temporary_worker_settlements SET payout_sheet_id = v_sheet WHERE id = s.id;
  PERFORM tw_recompute_sheet(v_sheet);
  PERFORM tw_log('temp_sheet', v_sheet, 'created', 'Payout sheet created for settlement ' || s.settlement_num, p_actor);
  RETURN v_sheet;
END $$;

-- ── 1. Employee lock + overlap rules ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tw_lock_employee(p_employee uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('tw_employee:' || p_employee::text, 0))
$$;

-- Payroll runs take this: SHARED when an entry is added (many may proceed together), EXCLUSIVE when the run's
-- dates or approval change (must see, and be seen by, every concurrent entry insert).
CREATE OR REPLACE FUNCTION public.tw_lock_run(p_run uuid, p_exclusive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_exclusive THEN PERFORM pg_advisory_xact_lock(hashtextextended('tw_run:' || p_run::text, 0));
  ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended('tw_run:' || p_run::text, 0)); END IF;
END $$;

-- Payroll runs overlapping an engagement's dates (volatile on purpose: it must see rows committed while we waited for the lock).
CREATE OR REPLACE FUNCTION public.tw_payroll_overlap(p_employee uuid, p_start date, p_end date) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.run_num FROM payroll_entries pe JOIN payroll_runs r ON r.id = pe.run_id
   WHERE pe.employee_id = p_employee AND r.period_start <= COALESCE(p_end, 'infinity'::date) AND r.period_end >= p_start
   LIMIT 1
$$;

-- Temporary-work dates protected against payroll for a worker in [p_start, p_end]:
--   • planned/active engagements: their whole agreed span (open-ended while active), and
--   • ANY engagement (including completed/cancelled/revised): the days with non-voided attendance or settled work.
-- A completed engagement therefore stops blocking payroll on days nothing was worked.
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
    FROM production_time_entries t
    JOIN production_job_assignments a ON a.id = t.assignment_id
    JOIN temporary_worker_engagements g ON g.id = a.temporary_engagement_id
   WHERE g.employee_id = p_employee AND t.status IN ('draft','submitted','approved')
     AND t.work_date BETWEEN p_start AND p_end
   LIMIT 1;
  RETURN v;
END $$;

-- Payroll side 1: adding/moving an entry. Run (shared) → employee.
CREATE OR REPLACE FUNCTION public.tw_payroll_entry_overlap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; v_num text;
BEGIN
  PERFORM tw_lock_run(NEW.run_id, false);
  PERFORM tw_lock_employee(NEW.employee_id);
  SELECT period_start, period_end INTO r FROM payroll_runs WHERE id = NEW.run_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_num := tw_engagement_overlap(NEW.employee_id, r.period_start, r.period_end);
  IF v_num IS NOT NULL THEN
    RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker has temporary engagement % overlapping this payroll period', v_num
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Payroll side 2: the run's dates change, or the run is approved. Run (exclusive) → every employee in the run, sorted by id.
CREATE OR REPLACE FUNCTION public.tw_payroll_run_overlap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_emp uuid; v_num text; v_emps uuid[];
BEGIN
  IF NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'approved') THEN
    PERFORM tw_lock_run(NEW.id, true);
    SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), '{}') INTO v_emps
      FROM (SELECT DISTINCT employee_id FROM payroll_entries WHERE run_id = NEW.id) x;
    FOREACH v_emp IN ARRAY v_emps LOOP PERFORM tw_lock_employee(v_emp); END LOOP;
    FOREACH v_emp IN ARRAY v_emps LOOP
      v_num := tw_engagement_overlap(v_emp, NEW.period_start, NEW.period_end);
      IF v_num IS NOT NULL THEN
        RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: a worker in this run has temporary engagement % overlapping the period', v_num
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payroll_runs_tw_overlap ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_tw_overlap BEFORE UPDATE OF period_start, period_end, status ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.tw_payroll_run_overlap_guard();

-- Engagement side. create: employee lock BEFORE the payroll check and the insert.
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
  PERFORM tw_lock_employee(p_employee);
  v_run := tw_payroll_overlap(p_employee, p_start, p_end);
  IF v_run IS NOT NULL THEN RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker is in payroll run % for an overlapping period', v_run; END IF;
  INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, expected_end_date, max_days, notes, status, created_by)
  VALUES (p_employee, p_order, p_rate, p_start, p_end, p_max_days, NULLIF(btrim(COALESCE(p_notes,'')), ''),
          CASE WHEN p_activate THEN 'active' ELSE 'planned' END, p_actor)
  RETURNING id INTO v_id;
  PERFORM tw_log('temp_engagement', v_id, 'created', 'Temporary engagement created', p_actor);
  RETURN v_id;
END $$;

-- Activation: employee lock first (read the id unlocked, lock, then lock the row).
CREATE OR REPLACE FUNCTION public.set_engagement_status(p_id uuid, p_status text, p_reason text, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; v_run text; v_emp uuid;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_status = 'active' THEN
    SELECT employee_id INTO v_emp FROM temporary_worker_engagements WHERE id = p_id;
    IF FOUND THEN PERFORM tw_lock_employee(v_emp); END IF;
  END IF;
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
  RETURN temporary_engagement_due(p_id);
END $$;

-- Revision: employee lock, payroll recheck for the new version's span. The expected end is carried over only if it is still
-- in the future (expected end is a guide, jobs run late; a past end would violate the dates check on the new row).
CREATE OR REPLACE FUNCTION public.revise_engagement_rate(p_id uuid, p_new_rate numeric, p_reason text, p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; v_new uuid; v_emp uuid; v_end date; v_run text;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_new_rate IS NULL OR p_new_rate <= 0 THEN RAISE EXCEPTION 'Agreed daily rate must be above 0'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required for a rate change'; END IF;
  SELECT employee_id INTO v_emp FROM temporary_worker_engagements WHERE id = p_id;
  IF FOUND THEN PERFORM tw_lock_employee(v_emp); END IF;
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR e.status <> 'active' THEN RAISE EXCEPTION 'Only an active engagement can be revised'; END IF;
  v_end := CASE WHEN e.expected_end_date >= current_date THEN e.expected_end_date ELSE NULL END;
  v_run := tw_payroll_overlap(e.employee_id, current_date, v_end);
  IF v_run IS NOT NULL THEN RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: this worker is in payroll run % for an overlapping period', v_run; END IF;
  UPDATE temporary_worker_engagements SET status = 'completed', closed_by = p_actor, closed_at = now(),
         close_reason = 'Rate revised: ' || btrim(p_reason) WHERE id = p_id;
  INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, expected_end_date, max_days, notes, status, version, supersedes_id, created_by)
  VALUES (e.employee_id, e.order_id, p_new_rate, current_date, v_end, e.max_days, e.notes, 'active', e.version + 1, e.id, p_actor)
  RETURNING id INTO v_new;
  PERFORM tw_log('temp_engagement', v_new, 'revised', 'Rate revised from ' || e.agreed_daily_rate || ' to ' || p_new_rate || ': ' || btrim(p_reason), p_actor);
  RETURN v_new;
END $$;

-- ── 2. Attendance on a temporary engagement ─────────────────────────────────
-- New entries only (existing ones may still be submitted/approved after the engagement closes).
-- Lock order here: assignment (held by record_time_entry) → employee → engagement (shared).
CREATE OR REPLACE FUNCTION public.tw_time_entry_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_eng uuid; e record; v_run text;
BEGIN
  SELECT temporary_engagement_id INTO v_eng FROM production_job_assignments WHERE id = NEW.assignment_id;
  IF v_eng IS NULL THEN RETURN NEW; END IF;
  PERFORM tw_lock_employee(NEW.employee_id);
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = v_eng FOR SHARE;
  IF e.status <> 'active' THEN
    RAISE EXCEPTION 'Temporary engagement % is %, so no new attendance can be recorded on this assignment. If the work continues, link a new assignment to the current engagement.',
      e.engagement_num, e.status;
  END IF;
  IF NEW.work_date < e.start_date THEN
    RAISE EXCEPTION 'The work date % is before temporary engagement % started (%)', NEW.work_date, e.engagement_num, e.start_date;
  END IF;
  SELECT r.run_num INTO v_run FROM payroll_entries pe JOIN payroll_runs r ON r.id = pe.run_id
   WHERE pe.employee_id = NEW.employee_id AND r.period_start <= NEW.work_date AND r.period_end >= NEW.work_date LIMIT 1;
  IF v_run IS NOT NULL THEN
    RAISE EXCEPTION 'TEMP_ENGAGEMENT_OVERLAP: % falls inside payroll run % for this worker — the same day cannot be paid twice', NEW.work_date, v_run
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_pte_tw_insert_guard ON public.production_time_entries;
CREATE TRIGGER trg_pte_tw_insert_guard BEFORE INSERT ON public.production_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.tw_time_entry_insert_guard();

-- ── 3. Linking recomputes the planned cost ──────────────────────────────────
-- Assignment row first (same order as record_time_entry), then the engagement. Production's own plan function recomputes
-- planned_labour_cost from the snapshot we just wrote, so the formula is not duplicated here.
CREATE OR REPLACE FUNCTION public.link_assignment_to_engagement(p_assignment uuid, p_engagement uuid, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a record; e record; j record;
BEGIN
  IF p_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO a FROM production_job_assignments WHERE id = p_assignment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found'; END IF;
  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_engagement FOR UPDATE;
  IF NOT FOUND OR e.status <> 'active' THEN RAISE EXCEPTION 'Engagement must be active'; END IF;
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
  -- Empty worker object = keep the planned days, recompute cost from the (new) snapshot. Dates are only read when days are being changed.
  PERFORM production_apply_labour_plan(p_assignment, '{}'::jsonb, NULL::date, NULL::date, p_actor);
  PERFORM tw_log('temp_engagement', p_engagement, 'assignment_linked', 'Assignment ' || p_assignment || ' linked', p_actor);
END $$;

-- ── 5. Bulk due summary ─────────────────────────────────────────────────────
-- One call for a list of engagements. Same figures as temporary_engagement_due(id): { id: {eligible_units, eligible_gross,
-- threshold_units, due, close_out_due} }. Engagements with no eligible work are present with zeros.
CREATE OR REPLACE FUNCTION public.temporary_engagements_due(p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH thr AS (SELECT COALESCE((SELECT settlement_threshold_units FROM temporary_worker_settings WHERE id = true), 3) AS t),
  elig AS (
    SELECT a.temporary_engagement_id AS eid, sum(e.attendance_units) AS u, sum(e.actual_labour_cost) AS g
      FROM production_time_entries e JOIN production_job_assignments a ON a.id = e.assignment_id
     WHERE a.temporary_engagement_id = ANY (p_ids) AND e.status = 'approved' AND e.actual_labour_cost IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.time_entry_id = e.id AND l.active)
     GROUP BY a.temporary_engagement_id)
  SELECT COALESCE(jsonb_object_agg(g.id::text, jsonb_build_object(
           'eligible_units', COALESCE(el.u, 0), 'eligible_gross', COALESCE(el.g, 0), 'threshold_units', (SELECT t FROM thr),
           'due', COALESCE(el.u, 0) >= (SELECT t FROM thr),
           'close_out_due', g.status IN ('completed','cancelled') AND COALESCE(el.u, 0) > 0)), '{}'::jsonb)
    FROM temporary_worker_engagements g LEFT JOIN elig el ON el.eid = g.id
   WHERE g.id = ANY (p_ids)
$$;

-- ── Grants: service_role only ───────────────────────────────────────────────
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND (p.proname LIKE 'tw\_%' OR p.proname IN (
              'create_temporary_engagement','set_engagement_status','revise_engagement_rate','link_assignment_to_engagement',
              'create_payout_sheet','temporary_engagements_due'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
