// Database tests for supabase/migrations/employee_change_requests.sql
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/employee_change_requests.pglite.mjs
//
// NOT covered: the API's role decisions (route harness); concurrent approvals (row lock is FOR UPDATE).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');
const here = dirname(fileURLToPath(import.meta.url));
const mig = readFileSync(join(here, '../migrations/employee_change_requests.sql'), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const throws = async (name, fn, re) => { try { await fn(); ok(name, false, 'did not throw'); } catch (e) { ok(name, re.test(e.message), e.message); } };
const one = async (sql, p) => (await db.query(sql, p)).rows[0];

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE employees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), employee_num text UNIQUE NOT NULL, name text NOT NULL,
    type text NOT NULL CHECK (type IN ('casual','permanent','skilled_casual')),
    day_rate numeric(10,2), monthly_salary numeric(10,2), piece_rate numeric(10,2),
    sha_amount numeric(10,2) NOT NULL DEFAULT 0, nssf_number text, id_number text,
    phone text, bank_account text, bank_name text, bank_branch text, paybill_number text,
    hire_date date, is_active boolean NOT NULL DEFAULT true, notes text, created_at timestamptz DEFAULT now(), created_by uuid);
  CREATE TABLE payroll_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
    activity_type text NOT NULL, description text NOT NULL, old_value text, new_value text,
    created_at timestamptz DEFAULT now(), created_by uuid);
  GRANT ALL ON employees, payroll_activities TO anon, authenticated, service_role;
  CREATE TABLE payroll_entries (employee_id uuid REFERENCES employees(id));
  CREATE SEQUENCE employee_num_seq;
  CREATE FUNCTION next_employee_num() RETURNS text LANGUAGE sql AS
    $$ SELECT 'TEST-' || nextval('employee_num_seq') $$;
`);

await db.exec(mig); ok('migration applies', true);
await db.exec(mig); ok('migration is re-runnable', true);

const U = '11111111-1111-1111-1111-111111111111', A = '22222222-2222-2222-2222-222222222222';
const emp = async (n = 1) => (await one(`INSERT INTO employees (employee_num, name, type, day_rate, phone, bank_account, sha_amount)
  VALUES ('EMP-' || floor(random()*1e9)::text, 'Jane', 'casual', 1000, '0712345678', '999', 300) RETURNING *`));
const request = async (e, changes, reason = 'rate review') =>
  (await one(`INSERT INTO employee_change_requests (employee_id, changes, reason, requested_by, requested_by_name, requested_by_role)
              VALUES ($1, $2::jsonb, $3, $4, 'Hannah (HoS)', 'head_of_sales') RETURNING id`, [e.id, JSON.stringify(changes), reason, U])).id;
const approve = id => db.query(`SELECT approve_employee_change($1, $2, 'Admin', 'ok') r`, [id, A]);
const row = id => one(`SELECT * FROM employees WHERE id=$1`, [id]);

// ── browser roles locked out ────────────────────────────────────────────────
{
  const r = await one(`SELECT relrowsecurity rls FROM pg_class WHERE relname='employees'`);
  ok('employees has row level security on', r.rls === true);
  const p = await one(`SELECT has_table_privilege('authenticated','employees','SELECT') s, has_table_privilege('authenticated','employees','UPDATE') u,
                              has_table_privilege('anon','employees','SELECT') a, has_table_privilege('service_role','employees','SELECT') sr`);
  ok('browser roles have no access to employees; service_role does', !p.s && !p.u && !p.a && p.sr, JSON.stringify(p));
  const q = await one(`SELECT has_table_privilege('authenticated','employee_change_requests','SELECT') s, has_table_privilege('authenticated','employee_change_requests','INSERT') i,
                              has_table_privilege('service_role','employee_change_requests','DELETE') d, has_table_privilege('service_role','employee_change_requests','UPDATE') u`);
  ok('requests table: browsers locked out; service_role cannot directly decide or delete', !q.s && !q.i && !q.d && !q.u, JSON.stringify(q));
  const f = await one(`SELECT has_function_privilege('authenticated','approve_employee_change(uuid,uuid,text,text)','EXECUTE') a,
                              has_function_privilege('service_role','approve_employee_change(uuid,uuid,text,text)','EXECUTE') s`);
  ok('only service_role can approve', !f.a && f.s, JSON.stringify(f));
}

// ── approve applies the change and logs old → new ───────────────────────────
{
  const e = await emp();
  const id = await request(e, { day_rate: { old: 1000, new: 1200 }, phone: { old: '0712345678', new: '0799000111' } });
  const before = await row(e.id);
  ok('a pending request changes nothing', Number(before.day_rate) === 1000 && before.phone === '0712345678');
  await approve(id);
  const after = await row(e.id);
  ok('approving applies every requested field', Number(after.day_rate) === 1200 && after.phone === '0799000111' && after.bank_account === '999', JSON.stringify(after));
  const r = await one(`SELECT status, decided_by, decided_at IS NOT NULL d FROM employee_change_requests WHERE id=$1`, [id]);
  ok('request marked approved with the decider', r.status === 'approved' && r.decided_by === A && r.d);
  const a = await one(`SELECT * FROM payroll_activities WHERE entity_id=$1 AND activity_type='change_approved'`, [e.id]);
  ok('the approval is logged with old and new values', a && /day_rate/.test(a.description) && /1000/.test(a.old_value) && /1200/.test(a.new_value) && /Hannah/.test(a.description), JSON.stringify(a));
  await throws('a request cannot be approved twice', () => approve(id), /NOT_PENDING/);
}

// ── numeric old values compare numerically (1000 vs 1000.00) and null → value works ──
{
  const e = await emp();
  const id = await request(e, { piece_rate: { old: null, new: 50 }, sha_amount: { old: 300, new: 400 }, nssf_number: { old: null, new: 'N-77' } });
  await approve(id);
  const a = await row(e.id);
  ok('null → value, 300 vs 300.00 and text fields apply', Number(a.piece_rate) === 50 && Number(a.sha_amount) === 400 && a.nssf_number === 'N-77', JSON.stringify(a));
}

// ── stale requests are refused, nothing applied ─────────────────────────────
{
  const e = await emp();
  const id = await request(e, { day_rate: { old: 1000, new: 1500 }, phone: { old: '0712345678', new: '0700' } });
  await db.query(`UPDATE employees SET phone='0788888888' WHERE id=$1`, [e.id]);   // someone changed the phone since
  ok('stale outcome when a field changed since the request was made', (await approve(id)).rows[0].r.status === 'stale');
  const a = await row(e.id);
  ok('…and NOTHING from the request was applied (not even the rate)', Number(a.day_rate) === 1000 && a.phone === '0788888888');
  ok('…the stale decision is persisted', (await one(`SELECT status FROM employee_change_requests WHERE id=$1`, [id])).status === 'stale');
}

const submit = (name, pay = 1000) => one(
  `SELECT submit_employee_onboarding($1, $2, 'Manager', 'production_manager') e`,
  [JSON.stringify({ name, type: 'casual', day_rate: pay, sha_amount: 0 }), U]);
{
  const { e } = await submit('Pending worker');
  const req = await one(`SELECT id, kind FROM employee_change_requests WHERE employee_id=$1`, [e.id]);
  ok('creation is inactive and has an onboarding request', !e.is_active && e.onboarding_status === 'pending' && req.kind === 'onboarding');
  ok('creation has an audit entry', !!await one(`SELECT id FROM payroll_activities WHERE entity_id=$1 AND activity_type='created'`, [e.id]));
  await throws('pending worker cannot be activated directly', () => db.query(`UPDATE employees SET is_active=true WHERE id=$1`, [e.id]), /employees_onboarding_valid/);
  await throws('pending worker cannot enter payroll', () => db.query(`INSERT INTO payroll_entries VALUES ($1)`, [e.id]), /EMPLOYEE_ONBOARDING_REQUIRED/);
  await throws('an onboarding record cannot be deleted by deleting the employee', () => db.query(`DELETE FROM employees WHERE id=$1`, [e.id]), /foreign key/);
  await approve(req.id);
  await db.query(`INSERT INTO payroll_entries VALUES ($1)`, [e.id]);
  ok('approval activates the worker and allows payroll', (await row(e.id)).is_active && (await row(e.id)).onboarding_status === 'approved');
  const { e: rejected } = await submit('Rejected worker');
  const rr = await one(`SELECT id FROM employee_change_requests WHERE employee_id=$1`, [rejected.id]);
  await db.query(`SELECT reject_employee_change($1,$2,'Admin','not verified')`, [rr.id, A]);
  await throws('rejected worker still cannot enter payroll', () => db.query(`UPDATE payroll_entries SET employee_id=$1 WHERE employee_id=$2`, [rejected.id, e.id]), /EMPLOYEE_ONBOARDING_REQUIRED/);
  await throws('negative pay rejected on submission', () => submit('Bad rate', -1), /employees_pay_values_valid/);
  const neg = await request(e, { day_rate: { old: 1000, new: -10 } });
  await throws('negative pay rejected on approval', () => approve(neg), /employees_pay_values_valid/);
  await db.exec(`ALTER TABLE payroll_activities ADD CHECK (activity_type <> 'created') NOT VALID`);
  await throws('failed audit aborts onboarding', () => submit('Audit failure'), /check constraint/);
  ok('failed audit leaves no employee', !await one(`SELECT id FROM employees WHERE name='Audit failure'`));
}

// ── field whitelist ─────────────────────────────────────────────────────────
{
  const e = await emp();
  for (const f of ['is_active', 'created_by', 'id', 'employee_num']) {
    const id = await request(e, { [f]: { old: null, new: 'x' } });
    await throws(`field ${f} cannot be changed through a request`, () => approve(id), /INVALID_FIELD/);
  }
}
// bad value rolls back (type CHECK)
{
  const e = await emp();
  const id = await request(e, { name: { old: 'Jane', new: 'Janet' }, type: { old: 'casual', new: 'bogus' } });
  await throws('an invalid value fails the whole approval', () => approve(id), /check|violates/i);
  ok('…and the name was not changed either', (await row(e.id)).name === 'Jane');
}

// ── reject ──────────────────────────────────────────────────────────────────
{
  const e = await emp();
  const id = await request(e, { phone: { old: '0712345678', new: '0799' } });
  await db.query(`SELECT reject_employee_change($1,$2,'Admin','not verified')`, [id, A]);
  ok('rejecting leaves the employee unchanged', (await row(e.id)).phone === '0712345678');
  const r = await one(`SELECT status, decision_note FROM employee_change_requests WHERE id=$1`, [id]);
  ok('request marked rejected with the note', r.status === 'rejected' && r.decision_note === 'not verified');
  ok('the rejection is logged', !!(await one(`SELECT 1 x FROM payroll_activities WHERE entity_id=$1 AND activity_type='change_rejected'`, [e.id])));
  await throws('a rejected request cannot then be approved', () => approve(id), /NOT_PENDING/);
}

// ── constraints ─────────────────────────────────────────────────────────────
{
  const e = await emp();
  await throws('empty change set refused', () => request(e, {}), /check/i);
  await throws('reason is required', () => request(e, { phone: { old: 'a', new: 'b' } }, ' '), /check/i);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
