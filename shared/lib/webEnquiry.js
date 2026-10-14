/**
 * shared/lib/webEnquiry.js
 *
 * Pure helpers for website enquiries, shared by the API routes (server) and the
 * CRM screens (browser). No I/O, no node-only imports, no clock (now is passed in).
 *
 *   shapeWebSubmission  what the CRM may see of a web_form_submissions row
 *   responseClock       first-reply state from the SERVER-computed reply_due_at
 *   describeSource      short "where did this lead come from" label
 *
 * The reply deadline itself is calculated in the database (business_deadline(),
 * enquiry_response_control.sql) and stored in enquiries.reply_due_at. This file
 * only compares it with "now"; it never does business-hours arithmetic, so the
 * CRM list, the Home dashboard and the database cannot disagree.
 */

export const CONTACT_METHODS = ['call', 'whatsapp', 'email', 'visit', 'other'];
export const CONTACT_METHOD_LABEL = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Visit', other: 'Other' };

/** An enquiry still being worked: a reply is still owed. */
export const REPLY_OPEN_STAGES = ['new', 'contacted', 'quoted'];
export const DUE_SOON_MS = 15 * 60 * 1000;

export const MATCH_LABEL = {
  matched_phone: 'Matched an existing customer by phone',
  matched_email: 'Matched an existing customer by email',
  new_prospect: 'New prospect (no existing customer matched)',
  ambiguous: 'Several customers match: needs a person to decide',
  manually_linked: 'Linked to a customer by a team member',
  kept_as_prospect: 'Kept as a new prospect by a team member',
};

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

/** Short human summary of where the lead came from, or '' when unknown/direct. */
export function describeSource(a = {}) {
  const tagged = [a.utm_source, a.utm_medium, a.utm_campaign].filter(Boolean).join(' / ');
  if (tagged) return tagged;
  const host = hostOf(a.referrer);
  return host && !/theseatingcompany\./i.test(host) ? host : '';
}

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Reduce a web_form_submissions row (with its JSON payload) to the fields the CRM
 * screens need. The raw payload is never forwarded to the browser.
 * `at` on consent is when the Tracker RECEIVED the submission, not when the
 * customer ticked the box, so the UI labels it "Recorded at".
 */
export function shapeWebSubmission(row) {
  if (!row) return null;
  const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const a = p.attribution && typeof p.attribution === 'object' ? p.attribution : {};
  const c = p.consent && typeof p.consent === 'object' ? p.consent : {};
  return {
    submission_id: row.external_id || null,
    shop_domain: row.shop_domain || null,
    match_status: row.match_status || null,
    received_at: row.received_at || null,
    resolved_at: row.resolved_at || null,
    contact_phone: row.contact_phone || null,
    contact_email: row.contact_email || null,
    company: str(p.company),
    location: str(p.location),
    project_type: str(p.project_type),
    product_interest: str(p.product_interest),
    quantity: Number.isFinite(p.quantity) ? p.quantity : null,
    budget: str(p.budget),
    reference_link: str(p.reference_link),
    attribution: {
      utm_source: str(a.utm_source), utm_medium: str(a.utm_medium), utm_campaign: str(a.utm_campaign),
      landing_page: str(a.landing_page), referrer: str(a.referrer),
    },
    source_label: describeSource(a),
    consent: { given: c.given === true, version: str(c.version), recorded_at: str(c.at) || row.received_at || null },
  };
}

/**
 * First-reply state for one enquiry.
 *   null         no clock applies (not a timed enquiry, or closed without a reply)
 *   contacted    a person logged first contact (the ONLY thing that stops the clock)
 *   on_track     reply still owed, more than 15 minutes left
 *   due_soon     reply owed within 15 minutes
 *   overdue      reply deadline passed
 */
export function responseClock(e, now = Date.now()) {
  if (!e) return null;
  if (e.first_contact_at) return { state: 'contacted', at: e.first_contact_at, method: e.first_contact_method || null };
  if (!e.reply_due_at || !REPLY_OPEN_STAGES.includes(e.stage)) return null;
  const due = Date.parse(e.reply_due_at);
  if (!Number.isFinite(due)) return null;
  const left = due - now;
  const state = left < 0 ? 'overdue' : left <= DUE_SOON_MS ? 'due_soon' : 'on_track';
  return { state, dueAt: e.reply_due_at, msToDue: left, overdueMs: Math.max(0, -left) };
}

export function isAwaitingReply(e, now = Date.now()) {
  const c = responseClock(e, now);
  return !!c && c.state !== 'contacted';
}

/** "12m", "3h 12m", "2d 4h". */
export function formatDuration(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const NAIROBI = 'Africa/Nairobi';
const dayKey = t => new Intl.DateTimeFormat('en-CA', { timeZone: NAIROBI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** "11:40" when due today (Nairobi), otherwise "Mon 08:40". */
export function formatDue(dueIso, now = Date.now()) {
  const t = Date.parse(dueIso);
  if (!Number.isFinite(t)) return '';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: NAIROBI, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
  if (dayKey(t) === dayKey(now)) return time;
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: NAIROBI, weekday: 'short' }).format(t);
  return `${wd} ${time}`;
}

/** Counts for the summary strip and Home. */
export function summariseResponse(list, now = Date.now()) {
  let awaiting = 0, overdue = 0, dueSoon = 0, oldestWaitingMs = 0;
  for (const e of list || []) {
    const c = responseClock(e, now);
    if (!c || c.state === 'contacted') continue;
    awaiting += 1;
    if (c.state === 'overdue') overdue += 1;
    if (c.state === 'due_soon') dueSoon += 1;
    const waited = now - Date.parse(e.created_at);
    if (Number.isFinite(waited)) oldestWaitingMs = Math.max(oldestWaitingMs, waited);
  }
  return { awaiting, overdue, dueSoon, oldestWaitingMs };
}
