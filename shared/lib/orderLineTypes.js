/**
 * shared/lib/orderLineTypes.js
 *
 * The ONE place the app decides whether an order/quote line is a deliverable
 * PRODUCT or a non-deliverable CHARGE (delivery, design, installation,
 * packaging, other charge, rush fee, discount). Delivery notes, batch
 * pickers, P&L and invoice code import from here — never keep a local copy
 * of the category list, because divergent copies are exactly what let
 * "Packaging" and "Other Charge" leak into delivery batches.
 *
 * Classification rule
 * -------------------
 * A row is a PRODUCT only when BOTH hold:
 *   1. its line_type is 'product' (or missing), and
 *   2. its category is not a known charge category.
 *
 * Why not line_type alone: order_items.line_type is NOT NULL DEFAULT
 * 'product', and charges typed directly on the order side (order form and
 * new-order page) have historically been inserted WITHOUT a line_type — so
 * they carry line_type = 'product' with category = 'Packaging', etc. Trusting
 * line_type alone would treat exactly those rows as deliverable. Checking the
 * category as well is the conservative direction: it can only ever hide a
 * charge from a delivery list, never expose one.
 *
 * Zero imports, zero I/O — safe in client components, route handlers and
 * node --test.
 */

/** Every category string that has ever denoted a non-deliverable charge. */
export const LEGACY_CHARGE_CATEGORIES = new Set([
  'Delivery Fee',
  'Design Fee',
  'Installation Fee',
  'Packaging',
  'Other Charge',
  'Rush Fee',   // legacy — no longer creatable, may exist on old rows
  'Discount',   // legacy — no longer creatable, may exist on old rows
]);

/** The values order_items.line_type / quote_items.line_type may hold. */
export const LINE_TYPES = Object.freeze([
  'product', 'delivery', 'design', 'installation', 'packaging', 'other',
]);

const CATEGORY_TO_LINE_TYPE = Object.freeze({
  'Delivery Fee':     'delivery',
  'Design Fee':       'design',
  'Installation Fee': 'installation',
  'Packaging':        'packaging',
  'Other Charge':     'other',
  'Rush Fee':         'other',
  'Discount':         'other',
});

/**
 * Canonical line_type for a category: charge categories map to their charge
 * type; anything else (a product category, or nothing) is 'product'.
 * @param {string|null|undefined} category
 * @returns {'product'|'delivery'|'design'|'installation'|'packaging'|'other'}
 */
export function lineTypeForCategory(category) {
  return CATEGORY_TO_LINE_TYPE[category] || 'product';
}

/**
 * True when the row is a non-deliverable charge. See the classification rule
 * in the file header.
 * @param {{line_type?: string|null, category?: string|null}|null|undefined} item
 * @returns {boolean}
 */
export function isChargeItem(item) {
  if (!item) return false;
  const lt = item.line_type;
  if (typeof lt === 'string' && LINE_TYPES.includes(lt) && lt !== 'product') return true;
  return LEGACY_CHARGE_CATEGORIES.has(item.category);
}

/**
 * True when the row is a deliverable product.
 * @param {{line_type?: string|null, category?: string|null}|null|undefined} item
 * @returns {boolean}
 */
export function isProductItem(item) {
  return !!item && !isChargeItem(item);
}
