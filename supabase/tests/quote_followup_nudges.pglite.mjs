// Database tests for supabase/migrations/quote_followup_nudges.sql
//
// Runs the REAL migration against a minimal stub of quotations / followups /
// quote_activities in an in-process Postgres (pglite). Covers: idempotency,
// backfill, the sent_at trigger, the open-auto-task index, the auto_source CHECK,
// and the transactional record_quote_followup_action RPC (incl. rollback).
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   node supabase/tests/quote_followup_nudges.pglite.mjs   (PGLITE_DIR=/tmp/pg if needed)
//
// NOT covered (needs staging): the HTTP routes, Vercel cron, RLS/role grants on real Supabase.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire((process.env.PGLITE_DIR || '/tmp/pg') + '/');
const { PGlite } = require('@electric-sql/pglite');

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '../migrations/quote_followup_nudges.sql'), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const throws = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const rpc = (id, action, { method = null, note = null, days = null, user = U1 } = {}) =>
  one(`SELECT public.record_quote_followup_action($1,$2,$3,$4,$5,$6) AS r`, [id, action, method, note, days, user]);

const U1 = '00000000-0000-0000-0000-0000000000a1';
const NOUSER = '00000000-0000-0000-0000-0000000000ff';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE users (id uuid PRIMARY KEY);
  INSERT INTO users VALUES ('${U1}');
  CREATE TABLE enquiries (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE quotations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL DEFAULT 'draft',
    converted_order_id uuid, suspended_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE followups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enquiry_id uuid REFERENCES enquiries(id),
    quotation_id uuid REFERENCES quotations(id),
    due_date date NOT NULL DEFAULT current_date, note text,
    completed_at timestamptz, completed_by uuid REFERENCES users(id),
    created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE quote_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL, entity_id uuid NOT NULL, activity_type text NOT NULL,
    description text NOT NULL, created_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now());
`);

// ── pre-migration data (backfill cases) ──────────────────────────────────────
const legacyLogged = await one(`INSERT INTO quotations (status, created_at, updated_at) VALUES ('accepted','2026-01-01','2026-02-20') RETURNING id`);
await db.query(`INSERT INTO quote_activities (entity_type, entity_id, activity_type, description, created_at)
  VALUES ('quotation',$1,'status_change','Status: draft → sent','2026-01-10T08:00:00Z'),
         ('quotation',$1,'status_change','Status: sent → sent','2026-01-15T08:00:00Z')`, [legacyLogged.id]);
const legacyNoLog = await one(`INSERT INTO quotations (status, created_at, updated_at) VALUES ('sent','2026-01-01','2026-03-05T00:00:00Z') RETURNING id`);
const legacyDraft = await one(`INSERT INTO quotations (status) VALUES ('draft') RETURNING id`);

await db.exec(migration);
await db.exec(migration);   // re-runnable

// ── backfill ─────────────────────────────────────────────────────────────────
let r = await one(`SELECT sent_at FROM quotations WHERE id=$1`, [legacyLogged.id]);
ok('backfill: earliest "→ sent" log entry wins', new Date(r.sent_at).toISOString() === '2026-01-10T08:00:00.000Z', String(r.sent_at));
r = await one(`SELECT sent_at FROM quotations WHERE id=$1`, [legacyNoLog.id]);
ok('backfill: sent with no log falls back to updated_at', new Date(r.sent_at).toISOString() === '2026-03-05T00:00:00.000Z', String(r.sent_at));
r = await one(`SELECT sent_at FROM quotations WHERE id=$1`, [legacyDraft.id]);
ok('backfill: drafts stay NULL', r.sent_at === null);

// ── sent_at trigger ──────────────────────────────────────────────────────────
const q = await one(`INSERT INTO quotations (status) VALUES ('draft') RETURNING id`);
ok('draft insert: sent_at NULL', (await one(`SELECT sent_at FROM quotations WHERE id=$1`, [q.id])).sent_at === null);

await db.query(`UPDATE quotations SET status='sent' WHERE id=$1`, [q.id]);
const first = (await one(`SELECT sent_at FROM quotations WHERE id=$1`, [q.id])).sent_at;
ok('first transition to sent records the timestamp', first !== null);

await new Promise(res => setTimeout(res, 15));
await db.query(`UPDATE quotations SET status='sent', updated_at=now() WHERE id=$1`, [q.id]);
ok('repeating {status:sent} preserves sent_at', +(await one(`SELECT sent_at FROM quotations WHERE id=$1`, [q.id])).sent_at === +first);

await db.query(`UPDATE quotations SET status='draft' WHERE id=$1`, [q.id]);
await new Promise(res => setTimeout(res, 15));
await db.query(`UPDATE quotations SET status='sent' WHERE id=$1`, [q.id]);
ok('sent → away → sent keeps the ORIGINAL sent_at', +(await one(`SELECT sent_at FROM quotations WHERE id=$1`, [q.id])).sent_at === +first);

await db.query(`UPDATE quotations SET sent_at='2020-01-01' WHERE id=$1`, [q.id]);
ok('an explicit overwrite of sent_at is ignored', +(await one(`SELECT sent_at FROM quotations WHERE id=$1`, [q.id])).sent_at === +first);

const direct = await one(`INSERT INTO quotations (status) VALUES ('sent') RETURNING id, sent_at`);
ok('created directly as sent records sent_at', direct.sent_at !== null);

// ── open auto-task uniqueness + CHECK ────────────────────────────────────────
const addAuto = id => db.query(`INSERT INTO followups (quotation_id, auto_source) VALUES ($1,'quote_nudge')`, [id]);
await addAuto(q.id);
await throws('second OPEN quote_nudge task for the same quote is rejected', () => addAuto(q.id), /uq_followups_open_auto_per_quote|duplicate/i);
await db.query(`INSERT INTO followups (quotation_id) VALUES ($1), ($1)`, [q.id]);
ok('manual tasks are not constrained by the index', true);
await throws('unknown auto_source is rejected', () => db.query(`INSERT INTO followups (quotation_id, auto_source) VALUES ($1,'mystery')`, [q.id]), /followups_auto_source_known|check/i);
await db.query(`UPDATE followups SET completed_at=now() WHERE quotation_id=$1 AND auto_source='quote_nudge'`, [q.id]);
await addAuto(q.id);
ok('a new open task is allowed once the previous one is completed', true);

// ── RPC: contact ─────────────────────────────────────────────────────────────
const c = await one(`INSERT INTO quotations (status, follow_up_snoozed_until) VALUES ('sent', current_date + 5) RETURNING id`);
await addAuto(c.id);
await db.query(`INSERT INTO followups (quotation_id, note) VALUES ($1,'manual: send samples')`, [c.id]);
await rpc(c.id, 'contact', { method: 'WhatsApp', note: '  said he will confirm Friday  ' });
let row = await one(`SELECT last_contact_at, follow_up_snoozed_until FROM quotations WHERE id=$1`, [c.id]);
ok('contact: last_contact_at set and snooze cleared', row.last_contact_at !== null && row.follow_up_snoozed_until === null);
let act = await all(`SELECT activity_type, description, created_by FROM quote_activities WHERE entity_id=$1`, [c.id]);
ok('contact: one activity row with method + trimmed note', act.length === 1 && act[0].activity_type === 'contact_logged' && act[0].description === 'WhatsApp: said he will confirm Friday' && act[0].created_by === U1, JSON.stringify(act));
let tasks = await all(`SELECT auto_source, completed_at, completed_reason FROM followups WHERE quotation_id=$1 ORDER BY auto_source NULLS LAST`, [c.id]);
ok('contact: auto task closed with reason contact_logged', tasks[0].completed_at !== null && tasks[0].completed_reason === 'contact_logged');
ok('contact: manual task left open', tasks[1].auto_source === null && tasks[1].completed_at === null);

// ── RPC: snooze ──────────────────────────────────────────────────────────────
const s = await one(`INSERT INTO quotations (status) VALUES ('sent') RETURNING id`);
await addAuto(s.id);
await db.query(`INSERT INTO followups (quotation_id, note) VALUES ($1,'manual: call back')`, [s.id]);
const snooze = (await rpc(s.id, 'snooze', { days: 4 })).r;
const nairobi = (await one(`SELECT ((now() AT TIME ZONE 'Africa/Nairobi')::date + 4)::text AS d`)).d;
ok('snooze: until = Nairobi today + 4', snooze.follow_up_snoozed_until === nairobi, JSON.stringify(snooze));
tasks = await all(`SELECT auto_source, completed_at, completed_reason FROM followups WHERE quotation_id=$1 ORDER BY auto_source NULLS LAST`, [s.id]);
ok('snooze: existing auto task is completed as "snoozed"', tasks[0].completed_at !== null && tasks[0].completed_reason === 'snoozed');
ok('snooze: manual task untouched', tasks[1].auto_source === null && tasks[1].completed_at === null);
await addAuto(s.id);
ok('snooze: the daily job can create a fresh task afterwards', (await all(`SELECT 1 FROM followups WHERE quotation_id=$1 AND auto_source='quote_nudge' AND completed_at IS NULL`, [s.id])).length === 1);
ok('snooze: history row written', (await all(`SELECT 1 FROM quote_activities WHERE entity_id=$1 AND activity_type='follow_up_snoozed'`, [s.id])).length === 1);
const clamp = (await rpc(s.id, 'snooze', { days: 999 })).r;
ok('snooze: days clamped to 14', clamp.follow_up_snoozed_until === (await one(`SELECT ((now() AT TIME ZONE 'Africa/Nairobi')::date + 14)::text AS d`)).d);
const dflt = (await rpc(s.id, 'snooze')).r;
ok('snooze: default is 3 days', dflt.follow_up_snoozed_until === (await one(`SELECT ((now() AT TIME ZONE 'Africa/Nairobi')::date + 3)::text AS d`)).d);

// ── RPC: validation ──────────────────────────────────────────────────────────
await throws('unknown quotation → QUOTE_NOT_FOUND', () => rpc('00000000-0000-0000-0000-000000000001', 'snooze'), /QUOTE_NOT_FOUND/);
const draft = await one(`INSERT INTO quotations (status) VALUES ('draft') RETURNING id`);
await throws('draft quote → QUOTE_NOT_CHASEABLE', () => rpc(draft.id, 'snooze'), /QUOTE_NOT_CHASEABLE/);
const accepted = await one(`INSERT INTO quotations (status) VALUES ('accepted') RETURNING id`);
await throws('accepted quote → QUOTE_NOT_CHASEABLE', () => rpc(accepted.id, 'contact', { method: 'call' }), /QUOTE_NOT_CHASEABLE/);
const susp = await one(`INSERT INTO quotations (status, suspended_at) VALUES ('sent', now()) RETURNING id`);
await throws('suspended quote → QUOTE_NOT_CHASEABLE', () => rpc(susp.id, 'snooze'), /QUOTE_NOT_CHASEABLE/);
const conv = await one(`INSERT INTO quotations (status, converted_order_id) VALUES ('sent', gen_random_uuid()) RETURNING id`);
await throws('converted quote → QUOTE_NOT_CHASEABLE', () => rpc(conv.id, 'snooze'), /QUOTE_NOT_CHASEABLE/);
await throws('bad method → BAD_METHOD', () => rpc(c.id, 'contact', { method: 'telepathy' }), /BAD_METHOD/);
await throws('bad action → BAD_ACTION', () => rpc(c.id, 'delete'), /BAD_ACTION/);

// ── RPC: atomic rollback ─────────────────────────────────────────────────────
// An unknown user violates the quote_activities FK AFTER the quotation was
// updated inside the function; everything must roll back.
const a = await one(`INSERT INTO quotations (status) VALUES ('sent') RETURNING id`);
await addAuto(a.id);
await throws('contact with a failing step raises', () => rpc(a.id, 'contact', { method: 'call', user: NOUSER }), /foreign key|violates/i);
row = await one(`SELECT last_contact_at FROM quotations WHERE id=$1`, [a.id]);
ok('rollback: last_contact_at NOT changed', row.last_contact_at === null);
ok('rollback: no activity row', (await all(`SELECT 1 FROM quote_activities WHERE entity_id=$1`, [a.id])).length === 0);
ok('rollback: auto task still open', (await all(`SELECT 1 FROM followups WHERE quotation_id=$1 AND completed_at IS NULL`, [a.id])).length === 1);
await throws('snooze with a failing step raises', () => rpc(a.id, 'snooze', { user: NOUSER }), /foreign key|violates/i);
ok('rollback (snooze): no snooze date, task still open', (await one(`SELECT follow_up_snoozed_until FROM quotations WHERE id=$1`, [a.id])).follow_up_snoozed_until === null
  && (await all(`SELECT 1 FROM followups WHERE quotation_id=$1 AND completed_at IS NULL`, [a.id])).length === 1);

// ── privileges ───────────────────────────────────────────────────────────────
const priv = await all(`SELECT r, has_function_privilege(r, 'public.record_quote_followup_action(uuid,text,text,text,integer,uuid)', 'EXECUTE') AS can
  FROM (VALUES ('anon'),('authenticated'),('service_role')) v(r)`);
const can = Object.fromEntries(priv.map(p => [p.r, p.can]));
ok('RPC executable by service_role only', can.service_role && !can.anon && !can.authenticated, JSON.stringify(can));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
