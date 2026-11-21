// Two-connection concurrency tests for the temporary-workers Stage 1 migration, on REAL Postgres.
// pglite is single-connection and cannot prove any of this.
//
// Technique: connection A opens a transaction and calls a function WITHOUT committing, so it holds its
// locks. Connection B then calls a conflicting function; we confirm B is genuinely BLOCKED (wait_event_type
// = 'Lock' in pg_stat_activity), then A commits and we assert B's outcome and the final database state.
//
// Run it against an EMPTY SCRATCH database (a local Postgres, or a throwaway Supabase branch). It builds its own
// schema (payroll_module.sql, production v3a/v3b, the Stage 1 migration, and minimal Production parent-table stubs)
// and REFUSES to run if an `employees` table already exists, so it can never touch real data.
//
//   mkdir -p /tmp/pgc && cd /tmp/pgc && npm init -y && npm i pg
//   CONCURRENCY_DB_URL=postgres://user:pass@localhost:5432/scratch PG_DIR=/tmp/pgc \
//     node supabase/tests/temporary_workers_concurrency.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PG_DIR || '/tmp/pgc') + '/');
const { Client } = require('pg');
const URL = process.env.CONCURRENCY_DB_URL;
if (!URL) { console.error('Set CONCURRENCY_DB_URL to an EMPTY scratch database.'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const mig = f => readFileSync(join(here, '../migrations', f), 'utf8');

const connect = async () => { const c = new Client({ connectionString: URL }); await c.connect(); c.pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p; return c; };
const admin = await connect();
const A = await connect(), B = await connect(), C = await connect();

if ((await admin.query(`SELECT to_regclass('public.employees') AS t`)).rows[0].t) {
  console.error('Refusing to run: an employees table already exists. Use an EMPTY scratch database.'); process.exit(2);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const one = async (c, sql, p) => (await c.query(sql, p)).rows[0];
const val = async (c, sql, p) => { const r = await one(c, sql, p); return r ? Object.values(r)[0] : null; };
const call = async (c, name, ...args) => (await one(c, `SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).r;
const arr = ids => '{' + ids.join(',') + '}';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── schema ──────────────────────────────────────────────────────────────────
await admin.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE production_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'Planned', order_id uuid NOT NULL REFERENCES orders(id));
  CREATE TABLE production_job_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_key text, stage_label text, is_enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE production_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_key text, is_active boolean DEFAULT true);
  CREATE TABLE production_job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_id uuid REFERENCES production_job_stages(id), operation_id uuid REFERENCES production_operations(id), employee_id uuid, status text NOT NULL DEFAULT 'Assigned');
`);
await admin.query(mig('payroll_module.sql'));
await admin.query(`ALTER TABLE production_job_assignments ADD CONSTRAINT fk_emp FOREIGN KEY (employee_id) REFERENCES employees(id)`);
for (const f of ['production_v3a_labour_costing.sql', 'production_v3b_time_entry_day_lock.sql', 'temporary_workers_stage1.sql', 'temporary_workers_stage1b.sql']) await admin.query(mig(f));

// ── fixtures ────────────────────────────────────────────────────────────────
const user = async () => (await one(admin, `INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const [adm, pmRec, pmApp, hos1, hos2, pmPay] = [await user(), await user(), await user(), await user(), await user(), await user()];
const ORDER = (await one(admin, `INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const JOB = (await one(admin, `INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [ORDER])).id;
const STAGE = (await one(admin, `INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [JOB])).id;
const OP = (await one(admin, `INSERT INTO production_operations (stage_key) VALUES ('cut') RETURNING id`)).id;
let n = 0;
const DATES = ['2026-11-02', '2026-11-03', '2026-11-04'];

// A worker with 3 approved days and a draft settlement (status per `upTo`).
async function scenario(upTo = 'draft') {
  const emp = (await one(admin, `INSERT INTO employees (employee_num, name, type, day_rate) VALUES ($1,$2,'casual',1000) RETURNING id`, [`C-${++n}`, `Conc ${n}`])).id;
  const eng = await call(admin, 'create_temporary_engagement', emp, ORDER, 1000, '2026-11-02', null, null, null, true, hos1, 'head_of_sales');
  const asg = (await one(admin, `INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call(admin, 'link_assignment_to_engagement', asg, eng, pmRec, 'production_manager');
  const entries = [];
  for (const d of DATES) {
    const r = await call(admin, 'record_time_entry', asg, d, 1, false, null, null, true, pmRec, '2026-12-31');
    await call(admin, 'transition_time_entry', r.id, 'approve', pmApp, 'production_manager', null);
    entries.push(r.id);
  }
  const s = { emp, eng, asg, entries };
  if (upTo === 'engaged') return s;
  s.p = await call(admin, 'prepare_temporary_settlement', eng, '2026-11-30', 'threshold', null, hos1, 'head_of_sales'); s.id = s.p.id;
  if (upTo === 'draft') return s;
  await call(admin, 'approve_temporary_settlement', s.id, hos2, 'head_of_sales', null);
  if (upTo === 'approved') return s;
  s.sheet = await call(admin, 'create_payout_sheet', arr([s.id]), hos1, 'head_of_sales');
  if (upTo === 'sheet') return s;
  await call(admin, 'mark_sheet_printed', s.sheet, hos1, 'head_of_sales');
  await call(admin, 'attach_signed_receipt', s.sheet, 'receipts/x.jpg', hos1, 'head_of_sales');
  return s;                                                     // 'signed'
}

// Run `fnA` inside an open transaction on A (locks held), then start `fnB` on B and prove it is blocked,
// then commit A (or roll back) and return B's outcome.
async function race(name, fnA, fnB, { commitA = true } = {}) {
  await A.query('BEGIN');
  let aErr = null;
  try { await fnA(A); } catch (e) { aErr = e; }
  if (aErr) { await A.query('ROLLBACK'); ok(`${name}: first connection succeeded`, false, aErr.message); return { a: aErr, b: null }; }
  let bDone = false, bRes, bErr = null;
  const bP = fnB(B).then(r => { bRes = r; }, e => { bErr = e; }).finally(() => { bDone = true; });
  let blocked = false;
  for (let i = 0; i < 40 && !bDone; i++) {
    await sleep(100);
    const w = await val(admin, `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [B.pid]);
    if (w === 'Lock') { blocked = true; break; }
  }
  ok(`${name}: second connection is genuinely BLOCKED while the first holds its locks`, blocked && !bDone, `blocked=${blocked} done=${bDone}`);
  await A.query(commitA ? 'COMMIT' : 'ROLLBACK');
  await bP;
  return { b: bErr, bRes };
}
const st = id => val(admin, `SELECT status FROM temporary_worker_settlements WHERE id=$1`, [id]);

// ── S1: two simultaneous prepares for the same engagement ───────────────────
{
  const s = await scenario('engaged');
  const r = await race('S1 prepare vs prepare',
    c => call(c, 'prepare_temporary_settlement', s.eng, '2026-11-30', 'threshold', null, hos1, 'head_of_sales'),
    c => call(c, 'prepare_temporary_settlement', s.eng, '2026-11-30', 'threshold', null, hos2, 'head_of_sales'));
  ok('S1: the loser is refused (nothing left to settle)', r.b && /no approved, unsettled work/.test(r.b.message), r.b?.message);
  ok('S1: exactly one settlement and one active line per entry', Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlements WHERE engagement_id=$1`, [s.eng])) === 1
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines l JOIN temporary_worker_settlements x ON x.id=l.settlement_id WHERE x.engagement_id=$1 AND l.active`, [s.eng])) === 3);
}

// ── S2: two approvers at once ───────────────────────────────────────────────
{
  const s = await scenario('draft');
  const r = await race('S2 approve vs approve',
    c => call(c, 'approve_temporary_settlement', s.id, hos2, 'head_of_sales', null),
    c => call(c, 'approve_temporary_settlement', s.id, adm, 'admin', null));
  ok('S2: second approval refused (already approved)', r.b && /Only a draft settlement/.test(r.b.message), r.b?.message);
  ok('S2: approved exactly once, by the first approver', (await st(s.id)) === 'approved' && (await val(admin, `SELECT approved_by FROM temporary_worker_settlements WHERE id=$1`, [s.id])) === hos2);
}

// ── S3: approve vs void ─────────────────────────────────────────────────────
{
  const s = await scenario('draft');
  const r = await race('S3 void (draft) vs approve',
    c => call(c, 'void_temporary_settlement', s.id, 'prepared in error', hos1, 'head_of_sales'),
    c => call(c, 'approve_temporary_settlement', s.id, hos2, 'head_of_sales', null));
  ok('S3: approval refused after the void commits', r.b && /Only a draft settlement/.test(r.b.message), r.b?.message);
  ok('S3: settlement is voided and its entries are free', (await st(s.id)) === 'voided'
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 0);
}

// ── S4: the same settlement paid twice at once ──────────────────────────────
{
  const s = await scenario('signed');
  const r = await race('S4 pay vs pay',
    c => call(c, 'pay_temporary_settlement', s.id, pmPay, 'production_manager', 'Jane Wanjiru', null),
    c => call(c, 'pay_temporary_settlement', s.id, hos2, 'head_of_sales', 'Jane Wanjiru', null));
  ok('S4: second payment refused (already paid)', r.b && /already paid/.test(r.b.message), r.b?.message);
  ok('S4: paid exactly once, by the first payer', (await st(s.id)) === 'paid' && (await val(admin, `SELECT paid_by FROM temporary_worker_settlements WHERE id=$1`, [s.id])) === pmPay);
}

// ── S5: voiding a time entry while a settlement is being prepared ───────────
{
  const s = await scenario('engaged');
  const r = await race('S5 prepare first, entry void second',
    c => call(c, 'prepare_temporary_settlement', s.eng, '2026-11-30', 'threshold', null, hos1, 'head_of_sales'),
    c => call(c, 'transition_time_entry', s.entries[0], 'void', adm, 'admin', 'wrong day'));
  ok('S5: the entry void is refused once the line exists', r.b && /void that settlement first/.test(r.b.message), r.b?.message);
  ok('S5: entry still approved and still in an active line', (await val(admin, `SELECT status FROM production_time_entries WHERE id=$1`, [s.entries[0]])) === 'approved'
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines WHERE time_entry_id=$1 AND active`, [s.entries[0]])) === 1);
}
{
  const s = await scenario('engaged');
  const r = await race('S5b entry void first, prepare second',
    c => call(c, 'transition_time_entry', s.entries[0], 'void', adm, 'admin', 'wrong day'),
    c => call(c, 'prepare_temporary_settlement', s.eng, '2026-11-30', 'early', 'two days left', hos1, 'head_of_sales'));
  ok('S5b: prepare succeeds without the voided entry', !r.b && r.bRes && Number(r.bRes.units) === 2, r.b?.message);
  ok('S5b: no active line references a voided entry', Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines l JOIN production_time_entries e ON e.id=l.time_entry_id WHERE l.active AND e.status <> 'approved'`)) === 0);
}

// ── S6: paying vs cancelling the sheet ──────────────────────────────────────
{
  const s = await scenario('signed');
  const r = await race('S6 pay first, cancel sheet second',
    c => call(c, 'pay_temporary_settlement', s.id, pmPay, 'production_manager', 'Jane Wanjiru', null),
    c => call(c, 'cancel_payout_sheet', s.sheet, 'wrong sheet', adm, 'admin'));
  ok('S6: cancel refused once the settlement is paid', r.b && /paid settlement cannot be cancelled/.test(r.b.message), r.b?.message);
  ok('S6: settlement paid, sheet still signed', (await st(s.id)) === 'paid' && (await val(admin, `SELECT status FROM temporary_worker_payout_sheets WHERE id=$1`, [s.sheet])) === 'signed');
}
{
  const s = await scenario('signed');
  const r = await race('S6b cancel sheet first, pay second',
    c => call(c, 'cancel_payout_sheet', s.sheet, 'wrong sheet', adm, 'admin'),
    c => call(c, 'pay_temporary_settlement', s.id, pmPay, 'production_manager', 'Jane Wanjiru', null));
  ok('S6b: payment refused after the sheet is cancelled', r.b && /sheet changed|signed and attached|payout sheet first/.test(r.b.message), r.b?.message);
  ok('S6b: settlement unpaid, back to approved with no sheet', (await st(s.id)) === 'approved' && (await val(admin, `SELECT payout_sheet_id FROM temporary_worker_settlements WHERE id=$1`, [s.id])) === null);
}

// ── S7: one settlement put on two sheets at once ────────────────────────────
{
  const s = await scenario('approved');
  const r = await race('S7 create sheet vs create sheet',
    c => call(c, 'create_payout_sheet', arr([s.id]), hos1, 'head_of_sales'),
    c => call(c, 'create_payout_sheet', arr([s.id]), hos2, 'head_of_sales'));
  ok('S7: second sheet refused', r.b && /not already on a payout sheet/.test(r.b.message), r.b?.message);
  ok('S7: the settlement is on exactly one sheet', Number(await val(admin, `SELECT count(DISTINCT payout_sheet_id) FROM temporary_worker_settlements WHERE id=$1 AND payout_sheet_id IS NOT NULL`, [s.id])) === 1);
}

// ── S8: voiding an approved settlement while it is being paid ───────────────
{
  const s = await scenario('signed');
  const r = await race('S8 void (approved) vs pay',
    c => call(c, 'pay_temporary_settlement', s.id, pmPay, 'production_manager', 'Jane Wanjiru', null),
    c => call(c, 'void_temporary_settlement', s.id, 'changed my mind', adm, 'admin'));
  ok('S8: void refused once payment commits (paid is final)', r.b && /paid settlement is final|signed payout sheet/.test(r.b.message), r.b?.message);
  ok('S8: settlement is paid and its lines are still active', (await st(s.id)) === 'paid'
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines WHERE settlement_id=$1 AND active`, [s.id])) === 3);
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE 1b — overlap races (engagement vs payroll) and attendance races
// ════════════════════════════════════════════════════════════════════════════
let rn = 0;
const mkWorker = async () => (await one(admin, `INSERT INTO employees (employee_num, name, type, day_rate) VALUES ($1,$2,'casual',1000) RETURNING id`, [`R-${++n}`, `Race ${n}`])).id;
const mkRun = async (start, end) => (await one(admin, `INSERT INTO payroll_runs (run_num, period_type, period_start, period_end, run_type) VALUES ($1,'weekly',$2::date,$3::date,'casual') RETURNING id`, [`PR-R${++rn}`, start, end])).id;
const addEntry = (c, run, emp) => c.query(`INSERT INTO payroll_entries (run_id, employee_id, snapshot_name, snapshot_type, snapshot_sha, gross_pay, net_pay) VALUES ($1,$2,'x','casual',0,1000,1000)`, [run, emp]);
const mkEng = (c, emp, start = '2026-11-02', end = null, activate = true) => call(c, 'create_temporary_engagement', emp, ORDER, 1000, start, end, null, null, activate, hos1, 'head_of_sales');
const overlapCount = emp => val(admin, `SELECT count(*) FROM payroll_entries pe JOIN payroll_runs r ON r.id=pe.run_id JOIN temporary_worker_engagements e ON e.employee_id=pe.employee_id
   WHERE pe.employee_id=$1 AND e.status IN ('planned','active') AND e.start_date <= r.period_end AND COALESCE(e.expected_end_date,'infinity') >= r.period_start`, [emp]).then(Number);

// R1: engagement creation (first) vs payroll insertion (second)
{
  const emp = await mkWorker(); const run = await mkRun('2026-11-02', '2026-11-08');
  const r = await race('R1 create engagement first, payroll entry second',
    c => mkEng(c, emp, '2026-11-02', '2026-11-30'), c => addEntry(c, run, emp));
  ok('R1: the payroll insert is refused once the engagement commits', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
  ok('R1: no worker ends up in both (engagement kept, payroll entry absent)', await overlapCount(emp) === 0
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_engagements WHERE employee_id=$1`, [emp])) === 1);
}
// R2: payroll insertion (first) vs engagement creation (second)
{
  const emp = await mkWorker(); const run = await mkRun('2026-11-02', '2026-11-08');
  const r = await race('R2 payroll entry first, create engagement second',
    c => addEntry(c, run, emp), c => mkEng(c, emp, '2026-11-02', '2026-11-30'));
  ok('R2: the engagement is refused once the payroll entry commits', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
  ok('R2: payroll entry kept, no engagement created', Number(await val(admin, `SELECT count(*) FROM payroll_entries WHERE employee_id=$1`, [emp])) === 1
    && Number(await val(admin, `SELECT count(*) FROM temporary_worker_engagements WHERE employee_id=$1`, [emp])) === 0);
}
// R3: activation vs payroll insertion (a planned engagement is activated while a payroll entry is inserted)
{
  const emp = await mkWorker(); const run = await mkRun('2026-11-02', '2026-11-08');
  const eng = await mkEng(admin, emp, '2026-11-02', '2026-11-30', false);
  const r = await race('R3 activate first, payroll entry second',
    c => call(c, 'set_engagement_status', eng, 'active', null, hos1, 'head_of_sales'), c => addEntry(c, run, emp));
  ok('R3: payroll insert refused; engagement is active', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message)
    && (await val(admin, `SELECT status FROM temporary_worker_engagements WHERE id=$1`, [eng])) === 'active', r.b?.message);
  const emp2 = await mkWorker(); const run2 = await mkRun('2026-11-02', '2026-11-08');
  const eng2 = await mkEng(admin, emp2, '2026-11-02', '2026-11-30', false);
  await admin.query(`UPDATE temporary_worker_engagements SET status='cancelled', closed_by=$2, closed_at=now(), close_reason='x' WHERE id=$1`, [eng2, hos1]);
  const eng3 = await mkEng(admin, emp2, '2026-12-01', '2026-12-31', false);          // clear of run2
  const r2 = await race('R3b payroll entry first, activate second',
    c => addEntry(c, run2, emp2), c => call(c, 'set_engagement_status', eng3, 'active', null, hos1, 'head_of_sales'));
  ok('R3b: activation proceeds (no overlap) and the payroll entry stands', !r2.b && await overlapCount(emp2) === 0);
}
// R4: rate revision vs payroll insertion
{
  const emp = await mkWorker(); const eng = await mkEng(admin, emp, '2026-01-05', null);
  const today = (await val(admin, `SELECT current_date::text`));
  const run = await mkRun(today, (await val(admin, `SELECT (current_date + 6)::text`)));
  const r = await race('R4 revise first, payroll entry second',
    c => call(c, 'revise_engagement_rate', eng, 1500, 'Raise', hos1, 'head_of_sales'), c => addEntry(c, run, emp));
  ok('R4: payroll insert refused (new active version covers today onward)', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
  ok('R4: exactly one active version, zero overlapping payroll entries', Number(await val(admin, `SELECT count(*) FROM temporary_worker_engagements WHERE employee_id=$1 AND status='active'`, [emp])) === 1 && await overlapCount(emp) === 0);
  const emp2 = await mkWorker(); const eng2 = await mkEng(admin, emp2, '2026-01-05', null);
  const run2 = await mkRun('2025-12-01', '2025-12-07');                                // before the engagement: allowed
  const r2 = await race('R4b payroll entry (clear period) first, revise second',
    c => addEntry(c, run2, emp2), c => call(c, 'revise_engagement_rate', eng2, 1500, 'Raise', hos1, 'head_of_sales'));
  ok('R4b: revision proceeds when the payroll run is clear of the engagement', !r2.b, r2.b?.message);
}
// R5: payroll run date edit vs engagement creation, both directions
{
  const emp = await mkWorker(); const run = await mkRun('2026-11-02', '2026-11-08'); await addEntry(admin, run, emp);
  const r = await race('R5 run date edit first, create engagement second',
    c => c.query(`UPDATE payroll_runs SET period_end='2026-11-20' WHERE id=$1`, [run]), c => mkEng(c, emp, '2026-11-15', '2026-11-30'));
  ok('R5: the engagement is refused (sees the committed new dates)', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
  const emp2 = await mkWorker(); const run2 = await mkRun('2026-11-02', '2026-11-08'); await addEntry(admin, run2, emp2);
  const r2 = await race('R5b create engagement first, run date edit second',
    c => mkEng(c, emp2, '2026-11-15', '2026-11-30'), c => c.query(`UPDATE payroll_runs SET period_end='2026-11-20' WHERE id=$1`, [run2]));
  ok('R5b: the date edit is refused (sees the committed engagement)', r2.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r2.b.message), r2.b?.message);
  ok('R5b: run dates unchanged', (await val(admin, `SELECT period_end::text FROM payroll_runs WHERE id=$1`, [run2])) === '2026-11-08');
}
// R6: payroll-run APPROVAL vs engagement creation
{
  const emp = await mkWorker(); const run = await mkRun('2026-11-02', '2026-11-08'); await addEntry(admin, run, emp);
  const r = await race('R6 approve run first, create engagement second',
    c => c.query(`UPDATE payroll_runs SET status='approved' WHERE id=$1`, [run]), c => mkEng(c, emp, '2026-11-02', '2026-11-30'));
  ok('R6: the engagement is refused after the run is approved', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
}
// R7: attendance vs payroll insertion (completed engagement: protected days are the days worked)
{
  const emp = await mkWorker(); const eng = await mkEng(admin, emp, '2026-11-02', null);
  const asg = (await one(admin, `INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call(admin, 'link_assignment_to_engagement', asg, eng, pmRec, 'production_manager');
  await call(admin, 'set_engagement_status', eng, 'completed', 'Done', hos1, 'head_of_sales');
  const eng2 = await mkEng(admin, emp, '2026-11-02', null);                 // second engagement for the same worker
  const asg2 = (await one(admin, `INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call(admin, 'link_assignment_to_engagement', asg2, eng2, pmRec, 'production_manager');
  await call(admin, 'set_engagement_status', eng2, 'completed', 'Done', hos1, 'head_of_sales');
  const run = await mkRun('2026-11-09', '2026-11-15');
  // The worker has no attendance and no open engagement: a payroll entry is allowed, so test the race with ATTENDANCE on a live engagement instead.
  const emp3 = await mkWorker(); const eng3 = await mkEng(admin, emp3, '2026-11-02', '2026-11-06');
  const asg3 = (await one(admin, `INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp3])).id;
  await call(admin, 'link_assignment_to_engagement', asg3, eng3, pmRec, 'production_manager');
  const runLate = await mkRun('2026-11-09', '2026-11-15');                   // after the expected end: payroll insert would be allowed
  const r = await race('R7 attendance (after expected end) first, payroll entry second',
    c => call(c, 'record_time_entry', asg3, '2026-11-10', 1, false, null, null, true, pmRec, '2026-12-31'), c => addEntry(c, runLate, emp3));
  ok('R7: payroll insert refused: that day now has temporary attendance', r.b && /TEMP_ENGAGEMENT_OVERLAP/.test(r.b.message), r.b?.message);
  void run;
}
// R8: attendance vs engagement completion
{
  const emp = await mkWorker(); const eng = await mkEng(admin, emp, '2026-11-02', null);
  const asg = (await one(admin, `INSERT INTO production_job_assignments (job_id, stage_id, operation_id, employee_id) VALUES ($1,$2,$3,$4) RETURNING id`, [JOB, STAGE, OP, emp])).id;
  await call(admin, 'link_assignment_to_engagement', asg, eng, pmRec, 'production_manager');
  const r = await race('R8 complete engagement first, attendance second',
    c => call(c, 'set_engagement_status', eng, 'completed', 'Done', hos1, 'head_of_sales'),
    c => call(c, 'record_time_entry', asg, '2026-11-03', 1, false, null, null, true, pmRec, '2026-12-31'));
  ok('R8: attendance refused once the engagement is completed', r.b && /is completed, so no new attendance/.test(r.b.message), r.b?.message);
  ok('R8: no entry was created', Number(await val(admin, `SELECT count(*) FROM production_time_entries WHERE assignment_id=$1`, [asg])) === 0);
}
// R9a: DETERMINISTIC proof of sorted lock order. A holds the advisory lock of the HIGHER employee id. B edits a run that
// contains both employees; B must already hold the lower id's lock (granted) while it waits for the higher one.
{
  const [x, y] = [await mkWorker(), await mkWorker()];
  const [lo, hi] = x < y ? [x, y] : [y, x];
  const run = await mkRun('2027-03-01', '2027-03-07');
  await addEntry(admin, run, hi); await addEntry(admin, run, lo);                 // inserted high-first on purpose
  await A.query('BEGIN'); await A.query(`SELECT pg_advisory_xact_lock(hashtextextended('tw_employee:' || $1::text, 0))`, [hi]);
  let done = false, err = null;
  const bP = B.query(`UPDATE payroll_runs SET period_end='2027-03-08' WHERE id=$1`, [run]).catch(e => { err = e; }).finally(() => { done = true; });
  let waiting = false;
  for (let i = 0; i < 40 && !done; i++) { await sleep(100); if ((await val(admin, `SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1`, [B.pid])) === 'Lock') { waiting = true; break; } }
  const held = Number(await val(admin, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted`, [B.pid]));
  ok('R9a: B is blocked on the HIGHER employee id', waiting && !done);
  ok('R9a: while blocked, B already holds the run lock and the LOWER employee lock (sorted order)', held === 2, `granted advisory locks held by B = ${held}`);
  await A.query('COMMIT'); await bP;
  ok('R9a: B completes after A releases', !err && (await val(admin, `SELECT period_end::text FROM payroll_runs WHERE id=$1`, [run])) === '2027-03-08', err?.message);
}
// R9b: two run-date edits over the same two workers (opposite entry order), repeated: no deadlock
{
  const [w1, w2] = [await mkWorker(), await mkWorker()];
  let deadlocks = 0, trials = 0;
  for (let i = 0; i < 15; i++) {
    const ra = await mkRun('2027-01-04', '2027-01-10'), rb = await mkRun('2027-02-01', '2027-02-07');
    await addEntry(admin, ra, w1); await addEntry(admin, ra, w2);
    await addEntry(admin, rb, w2); await addEntry(admin, rb, w1);                 // opposite insertion order
    const edit = async (c, run, to) => { try { await c.query('BEGIN'); await c.query(`UPDATE payroll_runs SET period_end=$2 WHERE id=$1`, [run, to]); await sleep(20); await c.query('COMMIT'); }
      catch (e) { if (e.code === '40P01') deadlocks++; await c.query('ROLLBACK').catch(() => {}); } };
    await Promise.all([edit(A, ra, '2027-01-11'), edit(B, rb, '2027-02-08')]); trials++;
  }
  ok(`R9: ${trials} concurrent edit pairs over the same workers: no deadlock`, deadlocks === 0, `${deadlocks} deadlocks`);
}

// ── S9: nothing ever double-paid, across the whole run ──────────────────────
ok('S9: no time entry is in more than one active line', Number(await val(admin, `SELECT count(*) FROM (SELECT time_entry_id FROM temporary_worker_settlement_lines WHERE active GROUP BY 1 HAVING count(*) > 1) x`)) === 0);
ok('S9: no paid settlement has an inactive line', Number(await val(admin, `SELECT count(*) FROM temporary_worker_settlement_lines l JOIN temporary_worker_settlements s ON s.id=l.settlement_id WHERE s.status='paid' AND NOT l.active`)) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
await Promise.all([admin.end(), A.end(), B.end(), C.end()]);
process.exit(fail ? 1 : 0);
