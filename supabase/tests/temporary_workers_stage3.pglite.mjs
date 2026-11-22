// Database tests for the temporary-workers migrations (stage1, 1b, 1c, 2, 3): PAYOUT VIA CHATPESA. Spec: docs/specs/temporary-workers.md
//
// Runs the REAL payroll_module.sql, production_v3a/v3b and temporary_workers_stage1, 1b, 1c, 2, 3 against an in-process Postgres (pglite).
// Only the Production parent tables (jobs, stages, operations, assignments) are minimal stubs.
//
// Stage 2 model: a temporary worker is engaged for ONE project at an agreed rate; days present are marked on the engagement
// (Full = 1, Half = 0.5) by head of sales / production manager / admin; settlements are built from those days.
//
//   mkdir -p /tmp/pg && cd /tmp/pg && npm init -y && npm i @electric-sql/pglite
//   PGLITE_DIR=/tmp/pg node supabase/tests/temporary_workers_stage3.pglite.mjs
//
// NOT covered here: true concurrency (pglite is single-connection). See supabase/tests/temporary_workers_concurrency.mjs.


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
const q = (sql, p) => db.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];
const val = async (sql, p) => { const r = await one(sql, p); return r ? Object.values(r)[0] : null; };
const call = async (name, ...args) => (await one(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).r;
const arr = ids => '{' + ids.join(',') + '}';

// ── schema ──────────────────────────────────────────────────────────────────
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE chatpesa_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chatpesa_id bigint NOT NULL UNIQUE, tx_type text NOT NULL CHECK (tx_type IN ('debit','credit','refund')), match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched','partial','matched','ignored','credit','refund')), account_number text, description text, confirm_code text, amount numeric(12,2) NOT NULL DEFAULT 0, transaction_date date NOT NULL, ignored_at timestamptz, ignored_by uuid REFERENCES auth.users(id));
  CREATE TABLE production_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL DEFAULT 'Planned', order_id uuid NOT NULL REFERENCES orders(id));
  CREATE TABLE production_job_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_key text, stage_label text, is_enabled boolean NOT NULL DEFAULT true);
  CREATE TABLE production_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_key text, is_active boolean DEFAULT true);
  CREATE TABLE production_job_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid REFERENCES production_jobs(id), stage_id uuid REFERENCES production_job_stages(id), operation_id uuid REFERENCES production_operations(id), employee_id uuid, status text NOT NULL DEFAULT 'Assigned');
`);
await db.exec(mig('payroll_module.sql'));
await db.exec(`ALTER TABLE production_job_assignments ADD CONSTRAINT fk_emp FOREIGN KEY (employee_id) REFERENCES employees(id);`);
await db.exec(mig('production_v3a_labour_costing.sql'));
await db.exec(mig('production_v3b_time_entry_day_lock.sql'));
await db.exec(mig('temporary_workers_stage1.sql'));
// Stage 1 is already applied in production with the DEFAULT damage setting of true; capture that state before 1b.
const damageBefore1b = await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`);
await db.exec(mig('temporary_workers_stage1b.sql'));
await db.exec(mig('temporary_workers_stage1c.sql'));
await db.exec(mig('temporary_workers_stage2.sql'));
await db.exec(mig('temporary_workers_stage3.sql'));
ok('migrations apply on top of the real payroll and production v3a/v3b migrations', true);
ok('stage 1 shipped with damage deductions ON (the state 1b corrects)', damageBefore1b === true);
ok('stage 1b flips the untouched settings row to OFF', (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === false);
ok('stage 1b: the column default is now false', (await val(`SELECT column_default FROM information_schema.columns WHERE table_name='temporary_worker_settings' AND column_name='damage_deductions_enabled'`)) === 'false');
const runAll = async () => { for (const f of ['temporary_workers_stage1.sql', 'temporary_workers_stage1b.sql', 'temporary_workers_stage1c.sql', 'temporary_workers_stage2.sql', 'temporary_workers_stage3.sql']) await db.exec(mig(f)); };
ok('migrations are idempotent when re-run in order (second run of all five)', await runAll().then(() => true, e => { console.log(e.message); return false; }));
ok('re-running does not re-enable damage deductions', (await val(`SELECT damage_deductions_enabled FROM temporary_worker_settings WHERE id`)) === false);
ok('stage 2 retired the Production link: no link function, no time-entry triggers',
  Number(await val(`SELECT count(*) FROM pg_proc WHERE proname IN ('link_assignment_to_engagement','tw_time_entry_insert_guard','tw_time_entry_void_guard','assign_engagement_worker')`)) === 0
  && Number(await val(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_pte_tw_insert_guard','trg_pte_tw_void_guard')`)) === 0);
ok('tw_today() is the Nairobi calendar day', (await val(`SELECT tw_today() = (now() AT TIME ZONE 'Africa/Nairobi')::date`)) === true);
// The fixtures use fixed November 2026 dates; pin "today" far ahead so they are valid whatever the real date is.
// The "future day" rule is tested below with its own pinned date.
const pinToday = (d) => db.exec(`CREATE OR REPLACE FUNCTION public.tw_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT '${d}'::date $$;`);
await pinToday('2099-12-31');


// ── actors and fixtures ─────────────────────────────────────────────────────
const user = async () => (await one(`INSERT INTO auth.users DEFAULT VALUES RETURNING id`)).id;
const admin = await user(), admin2 = await user(), pmRec = await user(), pmApp = await user(), hos1 = await user(), hos2 = await user(), pmPay = await user();
const ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const OTHER_ORDER = (await one(`INSERT INTO orders DEFAULT VALUES RETURNING id`)).id;
const JOB = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [ORDER])).id;
const OTHER_JOB = (await one(`INSERT INTO production_jobs (order_id) VALUES ($1) RETURNING id`, [OTHER_ORDER])).id;
const STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [JOB])).id;
const OTHER_STAGE = (await one(`INSERT INTO production_job_stages (job_id, stage_key, stage_label) VALUES ($1,'cut','Cut') RETURNING id`, [OTHER_JOB])).id;
const OP = (await one(`INSERT INTO production_operations (stage_key) VALUES ('cut') RETURNING id`)).id;

let n = 100;
const rates = new Map();
const worker = async (rate = 1000, active = true) => {
  const id = (await one(
    `INSERT INTO employees (employee_num, name, type, day_rate, is_active, phone) VALUES ($1,$2,'casual',$3,$4,$5) RETURNING id`,
    [`EMP-${++n}`, `Worker ${n}`, rate, active, `07${10000000 + n}`])).id;
  rates.set(id, rate); return id;
};
// The engagement's agreed rate (not the employee's day rate) drives the cost; default it to the worker's rate.
const engage = async (emp, o = {}) => call('create_temporary_engagement', emp, o.order || ORDER, o.rate ?? rates.get(emp) ?? 1000, o.start || '2026-11-02', o.end || null, null, null, true, o.actor || hos1, o.role || 'head_of_sales');

// Attendance is marked on the engagement itself (no Production assignment). `assign` stays as an alias so fixtures read the same.
const assign = async (emp, eng) => eng;
const W = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
const SUNDAY = '2026-11-08';
const markDays = (eng, days, actor = pmRec, role = 'production_manager') => call('mark_temporary_attendance', eng, JSON.stringify(days), actor, role);
// Mark Full days (or o.units) and return the attendance ids. The marker defaults to pmRec.
const book = async (eng, dates, o = {}) => {
  await markDays(eng, dates.map(d => ({ date: d, units: o.units ?? 1 })), o.recorder || pmRec, o.role || 'production_manager');
  return (await q(`SELECT id FROM temporary_worker_attendance WHERE engagement_id=$1 AND active AND work_date = ANY($2::date[]) ORDER BY work_date`, [eng, '{' + dates.join(',') + '}'])).rows.map(r => r.id);
};
const clearDay = (eng, date, actor = admin, role = 'admin') => markDays(eng, [{ date, units: 0 }], actor, role);
const mkRun = async (num, start, end = null) => (await one(
  `INSERT INTO payroll_runs (run_num, period_type, period_start, period_end, run_type) VALUES ($1,'weekly',$2::date,COALESCE($3::date,$2::date + 6),'casual') RETURNING id`, [num, start, end])).id;
const addEntry = (run, emp) => q(`INSERT INTO payroll_entries (run_id, employee_id, snapshot_name, snapshot_type, snapshot_sha, gross_pay, net_pay) VALUES ($1,$2,'x','casual',0,1000,1000)`, [run, emp]);

const prep = (eng, cutoff, kind = 'threshold', reason = null, actor = hos1, role = 'head_of_sales') =>
  call('prepare_temporary_settlement', eng, cutoff, kind, reason, actor, role);
const approve = (id, actor = hos2, role = 'head_of_sales', ov = null) => call('approve_temporary_settlement', id, actor, role, ov);
const sheetFor = (ids, actor = hos1, role = 'head_of_sales') => call('create_payout_sheet', arr(ids), actor, role);
const st = id => val(`SELECT status FROM temporary_worker_settlements WHERE id=$1`, [id]);
const resetSettings = () => q(`UPDATE temporary_worker_settings SET admin_approval_limit_kes=10000, settlement_threshold_units=3, rolling_window_days=7, deduction_single_limit_kes=1000, deduction_total_pct=25, damage_deductions_enabled=true`);
// A ready approved settlement of N days for a fresh worker.
const approved = async (days = 3, rate = 1000) => {
  const emp = await worker(rate); const eng = await engage(emp); const a = await assign(emp, eng);
  await book(a, W.slice(0, days));
  const p = await prep(eng, '2026-11-30');
  await approve(p.id);
  return { emp, eng, a, id: p.id, p };
};


// ════════════════════════════════════════════════════════════════════════════
// Stage 3 — ChatPesa payout
// ════════════════════════════════════════════════════════════════════════════
const exportSheet = (sh, actor = admin, role = 'admin') => call('export_payout_sheet', sh, actor, role);
const matchSheet = (sh, actor = hos1, role = 'head_of_sales') => call('match_payout_sheet', sh, actor, role);
const release = (sh, reason = 'ChatPesa rejected the row', actor = admin, role = 'admin') => call('release_unpaid_payout_rows', sh, reason, actor, role);
const today = `(now() AT TIME ZONE 'Africa/Nairobi')::date`;
let txn = 5000;
const tx = async (o = {}) => (await one(
  `INSERT INTO chatpesa_transactions (chatpesa_id, tx_type, match_status, account_number, description, confirm_code, amount, transaction_date)
   VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::date, ${today})) RETURNING id`,
  [++txn, o.type || 'debit', o.status || 'unmatched', o.phone ?? null, o.desc ?? null, o.code ?? `QX${txn}`, o.amount, o.date || null])).id;
const phoneOf = emp => val(`SELECT phone FROM employees WHERE id=$1`, [emp]);
const sNum = id => val(`SELECT settlement_num FROM temporary_worker_settlements WHERE id=$1`, [id]);
const sheetStatus = id => val(`SELECT status FROM temporary_worker_payout_sheets WHERE id=$1`, [id]);
const txStatus = id => val(`SELECT match_status FROM chatpesa_transactions WHERE id=$1`, [id]);
const acts = (entity, id, type) => val(`SELECT count(*) FROM payroll_activities WHERE entity_type=$1 AND entity_id=$2 AND activity_type=$3`, [entity, id, type]);

{
  // ── phone normaliser ──
  const np = p => val(`SELECT tw_normalise_phone($1)`, [p]);
  ok('phone: 07xx → 9 digits', await np('0712345678') === '712345678');
  ok('phone: +254 with spaces', await np('+254 712 345 678') === '712345678');
  ok('phone: 2541xx', await np('254112345678') === '112345678');
  ok('phone: already 9 digits', await np('712345678') === '712345678');
  ok('phone: 01xx', await np('0112345678') === '112345678');
  ok('phone: landline / wrong prefix refused', await np('0612345678') === null && await np('0201234567') === null);
  ok('phone: too short, blank and null refused', await np('12345') === null && await np('') === null && await np(null) === null);
  ok('legacy cash functions are gone', Number(await val(`SELECT count(*) FROM pg_proc WHERE proname IN ('pay_temporary_settlement','mark_sheet_printed','attach_signed_receipt')`)) === 0);
  ok('one-settlement-per-sheet index is gone', Number(await val(`SELECT count(*) FROM pg_indexes WHERE indexname='uq_tws_one_per_sheet'`)) === 0);
}

// ── creating a sheet, exporting, matching ──
{
  const a = await approved(3, 1000), b = await approved(3, 1500);
  const sh = await sheetFor([a.id, b.id]);
  ok('a sheet can now hold several workers (one ChatPesa upload)', Number(await val(`SELECT count(*) FROM temporary_worker_settlements WHERE payout_sheet_id=$1`, [sh])) === 2);
  ok('sheet total is the sum (3000 + 4500)', Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 7500);
  ok('a new sheet is open', (await sheetStatus(sh)) === 'open');
  await throws('an approved settlement already on a sheet cannot join another', () => sheetFor([a.id]), /not already on a payout sheet/);

  const nophone = await approved(3, 1000);
  await q(`UPDATE employees SET phone=NULL WHERE id=$1`, [nophone.emp]);
  await throws('a worker with no M-Pesa number blocks the sheet, naming the worker', () => sheetFor([nophone.id]), /No valid M-Pesa number on file for: Worker/);
  await q(`UPDATE employees SET phone='0612345678' WHERE id=$1`, [nophone.emp]);
  await throws('a landline-style number is not accepted', () => sheetFor([nophone.id]), /No valid M-Pesa number/);
  await throws('an unapproved settlement cannot go on a sheet', async () => {
    const emp = await worker(1000); const eng = await engage(emp); await book(await assign(emp, eng), W.slice(0, 3)); const p = await prep(eng, '2026-11-30');
    return sheetFor([p.id]);
  }, /approved, unpaid/);
  await throws('role without access cannot create a sheet', () => sheetFor([nophone.id], hos1, 'production_staff'), /Not allowed/);

  await throws('only an admin can export (production manager refused)', () => exportSheet(sh, pmPay, 'production_manager'), /Not allowed/);
  await throws('head of sales refused too', () => exportSheet(sh, hos2, 'head_of_sales'), /Not allowed/);
  await throws('an admin who prepared a settlement on the sheet cannot release it', async () => {
    const emp = await worker(1000); const eng = await engage(emp, { actor: admin, role: 'admin' }); await book(await assign(emp, eng), W.slice(0, 3));
    const p = await prep(eng, '2026-11-30', 'threshold', null, admin, 'admin'); await approve(p.id, hos2);
    return exportSheet(await sheetFor([p.id]), admin, 'admin');
  }, /prepared a settlement on this sheet/);

  const ex = await exportSheet(sh);
  ok('export returns one row per settlement', ex.rows.length === 2 && ex.first_export === true);
  ok('amounts are whole shillings and phones are 9 digits', ex.rows.every(r => Number.isInteger(Number(r.amount)) && /^[17]\d{8}$/.test(r.phone)));
  ok('each description carries the settlement number and has no comma or quote', ex.rows.every(r => /TW-\d{4}-\d{4}/.test(r.description) && !/[,"]/.test(r.description)));
  ok('sheet is exported with who/when recorded', (await sheetStatus(sh)) === 'exported' && (await val(`SELECT exported_by FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === admin
    && !!(await val(`SELECT exported_at FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])));
  ok('export is logged', Number(await acts('temp_sheet', sh, 'exported')) === 1);
  await throws('cannot add a settlement to an exported sheet', () => q(`UPDATE temporary_worker_settlements SET payout_sheet_id=$2 WHERE id=$1`, [nophone.id, sh]), /open payout sheet/);
  await throws('an exported sheet cannot be cancelled (the file may be uploaded)', () => call('cancel_payout_sheet', sh, 'oops', admin, 'admin'), /cannot be cancelled/);
  await throws('a settlement on an exported sheet cannot be voided', () => call('void_temporary_settlement', a.id, 'oops', admin, 'admin'), /exported payout sheet/);

  const again = await exportSheet(sh);
  ok('a repeat download returns the same unpaid rows and is flagged as not first', again.rows.length === 2 && again.first_export === false);
  ok('the repeat download is counted and logged', Number(await val(`SELECT export_downloads FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 2 && Number(await acts('temp_sheet', sh, 'export_repeated')) === 1);

  let m = await matchSheet(sh);
  ok('with no statement imported nothing is paid and both rows are reported not found', m.matched === 0 && m.pending === 2 && m.not_found.length === 2 && m.sheet_status === 'exported');
  ok('settlements stay approved', (await st(a.id)) === 'approved' && (await st(b.id)) === 'approved');
  await throws('role without access cannot match', () => matchSheet(sh, hos1, 'production_staff'), /Not allowed/);

  const an = await sNum(a.id), aph = await phoneOf(a.emp), bph = await phoneOf(b.emp);
  const wrongAmt = await tx({ amount: 3001, phone: aph, desc: `X - ${an}` });
  await tx({ amount: 3000, phone: '0799999999', desc: `X - ${an}` });
  const credit = await tx({ type: 'credit', amount: 3000, phone: aph, desc: `X - ${an}` });
  const already = await tx({ status: 'matched', amount: 3000, phone: aph, desc: `X - ${an}` });
  await tx({ amount: 3000, phone: aph, desc: `X - ${an}`, date: '2020-01-01' });
  await tx({ amount: 3000, phone: aph, desc: 'Someone - TW-2026-9999' });
  m = await matchSheet(sh);
  ok('wrong amount, wrong phone, a credit, an allocated debit, a pre-export debit and another settlement’s reference never match', m.matched === 0);
  ok('decoys are left untouched', (await txStatus(wrongAmt)) === 'unmatched' && (await txStatus(credit)) === 'unmatched' && (await txStatus(already)) === 'matched');

  const txA = await tx({ amount: 3000, phone: `+254${aph.slice(1)}`, desc: `Worker - ${an}`, code: 'RKA123' });
  m = await matchSheet(sh, hos1, 'head_of_sales');
  ok('A matched by settlement number (phone in a different format)', m.matched === 1 && m.pending === 1 && m.sheet_status === 'exported');
  const sa = await one(`SELECT status, paid_by, paid_at, payment_note, payout_sheet_id FROM temporary_worker_settlements WHERE id=$1`, [a.id]);
  ok('A is paid by the person who exported (not the matcher), with the M-Pesa code on it', sa.status === 'paid' && sa.paid_by === admin && /RKA123/.test(sa.payment_note) && sa.payout_sheet_id === sh);
  ok('B is still unpaid', (await st(b.id)) === 'approved');
  ok('the matched debit leaves the supplier queue', (await txStatus(txA)) === 'ignored');
  const ra = await one(`SELECT chatpesa_transaction_id, match_method, confirm_code, matched_by FROM temporary_worker_payout_rows WHERE settlement_id=$1`, [a.id]);
  ok('the row records the transaction, method, code and matcher', ra.chatpesa_transaction_id === txA && ra.match_method === 'settlement_ref' && ra.confirm_code === 'RKA123' && ra.matched_by === hos1);
  ok('a repeat download now excludes the paid row', (await exportSheet(sh)).rows.length === 1);
  await throws('a paid settlement cannot be voided', () => call('void_temporary_settlement', a.id, 'x', admin, 'admin'), /paid settlement is final/);
  ok('re-matching is harmless and changes nothing', (await matchSheet(sh)).matched === 0 && (await st(a.id)) === 'paid');

  await tx({ amount: 4500, phone: bph, desc: 'MPESA payout', code: 'RKB456' });
  m = await matchSheet(sh);
  ok('B matched by phone + amount when no settlement number was echoed', m.matched === 1 && m.sheet_status === 'paid');
  ok('that match is recorded as phone_amount', (await val(`SELECT match_method FROM temporary_worker_payout_rows WHERE settlement_id=$1`, [b.id])) === 'phone_amount');
  ok('every row matched → the sheet is paid', (await sheetStatus(sh)) === 'paid' && (await st(b.id)) === 'paid');
  await throws('a paid sheet cannot be exported again', () => exportSheet(sh), /cannot be exported/);
  await throws('a paid sheet cannot be changed', () => q(`UPDATE temporary_worker_payout_sheets SET admin_approved_by=$2, admin_approved_at=now() WHERE id=$1`, [sh, admin]), /paid payout sheet is final/);
  ok('both payments are logged', Number(await acts('temp_settlement', a.id, 'paid')) === 1 && Number(await acts('temp_settlement', b.id, 'paid')) === 1);
}

// ── ambiguity and double-spend protection ──
{
  const a = await approved(3, 1000);
  const sh = await sheetFor([a.id]); await exportSheet(sh);
  const num = await sNum(a.id), ph = await phoneOf(a.emp);
  await tx({ amount: 3000, phone: ph, desc: `Dup one - ${num}` }); await tx({ amount: 3000, phone: ph, desc: `Dup two - ${num}` });
  let m = await matchSheet(sh);
  ok('two candidate debits for one row is ambiguous: nothing is paid', m.matched === 0 && m.ambiguous.includes(num) && (await st(a.id)) === 'approved');
  await q(`UPDATE chatpesa_transactions SET match_status='ignored' WHERE description LIKE 'Dup%'`);

  const b = await approved(3, 1000);
  const shB = await sheetFor([b.id]); await exportSheet(shB);
  const shared = await tx({ amount: 3000, phone: ph, desc: `Pay - ${num}` });
  m = await matchSheet(sh);
  ok('a debit pays one row', m.matched === 1 && (await st(a.id)) === 'paid');
  m = await matchSheet(shB);
  ok('the same debit cannot pay a second sheet', m.matched === 0 && (await st(b.id)) === 'approved');
  await throws('DATABASE: a transaction cannot be linked to two rows', () => q(`UPDATE temporary_worker_payout_rows SET chatpesa_transaction_id=$1, match_method='phone_amount', matched_by=$2, matched_at=now() WHERE settlement_id=$3`, [shared, hos1, b.id]), /uq_twr_transaction|duplicate key/);
}

// ── partial payment and release ──
{
  const a = await approved(3, 1000), b = await approved(3, 2000);
  const sh = await sheetFor([a.id, b.id]); await exportSheet(sh);
  await tx({ amount: 3000, phone: await phoneOf(a.emp), desc: `A - ${await sNum(a.id)}` });
  const m = await matchSheet(sh);
  ok('one row paid, one not: the sheet stays exported', m.matched === 1 && m.sheet_status === 'exported' && (await sheetStatus(sh)) === 'exported');
  await throws('release is admin only', () => release(sh, 'x', hos1, 'head_of_sales'), /Not allowed/);
  await throws('release needs a reason', () => release(sh, '  '), /reason is required/);
  const r = await release(sh, 'ChatPesa rejected B: number not registered');
  ok('release closes the unpaid row only', r.released === 1 && r.paid_remaining === 1);
  ok('the released settlement is approved again and off the sheet', (await st(b.id)) === 'approved' && (await val(`SELECT payout_sheet_id FROM temporary_worker_settlements WHERE id=$1`, [b.id])) === null);
  ok('the paid settlement stays on the sheet; the sheet is paid with the paid total', (await sheetStatus(sh)) === 'paid' && Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 3000);
  ok('the released row keeps its reason', (await val(`SELECT release_reason FROM temporary_worker_payout_rows WHERE settlement_id=$1 AND released_at IS NOT NULL`, [b.id])) === 'ChatPesa rejected B: number not registered');
  const sh2 = await sheetFor([b.id]); const ex2 = await exportSheet(sh2);
  ok('a released settlement can be exported again on a new sheet', ex2.rows.length === 1 && ex2.first_export === true);
  await tx({ amount: 6000, phone: await phoneOf(b.emp), desc: `B - ${await sNum(b.id)}` });
  ok('and then matches', (await matchSheet(sh2)).sheet_status === 'paid' && (await st(b.id)) === 'paid');
}
{
  const a = await approved(3, 1000);
  const sh = await sheetFor([a.id]); await exportSheet(sh);
  await release(sh, 'File never uploaded');
  ok('nothing matched, all released → the sheet is cancelled and the settlement is free', (await sheetStatus(sh)) === 'cancelled' && (await st(a.id)) === 'approved');
  await throws('releasing twice is refused', () => release(sh), /exported payout sheet/);
}

// ── approval limit, open-sheet cancel, role rules ──
{
  const bigEmp = await worker(1000); const bigEng = await engage(bigEmp); await book(await assign(bigEmp, bigEng), W.slice(0, 12));
  const big = await prep(bigEng, '2026-11-30'); await approve(big.id, admin, 'admin');   // above the limit: only an admin approves
  const sh = await sheetFor([big.id]);
  await throws('a sheet above the limit needs admin approval before export', () => exportSheet(sh), /must approve it before it is exported/);
  await call('approve_payout_sheet', sh, admin, 'admin');
  ok('after admin approval the sheet exports', (await exportSheet(sh)).rows.length === 1);
  await throws('approving an exported sheet is refused', () => call('approve_payout_sheet', sh, admin, 'admin'), /Only an open payout sheet/);

  const c = await approved(3, 1000);
  const s2 = await sheetFor([c.id]);
  await throws('cancelling needs a reason', () => call('cancel_payout_sheet', s2, ' ', hos1, 'head_of_sales'), /reason is required/);
  await call('cancel_payout_sheet', s2, 'Wrong worker', hos1, 'head_of_sales');
  ok('an open sheet can be cancelled; the settlement is free', (await sheetStatus(s2)) === 'cancelled' && (await st(c.id)) === 'approved');
  await throws('a cancelled sheet cannot be exported', () => exportSheet(s2), /cannot be exported/);
  await throws('a cancelled sheet is final', () => q(`UPDATE temporary_worker_payout_sheets SET status='open', cancelled_by=NULL, cancelled_at=NULL, cancel_reason=NULL WHERE id=$1`, [s2]), /final/);
  await throws('an empty sheet cannot be exported', async () => {
    const e = await sheetFor([(await approved(3, 1000)).id]);
    await q(`UPDATE temporary_worker_settlements SET payout_sheet_id=NULL WHERE payout_sheet_id=$1`, [e]);
    return exportSheet(e);
  }, /empty/);
}

// ── void paths (regression: void of a settlement on NO sheet used to fail with an unassigned record) ──
{
  const d = await approved(3, 1000);
  await call('void_temporary_settlement', d.id, 'no sheet yet', admin, 'admin');
  ok('an approved settlement that is on no sheet can be voided (admin)', (await st(d.id)) === 'voided');
  const emp = await worker(1000); const eng = await engage(emp); await book(await assign(emp, eng), W.slice(0, 3));
  const draft = await prep(eng, '2026-11-30');
  await call('void_temporary_settlement', draft.id, 'prepared in error', hos1, 'head_of_sales');
  ok('a draft settlement can be voided by its preparer', (await st(draft.id)) === 'voided');
  const onOpen = await approved(3, 1000); const sh = await sheetFor([onOpen.id]);
  await call('void_temporary_settlement', onOpen.id, 'wrong worker', admin, 'admin');
  ok('a settlement on an OPEN sheet can be voided: it leaves the sheet and the sheet total follows', (await st(onOpen.id)) === 'voided'
    && Number(await val(`SELECT total_net FROM temporary_worker_payout_sheets WHERE id=$1`, [sh])) === 0);
  const a = await approved(3, 1000); const s1 = await sheetFor([a.id]); await exportSheet(s1);
  await tx({ amount: 3000, phone: await phoneOf(a.emp), desc: `A - ${await sNum(a.id)}` }); await matchSheet(s1);
  const again = await matchSheet(s1, hos2, 'head_of_sales');
  ok('matching a sheet that is already paid is harmless and says so', again.matched === 0 && again.sheet_status === 'paid');
}

// ── database-level guards (bypassing the functions) ──
{
  const a = await approved(3, 1000);
  const sh = await sheetFor([a.id]);
  await throws('a settlement cannot be marked paid while the sheet is open', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now() WHERE id=$1`, [a.id, admin]), /exported payout sheet/);
  await throws('a sheet cannot jump open → paid', () => q(`UPDATE temporary_worker_payout_sheets SET status='paid', exported_by=$2, exported_at=now() WHERE id=$1`, [sh, admin]), /Illegal payout sheet status/);
  await throws('exported without who/when is rejected', () => q(`UPDATE temporary_worker_payout_sheets SET status='exported' WHERE id=$1`, [sh]), /tws_sheet_status_fields/);
  await exportSheet(sh);
  await throws('paid by the preparer is rejected by CHECK', () => q(`UPDATE temporary_worker_settlements SET status='paid', paid_by=$2, paid_at=now() WHERE id=$1`, [a.id, hos1]), /tws_status_fields/);
  await throws('who exported a sheet cannot be rewritten', () => q(`UPDATE temporary_worker_payout_sheets SET exported_by=$2 WHERE id=$1`, [sh, hos2]), /cannot change/);
  await throws('payout rows cannot be edited', () => q(`UPDATE temporary_worker_payout_rows SET amount=1 WHERE sheet_id=$1`, [sh]), /cannot be edited/);
  await throws('payout rows cannot be deleted', () => q(`DELETE FROM temporary_worker_payout_rows WHERE sheet_id=$1`, [sh]), /never deleted/);
  await throws('no commas or quotes can reach the CSV description', () => q(`INSERT INTO temporary_worker_payout_rows (sheet_id, settlement_id, employee_id, phone, amount, description) VALUES ($1,$2,$3,'712345678',100,'a,b')`, [sh, a.id, a.emp]), /twr|check|violates|duplicate/);
  await throws('exported settlement figures cannot be edited', () => q(`UPDATE temporary_worker_settlements SET net_amount=1, deductions_total=0 WHERE id=$1`, [a.id]), /cannot be edited|fixed once|tws_/);
}

// ── name sanitising and rounding ──
{
  const emp = await worker(1000);
  await q(`UPDATE employees SET name='Doe, John "JJ"' WHERE id=$1`, [emp]);
  const eng = await engage(emp); await book(await assign(emp, eng), W.slice(0, 3)); const p = await prep(eng, '2026-11-30'); await approve(p.id);
  const sh = await sheetFor([p.id]); const ex = await exportSheet(sh);
  ok('commas and quotes in a worker name never reach the CSV', !/[,"]/.test(ex.rows[0].description) && /Doe/.test(ex.rows[0].description));

  const odd = await worker(1501);
  const e2 = await engage(odd, { rate: 1501 }); await markDays(e2, [{ date: W[0], units: 0.5 }, { date: W[1], units: 1 }, { date: W[2], units: 1 }, { date: W[3], units: 1 }]);
  const p2 = await prep(e2, '2026-11-30'); await approve(p2.id);
  const net = Number(await val(`SELECT net_amount FROM temporary_worker_settlements WHERE id=$1`, [p2.id]));
  const sh2 = await sheetFor([p2.id]); const ex2 = await exportSheet(sh2);
  ok('the exported amount is the net rounded to whole shillings', Number(ex2.rows[0].amount) === Math.round(net));
}

// ── grants ──
{
  const f = fn => val(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE')`);
  ok('service_role can export, match and release', await f('public.export_payout_sheet(uuid,uuid,text)') && await f('public.match_payout_sheet(uuid,uuid,text)') && await f('public.release_unpaid_payout_rows(uuid,text,uuid,text)'));
  ok('anon and authenticated cannot', !(await val(`SELECT has_function_privilege('anon', 'public.export_payout_sheet(uuid,uuid,text)', 'EXECUTE')`))
    && !(await val(`SELECT has_function_privilege('authenticated', 'public.match_payout_sheet(uuid,uuid,text)', 'EXECUTE')`)));
  ok('payout rows are not readable by the browser roles', !(await val(`SELECT has_table_privilege('authenticated', 'public.temporary_worker_payout_rows', 'SELECT')`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.close?.();
process.exit(fail ? 1 : 0);
