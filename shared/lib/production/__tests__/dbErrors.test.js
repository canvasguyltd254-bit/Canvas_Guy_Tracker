import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingSchema } from '../dbErrors.js';

test('missing column/table/function are schema-pending', () => {
  assert.equal(isMissingSchema({ code: '42703', message: 'x' }), true);
  assert.equal(isMissingSchema({ code: 'PGRST205', message: 'x' }), true);
  assert.equal(isMissingSchema({ message: 'column production_jobs.production_due_date does not exist' }), true);
  assert.equal(isMissingSchema({ message: "Could not find the table 'public.x' in the schema cache" }), true);
});
test('real failures are not schema-pending', () => {
  assert.equal(isMissingSchema({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
  assert.equal(isMissingSchema({ code: '42501', message: 'permission denied for table x' }), false);
  assert.equal(isMissingSchema({ message: 'fetch failed' }), false);
  assert.equal(isMissingSchema(null), false);
});
