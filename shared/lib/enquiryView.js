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

export const ENQUIRY_STAGES = ['new', 'contacted', 'quoted', 'won', 'lost'];
export const OPEN_STAGES = ['new', 'contacted', 'quoted'];

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
export function attentionInfo(e, today) {
  if (!e || !OPEN_STAGES.includes(e.stage)) return null;
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

/** Secondary actions for the menu (empty = no menu). */
export function enquiryMenu(e) {
  if (!e) return [];
  const out = [];
  if (e.stage === 'new') out.push({ key: 'quote', label: 'Create quote' });
  if (e.stage === 'new' || e.stage === 'contacted') out.push({ key: 'lost', label: 'Mark as lost', danger: true });
  return out;
}

export function matchesEnquirySearch(e, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return true;
  const hay = [e.enq_num, e.customers?.name, e.prospect_name, e.description, e.category, e.source]
    .filter(Boolean).join(' ').toLowerCase();
  return t.split(/\s+/).every(w => hay.includes(w));
}

export function enquiryTabCounts(list) {
  const c = { all: list.length, attention: 0 };
  for (const s of ENQUIRY_STAGES) c[s] = 0;
  for (const e of list) if (c[e.stage] !== undefined) c[e.stage] += 1;
  return c;
}

/** True when the row should show in the "Needs attention" tab. */
export function needsAttention(e, today) {
  const a = attentionInfo(e, today);
  return !!a && (a.tone === 'red' || a.tone === 'amber');
}

export function summariseEnquiries(list, today) {
  let newCount = 0, newWaiting = 0, attention = 0, overdueFollowUps = 0, openValue = 0, won = 0, lost = 0;
  for (const e of list) {
    if (e.stage === 'new') {
      newCount += 1;
      if (attentionInfo(e, today)?.key === 'new_waiting') newWaiting += 1;
    }
    if (OPEN_STAGES.includes(e.stage)) openValue += num(e.estimated_value);
    if (needsAttention(e, today)) attention += 1;
    if (attentionInfo(e, today)?.key === 'followup_overdue') overdueFollowUps += 1;
    if (e.stage === 'won') won += 1;
    if (e.stage === 'lost') lost += 1;
  }
  const decided = won + lost;
  return {
    newCount, newWaiting, attention, overdueFollowUps, openValue, won, lost,
    winRate: decided > 0 ? Math.round((won / decided) * 100) : null,
  };
}
