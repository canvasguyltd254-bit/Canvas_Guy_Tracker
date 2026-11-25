// Route-level test for the run-type guard: bundles the REAL route handlers with esbuild and
// swaps serviceClient for a tiny in-memory fake. Ad-hoc harness, not part of `npm test`.
//
//   mkdir -p /tmp/rt && cd /tmp/rt && npm init -y && npm i esbuild
//   REPO=/path/to/canvas-guy-tracker node supabase/tests/payroll_run_type_routes.harness.mjs
//
// (Needs esbuild resolvable from /tmp/rt.)

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
  entries: 'app/api/payroll/runs/[id]/entries/route.js',
  runPatch: 'app/api/payroll/runs/[id]/route.js',
};
for (const [name, rel] of Object.entries(routes)) {
  await esbuild.build({
    entryPoints: [path.join(REPO, rel)], bundle: true, platform: 'node', format: 'cjs',
    outfile: `/tmp/rt/out/p_${name}.cjs`, logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
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
const R = Object.fromEntries(Object.keys(routes).map(n => [n, require(`/tmp/rt/out/p_${n}.cjs`)]));

// ── tiny in-memory fake of the supabase-js builder ──
function makeDb(tables) {
  const from = (t) => {
    let rows = tables[t], filters = [], op = 'select', patch = null, wantSingle = false;
    const api = {
      select() { return api; },
      insert(v) { op = 'insert'; patch = Array.isArray(v) ? v : [v]; return api; },
      upsert(v) { op = 'upsert'; patch = v; return api; },
      update(v) { op = 'update'; patch = v; return api; },
      eq(k, v) { filters.push(r => r[k] === v); return api; },
      order() { return api; },
      single() { wantSingle = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const match = rows.filter(r => filters.every(f => f(r)));
      if (op === 'insert') { const made = patch.map((p, i) => ({ id: `${t}-${rows.length + i + 1}`, ...p })); rows.push(...made); return { data: wantSingle ? made[0] : made, error: null }; }
      if (op === 'upsert') return { data: null, error: null };
      if (op === 'update') { match.forEach(r => Object.assign(r, patch)); return { data: wantSingle ? match[0] ?? null : match, error: null }; }
      if (wantSingle) return match.length ? { data: match[0], error: null } : { data: null, error: { message: 'not found' } };
      return { data: match, error: null };
    }
    return api;
  };
  return { from };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const EMP = {
  cas:  { id: 'e-cas',  name: 'Cas',  type: 'casual',         is_active: true, onboarding_status: 'approved', day_rate: 1000, sha_amount: 300 },
  perm: { id: 'e-perm', name: 'Perm', type: 'permanent',      is_active: true, onboarding_status: 'approved', monthly_salary: 30000, sha_amount: 300 },
  sk:   { id: 'e-sk',   name: 'Sk',   type: 'skilled_casual', is_active: true, onboarding_status: 'approved', day_rate: 1500, sha_amount: 300 },
  temp: { id: 'e-temp', name: 'Tmp',  type: 'temporary',      is_active: true, onboarding_status: 'approved', day_rate: 1200, sha_amount: 0 },
  off:  { id: 'e-off',  name: 'Off',  type: 'casual',         is_active: false, onboarding_status: 'approved' },
};
function fresh(runType, existingEntries = []) {
  const tables = {
    payroll_runs: [{ id: 'run1', status: 'draft', run_type: runType, period_start: '2026-10-05', period_end: '2026-10-11' }],
    employees: Object.values(EMP).map(e => ({ ...e })),
    payroll_entries: existingEntries.map((t, i) => ({ id: `x${i}`, run_id: 'run1', employee_id: `old${i}`, snapshot_type: t })),
    payroll_attendance: [],
  };
  globalThis.__svc = makeDb(tables);
  globalThis.__ctx = { user: { id: 'u1' }, role: 'admin', displayName: 'Admin' };
  return tables;
}
const post = async (runType, empId, existing) => {
  const tables = fresh(runType, existing);
  const res = await R.entries.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ employee_id: empId }) }), { params: Promise.resolve({ id: 'run1' }) });
  return { status: res.status, body: await res.json(), tables };
};

let r = await post('permanent', 'e-cas');
ok('API: casual worker cannot enter permanent run (422)', r.status === 422 && r.body.code === 'RUN_TYPE_MISMATCH', JSON.stringify(r));
ok('API: nothing inserted on rejection', r.tables.payroll_entries.length === 0);
r = await post('casual', 'e-perm');
ok('API: permanent worker cannot enter casual run (422)', r.status === 422, JSON.stringify(r));
r = await post('casual', 'e-sk');
ok('API: skilled casual cannot enter casual run (422)', r.status === 422);
r = await post('combined', 'e-temp');
ok('API: unknown/future type cannot enter combined run (422)', r.status === 422 && /cannot be paid through a payroll run/.test(r.body.error), JSON.stringify(r));
for (const [run, emp, label] of [['casual', 'e-cas', 'casual→casual'], ['permanent', 'e-perm', 'permanent→permanent'], ['skilled_casual', 'e-sk', 'skilled→skilled']]) {
  r = await post(run, emp);
  ok(`API: ${label} still works (201)`, r.status === 201 && r.tables.payroll_entries.length === 1, JSON.stringify(r));
}
for (const emp of ['e-cas', 'e-perm', 'e-sk']) {
  r = await post('combined', emp);
  ok(`API: ${emp} can enter a combined run (201)`, r.status === 201, JSON.stringify(r));
}
ok('API: casual entry still seeds attendance rows path (no error)', (await post('casual', 'e-cas')).status === 201);
r = await post('casual', 'e-off');
ok('API: inactive worker still refused first (400)', r.status === 400);

// ── PATCH run_type ──
const patch = async (runType, existing, body) => {
  const tables = fresh(runType, existing);
  const res = await R.runPatch.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'run1' }) });
  return { status: res.status, body: await res.json(), tables };
};
r = await patch('combined', ['casual', 'permanent'], { run_type: 'casual' });
ok('PATCH: cannot narrow a mixed run to casual (409)', r.status === 409 && r.body.code === 'RUN_TYPE_MISMATCH', JSON.stringify(r));
ok('PATCH: run_type unchanged after rejection', r.tables.payroll_runs[0].run_type === 'combined');
r = await patch('casual', ['casual'], { run_type: 'combined' });
ok('PATCH: widening to combined is allowed (200)', r.status === 200 && r.tables.payroll_runs[0].run_type === 'combined', JSON.stringify(r));
r = await patch('casual', [], { run_type: 'permanent' });
ok('PATCH: empty run may change type (200)', r.status === 200);
r = await patch('casual', [], { run_type: 'bogus' });
ok('PATCH: invalid run_type refused (400)', r.status === 400);
r = await patch('casual', ['casual'], { notes: 'hello' });
ok('PATCH: notes-only edit unaffected (200)', r.status === 200 && r.tables.payroll_runs[0].notes === 'hello');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
