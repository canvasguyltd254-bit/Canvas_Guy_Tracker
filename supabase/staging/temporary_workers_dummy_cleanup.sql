-- ════════════════════════════════════════════════════════════════════════════
-- Temporary Workers — DUMMY DATA CLEANUP  (STAGING ONLY)
--
-- Removes everything tied to the dummy workers (EMP-TST-%) and the dummy project (TST-TW-%), including
-- anything you created on them through the UI: days present, settlements, deductions, payout sheets, and the
-- activity-log rows, plus any production plan/jobs/stages/assignments/time entries built on the dummy project.
--
-- The guard triggers deliberately block DELETE on paid/approved records, so this script switches USER triggers
-- off for the affected tables inside ONE transaction and back on at the end. If anything fails (for example a
-- table I did not know references these rows), the whole transaction rolls back and nothing is deleted or left
-- with triggers disabled. Needs the table owner role (the Supabase SQL editor's postgres role is fine).
--
-- Only rows reachable from the dummy workers / dummy project are deleted. Real data is not touched, but run the
-- PREVIEW at the bottom first and read the counts.
-- ════════════════════════════════════════════════════════════════════════════
begin;

-- Triggers off (restored below, still inside this transaction)
alter table temporary_worker_engagements          disable trigger user;
alter table temporary_worker_settlements          disable trigger user;
alter table temporary_worker_settlement_lines     disable trigger user;
alter table temporary_worker_settlement_deductions disable trigger user;
alter table temporary_worker_payout_sheets        disable trigger user;
alter table temporary_worker_attendance           disable trigger user;
alter table production_time_entries               disable trigger user;
alter table production_job_assignments            disable trigger user;

create temp table _tw_emp  on commit drop as select id from employees where employee_num like 'EMP-TST-%';
create temp table _tw_ord  on commit drop as select id from orders    where order_num    like 'TST-TW-%';
create temp table _tw_eng  on commit drop as
  select id from temporary_worker_engagements
   where employee_id in (select id from _tw_emp) or order_id in (select id from _tw_ord);
create temp table _tw_set  on commit drop as
  select id, payout_sheet_id from temporary_worker_settlements
   where engagement_id in (select id from _tw_eng) or employee_id in (select id from _tw_emp);
create temp table _tw_job  on commit drop as select id from production_jobs where order_id in (select id from _tw_ord);
create temp table _tw_asg  on commit drop as
  select id from production_job_assignments
   where job_id in (select id from _tw_job)
      or employee_id in (select id from _tw_emp)
      or temporary_engagement_id in (select id from _tw_eng);

-- Settlement tree
delete from temporary_worker_settlement_lines      where settlement_id in (select id from _tw_set);
delete from temporary_worker_settlement_deductions where settlement_id in (select id from _tw_set);
delete from temporary_worker_settlements           where id in (select id from _tw_set);
delete from temporary_worker_payout_sheets
 where id in (select payout_sheet_id from _tw_set where payout_sheet_id is not null);

-- Days present (stage 2), then anything built in Production for the dummy project
delete from temporary_worker_attendance where engagement_id in (select id from _tw_eng) or employee_id in (select id from _tw_emp);

delete from production_time_entries    where assignment_id in (select id from _tw_asg)
                                          or employee_id in (select id from _tw_emp)
                                          or job_id in (select id from _tw_job);
delete from production_job_assignments where id in (select id from _tw_asg);
delete from production_job_stages      where job_id in (select id from _tw_job);
delete from production_jobs            where id in (select id from _tw_job);
delete from production_plans           where order_id in (select id from _tw_ord);

-- Engagements (self-reference via supersedes_id is fine in a single statement)
delete from temporary_worker_engagements where id in (select id from _tw_eng);

-- Activity log rows written by the temporary-workers functions
delete from payroll_activities
 where entity_id in (select id from _tw_eng)
    or entity_id in (select id from _tw_set)
    or entity_id in (select payout_sheet_id from _tw_set where payout_sheet_id is not null);

-- Project and workers last
delete from order_items where order_id in (select id from _tw_ord);
delete from orders      where id in (select id from _tw_ord);
delete from employees   where id in (select id from _tw_emp);

-- Triggers back on
alter table temporary_worker_engagements          enable trigger user;
alter table temporary_worker_settlements          enable trigger user;
alter table temporary_worker_settlement_lines     enable trigger user;
alter table temporary_worker_settlement_deductions enable trigger user;
alter table temporary_worker_payout_sheets        enable trigger user;
alter table temporary_worker_attendance           enable trigger user;
alter table production_time_entries               enable trigger user;
alter table production_job_assignments            enable trigger user;

-- Verify: all four must be 0, and no trigger may be left disabled
select
  (select count(*) from employees where employee_num like 'EMP-TST-%')                         as workers_left,
  (select count(*) from orders    where order_num    like 'TST-TW-%')                           as orders_left,
  (select count(*) from temporary_worker_engagements e
     where not exists (select 1 from employees x where x.id = e.employee_id))                    as orphan_engagements,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname in ('temporary_worker_engagements','temporary_worker_settlements','temporary_worker_settlement_lines',
                         'temporary_worker_settlement_deductions','temporary_worker_payout_sheets',
                         'production_time_entries','production_job_assignments','temporary_worker_attendance')
       and not t.tgisinternal and t.tgenabled = 'D')                                             as triggers_still_disabled;

commit;

-- ── PREVIEW (run this BEFORE the script above; it deletes nothing) ──────────
-- select 'workers' what, count(*) from employees where employee_num like 'EMP-TST-%'
-- union all select 'orders', count(*) from orders where order_num like 'TST-TW-%'
-- union all select 'engagements', count(*) from temporary_worker_engagements
--            where employee_id in (select id from employees where employee_num like 'EMP-TST-%')
-- union all select 'settlements', count(*) from temporary_worker_settlements
--            where employee_id in (select id from employees where employee_num like 'EMP-TST-%')
-- union all select 'time entries', count(*) from production_time_entries
--            where job_id in (select id from production_jobs where order_id in (select id from orders where order_num like 'TST-TW-%'));
