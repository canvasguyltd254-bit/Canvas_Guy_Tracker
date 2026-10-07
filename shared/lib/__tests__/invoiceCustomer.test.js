import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInvoiceCustomer, toPdfCustomer, invoiceCustomerProvenance, isInvoiceIssued, INVOICE_IDENTITY_SOURCES as S,
} from '../invoiceCustomer.js';

const live = (over = {}) => ({ id: 'c1', name: 'LORRAINE WAIGANJO', contact_person: 'L. W.', address: 'New Address', email: 'new@x.com', phone: '0711', kra_pin: 'P999', ...over });

// An invoice issued when the customer was still "Rolaine Njoki", then the customer was renamed.
const issued = (over = {}) => ({
  client: 'Rolaine Njoki', contact_person: 'order contact',
  invoice_number: 'INV-2026-0045', invoice_issued_at: '2026-10-06T08:00:00Z', invoice_journal_entry_id: 'je1',
  invoice_customer_id_snapshot: 'c1', invoice_customer_name_snapshot: 'Rolaine Njoki',
  invoice_customer_contact_person_snapshot: 'R. N.', invoice_customer_address_snapshot: 'Old Address',
  invoice_customer_email_snapshot: 'old@x.com', invoice_customer_phone_snapshot: '0700', invoice_customer_tax_id_snapshot: 'P111',
  invoice_customer_snapshot_at: '2026-10-06T08:00:00Z', invoice_customer_snapshot_source: 'customer_at_issue', ...over,
});

test('issued invoice returns the stored snapshot, not the live customer', () => {
  const id = resolveInvoiceCustomer(issued(), live());
  assert.equal(id.name, 'Rolaine Njoki');
  assert.equal(id.address, 'Old Address');
  assert.equal(id.tax_id, 'P111');
  assert.equal(id.source, S.ISSUED_SNAPSHOT);
  assert.equal(id.captured_at, '2026-10-06T08:00:00Z');
  assert.deepEqual(id.legacy_fallback_fields, []);
});

test('customer rename does not change the issued identity or the PDF payload', () => {
  const before = toPdfCustomer(resolveInvoiceCustomer(issued(), live({ name: 'Rolaine Njoki', address: 'Old Address' })));
  const after  = toPdfCustomer(resolveInvoiceCustomer(issued(), live({ name: 'COMPLETELY NEW NAME', address: 'Elsewhere', kra_pin: 'ZZZ' })));
  assert.deepEqual(after, before);
});

test('screen, list and PDF resolve the same identity (single resolver)', () => {
  const a = resolveInvoiceCustomer(issued(), live());
  const b = resolveInvoiceCustomer(issued(), live({ name: 'other' }));
  assert.deepEqual(a, b);
});

test('unissued preview uses the current customer record', () => {
  const order = { client: 'Rolaine Njoki', invoice_number: null, invoice_journal_entry_id: null };
  const id = resolveInvoiceCustomer(order, live());
  assert.equal(id.name, 'LORRAINE WAIGANJO');
  assert.equal(id.source, S.LIVE_CUSTOMER);
  assert.equal(id.captured_at, null);
  assert.equal(isInvoiceIssued(order), false);
});

test('unissued walk-in preview falls back to the order name', () => {
  const id = resolveInvoiceCustomer({ client: 'Walk-in Joe', contact_person: 'Joe' }, null);
  assert.equal(id.name, 'Walk-in Joe');
  assert.equal(id.source, S.ORDER_SNAPSHOT);
});

test('issued walk-in invoice uses the order name captured at issue', () => {
  const order = issued({ invoice_customer_id_snapshot: null, invoice_customer_name_snapshot: 'Walk-in Joe',
    invoice_customer_snapshot_source: 'order_snapshot_at_issue', invoice_customer_address_snapshot: null,
    invoice_customer_email_snapshot: null, invoice_customer_phone_snapshot: null, invoice_customer_tax_id_snapshot: null });
  const id = resolveInvoiceCustomer(order, null);
  assert.equal(id.name, 'Walk-in Joe');
  assert.equal(id.source, S.ISSUED_ORDER_SNAPSHOT);
});

test('legacy issued invoice: name falls back to orders.client, never the live name', () => {
  const legacy = issued({
    invoice_customer_name_snapshot: 'Rolaine Njoki', invoice_customer_snapshot_source: 'legacy_order_snapshot',
    invoice_customer_contact_person_snapshot: null, invoice_customer_address_snapshot: null, invoice_customer_email_snapshot: null,
    invoice_customer_phone_snapshot: null, invoice_customer_tax_id_snapshot: null, invoice_customer_id_snapshot: null,
  });
  const id = resolveInvoiceCustomer(legacy, live());
  assert.equal(id.name, 'Rolaine Njoki');
  assert.equal(id.source, S.LEGACY);
  assert.match(id.note, /Legacy invoice/);
});

test('legacy fallback may fill gaps with current details, and flags exactly which fields', () => {
  const legacy = issued({
    invoice_customer_name_snapshot: 'Rolaine Njoki', invoice_customer_snapshot_source: 'legacy_order_snapshot',
    invoice_customer_contact_person_snapshot: null, invoice_customer_address_snapshot: null, invoice_customer_email_snapshot: null,
    invoice_customer_phone_snapshot: null, invoice_customer_tax_id_snapshot: null,
  });
  const id = resolveInvoiceCustomer(legacy, live());
  assert.equal(id.address, 'New Address');
  assert.deepEqual(id.legacy_fallback_fields.sort(), ['address', 'contact_person', 'email', 'phone', 'tax_id']);
  assert.equal(invoiceCustomerProvenance(id).source, S.LEGACY);
  // …but a field that WAS captured is never overwritten by the live record
  const partly = resolveInvoiceCustomer({ ...legacy, invoice_customer_address_snapshot: 'Captured Address' }, live());
  assert.equal(partly.address, 'Captured Address');
  assert.equal(partly.legacy_fallback_fields.includes('address'), false);
});

test('issued but snapshot columns missing (migration not applied) is treated as legacy, not live', () => {
  const order = { client: 'Rolaine Njoki', invoice_number: 'INV-1', invoice_issued_at: '2026-01-01T00:00:00Z' };
  const id = resolveInvoiceCustomer(order, live());
  assert.equal(id.name, 'Rolaine Njoki');
  assert.equal(id.source, S.LEGACY);
  assert.equal(id.captured_at, '2026-01-01T00:00:00Z');
});

test('a hand-numbered invoice counts as issued', () => {
  assert.equal(isInvoiceIssued({ invoice_number: 'HAND-001' }), true);
  assert.equal(isInvoiceIssued({ invoice_number: '  ' }), false);
  assert.equal(isInvoiceIssued({ invoice_journal_entry_id: 'je' }), true);
});

test('no API whitelist can write the snapshot columns (insert or update)', async () => {
  const { ALLOWED_FIELDS } = await import('../whitelist.js');
  for (const list of [ALLOWED_FIELDS.orders.insert, ALLOWED_FIELDS.orders.update]) {
    assert.equal(list.some(f => f.startsWith('invoice_customer_')), false);
  }
});

test('toPdfCustomer matches the object shape the PDF generator already reads', () => {
  const pdf = toPdfCustomer(resolveInvoiceCustomer(issued(), live()));
  assert.deepEqual(Object.keys(pdf).sort(), ['address', 'contact_person', 'email', 'id', 'kra_pin', 'name', 'phone']);
  assert.equal(pdf.kra_pin, 'P111');
});
