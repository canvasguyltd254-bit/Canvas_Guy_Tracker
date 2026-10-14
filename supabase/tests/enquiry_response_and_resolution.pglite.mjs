// Database tests for
//   supabase/migrations/enquiry_response_control.sql      (reply deadline, first contact)
//   supabase/migrations/web_enquiry_match_resolution.sql  (resolve an ambiguous customer match)
//
// Runs the REAL migrations, after web_form_enquiries.sql, against a minimal stub of the
// CRM tables in an in-process Postgres (pglite).
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/enquiry_response_and_resolution.pglite.mjs
//
// NOT covered: two real concurrent connections. pglite is single-connection, so the
// row locks (FOR UPDATE on the enquiry, then the submission) are verified by reading
// the SQL and by the "second resolve is refused" test, not by a true race.

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
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, phone text, email text);
  CREATE TABLE enquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enq_num text NOT NULL UNIQUE,
    customer_id uuid REFERENCES customers(id), prospect_name text, prospect_contact text,
    source text NOT NULL CHECK (source IN ('whatsapp','email','walk_in','referral','instagram','website','architect')),
    brand text CHECK (brand IN ('canvas_guy','seating_company')),
    category text, description text NOT NULL, estimated_value integer NOT NULL DEFAULT 0,
    assigned_to uuid, stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','quoted','won','lost')),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT needs_customer_or_prospect CHECK (customer_id IS NOT NULL OR prospect_name IS NOT NULL));
  CREATE TABLE quote_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
    activity_type text NOT NULL, description text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid REFERENCES customers(id),
    created_at timestamptz NOT NULL DEFAULT now(), suspended_at timestamptz);
  CREATE SEQUENCE enq_seq;
  CREATE FUNCTION next_enq_num() RETURNS text LANGUAGE sql AS $$ SELECT 'ENQ-2026-' || lpad(nextval('enq_seq')::text, 4, '0') $$;
`);

const dupA = await one(`INSERT INTO customers (name, phone) VALUES ('Dup A','0733-555-222') RETURNING id`);
const dupB = await one(`INSERT INTO customers (name, phone, email) VALUES ('Dup B','+254 733 555 222','b@dup.co.ke') RETURNING id`);
const solo = await one(`INSERT INTO customers (name, phone) VALUES ('Solo Co','0722 000 111') RETURNING id`);
const other = await one(`INSERT INTO customers (name, phone) VALUES ('Unrelated','0799 111 222') RETURNING id`);
const m1 = await one(`INSERT INTO customers (name, email) VALUES ('Mail One','shared@firm.co.ke') RETURNING id`);
const m2 = await one(`INSERT INTO customers (name, email) VALUES ('Mail Two',' SHARED@firm.co.ke') RETURNING id`);

await db.exec(mig('web_form_enquiries.sql'));
await db.exec(mig('enquiry_response_control.sql'));
await db.exec(mig('enquiry_response_control.sql'));   // re-runnable
await db.exec(mig('web_enquiry_match_resolution.sql'));
await db.exec(mig('web_enquiry_match_resolution.sql'));

// ── business_deadline ───────────────────────────────────────────────────────
// Nairobi is UTC+3 all year. 2026-10-14 is a Wednesday.
const dl = async (utc, minutes = 60) => (await one(`SELECT business_deadline($1::timestamptz, $2) AS d`, [utc, minutes])).d.toISOString();
const eq = async (name, utc, expectedUtc, minutes) => {
  const got = await dl(utc, minutes);
  ok(name, got === expectedUtc, `${utc} -> ${got}, expected ${expectedUtc}`);
};
await eq('weekday mid-morning: +1h',                 '2026-10-14T07:00:00Z', '2026-10-14T08:00:00.000Z');   // Wed 10:00 -> 11:00
await eq('arrives exactly at opening (08:00)',       '2026-10-14T05:00:00Z', '2026-10-14T06:00:00.000Z');   // Wed 08:00 -> 09:00
await eq('before opening counts from 08:00',         '2026-10-13T04:15:00Z', '2026-10-13T06:00:00.000Z');   // Tue 07:15 -> 09:00
await eq('after closing rolls to next morning',      '2026-10-14T16:30:00Z', '2026-10-15T06:00:00.000Z');   // Wed 19:30 -> Thu 09:00
await eq('late afternoon spills into next day',      '2026-10-14T14:30:00Z', '2026-10-15T05:30:00.000Z');   // Wed 17:30 -> Thu 08:30
await eq('finishes exactly at closing (18:00)',      '2026-10-14T14:00:00Z', '2026-10-14T15:00:00.000Z');   // Wed 17:00 -> 18:00
await eq('Saturday 17:40 -> Monday 08:40',           '2026-10-17T14:40:00Z', '2026-10-19T05:40:00.000Z');
await eq('Saturday morning is working time',         '2026-10-17T05:00:00Z', '2026-10-17T06:00:00.000Z');   // Sat 08:00 -> 09:00
await eq('Saturday after closing -> Monday 09:00',   '2026-10-17T15:30:00Z', '2026-10-19T06:00:00.000Z');   // Sat 18:30
await eq('Sunday noon -> Monday 09:00',              '2026-10-18T09:00:00Z', '2026-10-19T06:00:00.000Z');
await eq('Sunday late night -> Monday 09:00',        '2026-10-18T20:59:00Z', '2026-10-19T06:00:00.000Z');   // Sun 23:59
await eq('Monday small hours -> Monday 09:00',       '2026-10-18T21:30:00Z', '2026-10-19T06:00:00.000Z');   // Mon 00:30
await eq('Friday 17:59:30 carries 59m30s to Saturday', '2026-10-16T14:59:30Z', '2026-10-17T05:59:30.000Z');  // Sat 08:59:30
await eq('multi-hour target spans days',             '2026-10-17T14:00:00Z', '2026-10-19T08:00:00.000Z', 240); // Sat 17:00 +4h -> Mon 08:00+3h
await throws('negative minutes rejected', () => one(`SELECT business_deadline(now(), -5)`), /BAD_INPUT/);
await throws('null start rejected', () => one(`SELECT business_deadline(NULL, 60)`), /BAD_INPUT/);

// ── reply_due_at is set by the database ─────────────────────────────────────
let n = 0;
const submit = (o = {}) => one(
  `SELECT public.create_enquiry_from_web_form('shopify','tsc.myshopify.com',$1,'seating_company',$2,$3,$4,'Dining','40 dining chairs',$5) AS r`,
  [o.id ?? `sub-${++n}`, o.name ?? 'Jane Wanjiru', o.phone ?? `+2547${String(10000000 + n).slice(0, 8)}`, o.email ?? null, '{}'],
).then(x => x.r);

let r = await submit();
let enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('website enquiry gets a reply deadline automatically', enq.reply_due_at !== null);
ok('deadline equals business_deadline(created_at, 60)',
  (await one(`SELECT (reply_due_at = business_deadline(created_at, 60)) AS same FROM enquiries WHERE id=$1`, [r.enquiry_id])).same === true);
ok('new web enquiry has no first contact', enq.first_contact_at === null && enq.first_contact_method === null);

const mail = await one(`INSERT INTO enquiries (enq_num, prospect_name, source, description) VALUES ('ENQ-X1','Someone','email','Quote please') RETURNING *`);
ok('non-website enquiry gets no reply clock', mail.reply_due_at === null);

// ── mark_enquiry_contacted ──────────────────────────────────────────────────
const contact = (id, method = 'whatsapp', note = null, user = U1) =>
  one(`SELECT mark_enquiry_contacted($1,$2,$3,$4) AS r`, [id, method, note, user]).then(x => x.r);

// A stage edit is NOT contact.
await db.query(`UPDATE enquiries SET stage='contacted' WHERE id=$1`, [r.enquiry_id]);
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('editing the stage does not record first contact', enq.first_contact_at === null);
await db.query(`UPDATE enquiries SET stage='new' WHERE id=$1`, [r.enquiry_id]);

let c = await contact(r.enquiry_id, 'WhatsApp', '  Called back, wants swatches  ');
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('first contact is recorded with who, when and how',
  c.already === false && enq.first_contact_at !== null && enq.first_contact_by === U1 && enq.first_contact_method === 'whatsapp', JSON.stringify(c));
ok('a New enquiry moves to Contacted', enq.stage === 'contacted' && c.stage === 'contacted');
let act = await all(`SELECT * FROM quote_activities WHERE entity_id=$1 AND activity_type='contact_logged'`, [r.enquiry_id]);
ok('one audit row with method, trimmed note and user',
  act.length === 1 && act[0].created_by === U1 && /WhatsApp/.test(act[0].description) && /Called back, wants swatches/.test(act[0].description) && /new -> contacted/.test(act[0].description), JSON.stringify(act));

const again = await contact(r.enquiry_id, 'call', 'second person', U2);
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('second logger is told it is already contacted and nothing changes',
  again.already === true && enq.first_contact_by === U1 && enq.first_contact_method === 'whatsapp'
  && (await all(`SELECT 1 FROM quote_activities WHERE entity_id=$1 AND activity_type='contact_logged'`, [r.enquiry_id])).length === 1, JSON.stringify(again));

// A quote was started from a New enquiry, but nobody has spoken to the customer yet.
r = await submit();
await db.query(`UPDATE enquiries SET stage='quoted' WHERE id=$1`, [r.enquiry_id]);
c = await contact(r.enquiry_id, 'call');
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('first contact can still be logged on a Quoted enquiry, stage unchanged', c.already === false && enq.stage === 'quoted' && enq.first_contact_at !== null);
ok('Quoted-stage audit row has no stage-change text',
  !/->/.test((await one(`SELECT description FROM quote_activities WHERE entity_id=$1 AND activity_type='contact_logged'`, [r.enquiry_id])).description));

r = await submit();
await db.query(`UPDATE enquiries SET stage='lost' WHERE id=$1`, [r.enquiry_id]);
await throws('closed (lost) enquiry cannot get first contact', () => contact(r.enquiry_id), /ENQUIRY_CLOSED/);
await throws('unknown method rejected', async () => { const x = await submit(); return contact(x.enquiry_id, 'carrier-pigeon'); }, /BAD_METHOD/);
await throws('blank method rejected', async () => { const x = await submit(); return contact(x.enquiry_id, '  '); }, /BAD_METHOD/);
await throws('unknown enquiry rejected', () => contact('00000000-0000-0000-0000-000000000000'), /ENQUIRY_NOT_FOUND/);

// Atomic: if the audit insert fails, the contact must not stick.
const atom = await submit();
await db.exec(`ALTER TABLE quote_activities ADD CONSTRAINT block_contact CHECK (activity_type <> 'contact_logged') NOT VALID`);
await throws('failing audit insert raises', () => contact(atom.enquiry_id), /block_contact|check/i);
await db.exec(`ALTER TABLE quote_activities DROP CONSTRAINT block_contact`);
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [atom.enquiry_id]);
ok('rollback: no first contact and stage still New', enq.first_contact_at === null && enq.stage === 'new' && enq.first_contact_by === null);

// Table-level guard: contact fields come together.
await throws('first_contact_at without a method is refused',
  () => db.query(`UPDATE enquiries SET first_contact_at = now() WHERE id=$1`, [atom.enquiry_id]), /first_contact_complete|check/i);

// ── match resolution ────────────────────────────────────────────────────────
const amb = await submit({ phone: '+254733555222', name: 'Brian Otieno', email: null });
ok('setup: shared phone is flagged ambiguous', amb.match_status === 'ambiguous', JSON.stringify(amb));

await db.query(`INSERT INTO orders (customer_id, created_at) VALUES ($1,'2026-03-01'),($1,'2026-08-15'),($1,'2026-09-30')`, [dupB.id]);
await db.query(`UPDATE orders SET suspended_at = now() WHERE customer_id = $1 AND created_at = '2026-09-30'`, [dupB.id]);
const cands = await all(`SELECT * FROM web_enquiry_candidates($1)`, [amb.enquiry_id]);
const cB = cands.find(x => x.name === 'Dup B'), cA = cands.find(x => x.name === 'Dup A');
ok('candidate order_count ignores suspended orders', cB && cB.order_count === 2, JSON.stringify(cB));
ok('candidate last_order_at is the latest non-suspended order', cB && new Date(cB.last_order_at).getTime() === new Date((await one(`SELECT '2026-08-15'::timestamptz AS t`)).t).getTime(), JSON.stringify(cB));
ok('candidate with no orders: 0 and null', cA && cA.order_count === 0 && cA.last_order_at === null, JSON.stringify(cA));
ok('candidates are exactly the customers sharing the phone', cands.length === 2 && cands.map(x => x.name).sort().join() === 'Dup A,Dup B', JSON.stringify(cands));
ok('candidates of an unknown enquiry: none', (await all(`SELECT * FROM web_enquiry_candidates('00000000-0000-0000-0000-000000000000')`)).length === 0);

const resolve = (id, action, cust = null, user = U1) =>
  one(`SELECT resolve_web_enquiry_customer($1,$2,$3,$4) AS r`, [id, action, cust, user]).then(x => x.r);

await throws('bad action rejected', () => resolve(amb.enquiry_id, 'merge'), /BAD_ACTION/);
await throws('link without a customer rejected', () => resolve(amb.enquiry_id, 'link', null), /CUSTOMER_REQUIRED/);
await throws('customer that does not match the contact is refused', () => resolve(amb.enquiry_id, 'link', other.id), /CUSTOMER_NOT_CANDIDATE/);
await throws('customer that does not exist is refused', () => resolve(amb.enquiry_id, 'link', '00000000-0000-0000-0000-000000000000'), /CUSTOMER_NOT_CANDIDATE/);
ok('refused attempts changed nothing',
  (await one(`SELECT customer_id, prospect_name FROM enquiries WHERE id=$1`, [amb.enquiry_id])).customer_id === null
  && (await one(`SELECT match_status FROM web_form_submissions WHERE enquiry_id=$1`, [amb.enquiry_id])).match_status === 'ambiguous');

// Atomic: audit insert fails -> neither the enquiry nor the submission may change.
await db.exec(`ALTER TABLE quote_activities ADD CONSTRAINT block_resolve CHECK (activity_type <> 'customer_resolved') NOT VALID`);
await throws('failing audit insert raises', () => resolve(amb.enquiry_id, 'link', dupB.id), /block_resolve|check/i);
await db.exec(`ALTER TABLE quote_activities DROP CONSTRAINT block_resolve`);
ok('rollback: enquiry and submission untouched',
  (await one(`SELECT customer_id FROM enquiries WHERE id=$1`, [amb.enquiry_id])).customer_id === null
  && (await one(`SELECT match_status, resolved_at FROM web_form_submissions WHERE enquiry_id=$1`, [amb.enquiry_id])).match_status === 'ambiguous');

const res = await resolve(amb.enquiry_id, 'link', dupB.id, U1);
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [amb.enquiry_id]);
let sub = await one(`SELECT * FROM web_form_submissions WHERE enquiry_id=$1`, [amb.enquiry_id]);
ok('link: enquiry now belongs to the customer, prospect fields cleared',
  enq.customer_id === dupB.id && enq.prospect_name === null && enq.prospect_contact === null && res.match_status === 'manually_linked', JSON.stringify(res));
ok('link: submission records status, time and person',
  sub.match_status === 'manually_linked' && sub.resolved_at !== null && sub.resolved_by === U1);
act = await all(`SELECT * FROM quote_activities WHERE entity_id=$1 AND activity_type='customer_resolved'`, [amb.enquiry_id]);
ok('link: audit keeps the customer name AND the original website contact',
  act.length === 1 && act[0].created_by === U1 && /Dup B/.test(act[0].description) && /Brian Otieno/.test(act[0].description) && /254733555222/.test(act[0].description), JSON.stringify(act));

await throws('second person resolving differently is refused', () => resolve(amb.enquiry_id, 'link', dupA.id, U2), /ALREADY_RESOLVED/);
await throws('second person choosing keep-as-prospect is refused too', () => resolve(amb.enquiry_id, 'keep_prospect', null, U2), /ALREADY_RESOLVED/);
ok('the first decision stands',
  (await one(`SELECT customer_id FROM enquiries WHERE id=$1`, [amb.enquiry_id])).customer_id === dupB.id);

const amb2 = await submit({ phone: '+254733555222', name: 'Keep Me', email: null });
const kept = await resolve(amb2.enquiry_id, 'keep_prospect', null, U2);
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [amb2.enquiry_id]);
sub = await one(`SELECT * FROM web_form_submissions WHERE enquiry_id=$1`, [amb2.enquiry_id]);
ok('keep: stays a prospect with its name and contact',
  kept.match_status === 'kept_as_prospect' && enq.customer_id === null && enq.prospect_name === 'Keep Me' && /254733555222/.test(enq.prospect_contact));
ok('keep: submission records status, time and person', sub.match_status === 'kept_as_prospect' && sub.resolved_at !== null && sub.resolved_by === U2);
await throws('a kept prospect cannot be re-resolved', () => resolve(amb2.enquiry_id, 'link', dupA.id), /ALREADY_RESOLVED/);

// Email-based ambiguity.
const ambMail = await submit({ phone: '+254700000777', name: 'Mail Lead', email: 'Shared@Firm.co.ke' });
ok('setup: shared email is flagged ambiguous', ambMail.match_status === 'ambiguous', JSON.stringify(ambMail));
const mc = await all(`SELECT name FROM web_enquiry_candidates($1) ORDER BY name`, [ambMail.enquiry_id]);
ok('email candidates found case/space-insensitively', mc.map(x => x.name).join() === 'Mail One,Mail Two', JSON.stringify(mc));
await resolve(ambMail.enquiry_id, 'link', m2.id);
ok('linking from the email candidate list works', (await one(`SELECT customer_id FROM enquiries WHERE id=$1`, [ambMail.enquiry_id])).customer_id === m2.id);

// Enquiries that were never ambiguous.
const auto = await submit({ phone: '+254722000111', name: 'Auto Match' });
ok('setup: single match linked automatically', auto.match_status === 'matched_phone');
await throws('an automatically matched enquiry is not resolvable', () => resolve(auto.enquiry_id, 'link', solo.id), /ALREADY_RESOLVED|NOT_AMBIGUOUS/);
const fresh = await submit({ phone: '+254700555321', name: 'Nobody' });
await throws('a new-prospect enquiry is not resolvable', () => resolve(fresh.enquiry_id, 'keep_prospect'), /NOT_AMBIGUOUS/);
await throws('a non-website enquiry is rejected', () => resolve(mail.id, 'keep_prospect'), /NOT_WEB_ENQUIRY/);
await throws('an unknown enquiry is rejected', () => resolve('00000000-0000-0000-0000-000000000000', 'keep_prospect'), /ENQUIRY_NOT_FOUND/);

// ── table guards ────────────────────────────────────────────────────────────
await throws('a manual status without resolved_at is refused',
  () => db.query(`UPDATE web_form_submissions SET match_status='manually_linked' WHERE enquiry_id=$1`, [fresh.enquiry_id]), /resolution_complete|check/i);
await throws('resolved_at on an automatic status is refused',
  () => db.query(`UPDATE web_form_submissions SET resolved_at=now() WHERE enquiry_id=$1`, [fresh.enquiry_id]), /resolution_complete|check/i);
await throws('unknown status is refused',
  () => db.query(`UPDATE web_form_submissions SET match_status='whatever' WHERE enquiry_id=$1`, [fresh.enquiry_id]), /match_status_known|check/i);

// ── privileges ──────────────────────────────────────────────────────────────
const fns = [
  'public.business_deadline(timestamptz,integer)',
  'public.mark_enquiry_contacted(uuid,text,text,uuid)',
  'public.web_enquiry_candidates(uuid)',
  'public.resolve_web_enquiry_customer(uuid,text,uuid,uuid)',
];
for (const f of fns) {
  const p = Object.fromEntries((await all(
    `SELECT r, has_function_privilege(r, '${f}', 'EXECUTE') AS can FROM (VALUES ('anon'),('authenticated'),('service_role')) v(r)`)).map(x => [x.r, x.can]));
  ok(`${f.split('(')[0]} executable by service_role only`, p.service_role && !p.anon && !p.authenticated, JSON.stringify(p));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
