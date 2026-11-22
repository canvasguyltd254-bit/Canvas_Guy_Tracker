// Database tests for supabase/migrations/temporary_workers_stage1d.sql (assign_engagement_worker).
//   PGLITE_DIR=/tmp/pg node supabase/tests/temporary_workers_assign.pglite.mjs
// Real payroll_module / production_v3a / v3b / temporary_workers_stage1, 1b, 1c, 1d on pglite. Production parent tables are
// stubs with the columns assign_workers_to_stage uses (quantities, mode, planned dates) plus production_assignment_events.

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
const throws = async (name, fn, re) => { try { await fn(); ok(name, false, 'did not throw'); } catch (e) { ok(name, re.test(e.message), e.message); } };
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const val = async (sql, p) => { const r = await one(sql, p); return r ? Object.values(r)[0] : null; };
const call = async (name, ...args) => (await one(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).r;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE production_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'Planned', order_id uuid NOT NULL REFERENCES orders(id), planned_quantity integer NOT NULL DEFAULT 10);
  CREATE TABLE production_job_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_key text, stage_label text, is_enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE production_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_key text, is_active boolean DEFAULT true);
  CREATE TABLE production_job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_id uuid REFERENCES production_job_stages(id), operation_id uuid REFERENCES production_operations(id), employee_id uuid, status text NOT NULL DEFAULT 'Assigned',
    assigned_quantity integer, assigned_by uuid, assignment_mode text, planned_start_date date, planned_end_date date, planned_hours_per_day numeric);
  CREATE TABLE production_assignment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id uuid, job_id uuid, event text, old_values jsonb, new_values jsonb, actor uuid);
`);
await db.exec(mig('payroll_module.sql'));
await db.exec(`ALTER TABLE production_job_assignments ADD CONSTRAINT fk_emp FOREIGN KEY (employee_id) REFERENCES employees(id);`);
for (const f of ['production_v3a_labour_costing.sql', 'production_v3b_time_entry_day_lock.sql', 'temporary_workers_stage1.sql', 'temporary_workers_stage1b.sql', 'temporary_workers_stage1c.sql', 'temporary_workers_stage1d.sql']) await db.exec(mig(f));
ok('stage 1d applies on top of stage 1, 1b, 1c', true);
ok('stage 1d is idempotent', await db.exec(mig('temporary_workers_stage1d.sql')).then(() => true, e => { console.log(e.message); return false; }));

const user = async () => (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const admin = await user(), pm = await user(), hos = await user();
const ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const OTHER_ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const JOB = (await one(`INSERT INTO production_jobs (order_id, planned_quantity) VALUES ($1, 10) RETURNING id`, [ORDER])).id;
const OTHER_JOB = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [OTHER_ORDER])).id;
const STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [JOB])).id;
const OFF_STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label, is_enabled) VALUES ($1,'sand','Sand', false) RETURNING id`, [JOB])).id;
const OTHER_STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [OTHER_JOB])).id;
const OP = (await one(`INSERT INTO production_operations (stage_key) VALUES ('cut') RETURNING id`)).id;
const OP2 = (await one(`INSERT INTO production_operations (stage_key) VALUES ('cut') RETURNING id`)).id;
const OP_SAND = (await one(`INSERT INTO production_operations (stage_key) VALUES ('sand') RETURNING id`)).id;
const OP_RETIRED = (await one(`INSERT INTO production_operations (stage_key, is_active) VALUES ('cut', false) RETURNING id`)).id;

let n = 0;
const worker = async (rate = 1500) => (await one(`INSERT INTO employees (employee_num, name, type, day_rate) VALUES ($1,$2,'casual',$3) RETURNING id`, [`E-${++n}`, `W${n}`, rate])).id;
const engage = async (emp, o = {}) => call('create_temporary_engagement', emp, o.order || ORDER, o.rate ?? 1500, '2026-11-02', null, null, null, o.activate ?? true, hos, 'head_of_sales');
// 2026-11-09 is a Monday, 2026-11-13 a Friday, 2026-11-08 a Sunday.
// `'qty' in o` / `'role' in o` so an explicit null is passed through (not replaced by the default).
const assignW = (eng, o = {}) => call('assign_engagement_worker', eng, o.job || JOB, o.stage || STAGE, o.op || OP, 'qty' in o ? o.qty : 10, o.start || '2026-11-09', o.end || '2026-11-13', 'hours' in o ? o.hours : 8, o.actor || pm, 'role' in o ? o.role : 'production_manager');

// ── happy path: assigns AND links in one call ──
const e1 = await worker(), eng1 = await engage(e1);
const a1 = await assignW(eng1);
const row = await one(`SELECT * FROM production_job_assignments WHERE id=$1`, [a1]);
ok('creates an Assigned assignment for the engagement\'s worker', row && row.employee_id === e1 && row.status === 'Assigned' && row.job_id === JOB && row.stage_id === STAGE && row.operation_id === OP);
ok('stores quantity, mode, planned dates and hours', row.assigned_quantity === 10 && row.assignment_mode === 'working_together' && (await val(`SELECT to_char(planned_start_date,'YYYY-MM-DD')||'/'||to_char(planned_end_date,'YYYY-MM-DD') FROM production_job_assignments WHERE id=$1`, [a1])) === '2026-11-09/2026-11-13' && Number(row.planned_hours_per_day) === 8);
ok('is linked to the engagement in the same call', row.temporary_engagement_id === eng1);
ok('takes the engagement\'s agreed rate as its rate snapshot', Number(row.daily_rate_snapshot) === 1500);
ok('writes a created event with the temporary-engagement source', (await val(`SELECT new_values->>'source' FROM production_assignment_events WHERE assignment_id=$1 AND event='created'`, [a1])) === 'temporary_engagement');
ok('logs the activity', Number(await val(`SELECT count(*) FROM payroll_activities WHERE entity_id=$1 AND activity_type='assignment_created'`, [eng1])) === 1);

// ── the agreed rate, not the employee day rate, is the snapshot ──
const e2 = await worker(900), eng2 = await engage(e2, { rate: 2200 });
const a2 = await assignW(eng2, { op: OP2 });
ok('rate snapshot follows the engagement (2200), not the employee day rate (900)', Number(await val(`SELECT daily_rate_snapshot FROM production_job_assignments WHERE id=$1`, [a2])) === 2200);

// ── does NOT disturb other workers on the same job/stage/operation (the reason this function exists) ──
const e3 = await worker(), eng3 = await engage(e3);
const before = await val(`SELECT count(*) FROM production_job_assignments WHERE job_id=$1 AND stage_id=$2 AND operation_id=$3 AND status IN ('Assigned','In Progress')`, [JOB, STAGE, OP]);
const a3 = await assignW(eng3);   // same operation as worker 1, same quantity (working together)
const after = await val(`SELECT count(*) FROM production_job_assignments WHERE job_id=$1 AND stage_id=$2 AND operation_id=$3 AND status IN ('Assigned','In Progress')`, [JOB, STAGE, OP]);
ok('adding a second worker keeps the first one assigned', Number(before) === 1 && Number(after) === 2);
ok('the first worker\'s assignment is untouched (still Assigned, still linked)', (await val(`SELECT status FROM production_job_assignments WHERE id=$1`, [a1])) === 'Assigned' && (await val(`SELECT temporary_engagement_id FROM production_job_assignments WHERE id=$1`, [a1])) === eng1);
ok('no worker was marked Removed', Number(await val(`SELECT count(*) FROM production_job_assignments WHERE status='Removed'`)) === 0);

// ── group rules ──
const e4 = await worker(), eng4 = await engage(e4);
await throws('working-together group: a different quantity is refused (the others are on 10)', () => assignW(eng4, { qty: 5 }), /work together.*must match the others \(10\)/);
ok('a refused call leaves no assignment behind', Number(await val(`SELECT count(*) FROM production_job_assignments WHERE employee_id=$1`, [e4])) === 0);
await db.query(`UPDATE production_job_assignments SET assignment_mode='split_quantity', assigned_quantity=6 WHERE operation_id=$1 AND stage_id=$2`, [OP2, STAGE]);   // e2 alone on OP2, split mode, qty 6
const e5 = await worker(), eng5 = await engage(e5);
await throws('split group: quantities that exceed the job quantity are refused', () => assignW(eng5, { op: OP2, qty: 5 }), /add up to 11 — more than the 10/);
const a5 = await assignW(eng5, { op: OP2, qty: 4 });
ok('split group: fitting quantity is accepted and inherits split_quantity mode', (await val(`SELECT assignment_mode FROM production_job_assignments WHERE id=$1`, [a5])) === 'split_quantity');

// ── validation ──
const e6 = await worker(), eng6 = await engage(e6);
await throws('hos cannot assign (same rule as linking)', () => assignW(eng6, { role: 'head_of_sales', actor: hos }), /Not allowed/);
await throws('unknown role refused', () => assignW(eng6, { role: 'viewer' }), /Not allowed/);
await throws('null role refused', () => assignW(eng6, { role: null }), /Not allowed/);
const engPlanned = await engage(await worker(), { activate: false });
await throws('planned engagement refused', () => assignW(engPlanned), /must be active/);
await throws('unknown engagement refused', () => assignW('00000000-0000-0000-0000-000000000000'), /Engagement not found/);
await throws('job from another project refused', () => assignW(eng6, { job: OTHER_JOB, stage: OTHER_STAGE }), /different project/);
await throws('stage from another job refused', () => assignW(eng6, { stage: OTHER_STAGE }), /Stage does not belong/);
await throws('disabled stage refused', () => assignW(eng6, { stage: OFF_STAGE, op: OP_SAND }), /disabled/);
await throws('operation of another stage refused', () => assignW(eng6, { op: OP_SAND }), /not available for the Cut stage/);
await throws('retired operation refused', () => assignW(eng6, { op: OP_RETIRED }), /not available/);
await throws('zero quantity refused', () => assignW(eng6, { qty: 0 }), /quantity above 0/);
await throws('null quantity refused', () => assignW(eng6, { qty: null }), /quantity above 0/);
await throws('quantity above the job quantity refused', () => assignW(eng6, { qty: 11 }), /cannot exceed the job quantity \(10\)/);
await throws('end before start refused', () => assignW(eng6, { start: '2026-11-13', end: '2026-11-09' }), /end cannot be before/);
await throws('Sunday start refused', () => assignW(eng6, { start: '2026-11-08' }), /Sunday/);
await throws('Sunday end refused', () => assignW(eng6, { end: '2026-11-15' }), /Sunday/);
await throws('hours 0 refused', () => assignW(eng6, { hours: 0 }), /Hours per day/);
await throws('hours above 12 refused', () => assignW(eng6, { hours: 13 }), /Hours per day/);
await throws('same worker twice on the same operation refused', () => assignW(eng1), /already assigned to that operation/);
await throws('cancelled job refused', async () => { await db.query(`UPDATE production_jobs SET status='Cancelled' WHERE id=$1`, [JOB]); try { await assignW(eng6, { op: OP2 }); } finally { await db.query(`UPDATE production_jobs SET status='Planned' WHERE id=$1`, [JOB]); } }, /Cannot assign workers on a cancelled job/);
await db.query(`UPDATE employees SET is_active=false WHERE id=$1`, [e6]);
await throws('inactive worker refused', () => assignW(eng6), /inactive/);
ok('none of the refused calls left an assignment for worker 6', Number(await val(`SELECT count(*) FROM production_job_assignments WHERE employee_id=$1`, [e6])) === 0);

// ── attendance works end to end on the new assignment ──
const e7 = await worker(), eng7 = await engage(e7);
const a7 = await assignW(eng7, { op: OP, qty: 10 });
const te = await call('record_time_entry', a7, '2026-11-10', 1, false, null, null, true, pm, '2026-12-31');
await call('transition_time_entry', te.id, 'approve', admin, 'production_manager', null);
const due = await call('temporary_engagement_due', eng7, null);
ok('attendance on the new assignment is counted as due (1 day, KES 1,500)', Number(due.eligible_units) === 1 && Number(due.eligible_gross) === 1500, JSON.stringify(due));
await throws('cannot re-assign once time is recorded (duplicate refused, link refused)', () => assignW(eng7, { op: OP }), /already assigned/);

// ── grants ──
ok('only service_role can execute it', (await val(`SELECT has_function_privilege('anon','assign_engagement_worker(uuid,uuid,uuid,uuid,integer,date,date,numeric,uuid,text)','EXECUTE')`)) === false
  && (await val(`SELECT has_function_privilege('authenticated','assign_engagement_worker(uuid,uuid,uuid,uuid,integer,date,date,numeric,uuid,text)','EXECUTE')`)) === false
  && (await val(`SELECT has_function_privilege('service_role','assign_engagement_worker(uuid,uuid,uuid,uuid,integer,date,date,numeric,uuid,text)','EXECUTE')`)) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
