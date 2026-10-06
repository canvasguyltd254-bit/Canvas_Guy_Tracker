import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShopFloorCards, buildShortageSheet, buildInternalPack, escapeHtml } from '../printSheets.js';

const job = () => ({
  job_num: 'PJ-1', name: 'Dining <table>', order_num: 'ORD-9', planned_quantity: 2, size: '1800x900', wood_type: 'Oak',
  production_due_date: '2026-10-20', production_instructions: 'Round the corners',
  stages: [{ stage_label: 'Assembly', status: 'active', start: '2026-10-06', end: '2026-10-08', workers: ['Peter'] }],
  materials: [
    { material_name: 'Oak 25mm', unit: 'sheet', estimated_quantity: 4, readiness: 'short', short_note: 'Only 1 in stock', estimated_total_cost: 98765 },
    { material_name: 'Glue', unit: 'litre', estimated_quantity: 1, readiness: 'ready' },
  ],
  blockers: [{ reason: 'Oak on order', owner_name: 'Mary', expected_resolution_date: '2026-10-10', supplier_po_ref: 'PO-7' }],
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
});

test('shop-floor card shows work info and never any money', () => {
  const html = buildShopFloorCards([job()], { printedAt: '5 Oct' });
  assert.match(html, /PJ-1/);
  assert.match(html, /Dining &lt;table&gt;/);
  assert.match(html, /Production due/);
  assert.match(html, /Peter/);
  assert.match(html, /SHORT/);
  assert.match(html, /Owner: Mary/);
  assert.doesNotMatch(html, /KES|98765|98,765|cost|price|labour/i);
});

test('shortage sheet lists only short lines and carries blocker owner/date/ref; no prices', () => {
  const html = buildShortageSheet([job(), { ...job(), job_num: 'PJ-2', materials: [{ material_name: 'Glue', unit: 'l', readiness: 'ready' }] }]);
  assert.match(html, /Oak 25mm/);
  assert.doesNotMatch(html, /Glue/);
  assert.doesNotMatch(html, /PJ-2/);
  assert.match(html, /Mary/);
  assert.match(html, /PO-7/);
  assert.doesNotMatch(html, /KES|98765/);
});

test('shortage sheet warns when a short job has no blocker, and handles none short', () => {
  const j = job(); j.blockers = [];
  assert.match(buildShortageSheet([j]), /No blocker raised yet/);
  assert.match(buildShortageSheet([{ ...job(), materials: [] }]), /No material shortages recorded/);
});

test('internal pack: missing figures read "Not recorded", never 0; partial totals flagged', () => {
  const j = job();
  j.finance = {
    materials: [{ material_name: 'Oak', estimated_total_cost: 1000 }, { material_name: 'Glue', estimated_total_cost: null }],
    labour: { loaded: true, item_level: [], order_level: [] },
    planned_hours: [],
  };
  const html = buildInternalPack([j]);
  assert.match(html, /Not recorded/);
  assert.match(html, /partial — 1 line\(s\) not recorded/);
  assert.doesNotMatch(html, /KES 0\b/);
  assert.match(html, /no payroll allocation yet/);
});

test('internal pack labour: item-level vs order-level, pending runs, plan-only hours', () => {
  const j = job();
  j.finance = {
    materials: [],
    labour: { loaded: true,
      item_level: [{ worker: 'Peter', amount: 5000, run_status: 'draft' }],
      order_level: [{ worker: 'Mary', amount: 3000, run_status: 'approved' }] },
    planned_hours: [{ worker: 'Peter', stage_label: 'Assembly', hours: 12 }],
  };
  const html = buildInternalPack([j]);
  assert.match(html, /allocated to this item/);
  assert.match(html, /order-level — not split by job/);
  assert.match(html, /pending — payroll run not approved/);
  assert.match(html, /Item-level total: <b>KES 5,000<\/b>/);
  assert.match(html, /plan only/);
  assert.doesNotMatch(html, /KES 8,000/); // order-level is never added into a job total
});

test('internal pack with unloaded labour does not claim zero', () => {
  const j = job(); j.finance = { materials: [], labour: { loaded: false }, planned_hours: [] };
  assert.match(buildInternalPack([j]), /could not be loaded/);
});

import { buildShopFloorCards as cardsX, buildInternalPack as packX } from '../printSheets.js';
test('shop-floor card lists drawings (image embedded, unsafe url not) and warns when none', () => {
  const j = { job_num: 'J1', name: 'Bed', planned_quantity: 1, stages: [], materials: [], blockers: [],
    drawings: [{ file_name: 'bed.png', url: 'https://x/y/bed.png', category: 'Shop', uploaded_at: '2026-10-01' }, { file_name: 'evil.png', url: 'javascript:alert(1)' }] };
  const html = cardsX([j]);
  assert.match(html, /<img src="https:\/\/x\/y\/bed\.png"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /uploaded 2026-10-01/);
  assert.match(cardsX([{ ...j, drawings: [] }]), /No drawing is linked/);
});
test('internal pack shows estimate vs actual, variance and Not recorded (never 0)', () => {
  const j = { job_num: 'J1', name: 'Bed', planned_quantity: 1, stages: [], blockers: [], finance: { labour: { loaded: true }, planned_hours: [], materials: [
    { material_name: 'Oak', unit: 'bf', estimated_quantity: 10, estimated_total_cost: 1000, issued_quantity: 12, actual_unit_cost: 100, actual_total_cost: 1200 },
    { material_name: 'Glue', unit: 'l', estimated_quantity: 1, estimated_total_cost: 200, issued_quantity: null, actual_unit_cost: null, actual_total_cost: null },
  ] } };
  const html = packX([j]);
  assert.match(html, /\+KES 200/);
  assert.match(html, /Not recorded/);
  assert.match(html, /partial — 1 line\(s\) not recorded/);
});
