-- New employees stay inactive until an admin approves their onboarding request.
-- Managers' edits to approved employees also require approval, except activation/deactivation.
-- Apply before deploying the API; existing employee creation will fail closed during the cutover.
--
-- Also closes a pre-existing gap: `employees` had RLS disabled and no revoked grants, so any signed-in
-- browser session could read or write it directly through the Supabase API, bypassing every API
-- role check. All application access to employees goes through server routes (service_role), so
-- browser roles are locked out here.
--
-- Safe to re-run.

BEGIN;

-- ── 1. Lock employees (and the payroll audit log) away from browser roles ───
ALTER TABLE public.employees           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_activities  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employees          FROM anon, authenticated;
REVOKE ALL ON public.payroll_activities FROM anon, authenticated;
REVOKE ALL ON public.employees, public.payroll_activities FROM PUBLIC;
REVOKE INSERT ON public.employees FROM service_role;

-- Existing staff keep their eligibility. Only the brokered onboarding RPC can insert staff
-- from the application; the database owner can still maintain/import records explicitly.
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS onboarding_status text NOT NULL DEFAULT 'approved';
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_onboarding_valid;
ALTER TABLE public.employees ADD CONSTRAINT employees_onboarding_valid CHECK (
  onboarding_status IN ('pending', 'approved', 'rejected') AND (NOT is_active OR onboarding_status = 'approved')
);
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_pay_values_valid;
ALTER TABLE public.employees ADD CONSTRAINT employees_pay_values_valid CHECK (
  day_rate BETWEEN 0 AND 99999999.99 AND monthly_salary BETWEEN 0 AND 99999999.99
  AND piece_rate BETWEEN 0 AND 99999999.99 AND sha_amount BETWEEN 0 AND 99999999.99
) NOT VALID;

-- ── 2. Requests ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.employee_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  -- {"phone": {"old": "0712…", "new": "0799…"}, "day_rate": {"old": 1000, "new": 1200}}
  changes           jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb),
  reason            text  NOT NULL CHECK (length(btrim(reason)) >= 3),
  status            text  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
  requested_by      uuid,
  requested_by_name text,
  requested_by_role text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid,
  decided_by_name   text,
  decided_at        timestamptz,
  decision_note     text
);
CREATE INDEX IF NOT EXISTS idx_emp_change_requests_status   ON public.employee_change_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_emp_change_requests_employee ON public.employee_change_requests(employee_id);
ALTER TABLE public.employee_change_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'edit';
ALTER TABLE public.employee_change_requests DROP CONSTRAINT IF EXISTS employee_change_requests_kind_check;
ALTER TABLE public.employee_change_requests ADD CONSTRAINT employee_change_requests_kind_check CHECK (kind IN ('edit', 'onboarding'));
ALTER TABLE public.employee_change_requests DROP CONSTRAINT IF EXISTS employee_change_requests_employee_id_fkey;
ALTER TABLE public.employee_change_requests ADD CONSTRAINT employee_change_requests_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_one_onboarding ON public.employee_change_requests(employee_id) WHERE kind = 'onboarding';

ALTER TABLE public.employee_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_change_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.employee_change_requests TO service_role;

CREATE OR REPLACE FUNCTION public.submit_employee_onboarding(p_fields jsonb, p_actor uuid, p_name text, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v public.employees%ROWTYPE;
  e public.employees%ROWTYPE;
  v_changes jsonb;
BEGIN
  v := jsonb_populate_record(NULL::public.employees, p_fields);
  IF v.name IS NULL OR btrim(v.name) = '' THEN RAISE EXCEPTION 'INVALID_FIELD: name'; END IF;
  INSERT INTO public.employees (
    employee_num, name, type, day_rate, monthly_salary, piece_rate, sha_amount,
    nssf_number, id_number, phone, bank_account, bank_name, bank_branch, paybill_number, hire_date, notes,
    created_by, is_active, onboarding_status
  ) VALUES (
    public.next_employee_num(), v.name, v.type, v.day_rate, v.monthly_salary, v.piece_rate, v.sha_amount,
    v.nssf_number, v.id_number, v.phone, v.bank_account, v.bank_name, v.bank_branch, v.paybill_number, v.hire_date, v.notes,
    p_actor, false, 'pending'
  ) RETURNING * INTO e;
  SELECT jsonb_object_agg(key, jsonb_build_object('old', NULL, 'new', value))
    INTO v_changes FROM jsonb_each(p_fields);
  INSERT INTO public.employee_change_requests (employee_id, changes, reason, requested_by, requested_by_name, requested_by_role, kind)
  VALUES (e.id, v_changes, 'New employee — verify identity, pay and payment details', p_actor, p_name, p_role, 'onboarding');
  INSERT INTO public.payroll_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('employee', e.id, 'created', format('Employee %s submitted for approval by %s (%s)', e.employee_num, p_name, p_role), p_actor);
  RETURN to_jsonb(e);
END $$;
REVOKE ALL ON FUNCTION public.submit_employee_onboarding(jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_employee_onboarding(jsonb, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_payroll_employee_onboarding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = NEW.employee_id AND onboarding_status = 'approved' FOR SHARE) THEN
    RAISE EXCEPTION 'EMPLOYEE_ONBOARDING_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payroll_employee_onboarding ON public.payroll_entries;
CREATE TRIGGER trg_payroll_employee_onboarding BEFORE INSERT OR UPDATE OF employee_id ON public.payroll_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_employee_onboarding();

-- ── 3. Approve: re-check, apply, log — atomically ───────────────────────────
CREATE OR REPLACE FUNCTION public.approve_employee_change(
  p_request_id uuid, p_decided_by uuid, p_decided_by_name text, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_req      public.employee_change_requests%ROWTYPE;
  v_emp      public.employees%ROWTYPE;
  v_allowed  constant text[] := ARRAY['name','type','day_rate','monthly_salary','piece_rate','sha_amount',
                                      'nssf_number','id_number','phone','bank_account','bank_name',
                                      'bank_branch','paybill_number','hire_date','notes'];
  v_numeric  constant text[] := ARRAY['day_rate','monthly_salary','piece_rate','sha_amount'];
  v_key      text;
  v_stale    boolean := false;
  v_cur      text;
  v_old      text;
  v_new_vals jsonb;
  v_set      text;
BEGIN
  SELECT * INTO v_req FROM public.employee_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'NOT_PENDING: this request is already %', v_req.status; END IF;

  SELECT * INTO v_emp FROM public.employees WHERE id = v_req.employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'EMPLOYEE_NOT_FOUND'; END IF;

  IF v_req.kind = 'onboarding' THEN
    IF v_emp.onboarding_status <> 'pending' THEN RAISE EXCEPTION 'NOT_PENDING'; END IF;
    UPDATE public.employees SET onboarding_status = 'approved', is_active = true WHERE id = v_emp.id;
  ELSE
  IF v_emp.onboarding_status <> 'approved' THEN RAISE EXCEPTION 'EMPLOYEE_ONBOARDING_REQUIRED'; END IF;

  FOR v_key IN SELECT jsonb_object_keys(v_req.changes) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN RAISE EXCEPTION 'INVALID_FIELD: %', v_key; END IF;

    -- The request was written against the old value. If someone changed it since, do not overwrite blindly.
    v_cur := to_jsonb(v_emp) ->> v_key;
    v_old := v_req.changes -> v_key ->> 'old';
    IF v_key = ANY (v_numeric) THEN
      IF NULLIF(v_cur, '')::numeric IS DISTINCT FROM NULLIF(v_old, '')::numeric THEN
        v_stale := true;
        EXIT;
      END IF;
    ELSIF COALESCE(v_cur, '') IS DISTINCT FROM COALESCE(v_old, '') THEN
      v_stale := true;
      EXIT;
    END IF;
  END LOOP;

  IF v_stale THEN
    UPDATE public.employee_change_requests
      SET status = 'stale', decided_by = p_decided_by, decided_by_name = p_decided_by_name,
          decided_at = now(), decision_note = 'Employee record changed since this was requested'
      WHERE id = p_request_id;
    RETURN jsonb_build_object('request_id', p_request_id, 'status', 'stale');
  END IF;

  SELECT jsonb_object_agg(k, v_req.changes -> k -> 'new'),
         string_agg(format('%I = r.%I', k, k), ', ')
    INTO v_new_vals, v_set
    FROM jsonb_object_keys(v_req.changes) AS k;

  EXECUTE format(
    'UPDATE public.employees e SET %s FROM (SELECT * FROM jsonb_populate_record(NULL::public.employees, $1)) r WHERE e.id = $2',
    v_set) USING v_new_vals, v_req.employee_id;
  END IF;

  UPDATE public.employee_change_requests
     SET status = 'approved', decided_by = p_decided_by, decided_by_name = p_decided_by_name,
         decided_at = now(), decision_note = p_note
   WHERE id = p_request_id;

  INSERT INTO public.payroll_activities (entity_type, entity_id, activity_type, description, old_value, new_value, created_by)
  VALUES ('employee', v_req.employee_id, 'change_approved',
          format('Change to %s %s approved by %s (requested by %s): %s',
                 v_emp.employee_num, v_emp.name, COALESCE(p_decided_by_name, 'admin'),
                 COALESCE(v_req.requested_by_name, 'unknown'),
                 (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_req.changes) AS k)),
          (SELECT jsonb_object_agg(k, v_req.changes -> k -> 'old')::text FROM jsonb_object_keys(v_req.changes) AS k),
          v_new_vals::text, p_decided_by);

  RETURN jsonb_build_object('request_id', p_request_id, 'employee_id', v_req.employee_id, 'applied', v_new_vals);
END;
$$;

-- ── 4. Reject ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_employee_change(
  p_request_id uuid, p_decided_by uuid, p_decided_by_name text, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.employee_change_requests%ROWTYPE;
  v_emp public.employees%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM public.employee_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'NOT_PENDING: this request is already %', v_req.status; END IF;
  SELECT * INTO v_emp FROM public.employees WHERE id = v_req.employee_id;

  IF length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'NOTE_REQUIRED'; END IF;
  IF v_req.kind = 'onboarding' THEN
    UPDATE public.employees SET onboarding_status = 'rejected', is_active = false
      WHERE id = v_req.employee_id AND onboarding_status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_PENDING'; END IF;
  END IF;

  UPDATE public.employee_change_requests
     SET status = 'rejected', decided_by = p_decided_by, decided_by_name = p_decided_by_name,
         decided_at = now(), decision_note = p_note
   WHERE id = p_request_id;

  INSERT INTO public.payroll_activities (entity_type, entity_id, activity_type, description, created_by)
  VALUES ('employee', v_req.employee_id, 'change_rejected',
          format('Change to %s %s rejected by %s (requested by %s)%s',
                 v_emp.employee_num, v_emp.name, COALESCE(p_decided_by_name, 'admin'),
                 COALESCE(v_req.requested_by_name, 'unknown'),
                 CASE WHEN p_note IS NULL OR p_note = '' THEN '' ELSE ': ' || p_note END),
          p_decided_by);

  RETURN jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.approve_employee_change(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_employee_change(uuid, uuid, text, text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_employee_change(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_employee_change(uuid, uuid, text, text)  TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
