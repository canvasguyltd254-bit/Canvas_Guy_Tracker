/**
 * shared/lib/cashflow/__tests__/confidence.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  confidenceWeight,
  calculateCustomerPaymentHistory,
  deriveReceiptConfidence,
} from '../confidence.js';

const AS_OF = '2026-09-24';

describe('median', () => {
  test('odd-length array returns the middle value', () => {
    assert.equal(median([5, 1, 3]), 3);
  });
  test('even-length array averages the two middle values', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  test('single value returns itself', () => {
    assert.equal(median([42]), 42);
  });
  test('unsorted input with negatives is handled correctly', () => {
    assert.equal(median([10, -5, 0]), 0);
  });
  test('rejects an empty array rather than returning 0 or NaN', () => {
    assert.throws(() => median([]), { name: 'RangeError' });
  });
  test('rejects non-numeric entries', () => {
    assert.throws(() => median([1, '2', 3]), { name: 'RangeError' });
    assert.throws(() => median([1, NaN, 3]), { name: 'RangeError' });
  });
});

describe('confidenceWeight', () => {
  test('exact spec weights', () => {
    assert.equal(confidenceWeight('confirmed'), 1.00);
    assert.equal(confidenceWeight('likely'), 0.80);
    assert.equal(confidenceWeight('uncertain'), 0.50);
  });
  test('rejects an unknown confidence value', () => {
    assert.throws(() => confidenceWeight('sure'), { name: 'RangeError' });
    assert.throws(() => confidenceWeight(undefined), { name: 'RangeError' });
  });
});

describe('calculateCustomerPaymentHistory', () => {
  test('no settled orders -> count 0, median null, honest "no history" label', () => {
    const h = calculateCustomerPaymentHistory([]);
    assert.equal(h.settled_order_count, 0);
    assert.equal(h.median_lag_days, null);
    assert.equal(h.sample_label, 'No settled order history');
  });

  test('a single settled order paid early -> negative lag', () => {
    const h = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-06-15', final_payment_date: '2026-06-10' },
    ]);
    assert.equal(h.settled_order_count, 1);
    assert.equal(h.median_lag_days, -5);
  });

  test('spec example shape: median 34 days over 6 settled orders', () => {
    // Six orders whose lag days sort to a median of 34.
    const lagsWanted = [10, 20, 30, 38, 50, 60]; // median of middle two (30,38) = 34
    const orders = lagsWanted.map((lag, i) => ({
      order_id: `o${i}`,
      payment_due_date: '2026-01-01',
      final_payment_date: addDays('2026-01-01', lag),
    }));
    const h = calculateCustomerPaymentHistory(orders);
    assert.equal(h.settled_order_count, 6);
    assert.equal(h.median_lag_days, 34);
    assert.equal(h.sample_label, 'Median 34 days over 6 settled orders');
  });

  test('rejects a malformed entry rather than silently skipping it', () => {
    assert.throws(
      () => calculateCustomerPaymentHistory([
        { order_id: 'o1', payment_due_date: 'not-a-date', final_payment_date: '2026-06-10' },
      ]),
      { name: 'RangeError' },
    );
    assert.throws(
      () => calculateCustomerPaymentHistory([
        { order_id: 'o1', payment_due_date: '2026-06-15', final_payment_date: null },
      ]),
      { name: 'RangeError' },
    );
  });

  // Reversed-payment / cancelled-order exclusion is the snapshot builder's
  // job (see file header) — by the time an order reaches this function it
  // is assumed already eligible. This is verified structurally: an array
  // that has already had a reversed-payment order filtered out produces
  // exactly the history you'd expect from the remaining eligible orders.
  test('history reflects only the orders passed in, as if already filtered upstream', () => {
    const eligibleOnly = [
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-05' }, // lag 4
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-08' }, // lag 7
    ];
    const h = calculateCustomerPaymentHistory(eligibleOnly);
    assert.equal(h.settled_order_count, 2);
    assert.equal(h.median_lag_days, 5.5);
  });
});

describe('deriveReceiptConfidence', () => {
  test('new customer, no history -> likely (never confirmed)', () => {
    const history = calculateCustomerPaymentHistory([]);
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'likely');
    assert.equal(confidenceWeight(r.confidence), 0.80);
    assert.equal(r.derived_confidence, 'likely');
    assert.equal(r.source, 'derived');
  });

  test('two fast settlements (fewer than 3) -> likely, even though lag is excellent', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
    ]);
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'likely');
  });

  test('three fast settlements (median lag <= 7) -> confirmed', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-06' },
    ]);
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'confirmed');
    assert.equal(confidenceWeight(r.confidence), 1.00);
  });

  test('median lag between 8 and 30 inclusive -> likely, even with 3+ settlements', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: addDays('2026-01-01', 15) },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: addDays('2026-02-01', 15) },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: addDays('2026-03-01', 15) },
    ]);
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'likely');
  });

  test('median lag over 30 days -> uncertain, regardless of settled-order count', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: addDays('2026-01-01', 45) },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: addDays('2026-02-01', 45) },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: addDays('2026-03-01', 45) },
    ]);
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'uncertain');
    assert.equal(confidenceWeight(r.confidence), 0.50);
  });

  test('current receipt 60+ days overdue forces uncertain even with a perfect history', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-06' },
    ]);
    // Due 2026-07-20, as_of 2026-09-24 -> 66 days overdue.
    const r = deriveReceiptConfidence({ payment_due_date: '2026-07-20' }, history, null, AS_OF);
    assert.equal(r.confidence, 'uncertain');
  });

  test('exactly 59 days overdue does not trigger the severe-overdue rule', () => {
    const history = calculateCustomerPaymentHistory([]);
    const dueDate = addDays(AS_OF, -59);
    const r = deriveReceiptConfidence({ payment_due_date: dueDate }, history, null, AS_OF);
    // Falls through to the "fewer than 3 settled orders" branch -> likely,
    // not uncertain — confirms the 60-day boundary is not off-by-one.
    assert.equal(r.confidence, 'likely');
  });

  test('no recorded due date -> overdue-ness unknown, not assumed severe', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-06' },
    ]);
    const r = deriveReceiptConfidence({ payment_due_date: null }, history, null, AS_OF);
    assert.equal(r.confidence, 'confirmed');
  });

  test('schedule confidence_override wins, but derived_confidence is still returned', () => {
    const history = calculateCustomerPaymentHistory([]); // would derive to 'likely'
    const r = deriveReceiptConfidence(
      { payment_due_date: '2026-09-20' },
      history,
      { confidence_override: 'confirmed' },
      AS_OF,
    );
    assert.equal(r.confidence, 'confirmed');
    assert.equal(r.source, 'human_override');
    assert.equal(r.derived_confidence, 'likely');
  });

  test('an override does not need to agree with the derived value in either direction', () => {
    const history = calculateCustomerPaymentHistory([
      { order_id: 'o1', payment_due_date: '2026-01-01', final_payment_date: '2026-01-03' },
      { order_id: 'o2', payment_due_date: '2026-02-01', final_payment_date: '2026-02-04' },
      { order_id: 'o3', payment_due_date: '2026-03-01', final_payment_date: '2026-03-06' },
    ]); // would derive to 'confirmed'
    const r = deriveReceiptConfidence(
      { payment_due_date: '2026-09-20' },
      history,
      { confidence_override: 'uncertain' },
      AS_OF,
    );
    assert.equal(r.confidence, 'uncertain');
    assert.equal(r.source, 'human_override');
    assert.equal(r.derived_confidence, 'confirmed');
  });

  test('an unrecognised override value is ignored, falling back to the derived confidence', () => {
    const history = calculateCustomerPaymentHistory([]);
    const r = deriveReceiptConfidence(
      { payment_due_date: '2026-09-20' },
      history,
      { confidence_override: 'not_a_real_value' },
      AS_OF,
    );
    assert.equal(r.confidence, 'likely');
    assert.equal(r.source, 'derived');
  });

  test('missing customerHistory is treated the same as zero history', () => {
    const r = deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, null, null, AS_OF);
    assert.equal(r.confidence, 'likely');
  });

  test('rejects a malformed customerHistory (count > 0 but no median) rather than guessing', () => {
    assert.throws(
      () => deriveReceiptConfidence(
        { payment_due_date: '2026-09-20' },
        { settled_order_count: 3, median_lag_days: null },
        null,
        AS_OF,
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects a missing or invalid asOf rather than reading system time', () => {
    const history = calculateCustomerPaymentHistory([]);
    assert.throws(() => deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, undefined), { name: 'RangeError' });
    assert.throws(() => deriveReceiptConfidence({ payment_due_date: '2026-09-20' }, history, null, 'not-a-date'), { name: 'RangeError' });
  });

  test('rejects a missing receipt', () => {
    const history = calculateCustomerPaymentHistory([]);
    assert.throws(() => deriveReceiptConfidence(null, history, null, AS_OF), { name: 'RangeError' });
  });
});

// Local helper for building test fixtures — not part of the module under
// test. Mirrors shared/lib/isoDate.js's addDaysToIsoDate but kept local so
// this test file has no hidden coupling to how the fixture dates are built.
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
