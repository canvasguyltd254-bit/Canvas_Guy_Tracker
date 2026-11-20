// Database tests for supabase/migrations/temporary_workers_stage1.sql (spec: docs/specs/temporary-workers.md v2.1)
//
// Runs the REAL payroll_module.sql, production_v3a_labour_costing.sql, production_v3b_time_entry_day_lock.sql
// and the Stage 1 migration against an in-process Postgres (pglite). Only the Production parent tables
// (jobs, stages, operations, assignments) are minimal stubs. Time entries are created and approved through
// the real record_time_entry / transition_time_entry functions.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/temporary_workers_stage1.pglite.mjs
//
// NOT covered here: true concurrency (pglite is single-connection). See
// supabase/tests/temporary_workers_concurrency.mjs (real Postgres, two connections).

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
ok('migration applies on top of the real payroll and production v3a/v3b migrations', true);
ok('migration is idempotent (second run)', await db.exec(mig('temporary_workers_stage1.sql')).then(() => true, e => { console.log(e.message); return false; }));

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

// One assignment per worker, linked to the engagement.
const assign = async (emp, eng) => {
  const a = (await one(`INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call('link_assignment_to_engagement', a, eng, pmRec, 'production_manager');
  return a;
};
const W = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
const SUNDAY = '2026-11-08';
// Record AND approve time entries through the real ledger functions.
const book = async (a, dates, o = {}) => {
  const ids = [];
  for (const d of dates) {
    const r = await call('record_time_entry', a, d, o.units ?? 1, !!o.ot, o.ot ? 'night work' : null, null, true, o.recorder || pmRec, '2026-12-31');
    if (!o.keepSubmitted) await call('transition_time_entry', r.id, 'approve', o.approver || pmApp, 'production_manager', null);
    ids.push(r.id);
  }
  return ids;
};
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
// Engagements and the link to Production
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

  await throws('head of sales cannot link an assignment (production manager / admin only)', async () => {
    const a = (await one(`INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
    await call('link_assignment_to_engagement', a, eng, hos1, 'head_of_sales');
  }, /Not allowed/);
  const a = await assign(emp, eng);
  ok('link sets the assignment rate snapshot to the agreed rate', Number(await val(`SELECT daily_rate_snapshot FROM production_job_assignments WHERE id=$1`, [a])) === 1500);
  const wrongOrder = (await one(`INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [OTHER_JOB, OTHER_STAGE, OP, emp])).id;
  await throws('assignment on another project cannot be linked', () => call('link_assignment_to_engagement', wrongOrder, eng, pmRec, 'production_manager'), /project does not match/);
  const otherEmp = await worker();
  const wrongWorker = (await one(`INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, otherEmp])).id;
  await throws('assignment of another worker cannot be linked', () => call('link_assignment_to_engagement', wrongWorker, eng, pmRec, 'production_manager'), /worker does not match/);
  await book(a, [W[0]]);
  const a2 = (await one(`INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call('link_assignment_to_engagement', a2, eng, pmRec, 'production_manager');
  await book(a2, [W[1]]);
  await throws('link refused once time has been recorded on the assignment', () => call('link_assignment_to_engagement', a2, eng, pmRec, 'production_manager'), /Time has already been recorded/);
  await throws('engagement rate cannot be edited in place', () => q(`UPDATE temporary_worker_engagements SET agreed_daily_rate = 2000 WHERE id=$1`, [eng]), /cannot change/);

  // revision
  const v2 = await call('revise_engagement_rate', eng, 1800, 'Agreed a higher rate', hos1, 'head_of_sales');
  ok('rate revision closes the old version and opens version 2', (await val(`SELECT status FROM temporary_worker_engagements WHERE id=$1`, [eng])) === 'completed'
    && Number(await val(`SELECT version FROM temporary_worker_engagements WHERE id=$1`, [v2])) === 2
    && (await val(`SELECT supersedes_id FROM temporary_worker_engagements WHERE id=$1`, [v2])) === eng);
  ok('earlier assignment keeps the old rate', Number(await val(`SELECT daily_rate_snapshot FROM production_job_assignments WHERE id=$1`, [a])) === 1500);
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
// Due calculation and preparing a settlement
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 2));
  let due = await call('temporary_engagement_due', eng);
  ok('2.00 approved units: not due', Number(due.eligible_units) === 2 && due.due === false);
  await throws('threshold settlement refused below 3.00', () => prep(eng, '2026-11-30'), /threshold is/);
  await throws('early settlement needs a reason', () => prep(eng, '2026-11-30', 'early', ' '), /needs a reason/);
  await throws('close-out refused while the engagement is active', () => prep(eng, '2026-11-30', 'close_out'), /completed or cancelled/);
  await book(a, [W[2]], { units: 0.99 });
  due = await call('temporary_engagement_due', eng);
  ok('2.99 units: not due', Number(due.eligible_units) === 2.99 && due.due === false);
  await throws('2.99 cannot be settled as a threshold settlement', () => prep(eng, '2026-11-30'), /threshold is/);
  const [x] = await book(a, [W[3]], { units: 0.01 });
  due = await call('temporary_engagement_due', eng);
  ok('3.00 units: due', Number(due.eligible_units) === 3 && due.due === true);
  await book(a, [W[4]], { units: 0.5 });
  const p = await prep(eng, '2026-11-30');
  ok('3.50 units: ALL included in one settlement (no entry split or skipped)', Number(p.units) === 3.5 && p.lines === 5, JSON.stringify(p));
  const s = await one(`SELECT * FROM temporary_worker_settlements WHERE id=$1`, [p.id]);
  ok('settlement figures: gross 3500, net 3500, draft', Number(s.gross_amount) === 3500 && Number(s.net_amount) === 3500 && s.status === 'draft');
  await throws('nothing left to settle afterwards', () => prep(eng, '2026-11-30'), /no approved, unsettled work/);
  const lines = (await q(`SELECT work_date FROM temporary_worker_settlement_lines WHERE settlement_id=$1 ORDER BY work_date`, [p.id])).rows;
  ok('lines are in oldest-first order and cover every entry', lines.length === 5);
  await throws('role without access cannot prepare', () => prep(eng, '2026-11-30', 'early', 'x', hos1, 'production_staff'), /Not allowed/);
}
{ // cutoff, unapproved work, close-out, components
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  await book(a, W.slice(3, 4), { keepSubmitted: true });         // submitted, NOT approved
  await book(a, W.slice(6, 9));                                    // Nov 9-11, after the cutoff below
  const p = await prep(eng, '2026-11-08');
  ok('cutoff excludes later work; unapproved work is excluded', Number(p.units) === 3 && p.lines === 3, JSON.stringify(p));
  const late = await prep(eng, '2026-11-30', 'early', 'client wants it paid now');
  ok('early settlement with a reason takes the later approved work', Number(late.units) === 3);
  const close = await call('set_engagement_status', eng, 'completed', 'Job finished', hos1, 'head_of_sales');
  ok('closing reports no unsettled units (the submitted day is still unapproved)', Number(close.eligible_units) === 0 && close.close_out_due === false);
}
{
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, [W[0]], { ot: true });                              // 1000 + 200
  await book(a, [W[1]]);
  await book(a, [SUNDAY]);                                           // 1000 Sunday rate
  const p = await prep(eng, '2026-11-30', 'early', 'check components');
  const s = await one(`SELECT * FROM temporary_worker_settlements WHERE id=$1`, [p.id]);
  ok('components: base 2000 + overtime 200 + Sunday 1000 = 3200', Number(s.base_amount) === 2000 && Number(s.overtime_amount) === 200 && Number(s.sunday_amount) === 1000 && Number(s.gross_amount) === 3200, JSON.stringify(s));
  const bad = await one(`SELECT count(*)::int AS c FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND line_amount <> base_amount+overtime_amount+sunday_amount`, [p.id]);
  ok('every line reconciles to its parts', bad.c === 0);
  await call('set_engagement_status', eng, 'completed', 'Done', hos1, 'head_of_sales');
}
{ // close-out below the threshold
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 2));
  const c = await call('set_engagement_status', eng, 'completed', 'Job finished early', hos1, 'head_of_sales');
  ok('closing with 2.00 unsettled prompts a close-out', Number(c.eligible_units) === 2 && c.close_out_due === true);
  const p = await prep(eng, '2026-11-30', 'close_out');
  ok('close-out below the threshold works', Number(p.units) === 2);
}
{ // reconciliation failure stops preparation
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  const [id] = await book(a, [W[0]]);
  await q(`ALTER TABLE production_time_entries DISABLE TRIGGER trg_pte_guard`);
  await q(`UPDATE production_time_entries SET actual_labour_cost = 1234 WHERE id=$1`, [id]);   // simulate a corrupted ledger row
  await q(`ALTER TABLE production_time_entries ENABLE TRIGGER trg_pte_guard`);
  await throws('an entry that does not reconcile to its snapshots stops preparation', () => prep(eng, '2026-11-30', 'early', 'x'), /does not reconcile/);
}

// ════════════════════════════════════════════════════════════════════════════
// Approval: separation of duties, limit, split payments
// ════════════════════════════════════════════════════════════════════════════
{
  const emp = await worker(1000); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, 3));
  const p = await prep(eng, '2026-11-30');
  await throws('preparer cannot approve their own settlement', () => approve(p.id, hos1), /prepared or whose attendance/);
  await throws('attendance recorder cannot approve', () => approve(p.id, pmRec, 'production_manager'), /prepared or whose attendance/);
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
  const sh = await sheetFor([s1.id, s2.id]);
  ok('sheet totals computed (3000 + 3000)', Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 6000);
  await throws('a settlement cannot be on two sheets', () => sheetFor([s1.id]), /not already on a payout sheet/);
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
{ // sheet total above the limit although each settlement is under it
  const a1 = await approved(3, 2000), a2 = await approved(3, 2000);          // 6,000 each
  const sh = await sheetFor([a1.id, a2.id]);                                  // 12,000 total
  await throws('sheet total above the limit needs admin even when each settlement is under it', () => call('mark_sheet_printed', sh, hos1, 'head_of_sales'), /admin must approve/);
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
  const entries = (await q(`SELECT l.time_entry_id FROM temporary_worker_settlement_lines l WHERE l.settlement_id=$1`, [s.id])).rows.map(r => r.time_entry_id);
  ok('setup: a paid settlement with 3 active lines', (await st(s.id)) === 'paid' && entries.length === 3);

  await throws('admin cannot void a paid settlement', () => call('void_temporary_settlement', s.id, 'mistake', admin, 'admin'), /final and cannot be voided/);
  await throws('direct SQL cannot void a paid settlement', () => q(`UPDATE temporary_worker_settlements SET status='voided', voided_by=$2, voided_at=now(), void_reason='x', paid_by=NULL, paid_at=NULL, received_by_full_name=NULL, payout_sheet_id=NULL WHERE id=$1`, [s.id, admin]), /final/);
  await throws('direct SQL cannot edit a paid settlement', () => q(`UPDATE temporary_worker_settlements SET gross_amount=1, base_amount=1, overtime_amount=0, sunday_amount=0, net_amount=1 WHERE id=$1`, [s.id]), /final/);
  await throws('lines of a paid settlement cannot be released', () => q(`UPDATE temporary_worker_settlement_lines SET active=false WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  await throws('lines of a paid settlement cannot be deleted', () => q(`DELETE FROM temporary_worker_settlement_lines WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  await throws('lines of a paid settlement cannot be edited', () => q(`UPDATE temporary_worker_settlement_lines SET line_amount=1, base_amount=1, overtime_amount=0, sunday_amount=0 WHERE settlement_id=$1`, [s.id]), /Paid work is final/);
  await throws('a time entry in a paid settlement cannot be voided (even by admin)', () => call('transition_time_entry', entries[0], 'void', admin, 'admin', 'recorded wrongly'), /void that settlement first/);
  await throws('a time entry in a paid settlement cannot be voided by direct SQL', () => q(`UPDATE production_time_entries SET status='voided', voided_by=$2, voided_at=now(), void_reason='x' WHERE id=$1`, [entries[0], admin]), /void that settlement first/);
  ok('the entries are still approved and still in active lines', Number(await val(`SELECT count(*) FROM production_time_entries WHERE id = ANY($1::uuid[]) AND status='approved'`, [arr(entries)])) === 3
    && Number(await val(`SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 3);
  await throws('the same work cannot be paid a second time (nothing left to settle)', () => prep(s.eng, '2026-11-30', 'early', 'try again'), /no approved, unsettled work/);
  await throws('a second line for a paid entry is refused by the unique index', async () => {
    const p2 = await draft();           // a different worker's draft settlement
    await q(`INSERT INTO temporary_worker_settlement_lines (settlement_id, time_entry_id, work_date, attendance_units, base_amount, overtime_amount, sunday_amount, line_amount)
             VALUES ($1,$2,'2026-11-02',1,1000,0,0,1000)`, [p2.id, entries[0]]);
  }, /uq_twl_entry_active|duplicate key/);
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
// Voiding an unpaid settlement frees the work; an entry in an active settlement is protected
// ════════════════════════════════════════════════════════════════════════════
{
  const s = await approved(3);
  const entry = await val(`SELECT time_entry_id FROM temporary_worker_settlement_lines WHERE settlement_id=$1 LIMIT 1`, [s.id]);
  await throws('an entry in an ACTIVE settlement cannot be voided', () => call('transition_time_entry', entry, 'void', admin, 'admin', 'wrong day'), /void that settlement first/);
  await throws('production manager cannot void an approved settlement', () => call('void_temporary_settlement', s.id, 'changed', pmApp, 'production_manager'), /Only an admin/);
  await throws('void needs a reason', () => call('void_temporary_settlement', s.id, ' ', admin, 'admin'), /reason is required/);
  await call('void_temporary_settlement', s.id, 'Wrong period chosen', admin, 'admin');
  ok('voided settlement is final and its lines are released', (await st(s.id)) === 'voided'
    && Number(await val(`SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 0);
  await throws('a voided settlement cannot be revived', () => q(`UPDATE temporary_worker_settlements SET status='draft' WHERE id=$1`, [s.id]), /final/);
  const again = await prep(s.eng, '2026-11-30');
  ok('the freed work can be settled again', Number(again.units) === 3);
  await approve(again.id); await signedSheet([again.id]); await pay(again.id);
  ok('...and paid once', (await st(again.id)) === 'paid');
}
{
  const s = await approved(3);
  const entry = await val(`SELECT time_entry_id FROM temporary_worker_settlement_lines WHERE settlement_id=$1 LIMIT 1`, [s.id]);
  await call('void_temporary_settlement', s.id, 'Not needed', admin, 'admin');
  await call('transition_time_entry', entry, 'void', admin, 'admin', 'Recorded on the wrong day');
  ok('once the settlement is voided the entry can be voided', (await val(`SELECT status FROM production_time_entries WHERE id=$1`, [entry])) === 'voided');
  const p = await prep(s.eng, '2026-11-30', 'early', 'two days left');
  ok('the voided entry is no longer settled', Number(p.units) === 2);
}
{ // draft void by any run role; approved on an open sheet leaves the sheet; signed sheet blocks void
  const d = await draft();
  await call('void_temporary_settlement', d.id, 'Prepared by mistake', hos1, 'head_of_sales');
  ok('a draft can be voided by head of sales', (await st(d.id)) === 'voided');
  const a1 = await approved(), a2 = await approved();
  const sh = await sheetFor([a1.id, a2.id]);
  await call('void_temporary_settlement', a1.id, 'Worker left the site', admin, 'admin');
  ok('voiding an approved settlement removes it from an open sheet and recomputes totals',
    Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 3000);
  await call('mark_sheet_printed', sh, hos1, 'head_of_sales'); await call('attach_signed_receipt', sh, 'r.jpg', hos1, 'head_of_sales');
  await throws('a settlement on a SIGNED sheet cannot be voided until the sheet is cancelled', () => call('void_temporary_settlement', a2.id, 'x', admin, 'admin'), /cancel the sheet first/);
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
  const tables = ['temporary_worker_settings', 'temporary_worker_engagements', 'temporary_worker_settlements', 'temporary_worker_settlement_lines', 'temporary_worker_settlement_deductions', 'temporary_worker_payout_sheets'];
  let leak = [];
  for (const t of tables) for (const r of ['anon', 'authenticated', 'public'])
    if (await val(`SELECT has_table_privilege('${r}', 'public.${t}', 'SELECT')`)) leak.push(`${r}:${t}`);
  ok('no table is readable by anon / authenticated / public', leak.length === 0, leak.join(','));
  ok('every table has RLS enabled', Number(await val(`SELECT count(*) FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity`, [arr(tables)])) === tables.length);
  ok('service_role can read the tables', await val(`SELECT has_table_privilege('service_role', 'public.temporary_worker_settlements', 'SELECT')`));
  const fns = (await q(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
     AND (p.proname LIKE 'tw\\_%' OR p.proname IN ('pay_temporary_settlement','approve_temporary_settlement','void_temporary_settlement','prepare_temporary_settlement','create_payout_sheet','set_temporary_worker_settings'))`)).rows;
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
