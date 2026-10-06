/**
 * shared/lib/cashflow/__tests__/resolveDueDate.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSupplierPurchaseDueDate,
  resolveCustomerReceiptDate,
} from '../resolveDueDate.js';

const SETTINGS = { default_supplier_terms_days: 14 };

describe('resolveSupplierPurchaseDueDate — supplier-date tests', () => {
  test('explicit stored date', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: '2026-08-20', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-20');
    assert.equal(r.source, 'explicit');
    assert.equal(r.label, 'Explicit date');
    assert.equal(r.assumed, false);
    assert.equal(r.baseline_date, '2026-08-01');
    assert.equal(r.adjustment_days, 19);
    assert.equal(r.explanation, undefined);
  });

  test('stored supplier-terms date uses the row\'s own snapshot', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: '2026-08-31', due_date_source: 'supplier_terms', due_date_terms_days: 30, current_supplier_terms_days: 30 },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-31');
    assert.equal(r.source, 'supplier_terms');
    assert.equal(r.label, 'Supplier terms · 30 days');
    assert.equal(r.assumed, false);
    assert.equal(r.adjustment_days, 30);
  });

  test('terms snapshot remains stable after the supplier\'s live terms change', () => {
    // Purchase was made when the supplier had 30-day terms; supplier has
    // since moved to 60-day terms (current_supplier_terms_days reflects the
    // live value). The resolved date must still reflect the snapshot taken
    // at purchase time, not the supplier's current terms.
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: '2026-08-31', due_date_source: 'supplier_terms', due_date_terms_days: 30, current_supplier_terms_days: 60 },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-31');
    assert.equal(r.label, 'Supplier terms · 30 days');
    assert.equal(r.adjustment_days, 30);
  });

  test('singular "day" wording for a 1-day terms snapshot', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: '2026-08-02', due_date_source: 'supplier_terms', due_date_terms_days: 1, current_supplier_terms_days: 1 },
      SETTINGS,
    );
    assert.equal(r.label, 'Supplier terms · 1 day');
  });

  test('legacy row with current supplier terms is assumed, not confirmed', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: null, due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: 45 },
      SETTINGS,
    );
    assert.equal(r.date, '2026-09-15');
    assert.equal(r.source, 'current_supplier_terms');
    assert.equal(r.label, 'Assumed by Cashflow');
    assert.equal(r.assumed, true);
    assert.equal(r.adjustment_days, 45);
    assert.match(r.explanation, /has no recorded due date/);
  });

  test('legacy row, supplier terms of exactly 0 (cash on delivery) still counts as recorded', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: null, due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: 0 },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-01');
    assert.equal(r.source, 'current_supplier_terms');
    assert.equal(r.adjustment_days, 0);
  });

  test('settings-default fallback is assumed when supplier has no terms at all', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: null, due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: null },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-15');
    assert.equal(r.source, 'cashflow_default');
    assert.equal(r.label, 'Assumed by Cashflow');
    assert.equal(r.assumed, true);
    assert.equal(r.adjustment_days, 14);
    assert.match(r.explanation, /no supplier terms/);
  });

  test('zero-day terms snapshot resolves to the purchase date itself', () => {
    const r = resolveSupplierPurchaseDueDate(
      { purchase_date: '2026-08-01', due_date: '2026-08-01', due_date_source: 'supplier_terms', due_date_terms_days: 0, current_supplier_terms_days: 0 },
      SETTINGS,
    );
    assert.equal(r.date, '2026-08-01');
    assert.equal(r.adjustment_days, 0);
  });

  test('rejects an invalid purchase_date', () => {
    assert.throws(
      () => resolveSupplierPurchaseDueDate({ purchase_date: 'not-a-date' }, SETTINGS),
      { name: 'RangeError' },
    );
  });

  test('rejects a stored due_date with no valid provenance', () => {
    assert.throws(
      () => resolveSupplierPurchaseDueDate(
        { purchase_date: '2026-08-01', due_date: '2026-08-20', due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: null },
        SETTINGS,
      ),
      { name: 'RangeError' },
    );
    assert.throws(
      () => resolveSupplierPurchaseDueDate(
        { purchase_date: '2026-08-01', due_date: '2026-08-20', due_date_source: 'unrecorded', due_date_terms_days: null, current_supplier_terms_days: null },
        SETTINGS,
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects a supplier_terms source with no terms snapshot', () => {
    assert.throws(
      () => resolveSupplierPurchaseDueDate(
        { purchase_date: '2026-08-01', due_date: '2026-08-20', due_date_source: 'supplier_terms', due_date_terms_days: null, current_supplier_terms_days: 19 },
        SETTINGS,
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects a due date before the purchase date, even though the DB already prevents this', () => {
    assert.throws(
      () => resolveSupplierPurchaseDueDate(
        { purchase_date: '2026-08-20', due_date: '2026-08-01', due_date_source: 'explicit', due_date_terms_days: null, current_supplier_terms_days: null },
        SETTINGS,
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects a missing settings default when the fallback tier is actually reached', () => {
    assert.throws(
      () => resolveSupplierPurchaseDueDate(
        { purchase_date: '2026-08-01', due_date: null, due_date_source: null, due_date_terms_days: null, current_supplier_terms_days: null },
        { default_supplier_terms_days: null },
      ),
      { name: 'RangeError' },
    );
  });
});

describe('resolveCustomerReceiptDate', () => {
  test('schedule override wins outright and does not re-apply historical lag', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-01', invoice_issued_at: null, created_at: '2026-07-01', schedule: { planned_date: '2026-08-10' } },
      { median_lag_days: 20 },
    );
    assert.equal(r.date, '2026-08-10');
    assert.equal(r.source, 'schedule_override');
    assert.equal(r.label, 'Planned date override');
    assert.equal(r.assumed, false);
    assert.equal(r.baseline_date, null);
    assert.equal(r.adjustment_days, null);
  });

  test('stored due date shifted by positive median lag', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-01', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      { median_lag_days: 12 },
    );
    assert.equal(r.date, '2026-08-13');
    assert.equal(r.source, 'payment_due_date');
    assert.equal(r.assumed, false);
    assert.equal(r.baseline_date, '2026-08-01');
    assert.equal(r.adjustment_days, 12);
  });

  test('negative median lag (customer pays early) shifts the expected date earlier', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-20', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      { median_lag_days: -5 },
    );
    assert.equal(r.date, '2026-08-15');
    assert.equal(r.adjustment_days, -5);
    assert.match(r.label, /-5d/);
  });

  test('zero lag against a stored due date reports the plain label, no assumption', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-20', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      { median_lag_days: 0 },
    );
    assert.equal(r.date, '2026-08-20');
    assert.equal(r.label, 'Payment due date');
    assert.equal(r.assumed, false);
  });

  test('fractional median lag rounds to a whole day before shifting the date', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-01', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      { median_lag_days: 5.5 },
    );
    assert.equal(r.date, '2026-08-07'); // rounds 5.5 -> 6
    assert.equal(r.adjustment_days, 6);
  });

  test('invoice-issued fallback exposes the 30-day assumption', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: null, invoice_issued_at: '2026-08-01T10:00:00Z', created_at: '2026-07-01', schedule: null },
      { median_lag_days: 5 },
    );
    assert.equal(r.date, '2026-09-05'); // 1 Aug + 30 + 5 = 5 Sep
    assert.equal(r.source, 'invoice_issued_fallback');
    assert.equal(r.label, 'Assumed by Cashflow');
    assert.equal(r.assumed, true);
    assert.equal(r.baseline_date, '2026-08-01');
    assert.equal(r.adjustment_days, 35);
  });

  test('created_at fallback used when neither due date nor invoice date exists', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: null, invoice_issued_at: null, created_at: '2026-07-01T00:00:00Z', schedule: null },
      { median_lag_days: 10 },
    );
    assert.equal(r.date, '2026-08-10'); // 1 Jul + 30 + 10 = 10 Aug
    assert.equal(r.source, 'cashflow_default');
    assert.equal(r.assumed, true);
  });

  test('new customer with no settled history uses 0 lag, not a fabricated default', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: null, invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      { median_lag_days: null },
    );
    assert.equal(r.date, '2026-07-31'); // 1 Jul + 30 + 0
    assert.equal(r.adjustment_days, 30);
  });

  test('missing customerHistory entirely also falls back to 0 lag', () => {
    const r = resolveCustomerReceiptDate(
      { payment_due_date: '2026-08-01', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
      null,
    );
    assert.equal(r.date, '2026-08-01');
    assert.equal(r.adjustment_days, 0);
  });

  test('rejects an invalid created_at when it is the only baseline available', () => {
    assert.throws(
      () => resolveCustomerReceiptDate(
        { payment_due_date: null, invoice_issued_at: null, created_at: 'not-a-date', schedule: null },
        { median_lag_days: 5 },
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects an invalid stored payment_due_date', () => {
    assert.throws(
      () => resolveCustomerReceiptDate(
        { payment_due_date: 'not-a-date', invoice_issued_at: null, created_at: '2026-07-01', schedule: null },
        { median_lag_days: 0 },
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects an invalid schedule.planned_date', () => {
    assert.throws(
      () => resolveCustomerReceiptDate(
        { payment_due_date: '2026-08-01', invoice_issued_at: null, created_at: '2026-07-01', schedule: { planned_date: 'not-a-date' } },
        { median_lag_days: 0 },
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects a missing receipt', () => {
    assert.throws(() => resolveCustomerReceiptDate(null, null), { name: 'RangeError' });
  });
});
