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
  approve:   'app/api/payroll/runs/[id]/approve/route.js',
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
      delete() { op = 'delete'; return api; },
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
      if (op === 'delete') { match.forEach(m => rows.splice(rows.indexOf(m), 1)); return { data: null, error: null }; }
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
    employees: [mkEmp(), { ...mkEmp(), id: 'e2', employee_num: 'EMP-002', name: 'Joe' }, { ...mkEmp(), id: 'e3', employee_num: 'EMP-003', name: 'Pam', type: 'permanent' }],
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
let res;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const call = async (fn) => { const res = await fn(); let body = null; try { body = await res.clone().json(); } catch {} return { status: res.status, body }; };

// ════════ EMPLOYEE DIRECTORY ════════
// Policy: managers (production_manager, head_of_sales) work with day-paid workers in full
// (rate, phone, ID, bank) but never see/write monthly salary, SHA, NSSF; permanent staff are
// shown to them as identity + status only and cannot be edited by them (except activate/deactivate).
const EMP_ADMIN_ONLY = ['monthly_salary', 'sha_amount', 'nssf_number'];
const EMP_WORKER = ['day_rate', 'piece_rate', 'phone', 'id_number', 'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'hire_date', 'notes'];
for (const role of ['admin', 'production_manager', 'head_of_sales']) {
  setup(role);
  const { body } = await call(() => R.empList.GET(req('GET', null, 'http://x/api/payroll/employees')));
  const emp = body.employees[0];
  const perm = body.employees.find(e => e.type === 'permanent');
  ok(`EMP LIST ${role}: identity + status visible`, emp.name === 'Jane' && emp.employee_num === 'EMP-001' && emp.type === 'casual' && emp.is_active === true);
  ok(`EMP LIST ${role}: worker pay details visible`, EMP_WORKER.every(k => k in emp), JSON.stringify(emp));
  if (role === 'admin') {
    ok('EMP LIST admin: salary, SHA, NSSF visible', EMP_ADMIN_ONLY.every(k => k in emp));
    ok('EMP LIST admin: permanent staff full row', EMP_PRIVATE.every(k => k in perm));
  } else {
    ok(`EMP LIST ${role}: salary, SHA, NSSF ABSENT`, hasAny(emp, EMP_ADMIN_ONLY).length === 0, JSON.stringify(hasAny(emp, EMP_ADMIN_ONLY)));
    ok(`EMP LIST ${role}: permanent staff reduced to identity + status`,
      perm && ['id', 'employee_num', 'name', 'type', 'is_active'].every(k => k in perm) && hasAny(perm, [...EMP_PRIVATE, 'day_rate']).length === 0, JSON.stringify(perm));
  }
  ok(`EMP LIST ${role}: no select('*') on employees`, !log.selects.some(([t, s]) => t === 'employees' && s.trim() === '*'));
}
for (const role of ['production_manager', 'head_of_sales', 'admin']) {
  setup(role);
  await R.empList.GET(req('GET', null, 'http://x/api/payroll/employees?search=' + encodeURIComponent('jo,bank_account.ilike.%1%')));
  const f = log.ors[0] || '';
  ok(`EMP SEARCH ${role}: phone matching ${role === 'admin' ? 'allowed' : 'not allowed'}`, /phone\./.test(f) === (role === 'admin'), f);
  ok(`EMP SEARCH ${role}: no injected clause`, !/(^|,)bank_account\./.test(f), f);
}

// creation: managers add day-paid workers with full pay details; salary/SHA/NSSF and permanent staff stay admin-only
for (const [role, body, expectStatus, label] of [
  ['production_manager', { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', id_number: '1', bank_account: '5' }, 201, 'PM adds a casual with phone, ID, bank and rate'],
  ['production_manager', { name: 'New', type: 'skilled_casual' }, 201, 'PM adds a skilled casual'],
  ['head_of_sales',      { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', paybill_number: '4040' }, 201, 'HoS adds a casual with phone and rate'],
  ['production_manager', { name: 'New', type: 'permanent' }, 403, 'PM cannot add permanent staff'],
  ['head_of_sales',      { name: 'New', type: 'permanent' }, 403, 'HoS cannot add permanent staff'],
  ['production_manager', { name: 'New', type: 'casual', monthly_salary: 9 }, 403, 'PM cannot set monthly salary'],
  ['head_of_sales',      { name: 'New', type: 'casual', sha_amount: 1, nssf_number: 'x' }, 403, 'HoS cannot set SHA/NSSF'],
  ['production_staff',   { name: 'New', type: 'casual' }, 403, 'shop floor cannot add employees'],
]) {
  const t = setup(role);
  const r = await call(() => R.empList.POST(req('POST', body)));
  ok(`EMP CREATE: ${label} → ${expectStatus}`, r.status === expectStatus, JSON.stringify(r));
  if (expectStatus === 403) ok(`EMP CREATE: ${label} → nothing inserted`, t.employees.length === 3);
  if (expectStatus === 201) {
    ok(`EMP CREATE: ${label} → saved and no salary/SHA/NSSF in response`,
      t.employees.length === 4 && (!body.phone || t.employees[3].phone === body.phone) && hasAny(r.body.employee, EMP_ADMIN_ONLY).length === 0, JSON.stringify(r.body.employee));
  }
}
let t = setup('admin');
let r = await call(() => R.empList.POST(req('POST', { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', bank_account: '1' })));
ok('EMP CREATE admin may create with private fields and sees them', r.status === 201 && r.body.employee.phone === '0700000000' && t.employees[3].bank_account === '1');

// detail + documents
for (const role of ['production_manager', 'head_of_sales']) {
  setup(role);
  r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
  ok(`EMP DETAIL ${role}: worker details yes, salary/SHA/NSSF no`, EMP_WORKER.every(k => k in r.body.employee) && hasAny(r.body.employee, EMP_ADMIN_ONLY).length === 0, JSON.stringify(r.body.employee));
  ok(`EMP DETAIL ${role}: documents empty and employee_documents never queried`, r.body.documents.length === 0 && !log.tablesRead.includes('employee_documents'));
  setup(role);
  r = await call(() => R.empDetail.GET(req('GET'), P('e3')));
  ok(`EMP DETAIL ${role}: permanent employee shows identity + status only`, hasAny(r.body.employee, [...EMP_PRIVATE, 'day_rate']).length === 0, JSON.stringify(r.body.employee));
}
setup('admin');
r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
ok('EMP DETAIL admin: full profile + documents', EMP_PRIVATE.every(k => k in r.body.employee) && r.body.documents.length === 1);

// updates
for (const [role, id, body, expect, label] of [
  ['production_manager', 'e1', { type: 'permanent' }, 403, 'PM cannot make a worker permanent'],
  ['head_of_sales',      'e1', { type: 'permanent' }, 403, 'HoS cannot make a worker permanent'],
  ['production_manager', 'e1', { monthly_salary: 1 }, 403, 'PM cannot change monthly_salary'],
  ['head_of_sales',      'e1', { sha_amount: 1 }, 403, 'HoS cannot change SHA'],
  ['production_manager', 'e1', { day_rate: 1100, nssf_number: 'z' }, 403, 'PM mixing allowed + forbidden refuses whole request'],
  ['production_manager', 'e3', { phone: '0799' }, 403, 'PM cannot edit a permanent employee'],
  ['head_of_sales',      'e3', { bank_account: '1' }, 403, 'HoS cannot edit a permanent employee'],
  ['production_manager', 'e1', { day_rate: 1100 }, 200, 'PM can change day_rate'],
  ['head_of_sales',      'e1', { day_rate: 1200, phone: '0799', bank_account: '555', bank_name: 'Equity' }, 200, 'HoS can complete phone, bank and rate'],
  ['production_manager', 'e1', { name: 'Jane K', type: 'skilled_casual' }, 200, 'PM can rename and switch between day-paid types'],
  ['head_of_sales',      'e1', { is_active: false }, 200, 'HoS can deactivate'],
  ['production_manager', 'e3', { is_active: false }, 200, 'PM can deactivate permanent staff'],
  ['admin',              'e1', { type: 'permanent', phone: '0799', sha_amount: 400 }, 200, 'admin can change type and private fields'],
]) {
  t = setup(role);
  const before = JSON.stringify(t.employees.find(e => e.id === id));
  r = await call(() => R.empDetail.PATCH(req('PATCH', body), P(id)));
  ok(`EMP PATCH: ${label}`, r.status === expect, JSON.stringify(r));
  if (expect === 403) ok(`EMP PATCH: ${label} → data unchanged`, JSON.stringify(t.employees.find(e => e.id === id)) === before);
  if (expect === 200 && role !== 'admin') ok(`EMP PATCH: ${label} → response has no salary/SHA/NSSF`, hasAny(r.body.employee, EMP_ADMIN_ONLY).length === 0);
  if (expect === 200 && role !== 'admin' && body.phone) ok(`EMP PATCH: ${label} → stored`, t.employees[0].phone === body.phone && t.employees[0].bank_account === body.bank_account);
}
t = setup('production_manager');
r = await call(() => R.empDetail.DELETE(req('DELETE'), P('e1')));
ok('EMP DELETE (deactivate) unchanged for PM', r.status === 200 && t.employees[0].is_active === false);

// ════════ PAYROLL RUN DATA ════════
// Policy: admin, production_manager and head_of_sales may SEE runs and their sums and EDIT them
// (create, add workers, attendance, adjustments, run PDF, order links). Only admin may approve,
// reopen or delete a run, and only admin sees payments, batches, statutory rules and exports.
const runCalls = {
  'runs list GET':       () => R.runsList.GET(req('GET', null, 'http://x/api/payroll/runs')),
  'runs POST':           () => R.runsList.POST(req('POST', { period_type: 'weekly', period_start: '2026-10-12', period_end: '2026-10-18', run_type: 'casual' })),
  'run detail GET':      () => R.runDetail.GET(req('GET'), P('r1')),
  'run PATCH':           () => R.runDetail.PATCH(req('PATCH', { notes: 'edited' }), P('r1')),
  'run DELETE':          () => R.runDetail.DELETE(req('DELETE'), P('r1')),
  'run approve POST':    () => R.approve.POST(req('POST', {}), P('r1')),
  'entries GET':         () => R.entries.GET(req('GET'), P('r1')),
  'entries POST':        () => R.entries.POST(req('POST', { employee_id: 'e2' }), P('r1')),
  'attendance GET':      () => R.attend.GET(req('GET'), P('r1')),
  'adjustments GET':     () => R.adjust.GET(req('GET'), P('r1')),
  'run PDF':             () => R.runPdf.GET(req('GET'), P('r1')),
  'allocations GET':     () => R.alloc.GET(req('GET'), P('en1')),
  'payments GET':        () => R.payments.GET(req('GET'), P('en1')),
  'batches GET':         () => R.batches.GET(req('GET', null, 'http://x/api/payroll/batches')),
  'batches POST':        () => R.batches.POST(req('POST', {})),
  'batch detail GET':    () => R.batchOne.GET(req('GET'), P('b1')),
  'batch preview GET':   () => R.batchPrev.GET(req('GET', null, 'http://x/api/payroll/batches/preview')),
  'chatpesa export':     () => R.chatpesa.GET(req('GET'), P('b1')),
  'statutory GET':       () => R.statutory.GET(req('GET', null, 'http://x/api/payroll/statutory')),
  'employee report PDF': () => R.empReport.GET(req('GET', null, 'http://x/?from=2025-01-01&to=2025-12-31'), P('e1')),
};
// Closed to production_manager AND head_of_sales: nothing is even read.
const closedToBoth = ['run DELETE', 'run approve POST', 'payments GET', 'batches GET', 'batches POST', 'batch detail GET',
  'batch preview GET', 'chatpesa export', 'statutory GET', 'employee report PDF'];
for (const role of ['production_manager', 'head_of_sales']) {
  for (const name of closedToBoth) {
    setup(role);
    const res = await call(runCalls[name]);
    ok(`${role}: ${name} → 403, no data read`, res.status === 403 && log.tablesRead.length === 0, JSON.stringify(res));
  }
}

// Both run roles: see runs WITH sums, no select(*).
for (const role of ['production_manager', 'head_of_sales']) {
  setup(role);
  r = await call(runCalls['runs list GET']);
  ok(`${role} runs list: sees run totals`, r.status === 200 && r.body.runs[0].total_net === 4925 && r.body.runs[0].total_gross === 5400, JSON.stringify(r.body?.runs?.[0]));
  setup(role);
  r = await call(runCalls['run detail GET']);
  ok(`${role} run detail: sees run totals`, r.status === 200 && RUN_MONEY.filter(k => k.startsWith('total_')).every(k => k in r.body.run), JSON.stringify(r.body));
  ok(`${role} run detail: sees entry pay figures (gross, net, deductions)`, r.body.entries[0].gross_pay === 5400 && r.body.entries[0].net_pay === 4925 && r.body.entries[0].total_deductions === 475);
  ok(`${role} run detail: explicit columns, no select(*)`, !log.selects.some(([tb, sel]) => ['payroll_runs', 'payroll_entries'].includes(tb) && /(^|,)\s*\*/.test(sel)), JSON.stringify(log.selects));
  ok(`${role} run detail: employee join carries no phone / monthly salary`, !log.selects.some(([tb, sel]) => tb === 'payroll_entries' && /phone|monthly_salary|bank|id_number/.test(sel)));
  setup(role);
  r = await call(runCalls['entries GET']);
  ok(`${role} entries GET: sees pay figures`, r.status === 200 && ENTRY_MONEY.every(k => k in r.body.entries[0]));
}

// Both run roles: EDIT runs.
for (const role of ['production_manager', 'head_of_sales']) {
  t = setup(role);
  r = await call(runCalls['runs POST']);
  ok(`${role} can create a run`, r.status === 201 && t.payroll_runs.length === 2, JSON.stringify(r));
  t = setup(role);
  r = await call(runCalls['run PATCH']);
  ok(`${role} can edit a run`, r.status === 200 && t.payroll_runs[0].notes === 'edited', JSON.stringify(r));
  t = setup(role);
  r = await call(runCalls['entries POST']);
  ok(`${role} can add a worker to a run`, r.status === 201 && t.payroll_entries.length === 2, JSON.stringify(r));
  setup(role);
  r = await call(runCalls['attendance GET']);
  ok(`${role} can read/save attendance (GET works)`, r.status === 200 && r.body.attendance[0].present === true);
  setup(role);
  r = await call(runCalls['adjustments GET']);
  ok(`${role} can see adjustments`, r.status === 200 && r.body.adjustments.length === 1);
  setup(role);
  r = await call(() => R.adjust.DELETE(req('DELETE', null, 'http://x/api?adj_id=adj1'), P('r1')));
  ok(`${role} adjustments DELETE reaches the handler (not 403)`, r.status !== 403, JSON.stringify(r));
  setup(role);
  r = await call(runCalls['allocations GET']);
  ok(`${role} order links (allocations GET) not 403`, r.status !== 403, JSON.stringify(r));
  setup(role);
  res = await R.runPdf.GET(req('GET'), P('r1'));
  ok(`${role} run PDF not 403`, res.status !== 403);
}

// Unchanged: type rule applies to everyone.
t = setup('head_of_sales');
r = await call(() => R.entries.POST(req('POST', { employee_id: 'e3' }), P('r1')));
ok('head_of_sales cannot add a permanent worker to a casual run (422)', r.status === 422 && r.body.code === 'RUN_TYPE_MISMATCH', JSON.stringify(r));

// Admin keeps everything, including approve reaching the handler.
setup('admin');
r = await call(runCalls['runs list GET']);
ok('ADMIN runs list: totals present', r.status === 200 && r.body.runs[0].total_net === 4925);
setup('admin');
r = await call(runCalls['run detail GET']);
ok('ADMIN run detail: every entry and run money field present', ENTRY_MONEY.every(k => k in r.body.entries[0]) && RUN_MONEY.every(k => k in r.body.run), JSON.stringify(ENTRY_MONEY.filter(k => !(k in r.body.entries[0]))));
setup('admin');
r = await call(runCalls['payments GET']);
ok('ADMIN payments GET: sees phone snapshot', r.status === 200 && r.body.payments[0].phone === '0712345678');
setup('admin');
r = await call(runCalls['batches GET']);
ok('ADMIN batches GET: allowed', r.status !== 403);
setup('admin');
res = await R.approve.POST(req('POST', {}), P('r1'));
ok('ADMIN approve reaches the handler (not 403)', res.status !== 403);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
