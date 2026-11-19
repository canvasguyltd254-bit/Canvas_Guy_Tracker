// Route-level test for role-based payroll data access. Bundles the REAL route handlers with
// esbuild and swaps serviceClient for an in-memory fake that PROJECTS COLUMNS EXACTLY AS
// REQUESTED, so a field a route never selects can never appear in its response.
// Fixtures deliberately contain every money field (snapshot_salary, gross_pay, net_pay,
// deductions, run totals, phone snapshots) so a leak cannot hide behind an empty fixture.
// Ad-hoc harness, not part of `npm test`.
//
//   mkdir -p /tmp/rt && cd /tmp/rt && npm init -y && npm i esbuild
//   REPO=/path/to/canvas-guy-tracker node supabase/tests/payroll_employee_access_routes.harness.mjs

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = process.env.REPO || process.cwd();
const require = createRequire('/tmp/rt/');
const esbuild = require('esbuild');
mkdirSync('/tmp/rt/out', { recursive: true });

writeFileSync('/tmp/rt/nextStub.js', `export const NextResponse = { json: (body, init = {}) => new Response(JSON.stringify(body), { status: init.status || 200, headers: { 'content-type': 'application/json' } }) };`);
writeFileSync('/tmp/rt/apiAuthStub.js', `
export const getAuthContext = async () => globalThis.__ctx;
export const requireRole = (user, role, roles) => (roles.includes(role) ? null : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
export const serviceClient = new Proxy({}, { get: (_, k) => globalThis.__svc[k] });
`);
writeFileSync('/tmp/rt/shaStub.js', `export const resolveShaDeduction = async () => 0;`);

const routes = {
  empList:   'app/api/payroll/employees/route.js',
  empDetail: 'app/api/payroll/employees/[id]/route.js',
  empReport: 'app/api/payroll/employees/[id]/report/pdf/route.js',
  runsList:  'app/api/payroll/runs/route.js',
  runDetail: 'app/api/payroll/runs/[id]/route.js',
  entries:   'app/api/payroll/runs/[id]/entries/route.js',
  attend:    'app/api/payroll/runs/[id]/attendance/route.js',
  adjust:    'app/api/payroll/runs/[id]/adjustments/route.js',
  runPdf:    'app/api/payroll/runs/[id]/pdf/route.js',
  payments:  'app/api/payroll/entries/[id]/payments/route.js',
  alloc:     'app/api/payroll/entries/[id]/allocations/route.js',
  batches:   'app/api/payroll/batches/route.js',
  batchOne:  'app/api/payroll/batches/[id]/route.js',
  batchPrev: 'app/api/payroll/batches/preview/route.js',
  chatpesa:  'app/api/payroll/batches/[id]/chatpesa/route.js',
  statutory: 'app/api/payroll/statutory/route.js',
};
for (const [name, rel] of Object.entries(routes)) {
  await esbuild.build({
    entryPoints: [path.join(REPO, rel)], bundle: true, platform: 'node', format: 'cjs',
    outfile: `/tmp/rt/out/a_${name}.cjs`, logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
    plugins: [{
      name: 'alias',
      setup(b) {
        b.onResolve({ filter: /^next\/server$/ }, () => ({ path: '/tmp/rt/nextStub.js' }));
        b.onResolve({ filter: /^@\/shared\/lib\/api-auth$/ }, () => ({ path: '/tmp/rt/apiAuthStub.js' }));
        b.onResolve({ filter: /^@\/shared\/lib\/resolveShaDeduction$/ }, () => ({ path: '/tmp/rt/shaStub.js' }));
        b.onResolve({ filter: /^@\// }, a => {
          const base = path.join(REPO, a.path.slice(2));
          for (const ext of ['', '.js', '/index.js']) { try { if (statSync(base + ext).isFile()) return { path: base + ext }; } catch {} }
          return undefined;
        });
      },
    }],
  });
}
const R = Object.fromEntries(Object.keys(routes).map(n => [n, require(`/tmp/rt/out/a_${n}.cjs`)]));

// ── in-memory fake with real column projection ──
const log = { selects: [], ors: [], tablesRead: [] };
function project(row, sel) {
  if (!sel || sel.trim() === '*') return { ...row };
  const out = {};
  for (const raw of sel.split(/,(?![^(]*\))/)) {
    const c = raw.trim();
    if (!c || c.includes('(')) continue;                    // joins ignored by the fake
    if (c === '*') { Object.assign(out, row); continue; }
    if (c in row) out[c] = row[c];
  }
  return out;
}
function makeDb(tables) {
  const from = (t) => {
    log.tablesRead.push(t);
    let filters = [], op = 'select', patch = null, single = false, sel = '*';
    const api = {
      select(s) { sel = s ?? '*'; log.selects.push([t, sel]); return api; },
      insert(v) { op = 'insert'; patch = v; return api; },
      upsert() { op = 'upsert'; return api; },
      update(v) { op = 'update'; patch = v; return api; },
      eq(k, v) { filters.push(r => r[k] === v); return api; },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return api; },
      is() { return api; }, order() { return api; }, limit() { return api; }, range() { return api; },
      or(s) { log.ors.push(s); return api; },
      single() { single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const rows = tables[t] || [];
      const match = rows.filter(r => filters.every(f => f(r)));
      if (op === 'upsert') return { data: null, error: null };
      if (op === 'insert') {
        const made = { id: `${t}-${rows.length + 1}`, ...patch }; rows.push(made);
        return { data: single ? project(made, sel) : [project(made, sel)], error: null };
      }
      if (op === 'update') {
        match.forEach(r => Object.assign(r, patch));
        return { data: single ? (match[0] ? project(match[0], sel) : null) : match.map(r => project(r, sel)), error: null };
      }
      const out = match.map(r => project(r, sel));
      if (single) return out.length ? { data: out[0], error: null } : { data: null, error: { message: 'nf' } };
      return { data: out, error: null, count: out.length };
    }
    return api;
  };
  return { from, rpc: async () => ({ data: 'EMP-099', error: null }) };
}

const EMP_PRIVATE = ['monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number', 'id_number', 'phone',
  'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'hire_date', 'notes'];
const ENTRY_MONEY = ['snapshot_day_rate', 'snapshot_salary', 'snapshot_sha', 'overtime_rate', 'overtime_amount', 'gross_pay',
  'sha_deduction', 'advance_deduction', 'damage_deduction', 'other_deductions', 'total_deductions',
  'net_pay', 'amount_paid', 'balance', 'payment_status'];
const RUN_MONEY = ['total_gross', 'total_deductions', 'total_net', 'approved_by', 'approved_at', 'approved_by_name', 'reopen_reason'];

const mkEmp = () => ({
  id: 'e1', employee_num: 'EMP-001', name: 'Jane', type: 'casual', is_active: true, day_rate: 1000,
  monthly_salary: 30000, piece_rate: 50, sha_amount: 300, nssf_number: 'N-1', id_number: '12345678',
  phone: '0712345678', bank_account: '999', bank_name: 'KCB', bank_branch: 'Nairobi', paybill_number: '4040',
  hire_date: '2024-01-01', notes: 'secret note', created_at: '2024-01-01', created_by: 'u0',
});
const mkEntry = () => ({
  id: 'en1', run_id: 'r1', employee_id: 'e1', snapshot_name: 'Jane', snapshot_type: 'casual',
  snapshot_day_rate: 1000, snapshot_salary: 30000, snapshot_sha: 300, days_worked: 5, overtime_hours: 0,
  overtime_rate: 200, overtime_amount: 400, gross_pay: 5400, sha_deduction: 300, advance_deduction: 100,
  damage_deduction: 50, other_deductions: 25, total_deductions: 475, net_pay: 4925, amount_paid: 1000,
  balance: 3925, payment_status: 'part_paid', notes: 'n', created_at: '2025-01-01',
});
const mkRun = () => ({
  id: 'r1', run_num: 'PR-2026-CA-001', period_type: 'weekly', period_start: '2026-10-05', period_end: '2026-10-11',
  run_type: 'casual', status: 'draft', notes: 'run note', reopen_reason: 'fix', approved_by: 'u9',
  approved_at: '2026-10-12', approved_by_name: 'Boss', total_gross: 5400, total_deductions: 475, total_net: 4925,
  employee_count: 1, created_at: '2026-10-01', created_by: 'u0',
});
function setup(role) {
  const tables = {
    employees: [mkEmp(), { ...mkEmp(), id: 'e2', employee_num: 'EMP-002', name: 'Joe' }],
    employee_documents: [{ id: 'd1', employee_id: 'e1', file_name: 'id-copy.pdf', file_path: 'private/x', uploaded_at: '2024-01-02' }],
    payroll_payments: [{ id: 'p1', entry_id: 'en1', employee_id: 'e1', amount: 500, phone: '0712345678', reference: 'ABC', status: 'confirmed', created_at: '2025-01-01' }],
    payroll_entries: [mkEntry()],
    payroll_runs: [mkRun()],
    payroll_attendance: [{ id: 'a1', run_id: 'r1', employee_id: 'e1', work_date: '2026-10-05', present: true, overtime_hours: 200, notes: null, updated_by: 'u1', created_at: 'x' }],
    payroll_adjustments: [{ id: 'adj1', run_id: 'r1', employee_id: 'e1', adj_type: 'advance', amount: 100, is_deduction: true }],
    statutory_rules: [{ rule_type: 'sha', fixed_amount: 300 }],
    payroll_payment_batches: [{ id: 'b1', run_id: 'r1', status: 'draft', total_amount: 4925 }],
    payroll_activities: [],
  };
  log.selects.length = 0; log.ors.length = 0; log.tablesRead.length = 0;
  globalThis.__svc = makeDb(tables);
  globalThis.__ctx = { user: { id: 'u1' }, role, displayName: role };
  return tables;
}
const req = (method, body, url = 'http://x/api') => new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
const P = (id) => ({ params: Promise.resolve({ id }) });
const hasAny = (obj, keys) => keys.filter(k => k in obj);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const call = async (fn) => { const res = await fn(); let body = null; try { body = await res.clone().json(); } catch {} return { status: res.status, body }; };

// ════════ EMPLOYEE DIRECTORY ════════
for (const [role, expectPrivate, expectDayRate] of [['admin', true, true], ['production_manager', false, true], ['head_of_sales', false, false]]) {
  setup(role);
  const { body } = await call(() => R.empList.GET(req('GET', null, 'http://x/api/payroll/employees')));
  const emp = body.employees[0];
  ok(`EMP LIST ${role}: identity + status visible`, emp.name === 'Jane' && emp.employee_num === 'EMP-001' && emp.type === 'casual' && emp.is_active === true);
  ok(`EMP LIST ${role}: day_rate ${expectDayRate ? 'visible' : 'hidden'}`, ('day_rate' in emp) === expectDayRate);
  ok(`EMP LIST ${role}: private fields ${expectPrivate ? 'visible' : 'ABSENT'}`,
    expectPrivate ? EMP_PRIVATE.every(k => k in emp) : hasAny(emp, EMP_PRIVATE).length === 0, JSON.stringify(hasAny(emp, EMP_PRIVATE)));
  ok(`EMP LIST ${role}: no select('*') on employees`, !log.selects.some(([t, s]) => t === 'employees' && s.trim() === '*'));
}
for (const role of ['production_manager', 'head_of_sales', 'admin']) {
  setup(role);
  await R.empList.GET(req('GET', null, 'http://x/api/payroll/employees?search=' + encodeURIComponent('jo,bank_account.ilike.%1%')));
  const f = log.ors[0] || '';
  ok(`EMP SEARCH ${role}: phone matching ${role === 'admin' ? 'allowed' : 'not allowed'}`, /phone\./.test(f) === (role === 'admin'), f);
  ok(`EMP SEARCH ${role}: no injected clause`, !/(^|,)bank_account\./.test(f), f);
}

// creation is admin-only
for (const role of ['production_manager', 'head_of_sales']) {
  const t = setup(role);
  const r = await call(() => R.empList.POST(req('POST', { name: 'New', type: 'casual', day_rate: 900 })));
  ok(`EMP CREATE ${role} → 403 and nothing inserted`, r.status === 403 && r.body.code === 'ADMIN_ONLY' && t.employees.length === 2, JSON.stringify(r));
}
let t = setup('admin');
let r = await call(() => R.empList.POST(req('POST', { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', bank_account: '1' })));
ok('EMP CREATE admin may create with private fields and sees them', r.status === 201 && r.body.employee.phone === '0700000000' && t.employees[2].bank_account === '1');

// detail + documents
for (const role of ['production_manager', 'head_of_sales']) {
  setup(role);
  r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
  ok(`EMP DETAIL ${role}: no private fields`, hasAny(r.body.employee, EMP_PRIVATE).length === 0, JSON.stringify(hasAny(r.body.employee, EMP_PRIVATE)));
  ok(`EMP DETAIL ${role}: documents empty and employee_documents never queried`, r.body.documents.length === 0 && !log.tablesRead.includes('employee_documents'));
}
setup('admin');
r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
ok('EMP DETAIL admin: full profile + documents', EMP_PRIVATE.every(k => k in r.body.employee) && r.body.documents.length === 1);

// updates: type and sensitive fields admin-only
for (const [role, body, expect, label] of [
  ['production_manager', { type: 'permanent' }, 403, 'PM cannot change employee type'],
  ['head_of_sales',      { type: 'permanent' }, 403, 'HoS cannot change employee type'],
  ['production_manager', { bank_account: '555' }, 403, 'PM cannot change bank_account'],
  ['production_manager', { monthly_salary: 1 }, 403, 'PM cannot change monthly_salary'],
  ['production_manager', { day_rate: 1100, phone: '' }, 403, 'PM mixing allowed + forbidden refuses whole request'],
  ['head_of_sales',      { day_rate: 1 }, 403, 'HoS cannot change day_rate'],
  ['production_manager', { day_rate: 1100 }, 200, 'PM can change day_rate'],
  ['production_manager', { name: 'Jane K' }, 200, 'PM can rename'],
  ['head_of_sales',      { is_active: false }, 200, 'HoS can still deactivate'],
  ['admin',              { type: 'permanent', phone: '0799', sha_amount: 400 }, 200, 'admin can change type and private fields'],
]) {
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', body), P('e1')));
  ok(`EMP PATCH: ${label}`, r.status === expect, JSON.stringify(r));
  if (expect === 403) ok(`EMP PATCH: ${label} → data unchanged`, t.employees[0].type === 'casual' && t.employees[0].bank_account === '999' && t.employees[0].monthly_salary === 30000 && t.employees[0].day_rate === 1000);
  if (expect === 200 && role !== 'admin') ok(`EMP PATCH: ${label} → response has no private data`, hasAny(r.body.employee, EMP_PRIVATE).length === 0);
}
t = setup('production_manager');
r = await call(() => R.empDetail.DELETE(req('DELETE'), P('e1')));
ok('EMP DELETE (deactivate) unchanged for PM', r.status === 200 && t.employees[0].is_active === false);

// ════════ PAYROLL RUN DATA ════════
// Head of sales: no payroll-run access of any kind.
const runCalls = {
  'runs list GET':       () => R.runsList.GET(req('GET', null, 'http://x/api/payroll/runs')),
  'runs POST':           () => R.runsList.POST(req('POST', { period_type: 'weekly', period_start: '2026-10-12', period_end: '2026-10-18', run_type: 'casual' })),
  'run detail GET':      () => R.runDetail.GET(req('GET'), P('r1')),
  'run PATCH':           () => R.runDetail.PATCH(req('PATCH', { notes: 'x' }), P('r1')),
  'entries GET':         () => R.entries.GET(req('GET'), P('r1')),
  'entries POST':        () => R.entries.POST(req('POST', { employee_id: 'e2' }), P('r1')),
  'attendance GET':      () => R.attend.GET(req('GET'), P('r1')),
  'attendance POST':     () => R.attend.POST(req('POST', { rows: [] }), P('r1')),
  'adjustments GET':     () => R.adjust.GET(req('GET'), P('r1')),
  'adjustments POST':    () => R.adjust.POST(req('POST', {}), P('r1')),
  'adjustments DELETE':  () => R.adjust.DELETE(req('DELETE', null, 'http://x/api?adj_id=adj1'), P('r1')),
  'run PDF':             () => R.runPdf.GET(req('GET'), P('r1')),
  'payments GET':        () => R.payments.GET(req('GET'), P('en1')),
  'allocations GET':     () => R.alloc.GET(req('GET'), P('en1')),
  'batches GET':         () => R.batches.GET(req('GET', null, 'http://x/api/payroll/batches')),
  'batches POST':        () => R.batches.POST(req('POST', {})),
  'batch detail GET':    () => R.batchOne.GET(req('GET'), P('b1')),
  'batch preview GET':   () => R.batchPrev.GET(req('GET', null, 'http://x/api/payroll/batches/preview')),
  'chatpesa export':     () => R.chatpesa.GET(req('GET'), P('b1')),
  'statutory GET':       () => R.statutory.GET(req('GET', null, 'http://x/api/payroll/statutory')),
  'employee report PDF': () => R.empReport.GET(req('GET', null, 'http://x/?from=2025-01-01&to=2025-12-31'), P('e1')),
};
for (const [name, fn] of Object.entries(runCalls)) {
  setup('head_of_sales');
  const res = await call(fn);
  ok(`HoS: ${name} → 403, no data read`, res.status === 403 && log.tablesRead.length === 0, JSON.stringify(res));
}
// Production manager: admin-only money routes are closed.
const pmClosed = ['adjustments GET', 'adjustments POST', 'adjustments DELETE', 'run PDF', 'payments GET', 'allocations GET',
  'batches GET', 'batches POST', 'batch detail GET', 'batch preview GET', 'chatpesa export', 'statutory GET', 'employee report PDF'];
for (const name of pmClosed) {
  setup('production_manager');
  const res = await call(runCalls[name]);
  ok(`PM: ${name} → 403, no data read`, res.status === 403 && log.tablesRead.length === 0, JSON.stringify(res));
}

// Production manager: attendance routes work, and carry NO money on the wire.
setup('production_manager');
r = await call(runCalls['runs list GET']);
ok('PM runs list: 200, no totals or approval fields', r.status === 200 && r.body.runs.length === 1 && hasAny(r.body.runs[0], [...RUN_MONEY, 'total_outstanding']).length === 0, JSON.stringify(hasAny(r.body.runs[0] || {}, [...RUN_MONEY, 'total_outstanding'])));
ok('PM runs list: still gets run header + head-count', r.body.runs[0].run_num === 'PR-2026-CA-001' && r.body.runs[0].employee_count === 1);
ok('PM runs list: money columns never fetched from entries', !log.selects.some(([tb, s]) => tb === 'payroll_entries' && /gross_pay|net_pay|amount_paid/.test(s)));

setup('production_manager');
r = await call(runCalls['run detail GET']);
ok('PM run detail: 200, run has no money', r.status === 200 && hasAny(r.body.run, RUN_MONEY).length === 0, JSON.stringify(hasAny(r.body.run || {}, RUN_MONEY)));
ok('PM run detail: entries have NO snapshot_salary / gross / net / deductions', r.body.entries.length === 1 && hasAny(r.body.entries[0], ENTRY_MONEY).length === 0, JSON.stringify(hasAny(r.body.entries[0] || {}, ENTRY_MONEY)));
ok('PM run detail: entries still show name, type, days', r.body.entries[0].snapshot_name === 'Jane' && r.body.entries[0].snapshot_type === 'casual' && r.body.entries[0].days_worked === 5);
ok('PM run detail: no select(*) on runs or entries', !log.selects.some(([tb, s]) => ['payroll_runs', 'payroll_entries'].includes(tb) && /(^|,)\s*\*/.test(s)), JSON.stringify(log.selects));

setup('production_manager');
r = await call(runCalls['entries GET']);
ok('PM entries GET: NO money fields on the wire', r.status === 200 && hasAny(r.body.entries[0], ENTRY_MONEY).length === 0, JSON.stringify(hasAny(r.body.entries[0] || {}, ENTRY_MONEY)));
ok('PM entries GET: join carries no day_rate/phone/salary', !log.selects.some(([tb, s]) => tb === 'payroll_entries' && /day_rate|phone|salary/.test(s)), JSON.stringify(log.selects));

t = setup('production_manager');
r = await call(runCalls['entries POST']);
ok('PM entries POST: add worker works (201) and response has NO money', r.status === 201 && hasAny(r.body.entry, ENTRY_MONEY).length === 0 && t.payroll_entries.length === 2, JSON.stringify(r));

setup('production_manager');
r = await call(runCalls['attendance GET']);
ok('PM attendance GET: 200 with attendance rows, no audit fields', r.status === 200 && r.body.attendance[0].present === true && !('updated_by' in r.body.attendance[0]));

t = setup('production_manager');
r = await call(() => R.runDetail.PATCH(req('PATCH', { notes: 'edited' }), P('r1')));
ok('PM run PATCH: works and response has no run money', r.status === 200 && t.payroll_runs[0].notes === 'edited' && hasAny(r.body.run, RUN_MONEY).length === 0, JSON.stringify(r));

t = setup('production_manager');
r = await call(runCalls['runs POST']);
ok('PM runs POST: works and response has no run money', r.status === 201 && hasAny(r.body.run, RUN_MONEY).length === 0, JSON.stringify(r));

// Admin keeps every figure.
setup('admin');
r = await call(runCalls['runs list GET']);
ok('ADMIN runs list: totals present', r.status === 200 && RUN_MONEY.filter(k => k.startsWith('total_')).every(k => k in r.body.runs[0]) && r.body.runs[0].total_net === 4925, JSON.stringify(r.body.runs[0]));
setup('admin');
r = await call(runCalls['run detail GET']);
ok('ADMIN run detail: every entry money field present', ENTRY_MONEY.every(k => k in r.body.entries[0]) && r.body.entries[0].net_pay === 4925, JSON.stringify(ENTRY_MONEY.filter(k => !(k in r.body.entries[0]))));
ok('ADMIN run detail: every run field present', RUN_MONEY.every(k => k in r.body.run), JSON.stringify(RUN_MONEY.filter(k => !(k in r.body.run))));
setup('admin');
r = await call(runCalls['entries GET']);
ok('ADMIN entries GET: full money row', ENTRY_MONEY.every(k => k in r.body.entries[0]));
setup('admin');
r = await call(runCalls['adjustments GET']);
ok('ADMIN adjustments GET: allowed', r.status === 200 && r.body.adjustments.length === 1);
setup('admin');
r = await call(runCalls['payments GET']);
ok('ADMIN payments GET: sees phone snapshot', r.status === 200 && r.body.payments[0].phone === '0712345678');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
