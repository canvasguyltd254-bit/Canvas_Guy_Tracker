-- ════════════════════════════════════════════════════════════════════════════
-- Temporary Workers — DUMMY DATA SEED  (STAGING ONLY — do not run on production data you care about)
--
-- Creates, all tagged so temporary_workers_dummy_cleanup.sql can remove them:
--   • 5 dummy workers          employee_num  EMP-TST-001 … EMP-TST-005   (names start "DUMMY")
--   • 1 dummy project (order)  order_num     TST-TW-001, client "DUMMY Client – delete me"
--   • 3 engagements, created through the real create_temporary_engagement():
--       EMP-TST-001  active   KES 1,500/day, started 7 days ago, max 20 days
--       EMP-TST-002  active   KES 2,000/day, started 7 days ago      (a second worker for multi-worker checks)
--       EMP-TST-003  planned  KES 1,800/day, starts in 3 days
--     EMP-TST-004 and EMP-TST-005 have NO engagement — use them to try "New engagement" in the UI.
--
-- It does NOT create days present, settlements or payout sheets. Do those through the real screens
-- (Payroll → Temporary workers) so the real rules and approvals are exercised. See the walkthrough at the bottom.
--
-- Safe to re-run: existing dummy rows are reused, not duplicated.
-- Requires: stage1, stage1b, stage1c and stage2 applied, and at least one row in auth.users.
-- ════════════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  v_actor uuid;
  v_order uuid;
  v_emp   uuid;
  r       record;
begin
  -- payroll_activities.created_by references auth.users, so the actor must be a real user.
  select id into v_actor from auth.users order by created_at limit 1;
  if v_actor is null then raise exception 'No row in auth.users — sign in to the app once first.'; end if;

  -- Workers
  insert into employees (employee_num, name, type, day_rate, is_active) values
    ('EMP-TST-001', 'DUMMY Mwangi (temp)',  'casual', 1500, true),
    ('EMP-TST-002', 'DUMMY Achieng (temp)', 'casual', 2000, true),
    ('EMP-TST-003', 'DUMMY Otieno (temp)',  'casual', 1800, true),
    ('EMP-TST-004', 'DUMMY Wambui (temp)',  'casual', 1500, true),
    ('EMP-TST-005', 'DUMMY Kamau (temp)',   'casual', 1500, true)
  on conflict (employee_num) do nothing;

  -- Project
  insert into orders (order_num, client, notes)
  values ('TST-TW-001', 'DUMMY Client – delete me', 'Staging data for temporary workers. Safe to delete.')
  on conflict (order_num) do nothing;
  select id into v_order from orders where order_num = 'TST-TW-001';

  -- Engagements (skipped if the worker already has a non-cancelled one on this project)
  for r in
    select * from (values
      ('EMP-TST-001', 1500::numeric, current_date - 7, null::date, 20::numeric, true,  'Dummy: active, capped at 20 days'),
      ('EMP-TST-002', 2000::numeric, current_date - 7, null::date, null::numeric, true,  'Dummy: active, no cap'),
      ('EMP-TST-003', 1800::numeric, current_date + 3, current_date + 10, null::numeric, false, 'Dummy: planned, not yet started')
    ) as t(num, rate, s, e, mx, act, note)
  loop
    select id into v_emp from employees where employee_num = r.num;
    if not exists (select 1 from temporary_worker_engagements
                    where employee_id = v_emp and order_id = v_order and status in ('planned','active')) then
      perform create_temporary_engagement(v_emp, v_order, r.rate, r.s, r.e, r.mx, r.note, r.act, v_actor, 'admin');
    end if;
  end loop;
end $$;

-- Check what was created
select e.engagement_num, emp.employee_num, emp.name, e.status, e.agreed_daily_rate, e.start_date, e.max_days
  from temporary_worker_engagements e
  join employees emp on emp.id = e.employee_id
 where emp.employee_num like 'EMP-TST-%'
 order by emp.employee_num;

commit;

-- ── Walkthrough to stage the rest through the real screens ──────────────────
-- 1. Payroll → Temporary workers → Engagements → open DUMMY Mwangi (active) → "Days present": tap Full / Half on the days
--    he came (as one user, e.g. head of sales). Nothing here involves Production.
-- 2. Mark 3+ days → the worker appears under "Due". Prepare the settlement (as the same user).
-- 3. Approve it as a DIFFERENT user (not the preparer, not whoever marked the days). Above KES 10,000 an admin approves.
-- 4. Create the payout sheet, print, attach a photo of the signed copy, then mark paid (payer is not the preparer).
-- 5. Try the edge cases: a deduction (damage is OFF by default), a day before the start date or in the future (refused),
--    a day marked twice (changes it), clearing a day that is already in a settlement (refused), the max-days warning on
--    EMP-TST-001 (20 days), marking days on the planned engagement EMP-TST-003 (refused until activated).
-- When finished: run temporary_workers_dummy_cleanup.sql.
