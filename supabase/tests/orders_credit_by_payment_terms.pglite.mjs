// Database tests for supabase/migrations/orders_credit_by_payment_terms.sql
//
// Loads the REAL quotes_crm_migration_d.sql (old advance_order_status) to reproduce the bug,
// then the fix migration. The two GL posting functions are stubbed: they only record that
// they were called (their accounting is covered elsewhere).
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/orders_credit_by_payment_terms.pglite.mjs
//
// NOT covered: concurrent connections, the real GL journals, who may approve credit (a ROLE rule,
// tested in orders_status_route.harness.mjs), PostgREST's own role switching (simulated with SET ROLE).

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
    order_num text, invoice_number text, quote_number text, notes text,
    order_type text NOT NULL DEFAULT 'standard',
    status text NOT NULL DEFAULT 'Inquiry',
    client text, total_value numeric(14,2),
    customer_type text, payment_terms text,
    invoice_journal_entry_id uuid,
    credit_approval_ref text, refund_reference text,
    updated_at timestamptz
  );
  CREATE TABLE order_payments (id serial PRIMARY KEY, order_id uuid, amount numeric, reversed_at timestamptz);
  CREATE TABLE client_profiles (client_name text PRIMARY KEY, credit_limit numeric(14,2) DEFAULT 0, current_exposure numeric(14,2) DEFAULT 0);
  CREATE TABLE gl_calls (id serial PRIMARY KEY, order_id uuid, kind text);
  GRANT SELECT, UPDATE ON orders TO anon, authenticated, service_role;

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

const mk = async (customer_type, payment_terms, status = 'Quote Approved', opts = {}) => {
  const { invoiced = false, client = 'Acme', total = 100000, order_type = 'standard', approvalRef = null } = opts;
  return (await one(
    `INSERT INTO orders (order_num, status, client, total_value, customer_type, payment_terms, invoice_journal_entry_id, order_type, credit_approval_ref)
     VALUES ('ORD-' || nextval(pg_get_serial_sequence('gl_calls','id')), $1, $2, $3, $4, $5, CASE WHEN $6 THEN gen_random_uuid() END, $7, $8)
     RETURNING id`, [status, client, total, customer_type, payment_terms, invoiced, order_type, approvalRef])).id;
};
const pay = (id, reversed = false) =>
  db.query(`INSERT INTO order_payments (order_id, amount, reversed_at) VALUES ($1, 50000, CASE WHEN $2 THEN now() END)`, [id, reversed]);
const adv = (id, to, extra = {}) =>
  db.query(`SELECT advance_order_status($1, $2, gen_random_uuid(), $3::jsonb) r`, [id, to, JSON.stringify(extra)]);
const st = async id => (await one(`SELECT status FROM orders WHERE id=$1`, [id])).status;
const calls = async id => (await db.query(`SELECT kind FROM gl_calls WHERE order_id=$1 ORDER BY id`, [id])).rows.map(r => r.kind);
const counted = async id => Number((await one(`SELECT credit_exposure_counted c FROM orders WHERE id=$1`, [id])).c);
const exposure = async name => Number((await one(`SELECT current_exposure e FROM client_profiles WHERE client_name=$1`, [name])).e);
const profile = (name, limit, exp) => db.query(`INSERT INTO client_profiles VALUES ($1,$2,$3) ON CONFLICT (client_name) DO UPDATE SET credit_limit=$2, current_exposure=$3`, [name, limit, exp]);
// Simulates the API route's send-back: a direct status update as the service role, then the release call.
const sendBack = async (id, to, release = true) => {
  await db.exec(`SET ROLE service_role`);
  try {
    await db.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, to]);
    if (release) await db.query(`SELECT release_order_credit_exposure($1)`, [id]);
  } finally { await db.exec(`RESET ROLE`); }
};

// ── 0. Old function: the bug, and the pre-migration data that must be backfilled ──
await db.exec(mig('quotes_crm_migration_d.sql'));
{
  const id = await mk('retail', '30_day');
  await adv(id, 'Deposit Paid');
  ok('BEFORE fix: retail + 30_day is treated as a cash order (deposit invoice posted at Deposit Paid)',
    (await calls(id)).join() === 'deposit');
}
// Orders already credit-approved before the migration (exposure was added once, at approval).
const preApproved = await mk('commercial', '30_day', 'Material Check', { approvalRef: 'OLD-1', total: 70000 });
const preNever = await mk('commercial', '30_day', 'Quote Approved', { total: 40000 });

// ── Apply the fix ───────────────────────────────────────────────────────────
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration applies', true);
ok('backfill: an order approved before the migration is recorded as counted', (await counted(preApproved)) === 70000);
ok('backfill: an order never approved is not counted', (await counted(preNever)) === 0);
await db.query(`UPDATE orders SET credit_exposure_counted = 0 WHERE id=$1`, [preApproved]);   // e.g. released by a later send-back
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration is re-runnable', true);
ok('re-running does not re-backfill a released order', (await counted(preApproved)) === 0);

// ── 1. Credit by payment terms, any customer type ───────────────────────────
for (const [ct, terms] of [['retail', '30_day'], ['retail', '60_day'], ['retail', 'custom'],
                           ['commercial', '30_day'], ['commercial', 'custom'], ['reseller', '60_day'], [null, '30_day']]) {
  const id = await mk(ct, terms);
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-1' });
  ok(`${ct} + ${terms}: Quote Approved → Material Check (skips Deposit Paid)`, (await st(id)) === 'Material Check');
  const o = await one(`SELECT credit_approval_ref r FROM orders WHERE id=$1`, [id]);
  ok(`${ct} + ${terms}: approval reference saved`, o.r === 'APR-1');
}

// ── 2. Credit skip guards ───────────────────────────────────────────────────
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
  ok('  …and no GL / exposure side effects', (await calls(id)).length === 0 && (await counted(id)) === 0);
}

// ── 3. Legal transitions only (P0: no status jumping) ───────────────────────
const illegal = [
  ['Inquiry', 'Material Check'], ['Inquiry', 'Production'], ['Inquiry', 'Delivered'], ['Inquiry', 'Closed'], ['Inquiry', 'Deposit Paid'],
  ['Quote Approved', 'Production'], ['Quote Approved', 'Closed'], ['Quote Approved', 'Delivered'],
  ['Deposit Paid', 'Production'], ['Deposit Paid', 'Closed'],
  ['Material Check', 'Quality Control'], ['Material Check', 'Delivered'], ['Material Check', 'Cancelled / Refunded'],
  ['Production', 'Ready for Delivery'], ['Production', 'Closed'],
  ['Quality Control', 'Delivered'],
  ['Ready for Delivery', 'Closed'],
  ['Delivered', 'Production'], ['Material Check', 'Quote Approved'], ['Production', 'Material Check'], ['Closed', 'Delivered'],
  ['Deposit Paid', 'Cancelled / Refunded'],
];
for (const [from, to] of illegal) {
  const id = await mk('retail', '30_day', from, { invoiced: true });
  await pay(id);
  await throws(`illegal jump ${from} → ${to} is refused`, () => adv(id, to, { credit_approval_ref: 'X', refund_reference: 'X' }), /INVALID_TRANSITION/);
  ok('  …and the status did not change', (await st(id)) === from);
}
{
  const id = await mk('retail', '50_deposit', 'Inquiry');
  await pay(id);
  for (const to of ['Quote Approved', 'Deposit Paid', 'Material Check', 'Production', 'Quality Control', 'Ready for Delivery', 'Delivered', 'Closed']) {
    await adv(id, to, to === 'Quote Approved' ? {} : {});
  }
  ok('full standard flow walks end to end, one step at a time', (await st(id)) === 'Closed');
}
{
  const id = await mk('retail', '50_deposit', 'Ready for Delivery');
  await adv(id, 'Partially Delivered'); await adv(id, 'Delivered');
  ok('Ready for Delivery → Partially Delivered → Delivered is allowed', (await st(id)) === 'Delivered');
}
{
  const id = await mk('retail', 'cash_before', 'Reported', { order_type: 'repair' });
  for (const to of ['Assessed', 'In Repair', 'QC', 'Redelivered', 'Closed']) await adv(id, to);
  ok('repair order flow walks end to end', (await st(id)) === 'Closed');
  const id2 = await mk('retail', 'cash_before', 'Reported', { order_type: 'repair' });
  await throws('repair order cannot jump Reported → Closed', () => adv(id2, 'Closed'), /INVALID_TRANSITION/);
  await throws('repair order cannot take a standard status', () => adv(id2, 'Production'), /INVALID_TRANSITION/);
}

// ── 4. Deposit proof (every order) ──────────────────────────────────────────
{
  const id = await mk('retail', '50_deposit');
  await throws('cash order with no payment cannot reach Deposit Paid', () => adv(id, 'Deposit Paid'), /DEPOSIT_PAYMENT_REQUIRED/);
  await pay(id, true);
  await throws('a reversed payment does not count', () => adv(id, 'Deposit Paid'), /DEPOSIT_PAYMENT_REQUIRED/);
  ok('  …status unchanged, nothing posted', (await st(id)) === 'Quote Approved' && (await calls(id)).length === 0);
  await pay(id);
  await adv(id, 'Deposit Paid');
  ok('with an unreversed payment: Deposit Paid posts the deposit invoice', (await st(id)) === 'Deposit Paid' && (await calls(id)).join() === 'deposit');
}
{
  const id = await mk('retail', '50_deposit', 'Quote Approved', { invoiced: true });   // invoice journal already exists (the old loophole)
  await throws('invoice already posted + no payment: still cannot reach Deposit Paid', () => adv(id, 'Deposit Paid'), /DEPOSIT_PAYMENT_REQUIRED/);
}
{
  const id = await mk('retail', '30_day');
  await throws('credit order cannot walk into Deposit Paid with no payment (it must use the credit approval)', () => adv(id, 'Deposit Paid'), /DEPOSIT_PAYMENT_REQUIRED/);
  await pay(id);
  await adv(id, 'Deposit Paid');
  ok('credit order that really took a deposit may move to Deposit Paid', (await st(id)) === 'Deposit Paid');
}
{
  const id = await mk('retail', '60_day', 'Inquiry');
  await adv(id, 'Quote Approved');
  ok('credit order: invoice posted at Quote Approved (not at Deposit Paid)', (await calls(id)).join() === 'credit');
}

// ── 5. GL posting when leaving Quote Approved ───────────────────────────────
{
  const id = await mk('retail', '30_day', 'Quote Approved', { invoiced: false });   // terms switched to credit after approval
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-2' });
  ok('invoice never posted → credit invoice is posted exactly once on leaving Quote Approved', (await calls(id)).join() === 'credit');
}
{
  const id = await mk('retail', '30_day', 'Quote Approved', { invoiced: true });
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-3' });
  ok('invoice already posted → not posted again', (await calls(id)).length === 0);
}

// ── 6. Credit exposure is counted once (P1) ─────────────────────────────────
{
  await profile('Exposed Ltd', 0, 50000);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Exposed Ltd' });
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-4' });
  ok('approval adds the order total once (50,000 + 100,000)', (await exposure('Exposed Ltd')) === 150000 && (await counted(id)) === 100000);

  await sendBack(id, 'Quote Approved', true);
  ok('send-back to Quote Approved releases the exposure (back to 50,000)', (await exposure('Exposed Ltd')) === 50000 && (await counted(id)) === 0);
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-5' });
  ok('re-approval counts it once again (150,000, not 250,000)', (await exposure('Exposed Ltd')) === 150000);

  await sendBack(id, 'Quote Approved', false);          // release call failed / was skipped
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-6' });
  ok('even if the release was missed, re-approval does not double count', (await exposure('Exposed Ltd')) === 150000);

  await sendBack(id, 'Quote Approved', true);
  const r1 = await one(`SELECT release_order_credit_exposure($1) r`, [id]);
  ok('release is idempotent (second call releases nothing)', Number(r1.r) === 0 && (await exposure('Exposed Ltd')) === 50000);
}
{
  await profile('Stray Ltd', 0, 10000);
  const id = await mk('retail', '30_day', 'Deposit Paid', { client: 'Stray Ltd' });
  await pay(id);
  await adv(id, 'Material Check', { credit_approval_ref: 'SNEAK' });
  const o = await one(`SELECT credit_approval_ref r FROM orders WHERE id=$1`, [id]);
  ok('an approval ref on any other transition adds no exposure', (await exposure('Stray Ltd')) === 10000 && (await counted(id)) === 0);
  ok('  …and is not stored', o.r === null);
}
{
  await profile('Cancel Ltd', 0, 20000);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Cancel Ltd', total: 30000 });
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-7' });
  await sendBack(id, 'Quote Approved', false);
  await throws('cancel without a refund reference is refused', () => adv(id, 'Cancelled / Refunded'), /REFUND_REFERENCE_REQUIRED/);
  await adv(id, 'Cancelled / Refunded', { refund_reference: 'RF-1' });
  ok('cancelling releases any exposure still counted (back to 20,000)', (await exposure('Cancel Ltd')) === 20000 && (await counted(id)) === 0);
}

// ── 7. Credit limit ─────────────────────────────────────────────────────────
{
  await profile('Limited Ltd', 120000, 50000);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Limited Ltd' });
  await throws('order that would exceed the credit limit is refused', () => adv(id, 'Material Check', { credit_approval_ref: 'APR-8' }), /CREDIT_LIMIT_EXCEEDED/);
  ok('  …status and exposure unchanged', (await st(id)) === 'Quote Approved' && (await exposure('Limited Ltd')) === 50000 && (await counted(id)) === 0);
  await profile('Limited Ltd', 150000, 50000);
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-8' });
  ok('an order that lands exactly on the limit is allowed', (await st(id)) === 'Material Check' && (await exposure('Limited Ltd')) === 150000);
}
{
  await profile('Unlimited Ltd', 0, 999999);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Unlimited Ltd' });
  await adv(id, 'Material Check', { credit_approval_ref: 'APR-9' });
  ok('limit 0 means no limit', (await st(id)) === 'Material Check');
  const id2 = await mk('retail', '30_day', 'Quote Approved', { client: 'No Profile Ltd' });
  await adv(id2, 'Material Check', { credit_approval_ref: 'APR-10' });
  ok('client without a profile: approval works, no profile is created', (await st(id2)) === 'Material Check'
    && Number((await one(`SELECT count(*) c FROM client_profiles WHERE client_name='No Profile Ltd'`)).c) === 0);
}

// ── 8. Browsers cannot write workflow columns directly (RLS would otherwise allow it) ──
{
  const id = await mk('retail', 'cash_before', 'Quote Approved');
  const asBrowser = async (role, sql, p) => { await db.exec(`SET ROLE ${role}`); try { return await db.query(sql, p); } finally { await db.exec(`RESET ROLE`); } };
  const locked = [
    ['status', `UPDATE orders SET status='Production' WHERE id=$1`],
    ['payment_terms', `UPDATE orders SET payment_terms='30_day' WHERE id=$1`],
    ['credit_approval_ref', `UPDATE orders SET credit_approval_ref='SNEAK' WHERE id=$1`],
    ['refund_reference', `UPDATE orders SET refund_reference='SNEAK' WHERE id=$1`],
    ['credit_exposure_counted', `UPDATE orders SET credit_exposure_counted=5 WHERE id=$1`],
    ['invoice_journal_entry_id', `UPDATE orders SET invoice_journal_entry_id=gen_random_uuid() WHERE id=$1`],
  ];
  for (const role of ['authenticated', 'anon']) {
    for (const [col, sql] of locked) {
      await throws(`${role} cannot write ${col} directly`, () => asBrowser(role, sql, [id]), /ORDER_COLUMN_LOCKED/);
    }
  }
  const o = await one(`SELECT status, payment_terms FROM orders WHERE id=$1`, [id]);
  ok('  …and nothing changed', o.status === 'Quote Approved' && o.payment_terms === 'cash_before');
  await asBrowser('authenticated', `UPDATE orders SET quote_number='Q-1', notes='hello' WHERE id=$1`, [id]);
  ok('browser can still save ordinary fields (quote number, notes)', (await one(`SELECT quote_number q FROM orders WHERE id=$1`, [id])).q === 'Q-1');
  await asBrowser('authenticated', `UPDATE orders SET status=status, payment_terms=payment_terms WHERE id=$1`, [id]);
  ok('writing a locked column back to the same value is allowed', true);
  await asBrowser('service_role', `UPDATE orders SET payment_terms='30_day' WHERE id=$1`, [id]);
  ok('service role (the API) can write payment terms', (await one(`SELECT payment_terms p FROM orders WHERE id=$1`, [id])).p === '30_day');
  await db.exec(`SET ROLE service_role`);
  try {
    await adv(id, 'Material Check', { credit_approval_ref: 'APR-11' });
    ok('advance_order_status works when called as service_role (definer rights)', (await st(id)) === 'Material Check');
  } finally { await db.exec(`RESET ROLE`); }
  await db.exec(`SET ROLE authenticated`);
  try {
    await throws('a browser session cannot call advance_order_status', () => adv(id, 'Production'), /permission denied/);
    await throws('a browser session cannot call release_order_credit_exposure', () => db.query(`SELECT release_order_credit_exposure($1)`, [id]), /permission denied/);
  } finally { await db.exec(`RESET ROLE`); }
}

// ── 9. Unchanged behaviour ──────────────────────────────────────────────────
{
  const id = await mk('retail', 'cash_before', 'Deposit Paid');
  await throws('same status still refused', () => adv(id, 'Deposit Paid'), /SAME_STATUS/);
  await throws('unknown order still refused', () => adv('00000000-0000-0000-0000-000000000000', 'Material Check'), /ORDER_NOT_FOUND/);
}
{
  for (const fn of ['advance_order_status(uuid,text,uuid,jsonb)', 'release_order_credit_exposure(uuid)']) {
    const r = await one(`SELECT has_function_privilege('anon','${fn}','EXECUTE') a,
                                has_function_privilege('authenticated','${fn}','EXECUTE') u,
                                has_function_privilege('service_role','${fn}','EXECUTE') s`);
    ok(`only service_role can execute ${fn.split('(')[0]}`, !r.a && !r.u && r.s, JSON.stringify(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
