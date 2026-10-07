import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationalCustomerName, customerNameDrifted, withCustomerNames } from '../customerDisplay.js';

test('linked order shows the live customer name operationally', () => {
  const row = withCustomerNames({ id: 1, client: 'Rolaine Njoki', customer_id: 'c1', customers: { name: 'LORRAINE WAIGANJO' } });
  assert.equal(operationalCustomerName(row), 'LORRAINE WAIGANJO');
});

test('walk-in order (no customer record) falls back to orders.client', () => {
  const row = withCustomerNames({ id: 2, client: 'Walk-in Joe', customer_id: null, customers: null });
  assert.equal(operationalCustomerName(row), 'Walk-in Joe');
  assert.equal(row.customer_name, null);
});

test('API shape keeps the snapshot in client and returns both names explicitly', () => {
  const row = withCustomerNames({ id: 3, client: 'Rolaine Njoki', customers: { name: 'LORRAINE WAIGANJO' } });
  assert.equal(row.client, 'Rolaine Njoki');
  assert.equal(row.customer_name, 'LORRAINE WAIGANJO');
  assert.equal(row.customer_name_snapshot, 'Rolaine Njoki');
  assert.equal('customers' in row, false);
});

test('blank live name falls back to the snapshot', () => {
  const row = withCustomerNames({ client: 'Acme', customers: { name: '   ' } });
  assert.equal(operationalCustomerName(row), 'Acme');
});

test('order form shape (_customer) is honoured', () => {
  assert.equal(operationalCustomerName({ client: 'Old', _customer: { name: 'New' } }), 'New');
});

test('drift is detected only when both names exist and differ', () => {
  assert.equal(customerNameDrifted({ client: 'Old', customer_name: 'New' }), true);
  assert.equal(customerNameDrifted({ client: 'Same', customer_name: 'Same' }), false);
  assert.equal(customerNameDrifted({ client: 'Walk-in', customer_name: null }), false);
});

test('null order is safe', () => {
  assert.equal(operationalCustomerName(null), '');
  assert.equal(withCustomerNames(null), null);
});
