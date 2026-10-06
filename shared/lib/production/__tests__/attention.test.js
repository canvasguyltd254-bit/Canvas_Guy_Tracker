import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobAttention, worstSeverity } from '../attention.js';

const today = '2026-10-05';
const base = () => ({
  status: 'In Production', production_due_date: '2026-10-20', customer_due_date: '2026-10-25', awaiting_qc_qty: 0,
  stages: [
    { stage_key: 'assembly', stage_label: 'Assembly', sort_order: 2, start: '2026-10-06', end: '2026-10-08', workers: ['Ann'] },
    { stage_key: 'sanding', stage_label: 'Sanding', sort_order: 3, start: '2026-10-09', end: '2026-10-12', workers: ['Ann'] },
  ],
});
const codes = (r) => r.map((x) => x.code);

test('clean job has no reasons', () => {
  assert.deepEqual(jobAttention(base(), { today }), []);
});

test('finished jobs never need attention', () => {
  const j = { ...base(), status: 'Completed', production_due_date: null };
  assert.deepEqual(jobAttention(j, { today }), []);
});

test('blocker is explicit: reason, owner, date, ref; missing owner/date flagged', () => {
  const r = jobAttention(base(), { today, blockers: [{ reason: 'Waiting for oak', owner_name: 'Peter', expected_resolution_date: '2026-10-10', supplier_po_ref: 'PO-7' }] });
  assert.deepEqual(codes(r), ['blocked']);
  assert.match(r[0].message, /Waiting for oak.*Peter.*10 Oct.*PO-7/);
  const r2 = jobAttention(base(), { today, blockers: [{ reason: 'Glue' }] });
  assert.deepEqual(codes(r2), ['blocked', 'blocker_no_owner', 'blocker_no_date']);
});

test('overdue blocker is critical with day count', () => {
  const r = jobAttention(base(), { today, blockers: [{ reason: 'Hinges', owner_name: 'A', expected_resolution_date: '2026-10-02' }] });
  const o = r.find((x) => x.code === 'blocker_overdue');
  assert.equal(o.severity, 'critical');
  assert.match(o.message, /3 day/);
});

test('date rules: none set, late vs due, past due, production after customer', () => {
  assert.ok(codes(jobAttention({ ...base(), production_due_date: null }, { today })).includes('no_production_due'));
  assert.ok(codes(jobAttention({ ...base(), production_due_date: '2026-10-11' }, { today })).includes('late_vs_production_due'));
  assert.ok(codes(jobAttention({ ...base(), production_due_date: '2026-10-04' }, { today })).includes('past_production_due'));
  assert.ok(codes(jobAttention({ ...base(), customer_due_date: '2026-10-15' }, { today })).includes('production_due_after_customer'));
});

test('not scheduled and stage overlap', () => {
  assert.ok(codes(jobAttention({ ...base(), stages: [{ stage_key: 'assembly', start: null, end: null }] }, { today })).includes('not_scheduled'));
  const j = base(); j.stages[1].start = '2026-10-07';
  assert.ok(codes(jobAttention(j, { today })).includes('stage_overlap'));
});

test('worker conflict names employee, date, jobs and hours', () => {
  const r = jobAttention(base(), { today, conflicts: [{ employee_name: 'Peter', date: '2026-10-07', job_nums: ['PJ-1', 'PJ-2'], allocated_hours: 12, available_hours: 8 }] });
  assert.match(r[0].message, /Peter.*7 Oct.*12h allocated of 8h.*PJ-1, PJ-2/);
});

test('QC waiting uses the threshold (default 3) and only fires when exceeded', () => {
  const j = { ...base(), awaiting_qc_qty: 4 };
  assert.deepEqual(codes(jobAttention(j, { today, qc_since: '2026-10-02' })), []);           // 3 days: not over
  assert.deepEqual(codes(jobAttention(j, { today, qc_since: '2026-10-01' })), ['qc_waiting']); // 4 days
  assert.deepEqual(codes(jobAttention(j, { today, qc_since: '2026-10-03', qc_waiting_days: 1 })), ['qc_waiting']);
  assert.deepEqual(codes(jobAttention(j, { today, qc_since: null })), ['qc_waiting_unknown']);
});

test('worstSeverity', () => {
  assert.equal(worstSeverity([]), null);
  assert.equal(worstSeverity([{ severity: 'warning' }]), 'warning');
  assert.equal(worstSeverity([{ severity: 'warning' }, { severity: 'critical' }]), 'critical');
});

test('material shortage: critical with no blocker, warning once a blocker exists', () => {
  const short = [{ material_name: 'Oak 25mm' }, { material_name: 'Glue' }];
  const a = jobAttention(base(), { today, short_lines: short });
  assert.equal(a[0].code, 'material_short');
  assert.equal(a[0].severity, 'critical');
  assert.match(a[0].message, /2 material line\(s\) short: Oak 25mm, Glue.*no blocker raised/);
  const b = jobAttention(base(), { today, short_lines: short, blockers: [{ reason: 'Oak on order', owner_name: 'P', expected_resolution_date: '2026-10-10' }] });
  assert.equal(b.find((x) => x.code === 'material_short').severity, 'warning');
});

import { jobAttention as ja2 } from '../attention.js';
test('scheduled stage with no workers is flagged; started one is critical; finished/assigned are not', () => {
  const job = { status: 'In Production', production_due_date: '2026-12-01', stages: [
    { stage_key: 'assembly', stage_label: 'Assembly', start: '2026-10-05', end: '2026-10-08', status: 'active', planned_quantity: 4, workers: [] },
    { stage_key: 'sanding', stage_label: 'Sanding', start: '2026-10-09', end: '2026-10-10', status: 'not_started', planned_quantity: 4, workers: [] },
    { stage_key: 'finishing', stage_label: 'Finishing', start: '2026-10-11', end: '2026-10-12', status: 'not_started', planned_quantity: 4, workers: ['A'] },
    { stage_key: 'materials', stage_label: 'Materials', start: '2026-10-01', end: '2026-10-02', status: 'completed', planned_quantity: 4, workers: [] },
  ] };
  const r = ja2(job, { today: '2026-10-06' }).filter((x) => x.code === 'scheduled_stage_unassigned');
  assert.equal(r.length, 2);
  assert.equal(r.find((x) => /Assembly/.test(x.message)).severity, 'critical');
  assert.equal(r.find((x) => /Sanding/.test(x.message)).severity, 'warning');
});
test('pending rework is flagged', () => {
  const r = ja2({ status: 'In Production', rework_qty: 2, production_due_date: '2026-12-01', stages: [] }, { today: '2026-10-06' });
  assert.ok(r.some((x) => x.code === 'rework_pending'));
  assert.ok(!ja2({ status: 'In Production', rework_qty: 0, production_due_date: '2026-12-01', stages: [] }, { today: '2026-10-06' }).some((x) => x.code === 'rework_pending'));
});
