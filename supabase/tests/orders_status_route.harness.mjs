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
await bundle('app/api/orders/[id]/credit-position/route.js', 'orders_credit_position');
await bundle('app/api/customers/route.js', 'customers_collection');
await bundle('app/api/customers/[id]/route.js', 'customers_item');
const { POST } = require('/tmp/rt/out/orders_status.cjs');
const { PATCH } = require('/tmp/rt/out/orders_patch.cjs');
const { GET: creditPositionGET } = require('/tmp/rt/out/orders_credit_position.cjs');
const { POST: customersPOST } = require('/tmp/rt/out/customers_collection.cjs');
const { PATCH: customerPATCH } = require('/tmp/rt/out/customers_item.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

// ── fake service client ──
function setup(order, { rpcError = null, itemsRpcError = null, rpcData = {}, payments = [], single = {} } = {}) {
  const log = { rpc: [], updates: [], inserts: [], activities: 0 };
  globalThis.__svc = {
    from(t) {
      let op = 'select', patch = null;
      const api = {
        select() { return api; }, eq() { return api; }, is() { return api; }, order() { return api; },
        update(v) { op = 'update'; patch = v; return api; },
        insert(v) { op = 'insert'; patch = v; return api; },
        single() {
          if (op === 'update') log.updates.push({ t, patch });
          if (op === 'insert') log.inserts.push({ t, patch });
          return Promise.resolve({ data: (t in single) ? single[t] : (t === 'orders' ? order : null), error: null });
        },
        then(res, rej) {
          if (op === 'update') log.updates.push({ t, patch });
          if (op === 'insert') { log.inserts.push({ t, patch }); if (t === 'order_activities') log.activities++; }
          return Promise.resolve({ data: t === 'order_payments' ? payments : null, error: null }).then(res, rej);
        },
      };
      return api;
    },
    rpc(name, args) {
      log.rpc.push({ name, args });
      return Promise.resolve({ data: rpcData[name] ?? null, error: name === 'advance_order_status' ? rpcError : name === 'update_order_items_with_audit' ? itemsRpcError : null });
    },
  };
  return log;
}
const call = async (role, body) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'o1' }) });
  return { status: res.status, json: await res.json() };
};
const order = (status, extra = {}) => ({ id: 'o1', status, order_num: 'ORD-1', client: 'Acme', total_value: 100000, customer_id: 'c1', customer_type: 'retail', payment_terms: '30_day', invoice_journal_entry_id: null, ...extra });
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
  ['CREDIT_LIMIT_EXCEEDED: owed 1 + this order 2 exceeds limit 3', 422, /credit limit/],
  ['CUSTOMER_REQUIRED', 422, /Link this order to a customer/],
  ['CREDIT_LIMIT_NOT_SET', 422, /customer has no credit limit set/],
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
  ok('  …calls no database function at all (exposure is derived from status, nothing to release)', log.rpc.length === 0, JSON.stringify(log.rpc));
}
{
  const log = setup(order('Production'));
  const r = await call('head_of_sales', { newStatus: 'Material Check' });
  ok('send-back Production → Material Check succeeds', r.status === 200 && log.rpc.length === 0, JSON.stringify(r));
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
{
  setup(order('Quote Approved'), { rpcError: { message: 'CREDIT_LIMIT_NOT_SET' } });
  const r = await call('admin', { newStatus: 'Material Check', creditApprovalRef: 'APR-1' });
  ok('CREDIT_LIMIT_NOT_SET → 422 telling the user an admin sets it on the customer page', r.status === 422 && /customer's page/.test(r.json.error), JSON.stringify(r));
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


// ── Order cannot be re-linked to another customer once past Quote Approved ──
for (const status of ['Deposit Paid', 'Material Check', 'Production', 'Delivered']) {
  const log = setup(order(status));
  const r = await patch('sales', { customer_id: 'c2', notes: 'x' });
  ok(`re-linking the customer at ${status} is refused (409)`, r.status === 409 && r.json.code === 'CUSTOMER_LOCKED' && !log.updates.some(x => x.t === 'orders'), JSON.stringify(r));
}
for (const status of ['Inquiry', 'Quote Approved']) {
  const log = setup(order(status));
  const r = await patch('sales', { customer_id: 'c2' });
  const u = log.updates.find(x => x.t === 'orders');
  ok(`re-linking the customer at ${status} is allowed`, r.status === 200 && u && u.patch.customer_id === 'c2', JSON.stringify({ r, u }));
}
{
  const log = setup(order('Production'));
  const r = await patch('sales', { customer_id: 'c1', notes: 'same customer' });
  ok('saving the SAME customer_id at Production is not a re-link (200)', r.status === 200, JSON.stringify(r));
}

// ── Posted invoices: only an admin may change line items (the RPC posts the correcting journal) ──
const itemBody = { reason: 'Only 19 delivered', items: [{ id: 'i1', category: 'Mirrors', description: 'Mirror', quantity: 19, unit_price: 22000 }] };
for (const [role, expected] of [['admin', true], ['head_of_sales', false], ['sales', false]]) {
  const log = setup(order('Quote Approved', { invoice_journal_entry_id: 'j1' }));
  await patch(role, itemBody);
  const c = log.rpc.find(x => x.name === 'update_order_items_with_audit');
  ok(`item edit (${role}): p_allow_posted is ${expected}`, c && c.args.p_allow_posted === expected, JSON.stringify(c));
}
{
  // a client cannot grant itself the switch through the body
  const log = setup(order('Quote Approved', { invoice_journal_entry_id: 'j1' }));
  await patch('head_of_sales', { ...itemBody, p_allow_posted: true, allow_posted: true, allowPosted: true });
  const c = log.rpc.find(x => x.name === 'update_order_items_with_audit');
  ok('a body flag cannot turn the admin switch on for a non-admin', c && c.args.p_allow_posted === false, JSON.stringify(c));
}
{
  setup(order('Delivered', { invoice_journal_entry_id: 'j1' }));
  const r = await patch('sales', itemBody);
  ok('sales cannot change items on a delivered order (403)', r.status === 403, JSON.stringify(r));
}
for (const [msg, status] of [['INVOICE_POSTED: only an admin can correct', 409], ['ACCOUNT_NOT_FOUND: 4600', 409], ['UNBALANCED_JOURNAL: x', 409], ['TOTAL_BELOW_PAYMENTS: x', 409]]) {
  setup(order('Quote Approved', { invoice_journal_entry_id: 'j1' }), { itemsRpcError: { message: msg } });
  const r = await patch('admin', itemBody);
  ok(`${msg.split(':')[0]} → ${status} with a readable message`, r.status === status && typeof r.json.error === 'string', JSON.stringify(r));
}

// ── Credit position endpoint (what the approval modal shows) ──
const position = async (role) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await creditPositionGET(new Request('http://x'), { params: Promise.resolve({ id: 'o1' }) });
  return { status: res.status, json: await res.json() };
};
for (const role of ['sales', 'production_manager', 'production_staff']) {
  setup(order('Quote Approved'));
  const r = await position(role);
  ok(`${role} cannot read the credit position (403)`, r.status === 403, JSON.stringify(r));
}
for (const role of ['admin', 'head_of_sales']) {
  const log = setup(order('Quote Approved'), {
    rpcData: { customer_credit_position: { customer_name: 'KNP', limit: 500000, outstanding: 200000 } },
    payments: [{ amount: 30000 }],
  });
  const r = await position(role);
  ok(`${role}: owed, this order (unpaid), after approval and available are calculated`,
    r.status === 200 && r.json.limit === 500000 && r.json.owed === 200000 && r.json.thisOrder === 70000
    && r.json.afterApproval === 270000 && r.json.available === 300000 && r.json.withinLimit === true, JSON.stringify(r));
  const c = log.rpc.find(x => x.name === 'customer_credit_position');
  ok(`${role}: asks the database function for the order's customer, excluding this order`, c && c.args.p_customer_id === 'c1' && c.args.p_exclude_order === 'o1', JSON.stringify(c));
}
{
  setup(order('Quote Approved'), { rpcData: { customer_credit_position: { customer_name: 'KNP', limit: 500000, outstanding: 480000 } } });
  const r = await position('admin');
  ok('over the limit: reported as not within limit (the modal turns red)', r.status === 200 && r.json.withinLimit === false && r.json.afterApproval === 580000 && r.json.available === 20000, JSON.stringify(r));
}
{
  const log = setup(order('Quote Approved', { customer_id: null }));
  const r = await position('admin');
  ok('order with no linked customer → 422 CUSTOMER_REQUIRED, database not asked', r.status === 422 && r.json.code === 'CUSTOMER_REQUIRED' && log.rpc.length === 0, JSON.stringify(r));
}
{
  setup(order('Quote Approved'), { rpcData: { customer_credit_position: { customer_name: 'KNP Tower', limit: 0, outstanding: 0 } } });
  const r = await position('admin');
  ok('customer with limit 0 → 422 CREDIT_LIMIT_NOT_SET naming the customer', r.status === 422 && r.json.code === 'CREDIT_LIMIT_NOT_SET' && /KNP Tower/.test(r.json.error), JSON.stringify(r));
}

// ── Customers: credit limit / opening balance are admin-only ──
const custCurrent = { credit_limit: 500000, opening_balance: 0, opening_balance_date: null };
const patchCustomer = async (role, body) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await customerPATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'c1' }) });
  return { status: res.status, json: await res.json() };
};
for (const role of ['sales', 'head_of_sales', 'production_manager']) {
  for (const body of [{ credit_limit: 900000 }, { opening_balance: 1 }, { opening_balance_date: '2026-01-01' }, { credit_limit: 900000, phone: '0700' }]) {
    const log = setup(order('Inquiry'), { single: { customers: { ...custCurrent } } });
    const r = await patchCustomer(role, body);
    ok(`${role} cannot change ${Object.keys(body).filter(k => k !== 'phone').join()} (403)`, r.status === 403 && !log.updates.some(x => x.t === 'customers'), JSON.stringify(r));
  }
  const log = setup(order('Inquiry'), { single: { customers: { ...custCurrent } } });
  const r = await patchCustomer(role, { phone: '0700', credit_limit: '500000', opening_balance: '', opening_balance_date: '' });
  const u = log.updates.find(x => x.t === 'customers');
  ok(`${role} can save ordinary fields; the unchanged credit fields the form re-sends are dropped`,
    r.status === 200 && u && u.patch.phone === '0700' && !('credit_limit' in u.patch) && !('opening_balance' in u.patch) && !('opening_balance_date' in u.patch), JSON.stringify({ r, u }));
}
{
  const log = setup(order('Inquiry'), { single: { customers: { ...custCurrent } } });
  const r = await patchCustomer('sales', { credit_limit: 500000 });
  ok('only unchanged credit fields: succeeds with no write', r.status === 200 && !log.updates.some(x => x.t === 'customers'), JSON.stringify(r));
}
{
  const log = setup(order('Inquiry'), { single: { customers: { ...custCurrent } } });
  const r = await patchCustomer('admin', { credit_limit: 900000, opening_balance: 25000, opening_balance_date: '2026-01-01' });
  const u = log.updates.find(x => x.t === 'customers');
  ok('admin can set the credit limit and opening balance', r.status === 200 && u && u.patch.credit_limit === 900000 && u.patch.opening_balance === 25000 && u.patch.opening_balance_date === '2026-01-01', JSON.stringify({ r, u }));
}
const postCustomer = async (role, body) => {
  globalThis.__ctx = { user: { id: 'u1' }, role };
  const res = await customersPOST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
};
for (const role of ['sales', 'head_of_sales', 'production_manager']) {
  for (const extra of [{ credit_limit: 100000 }, { opening_balance: 5000 }, { opening_balance_date: '2026-01-01' }]) {
    const log = setup(order('Inquiry'), { single: { customers: { id: 'new' } } });
    const r = await postCustomer(role, { name: 'New Customer', ...extra });
    ok(`${role} cannot create a customer with ${Object.keys(extra)[0]} (403)`, r.status === 403 && !log.inserts.some(x => x.t === 'customers'), JSON.stringify(r));
  }
  const log = setup(order('Inquiry'), { single: { customers: { id: 'new' } } });
  const r = await postCustomer(role, { name: 'New Customer', credit_limit: '', opening_balance: 0, phone: '0700' });
  const i = log.inserts.find(x => x.t === 'customers');
  ok(`${role} can create a customer with no credit settings (limit stored as 0)`, r.status === 201 && i && i.patch.credit_limit === 0 && i.patch.opening_balance === 0, JSON.stringify({ r, i }));
}
{
  const log = setup(order('Inquiry'), { single: { customers: { id: 'new' } } });
  const r = await postCustomer('admin', { name: 'Credit Customer', credit_limit: 250000, opening_balance: 1000 });
  const i = log.inserts.find(x => x.t === 'customers');
  ok('admin can create a customer with a credit limit and opening balance', r.status === 201 && i && i.patch.credit_limit === 250000 && i.patch.opening_balance === 1000, JSON.stringify({ r, i }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
