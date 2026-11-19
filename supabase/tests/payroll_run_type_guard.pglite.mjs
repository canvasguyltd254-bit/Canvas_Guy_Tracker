// Database tests for supabase/migrations/payroll_run_type_guard.sql
//
// Runs the REAL payroll_module.sql, payroll_sha_claims.sql, approve_payroll_run_rpc.sql
// and the guard migration against an in-process Postgres (pglite), with a stub of Supabase's
// auth.users and roles.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/payroll_run_type_guard.pglite.mjs
//
// NOT covered: concurrent connections.

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
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
`);
await db.exec(mig('payroll_module.sql'));
await db.exec(`ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS reopen_reason text;`);
await db.exec(mig('payroll_sha_claims.sql'));
await db.exec(mig('approve_payroll_run_rpc.sql'));

// ── Seed a legacy violation BEFORE the guard exists (must not block the migration) ──
const mkEmp = async (n, type) => (await one(
  `INSERT INTO employees (employee_num, name, type, day_rate, monthly_salary) VALUES ($1,$2,$3,1000,30000) RETURNING id`,
  [`EMP-${n}`, `Emp ${n}`, type])).id;
const mkRun = async (num, type, start = '2026-10-05') => (await one(
  `INSERT INTO payroll_runs (run_num, period_type, period_start, period_end, run_type)
   VALUES ($1,'weekly',$2::date,($2::date + 6),$3) RETURNING id`, [num, start, type])).id;
const addEntry = (run, emp, name, type) => db.query(
  `INSERT INTO payroll_entries (run_id, employee_id, snapshot_name, snapshot_type, snapshot_sha, gross_pay, net_pay)
   VALUES ($1,$2,$3,$4,0,1000,1000)`, [run, emp, name, type]);

const eCas = await mkEmp(1, 'casual');
const ePerm = await mkEmp(2, 'permanent');
const eSk = await mkEmp(3, 'skilled_casual');
const legacyRun = await mkRun('PR-LEGACY', 'casual');
await addEntry(legacyRun, ePerm, 'Emp 2', 'permanent');       // legacy mismatch

await db.exec(mig('payroll_run_type_guard.sql'));
ok('migration applies on top of data containing a legacy mismatch', true);
ok('migration is idempotent (second run)', await db.exec(mig('payroll_run_type_guard.sql')).then(() => true, () => false));

// ── The rule function ──
const allows = async (r, t) => (await one(`SELECT payroll_run_type_allows($1,$2) AS v`, [r, t])).v;
ok('rule: casual in casual', await allows('casual', 'casual'));
ok('rule: permanent NOT in casual', !(await allows('casual', 'permanent')));
ok('rule: all three standard types in combined',
  (await allows('combined', 'casual')) && (await allows('combined', 'permanent')) && (await allows('combined', 'skilled_casual')));
ok('rule: unknown type NOT in combined', !(await allows('combined', 'temporary')));
ok('rule: null type NOT allowed', !(await allows('combined', null)));
ok('rule: unknown run type allows nothing', !(await allows('weekly', 'casual')));

// ── Insert-time guard ──
const casualRun = await mkRun('PR-CAS', 'casual', '2026-10-12');
const permRun   = await mkRun('PR-PERM', 'permanent', '2026-10-12');
const skRun     = await mkRun('PR-SK', 'skilled_casual', '2026-10-12');
const combRun   = await mkRun('PR-COMB', 'combined', '2026-10-12');

await throws('casual worker cannot enter permanent run', () => addEntry(permRun, eCas, 'Emp 1', 'casual'), /RUN_TYPE_MISMATCH/);
await throws('permanent worker cannot enter casual run', () => addEntry(casualRun, ePerm, 'Emp 2', 'permanent'), /RUN_TYPE_MISMATCH/);
await throws('skilled casual cannot enter casual run', () => addEntry(casualRun, eSk, 'Emp 3', 'skilled_casual'), /RUN_TYPE_MISMATCH/);
await throws('unknown/future type cannot enter combined run', () => addEntry(combRun, eCas, 'Emp 1', 'temporary'), /RUN_TYPE_MISMATCH/);
await throws('untyped snapshot cannot enter combined run', () => addEntry(combRun, eCas, 'Emp 1', ''), /RUN_TYPE_MISMATCH/);

await addEntry(casualRun, eCas, 'Emp 1', 'casual');
await addEntry(permRun, ePerm, 'Emp 2', 'permanent');
await addEntry(skRun, eSk, 'Emp 3', 'skilled_casual');
ok('matching types enter their own runs', true);
await addEntry(combRun, eCas, 'Emp 1', 'casual');
await addEntry(combRun, ePerm, 'Emp 2', 'permanent');
await addEntry(combRun, eSk, 'Emp 3', 'skilled_casual');
ok('all three standard types can enter a combined run',
  (await one(`SELECT count(*)::int AS n FROM payroll_entries WHERE run_id=$1`, [combRun])).n === 3);

// ── run_type switching ──
await throws('cannot switch a run to a type that would strand entries',
  () => db.query(`UPDATE payroll_runs SET run_type='casual' WHERE id=$1`, [combRun]), /RUN_TYPE_MISMATCH/);
const emptyRun = await mkRun('PR-EMPTY', 'casual', '2026-10-19');
await db.query(`UPDATE payroll_runs SET run_type='permanent' WHERE id=$1`, [emptyRun]);
ok('an empty run can change type', (await one(`SELECT run_type FROM payroll_runs WHERE id=$1`, [emptyRun])).run_type === 'permanent');
await db.query(`UPDATE payroll_runs SET run_type='combined' WHERE id=$1`, [casualRun]);
ok('widening a run to combined is allowed', (await one(`SELECT run_type FROM payroll_runs WHERE id=$1`, [casualRun])).run_type === 'combined');

// ── Approval ──
const approver = (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const approve = id => db.query(`SELECT approve_payroll_run($1, $2, 'tester') AS r`, [id, approver]);
await throws('invalid entry already in a run blocks approval', () => approve(legacyRun), /RUN_TYPE_MISMATCH/);
ok('blocked run stays draft', (await one(`SELECT status FROM payroll_runs WHERE id=$1`, [legacyRun])).status === 'draft');

// A combined run holding a non-standard type (inserted by bypassing the trigger) must also block.
await db.exec(`ALTER TABLE payroll_entries DISABLE TRIGGER trg_payroll_entries_run_type_guard;`);
const combBad = await mkRun('PR-COMB-BAD', 'combined', '2026-10-26');
await addEntry(combBad, eCas, 'Emp 1', 'temporary');
await db.exec(`ALTER TABLE payroll_entries ENABLE TRIGGER trg_payroll_entries_run_type_guard;`);
await throws('combined run with a non-standard type blocks approval', () => approve(combBad), /RUN_TYPE_MISMATCH/);

// Normal flows unchanged
for (const [label, id] of [['casual→combined', casualRun], ['permanent', permRun], ['skilled_casual', skRun], ['combined (3 types)', combRun]]) {
  const r = (await approve(id)).rows[0].r;
  ok(`normal approval still works: ${label}`, r.employee_count >= 1 && (await one(`SELECT status FROM payroll_runs WHERE id=$1`, [id])).status === 'approved', JSON.stringify(r));
}
ok('combined approval counted all three employees',
  (await one(`SELECT employee_count FROM payroll_runs WHERE id=$1`, [combRun])).employee_count === 3);
await throws('approving twice is still refused', () => approve(permRun), /Only draft runs/);
await throws('approving an empty run is still refused', () => approve(emptyRun), /no entries/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
