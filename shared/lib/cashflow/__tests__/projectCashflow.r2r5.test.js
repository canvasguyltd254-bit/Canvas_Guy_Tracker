/**
 * Cashflow spec R2–R5 acceptance tests (see Cashflow_Module_Spec_Changes).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectCashflow } from '../projectCashflow.js';

const SETTINGS = {
  horizon_weeks: 4,
  week_starts_on: 1,
  default_supplier_terms_days: 14,
  cash_reserve_threshold: 50000,
  override_stale_after_days: 14,
  schedule_review_stale_after_days: 30,
  reconciliation_stale_after_days: 7,
  unbanked_warn_after_days: 3,
  concentration_threshold_pct: 25,
};
const POOL = (balance) => ({ account_id: 'a', account_code: '1010', name: 'Absa', balance, is_enabled: true, last_reconciled_at: '2026-08-01', reconciled_balance: balance, unresolved_posting_errors: 0 });

function snap(over = {}) {
  return {
    as_of: '2026-07-30',
    settings: SETTINGS,
    ledger_health: { unposted_count: 0, oldest_unposted_days: null, unresolved_error_count: 0 },
    cash_pools: [POOL(100000)],
    receipts: [], customer_histories: {},
    supplier_purchases: [], payroll_obligations: [], payroll_statutory_obligations: [],
    manual_obligations: [], committed_boq: [], draft_boq_pipeline: [],
    receipt_methods: { available: true, unbanked: [], unknown_method_count: 0, unknown_method_amount: 0 },
    ...over,
  };
}
const manual = (over) => ({
  obligation_id: 'o1', name: 'x', payee: null, amount: 1000, is_statutory: false, recurrence: 'once',
  day_of_month: null, first_due_date: '2026-08-05', ends_on: null, is_active: true,
  default_priority: 'important', occurrence_schedules: {}, ...over,
});
const receipt = (id, amount, date, customer = 'c1') => ({
  order_id: id, customer_id: customer, customer_name: 'Cust ' + customer, order_num: 'ORD-' + id,
  total_value: amount, non_reversed_paid: 0, outstanding_amount: amount,
  payment_due_date: date, invoice_issued_at: null, created_at: '2026-07-01',
  schedule: { id: 's' + id, planned_date: date, planned_amount: amount, minimum_amount: null, priority: 'must_pay', confidence_override: 'confirmed', hold_reason: null, notes: null, last_reviewed_at: '2026-07-29', updated_at: '2026-07-29' },
  installments: [],
});

describe('R3 — daily low point drives the week', () => {
  test('a mid-week dip is Shortfall even though the week closes positive', () => {
    // Opening 100k. Tue 4 Aug: 150k outflow. Thu 6 Aug: 257k inflow (confirmed).
    const r = projectCashflow(snap({
      manual_obligations: [manual({ obligation_id: 'chq', name: 'JAT cheque', amount: 150000, first_due_date: '2026-08-04' })],
      receipts: [receipt('1', 257000, '2026-08-06')],
    }));
    const wk = r.weeks.find((w) => w.week_start === '2026-08-03');
    assert.ok(wk.closing > 0, 'weekly close is positive');
    assert.equal(wk.low_balance, -50000);
    assert.equal(wk.low_date, '2026-08-04');
    assert.equal(wk.state, 'shortfall');
    assert.equal(wk.state_basis.date, '2026-08-04');
  });

  test('outflow larger than the projected balance warns, with days_until, before it is due', () => {
    const r = projectCashflow(snap({
      manual_obligations: [manual({ obligation_id: 'chq', name: 'JAT cheque', amount: 150000, first_due_date: '2026-08-04' })],
    }));
    const w = r.warnings.find((x) => x.code === 'outflow_exceeds_balance');
    assert.ok(w);
    assert.equal(w.severity, 'critical');
    assert.equal(w.metadata.due_date, '2026-08-04');
    assert.equal(w.metadata.days_until, 5);          // as_of 30 Jul → 4 Aug
    assert.ok(w.metadata.days_until >= 3);
    assert.equal(w.metadata.projected_balance, 100000);
    assert.equal(w.metadata.shortfall, 50000);
  });

  test('no warning when the balance covers the outflow', () => {
    const r = projectCashflow(snap({
      manual_obligations: [manual({ amount: 40000, first_due_date: '2026-08-04' })],
    }));
    assert.equal(r.warnings.some((x) => x.code === 'outflow_exceeds_balance'), false);
  });

  test('same-day inflow is available to cover that day\'s outflow', () => {
    const r = projectCashflow(snap({
      cash_pools: [POOL(0)],
      receipts: [receipt('1', 60000, '2026-08-04')],
      manual_obligations: [manual({ amount: 50000, first_due_date: '2026-08-04' })],
    }));
    assert.equal(r.warnings.some((x) => x.code === 'outflow_exceeds_balance'), false);
  });
});

describe('R5 — downside drives state; concentration flag', () => {
  test('downside shortfall shows as Shortfall even when the official case is Normal', () => {
    const r = projectCashflow(snap({
      cash_pools: [POOL(300000)],
      committed_boq: [{ material_estimate_id: 'm1', job_id: 'j1', order_id: 'o1', supplier_id: null, needed_by: '2026-08-05', gross_commitment: 400000, linked_purchase_amount: 0, net_commitment: 400000 }],
    }));
    const wk = r.weeks.find((w) => w.week_start === '2026-08-03');
    assert.equal(wk.closing, 300000);              // official: Normal on its own
    assert.equal(wk.downside_low_balance, -100000);
    assert.equal(wk.state, 'shortfall');
    assert.equal(wk.state_basis.chain, 'downside');
  });

  test('a receipt above 25% of its month\'s planned inflow is flagged', () => {
    const r = projectCashflow(snap({
      receipts: [receipt('1', 900000, '2026-08-12'), receipt('2', 50000, '2026-08-13', 'c2'), receipt('3', 50000, '2026-08-14', 'c3')],
    }));
    const items = r.weeks.flatMap((w) => w.money_in.items);
    assert.equal(items.find((i) => i.order_id === '1').is_concentration_risk, true);
    assert.equal(items.find((i) => i.order_id === '2').is_concentration_risk, false);
    const w = r.warnings.find((x) => x.code === 'receipt_concentration');
    assert.equal(w.metadata.receipts.length, 1);
    assert.equal(w.metadata.receipts[0].amount, 900000);
  });
});

describe('R4 — statutory lines', () => {
  const payroll = [{ payroll_run_id: 'r1', label: 'PR-1', period_end: '2026-07-25', net_pay: 100000, paid_amount: 0, outstanding_amount: 100000, schedule: null, installments: [] }];

  test('payroll without PAYE/NSSF/AHL lines raises a critical warning; coverage is "missing", never zero', () => {
    const r = projectCashflow(snap({ payroll_obligations: payroll }));
    const w = r.warnings.find((x) => x.code === 'payroll_without_statutory_line');
    assert.ok(w);
    assert.equal(w.severity, 'critical');
    assert.deepEqual(w.metadata.missing.sort(), ['ahl', 'nssf', 'paye', 'sha']);
    assert.equal(r.statutory_coverage.paye.status, 'missing');
    assert.equal(r.statutory_coverage.vat.status, 'not_tracked');
  });

  test('tagged manual lines satisfy coverage, are labelled Estimated, and missing paying account warns', () => {
    const r = projectCashflow(snap({
      payroll_obligations: payroll,
      payroll_statutory_obligations: [{ source: 'payroll_sha', payroll_run_id: 'r1', label: 'SHA', due_date: '2026-08-09', outstanding_amount: 2000, priority: 'must_pay', schedule: null, installments: [] }],
      manual_obligations: [
        manual({ obligation_id: 'p', name: 'PAYE', is_statutory: true, statutory_type: 'paye', first_due_date: '2026-08-09', default_priority: 'must_pay' }),
        manual({ obligation_id: 'n', name: 'NSSF', is_statutory: true, statutory_type: 'nssf', first_due_date: '2026-08-09', default_priority: 'must_pay', paying_account_id: 'acc1' }),
        manual({ obligation_id: 'a', name: 'AHL', is_statutory: true, statutory_type: 'ahl', first_due_date: '2026-08-09', default_priority: 'must_pay', paying_account_id: 'acc1' }),
      ],
    }));
    assert.equal(r.warnings.some((x) => x.code === 'payroll_without_statutory_line'), false);
    assert.equal(r.statutory_coverage.paye.basis, 'manual_estimate');
    assert.equal(r.statutory_coverage.sha.basis, 'payroll_computed');
    const items = r.weeks.flatMap((w) => w.money_out.items).filter((i) => i.source_type === 'manual_obligation');
    assert.ok(items.length === 3 && items.every((i) => i.is_estimated === true));
    const w = r.warnings.find((x) => x.code === 'statutory_paying_account_unrecorded');
    assert.deepEqual(w.metadata.obligation_ids, ['p']);
  });

  test('no payroll → no missing-statutory warning', () => {
    const r = projectCashflow(snap());
    assert.equal(r.warnings.some((x) => x.code === 'payroll_without_statutory_line'), false);
  });
});

describe('R2 — unbanked receipts', () => {
  test('a 700,000 cash receipt never banked warns and is reported outside the bank balance', () => {
    const r = projectCashflow(snap({
      receipt_methods: { available: true, unknown_method_count: 0, unknown_method_amount: 0,
        unbanked: [{ payment_id: 'p1', order_id: 'o1', order_num: 'ORD-1', customer_name: 'X', amount: 700000, payment_method: 'cash', payment_date: '2026-07-20' }] },
    }));
    assert.equal(r.opening_cash, 100000);               // bank pool untouched
    assert.equal(r.receipt_methods.unbanked_total, 700000);
    assert.equal(r.receipt_methods.unbanked[0].days_unbanked, 10);
    const w = r.warnings.find((x) => x.code === 'unbanked_receipts');
    assert.ok(w);
    assert.equal(w.metadata.total, 700000);
  });

  test('recent unbanked cash is listed but does not warn yet', () => {
    const r = projectCashflow(snap({
      receipt_methods: { available: true, unknown_method_count: 0, unknown_method_amount: 0,
        unbanked: [{ payment_id: 'p1', order_id: 'o1', order_num: 'ORD-1', customer_name: 'X', amount: 5000, payment_method: 'mpesa', payment_date: '2026-07-29' }] },
    }));
    assert.equal(r.receipt_methods.unbanked_count, 1);
    assert.equal(r.warnings.some((x) => x.code === 'unbanked_receipts'), false);
  });

  test('legacy payments with no method are counted as unknown, not assumed', () => {
    const r = projectCashflow(snap({
      receipt_methods: { available: true, unbanked: [], unknown_method_count: 7, unknown_method_amount: 123000 },
    }));
    const w = r.warnings.find((x) => x.code === 'receipt_method_unrecorded');
    assert.equal(w.metadata.count, 7);
  });

  test('unavailable data (migration not run) is reported, not treated as "all banked"', () => {
    const r = projectCashflow(snap({ receipt_methods: { available: false, unbanked: [], unknown_method_count: 0, unknown_method_amount: 0 } }));
    assert.equal(r.receipt_methods.available, false);
    assert.ok(r.warnings.some((x) => x.code === 'receipt_method_data_unavailable'));
  });
});
