/**
 * shared/lib/cashflow/__tests__/classifyWeek.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWeek } from '../classifyWeek.js';

describe('classifyWeek', () => {
  test('negative closing balance -> Shortfall', () => {
    const r = classifyWeek(-187600, 250000);
    assert.equal(r.state, 'shortfall');
    assert.equal(r.label, 'Shortfall');
    assert.equal(r.shortfall_amount, 187600);
    assert.equal(r.reserve_gap, 250000 - (-187600)); // 437600
  });

  test('zero closing balance -> Low cash, not Shortfall', () => {
    const r = classifyWeek(0, 250000);
    assert.equal(r.state, 'low_cash');
    assert.equal(r.label, 'Low cash');
    assert.equal(r.shortfall_amount, 0);
    assert.equal(r.reserve_gap, 250000);
  });

  test('positive but below reserve -> Low cash', () => {
    const r = classifyWeek(100000, 250000);
    assert.equal(r.state, 'low_cash');
    assert.equal(r.shortfall_amount, 0);
    assert.equal(r.reserve_gap, 150000);
  });

  test('exactly at the reserve threshold -> Normal', () => {
    const r = classifyWeek(250000, 250000);
    assert.equal(r.state, 'normal');
    assert.equal(r.label, 'Normal');
    assert.equal(r.reserve_gap, 0);
    assert.equal(r.shortfall_amount, 0);
  });

  test('above the reserve threshold -> Normal', () => {
    const r = classifyWeek(1636000, 250000);
    assert.equal(r.state, 'normal');
    assert.equal(r.reserve_gap, 0);
    assert.equal(r.shortfall_amount, 0);
  });

  test('rejects non-numeric or non-finite inputs rather than treating them as zero', () => {
    assert.throws(() => classifyWeek(NaN, 250000), { name: 'RangeError' });
    assert.throws(() => classifyWeek('100000', 250000), { name: 'RangeError' });
    assert.throws(() => classifyWeek(100000, -1), { name: 'RangeError' });
    assert.throws(() => classifyWeek(100000, undefined), { name: 'RangeError' });
  });
});
