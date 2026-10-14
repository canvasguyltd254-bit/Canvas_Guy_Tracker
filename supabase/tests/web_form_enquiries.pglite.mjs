// Database tests for supabase/migrations/web_form_enquiries.sql
//
// Runs the REAL migration against a minimal stub of customers / enquiries /
// quote_activities in an in-process Postgres (pglite). Covers de-duplication,
// customer matching, rate limiting, input validation and transactional rollback.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   node supabase/tests/web_form_enquiries.pglite.mjs   (PGLITE_DIR=/tmp/pg if needed)
//
// NOT covered (needs staging): the App Proxy signature against a live Shopify store,
// the HTTP route, Vercel env vars.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../migrations/web_form_enquiries.sql'), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const throws = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;

let n = 0;
const submit = (o = {}) => one(
  `SELECT public.create_enquiry_from_web_form($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r`,
  [o.provider ?? 'shopify', o.shop ?? 'tsc.myshopify.com', o.id ?? `sub-${++n}`, o.brand ?? 'seating_company',
   o.name ?? 'Jane Wanjiru', o.phone === undefined ? `+2547${String(10000000 + n).slice(0, 8)}` : o.phone,
   o.email === undefined ? null : o.email, o.category ?? 'Dining',
   o.description === undefined ? '40 dining chairs' : o.description, JSON.stringify(o.payload ?? { quantity: 40 })],
).then(x => x.r);

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, phone text, email text);
  CREATE TABLE enquiries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), enq_num text NOT NULL UNIQUE,
    customer_id uuid REFERENCES customers(id), prospect_name text, prospect_contact text,
    source text NOT NULL CHECK (source IN ('whatsapp','email','walk_in','referral','instagram','website','architect')),
    brand text CHECK (brand IN ('canvas_guy','seating_company')),
    category text, description text NOT NULL, estimated_value integer NOT NULL DEFAULT 0,
    assigned_to uuid, stage text NOT NULL DEFAULT 'new', created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT needs_customer_or_prospect CHECK (customer_id IS NOT NULL OR prospect_name IS NOT NULL));
  CREATE TABLE quote_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
    activity_type text NOT NULL, description text NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
  CREATE SEQUENCE enq_seq;
  CREATE FUNCTION next_enq_num() RETURNS text LANGUAGE sql AS $$ SELECT 'ENQ-2026-' || lpad(nextval('enq_seq')::text, 4, '0') $$;
`);

const cust1 = await one(`INSERT INTO customers (name, phone, email) VALUES ('Existing Co','0722 000 111','existing@co.ke') RETURNING id`);
const dupA = await one(`INSERT INTO customers (name, phone) VALUES ('Dup A','0733-555-222') RETURNING id`);
await db.query(`INSERT INTO customers (name, phone) VALUES ('Dup B','+254 733 555 222')`);
const byMail = await one(`INSERT INTO customers (name, email) VALUES ('Mail Only','Buyer@Firm.co.ke') RETURNING id`);

await db.exec(migration);
await db.exec(migration);   // re-runnable

// ── creation ────────────────────────────────────────────────────────────────
let r = await submit({ id: 'a1', name: 'New Person', phone: '+254700123456', email: 'new@x.com', category: 'Lounge' });
ok('new submission creates an enquiry with a number', r.duplicate === false && /^ENQ-2026-\d{4}$/.test(r.enq_num), JSON.stringify(r));
ok('new prospect status', r.match_status === 'new_prospect');
let enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('enquiry: website source, seating_company brand, stage new', enq.source === 'website' && enq.brand === 'seating_company' && enq.stage === 'new');
ok('enquiry: prospect name + contact kept, no customer', enq.prospect_name === 'New Person' && enq.prospect_contact === '+254700123456 · new@x.com' && enq.customer_id === null, JSON.stringify(enq));
ok('enquiry: category and description stored', enq.category === 'Lounge' && enq.description === '40 dining chairs');
const act = await all(`SELECT * FROM quote_activities WHERE entity_id=$1`, [r.enquiry_id]);
ok('one history row, created_by NULL', act.length === 1 && act[0].activity_type === 'created' && act[0].created_by === null && /website form/.test(act[0].description), JSON.stringify(act));
ok('submission row links to the enquiry', (await one(`SELECT enquiry_id FROM web_form_submissions WHERE external_id='a1'`)).enquiry_id === r.enquiry_id);

// ── idempotency ─────────────────────────────────────────────────────────────
const again = await submit({ id: 'a1', name: 'New Person' });
ok('retry returns the same enquiry flagged duplicate', again.duplicate === true && again.enquiry_id === r.enquiry_id && again.enq_num === r.enq_num, JSON.stringify(again));
ok('retry creates no second enquiry or history row',
  +(await one(`SELECT count(*) c FROM enquiries`)).c === 1 && +(await one(`SELECT count(*) c FROM quote_activities`)).c === 1);
const otherShop = await submit({ id: 'a1', shop: 'other.myshopify.com', phone: '+254700999888' });
ok('same id on a different shop is a different submission', otherShop.duplicate === false);

// ── customer matching ───────────────────────────────────────────────────────
r = await submit({ phone: '+254722000111', name: 'Someone Else' });
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('phone match (different formatting) links the existing customer', r.match_status === 'matched_phone' && enq.customer_id === cust1.id && enq.prospect_name === null, JSON.stringify(r));
r = await submit({ phone: '+254711000999', email: ' BUYER@firm.co.ke ' });
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('email match (case/space insensitive) links the customer', r.match_status === 'matched_email' && enq.customer_id === byMail.id, JSON.stringify(r));
r = await submit({ phone: '+254733555222', name: 'Ambiguous Caller' });
enq = await one(`SELECT * FROM enquiries WHERE id=$1`, [r.enquiry_id]);
ok('two customers share the phone: NOT merged, flagged ambiguous', r.match_status === 'ambiguous' && enq.customer_id === null && enq.prospect_name === 'Ambiguous Caller', JSON.stringify(r));
ok('ambiguous history row says to check', /check before linking/.test((await one(`SELECT description FROM quote_activities WHERE entity_id=$1`, [r.enquiry_id])).description));
ok('phone wins over email when both would match', (await submit({ phone: '+254722000111', email: 'buyer@firm.co.ke' })).match_status === 'matched_phone');

// ── validation ──────────────────────────────────────────────────────────────
await throws('unknown provider → BAD_INPUT', () => submit({ provider: 'wix' }), /BAD_INPUT/);
await throws('unknown brand → BAD_INPUT', () => submit({ brand: 'acme' }), /BAD_INPUT/);
await throws('blank name → BAD_INPUT', () => submit({ name: '   ' }), /BAD_INPUT/);
await throws('blank description → BAD_INPUT', () => submit({ description: '' }), /BAD_INPUT/);
await throws('blank external id → BAD_INPUT', () => submit({ id: '' }), /BAD_INPUT/);

// ── atomic rollback ─────────────────────────────────────────────────────────
// brand passes the RPC check but we break the enquiries insert by dropping the
// sequence function's target; everything the function did must roll back.
const before = { s: +(await one(`SELECT count(*) c FROM web_form_submissions`)).c, e: +(await one(`SELECT count(*) c FROM enquiries`)).c };
await db.exec(`ALTER TABLE enquiries ADD CONSTRAINT force_fail CHECK (category IS DISTINCT FROM 'EXPLODE')`);
await throws('a failing insert raises', () => submit({ id: 'boom', category: 'EXPLODE', phone: '+254700555000' }), /force_fail|check/i);
await db.exec(`ALTER TABLE enquiries DROP CONSTRAINT force_fail`);
ok('rollback: no submission, enquiry or history row left behind',
  +(await one(`SELECT count(*) c FROM web_form_submissions`)).c === before.s && +(await one(`SELECT count(*) c FROM enquiries`)).c === before.e
  && (await all(`SELECT 1 FROM web_form_submissions WHERE external_id='boom'`)).length === 0);
ok('the same submission can be retried after a failure', (await submit({ id: 'boom', category: 'Dining', phone: '+254700555000' })).duplicate === false);

// ── rate limiting ───────────────────────────────────────────────────────────
const P = '+254799000001';
await submit({ phone: P }); await submit({ phone: P }); await submit({ phone: P });
await throws('4th submission from one phone within an hour → RATE_LIMITED', () => submit({ phone: P }), /RATE_LIMITED/);
await db.query(`UPDATE web_form_submissions SET received_at = now() - interval '2 hours' WHERE contact_phone = $1`, [P]);
ok('allowed again once those are older than an hour', (await submit({ phone: P })).duplicate === false);
const recent = +(await one(`SELECT count(*) c FROM web_form_submissions WHERE received_at > now() - interval '10 minutes'`)).c;
for (let i = recent; i < 30; i++) await submit({ phone: `+2547${String(20000000 + i)}` });
await throws('30 submissions in 10 minutes overall → RATE_LIMITED', () => submit({ phone: '+254788888888' }), /RATE_LIMITED/);

// ── privileges and RLS ──────────────────────────────────────────────────────
const priv = await all(`SELECT r, has_function_privilege(r, 'public.create_enquiry_from_web_form(text,text,text,text,text,text,text,text,text,jsonb)', 'EXECUTE') AS can
  FROM (VALUES ('anon'),('authenticated'),('service_role')) v(r)`);
const can = Object.fromEntries(priv.map(p => [p.r, p.can]));
ok('RPC executable by service_role only', can.service_role && !can.anon && !can.authenticated, JSON.stringify(can));
ok('RLS is enabled on web_form_submissions', (await one(`SELECT relrowsecurity FROM pg_class WHERE relname='web_form_submissions'`)).relrowsecurity === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
