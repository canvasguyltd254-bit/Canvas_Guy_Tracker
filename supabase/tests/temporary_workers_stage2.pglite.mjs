// Database tests for the temporary-workers migrations (stage1, 1b, 1c, 2). Spec: docs/specs/temporary-workers.md
//
// Runs the REAL payroll_module.sql, production_v3a/v3b and temporary_workers_stage1, 1b, 1c, 2 against an in-process Postgres (pglite).
// Only the Production parent tables (jobs, stages, operations, assignments) are minimal stubs.
//
// Stage 2 model: a temporary worker is engaged for ONE project at an agreed rate; days present are marked on the engagement
// (Full = 1, Half = 0.5) by head of sales / production manager / admin; settlements are built from those days.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/temporary_workers_stage2.pglite.mjs
//
// NOT covered here: true concurrency (pglite is single-connection). See supabase/tests/temporary_workers_concurrency.mjs.


import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');
const here = dirname(fileURLToPath(import.meta.url));
const mig = f => readFileSync(join(here, '../migrations', f), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const throws = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
};
const q = (sql, p) => db.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];
const val = async (sql, p) => { const r = await one(sql, p); return r ? Object.values(r)[0] : null; };
const call = async (name, ...args) => (await one(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).r;
const arr = ids => '{' + ids.join(',') + '}';

// ── schema ──────────────────────────────────────────────────────────────────
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE production_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'Planned', order_id uuid NOT NULL REFERENCES orders(id));
  CREATE TABLE production_job_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_key text, stage_label text, is_enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE production_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_key text, is_active boolean DEFAULT true);
  CREATE TABLE production_job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_id uuid REFERENCES production_job_stages(id), operation_id uuid REFERENCES production_operations(id), employee_id uuid, status text NOT NULL DEFAULT 'Assigned');
`);
await db.exec(mig('payroll_module.sql'));
await db.exec(`ALTER TABLE production_job_assignments ADD CONSTRAINT fk_emp FOREIGN KEY (employee_id) REFERENCES employees(id);`);
await db.exec(mig('production_v3a_labour_costing.sql'));
await db.exec(mig('production_v3b_time_entry_day_lock.sql'));
await db.exec(mig('temporary_workers_stage1.sql'));
// Stage 1 is already applied in production with the DEFAULT damage setting of true; capture that state before 1b.
const damageBefore1b = await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`);
await db.exec(mig('temporary_workers_stage1b.sql'));
await db.exec(mig('temporary_workers_stage1c.sql'));
await db.exec(mig('temporary_workers_stage2.sql'));
ok('migrations apply on top of the real payroll and production v3a/v3b migrations', true);
ok('stage 1 shipped with damage deductions ON (the state 1b corrects)', damageBefore1b === true);
ok('stage 1b flips the untouched settings row to OFF', (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === false);
ok('stage 1b: the column default is now false', (await val(`SELECT column_default FROM information_schema.columns WHERE table_name='temporary_worker_settings' AND column_name='damage_deductions_enabled'`)) === 'false');
const runAll = async () => { for (const f of ['temporary_workers_stage1.sql', 'temporary_workers_stage1b.sql', 'temporary_workers_stage1c.sql', 'temporary_workers_stage2.sql']) await db.exec(mig(f)); };
ok('migrations are idempotent when re-run in order (second run of all four)', await runAll().then(() => true, e => { console.log(e.message); return false; }));
ok('re-running does not re-enable damage deductions', (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === false);
ok('stage 2 retired the Production link: no link function, no time-entry triggers',
  Number(await val(`SELECT count(*) FROM pg_proc WHERE proname IN ('link_assignment_to_engagement','tw_time_entry_insert_guard','tw_time_entry_void_guard','assign_engagement_worker')`)) === 0
  && Number(await val(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_pte_tw_insert_guard','trg_pte_tw_void_guard')`)) === 0);
ok('tw_today() is the Nairobi calendar day', (await val(`SELECT tw_today() = (now() AT TIME ZONE 'Africa/Nairobi')::date`)) === true);
// The fixtures use fixed November 2026 dates; pin "today" far ahead so they are valid whatever the real date is.
// The "future day" rule is tested below with its own pinned date.
const pinToday = (d) => db.exec(`CREATE OR REPLACE FUNCTION public.tw_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT '${d}'::date $$;`);
await pinToday('2099-12-31');


// ── actors and fixtures ─────────────────────────────────────────────────────
const user = async () => (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const admin = await user(), admin2 = await user(), pmRec = await user(), pmApp = await user(), hos1 = await user(), hos2 = await user(), pmPay = await user();
const ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const OTHER_ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const JOB = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [ORDER])).id;
const OTHER_JOB = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [OTHER_ORDER])).id;
const STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [JOB])).id;
const OTHER_STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [OTHER_JOB])).id;
const OP = (await one(`INSERT INTO production_operations (stage_key) VALUES ('cut') RETURNING id`)).id;

let n = 100;
const rates = new Map();
const worker = async (rate = 1000, active = true) => {
  const id = (await one(
    `INSERT INTO employees (employee_num, name, type, day_rate, is_active) VALUES ($1,$2,'casual',$3,$4) RETURNING id`,
    [`EMP-${++n}`, `Worker ${n}`, rate, active])).id;
  rates.set(id, rate); return id;
};
// The engagement's agreed rate (not the employee's day rate) drives the cost; default it to the worker's rate.
const engage = async (emp, o = {}) => call('create_temporary_engagement', emp, o.order || ORDER, o.rate ?? rates.get(emp) ?? 1000, o.start || '2026-11-02', o.end || null, null, null, true, o.actor || hos1, o.role || 'head_of_sales');

// Attendance is marked on the engagement itself (no Production assignment). `assign` stays as an alias so fixtures read the same.
const assign = async (emp, eng) => eng;
const W = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
const SUNDAY = '2026-11-08';
const markDays = (eng, days, actor = pmRec, role = 'production_manager') => call('mark_temporary_attendance', eng, JSON.stringify(days), actor, role);
// Mark Full days (or o.units) and return the attendance ids. The marker defaults to pmRec.
const book = async (eng, dates, o = {}) => {
  await markDays(eng, dates.map(d => ({ date: d, units: o.units ?? 1 })), o.recorder || pmRec, o.role || 'production_manager');
  return (await q(`SELECT id FROM temporary_worker_attendance WHERE engagement_id=$1 AND active AND work_date = ANY($2::date[]) ORDER BY work_date`, [eng, '{' + dates.join(',') + '}'])).rows.map(r => r.id);
};
const clearDay = (eng, date, actor = admin, role = 'admin') => markDays(eng, [{ date, units: 0 }], actor, role);
const mkRun = async (num, start, end = null) => (await one(
  `INSERT INTO payroll_runs (run_num, period_type, period_start, period_end, run_type) VALUES ($1,'weekly',$2::date,COALESCE($3::date,$2::date + 6),'casual') RETURNING id`, [num, start, end])).id;
const addEntry = (run, emp) => q(`INSERT INTO payroll_entries (run_id, employee_id, snapshot_name, snapshot_type, snapshot_sha, gross_pay, net_pay) VALUES ($1,$2,'x','casual',0,1000,1000)`, [run, emp]);

const prep = (eng, cutoff, kind = 'threshold', reason = null, actor = hos1, role = 'head_of_sales') =>
  call('prepare_temporary_settlement', eng, cutoff, kind, reason, actor, role);
const approve = (id, actor = hos2, role = 'head_of_sales', ov = null) => call('approve_temporary_settlement', id, actor, role, ov);
const sheetFor = (ids, actor = hos1, role = 'head_of_sales') => call('create_payout_sheet', arr(ids), actor, role);
const signedSheet = async (ids, adminOk = false) => {
  const sh = await sheetFor(ids);
  if (adminOk) await call('approve_payout_sheet', sh, admin, 'admin');
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  await call('attach_signed_receipt', sh, 'receipts/sheet.jpg', hos1, 'head_of_sales');
  return sh;
};
const pay = (id, actor = pmPay, role = 'production_manager', name = 'Jane Wanjiru', note = null) => call('pay_temporary_settlement', id, actor, role, name, note);
const st = id => val(`SELECT status FROM temporary_worker_settlements WHERE id=$1`, [id]);
const resetSettings = () => q(`UPDATE temporary_worker_settings SET admin_approval_limit_kes=10000, settlement_threshold_units=3, rolling_window_days=7, deduction_single_limit_kes=1000, deduction_total_pct=25, damage_deductions_enabled=true`);
// A ready approved settlement of N days for a fresh worker.
const approved = async (days = 3, rate = 1000) => {
  const emp = await worker(rate); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, days));
  const p = await prep(eng, '2026-11-30');
  await approve(p.id);
  return { emp, eng, a, id: p.id, p };
};


// ════════════════════════════════════════════════════════════════════════════
// Engagements
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1500);
  const eng = await engage(emp, { rate: 1500 });
  ok('head of sales can create an engagement', !!eng);
  await throws('production_staff cannot create an engagement', () => engage(emp, { role: 'production_staff' }), /Not allowed/);
  await throws('unknown worker gets the "ask an administrator" message', () => call('create_temporary_engagement', '00000000-0000-0000-0000-000000000000', ORDER, 1000, '2026-11-02', null, null, null, true, hos1, 'head_of_sales'), /Ask an administrator to register this worker/);
  const inactive = await worker(1000, false);
  await throws('inactive worker cannot be engaged', () => engage(inactive), /Ask an administrator/);
  await throws('second active engagement for the same worker and project refused', () => engage(emp), /uq_twe_active_per_worker_order|duplicate key/);
  await throws('non-positive rate refused', async () => engage(await worker(), { rate: 0 }), /rate must be above 0/);
  await throws('engagement rate cannot be edited in place', () => q(`UPDATE temporary_worker_engagements SET agreed_daily_rate = 2000 WHERE id=$1`, [eng]), /cannot change/);

  const v2 = await call('revise_engagement_rate', eng, 1800, 'Agreed a higher rate', hos1, 'head_of_sales');
  ok('rate revision closes the old version and opens version 2', (await val(`SELECT status FROM temporary_worker_engagements WHERE id=$1`, [eng])) === 'completed'
    && Number(await val(`SELECT version FROM temporary_worker_engagements WHERE id=$1`, [v2])) === 2
    && (await val(`SELECT supersedes_id FROM temporary_worker_engagements WHERE id=$1`, [v2])) === eng);
  await throws('a closed engagement is frozen', () => q(`UPDATE temporary_worker_engagements SET expected_end_date='2027-01-01' WHERE id=$1`, [eng]), /closed/);
  await throws('closing needs a reason', async () => call('set_engagement_status', v2, 'cancelled', '  ', hos1, 'head_of_sales'), /reason is required/);
}


// ── overlap with ordinary payroll (both directions) ─────────────────────────
{
  const mkRun = async (num, start) => (await one(
    `INSERT INTO payroll_runs (run_num, period_type, period_start, period_end, run_type) VALUES ($1,'weekly',$2::date,($2::date + 6),'casual') RETURNING id`, [num, start])).id;
  const addEntry = (run, emp) => q(`INSERT INTO payroll_entries (run_id, employee_id, snapshot_name, snapshot_type, snapshot_sha, gross_pay, net_pay) VALUES ($1,$2,'x','casual',0,1000,1000)`, [run, emp]);
  const inRun = await worker(); const run1 = await mkRun('PR-A', '2026-11-02'); await addEntry(run1, inRun);
  await throws('engagement refused when the worker is in an overlapping payroll run', () => engage(inRun, { start: '2026-11-05' }), /TEMP_ENGAGEMENT_OVERLAP/);
  const e2 = await engage(inRun, { start: '2026-12-01' });
  ok('engagement after the payroll period is allowed', !!e2);
  const eng = await worker(); await engage(eng, { start: '2026-11-02', end: '2026-11-30' });
  const run2 = await mkRun('PR-B', '2026-11-09');
  await throws('worker with an active engagement cannot join an overlapping payroll run (DB trigger)', () => addEntry(run2, eng), /TEMP_ENGAGEMENT_OVERLAP/);
  const run3 = await mkRun('PR-C', '2026-10-05');
  await addEntry(run3, eng); ok('same worker can join a payroll run outside the engagement dates', true);
  const planned = await worker();
  await call('create_temporary_engagement', planned, ORDER, 1000, '2026-11-02', '2026-11-30', null, null, false, hos1, 'head_of_sales');
  const run4 = await mkRun('PR-D', '2026-11-16');
  await throws('a planned engagement also blocks the payroll run', () => addEntry(run4, planned), /TEMP_ENGAGEMENT_OVERLAP/);
}

// ════════════════════════════════════════════════════════════════════════════
// Marking days present (stage 2)
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1000); const eng = await engage(emp, { start: '2026-11-02', end: '2026-11-06' });
  const r = await markDays(eng, [{ date: '2026-11-02', units: 1 }, { date: '2026-11-03', units: 0.5 }], hos1, 'head_of_sales');
  ok('marks a Full and a Half day in one call', r.marked === 2 && r.changed === 0 && r.cleared === 0 && Number(await val(`SELECT sum(units) FROM temporary_worker_attendance WHERE engagement_id=$1 AND active`, [eng])) === 1.5, JSON.stringify(r));
  ok('each day records who marked it', (await val(`SELECT marked_by FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-02'`, [eng])) === hos1);
  const same = await markDays(eng, [{ date: '2026-11-02', units: 1 }], hos1, 'head_of_sales');
  ok('marking a day again with the same value changes nothing', same.marked === 0 && same.changed === 0 && Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1`, [eng])) === 2);
  const chg = await markDays(eng, [{ date: '2026-11-03', units: 1 }], pmRec, 'production_manager');
  ok('changing Half to Full voids the old row and writes a new one (history kept)', chg.changed === 1
    && Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03'`, [eng])) === 2
    && /Changed from 0.5 to 1/.test(await val(`SELECT void_reason FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03' AND NOT active`, [eng]))
    && (await val(`SELECT marked_by FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03' AND active`, [eng])) === pmRec);
  const clr = await markDays(eng, [{ date: '2026-11-03', units: 0 }], admin, 'admin');
  ok('units 0 clears the day (voided, who and why recorded)', clr.cleared === 1 && Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03' AND active`, [eng])) === 0
    && (await val(`SELECT voided_by FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03' AND NOT active AND void_reason LIKE 'Cleared%'`, [eng])) === admin);
  const noop = await markDays(eng, [{ date: '2026-11-04', units: 0 }], admin, 'admin');
  ok('clearing a day that was never marked is a harmless no-op', noop.cleared === 0 && noop.marked === 0);
  await markDays(eng, [{ date: '2026-11-03', units: 1 }], pmRec, 'production_manager');
  ok('a cleared day can be marked again', Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-03' AND active`, [eng])) === 1);

  await throws('production_staff cannot mark days', () => markDays(eng, [{ date: '2026-11-05', units: 1 }], hos1, 'production_staff'), /Not allowed/);
  await throws('no role cannot mark days', () => markDays(eng, [{ date: '2026-11-05', units: 1 }], hos1, null), /Not allowed/);
  await markDays(eng, [{ date: '2026-11-05', units: 1 }], admin, 'admin'); ok('admin can mark days', true);
  await throws('an empty list is refused', () => markDays(eng, []), /at least one day/);
  await throws('a non-list is refused', () => call('mark_temporary_attendance', eng, JSON.stringify({ date: '2026-11-05' }), pmRec, 'production_manager'), /at least one day/);
  await throws('a malformed date is refused', () => markDays(eng, [{ date: '11/05/2026', units: 1 }]), /valid date/);
  await throws('an impossible date (30 Feb) is refused', () => markDays(eng, [{ date: '2026-02-30', units: 1 }]), /valid date/);
  await throws('a missing date is refused', () => markDays(eng, [{ units: 1 }]), /valid date/);
  for (const bad of [0.75, 2, -1, 'x'])
    await throws(`units ${JSON.stringify(bad)} is refused (Full 1, Half 0.5 or clear 0 only)`, () => markDays(eng, [{ date: '2026-11-05', units: bad }]), /Full \(1\), Half \(0\.5\) or cleared \(0\)/);
  await throws('the same day twice in one call is refused', () => markDays(eng, [{ date: '2026-11-04', units: 1 }, { date: '2026-11-04', units: 0.5 }]), /listed twice/);
  await throws('more than 62 days in one call is refused', () => markDays(eng, Array.from({ length: 63 }, () => ({ date: '2026-11-04', units: 1 }))), /at most 62/);
  await throws('unknown engagement is refused', () => markDays('00000000-0000-0000-0000-000000000000', [{ date: '2026-11-04', units: 1 }]), /Engagement not found/);
  ok('a refused call leaves nothing behind', Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date='2026-11-04'`, [eng])) === 0);

  await markDays(eng, [{ date: '2026-11-09', units: 1 }]);
  ok('expected end date is a guide only: a day AFTER it (9 Nov vs 6 Nov) is accepted while the engagement is active', true);
  await throws('a day BEFORE the engagement start is refused', () => markDays(eng, [{ date: '2026-10-30', units: 1 }]), /before the engagement started/);

  // future days: pin "today" to a known date
  await pinToday('2026-11-10');
  await markDays(eng, [{ date: '2026-11-10', units: 1 }]); ok('today can be marked', true);
  await throws('tomorrow is refused: a day can only be marked once it has happened', () => markDays(eng, [{ date: '2026-11-11', units: 1 }]), /in the future/);
  await pinToday('2099-12-31');

  // direct SQL (the database is the last line of defence)
  await throws('direct SQL cannot give a day to a worker who is not the engagement\'s worker', async () => {
    const other = await worker(); await q(`INSERT INTO temporary_worker_attendance (engagement_id, employee_id, work_date, units, marked_by) VALUES ($1,$2,'2026-11-06',1,$3)`, [eng, other, pmRec]);
  }, /does not match the engagement/);
  await throws('direct SQL cannot mark a second active row for the same day (unique)', () => q(`INSERT INTO temporary_worker_attendance (engagement_id, employee_id, work_date, units, marked_by) VALUES ($1,$2,'2026-11-02',1,$3)`, [eng, emp, pmRec]), /uq_twa_employee_day_active|duplicate key/);
  await throws('direct SQL cannot use a 0.75 day (CHECK)', () => q(`INSERT INTO temporary_worker_attendance (engagement_id, employee_id, work_date, units, marked_by) VALUES ($1,$2,'2026-11-06',0.75,$3)`, [eng, emp, pmRec]), /units/);
  await throws('attendance is never deleted', () => q(`DELETE FROM temporary_worker_attendance WHERE engagement_id=$1`, [eng]), /never deleted/);
  await throws('a recorded day cannot be edited (units)', () => q(`UPDATE temporary_worker_attendance SET units=0.5 WHERE engagement_id=$1 AND work_date='2026-11-02'`, [eng]), /cannot be edited/);
  await throws('a recorded day cannot be edited (who marked it)', () => q(`UPDATE temporary_worker_attendance SET marked_by=$2 WHERE engagement_id=$1 AND work_date='2026-11-02'`, [eng, admin]), /cannot be edited/);
  await throws('a voided day is final (cannot be un-voided)', () => q(`UPDATE temporary_worker_attendance SET active=true, voided_by=NULL, voided_at=NULL, void_reason=NULL WHERE engagement_id=$1 AND NOT active`, [eng]), /voided day is final/);
  await throws('voiding without who/when/why is rejected (CHECK)', () => q(`UPDATE temporary_worker_attendance SET active=false WHERE engagement_id=$1 AND work_date='2026-11-02'`, [eng]), /twa_void_fields/);

  // engagement status
  const planned = await call('create_temporary_engagement', await worker(), ORDER, 1000, '2026-11-02', null, null, null, false, hos1, 'head_of_sales');
  await throws('a PLANNED engagement cannot have days marked', () => markDays(planned, [{ date: '2026-11-03', units: 1 }]), /is planned, so days can no longer be marked/);
  const e2 = await engage(await worker()); await call('set_engagement_status', e2, 'completed', 'Done', hos1, 'head_of_sales');
  await throws('a COMPLETED engagement cannot have days marked', () => markDays(e2, [{ date: '2026-11-03', units: 1 }]), /is completed, so days can no longer be marked/);
  const e3 = await engage(await worker()); await call('set_engagement_status', e3, 'cancelled', 'Client cancelled', hos1, 'head_of_sales');
  await throws('a CANCELLED engagement cannot have days marked', () => markDays(e3, [{ date: '2026-11-03', units: 1 }]), /is cancelled, so days can no longer be marked/);

  // payroll: the same day cannot be both temporary attendance and payroll
  const emp4 = await worker(1000);
  const run = await mkRun('PR-ATT', '2026-11-02'); await addEntry(run, emp4);     // 2–8 Nov payroll
  const eng4 = (await one(`INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, status) VALUES ($1,$2,1000,'2026-11-01','active') RETURNING id`, [emp4, ORDER])).id;
  await throws('a day inside the worker\'s own payroll run is refused', () => markDays(eng4, [{ date: '2026-11-03', units: 1 }]), /falls inside payroll run PR-ATT/);
  await markDays(eng4, [{ date: '2026-11-10', units: 1 }]);
  ok('...while a day outside that run is accepted', true);

  // a rate revision: the old version's day cannot be re-marked under the new version
  const emp5 = await worker(1000); const e5 = await engage(emp5, { rate: 1000 });
  await markDays(e5, [{ date: '2026-11-02', units: 1 }]);
  const e5b = await call('revise_engagement_rate', e5, 1500, 'Raise agreed', hos1, 'head_of_sales');
  await throws('an old version refuses new days (it is closed)', () => markDays(e5, [{ date: '2026-11-03', units: 1 }]), /is completed, so days can no longer be marked/);
  await throws('a day marked under the old version cannot be marked again under the new one', () => markDays(e5b, [{ date: '2026-11-02', units: 1 }]), /before the engagement started|already marked under another version/);
  const v2start = await val(`SELECT start_date::text FROM temporary_worker_engagements WHERE id=$1`, [e5b]);
  await markDays(e5b, [{ date: v2start, units: 1 }]);
  ok('the new version accepts days from its own start date', true);
}


// ════════════════════════════════════════════════════════════════════════════
// Due calculation and preparing a settlement
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, W.slice(0, 2));
  let due = await call('temporary_engagement_due', eng);
  ok('2 days: not due, KES 2,000', Number(due.eligible_units) === 2 && due.due === false && Number(due.eligible_gross) === 2000);
  await throws('threshold settlement refused below 3 days', () => prep(eng, '2026-11-30'), /threshold is/);
  await throws('early settlement needs a reason', () => prep(eng, '2026-11-30', 'early', ' '), /needs a reason/);
  await throws('close-out refused while the engagement is active', () => prep(eng, '2026-11-30', 'close_out'), /completed or cancelled/);
  await book(eng, [W[2]], { units: 0.5 });
  due = await call('temporary_engagement_due', eng);
  ok('2.5 days: not due', Number(due.eligible_units) === 2.5 && due.due === false && Number(due.eligible_gross) === 2500);
  await throws('2.5 days cannot be settled as a threshold settlement', () => prep(eng, '2026-11-30'), /threshold is/);
  await book(eng, [W[3]], { units: 0.5 });
  due = await call('temporary_engagement_due', eng);
  ok('3 days (two halves count): due', Number(due.eligible_units) === 3 && due.due === true && Number(due.eligible_gross) === 3000);
  await book(eng, [W[4]], { units: 0.5 });
  const p = await prep(eng, '2026-11-30');
  ok('3.5 days: ALL included in one settlement (no day split or skipped)', Number(p.units) === 3.5 && p.lines === 5, JSON.stringify(p));
  const s = await one(`SELECT * FROM temporary_worker_settlements WHERE id=$1`, [p.id]);
  ok('settlement figures: gross 3500, net 3500, draft, flat rate (no overtime / Sunday parts)', Number(s.gross_amount) === 3500 && Number(s.net_amount) === 3500 && s.status === 'draft'
    && Number(s.overtime_amount) === 0 && Number(s.sunday_amount) === 0 && Number(s.base_amount) === 3500);
  await throws('nothing left to settle afterwards', () => prep(eng, '2026-11-30'), /no marked, unsettled days/);
  const lines = (await q(`SELECT l.work_date::text d, l.job_id, l.stage_id, l.attendance_id, l.time_entry_id FROM temporary_worker_settlement_lines l WHERE l.settlement_id=$1 ORDER BY l.work_date`, [p.id])).rows;
  ok('lines are oldest-first and cover every day', lines.length === 5 && lines[0].d === '2026-11-02' && lines[4].d === '2026-11-06');
  ok('lines point at attendance days and carry no job or stage', lines.every(l => l.attendance_id && !l.time_entry_id && !l.job_id && !l.stage_id));
  await throws('role without access cannot prepare', () => prep(eng, '2026-11-30', 'early', 'x', hos1, 'production_staff'), /Not allowed/);
}
{ // cutoff, cleared day, close-out
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, W.slice(0, 3));
  await book(eng, [W[3]]); await clearDay(eng, W[3]);                  // marked, then cleared: never settled
  await book(eng, W.slice(6, 9));                                       // Nov 9-11, after the cutoff below
  const p = await prep(eng, '2026-11-08');
  ok('cutoff excludes later days; a cleared day is excluded', Number(p.units) === 3 && p.lines === 3, JSON.stringify(p));
  const late = await prep(eng, '2026-11-30', 'early', 'client wants it paid now');
  ok('early settlement with a reason takes the later days', Number(late.units) === 3);
  const close = await call('set_engagement_status', eng, 'completed', 'Job finished', hos1, 'head_of_sales');
  ok('closing reports no unsettled days (everything is already in a settlement)', Number(close.eligible_units) === 0 && close.close_out_due === false);
}
{ // flat rate: Sunday and half days
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, [W[0]]);                                              // Full: 1000
  await book(eng, [W[1]], { units: 0.5 });                              // Half: 500
  await book(eng, [SUNDAY]);                                            // Sunday: same flat rate, 1000
  const p = await prep(eng, '2026-11-30', 'early', 'check flat rate');
  const s = await one(`SELECT * FROM temporary_worker_settlements WHERE id=$1`, [p.id]);
  ok('flat daily rate: 1000 + 500 + 1000 = 2500 (a Sunday earns the same rate; no overtime part)', Number(s.gross_amount) === 2500 && Number(s.base_amount) === 2500 && Number(s.units_included) === 2.5, JSON.stringify(s));
  const bad = await one(`SELECT count(*)::int AS c FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND line_amount <> base_amount+overtime_amount+sunday_amount`, [p.id]);
  ok('every line reconciles to its parts', bad.c === 0);
  await call('set_engagement_status', eng, 'completed', 'Done', hos1, 'head_of_sales');
}
{ // close-out below the threshold
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, W.slice(0, 2));
  const c = await call('set_engagement_status', eng, 'completed', 'Job finished early', hos1, 'head_of_sales');
  ok('closing with 2 days unsettled prompts a close-out', Number(c.eligible_units) === 2 && c.close_out_due === true);
  const p = await prep(eng, '2026-11-30', 'close_out');
  ok('close-out below the threshold works', Number(p.units) === 2);
}
{ // a day voided behind the settlement's back stops approval (the guard is bypassed on purpose)
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, W.slice(0, 3)); const p = await prep(eng, '2026-11-30');
  await q(`ALTER TABLE temporary_worker_attendance DISABLE TRIGGER trg_twa_guard`);
  await q(`UPDATE temporary_worker_attendance SET active=false, voided_by=$2, voided_at=now(), void_reason='simulated' WHERE engagement_id=$1 AND work_date=$3`, [eng, admin, W[0]]);
  await q(`ALTER TABLE temporary_worker_attendance ENABLE TRIGGER trg_twa_guard`);
  await throws('approval refused when an included day has been voided', () => approve(p.id), /included day was voided/);
}


// ════════════════════════════════════════════════════════════════════════════
// Approval: separation of duties, limit, split payments
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  const p = await prep(eng, '2026-11-30');
  await throws('preparer cannot approve their own settlement', () => approve(p.id, hos1), /prepared or whose days you marked/);
  await throws('attendance recorder cannot approve', () => approve(p.id, pmRec, 'production_manager'), /prepared or whose days you marked/);
  await throws('admin who recorded must give an override reason', () => approve(p.id, pmRec, 'admin'), /override reason/);
  await throws('role without access cannot approve', () => approve(p.id, hos2, 'production_staff'), /Not allowed/);
  await approve(p.id, pmRec, 'admin', 'Owner reviewed the sheet personally');
  const s = await one(`SELECT approval_override, override_reason, approved_by_role FROM temporary_worker_settlements WHERE id=$1`, [p.id]);
  ok('admin override is stored with its reason', s.approval_override === true && /Owner reviewed/.test(s.override_reason) && s.approved_by_role === 'admin');
  ok('override is written to the audit log', Number(await val(`SELECT count(*) FROM payroll_activities WHERE entity_id=$1 AND activity_type='approved_override'`, [p.id])) === 1);
  await throws('approving twice refused', () => approve(p.id), /Only a draft settlement/);
}
{
  const { id } = await approved(3);
  const s = await one(`SELECT approval_override, approved_by_role, approved_by FROM temporary_worker_settlements WHERE id=$1`, [id]);
  ok('separate head of sales approves within the limit (no override)', s.approval_override === false && s.approved_by_role === 'head_of_sales' && s.approved_by === hos2);
}
{ // fail-closed limit
  const emp = await worker(4000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  const p = await prep(eng, '2026-11-30');   // 12,000 gross
  await throws('above KES 10,000: head of sales cannot approve', () => approve(p.id, hos2), /above the approval limit/);
  await throws('above KES 10,000: production manager cannot approve', () => approve(p.id, pmApp, 'production_manager'), /above the approval limit/);
  await approve(p.id, admin, 'admin');
  ok('above KES 10,000: admin approves', (await st(p.id)) === 'approved');
}
{
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  const p = await prep(eng, '2026-11-30');
  await q(`UPDATE temporary_worker_settings SET admin_approval_limit_kes = NULL`);
  await throws('limit NULL (fail-closed): a KES 3,000 settlement needs an admin', () => approve(p.id, hos2), /limit is not set|above the approval limit/);
  await q(`DELETE FROM temporary_worker_settings`);
  await throws('settings row missing (fail-closed): still admin only', () => approve(p.id, hos2), /limit is not set|above the approval limit/);
  await q(`INSERT INTO temporary_worker_settings (id) VALUES (true)`);
  await approve(p.id, hos2);
  ok('limit restored: head of sales can approve again', (await st(p.id)) === 'approved');
  await resetSettings();
}
{ // rolling-window split payments
  const emp = await worker(3000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  const p1 = await prep(eng, '2026-11-04');                      // 9,000
  await approve(p1.id, hos2);
  await book(a, W.slice(3, 6));
  const p2 = await prep(eng, '2026-11-30');                      // another 9,000: alone under the limit
  await throws('rolling 7-day total above the limit: head of sales refused', () => approve(p2.id, hos2), /recent settlements together/);
  await approve(p2.id, admin, 'admin');
  ok('rolling total above the limit: admin approves', (await st(p2.id)) === 'approved');
  // Outside the window the first settlement no longer counts
  const emp2 = await worker(3000); const eng2 = await engage(emp2); const b = await assign(emp2, eng2);
  await book(b, W.slice(0, 3)); const q1 = await prep(eng2, '2026-11-04'); await approve(q1.id, hos2);
  await q(`UPDATE temporary_worker_settlements SET approved_at = now() - interval '10 days' WHERE id=$1`, [q1.id]);
  await book(b, W.slice(3, 6)); const q2 = await prep(eng2, '2026-11-30');
  await approve(q2.id, hos2);
  ok('settlement older than the window does not count', (await st(q2.id)) === 'approved');
}

// ════════════════════════════════════════════════════════════════════════════
// Deductions
// ════════════════════════════════════════════════════════════════════════════
const draft = async (rate = 1000, days = 3) => {
  const emp = await worker(rate); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, days)); const p = await prep(eng, '2026-11-30'); return { emp, eng, a, id: p.id };
};
const addD = (id, type, amount, reason, ref = null, path = null, actor = hos1, role = 'head_of_sales') =>
  call('add_settlement_deduction', id, type, amount, reason, ref, path, actor, role);
{
  const { id } = await draft();
  await throws('statutory deduction types are impossible (CHECK)', () => q(`INSERT INTO temporary_worker_settlement_deductions (settlement_id, deduction_type, amount, reason, recorded_by, evidence_ref) VALUES ($1,'paye',100,'tax',$2,'X')`, [id, hos1]), /deduction_type/);
  await throws('reason is mandatory', () => addD(id, 'cash_advance', 100, '  ', 'ADV-1'), /reason is required/);
  await throws('damage needs evidence (reference or attachment)', () => addD(id, 'damage', 100, 'Broke a saw blade'), /evidence reference or attachment/);
  await throws('cash advance needs the voucher reference', () => addD(id, 'cash_advance', 100, 'Advance on Tuesday'), /advance voucher/);
  await throws('tools or materials need the issue-slip reference', () => addD(id, 'tools_or_materials', 100, 'Issued a router bit'), /issue-slip/);
  await throws('"other" needs a detailed reason (min 20 characters)', () => addD(id, 'other', 100, 'misc'), /at least 20 characters/);
  await throws('a deduction cannot push the total above gross', () => addD(id, 'cash_advance', 3500, 'Advance far too large', 'ADV-9'), /exceed the gross pay/);
  await throws('zero or negative amount refused', () => addD(id, 'cash_advance', 0, 'Advance of nothing', 'ADV-9'), /above 0/);
  await throws('role without access cannot add', () => addD(id, 'cash_advance', 100, 'Advance for lunch money', 'adv-1', null, hos1, 'production_staff'), /Not allowed/);
  const d1 = await addD(id, 'damage', 100, 'Broke a saw blade', null, 'evidence/blade.jpg');
  ok('damage with an attachment is accepted', !!d1);
  const d2 = await addD(id, 'cash_advance', 100, 'Advance given Tuesday morning', ' adv-77 ');
  ok('references are trimmed and uppercased', (await val(`SELECT evidence_ref FROM temporary_worker_settlement_deductions WHERE id=$1`, [d2])) === 'ADV-77');
  const d3 = await addD(id, 'other', 50, 'Cost of a lost key replaced at a kiosk');
  ok('"other" with a 20+ character reason accepted without an attachment', !!d3);
  const s = await one(`SELECT gross_amount, deductions_total, net_amount FROM temporary_worker_settlements WHERE id=$1`, [id]);
  ok('net = gross - deductions (3000 - 250 = 2750)', Number(s.deductions_total) === 250 && Number(s.net_amount) === 2750 && Number(s.gross_amount) === 3000);
  await throws('a wrong deductions_total cannot be written directly', () => q(`UPDATE temporary_worker_settlements SET deductions_total=10, net_amount=2990 WHERE id=$1`, [id]), /must equal the sum/);
  await throws('a recorded deduction cannot be edited', () => q(`UPDATE temporary_worker_settlement_deductions SET amount=1 WHERE id=$1`, [d1]), /cannot be edited/);
  await throws('recorder cannot approve their own deduction', () => call('approve_settlement_deduction', d1, hos1, 'head_of_sales'), /someone other than/);
  await throws('settlement cannot be approved while a deduction is unapproved', () => approve(id), /Every deduction must be approved/);
  await call('approve_settlement_deduction', d1, hos2, 'head_of_sales');
  await call('approve_settlement_deduction', d2, hos2, 'head_of_sales');
  await call('void_settlement_deduction', d3, 'Entered by mistake', hos1, 'head_of_sales');
  const s2 = await one(`SELECT deductions_total, net_amount FROM temporary_worker_settlements WHERE id=$1`, [id]);
  ok('voiding a deduction recomputes net (3000 - 200 = 2800)', Number(s2.deductions_total) === 200 && Number(s2.net_amount) === 2800);
  await throws('voided deduction cannot be approved', () => call('approve_settlement_deduction', d3, hos2, 'head_of_sales'), /voided/);
  await approve(id);
  ok('settlement approves once every active deduction is approved', (await st(id)) === 'approved');
  await throws('no deduction can be added after approval', () => addD(id, 'cash_advance', 10, 'Late advance, not allowed', 'ADV-2'), /only be added while/);
  await throws('no deduction can be voided after approval', () => call('void_settlement_deduction', d1, 'Changed my mind', hos1, 'head_of_sales'), /only be voided while/);
  await throws('deduction rows cannot be changed after approval (direct SQL)', () => q(`UPDATE temporary_worker_settlement_deductions SET amount=1 WHERE id=$1`, [d1]), /fixed once/);
  await throws('deduction rows are never deleted', () => q(`DELETE FROM temporary_worker_settlement_deductions WHERE id=$1`, [d1]), /never deleted/);
}
{ // admin-approval triggers
  const { id } = await draft(3000, 3);                         // gross 9,000
  const big = await addD(id, 'cash_advance', 1100, 'Advance of eleven hundred', 'ADV-11');
  await throws('single deduction over KES 1,000 needs an admin', () => call('approve_settlement_deduction', big, hos2, 'head_of_sales'), /admin must approve/);
  await call('approve_settlement_deduction', big, admin, 'admin');
  await approve(id);
  ok('admin-approved large deduction lets the settlement through', (await st(id)) === 'approved');
}
{
  const { id } = await draft(1000, 3);                         // gross 3,000; 25% = 750
  const d = await addD(id, 'cash_advance', 800, 'Advance of eight hundred', 'ADV-8');
  await throws('total over 25% of gross needs an admin', () => call('approve_settlement_deduction', d, hos2, 'head_of_sales'), /admin must approve/);
  const small = await addD(id, 'cash_advance', 10, 'Tiny advance for the bus', 'ADV-9');
  await call('approve_settlement_deduction', d, admin, 'admin');
  await call('approve_settlement_deduction', small, hos2, 'head_of_sales').catch(() => {});
  ok('admin approval covers the large deduction', (await val(`SELECT approved_by_role FROM temporary_worker_settlement_deductions WHERE id=$1`, [d])) === 'admin');
}
{
  const { id } = await draft(1000, 3);
  const d = await addD(id, 'cash_advance', 100, 'Small advance for lunch', 'ADV-5');
  await call('approve_settlement_deduction', d, hos2, 'head_of_sales');
  const d2 = await addD(id, 'cash_advance', 700, 'Second larger advance', 'ADV-6');      // pushes total to 800 > 25%
  await call('approve_settlement_deduction', d2, admin, 'admin');
  await throws('an earlier small approval no longer suffices once the total crosses 25%', () => approve(id), /still needs admin approval/);
  await call('approve_settlement_deduction', d, admin, 'admin');
  await approve(id);
  ok('admin re-approval of the earlier deduction clears it', (await st(id)) === 'approved');
}
{
  const { id } = await draft();
  await q(`UPDATE temporary_worker_settings SET damage_deductions_enabled=false`);
  await throws('damage deductions can be switched off in settings', () => addD(id, 'damage', 10, 'Broke something', 'EV-1'), /switched off/);
  await resetSettings();
}

// ════════════════════════════════════════════════════════════════════════════
// Payout sheets and payment
// ════════════════════════════════════════════════════════════════════════════
{
  const s1 = await approved(); const s2 = await approved();
  await throws('pay refused without a payout sheet', () => pay(s1.id), /payout sheet first/);
  await throws('a sheet for two settlements is refused (one settlement per sheet)', () => sheetFor([s1.id, s2.id]), /exactly one settlement/);
  await throws('a sheet for no settlement is refused', () => sheetFor([]), /Choose a settlement/);
  const sh = await sheetFor([s1.id]);
  ok('sheet totals computed (one settlement, 3000)', Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 3000);
  await throws('a settlement cannot be on two sheets', () => sheetFor([s1.id]), /not already on a payout sheet/);
  await throws('DATABASE enforces one settlement per sheet even if the function is bypassed (unique index)',
    () => q(`UPDATE temporary_worker_settlements SET payout_sheet_id=$2 WHERE id=$1`, [s2.id, sh]), /uq_tws_one_per_sheet|duplicate key/);
  await throws('pay refused while the sheet is open (not printed/signed)', () => pay(s1.id), /signed and attached/);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  await throws('pay refused while the sheet is only printed', () => pay(s1.id), /signed and attached/);
  await throws('signed receipt file is required', () => call('attach_signed_receipt', sh, '  ', hos1, 'head_of_sales'), /required/);
  await call('attach_signed_receipt', sh, 'receipts/ps.jpg', hos1, 'head_of_sales');
  await throws('preparer cannot pay (no override even for admin)', () => pay(s1.id, hos1, 'head_of_sales'), /prepared a settlement cannot pay/);
  await throws('admin who prepared cannot pay either', async () => {
    const x = await draft(); await approve(x.id, hos2); const s = await signedSheet([x.id]);
    await pay(x.id, hos1, 'admin');
  }, /prepared a settlement cannot pay/);
  await throws('receiver needs a full name (one name refused)', () => pay(s1.id, pmPay, 'production_manager', 'Jane'), /full name/);
  await throws('blank receiver refused', () => pay(s1.id, pmPay, 'production_manager', '   '), /full name/);
  await throws('role without access cannot pay', () => pay(s1.id, pmPay, 'production_staff'), /Not allowed/);
  const r = await pay(s1.id);
  ok('production manager (not the preparer) pays on the signed sheet', r.status === 'paid');
  const row = await one(`SELECT * FROM temporary_worker_settlements WHERE id=$1`, [s1.id]);
  ok('payment records payer, time, receiver and sheet', row.paid_by === pmPay && row.paid_at && row.received_by_full_name === 'Jane Wanjiru' && row.payout_sheet_id === sh);
  await throws('paying twice refused', () => pay(s1.id), /already paid/);
  await throws('a paid settlement cannot be moved onto another sheet', () => q(`UPDATE temporary_worker_settlements SET payout_sheet_id=NULL WHERE id=$1`, [s1.id]), /final/);
  await throws('a sheet with a paid settlement cannot be cancelled', () => call('cancel_payout_sheet', sh, 'wrong sheet', admin, 'admin'), /paid settlement cannot be cancelled/);
  // the approver may pay
  await signedSheet([s2.id]);
  const approverPays = await pay(s2.id, hos2, 'head_of_sales', 'John Kamau Mwangi');
  ok('the approver may be the payer', approverPays.status === 'paid');
}
{ // over-limit sheet and payment note
  const emp = await worker(4000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3)); const p = await prep(eng, '2026-11-30');      // 12,000
  await approve(p.id, admin, 'admin');
  const sh = await sheetFor([p.id]);
  await throws('printing a sheet above the limit needs admin approval first', () => call('mark_sheet_printed', sh, hos1, 'head_of_sales'), /admin must approve it before it is printed/);
  await throws('only an admin approves a sheet', () => call('approve_payout_sheet', sh, hos2, 'head_of_sales'), /Only an admin/);
  await call('approve_payout_sheet', sh, admin, 'admin');
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  await call('attach_signed_receipt', sh, 'receipts/big.jpg', hos1, 'head_of_sales');
  await throws('payment above the limit needs a note', () => pay(p.id), /payment note is required/);
  await pay(p.id, pmPay, 'production_manager', 'Peter Otieno Odhiambo', 'Counted twice in front of the foreman');
  ok('payment above the limit works with a note', (await st(p.id)) === 'paid');
}
{ // a settlement under the limit prints without admin approval; a batch can no longer be used to dodge the limit (one per sheet)
  const a1 = await approved(3, 2000);                                          // 6,000
  const sh = await sheetFor([a1.id]);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  ok('a 6,000 sheet (under the limit) prints without admin approval', (await val(`SELECT status FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 'printed');
}
{ // net basis: gross over limit, net under
  const emp = await worker(4000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3)); const p = await prep(eng, '2026-11-30');      // gross 12,000
  const d = await addD(p.id, 'cash_advance', 2500, 'Large advance', 'ADV-L');
  await call('approve_settlement_deduction', d, admin, 'admin');
  await approve(p.id, admin, 'admin');
  const sh = await sheetFor([p.id]);                                           // net 9,500
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');                 // net under limit: no sheet approval needed
  await call('attach_signed_receipt', sh, 'receipts/net.jpg', hos1, 'head_of_sales');
  await throws('payment note still required because GROSS exceeds the limit', () => pay(p.id), /payment note is required/);
  await pay(p.id, pmPay, 'production_manager', 'Mary Njeri Kamau', 'Gross above limit, net 9,500 paid');
  ok('worker acknowledgement stamped when the signed sheet was attached', (await val(`SELECT worker_acknowledged_at FROM temporary_worker_settlement_deductions WHERE id=$1`, [d])) !== null);
}
{ // cancelled sheet: terminal, never signed, settlements return to approved-unpaid
  const s1 = await approved();
  const sh = await sheetFor([s1.id]);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  await throws('cancelling needs a reason', () => call('cancel_payout_sheet', sh, ' ', hos1, 'head_of_sales'), /reason is required/);
  await call('cancel_payout_sheet', sh, 'Wrong names printed', hos1, 'head_of_sales');
  ok('sheet is cancelled and the settlement is free again', (await val(`SELECT status FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 'cancelled'
    && (await val(`SELECT payout_sheet_id FROM temporary_worker_settlements WHERE id=$1`, [s1.id])) === null && (await st(s1.id)) === 'approved');
  await throws('a cancelled sheet cannot be printed', () => call('mark_sheet_printed', sh, hos1, 'head_of_sales'), /Only an open/);
  await throws('a cancelled sheet can never be marked signed', () => call('attach_signed_receipt', sh, 'x.jpg', hos1, 'head_of_sales'), /Print the payout sheet|cancelled/);
  await throws('a cancelled sheet cannot be reopened (direct SQL)', () => q(`UPDATE temporary_worker_payout_sheets SET status='open' WHERE id=$1`, [sh]), /final|cancelled/);
  await throws('a cancelled sheet cannot be cancelled again', () => call('cancel_payout_sheet', sh, 'again', admin, 'admin'), /already cancelled/);
  const sh2 = await sheetFor([s1.id]);
  ok('the settlement can join a NEW sheet', !!sh2 && sh2 !== sh);
  await call('mark_sheet_printed', sh2, hos1, 'head_of_sales');
  await call('attach_signed_receipt', sh2, 'receipts/ok.jpg', hos1, 'head_of_sales');
  await throws('a signed sheet can only be cancelled by an admin', () => call('cancel_payout_sheet', sh2, 'oops', hos1, 'head_of_sales'), /Only an admin/);
  await call('cancel_payout_sheet', sh2, 'Receipt photo unreadable', admin, 'admin');
  ok('cancelling a signed sheet clears its receipt path but keeps an audit trail of it',
    (await val(`SELECT signed_receipt_path FROM temporary_worker_payout_sheets WHERE id=$1`, [sh2])) === null
    && Number(await val(`SELECT count(*) FROM payroll_activities WHERE entity_id=$1 AND activity_type='cancelled_receipt_retained'`, [sh2])) === 1);
  await throws('direct SQL cannot sign a cancelled sheet', () => q(`UPDATE temporary_worker_payout_sheets SET status='signed', signed_receipt_path='z', signed_receipt_uploaded_by=$2, signed_receipt_uploaded_at=now(), printed_at=now(), cancelled_by=NULL, cancelled_at=NULL, cancel_reason=NULL WHERE id=$1`, [sh2, admin]), /final/);
  await throws('direct SQL cannot put a settlement on a cancelled sheet', () => q(`UPDATE temporary_worker_settlements SET payout_sheet_id=$2 WHERE id=$1`, [s1.id, sh2]), /open payout sheet/);
}

// ════════════════════════════════════════════════════════════════════════════
// PAID IS FINAL
// ════════════════════════════════════════════════════════════════════════════
{
  const s = await approved(3);
  const sh = await signedSheet([s.id]);
  await pay(s.id);
  const entries = (await q(`SELECT l.attendance_id FROM temporary_worker_settlement_lines l WHERE l.settlement_id=$1`, [s.id])).rows.map(r => r.attendance_id);
  ok('setup: a paid settlement with 3 active lines', (await st(s.id)) === 'paid' && entries.length === 3);

  await throws('admin cannot void a paid settlement', () => call('void_temporary_settlement', s.id, 'mistake', admin, 'admin'), /final and cannot be voided/);
  await throws('direct SQL cannot void a paid settlement', () => q(`UPDATE temporary_worker_settlements SET status='voided', voided_by=$2, voided_at=now(), void_reason='x', paid_by=NULL, paid_at=NULL, received_by_full_name=NULL, payout_sheet_id=NULL WHERE id=$1`, [s.id, admin]), /final/);
  await throws('direct SQL cannot edit a paid settlement', () => q(`UPDATE temporary_worker_settlements SET gross_amount=1, base_amount=1, overtime_amount=0, sunday_amount=0, net_amount=1 WHERE id=$1`, [s.id]), /final/);
  await throws('lines of a paid settlement cannot be released', () => q(`UPDATE temporary_worker_settlement_lines SET active=false WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  await throws('lines of a paid settlement cannot be deleted', () => q(`DELETE FROM temporary_worker_settlement_lines WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  await throws('lines of a paid settlement cannot be edited', () => q(`UPDATE temporary_worker_settlement_lines SET line_amount=1, base_amount=1, overtime_amount=0, sunday_amount=0 WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  const paidDay = await val(`SELECT work_date::text FROM temporary_worker_attendance WHERE id=$1`, [entries[0]]);
  await throws('a day in a paid settlement cannot be cleared (even by admin)', () => clearDay(s.eng, paidDay), /void that settlement first/);
  await throws('a day in a paid settlement cannot be voided by direct SQL', () => q(`UPDATE temporary_worker_attendance SET active=false, voided_by=$2, voided_at=now(), void_reason='x' WHERE id=$1`, [entries[0], admin]), /void that settlement first/);
  ok('the entries are still approved and still in active lines', Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE id = ANY($1::uuid[]) AND active`, [arr(entries)])) === 3
    && Number(await val(`SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 3);
  await throws('the same work cannot be paid a second time (nothing left to settle)', () => prep(s.eng, '2026-11-30', 'early', 'try again'), /no marked, unsettled days/);
  await throws('a second line for a paid day is refused by the unique index', async () => {
    const p2 = await draft();           // a different worker's draft settlement
    await q(`INSERT INTO temporary_worker_settlement_lines (settlement_id, attendance_id, work_date, attendance_units, base_amount, overtime_amount, sunday_amount, line_amount)
             VALUES ($1,$2,'2026-11-02',1,1000,0,0,1000)`, [p2.id, entries[0]]);
  }, /uq_twl_attendance_active|duplicate key/);
  await throws('no deduction can be added to a paid settlement', () => addD(s.id, 'cash_advance', 10, 'Late advance not allowed', 'ADV-3'), /only be added while/);
  await throws('paid payout sheet fields cannot be altered', () => q(`UPDATE temporary_worker_payout_sheets SET total_net=1, total_gross=1 WHERE id=$1`, [sh]), /signed payout sheet cannot change/);
  await throws('paying again refused', () => pay(s.id), /already paid/);
  ok('after every attempt the settlement is still paid, once', (await st(s.id)) === 'paid'
    && Number(await val(`SELECT count(*) FROM temporary_worker_settlements WHERE id=$1 AND status='paid'`, [s.id])) === 1);
  // paid work with deductions: rows immutable
  const dd = await draft(); const d = await addD(dd.id, 'cash_advance', 100, 'Advance for lunch', 'ADV-P');
  await call('approve_settlement_deduction', d, hos2, 'head_of_sales'); await approve(dd.id);
  await signedSheet([dd.id]); await pay(dd.id);
  await throws('deductions of a paid settlement cannot change', () => q(`UPDATE temporary_worker_settlement_deductions SET worker_acknowledged_at=NULL, amount=1 WHERE id=$1`, [d]), /cannot change/);
}

// ════════════════════════════════════════════════════════════════════════════
// Voiding an unpaid settlement frees the days; a day in an active settlement is protected
// ════════════════════════════════════════════════════════════════════════════
const firstDay = (settlement) => val(`SELECT a.work_date::text FROM temporary_worker_settlement_lines l JOIN temporary_worker_attendance a ON a.id=l.attendance_id WHERE l.settlement_id=$1 ORDER BY a.work_date LIMIT 1`, [settlement]);
{
  const s = await approved(3);
  const day = await firstDay(s.id);
  await throws('a day in an ACTIVE settlement cannot be cleared', () => clearDay(s.eng, day), /void that settlement first/);
  await throws('production manager cannot void an approved settlement', () => call('void_temporary_settlement', s.id, 'changed', pmApp, 'production_manager'), /Only an admin/);
  await throws('void needs a reason', () => call('void_temporary_settlement', s.id, ' ', admin, 'admin'), /reason is required/);
  await call('void_temporary_settlement', s.id, 'Wrong period chosen', admin, 'admin');
  ok('voided settlement is final and its lines are released', (await st(s.id)) === 'voided'
    && Number(await val(`SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 0);
  await throws('a voided settlement cannot be revived', () => q(`UPDATE temporary_worker_settlements SET status='draft' WHERE id=$1`, [s.id]), /final/);
  const again = await prep(s.eng, '2026-11-30');
  ok('the freed days can be settled again', Number(again.units) === 3);
  await approve(again.id); await signedSheet([again.id]); await pay(again.id);
  ok('...and paid once', (await st(again.id)) === 'paid');
}
{
  const s = await approved(3);
  const day = await firstDay(s.id);
  await call('void_temporary_settlement', s.id, 'Not needed', admin, 'admin');
  await clearDay(s.eng, day);
  ok('once the settlement is voided the day can be cleared', Number(await val(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id=$1 AND work_date=$2 AND active`, [s.eng, day])) === 0);
  const p = await prep(s.eng, '2026-11-30', 'early', 'two days left');
  ok('the cleared day is no longer settled', Number(p.units) === 2);
}


{ // draft void by any run role; approved on an open sheet leaves the sheet; signed sheet blocks void
  const d = await draft();
  await call('void_temporary_settlement', d.id, 'Prepared by mistake', hos1, 'head_of_sales');
  ok('a draft can be voided by head of sales', (await st(d.id)) === 'voided');
  const a1 = await approved(), a2 = await approved();
  const sh1 = await sheetFor([a1.id]);
  await call('void_temporary_settlement', a1.id, 'Worker left the site', admin, 'admin');
  ok('voiding an approved settlement removes it from an open sheet and recomputes totals',
    Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh1])) === 0
    && (await val(`SELECT payout_sheet_id FROM temporary_worker_settlements WHERE id=$1`, [a1.id])) === null);
  await call('cancel_payout_sheet', sh1, 'Settlement voided', hos1, 'head_of_sales');
  ok('the now-empty open sheet can be cancelled', (await val(`SELECT status FROM temporary_worker_payout_sheets WHERE id=$1`, [sh1])) === 'cancelled');
  const sh = await sheetFor([a2.id]);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales'); await call('attach_signed_receipt', sh, 'r.jpg', hos1, 'head_of_sales');
  await throws('a settlement on a SIGNED sheet cannot be voided until the sheet is cancelled', () => call('void_temporary_settlement', a2.id, 'x', admin, 'admin'), /cancel the sheet first/);
  await call('cancel_payout_sheet', sh, 'Wrong names on the sheet', admin, 'admin');
  await call('void_temporary_settlement', a2.id, 'Worker left the site', admin, 'admin');
  ok('after the admin cancels the signed sheet the settlement can be voided (1:1: nothing is stranded)', (await st(a2.id)) === 'voided');
}

// ════════════════════════════════════════════════════════════════════════════
// Status consistency (CHECK constraints and transition triggers, via direct SQL)
// ════════════════════════════════════════════════════════════════════════════
{
  const d = await draft();
  await throws('approved without approver/time/role is rejected', () => q(`UPDATE temporary_worker_settlements SET status='approved' WHERE id=$1`, [d.id]), /tws_status_fields/);
  await throws('draft -> paid is an illegal transition', () => q(`UPDATE temporary_worker_settlements SET status='paid' WHERE id=$1`, [d.id]), /Illegal settlement status change/);
  await throws('non-paid settlement cannot carry payment details', () => q(`UPDATE temporary_worker_settlements SET paid_by=$2 WHERE id=$1`, [d.id, hos2]), /tws_payment_fields_only_when_paid/);
  await throws('non-paid settlement cannot carry a receiver name', () => q(`UPDATE temporary_worker_settlements SET received_by_full_name='Jane Doe' WHERE id=$1`, [d.id]), /tws_payment_fields_only_when_paid/);
  await throws('voided without actor, time and reason is rejected', () => q(`UPDATE temporary_worker_settlements SET status='voided' WHERE id=$1`, [d.id]), /tws_status_fields/);
  await throws('override flag without a reason is rejected', () => q(`UPDATE temporary_worker_settlements SET approval_override=true WHERE id=$1`, [d.id]), /tws_override/);
  await throws('a draft cannot be put on a sheet directly', async () => {
    const x = await approved(); const sh = await sheetFor([x.id]);
    await q(`UPDATE temporary_worker_settlements SET payout_sheet_id=$2 WHERE id=$1`, [d.id, sh]);
  }, /tws_status_fields|Only approved/);
  await throws('settlements cannot be deleted', () => q(`DELETE FROM temporary_worker_settlements WHERE id=$1`, [d.id]), /cannot be deleted/);
  await throws('settlement figures cannot be edited', () => q(`UPDATE temporary_worker_settlements SET gross_amount=9999, base_amount=9999, net_amount=9999 WHERE id=$1`, [d.id]), /cannot be edited/);
}
{
  const s = await approved();
  await throws('paid without a payout sheet is rejected', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now(), received_by_full_name='Jane Doe' WHERE id=$1`, [s.id, pmPay]), /signed payout sheet|tws_status_fields/);
  const sh = await sheetFor([s.id]);
  await throws('paid on a sheet that is not signed is rejected (trigger)', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now(), received_by_full_name='Jane Doe' WHERE id=$1`, [s.id, pmPay]), /signed payout sheet/);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales'); await call('attach_signed_receipt', sh, 'r.jpg', hos1, 'head_of_sales');
  const prepared = await val(`SELECT prepared_by FROM temporary_worker_settlements WHERE id=$1`, [s.id]);
  await throws('paid by the preparer is rejected by CHECK', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now(), received_by_full_name='Jane Doe' WHERE id=$1`, [s.id, prepared]), /tws_status_fields/);
  await throws('paid with a one-word receiver is rejected by CHECK', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now(), received_by_full_name='Jane' WHERE id=$1`, [s.id, pmPay]), /tws_receiver_name/);
  await throws('paid without a receiver is rejected by CHECK', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now() WHERE id=$1`, [s.id, pmPay]), /tws_status_fields/);
}
{ // sheets and engagements
  const x = await approved(); const sh = await sheetFor([x.id]);
  await throws('a sheet cannot jump open -> signed', () => q(`UPDATE temporary_worker_payout_sheets SET status='signed', printed_at=now(), signed_receipt_path='a', signed_receipt_uploaded_by=$2, signed_receipt_uploaded_at=now() WHERE id=$1`, [sh, admin]), /Illegal payout sheet status/);
  await throws('printed without a print time is rejected', () => q(`UPDATE temporary_worker_payout_sheets SET status='printed' WHERE id=$1`, [sh]), /tws_sheet_status_fields/);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales');
  await throws('signed without a receipt is rejected', () => q(`UPDATE temporary_worker_payout_sheets SET status='signed' WHERE id=$1`, [sh]), /tws_sheet_status_fields/);
  await throws('cancelled without actor and reason is rejected', () => q(`UPDATE temporary_worker_payout_sheets SET status='cancelled' WHERE id=$1`, [sh]), /tws_sheet_status_fields/);
  await throws('sheet totals must satisfy net = gross - deductions', () => q(`UPDATE temporary_worker_payout_sheets SET total_net=1 WHERE id=$1`, [sh]), /tws_sheet_totals/);
  const emp = await worker(); const eng = await engage(emp);
  await throws('completed engagement needs actor, time and reason', () => q(`UPDATE temporary_worker_engagements SET status='completed' WHERE id=$1`, [eng]), /twe_status_fields/);
  await throws('engagement cannot go active -> planned', () => q(`UPDATE temporary_worker_engagements SET status='planned' WHERE id=$1`, [eng]), /Illegal engagement status/);
}

// ════════════════════════════════════════════════════════════════════════════
// Access: service_role only, settings admin-only
// ════════════════════════════════════════════════════════════════════════════
{
  const tables = ['temporary_worker_settings', 'temporary_worker_engagements', 'temporary_worker_settlements', 'temporary_worker_settlement_lines', 'temporary_worker_settlement_deductions', 'temporary_worker_payout_sheets', 'temporary_worker_attendance'];
  let leak = [];
  for (const t of tables) for (const r of ['anon', 'authenticated', 'public'])
    if (await val(`SELECT has_table_privilege('${r}', 'public.${t}', 'SELECT')`)) leak.push(`${r}:${t}`);
  ok('no table is readable by anon / authenticated / public', leak.length === 0, leak.join(','));
  ok('every table has RLS enabled', Number(await val(`SELECT count(*) FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity`, [arr(tables)])) === tables.length);
  ok('service_role can read the tables', await val(`SELECT has_table_privilege('service_role', 'public.temporary_worker_settlements', 'SELECT')`));
  const fns = (await q(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
     AND (p.proname LIKE 'tw\\_%' OR p.proname IN ('pay_temporary_settlement','approve_temporary_settlement','void_temporary_settlement','prepare_temporary_settlement','create_payout_sheet','set_temporary_worker_settings','mark_temporary_attendance'))`)).rows;
  let open = [];
  for (const f of fns) for (const r of ['anon', 'authenticated', 'public'])
    if (await val(`SELECT has_function_privilege('${r}', '${f.sig}', 'EXECUTE')`)) open.push(`${r}:${f.sig}`);
  ok(`no function is executable by anon / authenticated / public (${fns.length} checked)`, open.length === 0, open.join(','));
  ok('service_role can execute', await val(`SELECT has_function_privilege('service_role', 'public.pay_temporary_settlement(uuid,uuid,text,text,text)', 'EXECUTE')`));
}
{
  await throws('only an admin can change settings', () => call('set_temporary_worker_settings', JSON.stringify({ admin_approval_limit_kes: 99999 }), hos1, 'head_of_sales'), /Only an admin/);
  const r = await call('set_temporary_worker_settings', JSON.stringify({ admin_approval_limit_kes: 5000 }), admin, 'admin');
  ok('admin can change the limit', Number(r.admin_approval_limit_kes) === 5000);
  const r2 = await call('set_temporary_worker_settings', JSON.stringify({ admin_approval_limit_kes: null }), admin, 'admin');
  ok('admin can set the limit to NULL (fail-closed)', r2.admin_approval_limit_kes === null);
  await resetSettings();
}


// ════════════════════════════════════════════════════════════════════════════
// Overlap rules, payroll-run edits, revision, bulk due, max days, separation of duties, damage default, grants
// ════════════════════════════════════════════════════════════════════════════
{ // overlap rule for completed engagements: protect days with attendance, not "forever"
  const emp = await worker(1000); const eng = await engage(emp, { start: '2026-11-02' });   // open-ended
  await book(eng, ['2026-11-04', '2026-11-05']);
  const lateRun = await mkRun('PR-X1b', '2027-03-01');
  await throws('active open-ended engagement blocks a payroll run months later', () => addEntry(lateRun, emp), /TEMP_ENGAGEMENT_OVERLAP/);
  await call('set_engagement_status', eng, 'completed', 'Done', hos1, 'head_of_sales');
  await addEntry(lateRun, emp);
  ok('once COMPLETED, the engagement no longer blocks payroll on days nothing was worked', true);
  const worked = await mkRun('PR-X2', '2026-11-02');
  await throws('...but days with temporary attendance stay protected', () => addEntry(worked, emp), /TEMP_ENGAGEMENT_OVERLAP/);
  const gap = await mkRun('PR-X3', '2026-11-09');
  await addEntry(gap, emp);
  ok('...and a run covering only days with no attendance is allowed', true);
  const emp2 = await worker(1000); const eng2 = await engage(emp2, { start: '2026-11-02' });
  await book(eng2, ['2026-11-18']);
  await call('set_engagement_status', eng2, 'completed', 'Done', hos1, 'head_of_sales');
  const r18 = await mkRun('PR-X4', '2026-11-16');
  await throws('a marked day protects itself even after the engagement closes', () => addEntry(r18, emp2), /TEMP_ENGAGEMENT_OVERLAP/);
  const emp3 = await worker(1000); const eng3 = await engage(emp3, { start: '2026-11-02' });
  await book(eng3, ['2026-11-18']); await clearDay(eng3, '2026-11-18'); await call('set_engagement_status', eng3, 'completed', 'Done', hos1, 'head_of_sales');
  const r18b = await mkRun('PR-X5', '2026-11-16'); await addEntry(r18b, emp3);
  ok('a CLEARED day releases its protection', true);
}

{ // payroll-run date edit and approval revalidation
  const emp = await worker(1000); await engage(emp, { start: '2026-12-14', end: '2026-12-18' });
  const run = await mkRun('PR-D1', '2026-12-07'); await addEntry(run, emp);          // 7–13 Dec: outside the engagement
  await throws('editing a run\'s dates INTO an engagement\'s span is refused', () => q(`UPDATE payroll_runs SET period_end='2026-12-15' WHERE id=$1`, [run]), /TEMP_ENGAGEMENT_OVERLAP/);
  await q(`UPDATE payroll_runs SET period_end='2026-12-13', notes='n' WHERE id=$1`, [run]);
  ok('editing dates that stay clear of the engagement is allowed', true);
  await q(`UPDATE payroll_runs SET period_start='2026-12-08' WHERE id=$1`, [run]);
  ok('moving the start date within the clear window is allowed', true);
  const emp2 = await worker(1000); const run2 = await mkRun('PR-D2', '2026-12-21'); await addEntry(run2, emp2);
  await q(`INSERT INTO temporary_worker_engagements (employee_id, order_id, agreed_daily_rate, start_date, status) VALUES ($1,$2,1000,'2026-12-22','active')`, [emp2, ORDER]);
  await throws('approving a run re-validates against temporary engagements', () => q(`UPDATE payroll_runs SET status='approved' WHERE id=$1`, [run2]), /TEMP_ENGAGEMENT_OVERLAP/);
}

{ // revision when the expected end has passed (jobs run late)
  const emp = await worker(1000); const eng = await engage(emp, { start: '2026-01-05', end: '2026-01-30' });
  const v2 = await call('revise_engagement_rate', eng, 1300, 'Late job, new rate', hos1, 'head_of_sales');
  ok('revising after the expected end date works; the new version is open-ended instead of violating the dates check',
    (await val(`SELECT expected_end_date FROM temporary_worker_engagements WHERE id=$1`, [v2])) === null);
  const emp2 = await worker(1000); const eng2 = await engage(emp2, { start: '2026-01-05', end: '2026-01-30' });
  const lateRun = await mkRun('PR-REV', '2027-06-07'); await addEntry(lateRun, emp2);
  await throws('revision is refused if the open-ended new version would overlap a payroll run the worker is already in',
    () => call('revise_engagement_rate', eng2, 1300, 'Late job, new rate', hos1, 'head_of_sales'), /TEMP_ENGAGEMENT_OVERLAP/);
}

{ // bulk due summary equals the single-engagement function
  const s = await approved(3);                                                       // fully settled: 0 eligible
  const g1 = await engage(await worker(1000)); await book(g1, W.slice(0, 4));        // 4 eligible
  const g2 = await engage(await worker(1000)); await book(g2, W.slice(0, 1));        // 1 eligible
  const g3 = await engage(await worker(1000)); await book(g3, W.slice(0, 2));
  await call('set_engagement_status', g3, 'completed', 'Done', hos1, 'head_of_sales');                                          // close-out due
  const ids = [s.eng, g1, g2, g3];
  const bulk = await call('temporary_engagements_due', arr(ids));
  let same = true;
  for (const id of ids) { const one1 = await call('temporary_engagement_due', id); if (JSON.stringify(Object.entries(one1).sort()) !== JSON.stringify(Object.entries(bulk[id]).sort())) same = false; }
  ok('bulk due summary matches temporary_engagement_due for every engagement', same, JSON.stringify(bulk));
  ok('bulk: 4 days is due, 1 day is not, closed with days is close_out_due, settled is zero',
    bulk[g1].due === true && Number(bulk[g1].eligible_units) === 4 && Number(bulk[g1].eligible_gross) === 4000 && bulk[g2].due === false && bulk[g3].close_out_due === true && Number(bulk[s.eng].eligible_units) === 0);
  ok('bulk: empty list gives an empty object; unknown ids are absent', JSON.stringify(await call('temporary_engagements_due', arr([]))) === '{}'
    && Object.keys(await call('temporary_engagements_due', arr(['00000000-0000-0000-0000-000000000000']))).length === 0);
  const half = await engage(await worker(2000)); await book(half, [W[0]], { units: 0.5 });
  ok('a Half day is worth half the agreed rate in the due figure (2000 → 1000)', Number((await call('temporary_engagement_due', half)).eligible_gross) === 1000);
}

{ // CANCELLED engagement with marked days: reported as close-out due and settleable
  const eng = await engage(await worker(1000));
  await book(eng, W.slice(0, 2));
  await call('set_engagement_status', eng, 'cancelled', 'Client cancelled the job', hos1, 'head_of_sales');
  const bulk = await call('temporary_engagements_due', arr([eng]));
  ok('cancelled engagement with marked days is close_out_due in the bulk summary', bulk[eng].close_out_due === true && Number(bulk[eng].eligible_units) === 2, JSON.stringify(bulk));
  ok('...and in the single-engagement summary', (await call('temporary_engagement_due', eng)).close_out_due === true);
  await throws('a threshold settlement is still refused on 2 days', () => prep(eng, '2026-11-30', 'threshold'), /settlement threshold/);
  const p = await prep(eng, '2026-11-30', 'close_out');
  ok('a close-out settlement can be prepared for the cancelled engagement (2 days = 2,000)', Number(p.units) === 2 && Number(p.gross) === 2000);
  ok('...after which nothing is due', (await call('temporary_engagements_due', arr([eng])))[eng].close_out_due === false);
}

{ // maximum-days warning: total ACTIVE days, not unsettled days
  const emp = await worker(1000);
  const eng = await call('create_temporary_engagement', emp, ORDER, 1000, '2026-11-02', null, 4, null, true, hos1, 'head_of_sales');   // max 4 days
  await book(eng, W.slice(0, 3));
  let d = (await call('temporary_engagements_due', arr([eng])))[eng];
  ok('3 of 4 days: total_units 3, max_days 4, no warning yet', Number(d.total_units) === 3 && Number(d.max_days) === 4 && d.max_days_reached === false, JSON.stringify(d));
  const s = await prep(eng, '2026-11-30', 'threshold'); await approve(s.id);
  await book(eng, [W[3]]);
  d = (await call('temporary_engagements_due', arr([eng])))[eng];
  ok('4 of 4 days reached: warning is on although 3 of the days are already settled (unsettled = 1)', d.max_days_reached === true && Number(d.total_units) === 4 && Number(d.eligible_units) === 1, JSON.stringify(d));
  const single = await call('temporary_engagement_due', eng);
  ok('single-engagement summary agrees', single.max_days_reached === true && Number(single.total_units) === 4);
  await book(eng, [W[4]]);
  ok('a fifth marked day counts toward the total', Number((await call('temporary_engagement_due', eng)).total_units) === 5);
  await clearDay(eng, W[4]);
  ok('a cleared day does not count', Number((await call('temporary_engagement_due', eng)).total_units) === 4);
  const noMax = await engage(await worker(1000));
  ok('an engagement without max_days never warns', (await call('temporary_engagements_due', arr([noMax])))[noMax].max_days_reached === false);
  // the total follows the worker across a rate revision (the new version inherits max_days)
  const emp2 = await worker(1000);
  const e1 = await call('create_temporary_engagement', emp2, ORDER, 1000, '2026-11-02', null, 3, null, true, hos1, 'head_of_sales');
  await book(e1, W.slice(0, 2));
  const e2 = await call('revise_engagement_rate', e1, 1200, 'New rate', hos1, 'head_of_sales');
  const today = await val(`SELECT start_date::text FROM temporary_worker_engagements WHERE id=$1`, [e2]);
  await book(e2, [today]);
  const dd = (await call('temporary_engagements_due', arr([e2])))[e2];
  ok('across a rate revision the total counts the earlier version (2 + 1 = 3 of 3 -> warning)', Number(dd.total_units) === 3 && dd.max_days_reached === true, JSON.stringify(dd));
}

{ // approval: separation of duties follows the person who MARKED the days
  const emp = await worker(1000); const eng = await engage(emp);
  await book(eng, [W[0]], { recorder: pmRec, role: 'production_manager' });
  await book(eng, [W[1], W[2]], { recorder: hos2, role: 'head_of_sales' });
  const p = await prep(eng, '2026-11-30', 'threshold', null, hos1, 'head_of_sales');
  await throws('the preparer cannot approve', () => approve(p.id, hos1), /prepared or whose days you marked/);
  await throws('the person who marked one day cannot approve', () => approve(p.id, pmRec, 'production_manager'), /prepared or whose days you marked/);
  await throws('the person who marked the other days cannot approve either', () => approve(p.id, hos2, 'head_of_sales'), /prepared or whose days you marked/);
  await throws('an admin who marked days must give an override reason', async () => { const e = await engage(await worker(1000)); await book(e, W.slice(0, 3), { recorder: admin, role: 'admin' }); const x = await prep(e, '2026-11-30'); await approve(x.id, admin, 'admin'); }, /override reason/);
  await approve(p.id, pmApp, 'production_manager');
  ok('a third person approves with no override', (await st(p.id)) === 'approved' && (await val(`SELECT approval_override FROM temporary_worker_settlements WHERE id=$1`, [p.id])) === false);
}

{ // damage default
  await q(`DELETE FROM temporary_worker_settings`); await q(`INSERT INTO temporary_worker_settings (id) VALUES (true)`);
  ok('a freshly created settings row has damage deductions OFF', (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === false);
  await q(`UPDATE temporary_worker_settings SET damage_deductions_enabled = true`);
  const hasDamage = Number(await val(`SELECT count(*) FROM temporary_worker_settlement_deductions WHERE deduction_type='damage'`));
  await runAll();
  ok('re-running the migrations leaves the setting alone when a damage deduction has ever been recorded', hasDamage > 0 && (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === true);
  await resetSettings();
  ok('after re-running in order the Production link stays retired (stage 2 last)', Number(await val(`SELECT count(*) FROM pg_proc WHERE proname = 'link_assignment_to_engagement'`)) === 0);
  await pinToday('2099-12-31');
}

{ // new functions are service_role only
  const fns = (await q(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
     AND p.proname IN ('tw_lock_employee','tw_lock_run','tw_engagement_overlap','tw_payroll_run_overlap_guard','tw_attendance_insert_guard','tw_attendance_guard','tw_today','temporary_engagements_due','mark_temporary_attendance','create_temporary_engagement')`)).rows;
  let open = [];
  for (const f of fns) for (const r of ['anon', 'authenticated', 'public'])
    if (await val(`SELECT has_function_privilege('${r}', '${f.sig}', 'EXECUTE')`)) open.push(`${r}:${f.sig}`);
  ok(`stage 1b/2 functions are not executable by anon / authenticated / public (${fns.length} checked)`, fns.length === 10 && open.length === 0, open.join(',') + ' / ' + fns.length);
  ok('attendance table: RLS on, not readable by anon / authenticated / public',
    (await val(`SELECT relrowsecurity FROM pg_class WHERE relname='temporary_worker_attendance'`)) === true
    && !(await val(`SELECT has_table_privilege('anon','public.temporary_worker_attendance','SELECT')`))
    && !(await val(`SELECT has_table_privilege('authenticated','public.temporary_worker_attendance','SELECT')`))
    && !(await val(`SELECT has_table_privilege('public','public.temporary_worker_attendance','SELECT')`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
