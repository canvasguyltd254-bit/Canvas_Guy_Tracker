-- ════════════════════════════════════════════════════════════════════════════
-- Temporary workers — Stage 1d. Run AFTER stage1, 1b and 1c. Idempotent.
--
-- Adds assign_engagement_worker(): put ONE temporary worker on a project's job stage and link the new assignment to
-- their engagement in a single transaction, so the user never has to leave the Temporary workers screen.
--
-- Why not reuse production's assign_workers_to_stage()? It takes the WHOLE desired group for a job/stage/operation and
-- marks every worker not in the list as Removed. Calling it with one worker would silently remove the other workers
-- already on that operation. This function only ever ADDS one assignment and respects the group's existing mode
-- (working_together = same quantity for all; split_quantity = quantities must still add up to the job quantity).
--
-- Lock order is unchanged: job row → (new assignment) → link_assignment_to_engagement (assignment → run lock → employee
-- locks → engagement). Who can call it: admin and production manager, the same as linking.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION public.assign_engagement_worker(
  p_engagement uuid, p_job uuid, p_stage uuid, p_operation uuid, p_quantity integer,
  p_start date, p_end date, p_hours numeric, p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e record; v_job record; v_stage record; v_new uuid;
  v_mode text; v_cnt integer; v_sum integer; v_first integer;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('admin','production_manager') THEN RAISE EXCEPTION 'Not allowed'; END IF;

  SELECT * INTO e FROM temporary_worker_engagements WHERE id = p_engagement;
  IF NOT FOUND THEN RAISE EXCEPTION 'Engagement not found'; END IF;
  IF e.status <> 'active' THEN RAISE EXCEPTION 'Engagement must be active'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = e.employee_id AND is_active) THEN
    RAISE EXCEPTION 'This worker is inactive';
  END IF;

  SELECT * INTO v_job FROM production_jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  IF v_job.order_id IS DISTINCT FROM e.order_id THEN RAISE EXCEPTION 'That job belongs to a different project than this engagement'; END IF;
  IF v_job.status IN ('Cancelled','Completed') THEN RAISE EXCEPTION 'Cannot assign workers on a % job', lower(v_job.status); END IF;

  SELECT * INTO v_stage FROM production_job_stages WHERE id = p_stage AND job_id = p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage does not belong to this job'; END IF;
  IF NOT v_stage.is_enabled THEN RAISE EXCEPTION 'Stage "%" is disabled for this job', v_stage.stage_label; END IF;
  IF NOT EXISTS (SELECT 1 FROM production_operations WHERE id = p_operation AND stage_key = v_stage.stage_key AND is_active) THEN
    RAISE EXCEPTION 'That operation is not available for the % stage', v_stage.stage_label;
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Enter a quantity above 0'; END IF;
  IF p_quantity > v_job.planned_quantity THEN
    RAISE EXCEPTION 'Quantity (%) cannot exceed the job quantity (%)', p_quantity, v_job.planned_quantity;
  END IF;
  IF p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
    RAISE EXCEPTION 'Planned start and end dates are required and the end cannot be before the start';
  END IF;
  IF EXTRACT(DOW FROM p_start) = 0 OR EXTRACT(DOW FROM p_end) = 0 THEN RAISE EXCEPTION 'Assignment dates cannot fall on a Sunday'; END IF;
  IF p_hours IS NULL OR p_hours <= 0 OR p_hours > 12 THEN RAISE EXCEPTION 'Hours per day must be between 0 and 12'; END IF;

  IF EXISTS (SELECT 1 FROM production_job_assignments
              WHERE job_id = p_job AND stage_id = p_stage AND operation_id = p_operation
                AND employee_id = e.employee_id AND status IN ('Assigned','In Progress')) THEN
    RAISE EXCEPTION 'This worker is already assigned to that operation — link the existing assignment instead';
  END IF;

  -- Respect the group that is already on this operation.
  SELECT count(*), COALESCE(sum(assigned_quantity), 0), min(assigned_quantity), min(assignment_mode)
    INTO v_cnt, v_sum, v_first, v_mode
    FROM production_job_assignments
   WHERE job_id = p_job AND stage_id = p_stage AND operation_id = p_operation AND status IN ('Assigned','In Progress');
  v_mode := COALESCE(v_mode, 'working_together');
  IF v_cnt > 0 THEN
    IF v_mode = 'working_together' AND p_quantity <> v_first THEN
      RAISE EXCEPTION 'Workers on this operation work together, so the quantity must match the others (%)', v_first;
    END IF;
    IF v_mode = 'split_quantity' AND v_sum + p_quantity > v_job.planned_quantity THEN
      RAISE EXCEPTION 'Quantities on this operation would add up to % — more than the % planned for the job', v_sum + p_quantity, v_job.planned_quantity;
    END IF;
  END IF;

  INSERT INTO production_job_assignments
    (job_id, employee_id, operation_id, assigned_quantity, assigned_by, status,
     stage_id, assignment_mode, planned_start_date, planned_end_date, planned_hours_per_day)
  VALUES (p_job, e.employee_id, p_operation, p_quantity, p_actor, 'Assigned',
          p_stage, v_mode, p_start, p_end, p_hours)
  RETURNING id INTO v_new;
  INSERT INTO production_assignment_events (assignment_id, job_id, event, new_values, actor)
  VALUES (v_new, p_job, 'created',
          jsonb_build_object('employee_id', e.employee_id, 'assigned_quantity', p_quantity, 'assignment_mode', v_mode,
                             'planned_start_date', p_start, 'planned_end_date', p_end, 'planned_hours_per_day', p_hours,
                             'source', 'temporary_engagement'), p_actor);

  -- Links, snapshots the agreed rate and recomputes the planned cost. Any refusal rolls the new assignment back too.
  PERFORM link_assignment_to_engagement(v_new, p_engagement, p_actor, p_role);
  PERFORM tw_log('temp_engagement', p_engagement, 'assignment_created', 'Assigned to job ' || p_job || ', stage ' || p_stage, p_actor);
  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION public.assign_engagement_worker(uuid,uuid,uuid,uuid,integer,date,date,numeric,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_engagement_worker(uuid,uuid,uuid,uuid,integer,date,date,numeric,uuid,text) TO service_role;

COMMIT;
