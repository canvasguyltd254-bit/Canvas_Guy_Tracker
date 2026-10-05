import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceBreakdown, computeLineAmounts } from '../invoiceLines.js';

const order = { pricing_mode: 'vat_inclusive', total_value: 1160 };
const quote = { quote_num: 'Q-001', revision: 2, total: 1000, pricing_mode: 'vat_inclusive' };

test('lines come from current order_items, not the quotation', () => {
  const b = buildInvoiceBreakdown({
    order, quote, taxStatus: 'taxable',
    orderItems: [
      { id: 'a', description: 'Chair', category: 'Chairs', quantity: 1, unit_price: 1000, gross_amount: 1000, net_amount: 862.07, vat_amount: 137.93, sort_order: 0 },
      { id: 'b', description: 'Packaging', category: 'Packaging', quantity: 1, unit_price: 160, gross_amount: 160, net_amount: 137.93, vat_amount: 22.07, sort_order: 1 },
    ],
  });
  assert.equal(b.source, 'order_items');
  assert.equal(b.items.length, 2);
  assert.equal(b.total, 1160);                       // 1000 quoted + 160 added after conversion
  assert.equal(b.quotation.original_total, 1000);
  assert.equal(b.quotation.current_total, 1160);
  assert.equal(b.quotation.changed, true);
  assert.equal(b.total_mismatch, false);
});

test('total is the sum of line gross amounts', () => {
  const b = buildInvoiceBreakdown({
    order: { ...order, total_value: 300 }, quote: null, taxStatus: 'taxable',
    orderItems: [
      { quantity: 2, unit_price: 100, gross_amount: 200, net_amount: 172.41, vat_amount: 27.59 },
      { quantity: 1, unit_price: 100, gross_amount: 100, net_amount: 86.21, vat_amount: 13.79 },
    ],
  });
  assert.equal(b.total, 300);
  assert.equal(Math.round((b.subtotal + b.vat_amount) * 100) / 100, 300);
  assert.equal(b.quotation, null);
});

test('legacy mismatch is flagged, never hidden', () => {
  const b = buildInvoiceBreakdown({
    order: { ...order, total_value: 999 }, quote: null, taxStatus: 'taxable',
    orderItems: [{ quantity: 1, unit_price: 500, gross_amount: 500, net_amount: 431.03, vat_amount: 68.97 }],
  });
  assert.equal(b.total, 500);
  assert.equal(b.total_mismatch, true);
});

test('zero-stored rows fall back to unit_price x quantity by pricing mode', () => {
  const inc = computeLineAmounts({ quantity: 2, unit_price: 116 }, 'vat_inclusive', 'taxable');
  assert.equal(inc.gross, 232);
  const exc = computeLineAmounts({ quantity: 1, unit_price: 100 }, 'vat_exclusive', 'taxable');
  assert.equal(Math.round(exc.gross), 116);
  const ex  = computeLineAmounts({ quantity: 1, unit_price: 100 }, 'vat_inclusive', 'exempt');
  assert.equal(ex.vat, 0);
});
