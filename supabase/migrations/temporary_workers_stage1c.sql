-- ════════════════════════════════════════════════════════════════════════════
-- Temporary workers — Stage 1c (small corrective). Run AFTER stage1 and stage1b. Idempotent.
--
-- The due-summary functions also report total attendance, so the optional "maximum days" guide can warn.
--   total_units       non-voided attendance (draft + submitted + approved) on this worker's engagements for this
--                     project, across rate revisions. NOT the unsettled amount: it must not drop after payment.
--   max_days          the engagement's optional guide
--   max_days_reached  max_days is set and total_units >= max_days (a warning only; nothing is blocked)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.temporary_engagement_due(p_engagement uuid, p_cutoff date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_units numeric; v_gross numeric; v_thr numeric; v_status text; v_total numeric; v_max numeric; v_emp uuid; v_order uuid;
BEGIN
  SELECT status, max_days, employee_id, order_id INTO v_status, v_max, v_emp, v_order FROM temporary_worker_engagements WHERE id = p_engagement;
  SELECT settlement_threshold_units INTO v_thr FROM temporary_worker_settings WHERE id = true;
  SELECT COALESCE(sum(e.attendance_units), 0), COALESCE(sum(e.actual_labour_cost), 0) INTO v_units, v_gross
    FROM production_time_entries e JOIN production_job_assignments a ON a.id = e.assignment_id
   WHERE a.temporary_engagement_id = p_engagement AND e.status = 'approved' AND e.actual_labour_cost IS NOT NULL
     AND (p_cutoff IS NULL OR e.work_date <= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.time_entry_id = e.id AND l.active);
  SELECT COALESCE(sum(t.attendance_units), 0) INTO v_total
    FROM production_time_entries t JOIN production_job_assignments a ON a.id = t.assignment_id
    JOIN temporary_worker_engagements s ON s.id = a.temporary_engagement_id
   WHERE s.employee_id = v_emp AND s.order_id = v_order AND t.status IN ('draft','submitted','approved');
  RETURN jsonb_build_object('eligible_units', v_units, 'eligible_gross', v_gross, 'threshold_units', v_thr,
    'due', v_units >= COALESCE(v_thr, 3), 'close_out_due', v_status IN ('completed','cancelled') AND v_units > 0,
    'total_units', v_total, 'max_days', v_max, 'max_days_reached', v_max IS NOT NULL AND v_total >= v_max);
END $$;

CREATE OR REPLACE FUNCTION public.temporary_engagements_due(p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH thr AS (SELECT COALESCE((SELECT settlement_threshold_units FROM temporary_worker_settings WHERE id = true), 3) AS t),
  elig AS (
    SELECT a.temporary_engagement_id AS eid, sum(e.attendance_units) AS u, sum(e.actual_labour_cost) AS g
      FROM production_time_entries e JOIN production_job_assignments a ON a.id = e.assignment_id
     WHERE a.temporary_engagement_id = ANY (p_ids) AND e.status = 'approved' AND e.actual_labour_cost IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_settlement_lines l WHERE l.time_entry_id = e.id AND l.active)
     GROUP BY a.temporary_engagement_id),
  tot AS (
    SELECT g.id AS eid, sum(t.attendance_units) AS u
      FROM temporary_worker_engagements g
      JOIN temporary_worker_engagements s ON s.employee_id = g.employee_id AND s.order_id = g.order_id
      JOIN production_job_assignments a ON a.temporary_engagement_id = s.id
      JOIN production_time_entries t ON t.assignment_id = a.id AND t.status IN ('draft','submitted','approved')
     WHERE g.id = ANY (p_ids)
     GROUP BY g.id)
  SELECT COALESCE(jsonb_object_agg(g.id::text, jsonb_build_object(
           'eligible_units', COALESCE(el.u, 0), 'eligible_gross', COALESCE(el.g, 0), 'threshold_units', (SELECT t FROM thr),
           'due', COALESCE(el.u, 0) >= (SELECT t FROM thr),
           'close_out_due', g.status IN ('completed','cancelled') AND COALESCE(el.u, 0) > 0,
           'total_units', COALESCE(tt.u, 0), 'max_days', g.max_days,
           'max_days_reached', g.max_days IS NOT NULL AND COALESCE(tt.u, 0) >= g.max_days)), '{}'::jsonb)
    FROM temporary_worker_engagements g
    LEFT JOIN elig el ON el.eid = g.id
    LEFT JOIN tot tt ON tt.eid = g.id
   WHERE g.id = ANY (p_ids)
$$;

REVOKE ALL ON FUNCTION public.temporary_engagement_due(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.temporary_engagement_due(uuid, date) TO service_role;
REVOKE ALL ON FUNCTION public.temporary_engagements_due(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.temporary_engagements_due(uuid[]) TO service_role;

COMMIT;
