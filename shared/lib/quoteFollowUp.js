/**
 * shared/lib/quoteFollowUp.js
 *
 * When should someone chase a quote that has been sent? Pure rules, no clock and
 * no database, so the list, the Home queue and the daily job all agree.
 *
 * The clock starts at the LATER of "sent" and "last logged contact". A quote is
 * due for follow-up once CADENCE_DAYS have passed since that moment, and again
 * every CADENCE_DAYS after each contact, until it is accepted, rejected,
 * converted, suspended or snoozed. The system cannot see calls or WhatsApp, so
 * only a logged contact resets the clock.
 *
 * Days are Nairobi calendar days (UTC+3, no DST).
 */

export const CADENCE_DAYS = 3;
/** The daily job only creates tasks for quotes quiet for at most this long; older ones show in the list only. */
export const AUTO_TASK_MAX_IDLE_DAYS = 30;
export const SNOOZE_DAYS = 3;
export const CONTACT_METHODS = ['call', 'whatsapp', 'email', 'visit', 'other'];

const dayNumber = d => {
  const [y, m, dd] = d.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, dd) / 86400000);
};
const dayFromNumber = n => new Date(n * 86400000).toISOString().slice(0, 10);

/** 'YYYY-MM-DD' (Nairobi) for a timestamp or date string; null when unusable. */
export function nairobiDay(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Does the nudge rule apply to this quote at all? Open, sent, not converted or suspended. */
export function isChaseable(qt) {
  return !!qt && qt.status === 'sent' && !qt.converted_order_id && !qt.suspended_at;
}

/**
 * @returns {{
 *   applies: boolean, due: boolean, snoozed: boolean, neverContacted: boolean,
 *   idleDays: number|null, nextDueDay: string|null, nudge: number, label: string
 * }}
 */
export function followUpState(qt, today) {
  const none = { applies: false, due: false, snoozed: false, neverContacted: false, idleDays: null, nextDueDay: null, nudge: 0, label: '' };
  if (!isChaseable(qt) || !nairobiDay(today)) return none;

  const sentDay = nairobiDay(qt.sent_at) || nairobiDay(qt.updated_at) || nairobiDay(qt.created_at);
  const contactDay = nairobiDay(qt.last_contact_at);
  if (!sentDay) return none;
  const touch = contactDay && contactDay > sentDay ? contactDay : sentDay;

  const t = dayNumber(nairobiDay(today));
  const idle = Math.max(0, t - dayNumber(touch));
  const nextDueDay = dayFromNumber(dayNumber(touch) + CADENCE_DAYS);
  const snoozeUntil = nairobiDay(qt.follow_up_snoozed_until);
  const snoozed = !!snoozeUntil && nairobiDay(today) < snoozeUntil;
  const due = idle >= CADENCE_DAYS && !snoozed;
  const neverContacted = !contactDay || contactDay < sentDay;

  let label;
  if (due) {
    label = neverContacted
      ? `Sent ${plural(idle, 'day')} ago, no contact yet`
      : `No contact for ${plural(idle, 'day')}`;
  } else if (snoozed) {
    label = `Snoozed until ${snoozeUntil}`;
  } else {
    const left = CADENCE_DAYS - idle;
    label = left <= 0 ? 'Follow up today' : `Follow up in ${plural(left, 'day')}`;
  }
  return { applies: true, due, snoozed, neverContacted, idleDays: idle, nextDueDay, nudge: Math.floor(idle / CADENCE_DAYS), label };
}

/** Should the daily job create a follow-up task for this quote? */
export function needsAutoTask(qt, today, hasOpenTask) {
  if (hasOpenTask) return false;
  const s = followUpState(qt, today);
  return s.due && s.idleDays <= AUTO_TASK_MAX_IDLE_DAYS;
}

/** The note written on a system-made task. */
export function autoTaskNote(qt, today) {
  const s = followUpState(qt, today);
  return `${s.label}. Contact the client, then log it on the quote.`;
}

/** Counts for the summary card and Home queue; oldest-quiet first. */
export function followUpSummary(quotes, today) {
  const due = [];
  for (const q of quotes || []) {
    const s = followUpState(q, today);
    if (s.due) due.push({ quote: q, state: s });
  }
  due.sort((a, b) => b.state.idleDays - a.state.idleDays);
  return { dueCount: due.length, due };
}
