import test from 'node:test';
import assert from 'node:assert/strict';
import { isCreditOrder } from '../isCreditOrder.js';

test('30 day, 60 day and custom terms are credit for every customer type', () => {
  for (const customer_type of ['retail', 'commercial', 'reseller', null, undefined]) {
    for (const payment_terms of ['30_day', '60_day', 'custom']) {
      assert.equal(isCreditOrder({ customer_type, payment_terms }), true, `${customer_type} ${payment_terms}`);
    }
  }
});

test('cash and deposit terms are never credit, even for commercial and reseller customers', () => {
  for (const customer_type of ['retail', 'commercial', 'reseller']) {
    for (const payment_terms of ['cash_before', '50_deposit', null, undefined, '']) {
      assert.equal(isCreditOrder({ customer_type, payment_terms }), false, `${customer_type} ${payment_terms}`);
    }
  }
});

test('missing order is not credit', () => {
  assert.equal(isCreditOrder(null), false);
  assert.equal(isCreditOrder(undefined), false);
});
