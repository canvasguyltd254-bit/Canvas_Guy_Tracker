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
  changes:   'app/api/payroll/employee-changes/route.js',
  changeOne: 'app/api/payroll/employee-changes/[id]/route.js',
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
const log = { selects: [], ors: [], tablesRead: [], rpc: [] };
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
      maybeSingle() { single = true; return api; },
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
  return {
    from,
    rpc: async (name, args) => {
      log.rpc.push({ name, args });
      if (name === 'next_employee_num') return { data: 'EMP-099', error: null };
      if (name === 'approve_payroll_run') return { data: { total_gross: 5400, total_deductions: 475, total_net: 4925, employee_count: 1 }, error: null };
      if (name === 'submit_employee_onboarding') {
        const data = { ...args.p_fields, id: 'new', created_by: args.p_actor, is_active: false, onboarding_status: 'pending' };
        tables.employees.push(data);
        tables.employee_change_requests.push({ employee_id: data.id, kind: 'onboarding', status: 'pending' });
        return { data, error: null };
      }
      if (name === 'approve_employee_change' && globalThis.__rpcError === 'STALE_OUTCOME') {
        tables.employee_change_requests[0].status = 'stale';
        return { data: { status: 'stale' }, error: null };
      }
      return { data: { ok: true }, error: globalThis.__rpcError ? { message: globalThis.__rpcError } : null };
    },
  };
}

const EMP_PRIVATE = ['monthly_salary', 'piece_rate', 'sha_amount', 'nssf_number', 'id_number', 'phone',
  'bank_account', 'bank_name', 'bank_branch', 'paybill_number', 'hire_date', 'notes'];
const ENTRY_MONEY = ['snapshot_day_rate', 'snapshot_salary', 'snapshot_sha', 'overtime_rate', 'overtime_amount', 'gross_pay',
  'sha_deduction', 'advance_deduction', 'damage_deduction', 'other_deductions', 'total_deductions',
  'net_pay', 'amount_paid', 'balance', 'payment_status'];
const RUN_MONEY = ['total_gross', 'total_deductions', 'total_net', 'approved_by', 'approved_at', 'approved_by_name', 'reopen_reason'];

const mkEmp = () => ({
  id: 'e1', employee_num: 'EMP-001', name: 'Jane', type: 'casual', is_active: true, onboarding_status: 'approved', day_rate: 1000,
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
    employee_change_requests: [],
  };
  globalThis.__rpcError = null; log.rpc.length = 0;
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
// Policy: admin and both managers see the full profile (phone search included) and ADD employees with
// every field. After that only an admin edits directly; a manager's change is logged as a request that
// an admin approves. Managers still activate/deactivate directly. Documents stay admin-only.
for (const role of ['admin', 'production_manager', 'head_of_sales']) {
  setup(role);
  const { body } = await call(() => R.empList.GET(req('GET', null, 'http://x/api/payroll/employees')));
  const emp = body.employees[0];
  ok(`EMP LIST ${role}: full profile visible (rate, phone, bank, salary, SHA, NSSF)`, EMP_PRIVATE.every(k => k in emp) && 'day_rate' in emp, JSON.stringify(emp));
  ok(`EMP LIST ${role}: no select('*') on employees`, !log.selects.some(([t, s]) => t === 'employees' && s.trim() === '*'));
  setup('production_staff');
}
{
  setup('production_staff');
  const r = await call(() => R.empList.GET(req('GET', null, 'http://x/api/payroll/employees')));
  ok('EMP LIST shop floor → 403', r.status === 403);
}
for (const role of ['production_manager', 'head_of_sales', 'admin']) {
  setup(role);
  await R.empList.GET(req('GET', null, 'http://x/api/payroll/employees?search=' + encodeURIComponent('jo,bank_account.ilike.%1%')));
  const f = log.ors[0] || '';
  ok(`EMP SEARCH ${role}: phone matching allowed`, /phone\./.test(f), f);
  ok(`EMP SEARCH ${role}: no injected clause`, !/(^|,)bank_account\./.test(f), f);
}

// creation
for (const [role, body, expectStatus, label] of [
  ['production_manager', { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', id_number: '1', bank_account: '5', sha_amount: 300, nssf_number: 'N1' }, 201, 'PM adds a worker with every field'],
  ['head_of_sales',      { name: 'New', type: 'skilled_casual', day_rate: 1500, phone: '0700000001', paybill_number: '4040' }, 201, 'HoS adds a worker with phone, rate, paybill'],
  ['production_manager', { name: 'New', type: 'permanent', monthly_salary: 50000 }, 201, 'PM may add permanent staff'],
  ['production_staff',   { name: 'New', type: 'casual' }, 403, 'shop floor cannot add employees'],
  ['head_of_sales',      { type: 'casual' }, 400, 'name is required'],
  ['head_of_sales',      { name: 'X', type: 'bogus' }, 400, 'type must be valid'],
  ['head_of_sales',      { name: 'X', type: 'casual', day_rate: -1 }, 400, 'negative rate refused'],
  ['head_of_sales',      { name: 'X', type: 'casual', hire_date: '2026-02-30' }, 400, 'impossible date refused'],
]) {
  const t = setup(role);
  const r = await call(() => R.empList.POST(req('POST', body)));
  ok(`EMP CREATE: ${label} → ${expectStatus}`, r.status === expectStatus, JSON.stringify(r));
  if (expectStatus !== 201) ok(`EMP CREATE: ${label} → nothing inserted`, t.employees.length === 3);
  if (expectStatus === 201) {
    ok(`EMP CREATE: ${label} → saved as sent`, t.employees.length === 4 && (!body.phone || t.employees[3].phone === body.phone) && t.employees[3].created_by === 'u1', JSON.stringify(t.employees[3]));
    ok(`EMP CREATE: ${label} → atomic onboarding RPC, pending and inactive`,
      log.rpc.some(x => x.name === 'submit_employee_onboarding' && x.args.p_role === role)
      && r.body.employee.onboarding_status === 'pending' && r.body.employee.is_active === false);
  }
}
let t = setup('admin');
let r = await call(() => R.empList.POST(req('POST', { name: 'New', type: 'casual', day_rate: 900, phone: '0700000000', bank_account: '1' })));
ok('EMP CREATE admin also submits for approval', r.status === 201 && r.body.employee.onboarding_status === 'pending' && t.employees[3].bank_account === '1');
r = await call(() => R.empDetail.PATCH(req('PATCH', { is_active: true }), P('new')));
ok('Even admin cannot activate outside onboarding approval', r.status === 409 && !t.employees[3].is_active);
r = await call(() => R.entries.POST(req('POST', { employee_id: 'new' }), P('r1')));
ok('Even admin cannot add a pending employee to payroll', r.status === 422 && r.body.code === 'EMPLOYEE_ONBOARDING_REQUIRED' && t.payroll_entries.length === 1);

// detail + documents
for (const role of ['production_manager', 'head_of_sales']) {
  setup(role);
  r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
  ok(`EMP DETAIL ${role}: full profile`, EMP_PRIVATE.every(k => k in r.body.employee));
  ok(`EMP DETAIL ${role}: documents empty and employee_documents never queried`, r.body.documents.length === 0 && !log.tablesRead.includes('employee_documents'));
}
setup('admin');
r = await call(() => R.empDetail.GET(req('GET'), P('e1')));
ok('EMP DETAIL admin: full profile + documents', EMP_PRIVATE.every(k => k in r.body.employee) && r.body.documents.length === 1);

// manager edits are REQUESTS: nothing changes until an admin approves
for (const role of ['production_manager', 'head_of_sales']) {
  for (const [body, label] of [
    [{ day_rate: 1200, reason: 'rate review' }, 'new rate'],
    [{ phone: '0799000111', reason: 'new M-Pesa number' }, 'new phone'],
    [{ bank_account: '555', bank_name: 'Equity', reason: 'switched bank' }, 'new bank details'],
    [{ sha_amount: 400, nssf_number: 'N-9', reason: 'statutory update' }, 'SHA and NSSF'],
    [{ monthly_salary: 31000, reason: 'raise' }, 'salary'],
    [{ name: 'Jane Kamau', reason: 'surname' }, 'rename'],
  ]) {
    t = setup(role);
    const before = JSON.stringify(t.employees[0]);
    r = await call(() => R.empDetail.PATCH(req('PATCH', body), P('e1')));
    ok(`REQUEST ${role}: ${label} → 202 and logged as pending`, r.status === 202 && r.body.changeRequest?.status === 'pending' && t.employee_change_requests.length === 1, JSON.stringify(r));
    ok(`REQUEST ${role}: ${label} → employee row NOT changed`, JSON.stringify(t.employees[0]) === before);
    const rq = t.employee_change_requests[0];
    const f = Object.keys(body).filter(k => k !== 'reason')[0];
    ok(`REQUEST ${role}: ${label} → stores old and new, who and why`, rq.changes[f].old === (t.employees[0][f]) && String(rq.changes[f].new) === String(body[f]) && rq.reason === body.reason && rq.requested_by === 'u1' && rq.requested_by_role === role, JSON.stringify(rq));
    ok(`REQUEST ${role}: ${label} → activity log has old→new`, t.payroll_activities.some(a => a.activity_type === 'change_requested' && !!a.old_value && !!a.new_value));
  }
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { phone: '0799' }), P('e1')));
  ok(`REQUEST ${role}: reason is required (422)`, r.status === 422 && r.body.code === 'REASON_REQUIRED' && t.employee_change_requests.length === 0, JSON.stringify(r));
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { phone: '0712345678', day_rate: 1000, reason: 'no real change' }), P('e1')));
  ok(`REQUEST ${role}: a request that changes nothing is refused (400) and logs nothing`, r.status === 400 && r.body.code === 'NO_CHANGE' && t.employee_change_requests.length === 0, JSON.stringify(r));
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { day_rate: 'abc', reason: 'typo' }), P('e1')));
  ok(`REQUEST ${role}: a non-numeric rate is refused (400)`, r.status === 400 && t.employee_change_requests.length === 0, JSON.stringify(r));
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { type: 'bogus', reason: 'x1x' }), P('e1')));
  ok(`REQUEST ${role}: an invalid type is refused (400)`, r.status === 400 && t.employee_change_requests.length === 0, JSON.stringify(r));
  // activate / deactivate stays direct; mixing applies is_active now and requests the rest
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { is_active: false }), P('e1')));
  ok(`${role} can deactivate directly`, r.status === 200 && t.employees[0].is_active === false && t.employee_change_requests.length === 0, JSON.stringify(r));
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { is_active: false, day_rate: 1300, reason: 'rate' }), P('e1')));
  ok(`${role}: mixed update refused without writing anything`, r.status === 422 && t.employees[0].is_active === true && Number(t.employees[0].day_rate) === 1000 && t.employee_change_requests.length === 0, JSON.stringify(r));
  // role cannot sneak a decision through the PATCH body
  t = setup(role);
  r = await call(() => R.empDetail.PATCH(req('PATCH', { status: 'approved', created_by: 'x', id: 'zzz', reason: 'sneak' }), P('e1')));
  ok(`${role}: unknown/system fields are ignored (400, nothing written)`, r.status === 400 && t.employee_change_requests.length === 0, JSON.stringify(r));
}
{
  t = setup('production_staff');
  r = await call(() => R.empDetail.PATCH(req('PATCH', { phone: '0799', reason: 'abc' }), P('e1')));
  ok('shop floor cannot request or edit (403)', r.status === 403 && t.employee_change_requests.length === 0);
}
// admin edits directly, no request created
t = setup('admin');
r = await call(() => R.empDetail.PATCH(req('PATCH', { type: 'permanent', phone: '0799', sha_amount: 400, bank_account: '77' }), P('e1')));
ok('admin edits directly (200) and no request is created', r.status === 200 && t.employees[0].phone === '0799' && Number(t.employees[0].sha_amount) === 400 && t.employee_change_requests.length === 0, JSON.stringify(r));

// ── change requests: list + decide ──
const decide = (id, body) => call(() => R.changeOne.POST(req('POST', body), P(id)));
for (const role of ['production_manager', 'head_of_sales']) {
  t = setup(role);
  r = await decide('c1', { action: 'approve' });
  ok(`DECIDE ${role}: cannot approve (403), RPC never called`, r.status === 403 && log.rpc.length === 0, JSON.stringify(r));
  r = await decide('c1', { action: 'reject', note: 'nope' });
  ok(`DECIDE ${role}: cannot reject (403)`, r.status === 403 && log.rpc.length === 0);
  setup(role);
  r = await call(() => R.changes.GET(req('GET', null, 'http://x/api/payroll/employee-changes?status=pending')));
  ok(`CHANGES LIST ${role}: can see what is pending`, r.status === 200 && Array.isArray(r.body.requests));
}
t = setup('admin');
r = await decide('c1', { action: 'approve' });
ok('DECIDE admin: approve calls approve_employee_change with the admin id', r.status === 200 && log.rpc.length === 1 && log.rpc[0].name === 'approve_employee_change' && log.rpc[0].args.p_request_id === 'c1' && log.rpc[0].args.p_decided_by === 'u1', JSON.stringify({ r, rpc: log.rpc }));
t = setup('admin');
r = await decide('c1', { action: 'reject' });
ok('DECIDE admin: rejecting needs a reason (422), RPC not called', r.status === 422 && log.rpc.length === 0, JSON.stringify(r));
r = await decide('c1', { action: 'reject', note: 'number not verified' });
ok('DECIDE admin: reject with a reason calls reject_employee_change', r.status === 200 && log.rpc[0].name === 'reject_employee_change' && log.rpc[0].args.p_note === 'number not verified');
r = await decide('c1', { action: 'maybe' });
ok('DECIDE admin: unknown action → 400', r.status === 400);
for (const [err, status, code] of [['NOT_PENDING: already approved', 409, 'NOT_PENDING'], ['REQUEST_NOT_FOUND', 404, undefined], ['STALE_OUTCOME', 409, 'STALE_REQUEST'], ['INVALID_FIELD: id', 422, 'INVALID_VALUE']]) {
  t = setup('admin'); globalThis.__rpcError = err;
  t.employee_change_requests.push({ id: 'c1', status: 'pending' });
  r = await decide('c1', { action: 'approve' });
  ok(`DECIDE admin: ${err.split(':')[0]} → ${status}`, r.status === status && (code === undefined || r.body.code === code), JSON.stringify(r));
  if (code === 'STALE_REQUEST') ok('DECIDE admin: a stale request is marked stale so it leaves the pending list', t.employee_change_requests[0].status === 'stale');
}
globalThis.__rpcError = null;

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
ok('ADMIN approve reaches the handler and succeeds', res.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
