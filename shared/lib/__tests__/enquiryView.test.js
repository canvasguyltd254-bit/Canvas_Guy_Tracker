import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openFollowUp, attentionInfo, enquiryPrimary, enquiryMenu, matchesEnquirySearch,
  enquiryTabCounts, needsAttention, summariseEnquiries,
} from '../enquiryView.js';

const TODAY = '2026-10-08';
const mk = (o = {}) => ({ stage: 'new', created_at: '2026-10-08T07:00:00+03:00', followups: [], ...o });

test('openFollowUp picks the earliest unfinished one', () => {
  const e = mk({ followups: [
    { due_date: '2026-10-20', completed_at: null },
    { due_date: '2026-10-05', completed_at: '2026-10-06T00:00:00Z' },
    { due_date: '2026-10-10', completed_at: null },
  ] });
  assert.equal(openFollowUp(e).due_date, '2026-10-10');
  assert.equal(openFollowUp(mk()), null);
});

test('attentionInfo: new enquiries age, scheduled follow-ups win', () => {
  assert.deepEqual(attentionInfo(mk(), TODAY), { text: 'New today', tone: 'muted', key: 'new_today' });
  assert.equal(attentionInfo(mk({ created_at: '2026-10-07T09:00:00+03:00' }), TODAY).text, 'Not contacted for 1 day');
  assert.equal(attentionInfo(mk({ created_at: '2026-10-07T09:00:00+03:00' }), TODAY).tone, 'amber');
  assert.equal(attentionInfo(mk({ created_at: '2026-10-04T09:00:00+03:00' }), TODAY).tone, 'red');
  assert.equal(attentionInfo(mk({ stage: 'contacted' }), TODAY).text, 'No follow-up scheduled');
  const withFu = due => mk({ stage: 'contacted', followups: [{ due_date: due, completed_at: null }] });
  assert.deepEqual(attentionInfo(withFu('2026-10-05'), TODAY), { text: 'Follow-up 3 days overdue', tone: 'red', key: 'followup_overdue' });
  assert.equal(attentionInfo(withFu('2026-10-08'), TODAY).text, 'Follow-up due today');
  assert.equal(attentionInfo(withFu('2026-10-11'), TODAY).tone, 'muted');
  for (const stage of ['quoted', 'won', 'lost']) assert.equal(attentionInfo(mk({ stage }), TODAY), null, stage);
});

test('actions follow the stage', () => {
  assert.equal(enquiryPrimary(mk()).key, 'contacted');
  assert.equal(enquiryPrimary(mk({ stage: 'contacted' })).key, 'quote');
  assert.equal(enquiryPrimary(mk({ stage: 'quoted' })), null);
  assert.deepEqual(enquiryMenu(mk()).map(a => a.key), ['quote', 'lost']);
  assert.deepEqual(enquiryMenu(mk({ stage: 'contacted' })).map(a => a.key), ['lost']);
  assert.deepEqual(enquiryMenu(mk({ stage: 'won' })), []);
  assert.equal(enquiryMenu(mk()).find(a => a.key === 'lost').danger, true);
});

test('search covers number, name, description, category', () => {
  const e = mk({ enq_num: 'ENQ-0042', prospect_name: 'Mairi', description: 'Wall art for lounge', category: 'Art' });
  assert.equal(matchesEnquirySearch(e, 'enq-0042'), true);
  assert.equal(matchesEnquirySearch(e, 'mairi lounge'), true);
  assert.equal(matchesEnquirySearch(e, 'sofa'), false);
  assert.equal(matchesEnquirySearch(e, ''), true);
});

test('counts and summary', () => {
  const list = [
    mk({ id: 1, estimated_value: 1000 }),                                              // new today
    mk({ id: 2, created_at: '2026-10-03T09:00:00+03:00', estimated_value: 500 }),      // new, waiting 5 days
    mk({ id: 3, stage: 'contacted', estimated_value: 200 }),                           // no follow-up
    mk({ id: 4, stage: 'contacted', followups: [{ due_date: '2026-10-01', completed_at: null }] }), // overdue
    mk({ id: 5, stage: 'quoted', estimated_value: 800 }),
    mk({ id: 6, stage: 'won', estimated_value: 9999 }),
    mk({ id: 7, stage: 'lost' }),
  ];
  const c = enquiryTabCounts(list);
  assert.equal(c.all, 7); assert.equal(c.new, 2); assert.equal(c.contacted, 2); assert.equal(c.won, 1);
  const s = summariseEnquiries(list, TODAY);
  assert.equal(s.newCount, 2); assert.equal(s.newWaiting, 1);
  assert.equal(s.attention, 3);               // waiting new + no follow-up + overdue follow-up
  assert.equal(s.overdueFollowUps, 1);
  assert.equal(s.openValue, 2500);            // excludes won/lost
  assert.equal(s.winRate, 50);
  assert.equal(needsAttention(list[0], TODAY), false);
  assert.equal(summariseEnquiries([], TODAY).winRate, null);
});
