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
    order_num text, invoice_number text, quote_number text, notes text, batch_delivery boolean DEFAULT false,
    order_type text NOT NULL DEFAULT 'standard',
    status text NOT NULL DEFAULT 'Inquiry',
    client text, total_value numeric(14,2),
    customer_type text, payment_terms text,
    invoice_journal_entry_id uuid,
    credit_approval_ref text, refund_reference text,
    updated_at timestamptz
  );
  CREATE TABLE order_payments (id serial PRIMARY KEY, order_id uuid, amount numeric, reversed_at timestamptz);
  CREATE TABLE client_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name text NOT NULL UNIQUE, customer_type text NOT NULL DEFAULT 'retail',
    credit_limit numeric(12,2) DEFAULT 0, current_exposure numeric(14,2) DEFAULT 0, notes text, updated_at timestamptz
  );
  CREATE TABLE gl_calls (id serial PRIMARY KEY, order_id uuid, kind text);
  GRANT ALL ON orders, order_payments, client_profiles, gl_calls TO anon, authenticated, service_role;
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

const mk = async (customer_type, payment_terms, status = 'Quote Approved', opts = {}) => {
  const { invoiced = false, client = 'Acme', total = 100000, order_type = 'standard', approvalRef = null } = opts;
  return (await one(
    `INSERT INTO orders (order_num, status, client, total_value, customer_type, payment_terms, invoice_journal_entry_id, order_type, credit_approval_ref)
     VALUES ('ORD-' || nextval(pg_get_serial_sequence('gl_calls','id')), $1, $2, $3, $4, $5, CASE WHEN $6 THEN gen_random_uuid() END, $7, $8)
     RETURNING id`, [status, client, total, customer_type, payment_terms, invoiced, order_type, approvalRef])).id;
};
const pay = async (id, amount = 50000, reversed = false) =>
  (await one(`INSERT INTO order_payments (order_id, amount, reversed_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END) RETURNING id`, [id, amount, reversed])).id;
const adv = (id, to, extra = {}) =>
  db.query(`SELECT advance_order_status($1, $2, gen_random_uuid(), $3::jsonb) r`, [id, to, JSON.stringify(extra)]);
const st = async id => (await one(`SELECT status FROM orders WHERE id=$1`, [id])).status;
const calls = async id => (await db.query(`SELECT kind FROM gl_calls WHERE order_id=$1 ORDER BY id`, [id])).rows.map(r => r.kind);
const counted = async id => Number((await one(`SELECT credit_exposure_counted c FROM orders WHERE id=$1`, [id])).c);
const exposure = async name => Number((await one(`SELECT current_exposure e FROM client_profiles WHERE client_name=$1`, [name])).e);
const profile = (name, limit, exp = 0) => db.query(
  `INSERT INTO client_profiles (client_name, credit_limit, current_exposure) VALUES ($1,$2,$3)
   ON CONFLICT (client_name) DO UPDATE SET credit_limit=$2, current_exposure=$3`, [name, limit, exp]);
const asRole = async (role, fn) => { await db.exec(`SET ROLE ${role}`); try { return await fn(); } finally { await db.exec(`RESET ROLE`); } };
// Simulates the API route's send-back: a direct status update as the service role, then the release call.
const sendBack = (id, to, release = true) => asRole('service_role', async () => {
  await db.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, to]);
  if (release) await db.query(`SELECT release_order_credit_exposure($1)`, [id]);
});
const approve = (id, ref = 'APR') => adv(id, 'Material Check', { credit_approval_ref: ref });

// ── 0. Old function: the bug, and the pre-migration data that must be handled ──
await db.exec(mig('quotes_crm_migration_d.sql'));
{
  const id = await mk('retail', '30_day');
  await adv(id, 'Deposit Paid');
  ok('BEFORE fix: retail + 30_day is treated as a cash order (deposit invoice posted at Deposit Paid)',
    (await calls(id)).join() === 'deposit');
}
await profile('Legacy Ltd', 500000, 999999);   // old lifetime counter, far above anything outstanding
const preApproved = await mk('commercial', '30_day', 'Material Check', { client: 'Legacy Ltd', approvalRef: 'OLD-1', total: 70000 });
const preReworked = await mk('commercial', '30_day', 'Quote Approved', { client: 'Legacy Ltd', approvalRef: 'OLD-2', total: 40000 });
const prePaid = await mk('commercial', '30_day', 'Closed', { client: 'Legacy Ltd', approvalRef: 'OLD-3', total: 30000 });
await pay(prePaid, 30000);

// ── Apply the fix ───────────────────────────────────────────────────────────
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration applies', true);
ok('backfill: order approved before the migration and still past Quote Approved is credit-approved', (await counted(preApproved)) === 70000);
ok('backfill: order sent back to Quote Approved is NOT counted', (await counted(preReworked)) === 0);
ok('exposure is recomputed from live data (70,000 outstanding + 0 for the fully paid order), not the old 999,999 counter',
  (await exposure('Legacy Ltd')) === 70000, String(await exposure('Legacy Ltd')));
await db.query(`UPDATE orders SET credit_exposure_counted = 0 WHERE id=$1`, [preApproved]);
await db.exec(mig('orders_credit_by_payment_terms.sql'));
ok('fix migration is re-runnable', true);
ok('re-running does not re-backfill a released order', (await counted(preApproved)) === 0);
ok('re-running refreshes the stored exposure (now 0)', (await exposure('Legacy Ltd')) === 0);

await profile('Acme', 100000000);

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
  ok('  …and the status did not change', (await st(id)) === 'Quote Approved');
  ok('  …and no GL / credit side effects', (await calls(id)).length === 0 && (await counted(id)) === 0);
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
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'No Profile Ltd' });
  await throws('client with NO credit profile cannot be approved', () => approve(id), /CREDIT_PROFILE_REQUIRED/);
  ok('  …status unchanged, nothing posted, no profile created', (await st(id)) === 'Quote Approved' && (await calls(id)).length === 0
    && Number((await one(`SELECT count(*) c FROM client_profiles WHERE client_name='No Profile Ltd'`)).c) === 0);
}
{
  await profile('Zero Ltd', 0);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Zero Ltd' });
  await throws('credit limit 0 is NOT "unlimited": approval is refused', () => approve(id), /CREDIT_LIMIT_NOT_SET/);
  await db.query(`UPDATE client_profiles SET credit_limit = NULL WHERE client_name='Zero Ltd'`);
  await throws('credit limit NULL is refused too', () => approve(id), /CREDIT_LIMIT_NOT_SET/);
  ok('  …status unchanged', (await st(id)) === 'Quote Approved' && (await counted(id)) === 0);
  await profile('Zero Ltd', 150000);
  await approve(id);
  ok('once an admin sets a limit, the same order can be approved', (await st(id)) === 'Material Check');
}

// ── 7. Exposure is live outstanding credit (payments reduce it) ─────────────
{
  await profile('Live Ltd', 500000);
  const a = await mk('retail', '30_day', 'Quote Approved', { client: 'Live Ltd', total: 100000 });
  const b = await mk('retail', '30_day', 'Quote Approved', { client: 'Live Ltd', total: 80000 });
  await approve(a); await approve(b);
  ok('two approvals: 100,000 + 80,000 outstanding', (await exposure('Live Ltd')) === 180000, String(await exposure('Live Ltd')));
  const p1 = await pay(a, 40000);
  ok('a payment reduces exposure (140,000)', (await exposure('Live Ltd')) === 140000, String(await exposure('Live Ltd')));
  await db.query(`UPDATE order_payments SET reversed_at = now() WHERE id=$1`, [p1]);
  ok('reversing the payment restores it (180,000)', (await exposure('Live Ltd')) === 180000);
  await pay(a, 100000);
  ok('fully paid order drops out (80,000)', (await exposure('Live Ltd')) === 80000);
  await pay(a, 5000);
  ok('overpayment never makes exposure negative', (await exposure('Live Ltd')) === 80000);
  await db.query(`UPDATE orders SET total_value = 90000 WHERE id=$1`, [b]);
  ok('an order total change is reflected (90,000)', (await exposure('Live Ltd')) === 90000);
  await sendBack(b, 'Quote Approved', true);
  ok('send-back to Quote Approved withdraws the approval (0)', (await exposure('Live Ltd')) === 0 && (await counted(b)) === 0);
  const r = await one(`SELECT release_order_credit_exposure($1) r`, [b]);
  ok('release is idempotent', Number(r.r) === 0 && (await exposure('Live Ltd')) === 0);
}
{
  await profile('Resend Ltd', 500000);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Resend Ltd', total: 60000 });
  await approve(id, 'A1');
  await sendBack(id, 'Quote Approved', false);                    // the release call failed / was skipped
  ok('missed release leaves it counted (the safe side)', (await exposure('Resend Ltd')) === 60000);
  await approve(id, 'A2');
  ok('re-approval does not double count (60,000, not 120,000)', (await exposure('Resend Ltd')) === 60000);
}
{
  await profile('Stray Ltd', 500000);
  const id = await mk('retail', '30_day', 'Deposit Paid', { client: 'Stray Ltd', total: 50000 });
  await pay(id, 10000);
  await adv(id, 'Material Check', { credit_approval_ref: 'SNEAK' });
  const o = await one(`SELECT credit_approval_ref r FROM orders WHERE id=$1`, [id]);
  ok('an approval ref on any other transition adds no exposure and is not stored', (await exposure('Stray Ltd')) === 0 && o.r === null);
}
{
  await profile('Cancel Ltd', 500000);
  const keep = await mk('retail', '30_day', 'Quote Approved', { client: 'Cancel Ltd', total: 20000 });
  await approve(keep);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Cancel Ltd', total: 30000 });
  await approve(id);
  await sendBack(id, 'Quote Approved', false);
  ok('before cancelling: 50,000 outstanding', (await exposure('Cancel Ltd')) === 50000);
  await throws('cancel without a refund reference is refused', () => adv(id, 'Cancelled / Refunded'), /REFUND_REFERENCE_REQUIRED/);
  await adv(id, 'Cancelled / Refunded', { refund_reference: 'RF-1' });
  ok('cancelling removes the order from exposure (20,000)', (await exposure('Cancel Ltd')) === 20000 && (await counted(id)) === 0);
}

// ── 8. Credit limit uses outstanding, not lifetime ──────────────────────────
{
  await profile('Cap Ltd', 120000);
  const o1 = await mk('retail', '30_day', 'Quote Approved', { client: 'Cap Ltd', total: 100000 });
  const o2 = await mk('retail', '30_day', 'Quote Approved', { client: 'Cap Ltd', total: 50000 });
  await approve(o1);
  await throws('100,000 outstanding + 50,000 exceeds the 120,000 limit', () => approve(o2), /CREDIT_LIMIT_EXCEEDED/);
  ok('  …status and exposure unchanged', (await st(o2)) === 'Quote Approved' && (await exposure('Cap Ltd')) === 100000 && (await counted(o2)) === 0);
  await pay(o1, 40000);
  await approve(o2);
  ok('after the client pays 40,000 the same order fits (60,000 + 50,000 = 110,000)', (await st(o2)) === 'Material Check' && (await exposure('Cap Ltd')) === 110000);
  const o3 = await mk('retail', '30_day', 'Quote Approved', { client: 'Cap Ltd', total: 10000 });
  await approve(o3);
  ok('an order that lands exactly on the limit is allowed (120,000)', (await exposure('Cap Ltd')) === 120000);
  const o4 = await mk('retail', '30_day', 'Quote Approved', { client: 'Cap Ltd', total: 1 });
  await throws('one shilling over is refused', () => approve(o4), /CREDIT_LIMIT_EXCEEDED/);
}
{
  await profile('Deposit Credit Ltd', 50000);
  const id = await mk('retail', '30_day', 'Quote Approved', { client: 'Deposit Credit Ltd', total: 100000 });
  await pay(id, 60000);
  await approve(id);
  ok('payments already on THIS order reduce what it adds (100,000 − 60,000 = 40,000 ≤ 50,000)', (await st(id)) === 'Material Check' && (await exposure('Deposit Credit Ltd')) === 40000);
}

// ── 9. Browsers cannot write workflow / credit / payment data directly ──────
{
  const id = await mk('retail', 'cash_before', 'Quote Approved', { client: 'Guard Ltd', total: 5000 });
  const upd = (role, sql) => asRole(role, () => db.query(sql, [id]));
  const lockedOrders = {
    status: `status='Production'`, payment_terms: `payment_terms='30_day'`, credit_approval_ref: `credit_approval_ref='SNEAK'`,
    refund_reference: `refund_reference='SNEAK'`, credit_exposure_counted: `credit_exposure_counted=5`,
    invoice_journal_entry_id: `invoice_journal_entry_id=gen_random_uuid()`, total_value: `total_value=1`,
    client: `client='Other Ltd'`, customer_type: `customer_type='commercial'`, order_type: `order_type='repair'`,
    invoice_number: `invoice_number='INV-FAKE'`, notes: null, // notes handled below
  };
  for (const [col, set] of Object.entries(lockedOrders)) {
    if (!set) continue;
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

  // inserts
  const ins = (role, cols, vals) => asRole(role, () => db.query(`INSERT INTO orders (client, ${cols}) VALUES ('New Ltd', ${vals})`));
  await ins('authenticated', `status`, `'Inquiry'`);
  ok('browser can create a fresh Inquiry order', true);
  await throws('browser cannot create an order already in Production', () => ins('authenticated', `status`, `'Production'`), /ORDER_COLUMN_LOCKED/);
  await throws('browser cannot create an order with a credit approval', () => ins('authenticated', `status, credit_approval_ref`, `'Inquiry', 'SNEAK'`), /ORDER_COLUMN_LOCKED/);
  await throws('browser cannot create an order with exposure marked', () => ins('anon', `status, credit_exposure_counted`, `'Inquiry', 5`), /ORDER_COLUMN_LOCKED/);
  await throws('browser cannot create an order with an invoice link', () => ins('authenticated', `status, invoice_journal_entry_id`, `'Inquiry', gen_random_uuid()`), /ORDER_COLUMN_LOCKED/);

  // client profiles
  await profile('Guard Profile Ltd', 10000, 100);
  const cp = (role, sql) => asRole(role, () => db.query(sql));
  for (const set of [`credit_limit=99999999`, `current_exposure=0`, `client_name='Renamed'`, `customer_type='reseller'`]) {
    await throws(`browser cannot write client_profiles.${set.split('=')[0]}`, () => cp('authenticated', `UPDATE client_profiles SET ${set} WHERE client_name='Guard Profile Ltd'`), /CREDIT_COLUMN_LOCKED/);
  }
  await throws('anon cannot raise a credit limit either', () => cp('anon', `UPDATE client_profiles SET credit_limit=1 WHERE client_name='Guard Profile Ltd'`), /CREDIT_COLUMN_LOCKED/);
  await cp('authenticated', `UPDATE client_profiles SET notes='called them' WHERE client_name='Guard Profile Ltd'`);
  ok('browser can still edit profile notes', true);
  await cp('authenticated', `INSERT INTO client_profiles (client_name, customer_type, credit_limit) VALUES ('Auto Created Ltd', 'commercial', 0)`);
  ok('browser can auto-create a profile at limit 0 (what the new-order page does)', true);
  await throws('browser cannot create a profile with a limit', () => cp('authenticated', `INSERT INTO client_profiles (client_name, credit_limit) VALUES ('Greedy Ltd', 5000)`), /CREDIT_COLUMN_LOCKED/);
  await throws('browser cannot create a profile with exposure', () => cp('authenticated', `INSERT INTO client_profiles (client_name, current_exposure) VALUES ('Greedy2 Ltd', 1)`), /CREDIT_COLUMN_LOCKED/);
  ok('  …and the real limit was untouched', Number((await one(`SELECT credit_limit l FROM client_profiles WHERE client_name='Guard Profile Ltd'`)).l) === 10000);
  await asRole('service_role', () => db.query(`UPDATE client_profiles SET credit_limit=20000 WHERE client_name='Guard Profile Ltd'`));
  ok('service role (admin API) can set a credit limit', Number((await one(`SELECT credit_limit l FROM client_profiles WHERE client_name='Guard Profile Ltd'`)).l) === 20000);

  // payments
  const pid = await pay(id, 1000);
  await throws('browser cannot insert a payment (fake deposit)', () => cp('authenticated', `INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 99999)`), /PAYMENT_WRITE_LOCKED/);
  await throws('anon cannot insert a payment either', () => cp('anon', `INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 99999)`), /PAYMENT_WRITE_LOCKED/);
  await throws('browser cannot reverse or edit a payment', () => cp('authenticated', `UPDATE order_payments SET reversed_at=now(), amount=1 WHERE id=${pid}`), /PAYMENT_WRITE_LOCKED/);
  await throws('browser cannot delete a payment', () => cp('authenticated', `DELETE FROM order_payments WHERE id=${pid}`), /PAYMENT_WRITE_LOCKED/);
  ok('  …and the payment is intact', Number((await one(`SELECT amount a FROM order_payments WHERE id=$1`, [pid])).a) === 1000);
  await asRole('service_role', () => db.query(`INSERT INTO order_payments (order_id, amount) VALUES ('${id}', 500)`));
  ok('service role (the payments API) can record a payment', true);

  // functions
  await asRole('service_role', async () => {
    const o2 = await mk('retail', '30_day', 'Quote Approved', { client: 'Acme' });
    await approve(o2, 'APR-11');
    ok('advance_order_status works when called as service_role (definer rights)', (await st(o2)) === 'Material Check');
  });
  await asRole('authenticated', async () => {
    await throws('a browser session cannot call advance_order_status', () => adv(id, 'Production'), /permission denied/);
    await throws('a browser session cannot call release_order_credit_exposure', () => db.query(`SELECT release_order_credit_exposure($1)`, [id]), /permission denied/);
    await throws('a browser session cannot call refresh_client_exposure', () => db.query(`SELECT refresh_client_exposure('Acme')`), /permission denied/);
  });
}

// ── 10. Unchanged behaviour ─────────────────────────────────────────────────
{
  const id = await mk('retail', 'cash_before', 'Deposit Paid');
  await throws('same status still refused', () => adv(id, 'Deposit Paid'), /SAME_STATUS/);
  await throws('unknown order still refused', () => adv('00000000-0000-0000-0000-000000000000', 'Material Check'), /ORDER_NOT_FOUND/);
}
{
  for (const fn of ['advance_order_status(uuid,text,uuid,jsonb)', 'release_order_credit_exposure(uuid)', 'refresh_client_exposure(text)', 'client_credit_outstanding(text,uuid)']) {
    const r = await one(`SELECT has_function_privilege('anon','${fn}','EXECUTE') a,
                                has_function_privilege('authenticated','${fn}','EXECUTE') u,
                                has_function_privilege('service_role','${fn}','EXECUTE') s`);
    ok(`only service_role can execute ${fn.split('(')[0]}`, !r.a && !r.u && r.s, JSON.stringify(r));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
