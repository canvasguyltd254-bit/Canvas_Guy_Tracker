import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderSavePayload } from '../orderSavePayload.js';
import { pick, ALLOWED_FIELDS } from '../whitelist.js';
import { withCustomerNames, operationalCustomerName } from '../customerDisplay.js';

// Same filter the PATCH route applies (app/api/orders/[id]/route.js)
const SERVER_OWNED = new Set(['status', 'total_value', 'subtotal_amount', 'vat_amount']);
const ORDER_UPDATE_FIELDS = ALLOWED_FIELDS.orders.update.filter(f => !SERVER_OWNED.has(f));

// A renamed customer's order: snapshot is the old name, live name is the new one.
const renamedOrder = withCustomerNames({
  id: 'o1', client: 'Rolaine Njoki', customer_id: 'c1', customers: { name: 'LORRAINE WAIGANJO' },
});

test('the form displays the live name for a renamed customer', () => {
  assert.equal(operationalCustomerName(renamedOrder), 'LORRAINE WAIGANJO');
});

test('editing delivery instructions on a renamed customer\'s order does not send client', () => {
  const payload = buildOrderSavePayload({
    notes: '', dueDate: '', deliveryAddress: '', deliveryContact: '',
    deliveryInstructions: 'Call before arriving',
  });
  assert.equal('client' in payload, false);
  assert.equal(payload.delivery_instructions, 'Call before arriving');
  // …and even the displayed live name never leaks into any field
  assert.equal(JSON.stringify(payload).includes('LORRAINE'), false);
});

test('the PATCH whitelist drops client even if a caller sends it', () => {
  assert.equal(ORDER_UPDATE_FIELDS.includes('client'), false);
  const persisted = pick({ client: 'LORRAINE WAIGANJO', delivery_instructions: 'x' }, ORDER_UPDATE_FIELDS);
  assert.equal('client' in persisted, false);
  assert.deepEqual(Object.keys(persisted), ['delivery_instructions']);
});

test('the persisted snapshot field on the row is untouched by display shaping', () => {
  assert.equal(renamedOrder.client, 'Rolaine Njoki');
  assert.equal(renamedOrder.customer_name_snapshot, 'Rolaine Njoki');
});
