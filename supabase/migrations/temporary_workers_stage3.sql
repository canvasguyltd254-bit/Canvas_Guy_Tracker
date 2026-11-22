-- ════════════════════════════════════════════════════════════════════════════
-- Temporary workers — Stage 3: pay through ChatPesa (M-Pesa), no cash. Run AFTER stage1, 1b, 1c and stage2. Idempotent.
--
-- Payout sheet lifecycle:   open  →  exported  →  paid        (or cancelled / released)
--   open       the sheet is being built; an admin approves it if it is above the approval limit.
--   exported   the ChatPesa bulk CSV was generated (ONCE: it freezes the rows). The money is released by uploading that CSV in ChatPesa.
--   paid       every row was matched to a real ChatPesa debit from the imported statement.
-- A settlement becomes PAID only when its row matches an imported ChatPesa debit (phone + amount, and the settlement number in the
-- description). A row ChatPesa rejected never appears in the statement, so it stays unpaid and is flagged — it is never assumed paid.
-- The matched debit is taken out of the supplier-allocation queue (marked 'ignored') so accounting does not treat it as a supplier payment.
--
-- Separation of duties kept: the person who releases the payment (exports) cannot be the preparer of any settlement on the sheet.
-- Retired: printing, the signed paper receipt, the receiver-name step and pay_temporary_settlement (cash).
-- Lifted: "one settlement per sheet" (it existed so one signed paper matched one payment). A sheet can now hold several workers,
-- giving ONE ChatPesa upload.
--
-- ORDER: stage1 → 1b → 1c → stage2 → stage3. Do not re-run stage1/1b/1c after this file without re-running stage2 and stage3.
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- Existing printed / signed sheets would be stranded by the new lifecycle. Real use had not started; refuse rather than guess.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.temporary_worker_payout_sheets WHERE status IN ('printed','signed')) THEN
    RAISE EXCEPTION 'Cancel every printed or signed temporary-worker payout sheet before running stage 3 (the cash flow is retired).';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.mark_sheet_printed(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.attach_signed_receipt(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.pay_temporary_settlement(uuid, uuid, text, text, text);
DROP INDEX IF EXISTS public.uq_tws_one_per_sheet;

-- ── Phone normaliser: 9-digit Kenyan mobile without the leading 0 (ChatPesa format), or NULL ──
CREATE OR REPLACE FUNCTION public.tw_normalise_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d ~ '^254[17]\d{8}$' THEN substr(d, 4)
    WHEN d ~ '^0[17]\d{8}$'   THEN substr(d, 2)
    WHEN d ~ '^[17]\d{8}$'    THEN d
    ELSE NULL END
  FROM (SELECT regexp_replace(COALESCE(p, ''), '\D', '', 'g') AS d) x
$$;

-- ── Sheet columns and status rules ──────────────────────────────────────────
ALTER TABLE public.temporary_worker_payout_sheets
  ADD COLUMN IF NOT EXISTS exported_by uuid,
  ADD COLUMN IF NOT EXISTS exported_at timestamptz,
  ADD COLUMN IF NOT EXISTS export_downloads integer NOT NULL DEFAULT 0;

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.temporary_worker_payout_sheets'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%printed%' OR pg_get_constraintdef(oid) ILIKE '%signed%')
  LOOP EXECUTE format('ALTER TABLE public.temporary_worker_payout_sheets DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE public.temporary_worker_payout_sheets DROP CONSTRAINT IF EXISTS tws_sheet_status_values;
ALTER TABLE public.temporary_worker_payout_sheets DROP CONSTRAINT IF EXISTS tws_sheet_status_fields;
ALTER TABLE public.temporary_worker_payout_sheets
  ADD CONSTRAINT tws_sheet_status_values CHECK (status IN ('open','exported','paid','cancelled'));
ALTER TABLE public.temporary_worker_payout_sheets
  ADD CONSTRAINT tws_sheet_status_fields CHECK (
    CASE status
      WHEN 'open'      THEN exported_by IS NULL AND exported_at IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'exported'  THEN exported_by IS NOT NULL AND exported_at IS NOT NULL AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'paid'      THEN exported_by IS NOT NULL AND exported_at IS NOT NULL AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL
      WHEN 'cancelled' THEN cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND NULLIF(btrim(COALESCE(cancel_reason,'')), '') IS NOT NULL
    END);

-- ── Frozen payout rows: exactly what went into the ChatPesa file ────────────
CREATE TABLE IF NOT EXISTS public.temporary_worker_payout_rows (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id                uuid NOT NULL REFERENCES public.temporary_worker_payout_sheets(id),
  settlement_id           uuid NOT NULL REFERENCES public.temporary_worker_settlements(id),
  employee_id             uuid NOT NULL REFERENCES public.employees(id),
  phone                   text NOT NULL CHECK (phone ~ '^[17]\d{8}$'),
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0 AND amount = round(amount)),
  description             text NOT NULL CHECK (description !~ '[,"]' AND btrim(description) <> ''),
  created_at              timestamptz NOT NULL DEFAULT now(),
  chatpesa_transaction_id uuid REFERENCES public.chatpesa_transactions(id),
  match_method            text CHECK (match_method IN ('settlement_ref','phone_amount')),
  confirm_code            text,
  matched_by              uuid,
  matched_at              timestamptz,
  released_by             uuid,
  released_at             timestamptz,
  release_reason          text,
  CONSTRAINT twr_match_fields CHECK ((chatpesa_transaction_id IS NULL) = (matched_at IS NULL)
                                     AND (chatpesa_transaction_id IS NULL) = (match_method IS NULL)
                                     AND (chatpesa_transaction_id IS NULL) = (matched_by IS NULL)),
  CONSTRAINT twr_release_fields CHECK ((released_at IS NULL) = (released_by IS NULL)
                                       AND (released_at IS NULL) = (release_reason IS NULL)
                                       AND (released_at IS NULL OR chatpesa_transaction_id IS NULL))
);
-- A settlement has at most one LIVE row (a released one may be exported again on a new sheet); a bank debit pays at most one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_twr_settlement ON public.temporary_worker_payout_rows (settlement_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_twr_transaction ON public.temporary_worker_payout_rows (chatpesa_transaction_id) WHERE chatpesa_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_twr_sheet ON public.temporary_worker_payout_rows (sheet_id);
ALTER TABLE public.temporary_worker_payout_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.temporary_worker_payout_rows FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.temporary_worker_payout_rows TO service_role;

-- Rows: never deleted; the frozen file contents never change; only matching or releasing may be recorded, once.
CREATE OR REPLACE FUNCTION public.tw_payout_rows_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payout rows are never deleted'; END IF;
  IF (to_jsonb(NEW) - 'chatpesa_transaction_id' - 'match_method' - 'confirm_code' - 'matched_by' - 'matched_at'
                    - 'released_by' - 'released_at' - 'release_reason')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'chatpesa_transaction_id' - 'match_method' - 'confirm_code' - 'matched_by' - 'matched_at'
                    - 'released_by' - 'released_at' - 'release_reason') THEN
    RAISE EXCEPTION 'A payout row cannot be edited';
  END IF;
  IF OLD.chatpesa_transaction_id IS NOT NULL AND (NEW.chatpesa_transaction_id IS DISTINCT FROM OLD.chatpesa_transaction_id OR NEW.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A matched payout row is final';
  END IF;
  IF OLD.released_at IS NOT NULL AND (NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.chatpesa_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A released payout row is final';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_twr_guard ON public.temporary_worker_payout_rows;
CREATE TRIGGER trg_twr_guard BEFORE UPDATE OR DELETE ON public.temporary_worker_payout_rows
  FOR EACH ROW EXECUTE FUNCTION public.tw_payout_rows_guard();

-- ── Sheet guard: open → exported → paid; open/exported → cancelled; paid and cancelled are final ──
CREATE OR REPLACE FUNCTION public.tw_sheets_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payout sheets cannot be deleted'; END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled payout sheet is final: it cannot be reused'; END IF;
  IF OLD.status = 'paid' THEN RAISE EXCEPTION 'A paid payout sheet is final'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'open'     AND NEW.status IN ('exported','cancelled'))
    OR (OLD.status = 'exported' AND NEW.status IN ('paid','cancelled'))) THEN
    RAISE EXCEPTION 'Illegal payout sheet status change % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.sheet_num IS DISTINCT FROM OLD.sheet_num OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Payout sheet identity cannot change';
  END IF;
  IF OLD.status = 'exported' AND (NEW.exported_by IS DISTINCT FROM OLD.exported_by OR NEW.exported_at IS DISTINCT FROM OLD.exported_at) THEN
    RAISE EXCEPTION 'Who exported a sheet, and when, cannot change';
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = OLD.id AND status = 'paid') THEN
    RAISE EXCEPTION 'A payout sheet with a paid settlement cannot be cancelled';
  END IF;
  RETURN NEW;
END $$;

-- ── Settlements: a paid settlement needs an exported sheet; no receiver name any more ──
ALTER TABLE public.temporary_worker_settlements DROP CONSTRAINT IF EXISTS tws_status_fields;
ALTER TABLE public.temporary_worker_settlements
  ADD CONSTRAINT tws_status_fields CHECK (
    CASE status
      WHEN 'draft'    THEN approved_by IS NULL AND approved_at IS NULL AND approved_by_role IS NULL AND NOT approval_override
                           AND payout_sheet_id IS NULL AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'approved' THEN approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by_role IS NOT NULL
                           AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'paid'     THEN approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by_role IS NOT NULL
                           AND payout_sheet_id IS NOT NULL AND paid_by IS NOT NULL AND paid_at IS NOT NULL
                           AND paid_by <> prepared_by
                           AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL
      WHEN 'voided'   THEN voided_by IS NOT NULL AND voided_at IS NOT NULL AND NULLIF(btrim(COALESCE(void_reason,'')), '') IS NOT NULL
                           AND payout_sheet_id IS NULL
    END);

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
    IF v_sheet_status IS DISTINCT FROM 'exported' THEN RAISE EXCEPTION 'Payment needs an exported payout sheet'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── Create a sheet: one or more approved settlements → ONE ChatPesa upload ──
CREATE OR REPLACE FUNCTION public.create_payout_sheet(p_settlement_ids uuid[], p_actor uuid, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ids uuid[]; v_n integer; v_ok integer; v_sheet uuid; v_bad text;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_settlement_ids) x;
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n = 0 THEN RAISE EXCEPTION 'Choose at least one settlement'; END IF;
  IF v_n > 200 THEN RAISE EXCEPTION 'A payout sheet holds at most 200 settlements'; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_ok FROM temporary_worker_settlements WHERE id = ANY (v_ids) AND status = 'approved' AND payout_sheet_id IS NULL;
  IF v_ok <> v_n THEN RAISE EXCEPTION 'Every settlement must be approved, unpaid and not already on a payout sheet'; END IF;
  SELECT string_agg(e.name, ', ' ORDER BY e.name) INTO v_bad
    FROM temporary_worker_settlements s JOIN employees e ON e.id = s.employee_id
   WHERE s.id = ANY (v_ids) AND tw_normalise_phone(e.phone) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'No valid M-Pesa number on file for: %. Add the number to the worker''s employee record (07xx or 01xx) first.', v_bad;
  END IF;
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
  IF sh.status <> 'open' THEN RAISE EXCEPTION 'Only an open payout sheet can be approved (this one is %)', sh.status; END IF;
  UPDATE temporary_worker_payout_sheets SET admin_approved_by = p_actor, admin_approved_at = now() WHERE id = p_id;
  PERFORM tw_log('temp_sheet', p_id, 'admin_approved', 'Payout sheet approved by admin', p_actor);
END $$;

-- Cancel is for a sheet that has not been exported. Once exported, money may be on its way: use release (admin) after matching.
CREATE OR REPLACE FUNCTION public.cancel_payout_sheet(p_id uuid, p_reason text, p_actor uuid, p_role text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required to cancel a payout sheet'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status = 'cancelled' THEN RAISE EXCEPTION 'Payout sheet is already cancelled'; END IF;
  IF sh.status <> 'open' THEN
    RAISE EXCEPTION 'A % payout sheet cannot be cancelled — the ChatPesa file may already have been uploaded. Match the payments, then release any rows that were never paid.', sh.status;
  END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  UPDATE temporary_worker_settlements SET payout_sheet_id = NULL WHERE payout_sheet_id = p_id;
  UPDATE temporary_worker_payout_sheets SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(), cancel_reason = btrim(p_reason) WHERE id = p_id;
  PERFORM tw_log('temp_sheet', p_id, 'cancelled', 'Payout sheet cancelled: ' || btrim(p_reason), p_actor);
END $$;

-- ── Export: freeze the rows and return them for the ChatPesa CSV ────────────
-- First call (sheet open): validates, freezes the rows, marks the sheet exported. Later calls return ONLY rows still unpaid
-- and unreleased (never a paid row again), and are logged: uploading the same file twice pays twice.
CREATE OR REPLACE FUNCTION public.export_payout_sheet(p_id uuid, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record; s record; v_bad text; v_first boolean := false; v_rows jsonb; v_amt numeric; v_n integer := 0;
BEGIN
  IF p_role <> 'admin' THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status NOT IN ('open','exported') THEN RAISE EXCEPTION 'A % payout sheet cannot be exported', sh.status; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id) THEN RAISE EXCEPTION 'The payout sheet is empty'; END IF;
  IF EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND prepared_by = p_actor) THEN
    RAISE EXCEPTION 'You prepared a settlement on this sheet, so someone else must release its payment';
  END IF;

  IF sh.status = 'open' THEN
    IF tw_over_limit(sh.total_net) AND sh.admin_approved_by IS NULL THEN
      RAISE EXCEPTION 'This payout sheet is above the approval limit (or the limit is not set) — an admin must approve it before it is exported';
    END IF;
    IF EXISTS (SELECT 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND status <> 'approved') THEN
      RAISE EXCEPTION 'Every settlement on the sheet must still be approved and unpaid';
    END IF;
    SELECT string_agg(e.name, ', ' ORDER BY e.name) INTO v_bad
      FROM temporary_worker_settlements x JOIN employees e ON e.id = x.employee_id
     WHERE x.payout_sheet_id = p_id AND tw_normalise_phone(e.phone) IS NULL;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'No valid M-Pesa number on file for: %. Add the number to the worker''s employee record first.', v_bad;
    END IF;
    FOR s IN SELECT x.*, e.name AS ename, e.phone AS ephone FROM temporary_worker_settlements x JOIN employees e ON e.id = x.employee_id
              WHERE x.payout_sheet_id = p_id ORDER BY x.settlement_num
    LOOP
      v_amt := round(s.net_amount);
      IF v_amt <= 0 THEN RAISE EXCEPTION 'Settlement % pays less than KES 1 — it cannot go through ChatPesa', s.settlement_num; END IF;
      INSERT INTO temporary_worker_payout_rows (sheet_id, settlement_id, employee_id, phone, amount, description)
      VALUES (p_id, s.id, s.employee_id, tw_normalise_phone(s.ephone), v_amt,
              left(btrim(regexp_replace(regexp_replace(s.ename, '[,"\r\n]+', ' ', 'g'), '\s+', ' ', 'g')), 60) || ' - ' || s.settlement_num);
      v_n := v_n + 1;
    END LOOP;
    UPDATE temporary_worker_payout_sheets SET status = 'exported', exported_by = p_actor, exported_at = now(), export_downloads = 1 WHERE id = p_id;
    v_first := true;
    PERFORM tw_log('temp_sheet', p_id, 'exported', 'ChatPesa file generated for ' || v_n || ' payment(s), KES ' || sh.total_net, p_actor);
  ELSE
    UPDATE temporary_worker_payout_sheets SET export_downloads = export_downloads + 1 WHERE id = p_id;
    PERFORM tw_log('temp_sheet', p_id, 'export_repeated', 'ChatPesa file downloaded again (unpaid rows only)', p_actor);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('settlement_num', st.settlement_num, 'phone', r.phone, 'amount', r.amount, 'description', r.description)
                            ORDER BY st.settlement_num), '[]'::jsonb)
    INTO v_rows
    FROM temporary_worker_payout_rows r JOIN temporary_worker_settlements st ON st.id = r.settlement_id
   WHERE r.sheet_id = p_id AND r.chatpesa_transaction_id IS NULL AND r.released_at IS NULL;
  IF jsonb_array_length(v_rows) = 0 THEN RAISE EXCEPTION 'Every payment on this sheet is already matched or released — there is nothing to export'; END IF;
  RETURN jsonb_build_object('sheet_num', sh.sheet_num, 'first_export', v_first, 'rows', v_rows);
END $$;

-- ── Match: pair each unpaid row with a real ChatPesa debit from the imported statement ──
-- A debit qualifies when it is an unallocated 'debit', for exactly the row's amount, to the row's phone, dated on/after the export day.
-- Tier 1: the settlement number appears in the description.  Tier 2 (only if no tier-1 candidate): a debit with NO settlement
-- number at all in its description (ChatPesa did not echo ours). More than one candidate = ambiguous: left unpaid, reported.
CREATE OR REPLACE FUNCTION public.match_payout_sheet(p_id uuid, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sh record; r record; s record; t record; v_since date; v_c uuid[]; v_method text;
  n_match integer := 0; n_pending integer := 0; v_amb text[] := '{}'; v_miss text[] := '{}'; v_left integer;
BEGIN
  IF NOT tw_is_run_role(p_role) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  -- Matching a sheet that is already fully paid is harmless (someone else matched it first): report it rather than fail.
  IF sh.status = 'paid' THEN
    RETURN jsonb_build_object('matched', 0, 'pending', 0, 'ambiguous', '[]'::jsonb, 'not_found', '[]'::jsonb, 'sheet_status', 'paid');
  END IF;
  IF sh.status <> 'exported' THEN RAISE EXCEPTION 'Only an exported payout sheet can be matched (this one is %)', sh.status; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  v_since := (sh.exported_at AT TIME ZONE 'Africa/Nairobi')::date;

  FOR r IN SELECT * FROM temporary_worker_payout_rows
            WHERE sheet_id = p_id AND chatpesa_transaction_id IS NULL AND released_at IS NULL ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO s FROM temporary_worker_settlements WHERE id = r.settlement_id;
    v_c := NULL; v_method := NULL;

    SELECT array_agg(x.id) INTO v_c FROM chatpesa_transactions x
     WHERE x.tx_type = 'debit' AND x.match_status = 'unmatched' AND x.amount = r.amount AND x.transaction_date >= v_since
       AND tw_normalise_phone(x.account_number) = r.phone
       AND COALESCE(x.description, '') ILIKE '%' || s.settlement_num || '%'
       AND NOT EXISTS (SELECT 1 FROM temporary_worker_payout_rows o WHERE o.chatpesa_transaction_id = x.id);
    IF COALESCE(array_length(v_c, 1), 0) = 1 THEN v_method := 'settlement_ref';
    ELSIF COALESCE(array_length(v_c, 1), 0) > 1 THEN
      v_amb := v_amb || s.settlement_num; CONTINUE;
    ELSE
      SELECT array_agg(x.id) INTO v_c FROM chatpesa_transactions x
       WHERE x.tx_type = 'debit' AND x.match_status = 'unmatched' AND x.amount = r.amount AND x.transaction_date >= v_since
         AND tw_normalise_phone(x.account_number) = r.phone
         AND COALESCE(x.description, '') !~* 'TW-[0-9]{4}-[0-9]{4}'
         AND NOT EXISTS (SELECT 1 FROM temporary_worker_payout_rows o WHERE o.chatpesa_transaction_id = x.id);
      IF COALESCE(array_length(v_c, 1), 0) = 1 THEN v_method := 'phone_amount';
      ELSIF COALESCE(array_length(v_c, 1), 0) > 1 THEN v_amb := v_amb || s.settlement_num; CONTINUE;
      ELSE v_miss := v_miss || s.settlement_num; n_pending := n_pending + 1; CONTINUE;
      END IF;
    END IF;

    SELECT * INTO t FROM chatpesa_transactions WHERE id = v_c[1] FOR UPDATE;
    IF t.match_status <> 'unmatched' THEN v_miss := v_miss || s.settlement_num; n_pending := n_pending + 1; CONTINUE; END IF;
    UPDATE chatpesa_transactions SET match_status = 'ignored', ignored_at = now(), ignored_by = p_actor WHERE id = t.id;
    UPDATE temporary_worker_payout_rows SET chatpesa_transaction_id = t.id, match_method = v_method, confirm_code = t.confirm_code,
           matched_by = p_actor, matched_at = now() WHERE id = r.id;
    UPDATE temporary_worker_settlements SET status = 'paid', paid_by = sh.exported_by, paid_at = now(),
           payment_note = NULLIF('M-Pesa ' || COALESCE(t.confirm_code, ''), 'M-Pesa ') WHERE id = s.id;
    PERFORM tw_log('temp_settlement', s.id, 'paid', 'Paid by M-Pesa via ChatPesa: KES ' || r.amount || ' to ' || r.phone
                   || COALESCE(' (' || t.confirm_code || ')', '') || ' — matched by ' || replace(v_method, '_', ' '), p_actor);
    n_match := n_match + 1;
  END LOOP;
  n_pending := n_pending + COALESCE(array_length(v_amb, 1), 0);

  SELECT count(*) INTO v_left FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND status <> 'paid';
  IF v_left = 0 THEN
    UPDATE temporary_worker_payout_sheets SET status = 'paid' WHERE id = p_id;
    PERFORM tw_log('temp_sheet', p_id, 'paid', 'Every payment on the sheet was matched in the ChatPesa statement', p_actor);
  END IF;
  RETURN jsonb_build_object('matched', n_match, 'pending', n_pending, 'ambiguous', to_jsonb(v_amb), 'not_found', to_jsonb(v_miss),
                            'sheet_status', CASE WHEN v_left = 0 THEN 'paid' ELSE 'exported' END);
END $$;

-- ── Release: admin closes out rows that were never paid (ChatPesa rejected them, or the file was never uploaded) ──
-- The settlements go back to "approved" with no sheet, so they can be put on a new one. Matched rows are untouched.
CREATE OR REPLACE FUNCTION public.release_unpaid_payout_rows(p_id uuid, p_reason text, p_actor uuid, p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE sh record; v_n integer; v_paid integer;
BEGIN
  IF p_role <> 'admin' THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF tw_blank(p_reason) THEN RAISE EXCEPTION 'A reason is required to release unpaid payments'; END IF;
  SELECT * INTO sh FROM temporary_worker_payout_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout sheet not found'; END IF;
  IF sh.status <> 'exported' THEN RAISE EXCEPTION 'Only an exported payout sheet can have rows released (this one is %)', sh.status; END IF;
  PERFORM 1 FROM temporary_worker_settlements WHERE payout_sheet_id = p_id ORDER BY id FOR UPDATE;
  UPDATE temporary_worker_payout_rows SET released_by = p_actor, released_at = now(), release_reason = btrim(p_reason)
   WHERE sheet_id = p_id AND chatpesa_transaction_id IS NULL AND released_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'There are no unpaid rows to release'; END IF;
  UPDATE temporary_worker_settlements SET payout_sheet_id = NULL
   WHERE payout_sheet_id = p_id AND status = 'approved';
  PERFORM tw_recompute_sheet(p_id);
  SELECT count(*) INTO v_paid FROM temporary_worker_settlements WHERE payout_sheet_id = p_id AND status = 'paid';
  IF v_paid > 0 THEN
    UPDATE temporary_worker_payout_sheets SET status = 'paid' WHERE id = p_id;
  ELSE
    UPDATE temporary_worker_payout_sheets SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(),
           cancel_reason = 'No payment matched; released: ' || btrim(p_reason) WHERE id = p_id;
  END IF;
  PERFORM tw_log('temp_sheet', p_id, 'released', v_n || ' unpaid payment(s) released: ' || btrim(p_reason), p_actor);
  RETURN jsonb_build_object('released', v_n, 'paid_remaining', v_paid);
END $$;

-- ── Void: a settlement on an exported sheet cannot be voided (its money may be on the way) ──
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
  -- Nested on purpose: PL/pgSQL does not short-circuit AND, and `sh` is unassigned when the settlement is on no sheet.
  IF v_sheet IS NOT NULL THEN
    IF sh.status = 'exported' THEN
      RAISE EXCEPTION 'This settlement is on an exported payout sheet — the ChatPesa file may already be uploaded. Match the payments and release the unpaid rows first';
    END IF;
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
              'create_payout_sheet','approve_payout_sheet','cancel_payout_sheet','export_payout_sheet','match_payout_sheet',
              'release_unpaid_payout_rows','void_temporary_settlement'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
