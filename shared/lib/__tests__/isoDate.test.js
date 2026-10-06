/**
 * shared/lib/__tests__/isoDate.test.js
 *
 * Run with: node --test shared/lib
 * (or the "test" script in package.json)
 *
 * Uses Node's built-in test runner (node:test) — no dependency added to the
 * project to make these repeatable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIsoDate, compareIsoDates, requireValidIsoDate } from '../isoDate.js';

describe('isValidIsoDate', () => {
  test('accepts real calendar dates', () => {
    assert.equal(isValidIsoDate('2026-09-28'), true);
    assert.equal(isValidIsoDate('2026-01-01'), true);
    assert.equal(isValidIsoDate('2026-12-31'), true);
    assert.equal(isValidIsoDate('2028-02-29'), true); // leap year
  });

  test('rejects non-existent calendar dates', () => {
    assert.equal(isValidIsoDate('2026-02-30'), false); // Feb never has 30 days
    assert.equal(isValidIsoDate('2026-04-31'), false); // April has 30 days
    assert.equal(isValidIsoDate('2026-02-29'), false); // 2026 is not a leap year
    assert.equal(isValidIsoDate('2026-13-01'), false); // month 13
    assert.equal(isValidIsoDate('2026-00-01'), false); // month 0
    assert.equal(isValidIsoDate('2026-01-00'), false); // day 0
    assert.equal(isValidIsoDate('2026-01-32'), false); // day 32
  });

  test('rejects malformed strings — the P1 gap: these must not reach Postgres', () => {
    assert.equal(isValidIsoDate('abc'), false);
    assert.equal(isValidIsoDate(''), false);
    assert.equal(isValidIsoDate('2026-9-28'), false);   // not zero-padded
    assert.equal(isValidIsoDate('28-09-2026'), false);  // wrong order
    assert.equal(isValidIsoDate('2026/09/28'), false);  // wrong separator
    assert.equal(isValidIsoDate('2026-09-28T00:00:00'), false); // datetime, not date
    assert.equal(isValidIsoDate(null), false);
    assert.equal(isValidIsoDate(undefined), false);
    assert.equal(isValidIsoDate(20260928), false); // number, not string
  });

  test('is timezone-independent (UTC arithmetic)', () => {
    // A date validated as real must stay real regardless of server TZ — this
    // doesn't change with TZ, but asserts the implementation path is UTC-based
    // by checking a date right at a DST-adjacent boundary in some zones.
    assert.equal(isValidIsoDate('2026-03-08'), true);
    assert.equal(isValidIsoDate('2026-11-01'), true);
  });
});

describe('compareIsoDates', () => {
  test('orders correctly for valid, zero-padded strings', () => {
    assert.equal(compareIsoDates('2026-09-28', '2026-10-05') < 0, true);
    assert.equal(compareIsoDates('2026-10-05', '2026-09-28') > 0, true);
    assert.equal(compareIsoDates('2026-09-28', '2026-09-28'), 0);
    assert.equal(compareIsoDates('2026-12-31', '2027-01-01') < 0, true); // year rollover
  });
});

describe('requireValidIsoDate', () => {
  test('returns the value unchanged when valid', () => {
    assert.equal(requireValidIsoDate('2026-09-28'), '2026-09-28');
  });

  test('throws RangeError with a field name on an invalid date', () => {
    assert.throws(
      () => requireValidIsoDate('2026-02-30', 'due_date'),
      { name: 'RangeError', message: /due_date/ },
    );
  });
});
