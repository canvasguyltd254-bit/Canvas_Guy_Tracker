// Route-level test for /api/payroll/temporary/*: bundles the REAL route handlers with esbuild and swaps
// serviceClient for a recording fake. Ad-hoc harness, not part of `npm test`.
//
//   mkdir -p /tmp/rt && cd /tmp/rt && npm init -y && npm i esbuild
//   REPO=/path/to/canvas-guy-tracker node supabase/tests/temporary_workers_routes.harness.mjs
//
// Proves: role gates (production_staff etc. get 403 and NOTHING is called), the actor and role passed to the
// database come from the session (never the request body), input validation happens before any database call,
// database errors are mapped without leaking internals, every select() uses an explicit allow-list, and the
// payroll entries route maps the engagement-overlap trigger.

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = process.env.REPO || process.cwd();
const require = createRequire('/tmp/rt/');
const esbuild = require('esbuild');
mkdirSync('/tmp/rt/out', { recursive: true });

writeFileSync('/tmp/rt/nextStub.js', `export const NextResponse = { json: (b, i = {}) => new Response(JSON.stringify(b), { status: i.status || 200, headers: { 'content-type': 'application/json' } }) };`);
writeFileSync('/tmp/rt/apiAuthStub.js', `
export const getAuthContext = async () => globalThis.__ctx;
export const requireRole = (user, role, roles) => {
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  return roles.includes(role) ? null : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
};
export const serviceClient = new Proxy({}, { get: (_, k) => globalThis.__svc[k] });`);
writeFileSync('/tmp/rt/shaStub.js', `export const resolveShaDeduction = async () => 0;`);

const T = 'app/api/payroll/temporary';
const routes = {
  engagements: `${T}/engagements/route.js`, engagement: `${T}/engagements/[id]/route.js`, assignments: `${T}/engagements/[id]/assignments/route.js`,
  settlements: `${T}/settlements/route.js`, settlement: `${T}/settlements/[id]/route.js`, sdeductions: `${T}/settlements/[id]/deductions/route.js`,
  deduction: `${T}/deductions/[id]/route.js`, sheets: `${T}/payout-sheets/route.js`, sheet: `${T}/payout-sheets/[id]/route.js`,
  settings: `${T}/settings/route.js`, entries: 'app/api/payroll/runs/[id]/entries/route.js',
};
for (const [name, rel] of Object.entries(routes)) {
  await esbuild.build({
    entryPoints: [path.join(REPO, rel)], bundle: true, platform: 'node', format: 'cjs',
    outfile: `/tmp/rt/out/t_${name}.cjs`, logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{ name: 'alias', setup(b) {
      b.onResolve({ filter: /^next\/server$/ }, () => ({ path: '/tmp/rt/nextStub.js' }));
      b.onResolve({ filter: /^@\/shared\/lib\/api-auth$/ }, () => ({ path: '/tmp/rt/apiAuthStub.js' }));
      b.onResolve({ filter: /^@\/shared\/lib\/resolveShaDeduction$/ }, () => ({ path: '/tmp/rt/shaStub.js' }));
      b.onResolve({ filter: /^@\// }, a => { const base = path.join(REPO, a.path.slice(2));
        for (const ext of ['', '.js', '/index.js']) { try { if (statSync(base + ext).isFile()) return { path: base + ext }; } catch {} } });
    } }],
  });
}
const R = Object.fromEntries(Object.keys(routes).map(n => [n, require(`/tmp/rt/out/t_${n}.cjs`)]));

// ── recording fake of the supabase-js client ──
const calls = { rpc: [], selects: [], storage: [], mutations: 0 };
let rpcResult = { data: { ok: true }, error: null };
let tableResult = {};
const storageFake = { createBucket: async () => ({}), from: () => ({
  createSignedUploadUrl: async (p) => { calls.storage.push(['upload', p]); return { data: { path: p, token: 'tok' }, error: null }; },
  createSignedUrl: async (p) => { calls.storage.push(['url', p]); return { data: { signedUrl: 'https://signed/x' }, error: null }; },
  list: async () => ({ data: globalThis.__listed ?? [], error: null }),
  remove: async (p) => { calls.storage.push(['remove', p]); return {}; },
}) };
function chain(table) {
  const api = new Proxy({}, { get(_, k) {
    if (k === 'select') return (c) => { calls.selects.push({ table, cols: c }); return api; };
    if (k === 'insert' || k === 'update' || k === 'upsert' || k === 'delete') return () => { calls.mutations++; return api; };
    if (k === 'then') return (res, rej) => Promise.resolve(tableResult[table] ?? { data: [], error: null }).then(res, rej);
    // supabase-js: single() errors on zero rows (PGRST116); maybeSingle() returns { data: null, error: null }.
    if (k === 'single') return () => ({ then: (res, rej) => Promise.resolve(tableResult[`${table}:one`] ?? { data: null, error: { code: 'PGRST116', message: 'no rows' } }).then(res, rej) });
    if (k === 'maybeSingle') return () => ({ then: (res, rej) => Promise.resolve(tableResult[`${table}:one`] ?? { data: null, error: null }).then(res, rej) });
    return () => api;
  } });
  return api;
}
globalThis.__svc = { rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpcResult; }, from: chain, storage: storageFake };

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const UID = '11111111-1111-4111-8111-111111111111', ID = '22222222-2222-4222-8222-222222222222', ID2 = '33333333-3333-4333-8333-333333333333';
const reset = (role = 'head_of_sales') => {
  calls.rpc.length = 0; calls.selects.length = 0; calls.storage.length = 0; calls.mutations = 0;
  rpcResult = { data: { ok: true }, error: null }; tableResult = {}; globalThis.__listed = [];
  globalThis.__ctx = role === 'anon' ? { user: null, role: null } : { user: { id: UID }, role: role === 'none' ? undefined : role };
};
const req = (method, body, url = 'http://x/api') => new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const P = (id = ID) => ({ params: Promise.resolve({ id }) });
const run = async (fn, ...a) => { const res = await fn(...a); return { status: res.status, body: await res.json() }; };

// A representative call for every route handler.
const VALID_ENG = { employee_id: ID, order_id: ID2, agreed_daily_rate: 1500, start_date: '2026-11-02', expected_end_date: '2026-11-30' };
const CALLS = {
  'GET engagements':          () => R.engagements.GET(req('GET', undefined, 'http://x/api?status=active')),
  'POST engagements':         () => R.engagements.POST(req('POST', VALID_ENG)),
  'GET engagement':           () => R.engagement.GET(req('GET'), P()),
  'PATCH engagement':         () => R.engagement.PATCH(req('PATCH', { action: 'activate' }), P()),
  'GET assignments':          () => R.assignments.GET(req('GET'), P()),
  'GET settlements':          () => R.settlements.GET(req('GET', undefined, 'http://x/api?status=draft')),
  'POST settlements':         () => R.settlements.POST(req('POST', { engagement_id: ID, cutoff_date: '2026-11-30', kind: 'threshold' })),
  'GET settlement':           () => R.settlement.GET(req('GET'), P()),
  'PATCH settlement approve': () => R.settlement.PATCH(req('PATCH', { action: 'approve' }), P()),
  'PATCH settlement pay':     () => R.settlement.PATCH(req('PATCH', { action: 'pay', received_by_full_name: 'Jane Wanjiru' }), P()),
  'POST deduction':           () => R.sdeductions.POST(req('POST', { deduction_type: 'cash_advance', amount: 100, reason: 'Advance', evidence_ref: 'ADV-1' }), P()),
  'PATCH deduction':          () => R.deduction.PATCH(req('PATCH', { action: 'approve' }), P()),
  'GET sheets':               () => R.sheets.GET(req('GET')),
  'POST sheets':              () => R.sheets.POST(req('POST', { settlement_ids: [ID] })),
  'GET sheet':                () => R.sheet.GET(req('GET'), P()),
  'PATCH sheet print':        () => R.sheet.PATCH(req('PATCH', { action: 'print' }), P()),
  'GET settings':             () => R.settings.GET(req('GET')),
};

// ── 1. role gates ──
for (const role of ['production_staff', 'sales', 'viewer', 'none']) {
  let leaked = [];
  for (const [name, fn] of Object.entries(CALLS)) {
    reset(role); const r = await run(fn);
    if (r.status !== 403 || calls.rpc.length || calls.selects.length || calls.storage.length) leaked.push(`${name}:${r.status}`);
  }
  ok(`${role}: every route is 403 and nothing is read, written or called`, leaked.length === 0, leaked.join(', '));
}
{
  let bad = [];
  for (const [name, fn] of Object.entries(CALLS)) { reset('anon'); const r = await run(fn); if (r.status !== 401 || calls.rpc.length) bad.push(name); }
  ok('unauthenticated: every route is 401', bad.length === 0, bad.join(', '));
}
for (const role of ['admin', 'production_manager', 'head_of_sales']) {
  let blocked = [];
  for (const [name, fn] of Object.entries(CALLS)) { reset(role); const r = await run(fn); if (r.status === 401 || r.status === 403) blocked.push(`${name}:${r.status}`); }
  ok(`${role}: every route is reachable`, blocked.length === 0, blocked.join(', '));
}

// ── 2. actor and role come from the session, never the body ──
{
  reset('head_of_sales');
  await run(() => R.settlement.PATCH(req('PATCH', { action: 'approve', p_role: 'admin', role: 'admin', p_actor: ID2, actor: ID2, override_reason: 'because' }), P()));
  const c = calls.rpc[0];
  ok('approve: rpc is approve_temporary_settlement with the SESSION actor and role', c.name === 'approve_temporary_settlement' && c.args.p_actor === UID && c.args.p_role === 'head_of_sales', JSON.stringify(c));
  ok('approve: body cannot smuggle a different actor or role', !('role' in c.args) && c.args.p_actor !== ID2 && c.args.p_role !== 'admin');
  ok('approve: override reason is passed through for the database to judge', c.args.p_override_reason === 'because');
  reset('production_manager');
  await run(() => R.settlement.PATCH(req('PATCH', { action: 'pay', received_by_full_name: 'Jane Wanjiru', payment_note: 'counted', p_role: 'admin' }), P()));
  const p = calls.rpc[0];
  ok('pay: names the receiver and note, session identity only', p.name === 'pay_temporary_settlement' && p.args.p_received_by === 'Jane Wanjiru' && p.args.p_note === 'counted' && p.args.p_actor === UID && p.args.p_role === 'production_manager');
}

// ── 3. validation happens before the database ──
const invalid = async (label, fn, re) => { reset(); const r = await run(fn); ok(`validation: ${label}`, r.status === 400 && (!re || re.test(r.body.error)) && calls.rpc.length === 0, JSON.stringify(r)); };
await invalid('engagement without a worker', () => R.engagements.POST(req('POST', { ...VALID_ENG, employee_id: 'nope' })), /worker/);
await invalid('engagement with zero rate', () => R.engagements.POST(req('POST', { ...VALID_ENG, agreed_daily_rate: 0 })), /rate/);
await invalid('engagement with bad date', () => R.engagements.POST(req('POST', { ...VALID_ENG, start_date: '02/11/2026' })), /start date/);
await invalid('engagement list with unknown status', () => R.engagements.GET(req('GET', undefined, 'http://x/api?status=bogus')), /status/);
await invalid('engagement unknown action', () => R.engagement.PATCH(req('PATCH', { action: 'delete' }), P()), /action/);
await invalid('engagement bad id', () => R.engagement.PATCH(req('PATCH', { action: 'activate' }), P('not-a-uuid')), /id/);
await invalid('revise rate needs a positive rate', () => R.engagement.PATCH(req('PATCH', { action: 'revise_rate', new_rate: -5, reason: 'x' }), P()), /rate/);
await invalid('link needs an assignment', () => R.engagement.PATCH(req('PATCH', { action: 'link_assignment' }), P()), /assignment/);
await invalid('settlement kind', () => R.settlements.POST(req('POST', { engagement_id: ID, cutoff_date: '2026-11-30', kind: 'whenever' })), /kind/);
await invalid('settlement cutoff', () => R.settlements.POST(req('POST', { engagement_id: ID, cutoff_date: 'soon', kind: 'threshold' })), /cutoff/);
await invalid('pay with a one-word receiver', () => R.settlement.PATCH(req('PATCH', { action: 'pay', received_by_full_name: 'Jane' }), P()), /full name/);
await invalid('settlement unknown action', () => R.settlement.PATCH(req('PATCH', { action: 'reopen' }), P()), /action/);
await invalid('deduction: statutory type', () => R.sdeductions.POST(req('POST', { deduction_type: 'paye', amount: 10, reason: 'tax', evidence_ref: 'x' }), P()), /type/);
await invalid('deduction: "other" under 20 characters', () => R.sdeductions.POST(req('POST', { deduction_type: 'other', amount: 10, reason: 'misc' }), P()), /at least 20 characters \(4\/20\)/);
await invalid('deduction: advance without a voucher', () => R.sdeductions.POST(req('POST', { deduction_type: 'cash_advance', amount: 10, reason: 'Advance' }), P()), /Advance voucher/);
await invalid('deduction: zero amount', () => R.sdeductions.POST(req('POST', { deduction_type: 'cash_advance', amount: 0, reason: 'Advance', evidence_ref: 'A' }), P()), /above 0/);
await invalid('deduction unknown action', () => R.deduction.PATCH(req('PATCH', { action: 'edit' }), P()), /action/);
await invalid('sheet with no settlements', () => R.sheets.POST(req('POST', { settlement_ids: [] })), /one settlement/);
await invalid('sheet with a non-uuid', () => R.sheets.POST(req('POST', { settlement_ids: ['x'] })), /one settlement/);
await invalid('sheet with two settlements (one settlement per sheet)', () => R.sheets.POST(req('POST', { settlement_ids: [ID, ID2] })), /one settlement/);
await invalid('engagement start 2026-02-30 (impossible calendar date)', () => R.engagements.POST(req('POST', { ...VALID_ENG, start_date: '2026-02-30' })), /start date/i);
await invalid('engagement end 2026-04-31', () => R.engagements.POST(req('POST', { ...VALID_ENG, expected_end_date: '2026-04-31' })), /end date/i);
await invalid('settlement cutoff 2026-02-30', () => R.settlements.POST(req('POST', { engagement_id: ID, cutoff_date: '2026-02-30', kind: 'threshold' })), /cutoff/i);
await invalid('sheet unknown action', () => R.sheet.PATCH(req('PATCH', { action: 'sign' }), P()), /action/);
await invalid('malformed JSON body is treated as empty', () => R.settlement.PATCH(new Request('http://x', { method: 'PATCH', body: '{nope' }), P()), /action/);

// ── 4. the right database function with the right arguments ──
{
  reset('head_of_sales'); const r = await run(() => R.engagements.POST(req('POST', { ...VALID_ENG, notes: 'n'.repeat(900) })));
  const a = calls.rpc[0].args;
  ok('create engagement: 201 via create_temporary_engagement, notes capped, defaults to active', r.status === 201 && calls.rpc[0].name === 'create_temporary_engagement' && a.p_notes.length === 500 && a.p_activate === true && a.p_rate === 1500);
  reset(); await run(() => R.engagements.POST(req('POST', { ...VALID_ENG, activate: false }))); ok('create engagement can be planned', calls.rpc[0].args.p_activate === false);
  reset(); await run(() => R.engagement.PATCH(req('PATCH', { action: 'complete', reason: 'Job finished' }), P()));
  ok('complete -> set_engagement_status completed with reason', calls.rpc[0].name === 'set_engagement_status' && calls.rpc[0].args.p_status === 'completed' && calls.rpc[0].args.p_reason === 'Job finished');
  reset(); await run(() => R.engagement.PATCH(req('PATCH', { action: 'link_assignment', assignment_id: ID2 }), P()));
  ok('link -> link_assignment_to_engagement', calls.rpc[0].name === 'link_assignment_to_engagement' && calls.rpc[0].args.p_assignment === ID2 && calls.rpc[0].args.p_engagement === ID);
  reset(); await run(() => R.settlements.POST(req('POST', { engagement_id: ID, cutoff_date: '2026-11-30', kind: 'early', reason: 'client asked' })));
  ok('prepare -> prepare_temporary_settlement (no entry list accepted: the database takes every eligible entry)', calls.rpc[0].name === 'prepare_temporary_settlement' && !Object.keys(calls.rpc[0].args).some(k => /entr/.test(k)));
  reset(); await run(() => R.settlement.PATCH(req('PATCH', { action: 'void', reason: 'Wrong period' }), P()));
  ok('void -> void_temporary_settlement', calls.rpc[0].name === 'void_temporary_settlement' && calls.rpc[0].args.p_reason === 'Wrong period');
  reset(); await run(() => R.sdeductions.POST(req('POST', { deduction_type: 'damage', amount: '250', reason: 'Broke a blade', evidence_ref: 'EV-1' }), P()));
  ok('add deduction: amount is numeric, attachment path is never taken from the client', calls.rpc[0].name === 'add_settlement_deduction' && calls.rpc[0].args.p_amount === 250 && calls.rpc[0].args.p_path === null);
  reset(); await run(() => R.deduction.PATCH(req('PATCH', { action: 'void', reason: 'entered twice' }), P()));
  ok('void deduction', calls.rpc[0].name === 'void_settlement_deduction' && calls.rpc[0].args.p_reason === 'entered twice');
  reset(); await run(() => R.sheets.POST(req('POST', { settlement_ids: [ID] }))); ok('create sheet (exactly one settlement)', calls.rpc[0].name === 'create_payout_sheet' && calls.rpc[0].args.p_settlement_ids.length === 1);
  for (const [action, fn] of [['approve', 'approve_payout_sheet'], ['print', 'mark_sheet_printed'], ['cancel', 'cancel_payout_sheet']]) {
    reset('admin'); await run(() => R.sheet.PATCH(req('PATCH', { action, reason: 'wrong names' }), P()));
    ok(`sheet ${action} -> ${fn}`, calls.rpc[0]?.name === fn);
  }
}

// ── 5. settings: admin-only writes, NULL limit allowed (fail-closed) ──
{
  reset('head_of_sales'); let r = await run(() => R.settings.PATCH(req('PATCH', { admin_approval_limit_kes: 99999 })));
  ok('settings PATCH: head of sales is 403 and nothing is called', r.status === 403 && calls.rpc.length === 0);
  reset('production_manager'); r = await run(() => R.settings.PATCH(req('PATCH', { admin_approval_limit_kes: 99999 })));
  ok('settings PATCH: production manager is 403', r.status === 403 && calls.rpc.length === 0);
  reset('admin'); r = await run(() => R.settings.PATCH(req('PATCH', { admin_approval_limit_kes: 15000, deduction_total_pct: 20, damage_deductions_enabled: false })));
  ok('settings PATCH: admin passes only known fields', r.status === 200 && calls.rpc[0].args.p_changes.admin_approval_limit_kes === 15000 && calls.rpc[0].args.p_changes.damage_deductions_enabled === false);
  reset('admin'); await run(() => R.settings.PATCH(req('PATCH', { admin_approval_limit_kes: null })));
  ok('settings PATCH: a NULL limit is passed through (fail-closed state)', calls.rpc[0].args.p_changes.admin_approval_limit_kes === null);
  reset('admin'); await run(() => R.settings.PATCH(req('PATCH', { updated_by: ID2, id: false, admin_approval_limit_kes: 'abc' })));
  ok('settings PATCH: junk is rejected before the database', calls.rpc.length === 0);
  reset('admin'); r = await run(() => R.settings.PATCH(req('PATCH', { updated_by: ID2 })));
  ok('settings PATCH: unknown fields alone change nothing (400)', r.status === 400 && calls.rpc.length === 0);
}

// ── 6. database errors are mapped; internals never leak ──
{
  reset(); rpcResult = { data: null, error: { code: 'P0001', message: 'Only a draft settlement can be approved (this one is approved)' } };
  let r = await run(CALLS['PATCH settlement approve']); ok('rule error: 422 with the readable message', r.status === 422 && /Only a draft/.test(r.body.error), JSON.stringify(r));
  reset(); rpcResult = { data: null, error: { code: 'P0001', message: 'Not allowed' } };
  r = await run(CALLS['PATCH settlement approve']); ok('"Not allowed" from the database: 403', r.status === 403);
  reset(); rpcResult = { data: null, error: { code: '23514', message: 'new row for relation "temporary_worker_settlements" violates check constraint "tws_status_fields"' } };
  r = await run(CALLS['PATCH settlement approve']); ok('check-constraint violation: 409 with no constraint or table name', r.status === 409 && !/tws_|temporary_worker/.test(JSON.stringify(r.body)), JSON.stringify(r));
  reset(); rpcResult = { data: null, error: { code: 'XX000', message: 'password authentication failed for user "postgres" at 10.1.2.3' } };
  r = await run(CALLS['PATCH settlement approve']); ok('unexpected error: 500, generic, no internals', r.status === 500 && !/password|10\.1/.test(JSON.stringify(r.body)), JSON.stringify(r));
  reset(); rpcResult = { data: null, error: { code: 'P0001', message: 'A paid settlement is final and cannot be voided' } };
  r = await run(() => R.settlement.PATCH(req('PATCH', { action: 'void', reason: 'oops' }), P())); ok('voiding a paid settlement surfaces the database refusal (422)', r.status === 422 && /final/.test(r.body.error));
}

// ── 6b. a database failure is never disguised as "not found"; genuine no-row is 404 ──
{
  const detail = [
    ['engagement', 'temporary_worker_engagements', () => R.engagement.GET(req('GET'), P())],
    ['settlement', 'temporary_worker_settlements', () => R.settlement.GET(req('GET'), P())],
    ['sheet',      'temporary_worker_payout_sheets', () => R.sheet.GET(req('GET'), P())],
    ['assignments (engagement lookup)', 'temporary_worker_engagements', () => R.assignments.GET(req('GET'), P())],
  ];
  for (const [label, table, fn] of detail) {
    reset('admin'); tableResult = { [`${table}:one`]: { data: null, error: { code: 'XX000', message: 'connection terminated' } } };
    let r = await run(fn); ok(`${label}: database error is 500, not 404`, r.status === 500 && !/connection/.test(JSON.stringify(r.body)), JSON.stringify(r));
    reset('admin'); tableResult = { [`${table}:one`]: { data: null, error: { code: '42P01', message: 'relation does not exist' } } };
    r = await run(fn); ok(`${label}: missing migration is 503 SETUP_INCOMPLETE, not 404`, r.status === 503 && r.body.code === 'SETUP_INCOMPLETE', JSON.stringify(r));
    reset('admin'); tableResult = { [`${table}:one`]: { data: null, error: null } };
    r = await run(fn); ok(`${label}: a genuine no-row result is 404`, r.status === 404, JSON.stringify(r));
  }
  // the engagement detail's due summary must not fail silently
  reset('admin'); tableResult = { 'temporary_worker_engagements:one': { data: { id: ID, status: 'active' }, error: null } };
  rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.temporary_engagement_due' } };
  let r = await run(() => R.engagement.GET(req('GET'), P()));
  ok('engagement detail: a failing due-summary is surfaced (503), not shown as empty', r.status === 503 && r.body.code === 'SETUP_INCOMPLETE', JSON.stringify(r));

  // list: ONE bulk call, only for engagements that can have unsettled work
  reset('admin');
  tableResult = { temporary_worker_engagements: { data: [{ id: ID, status: 'active' }, { id: ID2, status: 'planned' }, { id: UID, status: 'completed' }, { id: '44444444-4444-4444-8444-444444444444', status: 'cancelled' }], error: null } };
  rpcResult = { data: { [ID]: { due: true, eligible_units: 3 }, [UID]: { due: false, eligible_units: 0 }, '44444444-4444-4444-8444-444444444444': { due: false, close_out_due: true, eligible_units: 2 } }, error: null };
  r = await run(() => R.engagements.GET(req('GET')));
  ok('list: a cancelled engagement carries its close-out summary to the client', r.body.engagements.find(e => e.status === 'cancelled')?.due?.close_out_due === true, JSON.stringify(r.body));
  ok('list: exactly one RPC (temporary_engagements_due) for the whole list', calls.rpc.length === 1 && calls.rpc[0].name === 'temporary_engagements_due', JSON.stringify(calls.rpc));
  const CANC = '44444444-4444-4444-8444-444444444444';
  ok('list: the bulk call carries active, completed AND cancelled ids (cancelled work is still owed) but not planned', JSON.stringify(calls.rpc[0].args.p_ids.slice().sort()) === JSON.stringify([ID, UID, CANC].sort()), JSON.stringify(calls.rpc[0].args.p_ids));
  const byId = Object.fromEntries(r.body.engagements.map(e => [e.id, e.due]));
  ok('list: due is attached per engagement; a planned engagement gets null', byId[ID]?.due === true && byId[UID]?.due === false && byId[ID2] === null);
  reset('admin'); tableResult = { temporary_worker_engagements: { data: [{ id: ID, status: 'active' }], error: null } };
  rpcResult = { data: null, error: { code: 'XX000', message: 'boom' } };
  r = await run(() => R.engagements.GET(req('GET')));
  ok('list: a failing bulk summary fails the request (500) rather than showing no figures', r.status === 500, JSON.stringify(r));
  reset('admin'); tableResult = { temporary_worker_engagements: { data: [{ id: ID2, status: 'planned' }], error: null } };
  await run(() => R.engagements.GET(req('GET')));
  ok('list: no RPC at all when nothing can have unsettled work', calls.rpc.length === 0);
}

// ── 7. explicit column allow-lists on every read ──
{
  const BANNED = ['phone', 'bank', 'id_number', 'nssf', 'monthly_salary', 'evidence_path', 'signed_receipt_path', 'password'];
  reset('admin');
  tableResult = { 'temporary_worker_engagements': { data: [{ id: ID, status: 'active' }, { id: ID2, status: 'planned' }], error: null },
    'temporary_worker_engagements:one': { data: { id: ID, employee_id: ID, order_id: ID2 }, error: null },
    'temporary_worker_settlements': { data: [{ id: ID }], error: null },
    'temporary_worker_settlements:one': { data: { id: ID, status: 'draft' }, error: null },
    'temporary_worker_payout_sheets:one': { data: { id: ID, status: 'printed', signed_receipt_path: null }, error: null },
    'production_jobs': { data: [{ id: ID, job_num: 'JOB-1' }], error: null } };
  for (const fn of [CALLS['GET engagements'], CALLS['GET engagement'], CALLS['GET assignments'], CALLS['GET settlements'], CALLS['GET settlement'], CALLS['GET sheets'], CALLS['GET sheet'], CALLS['GET settings']]) await run(fn);
  const bad = calls.selects.filter(s => /\*/.test(s.cols) || BANNED.some(b => s.cols.includes(b)));
  ok(`every select() is an explicit allow-list with no private or storage columns (${calls.selects.length} selects checked)`, calls.selects.length >= 8 && bad.length === 0, JSON.stringify(bad));
  ok('no route wrote to a table directly (all writes go through database functions)', calls.mutations === 0);
}

// ── 8. receipt upload ──
{
  reset('head_of_sales'); tableResult = { 'temporary_worker_payout_sheets:one': { data: { status: 'open' }, error: null } };
  let r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_init', file_name: 'sheet.jpg', file_size: 1000 }), P()));
  ok('receipt_init refused until the sheet is printed', r.status === 400 && calls.storage.length === 0);
  reset('head_of_sales'); tableResult = { 'temporary_worker_payout_sheets:one': { data: { status: 'printed' }, error: null } };
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_init', file_name: 'malware.exe', file_size: 1000 }), P()));
  ok('receipt_init refuses a non-image/PDF file', r.status === 400 && calls.storage.length === 0);
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_init', file_name: 'big.jpg', file_size: 20 * 1024 * 1024 }), P()));
  ok('receipt_init refuses a file over 15 MB', r.status === 400 && calls.storage.length === 0);
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_init', file_name: 'Signed Sheet.JPG', file_size: 2_000_000 }), P()));
  ok('receipt_init returns a signed upload path under this sheet only', r.status === 200 && r.body.path.startsWith(`sheets/${ID}/`) && r.body.token === 'tok' && !/ /.test(r.body.path), JSON.stringify(r));
  reset('head_of_sales');
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_complete', path: `sheets/${ID2}/x.jpg` }), P()));
  ok('receipt_complete refuses a path from another sheet', r.status === 400 && calls.rpc.length === 0);
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_complete', path: `sheets/${ID}/../../secret.jpg` }), P()));
  ok('receipt_complete refuses path traversal', r.status === 400 && calls.rpc.length === 0);
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_complete', path: `sheets/${ID}/123-x.jpg` }), P()));
  ok('receipt_complete refuses an object that is not in storage', r.status === 400 && calls.rpc.length === 0);
  globalThis.__listed = [{ name: '123-x.jpg', metadata: { size: 5000 } }];
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_complete', path: `sheets/${ID}/123-x.jpg` }), P()));
  ok('receipt_complete verifies storage then calls attach_signed_receipt', r.status === 200 && calls.rpc[0].name === 'attach_signed_receipt' && calls.rpc[0].args.p_path === `sheets/${ID}/123-x.jpg`);
  reset('head_of_sales'); globalThis.__listed = [{ name: '123-x.jpg', metadata: { size: 20 * 1024 * 1024 } }];
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_complete', path: `sheets/${ID}/123-x.jpg` }), P()));
  ok('receipt_complete removes an oversized object and records nothing', r.status === 400 && calls.rpc.length === 0 && calls.storage.some(s => s[0] === 'remove'));
  reset('head_of_sales'); tableResult = { 'temporary_worker_payout_sheets:one': { data: { signed_receipt_path: `sheets/${ID}/123-x.jpg` }, error: null } };
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_url' }), P()));
  ok('receipt_url returns a short-lived signed URL, never a raw path', r.status === 200 && r.body.url === 'https://signed/x' && !('path' in r.body));
  reset('head_of_sales'); tableResult = { 'temporary_worker_payout_sheets:one': { data: { signed_receipt_path: null }, error: null } };
  r = await run(() => R.sheet.PATCH(req('PATCH', { action: 'receipt_url' }), P())); ok('receipt_url with no receipt is 404', r.status === 404);
}

// ── 9. payroll entries route maps the engagement-overlap trigger ──
{
  reset('production_manager');
  tableResult = {
    'payroll_runs:one': { data: { status: 'draft', period_start: '2026-11-02', period_end: '2026-11-08', run_type: 'casual' }, error: null },
    'employees:one': { data: { id: ID, name: 'A', type: 'casual', is_active: true, day_rate: 1000, monthly_salary: null, sha_amount: 0 }, error: null },
  };
  // the "already in run" lookup must find nothing; the insert must fail with the trigger's message
  const orig = globalThis.__svc.from;
  globalThis.__svc.from = (t) => {
    if (t === 'payroll_entries') {
      let inserted = false;
      const overlap = { data: null, error: { code: '23514', message: 'TEMP_ENGAGEMENT_OVERLAP: this worker has temporary engagement TE-2026-0001 overlapping this payroll period' } };
      const api = new Proxy({}, { get(_, k) {
        if (k === 'insert') return () => { inserted = true; return api; };
        if (k === 'single') return () => ({ then: (res) => Promise.resolve(inserted ? overlap : { data: null, error: { message: 'none' } }).then(res) });
        return () => api;
      } });
      return api;
    }
    return orig(t);
  };
  const r = await run(() => R.entries.POST(req('POST', { employee_id: ID }), P()));
  globalThis.__svc.from = orig;
  ok('payroll entries POST: overlap trigger becomes a clear 422 with its own code', r.status === 422 && r.body.code === 'TEMP_ENGAGEMENT_OVERLAP' && /temporary engagement/.test(r.body.error) && !/TE-2026/.test(r.body.error), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
