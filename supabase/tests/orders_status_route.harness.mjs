// Route-level test for app/api/orders/[id]/status/route.js: bundles the REAL route with esbuild and
// swaps serviceClient / auth for fakes. Ad-hoc harness, not part of `npm test`.
//
//   mkdir -p /tmp/rt && cd /tmp/rt && npm init -y && npm i esbuild
//   REPO=/path/to/canvas-guy-tracker node supabase/tests/orders_status_route.harness.mjs
//
// Covers the ROLE rules and RPC error mapping. The database rules themselves are in
// orders_credit_by_payment_terms.pglite.mjs.

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
writeFileSync('/tmp/rt/suspendStub.js', `export const checkOrderSuspended = async () => null;`);

const bundle = (rel, out) => esbuild.build({
  entryPoints: [path.join(REPO, rel)], bundle: true, platform: 'node', format: 'cjs',
  outfile: `/tmp/rt/out/${out}.cjs`, logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^next\/server$/ }, () => ({ path: '/tmp/rt/nextStub.js' }));
      b.onResolve({ filter: /^@\/shared\/lib\/api-auth$/ }, () => ({ path: '/tmp/rt/apiAuthStub.js' }));
      b.onResolve({ filter: /^@\/shared\/lib\/suspendGuard$/ }, () => ({ path: '/tmp/rt/suspendStub.js' }));
      b.onResolve({ filter: /^@\// }, a => {
        const base = path.join(REPO, a.path.slice(2));
        for (const ext of ['', '.js', '/index.js']) { try { if (statSync(base + ext).isFile()) return { path: base + ext }; } catch {} }
        return undefined;
      });
    },
  }],
});
await bundle('app/api/orders/[id]/status/route.js', 'orders_status');
await bundle('app/api/orders/[id]/route.js', 'orders_patch');
const { POST } = require('/tmp/rt/out/orders_status.cjs');
const { PATCH } = require('/tmp/rt/out/orders_patch.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

// ── fake service client ──
function setup(order, { rpcError = null } = {}) {
  const log = { rpc: [], updates: [], activities: 0 };
  globalThis.__svc = {
    from(t) {
      let op = 'select', patch = null;
      const api = {
        select() { return api; }, eq() { return api; }, is() { return api; }, order() { return api; },
        update(v) { op = 'update'; patch = v; return api; },
        insert() { op = 'insert'; return api; },
        single() { return Promise.resolve({ data: order, error: null }); },
        then(res, rej) {
          if (op === 'update') log.updates.push({ t, patch });
          if (op === 'insert' && t === 'order_activities') log.activities++;
          return Promise.resolve({ data: t === 'order_payments' ? [] : null, error: null }).then(res, rej);
        },
      };
      return api;
    },
    rpc(name, args) {
      log.rpc.push({ name, args });
      return Promise.resolve({ error: name === 'advance_order_status' ? rpcError : null });
    },
  };
  return log;
}
const call = async (role, body) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) });
  return { status: res.status, json: await res.json() };
};
const order = (status, extra = {}) => ({ id: 'o1', status, order_num: 'ORD-1', client: 'Acme', total_value: 100000, customer_type: 'retail', payment_terms: '30_day', invoice_journal_entry_id: null, ...extra });
const adv = log => log.rpc.filter(r => r.name === 'advance_order_status');

// ── credit approval is admin / head_of_sales only ──
for (const role of ['sales', 'production_manager', 'production_staff']) {
  const log = setup(order('Quote Approved'));
  const r = await call(role, { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok(`${role} cannot approve credit (403)`, r.status === 403, JSON.stringify(r));
  ok(`  …and the database function was never called`, adv(log).length === 0);
}
{
  const log = setup(order('Quote Approved'));
  const r = await call('head_of_sales', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok('head_of_sales approves credit at KES 100,000', r.status === 200 && adv(log).length === 1, JSON.stringify(r));
  ok('  …approval ref reaches the database function', adv(log)[0]?.args.p_extra.credit_approval_ref === 'APR-1');
}
{
  const log = setup(order('Quote Approved', { total_value: 250000 }));
  const r = await call('head_of_sales', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok('head_of_sales approves exactly at the KES 250,000 cap', r.status === 200, JSON.stringify(r));
}
{
  const log = setup(order('Quote Approved', { total_value: 250001 }));
  const r = await call('head_of_sales', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok('head_of_sales is refused above the cap (403, server-side)', r.status === 403 && /admin/.test(r.json.error), JSON.stringify(r));
  ok('  …and the database function was never called', adv(log).length === 0);
}
{
  const log = setup(order('Quote Approved', { total_value: 900000 }));
  const r = await call('admin', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok('admin approves a large credit order', r.status === 200 && adv(log).length === 1, JSON.stringify(r));
}

// ── Sales cap and refund role, enforced on the server ──
{
  const log = setup(order('Quote Approved', { payment_terms: '50_deposit' }));
  const r = await call('sales', { newStatus: 'Deposit Paid' });
  ok('sales may advance to Deposit Paid', r.status === 200 && adv(log).length === 1, JSON.stringify(r));
}
for (const [from, to] of [['Deposit Paid', 'Material Check'], ['Material Check', 'Production'], ['Ready for Delivery', 'Delivered'], ['Delivered', 'Closed']]) {
  const log = setup(order(from));
  const r = await call('sales', { newStatus: to });
  ok(`sales cannot advance ${from} → ${to} (403)`, r.status === 403 && adv(log).length === 0, JSON.stringify(r));
}
{
  const log = setup(order('Quote Approved'));
  const r = await call('production_staff', { newStatus: 'Cancelled / Refunded', refundReference: 'RF-1' });
  ok('production_staff cannot refund / cancel (403)', r.status === 403 && adv(log).length === 0, JSON.stringify(r));
}
{
  const log = setup(order('Quote Approved'));
  const r = await call('head_of_sales', { newStatus: 'Cancelled / Refunded', refundReference: 'RF-1' });
  ok('head_of_sales can refund', r.status === 200 && adv(log).length === 1, JSON.stringify(r));
}

// ── database errors become clear 4xx messages, not generic 500s ──
const mapped = [
  ['INVALID_TRANSITION: Inquiry -> Production', 422, /Cannot move an order from Quote Approved to Material Check/],
  ['NO_UNPOSTED_PAYMENTS: order x has no unposted deposit payments to post', 422, /Record a deposit payment/],
  ['DEPOSIT_PAYMENT_REQUIRED', 422, /Record a deposit payment/],
  ['CREDIT_LIMIT_EXCEEDED: exposure 1 + order 2 exceeds limit 3', 422, /credit limit/],
  ['DEPOSIT_REQUIRED', 422, /not on credit terms/],
  ['CREDIT_APPROVAL_REQUIRED', 422, /approval reference/],
  ['REFUND_REFERENCE_REQUIRED', 422, /refund reference/],
];
for (const [msg, code, re] of mapped) {
  setup(order('Quote Approved'), { rpcError: { message: msg } });
  const r = await call('admin', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok(`${msg.split(':')[0]} → ${code} with a clear message`, r.status === code && re.test(r.json.error), JSON.stringify(r));
}

// ── send-back ──
{
  const log = setup(order('Material Check', { credit_approval_ref: 'APR-1' }));
  const r = await call('head_of_sales', { newStatus: 'Quote Approved', reason: 'Client change', authorizedBy: 'MD', creditApprovalRef: 'SNEAK', refundReference: 'SNEAK' });
  ok('send-back Material Check → Quote Approved succeeds for head_of_sales', r.status === 200, JSON.stringify(r));
  const u = log.updates.find(x => x.t === 'orders');
  ok('  …changes the status only (refund / credit refs are never set here)', u && Object.keys(u.patch).join() === 'status' && u.patch.status === 'Quote Approved', JSON.stringify(u));
  ok('  …releases the credit exposure', log.rpc.some(x => x.name === 'release_order_credit_exposure'));
  ok('  …without calling advance_order_status', adv(log).length === 0);
}
{
  const log = setup(order('Production'));
  const r = await call('head_of_sales', { newStatus: 'Material Check' });
  ok('send-back Production → Material Check does not release exposure', r.status === 200 && !log.rpc.some(x => x.name === 'release_order_credit_exposure'), JSON.stringify(r));
}
{
  const log = setup(order('Material Check'));
  const r = await call('sales', { newStatus: 'Quote Approved' });
  ok('sales cannot send back (403)', r.status === 403 && log.updates.length === 0, JSON.stringify(r));
}


// ── Sales ceiling also covers repair / return statuses (not in STATUSES, so indexOf() would let them through) ──
for (const to of ['Reported', 'Assessed', 'In Repair', 'QC', 'Redelivered']) {
  const log = setup(order('Reported', { order_type: 'repair' }));
  const r = await call('sales', { newStatus: to });
  ok(`sales cannot move a repair order to ${to} (403)`, r.status === 403 && adv(log).length === 0, JSON.stringify(r));
}
{
  const log = setup(order('Reported', { order_type: 'repair' }));
  const r = await call('production_manager', { newStatus: 'Assessed' });
  ok('production_manager can still advance a repair order', r.status === 200 && adv(log).length === 1, JSON.stringify(r));
}
{
  setup(order('Quote Approved'));
  const r1 = await call('sales', { newStatus: 'Quote Approved' });
  ok('sales may still reach Quote Approved (inside the ceiling)', r1.status !== 403, JSON.stringify(r1));
}

// ── New credit-profile errors are clear 422s ──
for (const msg of ['CREDIT_PROFILE_REQUIRED', 'CREDIT_LIMIT_NOT_SET']) {
  setup(order('Quote Approved'), { rpcError: { message: msg } });
  const r = await call('admin', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok(`${msg} → 422 telling the user to ask an admin to set a limit`, r.status === 422 && /no credit limit set/.test(r.json.error) && /admin/.test(r.json.error), JSON.stringify(r));
}

// ── General PATCH cannot set workflow / credit fields ──
const patch = async (role, body) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) });
  return { status: res.status, json: await res.json() };
};
for (const role of ['sales', 'head_of_sales', 'admin']) {
  const log = setup(order('Quote Approved'));
  const r = await patch(role, {
    notes: 'hello', due_date: '2026-12-01',
    status: 'Production', credit_approval_ref: 'SNEAK', refund_reference: 'SNEAK', payment_terms: '30_day',
    invoice_number: 'INV-FAKE', total_value: 1, subtotal_amount: 1, vat_amount: 1, customer_id: null,
  });
  const u = log.updates.find(x => x.t === 'orders');
  ok(`PATCH (${role}) saves ordinary fields`, r.status === 200 && u && u.patch.notes === 'hello' && u.patch.due_date === '2026-12-01', JSON.stringify({ r, u }));
  const banned = ['status', 'credit_approval_ref', 'refund_reference', 'payment_terms', 'invoice_number', 'total_value', 'subtotal_amount', 'vat_amount'];
  ok(`PATCH (${role}) ignores status, credit/refund refs, payment terms, invoice number and money fields`,
    u && banned.every(k => !(k in u.patch)), JSON.stringify(u?.patch));
}
{
  const log = setup(order('Quote Approved'));
  const r = await patch('sales', { credit_approval_ref: 'SNEAK', payment_terms: '30_day', status: 'Production' });
  ok('PATCH with only protected fields writes nothing', r.status === 200 && !log.updates.some(x => x.t === 'orders'), JSON.stringify({ r, u: log.updates }));
}
{
  setup(order('Quote Approved'));
  const r = await patch('production_staff', { notes: 'x' });
  ok('production_staff still cannot PATCH orders (403)', r.status === 403, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
