// UI behaviour test for Payroll → Temporary Workers. Bundles the REAL components with esbuild, mounts them in jsdom
// with React 19, a fake fetch and stubbed auth/supabase, then clicks through the screens as each role.
// Ad-hoc harness, not part of `npm test`.
//
//   mkdir -p /tmp/rt && cd /tmp/rt && npm init -y && npm i esbuild jsdom
//   REPO=/path/to/canvas-guy-tracker node supabase/tests/temporary_workers_ui.harness.mjs

import { createRequire } from 'node:module';
import { writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = process.env.REPO || process.cwd();
const require = createRequire('/tmp/rt/');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

writeFileSync('/tmp/rt/uiAuthStub.js', `export const useAuth = () => window.__auth;`);
writeFileSync('/tmp/rt/uiSupabaseStub.js', `
export const createClient = () => ({
  from: () => { const q = { select: () => q, order: () => q, limit: async () => ({ data: window.__orders }) }; return q; },
});`);
writeFileSync('/tmp/rt/uiEntry.js', `
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TemporaryWorkersTab from '${path.join(REPO, 'modules/payroll/components/TemporaryWorkersTab.js')}';
export { React, act, createRoot, TemporaryWorkersTab };`);

await esbuild.build({
  entryPoints: ['/tmp/rt/uiEntry.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'App', outfile: '/tmp/rt/out/ui.js',
  loader: { '.js': 'jsx' }, jsx: 'automatic', logLevel: 'error', nodePaths: [path.join(REPO, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'alias', setup(b) {
    b.onResolve({ filter: /^@\/shared\/context\/AuthContext$/ }, () => ({ path: '/tmp/rt/uiAuthStub.js' }));
    b.onResolve({ filter: /^@\/shared\/supabase\/client$/ }, () => ({ path: '/tmp/rt/uiSupabaseStub.js' }));
    b.onResolve({ filter: /^@\// }, a => { const base = path.join(REPO, a.path.slice(2));
      for (const ext of ['', '.js', '/index.js']) { try { if (statSync(base + ext).isFile()) return { path: base + ext }; } catch {} } });
  } }],
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent']) { try { globalThis[k] = window[k]; } catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); } }
window.IS_REACT_ACT_ENVIRONMENT = true;
window.MessageChannel = MessageChannel;
window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.__prompts = 0; window.prompt = () => { window.__prompts++; return 'prompted reason'; };
window.open = () => ({ document: { write() {}, close() {} } });
window.eval(`${await (await import('node:fs/promises')).readFile('/tmp/rt/out/ui.js', 'utf8')}; window.__App = App;`);
const { React, act, createRoot, TemporaryWorkersTab } = window.__App;

// ── fake backend ──
const USER = 'u-me', OTHER = 'u-other';
const SETTINGS = { admin_approval_limit_kes: 10000, settlement_threshold_units: 3, rolling_window_days: 7, deduction_single_limit_kes: 1000, deduction_total_pct: 25, damage_deductions_enabled: true };
const emp = (n) => ({ name: n, employee_num: 'EMP-1' });
const settlement = (o) => ({ id: 's1', settlement_num: 'TW-2026-0001', engagement_id: 'e1', employee_id: 'w1', period_start: '2026-11-02', period_end: '2026-11-04', cutoff_date: '2026-11-30', units_included: 3, base_amount: 12000, overtime_amount: 0, sunday_amount: 0, gross_amount: 12000, deductions_total: 0, net_amount: 12000, kind: 'threshold', reason: null, status: 'draft', prepared_by: OTHER, prepared_at: '2026-11-05T08:00:00Z', approved_by: null, approved_at: null, approved_by_role: null, approval_override: false, override_reason: null, payout_sheet_id: null, paid_by: null, paid_at: null, received_by_full_name: null, payment_note: null, voided_by: null, voided_at: null, void_reason: null, employees: emp('Jane Worker'), temporary_worker_engagements: { engagement_num: 'TE-2026-0001' }, ...o });
const localIso = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const START = localIso(-10);
let backend, calls;
const route = (method, url, body) => {
  const u = new URL(url, 'http://x'); const p = u.pathname;
  if (p.endsWith('/temporary/settings')) return { settings: backend.settings };
  if (p.endsWith('/temporary/engagements') && method === 'GET') return { engagements: backend.engagements };
  if (/\/engagements\/[^/]+\/attendance$/.test(p)) {
    if (method === 'POST') {
      if (backend.refuse) return { __status: 422, error: backend.refuse };
      backend.days = backend.days || [];
      for (const d of body.days) { backend.days = backend.days.filter(x => x.work_date !== d.date); if (d.units > 0) backend.days.push({ id: 'd-' + d.date, engagement_id: 'e1', work_date: d.date, units: d.units }); }
      return { data: { marked: body.days.length } };
    }
    return { days: backend.days ?? [] };
  }
  if (p.endsWith('/temporary/settlements') && method === 'GET') { const st = u.searchParams.get('status'); return { settlements: st ? backend.settlements.filter(x => x.status === st) : backend.settlements }; }
  if (/\/settlements\/[^/]+$/.test(p) && method === 'GET') { const id = p.split('/').pop(); const s = backend.settlements.find(x => x.id === id); return { settlement: s, lines: [{ id: 'l1', work_date: '2026-11-02', attendance_units: 1, base_amount: 4000, overtime_amount: 0, sunday_amount: 0, line_amount: 4000, active: true }], deductions: backend.deductions[id] || [] }; }
  if (p.endsWith('/payout-sheets') && method === 'GET') return { sheets: backend.sheets };
  if (/\/payout-sheets\/[^/]+$/.test(p) && method === 'GET') return { sheet: backend.sheets[0], settlements: backend.sheetSettlements, deductions: [], rows: backend.sheetRows || [] };
  if (/\/payout-sheets\/[^/]+$/.test(p) && method === 'PATCH' && body?.action === 'match') return { data: backend.matchResult || { matched: 1, pending: 1, ambiguous: [], not_found: ['TW-2'], sheet_status: 'exported' } };
  if (p.startsWith('/api/payroll/employees')) return { employees: [{ id: 'w1', name: 'Jane Worker', employee_num: 'EMP-1' }] };
  return { data: { ok: true } };
};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET'; calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
  if (/\/payout-sheets\/[^/]+\/export$/.test(String(url))) {
    if (backend.exportRefuse) return { ok: false, status: 422, json: async () => ({ error: backend.exportRefuse }), text: async () => JSON.stringify({ error: backend.exportRefuse }) };
    return { ok: true, status: 200, headers: { get: (k) => ({ 'Content-Disposition': 'attachment; filename="chatpesa_PS-2026-0001_2026-11-07.csv"', 'X-First-Export': backend.firstExport === false ? '0' : '1' })[k] ?? null }, blob: async () => new window.Blob(['Type,Amount']) };
  }
  const body = route(method, String(url), init.body ? JSON.parse(init.body) : undefined);
  if (body && body.__status) return { ok: false, status: body.__status, text: async () => JSON.stringify({ error: body.error }) };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
window.fetch = globalThis.fetch;
window.URL.createObjectURL = () => 'blob:test'; window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { (window.__downloads ||= []).push(this.download); };

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 15)); }); };
const text = () => document.body.textContent.replace(/\s+/g, ' ');
const q = (sel, within = document) => [...within.querySelectorAll(sel)];
const byText = (tag, t, within = document) => q(tag, within).find(e => e.textContent.trim() === t || e.textContent.trim().startsWith(t));
const click = async (el) => { if (!el) throw new Error('element not found'); await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }); await settle(); };
const type = async (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })); });
};
let root;
const mount = async (role, over = {}) => {
  document.getElementById('root').innerHTML = ''; document.querySelectorAll('[role=dialog]').forEach(d => d.remove());
  backend = { settings: SETTINGS, engagements: [{ id: 'e1', engagement_num: 'TE-2026-0001', status: 'active', version: 1, agreed_daily_rate: 4000, start_date: START, expected_end_date: null, employees: emp('Jane Worker'), orders: { order_num: 'ORD-9', client: 'Acme' }, due: { eligible_units: 3, eligible_gross: 12000, due: true, close_out_due: false, threshold_units: 3 } }],
    settlements: [settlement({})], deductions: {}, sheets: [], sheetSettlements: [], sheetRows: [], ...over };
  calls = []; window.__auth = { user: { id: USER }, userRole: role, loaded: true }; window.__orders = [{ id: 'o1', order_num: 'ORD-9', client: 'Acme', status: 'In Production' }];
  root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(TemporaryWorkersTab)); }); await settle();
};
const unmount = async () => { await act(async () => { root.unmount(); }); };
const tab = async (label) => click(byText('button', label));
const pick = async (el, value) => { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })); }); };
const exactBtn = (t, within = document) => q('button', within).find(b => b.textContent.trim() === t);
const dialog = () => document.querySelector('[role=dialog]');

// ── access and tabs ──
await mount('production_staff'); ok('production_staff sees no temporary-workers screen', /don.t have access/.test(text()) && !byText('button', 'Engagements')); await unmount();
await mount('head_of_sales');
ok('head of sales sees Engagements, Due, Settlements, Payout sheets', ['Engagements', 'Due for payment', 'Settlements', 'Payout sheets'].every(l => byText('button', l)));
ok('head of sales does NOT see the Limits tab', !byText('button', 'Limits'));
ok('engagement list shows the worker, rate and an unsettled total', /Jane Worker/.test(text()) && /4,000/.test(text()) && /12,000/.test(text()));
await tab('Due for payment'); ok('"Due for payment" lists the worker at the threshold', /threshold reached/.test(text()));
await unmount();
await mount('admin'); ok('admin sees the Limits tab', !!byText('button', 'Limits')); await tab('Limits'); ok('limits form shows the current limit', q('input').some(i => i.value === '10000')); await unmount();
await mount('production_manager', { settings: null }); ok('missing limit row shows the fail-closed warning', /approval limit is not set/.test(text())); await unmount();

// ── onboarding message ──
await mount('head_of_sales'); await click(byText('button', '+ New engagement')); await settle(25);
ok('head of sales is told to ask an administrator to register a missing worker', /Ask an administrator to register this worker/.test(dialog().textContent));
ok('worker and project pickers are populated', /Jane Worker/.test(dialog().textContent) && /ORD-9/.test(dialog().textContent));
const createBtn = byText('button', 'Create engagement', dialog()); ok('Create is disabled until the form is complete', createBtn.disabled);
await unmount();
await mount('admin'); await click(byText('button', '+ New engagement'));
ok('admin is pointed to Payroll → Employees instead', !/Ask an administrator/.test(dialog().textContent) && /Register the worker under Payroll/.test(dialog().textContent)); await unmount();

// ── settlement: limit, separation, deductions ──
await mount('head_of_sales'); await tab('Settlements');
ok('draft over the limit is flagged for admin in the list', /Admin approval needed/.test(text()));
await click(byText('button', 'Open'));
let approve = byText('button', 'Approve settlement', dialog());
ok('head of sales cannot approve above the limit (button disabled, reason shown)', approve.disabled && /an admin must approve/.test(dialog().textContent));
ok('no override field for a non-admin', !/Admin override reason/.test(dialog().textContent));
await click(byText('button', '+ Add deduction', dialog()));
const sel = dialog().querySelector('select'); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'other'); sel.dispatchEvent(new window.Event('change', { bubbles: true })); });
const [amount] = q('input[inputmode=decimal]', dialog()); await type(amount, '100');
const reason = dialog().querySelector('textarea'); await type(reason, 'misc');
ok('"Other" shows a live character counter (4/20) and how many more are needed', /4\/20/.test(dialog().textContent) && /add 16 more characters/.test(dialog().textContent), dialog().textContent.slice(-300));
const before = calls.length;
await click(byText('button', 'Add deduction', dialog()));
ok('submitting a short "Other" reason shows the validation message and sends nothing', /at least 20 characters/.test(dialog().textContent) && !calls.slice(before).some(c => c.method === 'POST'));
await type(reason, 'Replacement of a lost padlock key');
ok('counter turns to a tick at 20+ characters', /✓/.test(dialog().textContent));
await click(byText('button', 'Add deduction', dialog()));
const post = calls.find(c => c.method === 'POST' && /deductions$/.test(c.url));
ok('a valid "Other" deduction is sent with its fields', post && post.body.deduction_type === 'other' && post.body.amount === '100' && post.body.reason.length >= 20, JSON.stringify(post));
await unmount();

await mount('head_of_sales', { settlements: [settlement({ gross_amount: 3000, net_amount: 3000, base_amount: 3000, prepared_by: USER })] });
await tab('Settlements'); await click(byText('button', 'Open'));
ok('the preparer cannot approve their own settlement (disabled with reason)', byText('button', 'Approve settlement', dialog()).disabled && /You prepared this settlement/.test(dialog().textContent));
await unmount();
await mount('head_of_sales', { settlements: [settlement({ gross_amount: 3000, net_amount: 3000, base_amount: 3000 })] });
await tab('Settlements'); await click(byText('button', 'Open'));
const ap = byText('button', 'Approve settlement', dialog()); ok('a different head of sales can approve within the limit', !ap.disabled);
await click(ap); ok('approve sends the action (identity comes from the session, not the page)', calls.some(c => c.method === 'PATCH' && c.body.action === 'approve' && !('role' in c.body) && !('actor' in c.body)));
await unmount();
await mount('admin'); await tab('Settlements'); await click(byText('button', 'Open'));
ok('admin sees the override-reason field and can approve above the limit', /Admin override reason/.test(dialog().textContent) && !byText('button', 'Approve settlement', dialog()).disabled); await unmount();

// ── paid is final ──
await mount('admin', { settlements: [settlement({ status: 'paid', approved_by: OTHER, approved_by_role: 'head_of_sales', approved_at: '2026-11-06T08:00:00Z', paid_by: 'u-pay', paid_at: '2026-11-07T08:00:00Z', payment_note: 'M-Pesa RKA123', payout_sheet_id: 'sh1' })] });
await tab('Settlements'); await click(byText('button', 'Open'));
ok('a paid settlement says it was paid by M-Pesa through ChatPesa (with the code) and offers no void/approve/pay button', /M-Pesa through ChatPesa/.test(dialog().textContent) && /RKA123/.test(dialog().textContent) && !/in cash/.test(dialog().textContent) && !byText('button', 'Void…', dialog()) && !byText('button', 'Approve settlement', dialog()) && /final/.test(dialog().textContent)); await unmount();
await mount('head_of_sales', { settlements: [settlement({ status: 'approved', approved_by: OTHER, approved_by_role: 'head_of_sales', approved_at: '2026-11-06T08:00:00Z' })] });
await tab('Settlements'); await click(byText('button', 'Open'));
ok('only an admin can void an approved settlement', !byText('button', 'Void…', dialog()) && /Only an admin can void/.test(dialog().textContent)); await unmount();

// ── payout sheet: ChatPesa (M-Pesa), no cash ──
const sheet = (o) => ({ id: 'sh1', sheet_num: 'PS-2026-0001', status: 'exported', total_gross: 6000, total_deductions: 0, total_net: 6000, admin_approved_by: null, exported_by: 'u-admin', exported_at: '2026-11-07T08:00:00Z', export_downloads: 1, created_at: '2026-11-06T08:00:00Z', ...o });
const approvedS = (o) => settlement({ status: 'approved', gross_amount: 3000, net_amount: 3000, base_amount: 3000, approved_by: OTHER, approved_by_role: 'head_of_sales', approved_at: '2026-11-06T08:00:00Z', payout_sheet_id: 'sh1', ...o });
const prow = (o) => ({ id: 'r1', sheet_id: 'sh1', settlement_id: 's1', amount: 3000, phone_masked: '07•• ••• 678', description: 'x', chatpesa_transaction_id: null, match_method: null, confirm_code: null, matched_at: null, released_at: null, release_reason: null, ...o });
const two = () => [approvedS({ id: 's1', settlement_num: 'TW-1', prepared_by: OTHER, employees: emp('Jane Worker') }), approvedS({ id: 's2', settlement_num: 'TW-2', prepared_by: OTHER, employees: emp('Peter Mine') })];
const rowsMixed = () => [prow({ id: 'r1', settlement_id: 's1', chatpesa_transaction_id: 't1', match_method: 'settlement_ref', confirm_code: 'RKA123', matched_at: '2026-11-08T08:00:00Z' }), prow({ id: 'r2', settlement_id: 's2', amount: 3000, phone_masked: '01•• ••• 321' })];
const noMoney = () => !q('button', dialog()).some(b => /Print|Upload|Mark paid|signed/i.test(b.textContent)) && !/signed copy|in cash|counted/i.test(dialog().textContent);

// exported sheet, a non-admin who prepared nothing: sees progress and can match, cannot release money
await mount('head_of_sales', { sheets: [sheet({})], sheetSettlements: two(), sheetRows: rowsMixed() });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('the exported sheet lists each worker with a MASKED number, never a full one', /07•• ••• 678/.test(dialog().textContent) && !/0712345678|712345678/.test(dialog().textContent));
ok('a matched row shows paid, the M-Pesa code and how it matched; an unmatched row waits for the statement', /RKA123/.test(dialog().textContent) && q('[data-testid=payout-row]', dialog()).length === 2 && /waiting for statement/.test(dialog().textContent));
ok('no cash, printing, signing or receipt controls anywhere on the sheet', noMoney());
ok('the steps tell the user to import the statement before matching', /Import the ChatPesa statement/.test(dialog().textContent));
ok('non-admin cannot release the money file or close out unpaid rows', !q('button', dialog()).some(b => /Download|Release unpaid|Cancel sheet/.test(b.textContent)));
await click(byText('button', 'Match payments', dialog()));
const mcall = calls.find(c => c.method === 'PATCH' && c.body.action === 'match');
ok('Match payments sends only the action (identity comes from the session)', mcall && Object.keys(mcall.body).join() === 'action', JSON.stringify(mcall));
ok('the result is explained: how many matched, how many are still not in the statement, and what to do', /1 payment matched/.test(dialog().textContent) && /1 still not in the statement/.test(dialog().textContent) && /Import a newer ChatPesa statement/.test(dialog().textContent));
await unmount();

// admin on an exported sheet: download again (with a double-payment warning), release with a reason
await mount('admin', { sheets: [sheet({})], sheetSettlements: two(), sheetRows: rowsMixed() });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('admin sees Download again, Match payments and Release unpaid on an exported sheet', ['Download again…', 'Match payments', 'Release unpaid…'].every(t => !!exactBtn(t, dialog())));
ok('it warns the file was already made and must not be uploaded twice', /Do not upload it to ChatPesa twice/.test(dialog().textContent));
await click(exactBtn('Download again…', dialog()));
ok('downloading again first asks for confirmation and explains the double-payment risk', /pays those workers twice/.test(dialog().textContent) && !calls.some(c => /export$/.test(c.url)));
await click(exactBtn('No', dialog()));
ok('answering No downloads nothing', !calls.some(c => /export$/.test(c.url)) && !/pays those workers twice/.test(dialog().textContent));
await click(exactBtn('Download again…', dialog())); backend.firstExport = false;
await click(exactBtn('Yes, download the unpaid rows', dialog()));
ok('confirming POSTs to the export route (never a GET) and saves a .csv file', calls.some(c => c.method === 'POST' && /payout-sheets\/sh1\/export$/.test(c.url)) && (window.__downloads || []).some(n => /\.csv$/.test(n)));
ok('...and explains the repeat file contains only unpaid payments', /only payments that are still unpaid/.test(dialog().textContent));
await click(exactBtn('Release unpaid…', dialog()));
const rel = byText('button', 'Release 1 unpaid payment', dialog());
ok('release warns to match first and keeps the button disabled until a reason is written', /Release only after importing a fresh ChatPesa statement/.test(dialog().textContent) && rel.disabled);
await type(q('input', dialog()).pop(), 'ChatPesa rejected the row: number not registered');
ok('...enabled once the reason is written', !byText('button', 'Release 1 unpaid payment', dialog()).disabled);
await click(byText('button', 'Release 1 unpaid payment', dialog()));
const rcall = calls.find(c => c.method === 'PATCH' && c.body.action === 'release');
ok('release sends the reason and nothing about identity', rcall && rcall.body.reason === 'ChatPesa rejected the row: number not registered' && !('p_actor' in rcall.body) && !('role' in rcall.body), JSON.stringify(rcall));
await unmount();

// the preparer cannot release their own settlement's payment
await mount('admin', { sheets: [sheet({})], sheetSettlements: [approvedS({ id: 's1', settlement_num: 'TW-1', prepared_by: USER, employees: emp('Jane Worker') })], sheetRows: [prow({})] });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('an admin who prepared a settlement on the sheet cannot download again, and is told why', exactBtn('Download again…', dialog()).disabled && /You prepared a settlement on this sheet/.test(dialog().textContent)); await unmount();

// open sheet above the limit
await mount('head_of_sales', { sheets: [sheet({ status: 'open', total_net: 12000, exported_by: null, exported_at: null })], sheetSettlements: [approvedS({ gross_amount: 12000, net_amount: 12000, base_amount: 12000 })] });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('a non-admin never gets the money file for an open sheet', !q('button', dialog()).some(b => /Download ChatPesa file/.test(b.textContent)) || byText('button', 'Download ChatPesa file', dialog()).disabled);
ok('an open sheet shows "not exported" rows, not numbers', /not exported/.test(dialog().textContent) && !/•/.test(dialog().textContent)); await unmount();
await mount('admin', { sheets: [sheet({ status: 'open', total_net: 12000, exported_by: null, exported_at: null })], sheetSettlements: [approvedS({ gross_amount: 12000, net_amount: 12000, base_amount: 12000 })] });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('above the limit an admin must approve the sheet before the file can be downloaded', !!byText('button', 'Approve sheet (admin)', dialog()) && byText('button', 'Download ChatPesa file', dialog()).disabled && /above the approval limit/.test(dialog().textContent)); await unmount();

// open sheet within the limit: the admin downloads the file; the sheet becomes exported
await mount('admin', { sheets: [sheet({ status: 'open', total_net: 6000, exported_by: null, exported_at: null })], sheetSettlements: two() });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('admin can download the ChatPesa file for an open sheet under the limit', !byText('button', 'Download ChatPesa file', dialog()).disabled);
await click(byText('button', 'Download ChatPesa file', dialog()));
ok('the first download POSTs to export and says what to do next', calls.some(c => c.method === 'POST' && /export$/.test(c.url)) && /Upload it in ChatPesa, then import the statement and match the payments/.test(dialog().textContent));
await unmount();
await mount('admin', { sheets: [sheet({ status: 'open', total_net: 6000, exported_by: null, exported_at: null })], sheetSettlements: two(), exportRefuse: 'No valid M-Pesa number on file for: Peter Mine. Add the number to the worker’s employee record first.' });
await tab('Payout sheets'); await click(byText('button', 'Open')); await click(byText('button', 'Download ChatPesa file', dialog()));
ok('a refusal (e.g. a worker with no M-Pesa number) is shown in plain words and nothing is marked exported', /No valid M-Pesa number on file for: Peter Mine/.test(dialog().textContent) && !window.__downloads?.some(n => /Peter/.test(n))); await unmount();

// paid and cancelled sheets are read-only
await mount('admin', { sheets: [sheet({ status: 'paid' })], sheetSettlements: [approvedS({ status: 'paid' })], sheetRows: [prow({ chatpesa_transaction_id: 't1', match_method: 'phone_amount', confirm_code: 'RKB456', matched_at: '2026-11-08T08:00:00Z' })] });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('a paid sheet says every payment was matched, flags a phone+amount match, and has no money buttons', /matched to a real ChatPesa payment/.test(dialog().textContent) && /matched by phone and amount/.test(dialog().textContent) && !q('button', dialog()).some(b => /Download|Match|Release|Cancel sheet/.test(b.textContent))); await unmount();
await mount('admin', { sheets: [sheet({ status: 'cancelled', exported_by: null, exported_at: null, cancelled_at: '2026-11-08T08:00:00Z', cancel_reason: 'Wrong names' })], sheetSettlements: [] });
await tab('Payout sheets'); await click(byText('button', 'Open'));
ok('a cancelled sheet is read-only and says it is never reused', /never reused/.test(dialog().textContent) && !q('button', dialog()).some(b => /Download|Match|Release|Cancel sheet/.test(b.textContent))); await unmount();

// ── first-time-user guidance (audit) ──
{
  await mount('head_of_sales');
  const how = document.querySelector('details');
  ok('a "How temporary workers are paid" guide is on the page with six numbered steps', how && /6 steps/.test(how.textContent) && how.querySelectorAll('li').length === 6);
  ok('the guide names the key rules: paid through ChatPesa (no cash), a different person approves, a match makes it paid and final', /through ChatPesa/.test(how.textContent) && !/cash only/.test(how.textContent) && /other than the preparer/i.test(how.textContent) && /final/.test(how.textContent));
  ok('each tab has a one-sentence explanation (Engagements)', /An engagement is the deal with one worker on one project/.test(document.querySelector('[data-testid=tab-help]').textContent));
  await tab('Due for payment'); ok('...and it changes with the tab (Due for payment)', /ready to be paid/.test(document.querySelector('[data-testid=tab-help]').textContent));
  await tab('Settlements'); ok('...(Settlements)', /amount owed to one worker/.test(document.querySelector('[data-testid=tab-help]').textContent));
  await tab('Payout sheets'); ok('...(Payout sheets)', /one ChatPesa file/.test(document.querySelector('[data-testid=tab-help]').textContent));
  ok('an empty payout-sheet list says what to do first', /Approve a settlement first/.test(text()));
  await unmount();

  // new-engagement form: says what is missing, and every label is wired to its control
  await mount('head_of_sales'); await click(byText('button', '+ New engagement'));
  const create = exactBtn('Create engagement');
  ok('Create engagement is disabled and says exactly what is still needed', create.disabled && /Still needed: a worker, a project, the agreed daily rate/.test(dialog().textContent) && /Still needed/.test(create.title));
  const labels = q('label[for]', dialog());
  const unwired = labels.filter(l => { const el = document.getElementById(l.getAttribute('for')); return !el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName); });
  ok(`every form label points at a real control (${labels.length} labels checked), so clicking a label focuses the field`, labels.length >= 6 && unwired.length === 0, unwired.map(l => l.textContent).join(','));
  ok('the worker and project search boxes have accessible names', !!dialog().querySelector('input[aria-label="Search workers"]') && !!dialog().querySelector('input[aria-label="Search projects"]'));
  ok('required fields are announced as required', q('[aria-required="true"]', dialog()).length >= 3);
  await unmount();

  // an active engagement with nothing linked warns that days will not count
  await mount('production_manager'); await click(byText('button', 'Open'));
  ok('an active engagement shows Days present (no Production assignment panel)', /Days present/.test(dialog().textContent) && !/Production assignment/.test(dialog().textContent)); await unmount();

  // removing a deduction: inline reason, never a browser pop-up
  const ded = { id: 'd1', settlement_id: 's1', deduction_type: 'cash_advance', amount: 500, reason: 'Advance', evidence_ref: 'ADV-1', active: true, recorded_by: OTHER, approved_by: null, approved_at: null, approved_by_role: null, worker_acknowledged_at: null, void_reason: null };
  await mount('head_of_sales', { settlements: [settlement({})], deductions: { s1: [ded] } });
  await tab('Settlements'); await click(byText('button', 'Open'));
  window.__prompts = 0;
  await click(exactBtn('Remove…', dialog()));
  ok('Remove… opens an inline reason form (no browser pop-up)', window.__prompts === 0 && /Why is this deduction being removed/.test(dialog().textContent));
  ok('"Remove deduction" stays disabled until a reason is typed', exactBtn('Remove deduction', dialog()).disabled);
  await type(q('input', dialog()).find(i => i.closest('div')?.previousElementSibling === null || true && /removed/i.test(i.closest('div').parentElement.textContent) && !i.value), 'Entered twice');
  await settle();
  const removeBtn = exactBtn('Remove deduction', dialog());
  ok('typing a reason enables it', !removeBtn.disabled);
  await click(removeBtn);
  const patch = calls.find(c => c.method === 'PATCH' && /deductions\/d1$/.test(c.url));
  ok('...and it voids the deduction with that reason, with no pop-up', patch && patch.body.action === 'void' && patch.body.reason === 'Entered twice' && window.__prompts === 0, JSON.stringify(patch));
  await unmount();

  // settlement: plain "Next:" guidance per status, and a one-click path to the payout sheet
  await mount('head_of_sales', { settlements: [settlement({ prepared_by: USER, gross_amount: 3000, base_amount: 3000, net_amount: 3000 })] });
  await tab('Settlements'); await click(byText('button', 'Open'));
  ok('draft you prepared: Next says someone else must approve', /Next: You prepared this, so someone else must approve it/.test(dialog().textContent)); await unmount();
  await mount('head_of_sales', { settlements: [settlement({})] });
  await tab('Settlements'); await click(byText('button', 'Open'));
  ok('draft above the approval limit (12,000): Next says an admin must approve', /Next: This is above the approval limit, so an admin must approve it/.test(dialog().textContent));
  await unmount();
  await mount('head_of_sales', { settlements: [settlement({ gross_amount: 3000, base_amount: 3000, net_amount: 3000 })] });
  await tab('Settlements'); await click(byText('button', 'Open'));
  ok('draft under the limit prepared by someone else: Next says check and approve', /Next: Check the days and deductions, then approve it/.test(dialog().textContent));
  ok('the settlement tables say "Days" (not the jargon "Units")', /Days/.test(dialog().textContent) && !/\bUnits\b/.test(dialog().textContent)); await unmount();
  await mount('head_of_sales', { settlements: [approvedS({ payout_sheet_id: null })], sheets: [sheet({ status: 'open', total_net: 3000, exported_by: null, exported_at: null })], sheetSettlements: [approvedS({})] });
  await tab('Settlements'); await click(byText('button', 'Open'));
  ok('approved without a sheet: Next says to create a payout sheet, with the button right there', /Next: Put it on a payout sheet/.test(dialog().textContent) && !!exactBtn('Create payout sheet', dialog()));
  await click(exactBtn('Create payout sheet', dialog()));
  const mk = calls.find(c => c.method === 'POST' && /payout-sheets$/.test(c.url));
  ok('Create payout sheet posts exactly this settlement', mk && mk.body.settlement_ids.length === 1 && mk.body.settlement_ids[0] === 's1', JSON.stringify(mk));
  ok('...then jumps to the Payout sheets tab with the new sheet open (no hunting for it)', /Payout sheet PS-/.test(dialog()?.getAttribute('aria-label') || '') && /Download ChatPesa file/.test(dialog().textContent));
  await unmount();
  await mount('head_of_sales', { settlements: [approvedS({ payout_sheet_id: 'sh1' })] });
  await tab('Settlements'); await click(byText('button', 'Open'));
  ok('approved and already on a sheet: no duplicate Create button, Next points to Payout sheets', !exactBtn('Create payout sheet', dialog()) && /Continue in “Payout sheets”/.test(dialog().textContent)); await unmount();
}

// ── cancelled engagement with approved attendance: visible as close-out due, and settleable ──
{
  const cancelled = (o = {}) => ({ id: 'e9', engagement_num: 'TE-2026-0009', status: 'cancelled', version: 1, agreed_daily_rate: 1000, start_date: '2026-11-02', expected_end_date: null,
    close_reason: 'Client cancelled the job', closed_at: '2026-11-10T08:00:00Z', employees: emp('Peter Cancelled'), orders: { order_num: 'ORD-9', client: 'Acme' },
    due: { eligible_units: 2, eligible_gross: 2000, due: false, close_out_due: true, threshold_units: 3, total_units: 2, max_days: null, max_days_reached: false }, ...o });
  await mount('head_of_sales', { engagements: [cancelled()] });
  ok('engagement list: a cancelled engagement with unsettled days offers Settle', !!exactBtn('Settle'));
  await click(exactBtn('Settle'));
  ok('...and the settlement form defaults to a close-out', /Close-out/.test(dialog().textContent) && q('input[name=kind]', dialog())[0].checked);
  await click(byText('button', 'Prepare settlement', dialog()));
  const post = calls.find(c => c.method === 'POST' && /\/settlements$/.test(c.url));
  ok('...and prepares a close_out settlement for the cancelled engagement', post && post.body.kind === 'close_out' && post.body.engagement_id === 'e9', JSON.stringify(post));
  await unmount();

  await mount('head_of_sales', { engagements: [cancelled()] }); await click(byText('button', 'Open'));
  ok('engagement modal: a cancelled engagement offers "Prepare settlement"', !!byText('button', 'Prepare settlement', dialog())); await unmount();

  await mount('head_of_sales', { engagements: [cancelled()] }); await tab('Due for payment');
  ok('"Due for payment" lists the cancelled engagement as a close-out', /Peter Cancelled/.test(text()) && /close-out/.test(text())); await unmount();

  await mount('head_of_sales', { engagements: [cancelled({ due: { eligible_units: 0, eligible_gross: 0, due: false, close_out_due: false, threshold_units: 3, total_units: 2, max_days: null, max_days_reached: false } })] });
  ok('a cancelled engagement with nothing unsettled offers no Settle button', !exactBtn('Settle')); await unmount();
}

// ── maximum-days warning ──
{
  const base = { id: 'e8', engagement_num: 'TE-2026-0008', status: 'active', version: 1, agreed_daily_rate: 1000, start_date: '2026-11-02', expected_end_date: null, employees: emp('Max Worker'), orders: { order_num: 'ORD-9', client: 'Acme' } };
  await mount('head_of_sales', { engagements: [{ ...base, due: { eligible_units: 0, eligible_gross: 0, due: false, close_out_due: false, threshold_units: 3, total_units: 5, max_days: 5, max_days_reached: true } }] });
  ok('list shows a "max days" badge once the guide is reached, even with nothing unsettled (all paid)', !!byText('span', 'max days') || /max days/.test(text()));
  await click(byText('button', 'Open'));
  ok('engagement modal warns with recorded vs guide days', /Maximum days reached: 5 day\(s\) recorded against a guide of 5\./.test(dialog().textContent), dialog().textContent.slice(0, 300)); await unmount();
  await mount('head_of_sales', { engagements: [{ ...base, due: { eligible_units: 1, eligible_gross: 1000, due: false, close_out_due: false, threshold_units: 3, total_units: 4, max_days: 5, max_days_reached: false } }] });
  ok('no warning below the guide', !/max days/.test(text())); await unmount();
}

// ── new payout sheet: several workers, one ChatPesa upload ──
{
  const two2 = [approvedS({ id: 's1', settlement_num: 'TW-1', payout_sheet_id: null, employees: emp('Jane Worker') }), approvedS({ id: 's2', settlement_num: 'TW-2', payout_sheet_id: null, employees: emp('Peter Mine') })];
  await mount('head_of_sales', { settlements: two2, sheets: [sheet({ status: 'open', total_net: 6000, exported_by: null, exported_at: null })], sheetSettlements: two() });
  await tab('Payout sheets'); await click(byText('button', '+ New payout sheet'));
  const boxes = q('input[type=checkbox]', dialog());
  ok('new sheet form lists each approved settlement with a checkbox (several workers per sheet)', boxes.length === 2 && q('input[type=radio]', dialog()).length === 0);
  ok('it says each worker needs an M-Pesa number on their employee record', /M-Pesa number on their employee record/.test(dialog().textContent));
  ok('weekly run: every approved settlement is ticked by default, with the total shown', boxes.every(b => b.checked) && /2 workers · KES 6,000/.test(dialog().textContent), dialog().textContent.slice(0, 400));
  await click(byText('button', 'Untick all', dialog()));
  ok('Untick all clears them and Create sheet is disabled', boxes.every(b => !b.checked) && byText('button', 'Create sheet', dialog()).disabled);
  await click(byText('button', 'Tick all', dialog()));
  ok('Tick all brings everyone back', boxes.every(b => b.checked));
  await click(byText('button', 'Create sheet', dialog()));
  const post = calls.find(c => c.method === 'POST' && /payout-sheets$/.test(c.url));
  ok('the one request carries both settlement ids (a single upload for the week)', post && post.body.settlement_ids.length === 2 && post.body.settlement_ids.includes('s1') && post.body.settlement_ids.includes('s2'), JSON.stringify(post));
  await unmount();
}

// ── weekly sheet warns about drafts left out ──
{
  const ap = [approvedS({ id: 's1', settlement_num: 'TW-1', payout_sheet_id: null, employees: emp('Jane Worker') })];
  await mount('head_of_sales', { settlements: [...ap, settlement({ id: 'sd', status: 'draft', employees: emp('Late Larry') })], sheets: [] });
  await tab('Payout sheets'); await click(byText('button', '+ New payout sheet'));
  ok('settlements still in draft are named in a warning and are not on the sheet', /not approved yet \(Late Larry\)/.test(dialog().textContent) && q('input[type=checkbox]', dialog()).length === 1);
  await unmount();
}

// ── engagement: days present ──
{
  const dp = () => dialog().querySelector('[data-testid=days-present]');
  const row = (date) => dp().querySelector(`[data-day="${date}"]`);
  const pressed = (date) => q('button[aria-pressed="true"]', row(date)).map(b => b.textContent);
  const markCalls = () => calls.filter(c => c.method === 'POST' && /\/attendance$/.test(c.url));
  const today = localIso(0);

  await mount('production_manager', { days: [] }); await click(byText('button', 'Open'));
  ok('an active engagement shows a Days present section with a row for every day since the start', !!dp() && dp().querySelectorAll('[data-day]').length === 11, String(dp()?.querySelectorAll('[data-day]').length));
  const dates = q('[data-day]', dp()).map(r => r.getAttribute('data-day'));
  ok('rows are newest first, starting today, never in the future', dates[0] === today && dates[dates.length - 1] === START && dates.every(d => d <= today), dates.slice(0, 2).join(','));
  ok('the paying side shows no job, stage, task or assignment wording', !/\bjob\b|\bstage\b|operation|assignment/i.test(dialog().textContent), dialog().textContent.slice(0, 300));
  ok('every day starts as Absent', pressed(today).join() === 'Absent');
  ok('the total starts at 0 marked', /0 marked/.test(dp().textContent));

  await click(q('button', row(today)).find(b => b.textContent === 'Full'));
  const c1 = markCalls().at(-1);
  ok('tapping Full sends one day with units 1', markCalls().length === 1 && c1.body.days.length === 1 && c1.body.days[0].date === today && c1.body.days[0].units === 1, JSON.stringify(c1?.body));
  ok('actor and role are never sent from the page', !('role' in c1.body) && !('actor' in c1.body) && !('p_actor' in c1.body));
  ok('after saving, the day shows Full and the total is 1', pressed(today).join() === 'Full' && /1 marked/.test(dp().textContent), pressed(today).join());
  await click(q('button', row(today)).find(b => b.textContent === 'Half'));
  ok('tapping Half changes it to half a day (total 0.5)', markCalls().at(-1).body.days[0].units === 0.5 && pressed(today).join() === 'Half' && /0\.5 marked/.test(dp().textContent), dp().textContent.slice(0, 120));
  const n = markCalls().length;
  await click(q('button', row(today)).find(b => b.textContent === 'Half'));
  ok('tapping the option that is already selected sends nothing', markCalls().length === n);
  await click(q('button', row(today)).find(b => b.textContent === 'Absent'));
  ok('tapping Absent clears the day (units 0, total back to 0)', markCalls().at(-1).body.days[0].units === 0 && pressed(today).join() === 'Absent' && /0 marked/.test(dp().textContent));
  const fullOn = (d) => q('button', row(d)).find(b => b.textContent === 'Full').getAttribute('aria-pressed');
  ok('each option is a real button with aria-pressed (screen readers hear which is selected)', fullOn(today) === 'false' && q('[role=group]', row(today)).length === 1 && !!row(today).querySelector('[role=group][aria-label^="Attendance for"]'));
  await unmount();

  await mount('head_of_sales', { days: [] }); await click(byText('button', 'Open'));
  ok('head of sales can mark days too', !!q('button', row(today)).find(b => b.textContent === 'Full')); await unmount();

  await mount('production_manager', { days: [], refuse: 'This day is in temporary-worker settlement TW-2026-0001 — void that settlement first' }); await click(byText('button', 'Open'));
  await click(q('button', row(today)).find(b => b.textContent === 'Full'));
  ok('a refusal from the server is shown in the dialog and the day is unchanged', /void that settlement first/.test(dialog().textContent) && pressed(today).join() === 'Absent'); await unmount();

  const closed = { id: 'e1', engagement_num: 'TE-2026-0001', status: 'completed', version: 1, agreed_daily_rate: 4000, start_date: START, expected_end_date: null, employees: emp('Jane Worker'), orders: { order_num: 'ORD-9', client: 'Acme' },
    close_reason: 'Done', closed_at: '2026-11-10T00:00:00Z', due: { eligible_units: 0, eligible_gross: 0, threshold_units: 3, due: false, close_out_due: false, total_units: 1.5, max_days: null, max_days_reached: false } };
  await mount('production_manager', { engagements: [closed], days: [{ id: 'x1', work_date: START, units: 1 }, { id: 'x2', work_date: localIso(-9), units: 0.5 }] }); await click(byText('button', 'Open'));
  ok('a completed engagement lists its marked days read-only (no Full / Half / Absent buttons)', q('[data-day]', dp()).length === 2 && !q('button', dp()).some(b => ['Full', 'Half', 'Absent'].includes(b.textContent)) && /full day/.test(dp().textContent) && /half day/.test(dp().textContent)); await unmount();

  await mount('production_manager', { engagements: [{ ...closed, status: 'planned', close_reason: null, closed_at: null }], days: [] }); await click(byText('button', 'Open'));
  ok('a planned engagement says to activate it first and offers no marking', /Activate the engagement to start marking days/.test(dialog().textContent) && !dp()); await unmount();

  await mount('production_manager', { engagements: [{ ...closed, status: 'active', start_date: localIso(3), close_reason: null, closed_at: null }], days: [] }); await click(byText('button', 'Open'));
  ok('an engagement that starts in the future says when the first day can be marked', new RegExp('first day can be marked on').test(dp().textContent)); await unmount();
}

// ── settlement lines: the paying side sees the day and the amount only ──
await mount('head_of_sales'); await tab('Settlements'); await click(byText('button', 'Open'));
ok('the settlement shows Date, Days and Amount per day, with no Base / Overtime / Sunday columns', /Days included/.test(dialog().textContent) && !/Overtime|Sunday/.test(dialog().textContent.replace(/Sunday work/g, '')) && /Amount/.test(dialog().textContent));
await unmount();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
