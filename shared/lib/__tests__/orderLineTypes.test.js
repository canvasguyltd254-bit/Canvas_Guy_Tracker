import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isChargeItem, isProductItem, lineTypeForCategory, LEGACY_CHARGE_CATEGORIES,
} from '../orderLineTypes.js';

test('every current charge category is a charge, even with default line_type product', () => {
  for (const category of ['Delivery Fee', 'Design Fee', 'Installation Fee', 'Packaging', 'Other Charge']) {
    // Order-side charges are inserted without a line_type → DB default 'product'.
    assert.equal(isChargeItem({ category, line_type: 'product' }), true, category);
    assert.equal(isChargeItem({ category }), true, `${category} (no line_type)`);
    assert.equal(isProductItem({ category, line_type: 'product' }), false, category);
  }
});

test('legacy Rush Fee and Discount remain charges', () => {
  assert.equal(isChargeItem({ category: 'Rush Fee' }), true);
  assert.equal(isChargeItem({ category: 'Discount', line_type: 'product' }), true);
});

test('a non-product line_type is a charge whatever the category says', () => {
  assert.equal(isChargeItem({ category: 'Furniture', line_type: 'delivery' }), true);
  assert.equal(isChargeItem({ category: null, line_type: 'packaging' }), true);
});

test('product categories with product or missing line_type are products', () => {
  for (const category of ['Wall Decoration Canvas', 'Mirrors', 'Furniture', 'Assorted Timber Products', 'Other']) {
    assert.equal(isProductItem({ category, line_type: 'product' }), true, category);
    assert.equal(isProductItem({ category }), true, `${category} (no line_type)`);
  }
});

test('an unrecognised line_type string falls back to the category rule', () => {
  assert.equal(isChargeItem({ category: 'Furniture', line_type: 'garbage' }), false);
  assert.equal(isChargeItem({ category: 'Packaging', line_type: 'garbage' }), true);
});

test('null/undefined items are neither product nor charge', () => {
  assert.equal(isChargeItem(null), false);
  assert.equal(isProductItem(undefined), false);
});

test('lineTypeForCategory maps charge categories and defaults to product', () => {
  assert.equal(lineTypeForCategory('Delivery Fee'), 'delivery');
  assert.equal(lineTypeForCategory('Design Fee'), 'design');
  assert.equal(lineTypeForCategory('Installation Fee'), 'installation');
  assert.equal(lineTypeForCategory('Packaging'), 'packaging');
  assert.equal(lineTypeForCategory('Other Charge'), 'other');
  assert.equal(lineTypeForCategory('Mirrors'), 'product');
  assert.equal(lineTypeForCategory(undefined), 'product');
});

test('legacy set covers all seven historical charge categories', () => {
  assert.equal(LEGACY_CHARGE_CATEGORIES.size, 7);
});

// New-order pages stamp line_type explicitly from the category (never rely on
// the column default). Every selectable charge label must map to a non-product type.
import { CHARGE_TYPES } from '../../../modules/orders/components/constants.js';
import { lineTypeForCategory as ltc, LINE_TYPES as LT } from '../orderLineTypes.js';

test('every selectable charge label maps to a non-product line_type', () => {
  for (const label of CHARGE_TYPES) {
    const t = ltc(label);
    assert.notEqual(t, 'product', `${label} must not default to product`);
    assert.ok(LT.includes(t), `${label} -> ${t} must be a valid line_type`);
  }
});

test('product categories map to product', () => {
  assert.equal(ltc('Chairs'), 'product');
  assert.equal(ltc(undefined), 'product');
});
