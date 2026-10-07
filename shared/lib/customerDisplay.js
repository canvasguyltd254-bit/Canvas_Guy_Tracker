/**
 * Customer-name display rules for orders.
 *
 * Three distinct concepts (never conflate them):
 *   1. Current name      customers.name       operational screens (lists, search, headers)
 *   2. Order snapshot    orders.client        name when the order was created; never auto-rewritten
 *   3. Issued-document   (future) captured at issue time; issued documents must NOT use #1
 *
 * This helper covers #1 vs #2 for OPERATIONAL display only. Issued-document
 * generators (invoice / quotation / delivery PDFs) must not call it.
 */

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Live customer name when the order is linked to a customer, else the order snapshot. */
export function operationalCustomerName(order) {
  if (!order) return '';
  return clean(order.customer_name) ?? clean(order.customers?.name) ?? clean(order._customer?.name) ?? clean(order.client) ?? '';
}

/** True when a linked customer's current name differs from the order-time snapshot. */
export function customerNameDrifted(order) {
  const live = clean(order?.customer_name) ?? clean(order?.customers?.name) ?? clean(order?._customer?.name);
  const snap = clean(order?.customer_name_snapshot) ?? clean(order?.client);
  return Boolean(live && snap && live !== snap);
}

/**
 * Shape a row fetched with an embedded `customers(name)` into explicit fields.
 * `client` is left untouched so provenance is never hidden.
 */
export function withCustomerNames(row) {
  if (!row) return row;
  const { customers, ...rest } = row;
  return {
    ...rest,
    customer_name: clean(customers?.name),
    customer_name_snapshot: clean(row.client),
  };
}
