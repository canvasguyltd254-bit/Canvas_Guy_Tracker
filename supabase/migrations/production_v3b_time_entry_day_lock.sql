-- ─────────────────────────────────────────────────────────────────────────────
-- production_v3b_time_entry_day_lock.sql
--
-- Corrective migration for production_v3a_labour_costing.sql (which stays unchanged).
--
-- Problem: record_time_entry locks the assignment and job rows, but the "a worker's day cannot
-- exceed 1.00" check reads rows across ALL jobs. Two simultaneous entries for the same worker
-- on different jobs could both pass the check and book more than one day (double overtime /
-- Sunday allowance).
--
-- Fix: serialise bookings per (employee, work_date) with a transaction-scoped advisory lock
-- taken before the check. The lock is released automatically at commit/rollback.
--
-- Safe to run more than once (CREATE OR REPLACE). Same signature, same grants as v3a.
-- Requires: production_v3a_labour_costing.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_time_entry(
  p_assignment_id   uuid,
  p_work_date       date,
  p_units           numeric,
  p_has_overtime    boolean,
  p_overtime_reason text,
  p_notes           text,
  p_submit          boolean,
  p_actor           uuid,
  p_today           date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  a record; j record; st record; s record; r jsonb;
  v_ot boolean := COALESCE(p_has_overtime, false);
  v_sun boolean; v_daily numeric; v_otr numeric; v_sunr numeric; v_cost numeric; v_other numeric; v_id uuid;
  v_ot_other boolean;
BEGIN
  SELECT * INTO s FROM production_labour_settings WHERE id = true;
  IF p_work_date IS NULL THEN RAISE EXCEPTION 'work_date is required'; END IF;
  IF p_today IS NOT NULL AND p_work_date > p_today THEN RAISE EXCEPTION 'Time cannot be recorded for a future date'; END IF;
  IF p_units IS NULL OR p_units <= 0 THEN RAISE EXCEPTION 'Enter the share of the day worked on this job'; END IF;
  IF p_units > 1 THEN RAISE EXCEPTION 'A worker cannot give more than one day (1.00) to a job in a day'; END IF;
  v_sun := EXTRACT(DOW FROM p_work_date) = 0;
  IF v_sun AND v_ot THEN RAISE EXCEPTION 'Sunday is a flat Sunday rate — the overtime allowance does not apply'; END IF;
  IF v_ot AND s.require_overtime_reason AND NULLIF(btrim(COALESCE(p_overtime_reason,'')), '') IS NULL THEN
    RAISE EXCEPTION 'Overtime needs a reason';
  END IF;

  SELECT * INTO a FROM production_job_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found'; END IF;
  IF a.status NOT IN ('Assigned','In Progress','Completed') THEN
    RAISE EXCEPTION 'Time cannot be booked to a % assignment', lower(a.status);
  END IF;
  SELECT * INTO j FROM production_jobs WHERE id = a.job_id FOR UPDATE;
  IF j.status = 'Cancelled' THEN RAISE EXCEPTION 'Job is cancelled'; END IF;
  IF j.status = 'Completed' THEN RAISE EXCEPTION 'Job is completed — reopen it before recording time'; END IF;
  SELECT * INTO st FROM production_job_stages WHERE id = a.stage_id;
  IF st.id IS NULL OR NOT st.is_enabled THEN RAISE EXCEPTION 'Time cannot be booked to a disabled stage'; END IF;

  -- Serialise every booking for this worker-day, across ALL jobs: the row locks above are per assignment/job,
  -- so two simultaneous entries on different jobs could each pass the 1.00 check below without this.
  PERFORM pg_advisory_xact_lock(hashtext('time_entry:' || a.employee_id::text || ':' || p_work_date::text));

  -- The same worker's day, across ALL jobs, cannot add up to more than one day; and the
  -- overtime flag is a property of the day, so every entry for that day must agree.
  SELECT COALESCE(sum(attendance_units), 0), bool_or(has_overtime) INTO v_other, v_ot_other
    FROM production_time_entries
   WHERE employee_id = a.employee_id AND work_date = p_work_date AND status IN ('draft','submitted','approved');
  IF v_other + p_units > 1 THEN
    RAISE EXCEPTION 'That worker already has % of a day booked on % — a day cannot exceed 1.00', v_other, p_work_date;
  END IF;
  IF v_ot_other IS NOT NULL AND v_ot_other <> v_ot THEN
    RAISE EXCEPTION 'Overtime applies to the whole day: other entries for that worker on % are marked %', p_work_date,
      CASE WHEN v_ot_other THEN 'with overtime' ELSE 'without overtime' END;
  END IF;
  IF EXISTS (SELECT 1 FROM production_time_entries WHERE assignment_id = p_assignment_id AND work_date = p_work_date
              AND status IN ('draft','submitted','approved')) THEN
    RAISE EXCEPTION 'There is already an entry for this assignment on % — void it first to correct it', p_work_date;
  END IF;

  -- Rate snapshot: the assignment's snapshot wins; otherwise take one now and store it there too.
  v_daily := a.daily_rate_snapshot; v_otr := a.overtime_rate_snapshot; v_sunr := a.sunday_rate_snapshot;
  IF v_daily IS NULL OR v_otr IS NULL OR v_sunr IS NULL THEN
    r := public.production_employee_rates(a.employee_id);
    IF v_daily IS NULL THEN v_daily := NULLIF(r->>'daily','')::numeric; END IF;
    IF v_otr   IS NULL THEN v_otr   := NULLIF(r->>'overtime_allowance','')::numeric; END IF;
    IF v_sunr  IS NULL THEN v_sunr  := NULLIF(r->>'sunday_rate','')::numeric; END IF;
    UPDATE production_job_assignments SET daily_rate_snapshot = v_daily, overtime_rate_snapshot = v_otr, sunday_rate_snapshot = v_sunr,
           rate_snapshot_at = COALESCE(rate_snapshot_at, now())
     WHERE id = a.id;
  END IF;
  v_cost := public.production_labour_cost(p_units, v_ot, v_sun, v_daily, v_otr, v_sunr);

  INSERT INTO production_time_entries
    (job_id, stage_id, operation_id, assignment_id, employee_id, work_date, attendance_units, has_overtime, is_sunday,
     daily_rate_snapshot, overtime_rate_snapshot, sunday_rate_snapshot, actual_labour_cost,
     overtime_reason, notes, status, recorded_by, submitted_at)
  VALUES (a.job_id, a.stage_id, a.operation_id, a.id, a.employee_id, p_work_date, p_units, v_ot, v_sun,
          v_daily, v_otr, v_sunr, v_cost,
          CASE WHEN v_ot THEN NULLIF(btrim(COALESCE(p_overtime_reason,'')), '') END, NULLIF(btrim(COALESCE(p_notes,'')), ''),
          CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END, p_actor, CASE WHEN p_submit THEN now() END)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'status', CASE WHEN p_submit THEN 'submitted' ELSE 'draft' END,
                            'is_sunday', v_sun, 'rate_missing', v_cost IS NULL);
END;
$$;


REVOKE ALL ON FUNCTION public.record_time_entry(uuid, date, numeric, boolean, text, text, boolean, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_time_entry(uuid, date, numeric, boolean, text, text, boolean, uuid, date) TO service_role;
