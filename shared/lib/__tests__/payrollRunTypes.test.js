import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDARD_EMPLOYEE_TYPES, allowedTypesForRun, isTypeAllowedInRun,
  runTypeMismatchMessage, entryTypesConflictingWithRun,
} from '../payroll/runTypes.js';

test('casual worker cannot enter a permanent run', () => {
  assert.equal(isTypeAllowedInRun('permanent', 'casual'), false);
  assert.match(runTypeMismatchMessage('permanent', 'casual'), /permanent run cannot include a casual/);
});

test('permanent worker cannot enter a casual run', () => {
  assert.equal(isTypeAllowedInRun('casual', 'permanent'), false);
});

test('skilled casual only fits skilled_casual and combined runs', () => {
  assert.equal(isTypeAllowedInRun('skilled_casual', 'skilled_casual'), true);
  assert.equal(isTypeAllowedInRun('casual', 'skilled_casual'), false);
  assert.equal(isTypeAllowedInRun('permanent', 'skilled_casual'), false);
  assert.equal(isTypeAllowedInRun('combined', 'skilled_casual'), true);
});

test('all three standard types can enter a combined run', () => {
  for (const t of STANDARD_EMPLOYEE_TYPES) assert.equal(isTypeAllowedInRun('combined', t), true, t);
  assert.deepEqual(allowedTypesForRun('combined'), ['casual', 'permanent', 'skilled_casual']);
});

test('unknown, future, temporary and empty types never enter any run, combined included', () => {
  for (const t of ['temporary', 'contractor', 'future_type', '', null, undefined]) {
    for (const run of ['casual', 'permanent', 'skilled_casual', 'combined']) {
      assert.equal(isTypeAllowedInRun(run, t), false, `${t} in ${run}`);
    }
  }
  assert.match(runTypeMismatchMessage('combined', 'temporary'), /cannot be paid through a payroll run/);
});

test('unknown run types accept nobody', () => {
  assert.deepEqual(allowedTypesForRun('weekly'), []);
  assert.equal(isTypeAllowedInRun('weekly', 'casual'), false);
  assert.match(runTypeMismatchMessage('weekly', 'casual'), /Unknown run type/);
});

test('eligible pairs produce no message', () => {
  assert.equal(runTypeMismatchMessage('casual', 'casual'), null);
  assert.equal(runTypeMismatchMessage('combined', 'permanent'), null);
});

test('switching a run type reports the entries it would invalidate', () => {
  assert.deepEqual(entryTypesConflictingWithRun('combined', ['casual', 'permanent']), []);
  assert.deepEqual(entryTypesConflictingWithRun('casual', ['casual', 'permanent', 'skilled_casual']).sort(),
    ['permanent', 'skilled_casual']);
  assert.deepEqual(entryTypesConflictingWithRun('combined', ['casual', 'temporary']), ['temporary']);
  assert.deepEqual(entryTypesConflictingWithRun('permanent', []), []);
});
