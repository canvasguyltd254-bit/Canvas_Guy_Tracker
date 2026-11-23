// Database tests for supabase/migrations/invoice_posted_item_edit.sql
//
// Runs the REAL order_items_atomic_edit_audit.sql (the old edit function), the REAL post_journal_entry
// from accounting_foundation.sql, then the new migration, against an in-process Postgres (pglite)
// with minimal stubs for orders / order_items / journal tables.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/invoice_posted_item_edit.pglite.mjs
//
// NOT covered: concurrent connections; the API's admin-only decision (tested in the route harness);
// the real invoice-posting functions (their journal shape is reproduced by hand below).

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
const num = v => Number(v);

// Real post_journal_entry, lifted from accounting_foundation.sql
const af = mig('accounting_foundation.sql');
const pj0 = af.indexOf('CREATE OR REPLACE FUNCTION post_journal_entry(');
const postJournalFn = af.slice(pj0, af.indexOf('$$;', pj0) + 3);

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_num text, invoice_number text, pricing_mode text DEFAULT 'vat_inclusive', tax_status text DEFAULT 'taxable',
    subtotal_amount numeric(14,2), vat_amount numeric(14,2), total_value numeric(14,2),
    invoice_journal_entry_id uuid
  );
  CREATE TABLE order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
    category text, description text, quantity integer, size text, finish_type text, finish_color text, wood_type text,
    unit_price numeric, sort_order integer DEFAULT 0, line_type text, tax_treatment text DEFAULT 'standard',
    vat_rate numeric, net_amount numeric, vat_amount numeric, gross_amount numeric, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE order_payments (id serial PRIMARY KEY, order_id uuid, amount numeric, reversed_at timestamptz);
  CREATE TABLE order_activities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, activity_type text NOT NULL,
    description text NOT NULL, created_at timestamptz DEFAULT now(), created_by uuid);
  CREATE TABLE accounting_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text UNIQUE, name text);
  CREATE TABLE journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_date date, description text,
    source_type text NOT NULL, source_id uuid, posted_by uuid, status text NOT NULL DEFAULT 'active', posted_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX idx_journal_entries_active_source ON journal_entries (source_type, source_id) WHERE status = 'active';
  CREATE TABLE journal_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_entry_id uuid REFERENCES journal_entries(id),
    account_id uuid REFERENCES accounting_accounts(id), amount numeric NOT NULL, description text);
  INSERT INTO accounting_accounts (code, name) VALUES ('1100','Accounts Receivable'),('2010','VAT Payable'),
    ('4000','Direct Sales'),('4600','Delivery & Installation'),('4700','Design Services'),('4990','Other Income');
`);
await db.exec(postJournalFn);
await db.exec(`GRANT EXECUTE ON FUNCTION post_journal_entry(date,text,text,uuid,uuid,jsonb) TO service_role;`);

await db.exec(mig('order_items_atomic_edit_audit.sql'));
ok('old edit migration applies', true);

const USER = '11111111-1111-1111-1111-111111111111';
const acct = async code => (await one(`SELECT id FROM accounting_accounts WHERE code=$1`, [code])).id;

// An invoice posted the way post_credit_order_invoice posts it: DR AR gross / CR revenue / CR VAT.
async function postedOrder({ qty = 20, unit = 22000, extraLines = [] } = {}) {
  const gross = qty * unit, net = Math.round(gross / 1.16 * 100) / 100, vat = Math.round((gross - net) * 100) / 100;
  const o = (await one(`INSERT INTO orders (order_num, subtotal_amount, vat_amount, total_value)
                        VALUES ('ORD-' || floor(random()*1e9)::text, $1, $2, $3) RETURNING id`, [net, vat, gross])).id;
  const item = (await one(`INSERT INTO order_items (order_id, category, description, quantity, unit_price, line_type, vat_rate, net_amount, vat_amount, gross_amount)
                           VALUES ($1,'Mirrors','Minimal Mirror 1800 x 900mm',$2,$3,'product',0.16,$4,$5,$6) RETURNING id`, [o, qty, unit, net, vat, gross])).id;
  const lines = [
    { account_id: await acct('1100'), amount: gross },
    { account_id: await acct('4000'), amount: -net },
    { account_id: await acct('2010'), amount: -vat },
  ];
  const j = (await one(`SELECT post_journal_entry(CURRENT_DATE,'Credit customer invoice','order_invoice',$1,$2,$3::jsonb) j`, [o, USER, JSON.stringify(lines)])).j;
  await db.query(`UPDATE orders SET invoice_journal_entry_id=$2, invoice_number='INV-2026-0013' WHERE id=$1`, [o, j]);
  return { order: o, item, journal: j, gross, net, vat };
}
const edit = (order, items, deleted = [], reason = 'Only 19 delivered', allow = true) =>
  db.query(`SELECT update_order_items_with_audit($1, $2::jsonb, $3::uuid[], $4, $5, $6) r`,
    [order, JSON.stringify(items), deleted, reason, USER, allow]);
const mirrors = (id, quantity, unit_price = 22000) => ({ id, category: 'Mirrors', description: 'Minimal Mirror 1800 x 900mm', quantity, unit_price });
// Net position of the ledger for one order's invoice (original + corrections), per account code.
const ledger = async order => {
  const r = await db.query(`
    SELECT a.code, COALESCE(SUM(jl.amount),0) amt
    FROM journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id
    WHERE jl.journal_entry_id IN (
      SELECT invoice_journal_entry_id FROM orders WHERE id=$1
      UNION SELECT journal_entry_id FROM order_invoice_corrections WHERE order_id=$1)
    GROUP BY a.code`, [order]);
  return Object.fromEntries(r.rows.map(x => [x.code, num(x.amt)]));
};
const near = (a, b) => Math.abs(a - b) < 0.011;
const totals = async o => { const t = await one(`SELECT total_value, subtotal_amount, vat_amount FROM orders WHERE id=$1`, [o]); return { total: num(t.total_value), net: num(t.subtotal_amount), vat: num(t.vat_amount) }; };

await db.exec(mig('invoice_posted_item_edit.sql'));
ok('migration applies on top of the old edit function', true);
await db.exec(mig('invoice_posted_item_edit.sql'));
ok('migration is re-runnable', true);
{
  const n = await one(`SELECT count(*) c FROM pg_proc WHERE proname = 'update_order_items_with_audit'`);
  ok('exactly one update_order_items_with_audit exists (the old 5-argument one is gone)', num(n.c) === 1, JSON.stringify(n));
}

// ── 1. Not admin: still refused ─────────────────────────────────────────────
{
  const p = await postedOrder();
  await throws('without the admin switch a posted invoice cannot be changed (INVOICE_POSTED)', () => edit(p.order, [mirrors(p.item, 19)], [], 'x', false), /INVOICE_POSTED/);
  ok('  …items and totals untouched', (await totals(p.order)).total === 440000
    && num((await one(`SELECT quantity q FROM order_items WHERE id=$1`, [p.item])).q) === 20);
  const c = await one(`SELECT count(*) c FROM order_invoice_corrections WHERE order_id=$1`, [p.order]);
  ok('  …and no correction was recorded, ledger unchanged', num(c.c) === 0 && near((await ledger(p.order))['1100'], 440000));
  await db.query(`SELECT update_order_items_with_audit($1,$2::jsonb,$3::uuid[],$4,$5)`, [p.order, JSON.stringify([mirrors(p.item, 19)]), [], 'x', USER]).then(
    () => ok('the old 5-argument call is still refused on a posted invoice (the switch defaults to off)', false),
    e => ok('the old 5-argument call is still refused on a posted invoice (the switch defaults to off)', /INVOICE_POSTED/.test(e.message), e.message));
  // non-financial edit stays allowed for everyone
  await edit(p.order, [{ ...mirrors(p.item, 20), description: 'Minimal Mirror 1800 x 900mm, white oak' }], [], null, false);
  ok('a wording-only change on a posted invoice is still allowed without the switch', true);
}

// ── 2. Admin: 20 → 19 (the real case) ───────────────────────────────────────
{
  const p = await postedOrder();
  const before = await db.query(`SELECT a.code, jl.amount FROM journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id WHERE journal_entry_id=$1 ORDER BY a.code`, [p.journal]);
  const r = (await edit(p.order, [mirrors(p.item, 19)])).rows[0].r;
  const t = await totals(p.order);
  ok('quantity 20 → 19: order total becomes 418,000 (19 × 22,000)', t.total === 418000, JSON.stringify(t));
  ok('  …net + VAT = gross', near(t.net + t.vat, 418000));
  ok('a correcting journal is returned and recorded', !!r.invoice_correction_journal_id);

  const corr = await one(`SELECT * FROM order_invoice_corrections WHERE order_id=$1`, [p.order]);
  ok('correction row links the edit to its journal, with the gross change and reason',
    corr.journal_entry_id === r.invoice_correction_journal_id && num(corr.gross_delta) === -22000 && corr.reason === 'Only 19 delivered', JSON.stringify(corr));

  const lines = await db.query(`SELECT a.code, jl.amount FROM journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id WHERE journal_entry_id=$1`, [r.invoice_correction_journal_id]);
  const byCode = Object.fromEntries(lines.rows.map(x => [x.code, num(x.amount)]));
  ok('correction credits receivables by the 22,000 reduction', near(byCode['1100'], -22000), JSON.stringify(byCode));
  ok('correction debits sales and VAT (revenue and VAT go down)', byCode['4000'] > 0 && byCode['2010'] > 0, JSON.stringify(byCode));
  ok('correction journal balances to zero', near(lines.rows.reduce((s, x) => s + num(x.amount), 0), 0));

  const after = await db.query(`SELECT a.code, jl.amount FROM journal_lines jl JOIN accounting_accounts a ON a.id=jl.account_id WHERE journal_entry_id=$1 ORDER BY a.code`, [p.journal]);
  ok('the ORIGINAL invoice journal is untouched (same lines, still active)', JSON.stringify(before.rows) === JSON.stringify(after.rows)
    && (await one(`SELECT status s FROM journal_entries WHERE id=$1`, [p.journal])).s === 'active');
  const L = await ledger(p.order);
  ok('ledger for the invoice now equals the new items: receivable 418,000', near(L['1100'], 418000), JSON.stringify(L));
  ok('  …revenue + VAT equal the new items', near(-L['4000'], t.net) && near(-L['2010'], t.vat), JSON.stringify({ L, t }));

  const adj = await one(`SELECT * FROM order_item_adjustments WHERE order_id=$1`, [p.order]);
  ok('the edit is audited: gross delta −22,000, posted-invoice flag, reason, who', num(adj.gross_delta) === -22000 && adj.was_invoice_posted === true
    && adj.reason === 'Only 19 delivered' && adj.created_by === USER, JSON.stringify(adj));
  const act = await one(`SELECT description FROM order_activities WHERE order_id=$1 AND activity_type='invoice_corrected'`, [p.order]);
  ok('an Activity entry records the correction, amount and reason', /INV-2026-0013/.test(act.description) && /22,000\.00/.test(act.description) && /Only 19 delivered/.test(act.description), act?.description);
  ok('the invoice number is unchanged', (await one(`SELECT invoice_number n FROM orders WHERE id=$1`, [p.order])).n === 'INV-2026-0013');
}

// ── 3. Repeated edits stay consistent ───────────────────────────────────────
{
  const p = await postedOrder();
  await edit(p.order, [mirrors(p.item, 19)], [], 'first');
  await edit(p.order, [mirrors(p.item, 18)], [], 'second');
  let L = await ledger(p.order);
  ok('second edit 19 → 18: ledger receivable 396,000', near(L['1100'], 396000), JSON.stringify(L));
  await edit(p.order, [mirrors(p.item, 20)], [], 'put back');
  L = await ledger(p.order);
  const t = await totals(p.order);
  ok('editing back to 20 returns the ledger to the original 440,000', near(L['1100'], 440000) && near(-L['4000'], t.net) && near(-L['2010'], t.vat), JSON.stringify(L));
  const n = await one(`SELECT count(*) c FROM order_invoice_corrections WHERE order_id=$1`, [p.order]);
  ok('three edits → three correction journals, each with its own event', num(n.c) === 3);
  const price = await edit(p.order, [mirrors(p.item, 20, 20000)], [], 'price correction');
  ok('a unit price change is corrected too (20 × 20,000 = 400,000)', near((await ledger(p.order))['1100'], 400000) && (await totals(p.order)).total === 400000);
}

// ── 4. Charges and added lines hit the right accounts ───────────────────────
{
  const p = await postedOrder();
  await edit(p.order, [mirrors(p.item, 20), { category: 'Delivery Fee', description: 'Delivery', quantity: 1, unit_price: 5800 }], [], 'add delivery');
  const L = await ledger(p.order);
  ok('adding a Delivery Fee of 5,800 raises receivable to 445,800', near(L['1100'], 445800), JSON.stringify(L));
  ok('  …and credits Delivery & Installation (4600) with its net (5,000)', near(-L['4600'], 5000), JSON.stringify(L));
  const del = (await db.query(`SELECT id FROM order_items WHERE order_id=$1 AND category='Delivery Fee'`, [p.order])).rows[0].id;
  await edit(p.order, [], [del], 'remove delivery');
  const L2 = await ledger(p.order);
  ok('removing it again returns to 440,000 with nothing left on 4600', near(L2['1100'], 440000) && near(L2['4600'] || 0, 0), JSON.stringify(L2));
}

// ── 5. Guards ───────────────────────────────────────────────────────────────
{
  const p = await postedOrder();
  await throws('a reason is required for a financial change', () => edit(p.order, [mirrors(p.item, 19)], [], '   '), /REASON_REQUIRED/);
  await db.query(`INSERT INTO order_payments (order_id, amount) VALUES ($1, 400000)`, [p.order]);
  await throws('the total cannot drop below payments already received (396,000 < 400,000)', () => edit(p.order, [mirrors(p.item, 18)], [], 'too low'), /TOTAL_BELOW_PAYMENTS/);
  const c = await one(`SELECT count(*) c FROM order_invoice_corrections WHERE order_id=$1`, [p.order]);
  ok('  …and the refused edit left nothing behind (quantity, total, no correction, no audit row)',
    num(c.c) === 0 && (await totals(p.order)).total === 440000
    && num((await one(`SELECT quantity q FROM order_items WHERE id=$1`, [p.item])).q) === 20
    && num((await one(`SELECT count(*) c FROM order_item_adjustments WHERE order_id=$1`, [p.order])).c) === 0);
  await edit(p.order, [mirrors(p.item, 19)], [], 'still above payments');
  ok('an edit that stays above payments is fine (418,000 ≥ 400,000)', (await totals(p.order)).total === 418000);
}
{
  // Items that do not add up (net + VAT ≠ gross on a line the edit does not touch) must not post a bad journal.
  const p = await postedOrder();
  const other = (await one(`INSERT INTO order_items (order_id, category, description, quantity, unit_price, line_type, vat_rate, net_amount, vat_amount, gross_amount)
                            VALUES ($1,'Mirrors','Odd legacy line',1,1000,'product',0.16,800,100,1000) RETURNING id`, [p.order])).id;   // 800 + 100 ≠ 1000
  await db.query(`UPDATE orders SET total_value = total_value + 1000 WHERE id=$1`, [p.order]);
  await throws('items that do not add up make the correction fail UNBALANCED (nothing half-posted)', () => edit(p.order, [mirrors(p.item, 19)], [], 'try'), /UNBALANCED_JOURNAL/);
  ok('  …the whole edit rolled back (quantity still 20, no correction row)',
    num((await one(`SELECT quantity q FROM order_items WHERE id=$1`, [p.item])).q) === 20
    && num((await one(`SELECT count(*) c FROM order_invoice_corrections WHERE order_id=$1`, [p.order])).c) === 0);
}

// ── 6. Not-yet-invoiced orders behave exactly as before ─────────────────────
{
  const o = (await one(`INSERT INTO orders (order_num, total_value) VALUES ('ORD-NOINV', 100000) RETURNING id`)).id;
  const it = (await one(`INSERT INTO order_items (order_id, category, description, quantity, unit_price, line_type, vat_rate, net_amount, vat_amount, gross_amount)
                         VALUES ($1,'Mirrors','Mirror',10,10000,'product',0.16,86206.9,13793.1,100000) RETURNING id`, [o])).id;
  const j0 = num((await one(`SELECT count(*) c FROM journal_entries`)).c);
  const r = (await edit(o, [mirrors(it, 9, 10000)], [], 'before invoicing', true)).rows[0].r;
  ok('unposted order edited with the admin switch on: edit applies, NO correction journal', (await totals(o)).total === 90000
    && r.invoice_correction_journal_id === null && num((await one(`SELECT count(*) c FROM journal_entries`)).c) === j0);
}

// ── 7. Privileges ───────────────────────────────────────────────────────────
{
  for (const fn of ['update_order_items_with_audit(uuid,jsonb,uuid[],text,uuid,boolean)', 'post_invoice_correction(uuid,uuid,text,uuid)']) {
    const r = await one(`SELECT has_function_privilege('anon','${fn}','EXECUTE') a, has_function_privilege('authenticated','${fn}','EXECUTE') u,
                                has_function_privilege('service_role','${fn}','EXECUTE') s`);
    ok(`only service_role can execute ${fn.split('(')[0]}`, !r.a && !r.u && r.s, JSON.stringify(r));
  }
  const t = await one(`SELECT has_table_privilege('authenticated','order_invoice_corrections','SELECT') s, has_table_privilege('service_role','order_invoice_corrections','UPDATE') u`);
  ok('corrections table: not readable by browsers, and append-only even for service_role', !t.s && !t.u, JSON.stringify(t));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
