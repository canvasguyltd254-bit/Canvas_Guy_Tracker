/**
 * Customer identity on an INVOICE (screen, list and every PDF).
 *
 * An invoice is an attribute of its order (1:1). Identity rules:
 *
 *   issued, snapshot captured      → the stored snapshot, never the live customer
 *   issued, legacy snapshot        → name from the snapshot (= orders.client);
 *                                    other details were never captured. Current
 *                                    customer details may fill the GAPS only,
 *                                    and every such field is listed in
 *                                    `legacy_fallback_fields` (provenance)
 *   issued, no snapshot columns    → treated as legacy; NEVER the live name
 *   unissued preview               → current customer; unlinked order → orders.client
 *
 * Pure functions: the routes fetch the order + the live customer, this decides.
 */

export const INVOICE_IDENTITY_SOURCES = Object.freeze({
  ISSUED_SNAPSHOT: 'issued_snapshot',          // captured from the customer when issued
  ISSUED_ORDER_SNAPSHOT: 'issued_order_snapshot', // walk-in: order name captured when issued
  LEGACY: 'legacy_order_snapshot',             // pre-feature invoice, name only
  LIVE_CUSTOMER: 'live_customer',              // unissued preview
  ORDER_SNAPSHOT: 'order_snapshot',            // unissued, unlinked order
});

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** True once the order carries an invoice (journal-issued OR hand-numbered). */
export function isInvoiceIssued(order) {
  return Boolean(order && (order.invoice_journal_entry_id || clean(order.invoice_number)));
}

const SNAPSHOT_FIELDS = [
  ['name', 'invoice_customer_name_snapshot'],
  ['contact_person', 'invoice_customer_contact_person_snapshot'],
  ['address', 'invoice_customer_address_snapshot'],
  ['email', 'invoice_customer_email_snapshot'],
  ['phone', 'invoice_customer_phone_snapshot'],
  ['tax_id', 'invoice_customer_tax_id_snapshot'],
];

/**
 * @param order          orders row incl. invoice_* and invoice_customer_*_snapshot columns
 * @param liveCustomer   the linked customers row (or null)
 */
export function resolveInvoiceCustomer(order, liveCustomer = null) {
  const live = liveCustomer || null;
  const liveFields = live && {
    name: clean(live.name), contact_person: clean(live.contact_person), address: clean(live.address),
    email: clean(live.email), phone: clean(live.phone), tax_id: clean(live.kra_pin),
  };

  // ── unissued preview ──
  if (!isInvoiceIssued(order)) {
    if (liveFields && liveFields.name) {
      return { ...liveFields, customer_id: live.id ?? null, source: INVOICE_IDENTITY_SOURCES.LIVE_CUSTOMER,
               captured_at: null, legacy_fallback_fields: [], note: null };
    }
    return { name: clean(order?.client) ?? '', contact_person: clean(order?.contact_person), address: null, email: null,
             phone: null, tax_id: null, customer_id: null, source: INVOICE_IDENTITY_SOURCES.ORDER_SNAPSHOT,
             captured_at: null, legacy_fallback_fields: [], note: null };
  }

  const hasSnapshot = Boolean(order.invoice_customer_snapshot_at && clean(order.invoice_customer_name_snapshot));

  // ── issued, captured at issue ──
  if (hasSnapshot && order.invoice_customer_snapshot_source !== 'legacy_order_snapshot') {
    const out = { customer_id: order.invoice_customer_id_snapshot ?? null, legacy_fallback_fields: [], note: null,
                  captured_at: order.invoice_customer_snapshot_at };
    for (const [k, col] of SNAPSHOT_FIELDS) out[k] = clean(order[col]);
    out.source = order.invoice_customer_snapshot_source === 'order_snapshot_at_issue'
      ? INVOICE_IDENTITY_SOURCES.ISSUED_ORDER_SNAPSHOT : INVOICE_IDENTITY_SOURCES.ISSUED_SNAPSHOT;
    return out;
  }

  // ── issued, legacy (explicit legacy snapshot, or columns not populated) ──
  const out = {
    name: clean(order.invoice_customer_name_snapshot) ?? clean(order.client) ?? '',
    contact_person: clean(order.invoice_customer_contact_person_snapshot),
    address: clean(order.invoice_customer_address_snapshot),
    email: clean(order.invoice_customer_email_snapshot),
    phone: clean(order.invoice_customer_phone_snapshot),
    tax_id: clean(order.invoice_customer_tax_id_snapshot),
    customer_id: order.invoice_customer_id_snapshot ?? null,
    source: INVOICE_IDENTITY_SOURCES.LEGACY,
    captured_at: order.invoice_customer_snapshot_at ?? order.invoice_issued_at ?? null,
    legacy_fallback_fields: [],
    note: 'Legacy invoice — full issued customer details were not captured.',
  };
  // Documented fallback: current details may fill gaps (never the NAME), and are flagged.
  if (liveFields) {
    for (const k of ['contact_person', 'address', 'email', 'phone', 'tax_id']) {
      if (!out[k] && liveFields[k]) { out[k] = liveFields[k]; out.legacy_fallback_fields.push(k); }
    }
  }
  return out;
}

/** Shape the resolved identity like the `customers` object the PDF generator already reads. */
export function toPdfCustomer(identity) {
  return {
    id: identity.customer_id ?? null,
    name: identity.name,
    contact_person: identity.contact_person,
    address: identity.address,
    email: identity.email,
    phone: identity.phone,
    kra_pin: identity.tax_id,
  };
}

/** Provenance block for APIs (admin-inspectable; not shown to the customer). */
export function invoiceCustomerProvenance(identity) {
  return {
    source: identity.source,
    captured_at: identity.captured_at,
    legacy_fallback_fields: identity.legacy_fallback_fields,
    note: identity.note,
  };
}

/** Columns every invoice reader must select from orders. */
export const INVOICE_SNAPSHOT_COLUMNS = [
  'invoice_customer_id_snapshot', 'invoice_customer_name_snapshot', 'invoice_customer_contact_person_snapshot',
  'invoice_customer_address_snapshot', 'invoice_customer_email_snapshot', 'invoice_customer_phone_snapshot',
  'invoice_customer_tax_id_snapshot', 'invoice_customer_snapshot_at', 'invoice_customer_snapshot_source',
].join(', ');
