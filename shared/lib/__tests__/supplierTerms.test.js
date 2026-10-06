/**
 * shared/lib/__tests__/supplierTerms.test.js
 *
 * Run with: node --test shared/lib
 * (or the "test" script in package.json)
 *
 * Covers the cases the P2 review asked to see committed, plus the rev-3
 * provenance-snapshot review:
 *   - blank versus zero
 *   - non-integer and out-of-range terms
 *   - month / year / leap-year rollover
 *   - supplier-terms versus explicit provenance wording
 *   - terms changed after purchase creation must not relabel old purchases
 *   - POST/PATCH "unrecorded" must behave identically regardless of the
 *     supplier's current terms
 *   - the due_date_terms_days snapshot is preserved exactly, and explicit
 *     dates never carry one
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePaymentTermsDays,
  hasRecordedTerms,
  deriveDueDate,
  describeDueDateSource,
  buildDueDateFields,
  shouldRequestSupplierTermsDerivation,
  inferLegacyDueDateMode,
} from '../supplierTerms.js';

describe('parsePaymentTermsDays — blank vs zero', () => {
  test('blank, null, undefined and whitespace all parse to null (not recorded)', () => {
    assert.deepEqual(parsePaymentTermsDays(''), { ok: true, value: null });
    assert.deepEqual(parsePaymentTermsDays('   '), { ok: true, value: null });
    assert.deepEqual(parsePaymentTermsDays(null), { ok: true, value: null });
    assert.deepEqual(parsePaymentTermsDays(undefined), { ok: true, value: null });
  });

  test('"0" parses to 0 — a real, recorded answer (cash on delivery), never coerced to null', () => {
    const result = parsePaymentTermsDays('0');
    assert.deepEqual(result, { ok: true, value: 0 });
    // The bug this guards against: `if (!result.value)` would misread 0 as
    // "nothing recorded" because 0 is falsy in JS.
    assert.equal(result.value === null, false);
  });

  test('30 parses as a normal recorded value', () => {
    assert.deepEqual(parsePaymentTermsDays('30'), { ok: true, value: 30 });
    assert.deepEqual(parsePaymentTermsDays(30), { ok: true, value: 30 });
  });
});

describe('parsePaymentTermsDays — non-integer and out-of-range', () => {
  test('rejects non-numeric strings', () => {
    assert.equal(parsePaymentTermsDays('abc').ok, false);
  });

  test('rejects fractional values', () => {
    assert.equal(parsePaymentTermsDays('30.5').ok, false);
    assert.equal(parsePaymentTermsDays(30.5).ok, false);
  });

  test('rejects negative values', () => {
    assert.equal(parsePaymentTermsDays(-1).ok, false);
    assert.equal(parsePaymentTermsDays('-5').ok, false);
  });

  test('rejects values above 365', () => {
    assert.equal(parsePaymentTermsDays(366).ok, false);
  });

  test('accepts the boundary values 0 and 365', () => {
    assert.equal(parsePaymentTermsDays(0).ok, true);
    assert.equal(parsePaymentTermsDays(365).ok, true);
  });

  test('NaN-producing input is rejected, not silently let through', () => {
    // The bug this guards against: parseFloat('abc') is NaN, and every
    // comparison against NaN is false, so a bare `v < 0 || v > 365` range
    // check lets garbage reach the database. Number.isInteger(NaN) is false,
    // which is what makes this rejection actually work.
    assert.equal(parsePaymentTermsDays('abc').ok, false);
    assert.equal(Number.isInteger(NaN), false);
  });
});

describe('hasRecordedTerms', () => {
  test('true for 0 (cash on delivery is a recorded answer)', () => {
    assert.equal(hasRecordedTerms(0), true);
  });
  test('true for any recorded integer', () => {
    assert.equal(hasRecordedTerms(30), true);
    assert.equal(hasRecordedTerms(365), true);
  });
  test('false for null/undefined (not recorded)', () => {
    assert.equal(hasRecordedTerms(null), false);
    assert.equal(hasRecordedTerms(undefined), false);
  });
});

describe('deriveDueDate — calendar arithmetic', () => {
  test('adds days within a month', () => {
    assert.equal(deriveDueDate('2026-09-28', 5), '2026-10-03');
  });

  test('0-day terms return the same date (cash on delivery)', () => {
    assert.equal(deriveDueDate('2026-09-28', 0), '2026-09-28');
  });

  test('month rollover', () => {
    assert.equal(deriveDueDate('2026-11-30', 31), '2026-12-31');
  });

  test('year rollover', () => {
    assert.equal(deriveDueDate('2026-12-20', 30), '2027-01-19');
  });

  test('leap-year rollover — 2028 is a leap year', () => {
    assert.equal(deriveDueDate('2028-01-31', 29), '2028-02-29');
  });

  test('non-leap-year February has no 29th', () => {
    // 2026 is not a leap year: 31 Jan + 29 days lands on 1 Mar, not 29 Feb.
    assert.equal(deriveDueDate('2026-01-31', 29), '2026-03-01');
  });

  test('returns null when terms are not recorded', () => {
    assert.equal(deriveDueDate('2026-09-28', null), null);
    assert.equal(deriveDueDate('2026-09-28', undefined), null);
  });

  test('returns null for an invalid purchase date rather than producing a bad result', () => {
    assert.equal(deriveDueDate('2026-02-30', 30), null); // Feb 30 doesn't exist
    assert.equal(deriveDueDate('not-a-date', 30), null);
    assert.equal(deriveDueDate('', 30), null);
  });

  test('0-day terms on an invalid supplier still returns null, not the invalid input echoed back', () => {
    assert.equal(deriveDueDate('2026-13-01', 0), null);
  });
});

describe('describeDueDateSource — provenance wording (P0)', () => {
  test('explicit source', () => {
    assert.deepEqual(
      describeDueDateSource('explicit', 30),
      { label: 'Explicit date', assumed: false },
    );
  });

  test('supplier_terms source includes the day count, matches the spec wording exactly', () => {
    assert.deepEqual(
      describeDueDateSource('supplier_terms', 30),
      { label: 'Supplier terms · 30 days', assumed: false },
    );
  });

  test('supplier_terms singular day', () => {
    assert.equal(describeDueDateSource('supplier_terms', 1).label, 'Supplier terms · 1 day');
  });

  test('supplier_terms with 0 days (cash on delivery) still labelled, not blank', () => {
    assert.equal(describeDueDateSource('supplier_terms', 0).label, 'Supplier terms · 0 days');
  });

  test('no source recorded at all is "Assumed by Cashflow", never presented as fact', () => {
    assert.deepEqual(
      describeDueDateSource(null, null),
      { label: 'Assumed by Cashflow', assumed: true },
    );
    assert.deepEqual(
      describeDueDateSource(undefined, undefined),
      { label: 'Assumed by Cashflow', assumed: true },
    );
  });

  test('an unrecognised source value falls back to Assumed rather than throwing or mislabeling', () => {
    assert.equal(describeDueDateSource('something_unexpected', 30).assumed, true);
  });
});

describe('provenance cannot be re-derived by comparing against current terms (the P0 bug)', () => {
  test('a stored explicit date that happens to match a NEW terms-derived date must still read as explicit', () => {
    // Scenario: purchase made when supplier had no terms, due date entered by
    // hand as 2026-10-28 (explicit). Supplier terms are set to 30 days later.
    // 2026-09-28 + 30 = 2026-10-28 — the SAME date, purely by coincidence.
    // Provenance must come from the stored due_date_source, not from
    // recomputing and comparing dates, or this would misreport as derived.
    const storedDate   = '2026-10-28';
    const storedSource = 'explicit'; // recorded at write time, unrelated to current terms
    const currentTerms = 30;
    const wouldBeDerivedToday = deriveDueDate('2026-09-28', currentTerms);

    assert.equal(wouldBeDerivedToday, storedDate); // the coincidence
    assert.equal(
      describeDueDateSource(storedSource, currentTerms).label,
      'Explicit date', // NOT "Supplier terms · 30 days" — the stored fact wins
    );
  });
});

describe('terms changed after purchase creation must not relabel old purchases (rev-3 P0)', () => {
  test('a purchase derived under 30-day terms keeps reading "30 days" after the supplier moves to 60', () => {
    // Purchase created while the supplier had 30-day terms.
    const fields = buildDueDateFields('supplier_terms', {
      derivedDate:        '2026-10-28',
      supplierTermsDays:  30,
    });
    assert.equal(fields.due_date_terms_days, 30);

    // Supplier's terms change afterwards — buildDueDateFields is never
    // re-invoked for this row, so its output is inert; but the label
    // function is the thing the UI would actually call, and it must be
    // given the STORED snapshot (30), never the supplier's new terms (60).
    const supplierCurrentTermsNow = 60;
    assert.equal(
      describeDueDateSource(fields.due_date_source, fields.due_date_terms_days).label,
      'Supplier terms · 30 days',
    );
    // Sanity check that this is not a trivial pass: calling describeDueDateSource
    // with the supplier's CURRENT terms instead of the snapshot produces the
    // wrong label, which is exactly the bug this snapshot exists to prevent.
    assert.equal(
      describeDueDateSource(fields.due_date_source, supplierCurrentTermsNow).label,
      'Supplier terms · 60 days',
    );
  });
});

describe('POST "unrecorded" with a supplier that has terms must stay unrecorded (rev-3 P0)', () => {
  test('shouldRequestSupplierTermsDerivation ignores whether the supplier has terms — only the resolved mode matters', () => {
    // The bug: the old trigger derived a date whenever the supplier had ANY
    // terms recorded, regardless of what the caller asked for. The fix makes
    // derivation depend solely on the resolved mode being 'supplier_terms'.
    assert.equal(shouldRequestSupplierTermsDerivation('unrecorded'), false);
    assert.equal(shouldRequestSupplierTermsDerivation('explicit'), false);
    assert.equal(shouldRequestSupplierTermsDerivation('supplier_terms'), true);
  });

  test('inferLegacyDueDateMode only infers supplier_terms when due_date_mode was truly omitted, never when the caller said unrecorded', () => {
    // Omission with a supplier that has terms -> infer supplier_terms (the
    // pre-mode contract). This is NOT the same case as an explicit
    // "unrecorded" request, which this function is never even consulted for
    // — the route only calls it when due_date_mode is undefined/null.
    assert.equal(
      inferLegacyDueDateMode({ rawDueDateProvided: false, supplierTermsDays: 30 }),
      'supplier_terms',
    );
    assert.equal(
      inferLegacyDueDateMode({ rawDueDateProvided: false, supplierTermsDays: null }),
      'unrecorded',
    );
    // 0 is a recorded answer (cash on delivery), not "no terms" — must still infer supplier_terms.
    assert.equal(
      inferLegacyDueDateMode({ rawDueDateProvided: false, supplierTermsDays: 0 }),
      'supplier_terms',
    );
    // A raw due_date always means explicit, even if the supplier happens to have terms too.
    assert.equal(
      inferLegacyDueDateMode({ rawDueDateProvided: true, supplierTermsDays: 30 }),
      'explicit',
    );
  });
});

describe('PATCH "unrecorded" with a supplier that has terms must stay unrecorded, matching POST (rev-3 P0)', () => {
  test('buildDueDateFields("unrecorded") always clears all three fields, independent of any terms value', () => {
    // buildDueDateFields doesn't even take a supplierTermsDays parameter for
    // 'unrecorded' — that is the point: a supplier having terms cannot leak
    // into the outcome. Passing one anyway (as if a caller tried to smuggle
    // it in) must still be ignored.
    const withIgnoredTerms = buildDueDateFields('unrecorded', { supplierTermsDays: 45 });
    assert.deepEqual(withIgnoredTerms, {
      due_date: null,
      due_date_source: null,
      due_date_terms_days: null,
    });

    const withNoInputsAtAll = buildDueDateFields('unrecorded');
    assert.deepEqual(withNoInputsAtAll, {
      due_date: null,
      due_date_source: null,
      due_date_terms_days: null,
    });
  });
});

describe('supplier-terms snapshot preservation (rev-3 P0)', () => {
  test('buildDueDateFields("supplier_terms") stores exactly the terms it was given, including 0 (cash on delivery)', () => {
    assert.deepEqual(
      buildDueDateFields('supplier_terms', { derivedDate: '2026-11-05', supplierTermsDays: 45 }),
      { due_date: '2026-11-05', due_date_source: 'supplier_terms', due_date_terms_days: 45 },
    );
    assert.deepEqual(
      buildDueDateFields('supplier_terms', { derivedDate: '2026-09-01', supplierTermsDays: 0 }),
      { due_date: '2026-09-01', due_date_source: 'supplier_terms', due_date_terms_days: 0 },
    );
  });

  test('buildDueDateFields("supplier_terms") refuses to build without a derived date or recorded terms', () => {
    assert.throws(
      () => buildDueDateFields('supplier_terms', { supplierTermsDays: 30 }),
      { name: 'RangeError' },
    );
    assert.throws(
      () => buildDueDateFields('supplier_terms', { derivedDate: '2026-11-05', supplierTermsDays: null }),
      { name: 'RangeError' },
    );
  });
});

describe('explicit dates never carry a terms snapshot (rev-3 P0)', () => {
  test('buildDueDateFields("explicit") sets due_date_terms_days to null even if a terms value is also passed', () => {
    const fields = buildDueDateFields('explicit', {
      explicitDate:       '2026-12-01',
      supplierTermsDays:  30, // must be ignored entirely — an explicit date has no "terms used"
    });
    assert.deepEqual(fields, {
      due_date: '2026-12-01',
      due_date_source: 'explicit',
      due_date_terms_days: null,
    });
  });

  test('buildDueDateFields("explicit") refuses to build without a date', () => {
    assert.throws(() => buildDueDateFields('explicit', {}), { name: 'RangeError' });
  });
});
