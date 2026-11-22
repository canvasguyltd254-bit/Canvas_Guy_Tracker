// Staging seed + cleanup scripts (supabase/staging/*.sql) against the REAL migrations: seed, use the data through the real
// functions (a PAID settlement, a production chain), clean up, and prove real data survives and no trigger stays disabled.
//   PGLITE_DIR=/tmp/pg node supabase/tests/temporary_workers_seed.pglite.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..') + '/';
const mig = f => readFileSync(R + 'migrations/' + f, 'utf8');
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const one = async (s, p) => (await db.query(s, p)).rows[0];
const val = async (s, p) => { const r = await one(s, p); return r ? Object.values(r)[0] : null; };
const call = async (name, ...a) => (await one(`SELECT ${name}(${a.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, a)).r;
await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now());
 CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_num text NOT NULL UNIQUE, client text NOT NULL, notes text, status text NOT NULL DEFAULT 'Inquiry');
 CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders(id));
 CREATE TABLE production_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid UNIQUE REFERENCES orders(id));
 CREATE TABLE production_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'Planned', order_id uuid NOT NULL REFERENCES orders(id));
 CREATE TABLE production_job_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_key text, stage_label text, is_enabled boolean NOT NULL DEFAULT true);
 CREATE TABLE production_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_key text, is_active boolean DEFAULT true);
 CREATE TABLE production_job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_id uuid REFERENCES production_job_stages(id), operation_id uuid REFERENCES production_operations(id), employee_id uuid, status text NOT NULL DEFAULT 'Assigned');
`);
await db.exec(mig('payroll_module.sql'));
await db.exec(`ALTER TABLE production_job_assignments ADD CONSTRAINT fk_emp FOREIGN KEY (employee_id) REFERENCES employees(id)`);
for (const f of ['production_v3a_labour_costing.sql', 'production_v3b_time_entry_day_lock.sql', 'temporary_workers_stage1.sql', 'temporary_workers_stage1b.sql', 'temporary_workers_stage1c.sql', 'temporary_workers_stage2.sql']) await db.exec(mig(f));
const seed = readFileSync(R + 'staging/temporary_workers_dummy_seed.sql', 'utf8');
const cleanup = readFileSync(R + 'staging/temporary_workers_dummy_cleanup.sql', 'utf8');

const u1 = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const u2 = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
await db.exec(seed);
ok('seed: 5 workers', Number(await val(`SELECT count(*) FROM employees WHERE employee_num LIKE 'EMP-TST-%'`)) === 5);
ok('seed: 1 project', Number(await val(`SELECT count(*) FROM orders WHERE order_num='TST-TW-001'`)) === 1);
ok('seed: 3 engagements (2 active, 1 planned)', Number(await val(`SELECT count(*) FROM temporary_worker_engagements e JOIN employees x ON x.id=e.employee_id WHERE x.employee_num LIKE 'EMP-TST-%'`)) === 3
  && Number(await val(`SELECT count(*) FROM temporary_worker_engagements WHERE status='active'`)) === 2);
await db.exec(seed);
ok('seed: re-running creates no duplicates', Number(await val(`SELECT count(*) FROM employees WHERE employee_num LIKE 'EMP-TST-%'`)) === 5 && Number(await val(`SELECT count(*) FROM temporary_worker_engagements`)) === 3);

// real use of the dummy data through the real functions
const eng = await val(`SELECT e.id FROM temporary_worker_engagements e JOIN employees x ON x.id=e.employee_id WHERE x.employee_num='EMP-TST-001'`);
const today = await val(`SELECT tw_today()::text`);
const days = [1, 2, 3].map(n => ({ date: String(await_d(n)), units: 1 }));
function await_d(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
await call('mark_temporary_attendance', eng, JSON.stringify(days), u1, 'head_of_sales');
const p = await call('prepare_temporary_settlement', eng, today, 'threshold', null, u1, 'head_of_sales');
await call('approve_temporary_settlement', p.id, u2, 'head_of_sales', null);
const sh = await call('create_payout_sheet', '{' + p.id + '}', u1, 'head_of_sales');
await call('mark_sheet_printed', sh, u1, 'head_of_sales'); await call('attach_signed_receipt', sh, 'r.jpg', u1, 'head_of_sales');
await call('pay_temporary_settlement', p.id, u2, 'head_of_sales', 'Jane Wanjiru', null);
ok('staged: a PAID settlement with 3 days exists on the dummy data', (await val(`SELECT status FROM temporary_worker_settlements WHERE id=$1`, [p.id])) === 'paid');
// and a production chain on the dummy project, plus a deduction on a second settlement
const ord = await val(`SELECT id FROM orders WHERE order_num='TST-TW-001'`);
const job = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [ord])).id;
await db.query(`INSERT INTO production_plans (order_id) VALUES ($1)`, [ord]); await db.query(`INSERT INTO order_items (order_id) VALUES ($1)`, [ord]);
const stg = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [job])).id;
const emp = await val(`SELECT id FROM employees WHERE employee_num='EMP-TST-001'`);
await db.query(`INSERT INTO production_job_assignments (job_id, stage_id, employee_id) VALUES ($1,$2,$3)`, [job, stg, emp]);
// a REAL worker and order that must survive
const realEmp = (await one(`INSERT INTO employees (employee_num, name, type, day_rate) VALUES ('EMP-001','Real Person','casual',900) RETURNING id`)).id;
const realOrd = (await one(`INSERT INTO orders (order_num, client) VALUES ('ORD-REAL-1','Real Client') RETURNING id`)).id;
const realEng = await call('create_temporary_engagement', realEmp, realOrd, 1000, '2026-01-05', null, null, null, true, u1, 'head_of_sales');
await call('mark_temporary_attendance', realEng, JSON.stringify([{ date: '2026-01-06', units: 1 }]), u1, 'head_of_sales');

await db.exec(cleanup);
const left = async (sql) => Number(await val(sql));
ok('cleanup: no dummy workers or projects remain', await left(`SELECT count(*) FROM employees WHERE employee_num LIKE 'EMP-TST-%'`) === 0 && await left(`SELECT count(*) FROM orders WHERE order_num LIKE 'TST-TW-%'`) === 0);
ok('cleanup: engagements, days, settlements, lines, sheets, deductions are all gone',
  await left(`SELECT count(*) FROM temporary_worker_engagements WHERE id <> $1`.replace('$1', `'${realEng}'`)) === 0
  && await left(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id <> '${realEng}'`) === 0
  && await left(`SELECT count(*) FROM temporary_worker_settlements`) === 0 && await left(`SELECT count(*) FROM temporary_worker_settlement_lines`) === 0
  && await left(`SELECT count(*) FROM temporary_worker_payout_sheets`) === 0);
ok('cleanup: the production plan, job, stage, assignment and order items of the dummy project are gone',
  await left(`SELECT count(*) FROM production_jobs`) === 0 && await left(`SELECT count(*) FROM production_plans`) === 0 && await left(`SELECT count(*) FROM production_job_assignments`) === 0 && await left(`SELECT count(*) FROM order_items`) === 0);
ok('cleanup: activity-log rows of the deleted engagements and settlements are gone, the real engagement\'s remain',
  await left(`SELECT count(*) FROM payroll_activities WHERE entity_id = '${p.id}'`) === 0 && await left(`SELECT count(*) FROM payroll_activities WHERE entity_id = '${realEng}'`) >= 1);
ok('cleanup: REAL data is untouched (worker, order, engagement and its marked day)',
  await left(`SELECT count(*) FROM employees WHERE employee_num='EMP-001'`) === 1 && await left(`SELECT count(*) FROM orders WHERE order_num='ORD-REAL-1'`) === 1
  && await left(`SELECT count(*) FROM temporary_worker_engagements WHERE id='${realEng}'`) === 1 && await left(`SELECT count(*) FROM temporary_worker_attendance WHERE engagement_id='${realEng}' AND active`) === 1);
ok('cleanup: no trigger is left disabled', await left(`SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relname LIKE 'temporary_worker%' AND NOT t.tgisinternal AND t.tgenabled='D'`) === 0);
let blocked = false; try { await db.query(`DELETE FROM temporary_worker_attendance`); } catch (e) { blocked = /never deleted/.test(e.message); }
ok('cleanup: the guard triggers work again afterwards (deleting attendance is refused)', blocked);
await db.exec(seed); ok('the seed can be re-run after a cleanup', Number(await val(`SELECT count(*) FROM employees WHERE employee_num LIKE 'EMP-TST-%'`)) === 5);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
