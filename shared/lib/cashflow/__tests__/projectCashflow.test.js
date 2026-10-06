/**
 * shared/lib/cashflow/__tests__/projectCashflow.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectCashflow } from '../projectCashflow.js';

const BASE_SETTINGS = {
  horizon_weeks: 13,
  week_starts_on: 1,
  default_supplier_terms_days: 14,
  cash_reserve_threshold: 250000,
  override_stale_after_days: 14,
  schedule_review_stale_after_days: 30,
  reconciliation_stale_after_days: 7,
};

function baseSnapshot(overrides = {}) {
  return {
    as_of: '2026-09-23',
    settings: BASE_SETTINGS,
    ledger_health: { unposted_count: 0, oldest_unposted_days: null, unresolved_error_count: 0 },
    cash_pools: [],
    receipts: [],
    customer_histories: {},
    supplier_purchases: [],
    payroll_obligations: [],
    payroll_statutory_obligations: [],
    manual_obligations: [],
    committed_boq: [],
    draft_boq_pipeline: [],
    ...overrides,
  };
}

describe('projectCashflow — structure and horizon', () => {
  test('builds the correct horizon and an empty projection reconciles to a flat line', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [
        { account_id: 'a1', account_code: '1000', name: 'Cash on Hand', balance: 84000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 84000, unresolved_posting_errors: 0 },
        { account_id: 'a2', account_code: '1010', name: 'Bank', balance: 1552000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 1552000, unresolved_posting_errors: 0 },
      ],
    }));
    assert.equal(result.horizon.weeks, 13);
    assert.equal(result.horizon.first_week_start, '2026-09-28');
    assert.equal(result.horizon.last_week_end, '2026-12-27');
    assert.equal(result.opening_cash, 1636000);
    for (const w of result.weeks) {
      assert.equal(w.closing, w.opening);
      assert.equal(w.downside_closing, w.downside_opening);
      assert.equal(w.state, 'normal');
    }
    assert.equal(result.counts.normal_weeks, 13);
    assert.equal(result.counts.shortfall_weeks, 0);
    assert.equal(result.first_shortfall_week, null);
  });

  test('rejects a missing snapshot, invalid as_of, or bad settings', () => {
    assert.throws(() => projectCashflow(null), { name: 'RangeError' });
    assert.throws(() => projectCashflow(baseSnapshot({ as_of: 'not-a-date' })), { name: 'RangeError' });
    assert.throws(() => projectCashflow(baseSnapshot({ settings: { ...BASE_SETTINGS, horizon_weeks: 0 } })), { name: 'RangeError' });
  });
});

describe('projectCashflow — cash pools', () => {
  test('a disabled pool is visible but excluded from opening_cash, flagged in provisional_reasons', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [
        { account_id: 'a1', account_code: '1000', name: 'Cash', balance: 100000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 100000, unresolved_posting_errors: 0 },
        { account_id: 'a2', account_code: '1030', name: 'Old Account', balance: 999999, is_enabled: false, last_reconciled_at: null, reconciled_balance: null, unresolved_posting_errors: 0 },
      ],
    }));
    assert.equal(result.opening_cash, 100000);
    const disabled = result.cash_pools.find((p) => p.account_id === 'a2');
    assert.ok(disabled.provisional_reasons.includes('disabled_excluded_from_total'));
    assert.equal(disabled.is_provisional, true);
  });

  test('stale reconciliation and posting errors mark a pool provisional but its balance still counts', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [
        { account_id: 'a1', account_code: '1000', name: 'Cash', balance: 50000, is_enabled: true, last_reconciled_at: '2026-01-01', reconciled_balance: 40000, unresolved_posting_errors: 2 },
      ],
    }));
    assert.equal(result.opening_cash, 50000); // still counted, not silently dropped
    const pool = result.cash_pools[0];
    assert.equal(pool.is_provisional, true);
    assert.deepEqual(pool.provisional_reasons.sort(), ['stale_reconciliation', 'unresolved_posting_errors']);
    assert.ok(result.warnings.some((w) => w.code === 'provisional_opening_cash'));
  });

  test('unresolved ledger errors mark ledger_health provisional and emit a critical warning', () => {
    const result = projectCashflow(baseSnapshot({
      ledger_health: { unposted_count: 3, oldest_unposted_days: 10, unresolved_error_count: 2 },
    }));
    assert.equal(result.ledger_health.is_provisional, true);
    assert.ok(result.warnings.some((w) => w.code === 'unresolved_posting_errors' && w.severity === 'critical'));
  });
});

describe('projectCashflow — receipts (money in)', () => {
  test('confirmed customer history weights the receipt at full value', () => {
    const result = projectCashflow(baseSnapshot({
      receipts: [{
        order_id: 'o1', customer_id: 'c1', customer_name: 'Acme', order_num: 'ORD-1',
        total_value: 500000, non_reversed_paid: 0, outstanding_amount: 500000,
        payment_due_date: '2026-10-01', invoice_issued_at: null, created_at: '2026-09-01', schedule: null,
      }],
      customer_histories: {
        c1: {
          settled_orders: [
            { order_id: 'p1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
            { order_id: 'p2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
            { order_id: 'p3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-05' },
          ],
        },
      },
    }));
    const allItems = result.weeks.flatMap((w) => w.money_in.items);
    assert.equal(allItems.length, 1);
    assert.equal(allItems[0].confidence, 'confirmed');
    assert.equal(allItems[0].weighted_amount, 500000);
  });

  test('a new customer with no history is weighted at 0.80, not full value', () => {
    const result = projectCashflow(baseSnapshot({
      receipts: [{
        order_id: 'o1', customer_id: 'new-cust', customer_name: 'New Co', order_num: 'ORD-2',
        total_value: 100000, non_reversed_paid: 0, outstanding_amount: 100000,
        payment_due_date: '2026-10-01', invoice_issued_at: null, created_at: '2026-09-01', schedule: null,
      }],
    }));
    const item = result.weeks.flatMap((w) => w.money_in.items)[0];
    assert.equal(item.confidence, 'likely');
    assert.equal(item.weighted_amount, 80000);
  });

  test('a schedule override skips historical-lag re-application and reports schedule_override source', () => {
    const result = projectCashflow(baseSnapshot({
      receipts: [{
        order_id: 'o1', customer_id: 'c1', customer_name: 'Acme', order_num: 'ORD-3',
        total_value: 200000, non_reversed_paid: 0, outstanding_amount: 200000,
        payment_due_date: '2026-09-25', invoice_issued_at: null, created_at: '2026-09-01',
        schedule: { id: 's1', planned_date: '2026-10-02', planned_amount: null, minimum_amount: null, priority: 'must_pay', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
      }],
      customer_histories: { c1: { settled_orders: [{ order_id: 'p1', payment_due_date: '2026-01-01', final_payment_date: '2026-02-15' }] } }, // huge lag, should NOT apply
    }));
    const item = result.weeks.flatMap((w) => w.money_in.items)[0];
    assert.equal(item.expected_date, '2026-10-02');
    assert.equal(item.date_resolution.source, 'schedule_override');
  });

  test('a receipt whose expected date falls beyond the horizon is not reported in any week', () => {
    const result = projectCashflow(baseSnapshot({
      receipts: [{
        order_id: 'o1', customer_id: 'c1', customer_name: 'Acme', order_num: 'ORD-4',
        total_value: 100000, non_reversed_paid: 0, outstanding_amount: 100000,
        payment_due_date: '2027-06-01', invoice_issued_at: null, created_at: '2026-09-01', schedule: null,
      }],
    }));
    assert.equal(result.weeks.flatMap((w) => w.money_in.items).length, 0);
  });

  test('receipt installments split collections and leave an uncovered balance visibly unplanned', () => {
    const result = projectCashflow(baseSnapshot({
      receipts: [{
        order_id: 'o-installments', customer_id: 'c1', customer_name: 'Client', order_num: 'ORD-1',
        total_value: 100000, non_reversed_paid: 0, outstanding_amount: 100000,
        payment_due_date: '2026-10-20', invoice_issued_at: '2026-09-01', created_at: '2026-09-01',
        schedule: { id: 'sc-r', planned_date: '2026-10-20', planned_amount: 100000, minimum_amount: null, priority: 'important', confidence_override: 'confirmed', hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [
          { id: 'ri1', installment_number: 1, planned_date: '2026-09-29', planned_amount: 30000, status: 'planned' },
          { id: 'ri2', installment_number: 2, planned_date: '2026-10-13', planned_amount: 40000, status: 'planned' },
        ],
      }],
    }));
    const items = result.weeks.flatMap(w => w.money_in.items);
    assert.equal(items.filter(i => !i.is_unplanned).length, 2);
    assert.equal(items.find(i => i.is_unplanned).outstanding_amount, 30000);
    assert.equal(result.weeks.reduce((sum, w) => sum + w.money_in.gross, 0), 70000);
    assert.equal(result.weeks.reduce((sum, w) => sum + w.money_in.unplanned, 0), 30000);
  });
});

describe('projectCashflow — outflows: priority, holds, installments', () => {
  test('a supplier purchase with no schedule uses the overdue/7-day/later priority rule', () => {
    const result = projectCashflow(baseSnapshot({
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: null, due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 60000, paid_amount: 0, outstanding_amount: 60000, schedule: null, installments: [],
      }],
    }));
    // No supplier terms, no settings default override here -> cashflow_default: 2026-09-01 + 14 = 2026-09-15,
    // which is before as_of (2026-09-23) -> overdue -> 'important'.
    const item = result.weeks.flatMap((w) => w.money_out.items)[0];
    assert.equal(item.priority, 'important');
    assert.equal(item.is_overdue, true);
  });

  test('a schedule with on_hold priority excludes the item from total_planned but keeps it visible and in `held`', () => {
    const result = projectCashflow(baseSnapshot({
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: '2026-09-10', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 60000, paid_amount: 0, outstanding_amount: 60000,
        schedule: { id: 'sc1', planned_date: '2026-10-01', planned_amount: 60000, minimum_amount: null, priority: 'on_hold', confidence_override: null, hold_reason: 'Awaiting quality dispute resolution', notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [],
      }],
    }));
    const week = result.weeks.find((w) => w.week_start <= '2026-10-01' && w.week_end >= '2026-10-01');
    assert.equal(week.money_out.total_planned, 0);
    assert.equal(week.money_out.held, 60000);
    assert.equal(week.money_out.items.length, 1);
    assert.equal(week.money_out.items[0].is_held, true);
    assert.equal(week.money_out.items[0].hold_reason, 'Awaiting quality dispute resolution');
  });

  test('an on_hold schedule with no hold_reason is rejected rather than silently accepted', () => {
    assert.throws(() => projectCashflow(baseSnapshot({
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: '2026-09-10', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 60000, paid_amount: 0, outstanding_amount: 60000,
        schedule: { id: 'sc1', planned_date: '2026-10-01', planned_amount: 60000, minimum_amount: null, priority: 'on_hold', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [],
      }],
    })), { name: 'RangeError' });
  });

  test('installments replace the schedule header amount and split across their own dates', () => {
    const result = projectCashflow(baseSnapshot({
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: '2026-09-10', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 100000, paid_amount: 0, outstanding_amount: 100000,
        schedule: { id: 'sc1', planned_date: '2026-10-01', planned_amount: 100000, minimum_amount: null, priority: 'important', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [
          { id: 'i1', installment_number: 1, planned_date: '2026-09-29', planned_amount: 40000, status: 'planned' },
          { id: 'i2', installment_number: 2, planned_date: '2026-10-13', planned_amount: 40000, status: 'planned' },
          { id: 'i3', installment_number: 3, planned_date: '2026-10-20', planned_amount: 20000, status: 'cancelled' },
        ],
      }],
    }));
    const items = result.weeks.flatMap((w) => w.money_out.items);
    // Two active installments (40000 + 40000 = 80000) + one unplanned-balance gap item (20000).
    assert.equal(items.length, 3);
    const gapItem = items.find((i) => i.unplanned_amount > 0);
    assert.equal(gapItem.unplanned_amount, 20000);
    assert.equal(gapItem.planned_amount, 0);
    const total = items.reduce((s, i) => s + i.planned_amount, 0);
    assert.equal(total, 80000); // gap item contributes 0 to planned
  });

  test('a statutory obligation is always must_pay even if a schedule tries to set a different priority', () => {
    const result = projectCashflow(baseSnapshot({
      payroll_statutory_obligations: [{
        source: 'payroll_sha', payroll_run_id: 'pr1', label: 'SHA — September', due_date: '2026-10-05',
        outstanding_amount: 45000, priority: 'must_pay',
        schedule: { id: 'sc1', planned_date: '2026-10-05', planned_amount: 45000, minimum_amount: null, priority: 'can_wait', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [],
      }],
    }));
    const item = result.weeks.flatMap((w) => w.money_out.items)[0];
    assert.equal(item.priority, 'must_pay');
    assert.ok(result.warnings.some((w) => w.code === 'schedule_conflicts_with_statutory_priority'));
  });

  test('regular payroll defaults to must_pay but a schedule CAN override it (not a hard floor)', () => {
    const result = projectCashflow(baseSnapshot({
      payroll_obligations: [{
        payroll_run_id: 'pr2', label: 'Payroll — September', period_end: '2026-09-30',
        net_pay: 300000, paid_amount: 0, outstanding_amount: 300000,
        schedule: { id: 'sc2', planned_date: '2026-10-01', planned_amount: 300000, minimum_amount: null, priority: 'important', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        installments: [],
      }],
    }));
    const item = result.weeks.flatMap((w) => w.money_out.items)[0];
    assert.equal(item.priority, 'important'); // schedule's priority wins, unlike statutory
  });

  test('regular payroll with no schedule defaults to must_pay, using period_end as the date', () => {
    const result = projectCashflow(baseSnapshot({
      payroll_obligations: [{
        payroll_run_id: 'pr3', label: 'Payroll — October', period_end: '2026-10-31',
        net_pay: 300000, paid_amount: 0, outstanding_amount: 300000, schedule: null, installments: [],
      }],
    }));
    const item = result.weeks.flatMap((w) => w.money_out.items)[0];
    assert.equal(item.priority, 'must_pay');
    assert.equal(item.planned_date, '2026-10-31');
  });

  test('manual obligation recurrence expands into one item per occurrence within the horizon', () => {
    const result = projectCashflow(baseSnapshot({
      manual_obligations: [{
        obligation_id: 'ob1', name: 'Office rent', payee: 'Landlord Ltd', amount: 50000, is_statutory: false,
        recurrence: 'monthly', day_of_month: 1, first_due_date: '2026-09-01', ends_on: null, is_active: true,
        default_priority: 'must_pay', occurrence_schedules: {},
      }],
    }));
    const items = result.weeks.flatMap((w) => w.money_out.items).filter((i) => i.source_type === 'manual_obligation');
    // Occurrences within [2026-09-28, 2026-12-27]: Oct 1, Nov 1, Dec 1 (Sep 1 is before the horizon).
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.planned_date).sort(), ['2026-10-01', '2026-11-01', '2026-12-01']);
  });

  test('an occurrence_schedules override applies to just that one occurrence', () => {
    const result = projectCashflow(baseSnapshot({
      manual_obligations: [{
        obligation_id: 'ob1', name: 'Office rent', payee: 'Landlord Ltd', amount: 50000, is_statutory: false,
        recurrence: 'monthly', day_of_month: 1, first_due_date: '2026-09-01', ends_on: '2026-11-01', is_active: true,
        default_priority: 'must_pay',
        occurrence_schedules: {
          '2026-10-01': { id: 'sc-oct', planned_date: '2026-10-15', planned_amount: 45000, minimum_amount: null, priority: 'can_wait', confidence_override: null, hold_reason: null, notes: null, last_reviewed_at: '2026-09-20', updated_at: '2026-09-20' },
        },
      }],
    }));
    const items = result.weeks.flatMap((w) => w.money_out.items).filter((i) => i.source_type === 'manual_obligation');
    const overridden = items.find((i) => i.planned_date === '2026-10-15');
    assert.ok(overridden);
    assert.equal(overridden.priority, 'can_wait');
    assert.equal(overridden.unplanned_amount, 5000); // 50000 - 45000
    const notOverridden = items.find((i) => i.planned_date === '2026-11-01');
    assert.equal(notOverridden.priority, 'must_pay');
  });

  test('manual-obligation occurrence installments replace the schedule header amount', () => {
    const result = projectCashflow(baseSnapshot({
      manual_obligations: [{
        obligation_id: 'ob-instalments', name: 'Workshop rent', payee: 'Landlord', amount: 50000, is_statutory: false,
        recurrence: 'once', day_of_month: null, first_due_date: '2026-10-01', ends_on: null, is_active: true,
        default_priority: 'must_pay',
        occurrence_schedules: {
          '2026-10-01': {
            id: 'sc-ob', planned_date: '2026-10-01', planned_amount: 50000, minimum_amount: null,
            priority: 'important', confidence_override: null, hold_reason: null, notes: null,
            last_reviewed_at: '2026-09-20', updated_at: '2026-09-20',
            installments: [
              { id: 'obi1', installment_number: 1, planned_date: '2026-10-01', planned_amount: 20000, status: 'planned' },
              { id: 'obi2', installment_number: 2, planned_date: '2026-10-15', planned_amount: 30000, status: 'planned' },
            ],
          },
        },
      }],
    }));
    const items = result.weeks.flatMap(w => w.money_out.items).filter(i => i.source_id === 'ob-instalments');
    assert.equal(items.length, 2);
    assert.equal(items.reduce((sum, item) => sum + item.planned_amount, 0), 50000);
    assert.deepEqual(items.map(i => i.installment_id).sort(), ['obi1', 'obi2']);
  });

  test('untracked SHA remittances make the forecast provisional and emit a visible warning', () => {
    const result = projectCashflow(baseSnapshot({
      payroll_statutory_obligations: [{
        source: 'payroll_sha', payroll_run_id: 'sha-untracked', label: 'SHA remittance', due_date: '2026-10-09',
        outstanding_amount: 1000, priority: 'must_pay', schedule: null, installments: [],
      }],
    }));
    assert.equal(result.ledger_health.is_provisional, true);
    assert.ok(result.warnings.some(w => w.code === 'sha_remittance_status_untracked'));
  });

  test('an inactive manual obligation generates no occurrences at all', () => {
    const result = projectCashflow(baseSnapshot({
      manual_obligations: [{
        obligation_id: 'ob1', name: 'Cancelled subscription', payee: null, amount: 5000, is_statutory: false,
        recurrence: 'monthly', day_of_month: 1, first_due_date: '2026-09-01', ends_on: null, is_active: false,
        default_priority: 'can_wait', occurrence_schedules: {},
      }],
    }));
    assert.equal(result.weeks.flatMap((w) => w.money_out.items).length, 0);
  });
});

describe('projectCashflow — committed BoQ', () => {
  test('committed BoQ never subtracts from official closing, only from downside', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 1000000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 1000000, unresolved_posting_errors: 0 }],
      committed_boq: [{
        material_estimate_id: 'me1', job_id: 'job1', order_id: 'ord1', supplier_id: 's1', plan_status: 'Active',
        needed_by: '2026-09-30', gross_commitment: 240000, linked_purchase_amount: 80000, net_commitment: 160000,
      }],
    }));
    const week = result.weeks.find((w) => w.committed_boq.gross > 0);
    assert.equal(week.committed_boq.net, 160000);
    assert.equal(week.closing, week.opening); // official closing unaffected by BoQ
    assert.equal(week.downside_closing, week.downside_opening - 160000);
  });

  test('draft BoQ rows never enter any week\'s committed_boq, only boq_summary.draft_pipeline', () => {
    const result = projectCashflow(baseSnapshot({
      draft_boq_pipeline: [{
        material_estimate_id: 'me2', job_id: 'job2', order_id: 'ord2', supplier_id: null, plan_status: 'Draft',
        needed_by: '2026-10-10', gross_commitment: 120000, linked_purchase_amount: 0, net_commitment: 120000,
      }],
    }));
    assert.equal(result.boq_summary.draft_pipeline, 120000);
    assert.equal(result.weeks.every((w) => w.committed_boq.gross === 0), true);
  });

  test('link coverage percent is 0, not 100, when gross commitment is zero', () => {
    const result = projectCashflow(baseSnapshot({}));
    assert.equal(result.boq_summary.link_coverage_percent, 0);
  });

  test('link coverage percent is computed correctly and flags incomplete coverage', () => {
    const result = projectCashflow(baseSnapshot({
      committed_boq: [{
        material_estimate_id: 'me1', job_id: 'job1', order_id: 'ord1', supplier_id: 's1', plan_status: 'Active',
        needed_by: '2026-10-01', gross_commitment: 464000, linked_purchase_amount: 148000, net_commitment: 316000,
      }],
    }));
    assert.ok(Math.abs(result.boq_summary.link_coverage_percent - 31.896551724137932) < 1e-9);
    assert.ok(result.warnings.some((w) => w.code === 'incomplete_boq_link_coverage'));
  });
});

describe('projectCashflow — downside chaining (corrected)', () => {
  test('downside_opening for week 0 equals opening_cash, not week 0\'s official closing', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 1636000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 1636000, unresolved_posting_errors: 0 }],
      receipts: [{
        order_id: 'o1', customer_id: 'c1', customer_name: 'Acme', order_num: 'ORD-1',
        total_value: 500000, non_reversed_paid: 0, outstanding_amount: 500000,
        payment_due_date: '2026-09-28', invoice_issued_at: null, created_at: '2026-09-01', schedule: null,
      }],
      customer_histories: {
        c1: { settled_orders: [
          { order_id: 'p1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
          { order_id: 'p2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-03' },
          { order_id: 'p3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-05' },
        ] },
      },
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: '2026-09-29', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 498000, paid_amount: 0, outstanding_amount: 498000, schedule: null, installments: [],
      }],
      committed_boq: [{
        material_estimate_id: 'me1', job_id: 'job1', order_id: 'ord1', supplier_id: 's1', plan_status: 'Active',
        needed_by: '2026-09-30', gross_commitment: 240000, linked_purchase_amount: 80000, net_commitment: 160000,
      }],
    }));
    const w0 = result.weeks[0];
    assert.equal(w0.opening, 1636000);
    assert.equal(w0.money_in.gross, 500000);
    assert.equal(w0.money_in.weighted, 500000); // confirmed history -> full weight
    assert.equal(w0.money_out.total_planned, 498000);
    assert.equal(w0.closing, 1636000 + 500000 - 498000); // 1638000
    assert.equal(w0.downside_opening, 1636000); // the corrected rule
    assert.equal(w0.downside_closing, 1636000 + 500000 - 498000 - 160000); // 1478000

    const w1 = result.weeks[1];
    assert.equal(w1.opening, w0.closing);
    assert.equal(w1.downside_opening, w0.downside_closing); // chains from downside, not from official closing
  });

  test('downside series chains independently across multiple weeks, never re-deriving from the official series', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 500000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 500000, unresolved_posting_errors: 0 }],
      committed_boq: [
        { material_estimate_id: 'me1', job_id: 'job1', order_id: 'ord1', supplier_id: null, plan_status: 'Active', needed_by: '2026-09-30', gross_commitment: 50000, linked_purchase_amount: 0, net_commitment: 50000 },
        { material_estimate_id: 'me2', job_id: 'job2', order_id: 'ord2', supplier_id: null, plan_status: 'Active', needed_by: '2026-10-07', gross_commitment: 30000, linked_purchase_amount: 0, net_commitment: 30000 },
      ],
    }));
    // No money in/out at all -> official series flat at 500000 every week.
    assert.ok(result.weeks.every((w) => w.closing === 500000));
    // Downside: week0 downside_opening=500000, minus 50000 BoQ -> 450000; week1 downside_opening=450000, minus 30000 -> 420000; flat after.
    assert.equal(result.weeks[0].downside_closing, 450000);
    assert.equal(result.weeks[1].downside_opening, 450000);
    assert.equal(result.weeks[1].downside_closing, 420000);
    assert.equal(result.weeks[2].downside_opening, 420000);
    assert.equal(result.weeks[2].downside_closing, 420000);
  });
});

describe('projectCashflow — shortfall detection and deferrable item', () => {
  test('the first shortfall week is found and its warning + summary are consistent', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 100000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 100000, unresolved_posting_errors: 0 }],
      supplier_purchases: [{
        purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01',
        due_date: '2026-09-29', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
        total_amount: 250000, paid_amount: 0, outstanding_amount: 250000, schedule: null, installments: [],
      }],
    }));
    assert.ok(result.first_shortfall_week);
    assert.equal(result.first_shortfall_week.week_start, result.weeks[0].week_start);
    // With no further inflows, the negative balance from week 0 never recovers,
    // so every subsequent week is also a shortfall — that's correct, not a bug:
    // classifyWeek looks only at that week's own closing balance (see its own
    // header comment), and there is nothing in this fixture to bring cash back
    // above zero.
    assert.equal(result.counts.shortfall_weeks, 13);
    assert.ok(result.warnings.some((w) => w.code === 'first_official_shortfall' && w.severity === 'critical'));
  });

  test('the suggested deferrable item is never must_pay, never held, and is the largest eligible amount', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 50000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 50000, unresolved_posting_errors: 0 }],
      payroll_obligations: [{
        payroll_run_id: 'pr1', label: 'Payroll', period_end: '2026-09-30',
        net_pay: 200000, paid_amount: 0, outstanding_amount: 200000, schedule: null, installments: [],
      }],
      supplier_purchases: [
        {
          purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Big Supplier', purchase_date: '2026-09-01',
          due_date: '2026-09-29', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
          total_amount: 90000, paid_amount: 0, outstanding_amount: 90000, schedule: null, installments: [],
        },
        {
          purchase_id: 'pu2', supplier_id: 's2', supplier_name: 'Small Supplier', purchase_date: '2026-09-01',
          due_date: '2026-09-29', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null,
          total_amount: 30000, paid_amount: 0, outstanding_amount: 30000, schedule: null, installments: [],
        },
      ],
    }));
    const deferrable = result.first_shortfall_week.largest_deferrable_item;
    assert.ok(deferrable);
    assert.notEqual(deferrable.priority, 'must_pay'); // excludes payroll (must_pay)
    assert.equal(deferrable.source_id, 'pu1'); // the larger of the two eligible supplier purchases
  });

  test('when every outflow is must_pay, there is no deferrable item even in a shortfall week', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [{ account_id: 'a1', account_code: '1000', name: 'Cash', balance: 10000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 10000, unresolved_posting_errors: 0 }],
      payroll_statutory_obligations: [{
        source: 'payroll_sha', payroll_run_id: 'pr1', label: 'SHA', due_date: '2026-09-29',
        outstanding_amount: 500000, priority: 'must_pay', schedule: null, installments: [],
      }],
    }));
    assert.ok(result.first_shortfall_week);
    assert.equal(result.first_shortfall_week.largest_deferrable_item, null);
  });
});

describe('projectCashflow — a hand-built 13-week reconciliation', () => {
  test('every week reconciles: closing = opening + weighted_in - planned_out, and totals match counts', () => {
    const result = projectCashflow(baseSnapshot({
      cash_pools: [
        { account_id: 'a1', account_code: '1000', name: 'Cash on Hand', balance: 84000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 84000, unresolved_posting_errors: 0 },
        { account_id: 'a2', account_code: '1010', name: 'Bank', balance: 1552000, is_enabled: true, last_reconciled_at: '2026-09-20', reconciled_balance: 1552000, unresolved_posting_errors: 0 },
      ],
      receipts: [
        { order_id: 'o1', customer_id: 'c1', customer_name: 'Acme', order_num: 'ORD-1', total_value: 500000, non_reversed_paid: 0, outstanding_amount: 500000, payment_due_date: '2026-09-28', invoice_issued_at: null, created_at: '2026-09-01', schedule: null },
        { order_id: 'o2', customer_id: 'c2', customer_name: 'Beta', order_num: 'ORD-2', total_value: 300000, non_reversed_paid: 0, outstanding_amount: 300000, payment_due_date: '2026-11-10', invoice_issued_at: null, created_at: '2026-10-01', schedule: null },
      ],
      customer_histories: {
        c1: { settled_orders: [
          { order_id: 'p1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
          { order_id: 'p2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-03' },
          { order_id: 'p3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-05' },
        ] },
      },
      supplier_purchases: [
        { purchase_id: 'pu1', supplier_id: 's1', supplier_name: 'Timber Co', purchase_date: '2026-09-01', due_date: '2026-09-29', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null, total_amount: 380000, paid_amount: 0, outstanding_amount: 380000, schedule: null, installments: [] },
      ],
      payroll_obligations: [
        { payroll_run_id: 'pr1', label: 'Payroll — September', period_end: '2026-09-30', net_pay: 118000, paid_amount: 0, outstanding_amount: 118000, schedule: null, installments: [] },
      ],
      committed_boq: [
        { material_estimate_id: 'me1', job_id: 'job1', order_id: 'ord1', supplier_id: 's1', plan_status: 'Active', needed_by: '2026-09-30', gross_commitment: 240000, linked_purchase_amount: 80000, net_commitment: 160000 },
      ],
    }));

    assert.equal(result.weeks.length, 13);

    // Manual reconciliation of every week.
    let expectedOfficial = result.opening_cash;
    let expectedDownside = result.opening_cash;
    for (const w of result.weeks) {
      assert.equal(w.opening, expectedOfficial, `week ${w.index} opening mismatch`);
      assert.equal(w.closing, w.opening + w.money_in.weighted - w.money_out.total_planned, `week ${w.index} closing arithmetic`);
      assert.equal(w.downside_opening, expectedDownside, `week ${w.index} downside_opening mismatch`);
      assert.equal(
        w.downside_closing,
        w.downside_opening + w.money_in.weighted - w.money_out.total_planned - w.committed_boq.net,
        `week ${w.index} downside_closing arithmetic`,
      );
      expectedOfficial = w.closing;
      expectedDownside = w.downside_closing;
    }

    // Counts must add up to the total number of weeks.
    const { normal_weeks, low_cash_weeks, shortfall_weeks } = result.counts;
    assert.equal(normal_weeks + low_cash_weeks + shortfall_weeks, 13);

    // Week 0 specifically: 380000 (supplier) + 118000 (payroll) = 498000 planned out.
    assert.equal(result.weeks[0].money_out.total_planned, 498000);
    assert.equal(result.weeks[0].money_out.must_pay, 118000);
    assert.equal(result.weeks[0].money_out.important, 380000); // due within 7 days of as_of
    assert.equal(result.weeks[0].closing, 1636000 + 500000 - 498000);
  });
});
