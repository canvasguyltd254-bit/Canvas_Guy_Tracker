/**
 * shared/lib/cashflow/__tests__/isoWeeks.test.js
 *
 * Run with: npm test (node --test shared/lib/**\/*.test.js)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getIsoMonday,
  getNextIsoMonday,
  buildIsoWeeks,
  bucketDateIntoWeek,
  clampDayToMonth,
  generateObligationOccurrences,
} from '../isoWeeks.js';

describe('getIsoMonday', () => {
  test('a Monday maps to itself', () => {
    assert.equal(getIsoMonday('2026-09-28'), '2026-09-28');
  });
  test('a Wednesday maps to the Monday of the same week', () => {
    assert.equal(getIsoMonday('2026-09-23'), '2026-09-21');
  });
  test('a Sunday maps to the Monday of the same (ISO) week, not the next', () => {
    assert.equal(getIsoMonday('2026-09-27'), '2026-09-21');
  });
});

describe('getNextIsoMonday — first Monday on or after', () => {
  test('spec example: Wednesday 23 Sep 2026 -> Monday 28 Sep 2026', () => {
    assert.equal(getNextIsoMonday('2026-09-23'), '2026-09-28');
  });
  test('a Monday returns itself, not the following week', () => {
    assert.equal(getNextIsoMonday('2026-09-28'), '2026-09-28');
  });
  test('a Sunday rolls to the very next day (Monday)', () => {
    assert.equal(getNextIsoMonday('2026-09-27'), '2026-09-28');
  });
});

describe('buildIsoWeeks', () => {
  test('spec example: as_of 2026-09-23 produces week 0 starting 2026-09-28', () => {
    const weeks = buildIsoWeeks('2026-09-23', 13);
    assert.equal(weeks.length, 13);
    assert.deepEqual(weeks[0], {
      index: 0,
      week_start: '2026-09-28',
      week_end: '2026-10-04',
      label: '28 Sep',
    });
  });

  test('weeks are contiguous — each week_start is the day after the previous week_end', () => {
    const weeks = buildIsoWeeks('2026-09-23', 13);
    for (let i = 1; i < weeks.length; i++) {
      const prevEnd = new Date(weeks[i - 1].week_end + 'T00:00:00Z');
      const thisStart = new Date(weeks[i].week_start + 'T00:00:00Z');
      const diffDays = (thisStart - prevEnd) / (1000 * 60 * 60 * 24);
      assert.equal(diffDays, 1, `week ${i} does not start immediately after week ${i - 1} ends`);
    }
  });

  test('year boundary — week spanning Dec 2026 into Jan 2027 is not truncated', () => {
    // First forecast Monday for as_of 2026-09-23 is 2026-09-28; 13 weeks later
    // (index 12) starts 2026-12-21 and ends 2026-12-27 — one more manual step
    // confirms the boundary case directly instead.
    const weeks = buildIsoWeeks('2026-12-20', 2); // Sunday
    // getNextIsoMonday(2026-12-20) -> 2026-12-21 (Monday)
    assert.equal(weeks[0].week_start, '2026-12-21');
    assert.equal(weeks[0].week_end, '2026-12-27');
    assert.equal(weeks[1].week_start, '2026-12-28');
    assert.equal(weeks[1].week_end, '2027-01-03');
    assert.equal(weeks[1].label, '28 Dec');
  });

  test('rejects invalid as_of and non-positive horizon', () => {
    assert.throws(() => buildIsoWeeks('2026-13-01', 13), { name: 'RangeError' });
    assert.throws(() => buildIsoWeeks('2026-09-23', 0), { name: 'RangeError' });
    assert.throws(() => buildIsoWeeks('2026-09-23', 1.5), { name: 'RangeError' });
  });
});

describe('bucketDateIntoWeek', () => {
  const weeks = buildIsoWeeks('2026-09-23', 13); // weeks[0] = 2026-09-28..2026-10-04

  test('a date inside week 0 maps to week 0, not overdue', () => {
    assert.deepEqual(bucketDateIntoWeek('2026-09-30', weeks), { index: 0, is_overdue: false });
  });

  test('overdue dates (before weeks[0].week_start) roll into week one, marked overdue', () => {
    assert.deepEqual(bucketDateIntoWeek('2026-09-01', weeks), { index: 0, is_overdue: true });
    assert.deepEqual(bucketDateIntoWeek('2026-09-27', weeks), { index: 0, is_overdue: true });
  });

  test('a date after the final week_end returns null', () => {
    assert.equal(bucketDateIntoWeek('2027-01-01', weeks), null);
  });

  test('a date exactly on the last week_end is still in range (inclusive)', () => {
    const lastWeek = weeks[weeks.length - 1];
    const result = bucketDateIntoWeek(lastWeek.week_end, weeks);
    assert.deepEqual(result, { index: lastWeek.index, is_overdue: false });
  });

  test('an invalid date throws rather than silently rolling to another calendar day', () => {
    assert.throws(() => bucketDateIntoWeek('2026-02-30', weeks), { name: 'RangeError' });
    assert.throws(() => bucketDateIntoWeek('not-a-date', weeks), { name: 'RangeError' });
  });
});

describe('clampDayToMonth', () => {
  test('day within range is unchanged', () => {
    assert.equal(clampDayToMonth(2026, 9, 15), 15);
  });
  test('day 31 in a 30-day month clamps to 30', () => {
    assert.equal(clampDayToMonth(2026, 9, 31), 30); // September has 30 days
  });
  test('day 31 in February clamps to 28 in a non-leap year', () => {
    assert.equal(clampDayToMonth(2026, 2, 31), 28);
  });
  test('day 31 in February clamps to 29 in a leap year', () => {
    assert.equal(clampDayToMonth(2028, 2, 31), 29); // 2028 is a leap year
  });
  test('day 31 in a 31-day month is unchanged', () => {
    assert.equal(clampDayToMonth(2026, 1, 31), 31);
  });
});

describe('generateObligationOccurrences', () => {
  test('inactive obligation generates nothing', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'monthly', first_due_date: '2026-01-01', ends_on: null, is_active: false, day_of_month: 1 },
      '2026-01-01', '2026-12-31',
    );
    assert.deepEqual(occ, []);
  });

  test('"once" generates exactly first_due_date when in range', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'once', first_due_date: '2026-10-15', ends_on: null, is_active: true, day_of_month: null },
      '2026-09-28', '2026-12-27',
    );
    assert.deepEqual(occ, ['2026-10-15']);
  });

  test('"once" outside range generates nothing', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'once', first_due_date: '2026-01-01', ends_on: null, is_active: true, day_of_month: null },
      '2026-09-28', '2026-12-27',
    );
    assert.deepEqual(occ, []);
  });

  test('monthly day 31 clamps correctly every month, including Feb', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'monthly', first_due_date: '2026-01-31', ends_on: null, is_active: true, day_of_month: 31 },
      '2026-01-01', '2026-05-31',
    );
    assert.deepEqual(occ, [
      '2026-01-31', // occurrence #0 is first_due_date itself
      '2026-02-28', // clamped (non-leap Feb)
      '2026-03-31',
      '2026-04-30', // clamped (April has 30 days)
      '2026-05-31',
    ]);
  });

  test('quarterly anchors to first_due_date and steps by 3 months', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'quarterly', first_due_date: '2026-01-15', ends_on: null, is_active: true, day_of_month: 15 },
      '2026-01-01', '2026-12-31',
    );
    assert.deepEqual(occ, ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  });

  test('annual anchors to first_due_date and steps by 12 months, clamping leap-day where needed', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'annual', first_due_date: '2028-02-29', ends_on: null, is_active: true, day_of_month: 29 },
      '2028-01-01', '2030-12-31',
    );
    assert.deepEqual(occ, ['2028-02-29', '2029-02-28', '2030-02-28']);
  });

  test('never generates before first_due_date even if range starts earlier', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'monthly', first_due_date: '2026-06-01', ends_on: null, is_active: true, day_of_month: 1 },
      '2026-01-01', '2026-12-31',
    );
    assert.ok(occ.every(d => d >= '2026-06-01'));
    assert.equal(occ[0], '2026-06-01');
  });

  test('never generates after ends_on', () => {
    const occ = generateObligationOccurrences(
      { recurrence: 'monthly', first_due_date: '2026-01-01', ends_on: '2026-03-15', is_active: true, day_of_month: 1 },
      '2026-01-01', '2026-12-31',
    );
    assert.deepEqual(occ, ['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  test('rejects an unknown recurrence value', () => {
    assert.throws(
      () => generateObligationOccurrences(
        { recurrence: 'weekly', first_due_date: '2026-01-01', ends_on: null, is_active: true, day_of_month: 1 },
        '2026-01-01', '2026-12-31',
      ),
      { name: 'RangeError' },
    );
  });

  test('rejects monthly/quarterly/annual without day_of_month', () => {
    assert.throws(
      () => generateObligationOccurrences(
        { recurrence: 'monthly', first_due_date: '2026-01-01', ends_on: null, is_active: true, day_of_month: null },
        '2026-01-01', '2026-12-31',
      ),
      { name: 'RangeError' },
    );
  });
});
