import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeWebSubmission, responseClock, isAwaitingReply, formatDuration, formatDue, summariseResponse, describeSource, DUE_SOON_MS,
} from '../webEnquiry.js';
import {
  filterEnquiries, matchesEnquirySearch, attentionInfo, enquiryMenu, enquiryPrimary, owesFirstContact, summariseEnquiries,
  needsMatchReview, sourceOptions,
} from '../enquiryView.js';

const MIN = 60000;
const NOW = Date.parse('2026-10-14T08:00:00Z');   // Wed 11:00 Nairobi
const at = offsetMin => new Date(NOW + offsetMin * MIN).toISOString();

const enq = (o = {}) => ({
  id: o.id || 'e1', enq_num: 'ENQ-1', source: 'website', brand: 'seating_company', stage: 'new',
  created_at: at(-30), reply_due_at: at(30), first_contact_at: null, first_contact_method: null,
  prospect_name: 'Jane', description: 'chairs', ...o,
});

test('shapeWebSubmission keeps what the CRM needs and drops the raw payload', () => {
  const s = shapeWebSubmission({
    external_id: 'abc', shop_domain: 'tsc.myshopify.com', match_status: 'ambiguous', received_at: '2026-10-14T08:00:00Z',
    contact_phone: '+254733555222', contact_email: 'a@b.co',
    payload: {
      company: 'Villa Rosa', location: 'Westlands', project_type: 'Hospitality', product_interest: 'Dining', quantity: 40, budget: 'KES 800k',
      reference_link: 'https://pin.it/abc', secret_internal: 'x',
      attribution: { utm_source: 'google', utm_medium: 'cpc', landing_page: 'https://s.co/collections/dining' },
      consent: { given: true, version: 'tsc-consent-v1', at: '2026-10-14T08:00:01Z' },
    },
  });
  assert.equal(s.submission_id, 'abc');
  assert.equal(s.company, 'Villa Rosa');
  assert.equal(s.quantity, 40);
  assert.equal(s.source_label, 'google / cpc');
  assert.deepEqual(s.consent, { given: true, version: 'tsc-consent-v1', recorded_at: '2026-10-14T08:00:01Z' });
  assert.ok(!('payload' in s) && !('secret_internal' in s));
});

test('shapeWebSubmission tolerates missing/odd payloads and consent not given', () => {
  assert.equal(shapeWebSubmission(null), null);
  const s = shapeWebSubmission({ external_id: 'x', received_at: '2026-10-14T08:00:00Z', payload: null });
  assert.equal(s.consent.given, false);
  assert.equal(s.consent.recorded_at, '2026-10-14T08:00:00Z');   // falls back to when we received it
  assert.equal(s.company, '');
  assert.equal(s.quantity, null);
  assert.equal(shapeWebSubmission({ payload: { consent: 'yes', attribution: 'x' } }).consent.given, false);
});

test('describeSource prefers UTM tags, then an external referrer host', () => {
  assert.equal(describeSource({ utm_source: 'google' }), 'google');
  assert.equal(describeSource({ referrer: 'https://www.instagram.com/p/1' }), 'instagram.com');
  assert.equal(describeSource({ referrer: 'https://theseatingcompany.co.ke/' }), '');
  assert.equal(describeSource(), '');
});

test('responseClock: on track, due soon, overdue, boundaries', () => {
  assert.equal(responseClock(enq({ reply_due_at: at(60) }), NOW).state, 'on_track');
  assert.equal(responseClock(enq({ reply_due_at: at(15) }), NOW).state, 'due_soon');     // exactly 15 min left
  assert.equal(responseClock(enq({ reply_due_at: at(16) }), NOW).state, 'on_track');
  assert.equal(responseClock(enq({ reply_due_at: at(0) }), NOW).state, 'due_soon');      // due right now is not yet late
  const late = responseClock(enq({ reply_due_at: at(-5) }), NOW);
  assert.equal(late.state, 'overdue');
  assert.equal(late.overdueMs, 5 * MIN);
  assert.equal(DUE_SOON_MS, 15 * MIN);
});

test('responseClock: only a recorded first contact stops the clock', () => {
  // Stage moved on (a quote was started) but nobody logged contact: the clock still runs.
  const quoted = enq({ stage: 'quoted', reply_due_at: at(-120) });
  assert.equal(responseClock(quoted, NOW).state, 'overdue');
  assert.equal(responseClock(enq({ stage: 'contacted', reply_due_at: at(-120) }), NOW).state, 'overdue');
  const done = responseClock(enq({ first_contact_at: at(-10), first_contact_method: 'call', reply_due_at: at(-120) }), NOW);
  assert.deepEqual([done.state, done.method], ['contacted', 'call']);
});

test('responseClock: no clock for untimed or closed enquiries', () => {
  assert.equal(responseClock(enq({ reply_due_at: null }), NOW), null);
  assert.equal(responseClock(enq({ stage: 'lost' }), NOW), null);
  assert.equal(responseClock(enq({ stage: 'won' }), NOW), null);
  assert.equal(responseClock(null, NOW), null);
  assert.equal(responseClock(enq({ reply_due_at: 'garbage' }), NOW), null);
  assert.equal(isAwaitingReply(enq(), NOW), true);
  assert.equal(isAwaitingReply(enq({ first_contact_at: at(-1), first_contact_method: 'call' }), NOW), false);
});

test('formatDuration', () => {
  assert.equal(formatDuration(20 * 1000), '<1m');
  assert.equal(formatDuration(12 * MIN), '12m');
  assert.equal(formatDuration(192 * MIN), '3h 12m');
  assert.equal(formatDuration((26 * 60) * MIN), '1d 2h');
  assert.equal(formatDuration(-5), '<1m');
});

test('formatDue: time today, weekday + time on other days, Nairobi clock', () => {
  assert.equal(formatDue('2026-10-14T08:40:00Z', NOW), '11:40');            // Wed 11:40
  assert.equal(formatDue('2026-10-19T05:40:00Z', NOW), 'Mon 08:40');        // Monday 08:40 Nairobi
  assert.equal(formatDue('nope', NOW), '');
  // 22:30 UTC on the 14th is already the 15th in Nairobi: not "today".
  assert.match(formatDue('2026-10-14T22:30:00Z', NOW), /^Thu /);
});

test('summariseResponse counts only enquiries still owed a reply', () => {
  const list = [
    enq({ id: 'a', reply_due_at: at(-60), created_at: at(-180) }),               // overdue, oldest
    enq({ id: 'b', reply_due_at: at(10), created_at: at(-50) }),                 // due soon
    enq({ id: 'c', reply_due_at: at(40), created_at: at(-20) }),                 // on track
    enq({ id: 'd', first_contact_at: at(-5), first_contact_method: 'call' }),    // done
    enq({ id: 'e', reply_due_at: null }),                                        // no clock
  ];
  const s = summariseResponse(list, NOW);
  assert.deepEqual([s.awaiting, s.overdue, s.dueSoon], [3, 1, 1]);
  assert.equal(s.oldestWaitingMs, 180 * MIN);
});

// ── enquiryView additions ───────────────────────────────────────────────────
const TODAY = '2026-10-14';

test('attentionInfo: an overdue first reply outranks everything', () => {
  const a = attentionInfo(enq({ reply_due_at: at(-5), followups: [{ due_date: '2026-10-20', completed_at: null }] }), TODAY, NOW);
  assert.deepEqual([a.key, a.tone], ['reply_overdue', 'red']);
  assert.equal(attentionInfo(enq({ reply_due_at: at(10) }), TODAY, NOW).key, 'reply_due_soon');
  assert.equal(attentionInfo(enq({ reply_due_at: at(50) }), TODAY, NOW).key, 'new_today');
  assert.equal(attentionInfo(enq({ first_contact_at: at(-1), first_contact_method: 'call', stage: 'contacted', reply_due_at: at(-100) }), TODAY, NOW).key, 'no_followup');
});

test('menu and primary action: Log contact appears only for a timed enquiry past New with no contact', () => {
  assert.equal(owesFirstContact(enq({ stage: 'quoted' })), true);
  assert.equal(owesFirstContact(enq({ stage: 'new' })), false);                       // New already has the primary button
  assert.equal(owesFirstContact(enq({ stage: 'quoted', first_contact_at: at(-1), first_contact_method: 'call' })), false);
  assert.equal(owesFirstContact(enq({ stage: 'quoted', reply_due_at: null })), false);
  assert.equal(enquiryMenu(enq({ stage: 'quoted' }))[0].key, 'log_contact');
  assert.equal(enquiryPrimary(enq({ stage: 'new' })).key, 'contacted');
  assert.ok(!enquiryMenu(enq({ stage: 'contacted', reply_due_at: null })).some(m => m.key === 'log_contact'));
});

test('search covers phone in any format, email, company, brand, enquiry number and brief', () => {
  const e = enq({ enq_num: 'ENQ-2026-0145', prospect_contact: '+254713196650 · jane@villarosa.co.ke', description: 'Dining chairs for the restaurant',
    web: { contact_phone: '+254713196650', contact_email: 'jane@villarosa.co.ke', company: 'Villa Rosa Hotel', location: 'Westlands' } });
  for (const q of ['0145', '0713 196 650', '713196650', '+254 713 196 650', 'villarosa', 'villa rosa', 'westlands', 'seating', 'restaurant chairs', 'JANE'])
    assert.equal(matchesEnquirySearch(e, q), true, q);
  for (const q of ['0722000111', 'canvas', 'banana', '12'])
    assert.equal(matchesEnquirySearch(e, q), false, q);
  assert.equal(matchesEnquirySearch(e, ''), true);
});

test('filterEnquiries: ONE dataset drives both layouts; tab counts ignore the tab', () => {
  const list = [
    enq({ id: 'w1', brand: 'seating_company', source: 'website', stage: 'new', reply_due_at: at(-30) }),
    enq({ id: 'w2', brand: 'canvas_guy', source: 'website', stage: 'contacted', first_contact_at: at(-5), first_contact_method: 'call' }),
    enq({ id: 'm1', brand: 'canvas_guy', source: 'email', stage: 'new', reply_due_at: null, prospect_name: 'Rolaine' }),
    enq({ id: 'm2', brand: null, source: 'whatsapp', stage: 'quoted', reply_due_at: null }),
  ];
  const ids = f => filterEnquiries(list, f, TODAY, NOW).visible.map(e => e.id).sort().join();
  assert.equal(ids({}), 'm1,m2,w1,w2');
  assert.equal(ids({ webOnly: true }), 'w1,w2');
  assert.equal(ids({ brand: 'canvas_guy' }), 'm1,w2');
  assert.equal(ids({ brand: 'canvas_guy', webOnly: true }), 'w2');
  assert.equal(ids({ source: 'email' }), 'm1');
  assert.equal(ids({ tab: 'new' }), 'm1,w1');
  assert.equal(ids({ tab: 'new', webOnly: true }), 'w1');
  assert.equal(ids({ q: 'rolaine' }), 'm1');
  assert.equal(ids({ focus: 'website_waiting' }), 'w1');
  assert.equal(ids({ tab: 'attention' }), 'w1,w2');                               // w1: reply overdue; w2: contacted but no follow-up set
  const r = filterEnquiries(list, { tab: 'new', webOnly: true }, TODAY, NOW);
  assert.equal(r.base.length, 2);                                                  // base ignores the tab, so counts stay right
  assert.deepEqual(sourceOptions(list), ['email', 'website', 'whatsapp']);
});

test('needsMatchReview and the match_review focus', () => {
  const list = [enq({ id: 'a', web: { match_status: 'ambiguous' } }), enq({ id: 'b', web: { match_status: 'manually_linked' } }), enq({ id: 'c', web: null })];
  assert.deepEqual(list.map(needsMatchReview), [true, false, false]);
  assert.equal(filterEnquiries(list, { focus: 'match_review' }, TODAY, NOW).visible.map(e => e.id).join(), 'a');
});

test('summariseEnquiries exposes the website reply numbers', () => {
  const list = [enq({ id: 'a', reply_due_at: at(-60) }), enq({ id: 'b', reply_due_at: at(40) }), enq({ id: 'c', reply_due_at: null, source: 'email' })];
  const s = summariseEnquiries(list, TODAY, NOW);
  assert.deepEqual([s.websiteWaiting, s.websiteOverdue], [2, 1]);
});
