// Database tests for supabase/migrations/orders_credit_by_payment_terms.sql
//
// Loads the REAL quotes_crm_migration_d.sql (old advance_order_status) to reproduce the bug,
// then the fix migration. The two GL posting functions are stubbed: they only record that
// they were called (their accounting is covered elsewhere).
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/orders_credit_by_payment_terms.pglite.mjs
//
// NOT covered: concurrent connections, the real GL journals, who may approve credit or edit
// customers (ROLE rules, tested in orders_status_route.harness.mjs), PostgREST's own role
// switching (simulated with SET ROLE).

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
  CREATE TABLE customers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, phone text, notes text,
    credit_limit numeric(12,2) NOT NULL DEFAULT 0,
    opening_balance numeric(12,2) NOT NULL DEFAULT 0,
    opening_balance_date date
  );
  CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_num text, invoice_number text, quote_number text, notes text, batch_delivery boolean DEFAULT false,
    order_type text NOT NULL DEFAULT 'standard',
    status text NOT NULL DEFAULT 'Inquiry',
    client text, customer_id uuid REFERENCES customers(id), total_value numeric(14,2),
    customer_type text, payment_terms text,
    invoice_journal_entry_id uuid,
    credit_approval_ref text, refund_reference text,
    updated_at timestamptz
  );
  CREATE TABLE order_payments (id serial PRIMARY KEY, order_id uuid, amount numeric, reversed_at timestamptz);
  CREATE TABLE gl_calls (id serial PRIMARY KEY, order_id uuid, kind text);
  GRANT ALL ON customers, orders, order_payments, gl_calls TO anon, authenticated, service_role;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

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

const customer = async (name, limit = 0, opening = 0, openingDate = null) =>
  (await one(`INSERT INTO customers (name, credit_limit, opening_balance, opening_balance_date) VALUES ($1,$2,$3,$4) RETURNING id`, [name, limit, opening, openingDate])).id;
const setLimit = (id, limit) => db.query(`UPDATE customers SET credit_limit=$2 WHERE id=$1`, [id, limit]);

let acme;   // default customer with a huge limit; assigned after the migration
const mk = async (customer_type, payment_terms, status = 'Quote Approved', opts = {}) => {
  const { invoiced = false, total = 100000, order_type = 'standard', approvalRef = null, cust = acme } = opts;
  return (await one(
    `INSERT INTO orders (order_num, status, client, customer_id, total_value, customer_type, payment_terms, invoice_journal_entry_id, order_type, credit_approval_ref)
     VALUES ('ORD-' || nextval(pg_get_serial_sequence('gl_calls','id')), $1, 'Client', $2, $3, $4, $5, CASE WHEN $6 THEN gen_random_uuid() END, $7, $8)
     RETURNING id`, [status, cust, total, customer_type, payment_terms, invoiced, order_type, approvalRef])).id;
};
const pay = async (id, amount = 50000, reversed = false) =>
  (await one(`INSERT INTO order_payments (order_id, amount, reversed_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id`, [id, amount, reversed])).id;
const adv = (id, to, extra = {}) =>
  db.query(`SELECT advance_order_status($1, $2, gen_random_uuid(), $3::jsonb) r`, [id, to, JSON.stringify(extra)]);
const st = async id => (await one(`SELECT status FROM orders WHERE id=$1`, [id])).status;
const calls = async id => (await db.query(`SELECT kind FROM gl_calls WHERE order_id=$1 ORDER BY id`, [id])).rows.map(r => r.kind);
const position = async (cust, exclude = null) => (await one(`SELECT customer_credit_position($1,$2) p`, [cust, exclude])).p;
const asRole = async (role, fn) => { await db.exec(`SET ROLE ${role}`); try { return await fn(); } finally { await db.exec(`RESET ROLE`); } };
const setStatus = (id, to) => asRole('service_role', () => db.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, to]));   // the API's send-back
const approve = (id, ref = 'APR') => adv(id, 'Material Check', { credit_approval_ref: ref });

// ── 0. Old function: the bug. Plus leftovers from an earlier draft that must be cleaned up ──
await db.exec(mig('quotes_crm_migration_d.sql'));
{
  const id = await mk('retail', '30_day', 'Quote Approved', { cust: null });
  await adv(id, 'Deposit Paid');
  ok('BEFORE fix: retail + 30_day is treated as a cash order (deposit invoice posted at Deposit Paid)',
    (await calls(id)).join() === 'deposit');
}
await db.exec(`
  ALTER TABLE orders ADD COLUMN credit_exposure_counted numeric DEFAULT 0;
  CREATE FUNCTION release_order_credit_exposure(p uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$;
  CREATE FUNCTION refresh_client_exposure(p text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
`);

await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration applies', true);
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration is re-runnable', true);
{
  const r = await one(`SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='credit_exposure_counted') col,
      (SELECT count(*) FROM pg_proc WHERE proname IN ('release_order_credit_exposure','refresh_client_exposure')) fn`);
  ok('objects from the earlier draft (per-order exposure column and helpers) are removed', Number(r.col) === 0 && Number(r.fn) === 0, JSON.stringify(r));
}

acme = await customer('Acme', 100000000);

// ── 1. Credit by payment terms, any customer type ───────────────────────────
for (const [ct, terms] of [['retail', '30_day'], ['retail', '60_day'], ['retail', 'custom'],
                           ['commercial', '30_day'], ['commercial', 'custom'], ['reseller', '60_day'], [null, '30_day']]) {
  const id = await mk(ct, terms);
  await approve(id, 'APR-1');
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
  await throws(`${ct} + ${terms}: cannot skip Deposit Paid (even with an approval ref)`, () => approve(id), /DEPOSIT_REQUIRED/);
  ok('  …and the status did not change, nothing posted', (await st(id)) === 'Quote Approved' && (await calls(id)).length === 0);
}

// ── 3. Legal transitions only (no status jumping) ───────────────────────────
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
  for (const to of ['Quote Approved', 'Deposit Paid', 'Material Check', 'Production', 'Quality Control', 'Ready for Delivery', 'Delivered', 'Closed']) await adv(id, to);
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
  await pay(id, 50000, true);
  await throws('a reversed payment does not count', () => adv(id, 'Deposit Paid'), /DEPOSIT_PAYMENT_REQUIRED/);
  ok('  …status unchanged, nothing posted', (await st(id)) === 'Quote Approved' && (await calls(id)).length === 0);
  await pay(id);
  await adv(id, 'Deposit Paid');
  ok('with an unreversed payment: Deposit Paid posts the deposit invoice', (await st(id)) === 'Deposit Paid' && (await calls(id)).join() === 'deposit');
}
{
  const id = await mk('retail', '50_deposit', 'Quote Approved', { invoiced: true });
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
  const id = await mk('retail', '30_day', 'Quote Approved', { invoiced: false });
  await approve(id, 'APR-2');
  ok('invoice never posted → credit invoice is posted exactly once on leaving Quote Approved', (await calls(id)).join() === 'credit');
}
{
  const id = await mk('retail', '30_day', 'Quote Approved', { invoiced: true });
  await approve(id, 'APR-3');
  ok('invoice already posted → not posted again', (await calls(id)).length === 0);
}

// ── 6. Credit fails closed ──────────────────────────────────────────────────
{
  const id = await mk('retail', '30_day', 'Quote Approved', { cust: null });
  await throws('order not linked to a customer cannot be approved', () => approve(id), /CUSTOMER_REQUIRED/);
  ok('  …status unchanged, nothing posted', (await st(id)) === 'Quote Approved' && (await calls(id)).length === 0);
  const c = await customer('Late Link Ltd', 150000);
  await db.query(`UPDATE orders SET customer_id=$2 WHERE id=$1`, [id, c]);
  await approve(id);
  ok('once the order is linked to a customer with a limit, it can be approved', (await st(id)) === 'Material Check');
}
{
  const c = await customer('Zero Ltd', 0);
  const id = await mk('retail', '30_day', 'Quote Approved', { cust: c });
  await throws('customer credit limit 0 is NOT "unlimited": approval is refused', () => approve(id), /CREDIT_LIMIT_NOT_SET/);
  await db.query(`UPDATE customers SET credit_limit = 0.00 WHERE id=$1`, [c]);
  ok('  …status unchanged', (await st(id)) === 'Quote Approved');
  await setLimit(c, 150000);
  await approve(id);
  ok('once an admin sets a limit on the customer, the same order can be approved', (await st(id)) === 'Material Check');
}
{
  // the limit that counts is the CUSTOMER limit, not a client profile
  await db.exec(`CREATE TABLE IF NOT EXISTS client_profiles (client_name text PRIMARY KEY, credit_limit numeric)`);
  await db.exec(`INSERT INTO client_profiles VALUES ('Client', 99999999) ON CONFLICT DO NOTHING`);
  const c = await customer('Profile Ignored Ltd', 0);
  const id = await mk('retail', '30_day', 'Quote Approved', { cust: c });
  await throws('a limit set only on a client_profiles row does not unlock credit (the customer record is the source)', () => approve(id), /CREDIT_LIMIT_NOT_SET/);
}

// ── 7. What a customer owes ─────────────────────────────────────────────────
{
  const c = await customer('Pos Ltd', 1000000, 200000);
  const other = await customer('Other Ltd', 1000000);
  const inq    = await mk('retail', '30_day', 'Inquiry',        { cust: c, total: 50000 });
  const quote  = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 60000 });
  const dep    = await mk('retail', '50_deposit', 'Deposit Paid', { cust: c, total: 100000 });
  await pay(dep, 40000);
  const prod   = await mk('retail', '30_day', 'Production',     { cust: c, total: 30000 });
  const closed = await mk('retail', '30_day', 'Closed',         { cust: c, total: 80000 });
  await pay(closed, 80000);
  const cancel = await mk('retail', '30_day', 'Cancelled / Refunded', { cust: c, total: 90000 });
  const over   = await mk('retail', '30_day', 'Delivered',      { cust: c, total: 70000 });
  await pay(over, 75000);
  await mk('retail', '30_day', 'Production', { cust: other, total: 999999 });
  const p = await position(c);
  ok('enquiries and unapproved quotes are NOT counted', p.owed_on_orders === 90000 || Number(p.owed_on_orders) === 90000, JSON.stringify(p));
  ok('owed = opening balance 200,000 + 60,000 (deposit order) + 30,000 (production) = 290,000', Number(p.outstanding) === 290000, JSON.stringify(p));
  ok('fully paid, cancelled and overpaid orders add nothing; overpayment does not offset others', Number(p.owed_on_orders) === 90000);
  ok('another customer\'s debt is not mixed in; limit and name are reported', Number(p.limit) === 1000000 && p.customer_name === 'Pos Ltd');
  const px = await position(c, dep);
  ok('the order being approved can be excluded (290,000 − 60,000 = 230,000)', Number(px.outstanding) === 230000, JSON.stringify(px));
  await pay(dep, 30000, true);
  ok('a reversed payment does not reduce what is owed', Number((await position(c)).outstanding) === 290000);
  await pay(dep, 60000);
  ok('payments reduce what is owed (290,000 − 60,000 = 230,000)', Number((await position(c)).outstanding) === 230000);
  await db.query(`UPDATE customers SET opening_balance = -50000 WHERE id=$1`, [c]);
  ok('a negative opening balance (customer in credit) is floored at 0, not netted against orders', Number((await position(c)).outstanding) === 30000, JSON.stringify(await position(c)));
  ok('unknown customer returns NULL', (await position('00000000-0000-0000-0000-000000000000')) === null);
}

// ── 8. Credit limit uses what is owed ───────────────────────────────────────
{
  const c = await customer('Cap Ltd', 120000, 20000);
  const o1 = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 80000 });
  const o2 = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 50000 });
  for (let i = 0; i < 5; i++) await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 1000000 });   // unapproved quotes
  await approve(o1);
  ok('big unapproved quotes do not block an approval (20,000 + 80,000 = 100,000 ≤ 120,000)', (await st(o1)) === 'Material Check');
  await throws('opening 20,000 + owed 80,000 + this 50,000 = 150,000 exceeds the 120,000 limit', () => approve(o2), /CREDIT_LIMIT_EXCEEDED/);
  ok('  …status unchanged', (await st(o2)) === 'Quote Approved');
  await pay(o1, 40000);
  await approve(o2);
  ok('after the customer pays 40,000 the same order fits (20,000 + 40,000 + 50,000 = 110,000)', (await st(o2)) === 'Material Check');
  const o3 = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 10000 });
  await approve(o3);
  ok('an order that lands exactly on the limit is allowed (120,000)', (await st(o3)) === 'Material Check');
  const o4 = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 1 });
  await throws('one shilling over is refused', () => approve(o4), /CREDIT_LIMIT_EXCEEDED/);
  await setStatus(o3, 'Quote Approved');
  await approve(o4);
  ok('sending an order back to Quote Approved stops it counting, so room is freed (no release step needed)', (await st(o4)) === 'Material Check');
  await setStatus(o4, 'Quote Approved');
  await approve(o3);
  ok('re-approving a sent-back order counts it once, not twice', (await st(o3)) === 'Material Check' && Number((await position(c)).outstanding) === 20000 + 40000 + 50000 + 10000);
  await adv(o2, 'Production');
  const refused = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 5 });
  await throws('cancelled orders drop out only when actually cancelled; others keep counting', () => approve(refused), /CREDIT_LIMIT_EXCEEDED/);
}
{
  const c = await customer('Deposit Credit Ltd', 50000);
  const id = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 100000 });
  await pay(id, 60000);
  await approve(id);
  ok('payments already on THIS order reduce what it adds (100,000 − 60,000 = 40,000 ≤ 50,000)', (await st(id)) === 'Material Check');
}
{
  const c = await customer('Cancel Ltd', 100000);
  const a = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 100000 });
  await approve(a);
  const b = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 10 });
  await throws('customer is at their limit', () => approve(b), /CREDIT_LIMIT_EXCEEDED/);
  await setStatus(a, 'Quote Approved');
  const x = await mk('retail', '30_day', 'Quote Approved', { cust: c, total: 100000 });
  await throws('cancel without a refund reference is refused', () => adv(a, 'Cancelled / Refunded'), /REFUND_REFERENCE_REQUIRED/);
  await adv(a, 'Cancelled / Refunded', { refund_reference: 'RF-1' });
  await approve(x);
  ok('a cancelled order does not count against the customer', (await st(x)) === 'Material Check');
}

// ── 9. Browsers cannot write workflow / credit / payment data directly ──────
{
  const id = await mk('retail', 'cash_before', 'Quote Approved', { total: 5000 });
  const upd = (role, sql) => asRole(role, () => db.query(sql, [id]));
  const lockedOrders = {
    status: `status='Production'`, payment_terms: `payment_terms='30_day'`, credit_approval_ref: `credit_approval_ref='SNEAK'`,
    refund_reference: `refund_reference='SNEAK'`, invoice_journal_entry_id: `invoice_journal_entry_id=gen_random_uuid()`,
    total_value: `total_value=1`, customer_id: `customer_id=NULL`, customer_type: `customer_type='commercial'`,
    order_type: `order_type='repair'`, invoice_number: `invoice_number='INV-FAKE'`, client: `client='Other'`,
  };
  for (const [col, set] of Object.entries(lockedOrders)) {
    await throws(`browser cannot write orders.${col}`, () => upd('authenticated', `UPDATE orders SET ${set} WHERE id=$1`), /ORDER_COLUMN_LOCKED/);
  }
  for (const set of [`status='Production'`, `payment_terms='30_day'`, `total_value=1`]) {
    await throws(`anon cannot write ${set.split('=')[0]} either`, () => upd('anon', `UPDATE orders SET ${set} WHERE id=$1`), /ORDER_COLUMN_LOCKED/);
  }
  await throws('a mixed update that includes one locked column is refused as a whole',
    () => upd('authenticated', `UPDATE orders SET quote_number='Q-9', status='Production' WHERE id=$1`), /ORDER_COLUMN_LOCKED/);
  const o = await one(`SELECT status, payment_terms, total_value, quote_number FROM orders WHERE id=$1`, [id]);
  ok('  …and nothing changed', o.status === 'Quote Approved' && o.payment_terms === 'cash_before' && Number(o.total_value) === 5000 && o.quote_number === null);

  await upd('authenticated', `UPDATE orders SET quote_number='Q-1', batch_delivery=true WHERE id=$1`);
  const q = await one(`SELECT quote_number, batch_delivery FROM orders WHERE id=$1`, [id]);
  ok('browser can still save the quote number and batch delivery', q.quote_number === 'Q-1' && q.batch_delivery === true);
  await upd('authenticated', `UPDATE orders SET status=status, payment_terms=payment_terms WHERE id=$1`);
  ok('writing a locked column back to its current value is allowed', true);
  await upd('service_role', `UPDATE orders SET payment_terms='30_day' WHERE id=$1`);
  ok('service role (the API) can write payment terms', (await one(`SELECT payment_terms p FROM orders WHERE id=$1`, [id])).p === '30_day');

  const ins = (role, cols, vals) => asRole(role, () => db.query(`INSERT INTO orders (client, ${cols}) VALUES ('New Ltd', ${vals})`));
  await ins('authenticated', `status`, `'Inquiry'`);
  ok('browser can create a fresh Inquiry order', true);
  await throws('browser cannot create an order already in Production', () => ins('authenticated', `status`, `'Production'`), /ORDER_COLUMN_LOCKED/);
  await throws('browser cannot create an order with a credit approval', () => ins('authenticated', `status, credit_approval_ref`, `'Inquiry', 'SNEAK'`), /ORDER_COLUMN_LOCKED/);
  await throws('browser cannot create an order with an invoice link', () => ins('authenticated', `status, invoice_journal_entry_id`, `'Inquiry', gen_random_uuid()`), /ORDER_COLUMN_LOCKED/);
  await throws('anon cannot create an order with a refund reference', () => ins('anon', `status, refund_reference`, `'Inquiry', 'X'`), /ORDER_COLUMN_LOCKED/);

  // customers: the credit source
  const cid = await customer('Guard Customer Ltd', 10000, 500, '2026-01-01');
  const cu = (role, sql) => asRole(role, () => db.query(sql));
  for (const set of [`credit_limit=99999999`, `opening_balance=0`, `opening_balance_date='2026-02-02'`, `opening_balance_date=NULL`]) {
    await throws(`browser cannot write customers.${set.split('=')[0]}`, () => cu('authenticated', `UPDATE customers SET ${set} WHERE id='${cid}'`), /CREDIT_COLUMN_LOCKED/);
  }
  await throws('anon cannot raise a credit limit either', () => cu('anon', `UPDATE customers SET credit_limit=1 WHERE id='${cid}'`), /CREDIT_COLUMN_LOCKED/);
  await cu('authenticated', `UPDATE customers SET phone='0700', notes='called' WHERE id='${cid}'`);
  ok('browser can still edit ordinary customer fields', true);
  await cu('authenticated', `UPDATE customers SET credit_limit=credit_limit WHERE id='${cid}'`);
  ok('writing a credit column back to its current value is allowed', true);
  await cu('authenticated', `INSERT INTO customers (name) VALUES ('Plain New Customer')`);
  ok('browser can create a customer with no credit settings', true);
  await throws('browser cannot create a customer with a credit limit', () => cu('authenticated', `INSERT INTO customers (name, credit_limit) VALUES ('Greedy', 5000)`), /CREDIT_COLUMN_LOCKED/);
  await throws('browser cannot create a customer with an opening balance', () => cu('authenticated', `INSERT INTO customers (name, opening_balance) VALUES ('Greedy2', 1)`), /CREDIT_COLUMN_LOCKED/);
  ok('  …and the real limit was untouched', Number((await one(`SELECT credit_limit l FROM customers WHERE id=$1`, [cid])).l) === 10000);
  await cu('service_role', `UPDATE customers SET credit_limit=20000, opening_balance=0 WHERE id='${cid}'`);
  ok('service role (the admin-only API) can set credit settings', Number((await one(`SELECT credit_limit l FROM customers WHERE id=$1`, [cid])).l) === 20000);

  // payments
  const pid = await pay(id, 1000);
  await throws('browser cannot insert a payment (fake deposit)', () => cu('authenticated', `INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 99999)`), /PAYMENT_WRITE_LOCKED/);
  await throws('anon cannot insert a payment either', () => cu('anon', `INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 99999)`), /PAYMENT_WRITE_LOCKED/);
  await throws('browser cannot reverse or edit a payment', () => cu('authenticated', `UPDATE order_payments SET reversed_at=now(), amount=1 WHERE id=${pid}`), /PAYMENT_WRITE_LOCKED/);
  await throws('browser cannot delete a payment', () => cu('authenticated', `DELETE FROM order_payments WHERE id=${pid}`), /PAYMENT_WRITE_LOCKED/);
  ok('  …and the payment is intact', Number((await one(`SELECT amount a FROM order_payments WHERE id=$1`, [pid])).a) === 1000);
  await cu('service_role', `INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 500)`);
  ok('service role (the payments API) can record a payment', true);

  // functions
  await asRole('service_role', async () => {
    const o2 = await mk('retail', '30_day', 'Quote Approved');
    await approve(o2, 'APR-11');
    ok('advance_order_status works when called as service_role (definer rights)', (await st(o2)) === 'Material Check');
  });
  await asRole('authenticated', async () => {
    await throws('a browser session cannot call advance_order_status', () => adv(id, 'Production'), /permission denied/);
    await throws('a browser session cannot call customer_credit_position', () => db.query(`SELECT customer_credit_position($1)`, [acme]), /permission denied/);
  });
}

// ── 10. Unchanged behaviour ─────────────────────────────────────────────────
{
  const id = await mk('retail', 'cash_before', 'Deposit Paid');
  await throws('same status still refused', () => adv(id, 'Deposit Paid'), /SAME_STATUS/);
  await throws('unknown order still refused', () => adv('00000000-0000-0000-0000-000000000000', 'Material Check'), /ORDER_NOT_FOUND/);
}
{
  for (const fn of ['advance_order_status(uuid,text,uuid,jsonb)', 'customer_credit_position(uuid,uuid)']) {
    const r = await one(`SELECT has_function_privilege('anon','${fn}','EXECUTE') a,
                                has_function_privilege('authenticated','${fn}','EXECUTE') u,
                                has_function_privilege('service_role','${fn}','EXECUTE') s`);
    ok(`only service_role can execute ${fn.split('(')[0]}`, !r.a && !r.u && r.s, JSON.stringify(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
