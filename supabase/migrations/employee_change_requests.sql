-- Employee change requests: Head of Sales / Production Manager may ADD employees, but any change
-- to an existing employee (rate, phone, bank/paybill, SHA, NSSF, name ...) is a REQUEST that only
-- an admin can approve. Approval applies the change and logs it, in one transaction.
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

ALTER TABLE public.employee_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_change_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.employee_change_requests TO service_role;   -- never DELETE: it is the audit trail

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

  FOR v_key IN SELECT jsonb_object_keys(v_req.changes) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN RAISE EXCEPTION 'INVALID_FIELD: %', v_key; END IF;

    -- The request was written against the old value. If someone changed it since, do not overwrite blindly.
    v_cur := to_jsonb(v_emp) ->> v_key;
    v_old := v_req.changes -> v_key ->> 'old';
    IF v_key = ANY (v_numeric) THEN
      IF NULLIF(v_cur, '')::numeric IS DISTINCT FROM NULLIF(v_old, '')::numeric THEN
        RAISE EXCEPTION 'STALE_REQUEST: % has changed since this was requested', v_key;
      END IF;
    ELSIF COALESCE(v_cur, '') IS DISTINCT FROM COALESCE(v_old, '') THEN
      RAISE EXCEPTION 'STALE_REQUEST: % has changed since this was requested', v_key;
    END IF;
  END LOOP;

  SELECT jsonb_object_agg(k, v_req.changes -> k -> 'new'),
         string_agg(format('%I = r.%I', k, k), ', ')
    INTO v_new_vals, v_set
    FROM jsonb_object_keys(v_req.changes) AS k;

  EXECUTE format(
    'UPDATE public.employees e SET %s FROM (SELECT * FROM jsonb_populate_record(NULL::public.employees, $1)) r WHERE e.id = $2',
    v_set) USING v_new_vals, v_req.employee_id;

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
