// Database tests for supabase/migrations/orders_credit_by_payment_terms.sql
//
// Loads the REAL quotes_crm_migration_d.sql (old advance_order_status) to reproduce the bug,
// then the fix migration. The two GL posting functions are stubbed: they only record that
// they were called (their accounting is covered elsewhere).
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/orders_credit_by_payment_terms.pglite.mjs
//
// NOT covered: concurrent connections, the real GL journals, the browser-side credit limit check.

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
  CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_num text, invoice_number text,
    status text NOT NULL DEFAULT 'Inquiry',
    client text, total_value numeric(14,2),
    customer_type text, payment_terms text,
    invoice_journal_entry_id uuid,
    credit_approval_ref text, refund_reference text,
    updated_at timestamptz
  );
  CREATE TABLE client_profiles (client_name text PRIMARY KEY, current_exposure numeric(14,2));
  CREATE TABLE gl_calls (id serial PRIMARY KEY, order_id uuid, kind text);

  CREATE FUNCTION post_deposit_paid_journals(p_order_id uuid, p_by uuid) RETURNS jsonb
  LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO gl_calls(order_id, kind) VALUES (p_order_id, 'deposit');
    UPDATE orders SET invoice_journal_entry_id = gen_random_uuid() WHERE id = p_order_id;
    RETURN '{}'::jsonb; END $$;
  CREATE FUNCTION post_credit_order_invoice(p_order_id uuid, p_by uuid) RETURNS jsonb
  LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO gl_calls(order_id, kind) VALUES (p_order_id, 'credit');
    UPDATE orders SET invoice_journal_entry_id = gen_random_uuid() WHERE id = p_order_id;
    RETURN '{}'::jsonb; END $$;
`);

const mk = async (customer_type, payment_terms, status = 'Quote Approved', invoiced = false, client = 'Acme') => (await one(
  `INSERT INTO orders (order_num, status, client, total_value, customer_type, payment_terms, invoice_journal_entry_id)
   VALUES ('ORD-' || nextval(pg_get_serial_sequence('gl_calls','id')), $1, $2, 100000, $3, $4, CASE WHEN $5 THEN gen_random_uuid() END)
   RETURNING id`, [status, client, customer_type, payment_terms, invoiced])).id;
const adv = (id, to, extra = {}) =>
  db.query(`SELECT advance_order_status($1, $2, gen_random_uuid(), $3::jsonb) r`, [id, to, JSON.stringify(extra)]);
const st = async id => (await one(`SELECT status FROM orders WHERE id=$1`, [id])).status;
const calls = async id => (await db.query(`SELECT kind FROM gl_calls WHERE order_id=$1 ORDER BY id`, [id])).rows.map(r => r.kind);

// ── 0. The bug, on the OLD function ─────────────────────────────────────────
await db.exec(mig('quotes_crm_migration_d.sql'));
{
  const id = await mk('retail', '30_day');
  await adv(id, 'Deposit Paid');
  ok('BEFORE fix: retail + 30_day is treated as a cash order (deposit invoice posted at Deposit Paid)',
    (await calls(id)).join() === 'deposit');
}

// ── Apply the fix ───────────────────────────────────────────────────────────
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration applies', true);
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration is re-runnable', true);

// ── 1. Credit by payment terms, any customer type ───────────────────────────
for (const [ct, terms] of [['retail', '30_day'], ['retail', '60_day'], ['retail', 'custom'],
                           ['commercial', '30_day'], ['commercial', 'custom'], ['reseller', '60_day'], [null, '30_day']]) {
  const id = await mk(ct, terms);
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-1' });
  ok(`${ct} + ${terms}: Quote Approved → Material Check (skips Deposit Paid)`, (await st(id)) === 'Material Check');
  const o = await one(`SELECT credit_approval_ref r FROM orders WHERE id=$1`, [id]);
  ok(`${ct} + ${terms}: approval reference saved`, o.r === 'APR-1');
}

// ── 2. Guards ───────────────────────────────────────────────────────────────
for (const ref of [undefined, null, '', '   ']) {
  const id = await mk('retail', '30_day');
  await throws(`credit skip without approval ref (${JSON.stringify(ref)}) is refused`,
    () => adv(id, 'Material Check', ref === undefined ? {} : { credit_approval_ref: ref }), /CREDIT_APPROVAL_REQUIRED/);
  ok('  …and the status did not change', (await st(id)) === 'Quote Approved');
}
for (const [ct, terms] of [['retail', 'cash_before'], ['retail', '50_deposit'], ['commercial', 'cash_before'],
                           ['reseller', '50_deposit'], ['retail', null]]) {
  const id = await mk(ct, terms);
  await throws(`${ct} + ${terms}: cannot skip Deposit Paid (even with an approval ref)`,
    () => adv(id, 'Material Check', { credit_approval_ref: 'APR-1' }), /DEPOSIT_REQUIRED/);
  ok('  …and the status did not change', (await st(id)) === 'Quote Approved');
  ok('  …and no exposure/GL side effects', (await calls(id)).length === 0);
}

// ── 3. Normal paths unaffected ──────────────────────────────────────────────
{
  const id = await mk('retail', '50_deposit');
  await adv(id, 'Deposit Paid');
  ok('cash order: Quote Approved → Deposit Paid posts the deposit invoice', (await calls(id)).join() === 'deposit');
  await adv(id, 'Material Check');
  ok('cash order: Deposit Paid → Material Check has no guard', (await st(id)) === 'Material Check');
}
{
  const id = await mk('retail', '60_day', 'Inquiry');
  await adv(id, 'Quote Approved');
  ok('credit order: invoice posted at Quote Approved (not at Deposit Paid)', (await calls(id)).join() === 'credit');
}

// ── 4. GL posting when leaving Quote Approved ───────────────────────────────
{
  const id = await mk('retail', '30_day', 'Quote Approved', false);     // terms switched to credit after approval
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-2' });
  ok('invoice never posted → credit invoice is posted exactly once on leaving Quote Approved', (await calls(id)).join() === 'credit');
}
{
  const id = await mk('retail', '30_day', 'Quote Approved', true);      // invoice already posted at Quote Approved
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-3' });
  ok('invoice already posted → not posted again', (await calls(id)).length === 0);
}

// ── 5. Credit exposure ──────────────────────────────────────────────────────
{
  await db.query(`INSERT INTO client_profiles VALUES ('Exposed Ltd', 50000)`);
  const id = await mk('retail', '30_day', 'Quote Approved', false, 'Exposed Ltd');
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-4' });
  const e = (await one(`SELECT current_exposure e FROM client_profiles WHERE client_name='Exposed Ltd'`)).e;
  ok('exposure increases by the order total on credit approval (50,000 + 100,000)', Number(e) === 150000, String(e));
}

// ── 6. Unchanged behaviour ──────────────────────────────────────────────────
{
  const id = await mk('retail', 'cash_before', 'Deposit Paid');
  await throws('same status still refused', () => adv(id, 'Deposit Paid'), /SAME_STATUS/);
  await throws('unknown order still refused', () => adv('00000000-0000-0000-0000-000000000000', 'Material Check'), /ORDER_NOT_FOUND/);
}
{
  const r = await one(`SELECT has_function_privilege('anon','advance_order_status(uuid,text,uuid,jsonb)','EXECUTE') a,
                              has_function_privilege('authenticated','advance_order_status(uuid,text,uuid,jsonb)','EXECUTE') u,
                              has_function_privilege('service_role','advance_order_status(uuid,text,uuid,jsonb)','EXECUTE') s`);
  ok('only service_role can execute advance_order_status', !r.a && !r.u && r.s, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
