/**
 * shared/lib/quoteView.js
 *
 * Pure view logic for the CRM Quotations list: what status to show, which single
 * action is primary, how urgent the validity date is, tab counts, and the summary
 * strip. No React, no fetching, so it is unit-tested and the table stays dumb.
 *
 * Dates are 'YYYY-MM-DD' strings (a timestamp is cut to its date part). `today`
 * is passed in, never read from the clock.
 */

import { isChaseable } from './quoteFollowUp.js';

export const STATUS_ORDER = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'];
export const EXPIRY_WARN_DAYS = 7;
export const EXPIRY_URGENT_DAYS = 3;

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const dayOf = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const dayNumber = d => {
  const [y, m, dd] = d.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, dd) / 86400000);
};

/** Whole days from today to valid_until (negative once lapsed); null when no date. */
export function daysLeft(validUntil, today) {
  const v = dayOf(validUntil), t = dayOf(today);
  return v && t ? dayNumber(v) - dayNumber(t) : null;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * How to show the "valid until" cell. Only meaningful while a quote is still
 * open (draft or sent); every other status returns null so the cell stays quiet.
 * @returns {{ text: string, tone: 'red'|'amber'|'muted', days: number } | null}
 */
export function validityInfo(qt, today) {
  if (!qt || (qt.status !== 'draft' && qt.status !== 'sent')) return null;
  const d = daysLeft(qt.valid_until, today);
  if (d === null) return null;
  if (d < 0) return { text: `Expired ${plural(-d, 'day')} ago`, tone: 'red', days: d };
  if (d === 0) return { text: 'Expires today', tone: 'red', days: d };
  if (d <= EXPIRY_URGENT_DAYS) return { text: `${plural(d, 'day')} left`, tone: 'red', days: d };
  if (d <= EXPIRY_WARN_DAYS) return { text: `${plural(d, 'day')} left`, tone: 'amber', days: d };
  return { text: `${plural(d, 'day')} left`, tone: 'muted', days: d };
}

/**
 * ONE status for the row. A converted quote is "Order created", not "accepted"
 * plus a separate chip.
 */
export function statusView(qt) {
  if (qt?.converted_order_id) return { label: 'Order created', color: 'green', key: 'converted' };
  const s = qt?.status || 'draft';
  const map = {
    draft: ['Draft', 'gray'], sent: ['Sent', 'blue'], accepted: ['Accepted', 'green'],
    rejected: ['Rejected', 'red'], expired: ['Expired', 'amber'], superseded: ['Superseded', 'gray'],
  };
  const [label, color] = map[s] || [s, 'gray'];
  return { label, color, key: s };
}

/**
 * The single primary action for a row, or null. `disabledReason` is shown inline
 * (not in a tooltip a disabled button swallows) when the action is blocked.
 * @returns {{ key: 'send'|'accept'|'convert'|'invoice', label: string, disabledReason?: string } | null}
 */
export function primaryAction(qt) {
  if (!qt || qt.suspended_at) return null;
  if (qt.converted_order_id) {
    return qt.orders?.invoice_number ? { key: 'invoice', label: 'Invoice PDF' } : null;
  }
  const noCustomer = !qt.customer_id;
  switch (qt.status) {
    case 'draft': return { key: 'send', label: 'Send' };
    case 'sent':
      return noCustomer
        ? { key: 'accept', label: 'Accept', disabledReason: 'Link a customer profile to accept' }
        : { key: 'accept', label: 'Accept' };
    case 'accepted':
      return noCustomer
        ? { key: 'convert', label: 'Convert to order', disabledReason: 'Link a customer profile to convert' }
        : { key: 'convert', label: 'Convert to order' };
    default: return null;
  }
}

/**
 * Secondary actions for the "more" menu. Reject is the only destructive one and
 * is flagged so the UI can colour it and confirm.
 * @returns {{ key: string, label: string, danger?: boolean }[]}
 */
export function menuActions(qt) {
  if (!qt) return [];
  const out = [{ key: 'pdf', label: 'Download PDF' }];
  if (qt.converted_order_id && qt.orders?.invoice_number) out.push({ key: 'invoice', label: 'Download invoice PDF' });
  if (isChaseable(qt)) {
    out.push({ key: 'contact', label: 'Log contact' });
    out.push({ key: 'snooze', label: 'Snooze reminder' });
  }
  if (!qt.converted_order_id) out.push({ key: 'edit', label: 'Edit quote' });
  if (qt.status === 'sent') out.push({ key: 'reject', label: 'Reject quote', danger: true });
  return out;
}

export function customerLabel(qt) {
  const c = qt?.customers?.name;
  if (c) return { name: c, isCustomer: true };
  const p = String(qt?.prospect_name || '').replace(/^~+\s*/, '').trim();
  return { name: p || '—', isCustomer: false };
}

/** Case-insensitive search over quote number, customer/prospect and project. */
export function matchesSearch(qt, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return true;
  const hay = [qt.quote_num, qt.customers?.name, qt.prospect_name, qt.project_description]
    .filter(Boolean).join(' ').toLowerCase();
  return t.split(/\s+/).every(w => hay.includes(w));
}

/** Counts per tab, computed on the SEARCH-filtered list so numbers match what a tab shows. */
export function tabCounts(quotes) {
  const counts = { all: quotes.length };
  for (const s of STATUS_ORDER) counts[s] = 0;
  for (const q of quotes) if (counts[q.status] !== undefined) counts[q.status] += 1;
  return counts;
}

/**
 * Summary strip. "Open" = sent and still awaiting a reply.
 *  - openValue / openCount: value and number of sent quotes
 *  - expiringSoon: open (draft or sent) quotes lapsing within EXPIRY_WARN_DAYS, or already lapsed
 *  - toConvert: accepted quotes that have not become an order yet (money waiting to be started)
 */
export function summarise(quotes, today) {
  let openValue = 0, openCount = 0, expiringSoon = 0, toConvert = 0, toConvertValue = 0;
  for (const q of quotes) {
    if (q.suspended_at) continue;
    if (q.status === 'sent') { openValue += num(q.total); openCount += 1; }
    if (q.status === 'accepted' && !q.converted_order_id) { toConvert += 1; toConvertValue += num(q.total); }
    const v = validityInfo(q, today);
    if (v && v.days <= EXPIRY_WARN_DAYS) expiringSoon += 1;
  }
  return { openValue, openCount, expiringSoon, toConvert, toConvertValue };
}
