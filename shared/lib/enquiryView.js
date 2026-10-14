/**
 * shared/lib/enquiryView.js
 *
 * Pure view logic for the CRM Enquiries list, mirroring quoteView.js: how long an
 * enquiry has been waiting, which action is primary, tab counts and the summary
 * strip. No React, no fetching, no clock (today is passed in).
 *
 * Enquiry stages: new → contacted → quoted → won | lost. "Quoted" and "won"
 * are set automatically by the quote flow, so a person only ever moves an enquiry
 * from new to contacted, or to lost.
 */

import { responseClock, summariseResponse } from './webEnquiry.js';

export const ENQUIRY_STAGES = ['new', 'contacted', 'quoted', 'won', 'lost'];
export const OPEN_STAGES = ['new', 'contacted', 'quoted'];

export const BRAND_LABEL = { canvas_guy: 'Canvas Guy', seating_company: 'Seating Company' };
export const BRANDS = Object.keys(BRAND_LABEL);

export const isWebsite = e => e?.source === 'website';
export const matchesBrand = (e, brand) => !brand || e?.brand === brand;
export const matchesSource = (e, source) => !source || e?.source === source;

/** Distinct sources present in the list, for the Source filter. */
export function sourceOptions(list) {
  return [...new Set((list || []).map(e => e.source).filter(Boolean))].sort();
}

/** Website enquiry whose phone/email matched several customers and still needs a person. */
export const needsMatchReview = e => e?.web?.match_status === 'ambiguous';

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const dayOf = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const dayNumber = d => {
  const [y, m, dd] = d.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, dd) / 86400000);
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Created timestamp → Nairobi 'YYYY-MM-DD' (UTC+3). */
function createdDay(e) {
  if (!e?.created_at) return null;
  const t = new Date(e.created_at).getTime();
  return Number.isFinite(t) ? new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

export function openFollowUp(e) {
  const open = (e?.followups || []).filter(f => !f.completed_at && dayOf(f.due_date));
  open.sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  return open[0] || null;
}

/**
 * The one line that says whether this enquiry needs attention.
 * @returns {{ text: string, tone: 'red'|'amber'|'muted', key: string } | null}
 */
export function attentionInfo(e, today, now = Date.now()) {
  if (!e || !OPEN_STAGES.includes(e.stage)) return null;
  // A missed first reply outranks everything else on the row.
  const clock = responseClock(e, now);
  if (clock?.state === 'overdue') return { text: 'Reply overdue', tone: 'red', key: 'reply_overdue' };
  if (clock?.state === 'due_soon') return { text: 'Reply due soon', tone: 'amber', key: 'reply_due_soon' };
  const fu = openFollowUp(e);
  if (fu) {
    const d = dayNumber(dayOf(fu.due_date)) - dayNumber(today);
    if (d < 0) return { text: `Follow-up ${plural(-d, 'day')} overdue`, tone: 'red', key: 'followup_overdue' };
    if (d === 0) return { text: 'Follow-up due today', tone: 'amber', key: 'followup_today' };
    return { text: `Follow-up in ${plural(d, 'day')}`, tone: 'muted', key: 'followup_set' };
  }
  if (e.stage === 'new') {
    const c = createdDay(e);
    const waited = c ? Math.max(0, dayNumber(today) - dayNumber(c)) : 0;
    if (waited === 0) return { text: 'New today', tone: 'muted', key: 'new_today' };
    return { text: `Not contacted for ${plural(waited, 'day')}`, tone: waited >= 3 ? 'red' : 'amber', key: 'new_waiting' };
  }
  if (e.stage === 'contacted') return { text: 'No follow-up scheduled', tone: 'amber', key: 'no_followup' };
  return null; // quoted: the quote's own follow-up rule takes over
}

/** @returns {{ key: 'contacted'|'quote', label: string } | null} */
export function enquiryPrimary(e) {
  if (!e) return null;
  if (e.stage === 'new') return { key: 'contacted', label: 'Mark contacted' };
  if (e.stage === 'contacted') return { key: 'quote', label: 'Create quote' };
  return null;
}

/** A timed enquiry nobody has contacted yet, even though its stage moved on (e.g. a quote was started). */
export const owesFirstContact = e =>
  !!e && !!e.reply_due_at && !e.first_contact_at && (e.stage === 'contacted' || e.stage === 'quoted');

/** Secondary actions for the menu (empty = no menu). */
export function enquiryMenu(e) {
  if (!e) return [];
  const out = [];
  if (owesFirstContact(e)) out.push({ key: 'log_contact', label: 'Log contact' });
  if (e.stage === 'new') out.push({ key: 'quote', label: 'Create quote' });
  if (e.stage === 'new' || e.stage === 'contacted') out.push({ key: 'lost', label: 'Mark as lost', danger: true });
  return out;
}

/** Phone numbers compared on their local digits: 0713 196 650, +254713196650 and 713196650 all match. */
const localDigits = v => String(v || '').replace(/\D/g, '').replace(/^254/, '').replace(/^0/, '');

export function matchesEnquirySearch(e, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return true;
  const phones = [e.prospect_contact, e.customers?.phone, e.web?.contact_phone];
  const hay = [
    e.enq_num, e.customers?.name, e.prospect_name, e.description, e.category, e.source,
    e.prospect_contact, e.customers?.phone, e.customers?.email, e.web?.contact_phone, e.web?.contact_email,
    e.web?.company, e.web?.location, BRAND_LABEL[e.brand],
  ].filter(Boolean).join(' ').toLowerCase();
  const hayDigits = phones.map(localDigits).join(' ');
  // A whole phone number typed with spaces ("0713 196 650") must be compared as one number.
  const wholeDigits = localDigits(t);
  if (/^[\d\s+()-]+$/.test(t) && wholeDigits.length >= 4 && hayDigits.includes(wholeDigits)) return true;
  return t.split(/\s+/).every(w => {
    if (hay.includes(w)) return true;
    const d = localDigits(w);
    return /^[\d+()-]+$/.test(w) && d.length >= 4 && hayDigits.includes(d);
  });
}

/**
 * ONE filtered dataset for the desktop table AND the mobile cards.
 * `base` applies every filter except the stage tab, so the tab counts stay correct;
 * `visible` is base narrowed to the chosen tab.
 *
 * f = { tab, q, brand, source, webOnly, focus }
 *   focus: 'website_waiting' (reply clock running) | 'match_review' (ambiguous customer), from Home links.
 */
export function filterEnquiries(list, f = {}, today, now = Date.now()) {
  const base = (list || []).filter(e =>
    matchesEnquirySearch(e, f.q)
    && matchesBrand(e, f.brand)
    && matchesSource(e, f.source)
    && (!f.webOnly || isWebsite(e))
    && (f.focus !== 'website_waiting' || awaitingFirstReply(e, now))
    && (f.focus !== 'match_review' || needsMatchReview(e)));
  const tab = f.tab || 'all';
  const visible = tab === 'all' ? base
    : tab === 'attention' ? base.filter(e => needsAttention(e, today, now))
    : base.filter(e => e.stage === tab);
  return { base, visible };
}

export function enquiryTabCounts(list) {
  const c = { all: list.length, attention: 0 };
  for (const s of ENQUIRY_STAGES) c[s] = 0;
  for (const e of list) if (c[e.stage] !== undefined) c[e.stage] += 1;
  return c;
}

/** True when the row should show in the "Needs attention" tab. */
export function needsAttention(e, today, now = Date.now()) {
  const a = attentionInfo(e, today, now);
  return !!a && (a.tone === 'red' || a.tone === 'amber');
}

/** Website enquiries still waiting for a first human reply (the reply clock is running). */
export function awaitingFirstReply(e, now = Date.now()) {
  const c = responseClock(e, now);
  return !!c && c.state !== 'contacted';
}

export function summariseEnquiries(list, today, now = Date.now()) {
  let newCount = 0, newWaiting = 0, attention = 0, overdueFollowUps = 0, openValue = 0, won = 0, lost = 0;
  for (const e of list) {
    if (e.stage === 'new') {
      newCount += 1;
      if (attentionInfo(e, today, now)?.key === 'new_waiting') newWaiting += 1;
    }
    if (OPEN_STAGES.includes(e.stage)) openValue += num(e.estimated_value);
    if (needsAttention(e, today, now)) attention += 1;
    if (attentionInfo(e, today, now)?.key === 'followup_overdue') overdueFollowUps += 1;
    if (e.stage === 'won') won += 1;
    if (e.stage === 'lost') lost += 1;
  }
  const decided = won + lost;
  const reply = summariseResponse(list, now);
  return {
    newCount, newWaiting, attention, overdueFollowUps, openValue, won, lost,
    winRate: decided > 0 ? Math.round((won / decided) * 100) : null,
    websiteWaiting: reply.awaiting, websiteOverdue: reply.overdue, websiteOldestWaitingMs: reply.oldestWaitingMs,
  };
}
