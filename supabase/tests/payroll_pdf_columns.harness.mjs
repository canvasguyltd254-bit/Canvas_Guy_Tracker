// Run-PDF column allow-list test. Bundles the REAL route, records every .select() string,
// and fails if any query asks for '*', a join, or an unrelated private column.
//   REPO=$PWD node supabase/tests/payroll_pdf_columns.harness.mjs   (esbuild resolvable from /tmp/rt)
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
export const requireRole = (u, role, roles) => (roles.includes(role) ? null : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
export const serviceClient = new Proxy({}, { get: (_, k) => globalThis.__svc[k] });`);
// Capture what would be handed to the PDF generator instead of spawning it.
writeFileSync('/tmp/rt/cpStub.js', `
import { EventEmitter } from 'node:events';
export const spawn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { write: d => { globalThis.__pdfInput = JSON.parse(d); }, end: () => setTimeout(() => { c.stdout.emit('data', Buffer.from('%PDF')); c.emit('close', 0); }, 0) }; return c; };`);

await esbuild.build({
  entryPoints: [path.join(REPO, 'app/api/payroll/runs/[id]/pdf/route.js')], bundle: true, platform: 'node', format: 'cjs',
  outfile: '/tmp/rt/out/pdf.cjs', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^next\/server$/ }, () => ({ path: '/tmp/rt/nextStub.js' }));
    b.onResolve({ filter: /^child_process$/ }, () => ({ path: '/tmp/rt/cpStub.js' }));
    b.onResolve({ filter: /^@\/shared\/lib\/api-auth$/ }, () => ({ path: '/tmp/rt/apiAuthStub.js' }));
    b.onResolve({ filter: /^@\// }, a => { const base = path.join(REPO, a.path.slice(2));
      for (const ext of ['', '.js']) { try { if (statSync(base + ext).isFile()) return { path: base + ext }; } catch {} } });
  } }],
});
const R = require('/tmp/rt/out/pdf.cjs');

const SECRET = ['phone', 'bank_account', 'snapshot_salary', 'snapshot_day_rate', 'snapshot_sha', 'overtime_rate', 'approved_by', 'monthly_salary', 'notes'];
const projects = (t) => { const rows = {
  payroll_runs: [{ id: 'run1', run_num: 'PR-1', run_type: 'casual', period_start: '2026-10-05', period_end: '2026-10-11', status: 'draft', total_gross: 1, phone: 'x', approved_by: 'u9', notes: 'n' }],
  payroll_entries: [{ id: 'en1', run_id: 'run1', snapshot_name: 'A', snapshot_type: 'casual', days_worked: 5, gross_pay: 5000, sha_deduction: 0, advance_deduction: 0, damage_deduction: 0, other_deductions: 0, total_deductions: 0, net_pay: 5000, amount_paid: 0, payment_status: 'unpaid', snapshot_salary: 99999, snapshot_day_rate: 1000, snapshot_sha: 300, overtime_rate: 200, notes: 'private', phone: '0700' }],
  payroll_adjustments: [{ id: 'a1', entry_id: 'en1', adj_type: 'advance', description: 'd', is_deduction: true, amount: 10, created_at: '2026-10-06', recorded_by: 'u1' }],
}[t]; return rows; };
const selects = [];
globalThis.__svc = { from: (t) => {
  let cols = null, f = [];
  const api = { select(c) { cols = c; selects.push({ t, c }); return api; }, eq(k, v) { f.push(r => r[k] === v); return api; }, in(k, v) { f.push(r => v.includes(r[k])); return api; }, order() { return api; }, single() { api._s = true; return api; },
    then(res, rej) { const keys = cols.split(',').map(s => s.trim()); const m = projects(t).filter(r => f.every(x => x(r))).map(r => Object.fromEntries(keys.filter(k => k in r).map(k => [k, r[k]])));
      return Promise.resolve(api._s ? { data: m[0] ?? null, error: null } : { data: m, error: null }).then(res, rej); } };
  return api; } };

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const call = async (role) => { selects.length = 0; globalThis.__pdfInput = null; globalThis.__ctx = { user: { id: 'u' }, role };
  return R.GET(new Request('http://x'), { params: Promise.resolve({ id: 'run1' }) }); };

for (const role of ['admin', 'production_manager', 'head_of_sales']) {
  const res = await call(role);
  ok(`${role}: 200`, res.status === 200);
  ok(`${role}: no select('*') or join`, selects.length === 3 && selects.every(s => !/\*|\(/.test(s.c)), JSON.stringify(selects));
  ok(`${role}: no unrelated private column requested`, selects.every(s => SECRET.every(k => !s.c.split(',').map(x => x.trim()).includes(k))), JSON.stringify(selects));
  const data = JSON.stringify(globalThis.__pdfInput);
  ok(`${role}: nothing private reaches the PDF generator`, SECRET.every(k => !data.includes(`"${k}"`)), data);
  ok(`${role}: PDF still receives printed fields`, /"net_pay":5000/.test(data) && /"adj_type":"advance"/.test(data) && /"run_num":"PR-1"/.test(data));
}
for (const role of ['production_staff', 'sales', undefined]) {
  const res = await call(role);
  ok(`${role}: 403`, res.status === 403);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
