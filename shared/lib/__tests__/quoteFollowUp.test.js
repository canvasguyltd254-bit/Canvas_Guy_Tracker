import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nairobiDay, isChaseable, followUpState, needsAutoTask, followUpSummary, CADENCE_DAYS,
} from '../quoteFollowUp.js';

const TODAY = '2026-10-08';
const sent = (extra = {}) => ({ status: 'sent', sent_at: '2026-10-05T09:00:00+03:00', ...extra });

test('nairobiDay shifts late-evening UTC into the next Nairobi day', () => {
  assert.equal(nairobiDay('2026-10-05T22:30:00Z'), '2026-10-06');
  assert.equal(nairobiDay('2026-10-05T08:00:00Z'), '2026-10-05');
  assert.equal(nairobiDay('2026-10-05'), '2026-10-05');
  assert.equal(nairobiDay(null), null);
  assert.equal(nairobiDay('nope'), null);
});

test('only open, sent, unconverted, unsuspended quotes are chaseable', () => {
  assert.equal(isChaseable(sent()), true);
  for (const s of ['draft', 'accepted', 'rejected', 'expired', 'superseded']) assert.equal(isChaseable({ status: s }), false, s);
  assert.equal(isChaseable(sent({ converted_order_id: 'o' })), false);
  assert.equal(isChaseable(sent({ suspended_at: '2026-10-01' })), false);
  assert.equal(followUpState({ status: 'draft' }, TODAY).applies, false);
});

test('due exactly at CADENCE_DAYS after sending, not before', () => {
  assert.equal(CADENCE_DAYS, 3);
  const at = day => followUpState(sent({ sent_at: `${day}T10:00:00+03:00` }), TODAY);
  assert.equal(at('2026-10-08').due, false);                  // sent today
  assert.equal(at('2026-10-07').due, false);                  // 1 day
  assert.equal(at('2026-10-06').due, false);                  // 2 days
  const three = at('2026-10-05');
  assert.equal(three.due, true);
  assert.equal(three.idleDays, 3);
  assert.equal(three.label, 'Sent 3 days ago, no contact yet');
  assert.equal(three.nextDueDay, '2026-10-08');
});

test('a logged contact resets the clock and changes the wording', () => {
  const s = followUpState(sent({ sent_at: '2026-10-01T10:00:00+03:00', last_contact_at: '2026-10-07T10:00:00+03:00' }), TODAY);
  assert.equal(s.due, false);
  assert.equal(s.idleDays, 1);
  assert.equal(s.label, 'Follow up in 2 days');
  const again = followUpState(sent({ sent_at: '2026-10-01T10:00:00+03:00', last_contact_at: '2026-10-04T10:00:00+03:00' }), TODAY);
  assert.equal(again.due, true);
  assert.equal(again.label, 'No contact for 4 days');
  assert.equal(again.neverContacted, false);
  assert.equal(again.nudge, 1);
});

test('a contact logged BEFORE the (re)send does not count', () => {
  const s = followUpState(sent({ sent_at: '2026-10-05T10:00:00+03:00', last_contact_at: '2026-09-20T10:00:00+03:00' }), TODAY);
  assert.equal(s.idleDays, 3);
  assert.equal(s.neverContacted, true);
});

test('snooze hides the nudge until the date, then it returns', () => {
  const q = sent({ follow_up_snoozed_until: '2026-10-10' });
  const s = followUpState(q, TODAY);
  assert.equal(s.due, false); assert.equal(s.snoozed, true); assert.match(s.label, /Snoozed until 2026-10-10/);
  assert.equal(followUpState(q, '2026-10-10').due, true);
});

test('missing sent_at falls back to updated_at then created_at', () => {
  assert.equal(followUpState({ status: 'sent', updated_at: '2026-10-01T00:00:00Z' }, TODAY).idleDays, 7);
  assert.equal(followUpState({ status: 'sent', created_at: '2026-09-28T00:00:00Z' }, TODAY).idleDays, 10);
  assert.equal(followUpState({ status: 'sent' }, TODAY).applies, false);
});

test('needsAutoTask: due, no open task, and not ancient', () => {
  const q = sent();
  assert.equal(needsAutoTask(q, TODAY, false), true);
  assert.equal(needsAutoTask(q, TODAY, true), false);
  assert.equal(needsAutoTask(sent({ sent_at: '2026-10-07T10:00:00+03:00' }), TODAY, false), false);
  assert.equal(needsAutoTask(sent({ sent_at: '2026-08-01T10:00:00+03:00' }), TODAY, false), false); // >30 days quiet
});

test('summary orders the quietest quotes first', () => {
  const quotes = [
    sent({ id: 'a', sent_at: '2026-10-04T10:00:00+03:00' }),
    sent({ id: 'b', sent_at: '2026-09-28T10:00:00+03:00' }),
    sent({ id: 'c', sent_at: '2026-10-08T10:00:00+03:00' }),
    { id: 'd', status: 'draft' },
  ];
  const s = followUpSummary(quotes, TODAY);
  assert.equal(s.dueCount, 2);
  assert.deepEqual(s.due.map(x => x.quote.id), ['b', 'a']);
});
