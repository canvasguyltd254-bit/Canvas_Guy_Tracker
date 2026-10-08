/**
 * shared/lib/invoiceView.js
 *
 * Pure view logic for the CRM Invoices tab: payment urgency, ageing, tab counts
 * and the metrics strip. Same money rules as Customers and Reports: cancelled and
 * suspended orders are not receivables, and a balance under SETTLED_TOLERANCE
 * counts as paid. No React, no fetching, no clock.
 *
 * Input rows are the shape returned by GET /api/crm/invoices.
 */

import { SETTLED_TOLERANCE } from './customerBalance.js';
import { isCancelled } from './reports/orderRules.js';

export const AGEING_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd1_30',   label: '1–30 days' },
  { key: 'd31_60',  label: '31–60 days' },
  { key: 'd61_90',  label: '61–90 days' },
  { key: 'd90p',    label: '90+ days' },
  { key: 'nodate',  label: 'No due date' },
];
export const DUE_SOON_DAYS = 7;

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

/** A row that counts as a live, issued invoice (not pending issuance, cancelled or suspended). */
export function isLiveInvoice(inv) {
  return !!inv && !inv.pending_invoice && !inv.suspended_at && !isCancelled(inv);
}

export function owes(inv) {
  return isLiveInvoice(inv) && num(inv.balance) >= SETTLED_TOLERANCE;
}

/** Days past the payment due date (negative = not yet due); null without a date. */
export function daysPastDue(inv, today) {
  const d = dayOf(inv?.payment_due_date), t = dayOf(today);
  return d && t ? dayNumber(t) - dayNumber(d) : null;
}

/**
 * Payment urgency line for an invoice that is still owed.
 * @returns {{ text: string, tone: 'red'|'amber'|'muted', overdue: boolean } | null}
 */
export function dueInfo(inv, today) {
  if (!owes(inv)) return null;
  const p = daysPastDue(inv, today);
  if (p === null) return { text: 'No due date', tone: 'muted', overdue: false };
  if (p > 0) return { text: `${plural(p, 'day')} overdue`, tone: p > 30 ? 'red' : 'amber', overdue: true };
  if (p === 0) return { text: 'Due today', tone: 'amber', overdue: false };
  const left = -p;
  return { text: `Due in ${plural(left, 'day')}`, tone: left <= DUE_SOON_DAYS ? 'amber' : 'muted', overdue: false };
}

export function ageingBucket(inv, today) {
  const p = daysPastDue(inv, today);
  if (p === null) return 'nodate';
  if (p <= 0) return 'current';
  if (p <= 30) return 'd1_30';
  if (p <= 60) return 'd31_60';
  if (p <= 90) return 'd61_90';
  return 'd90p';
}

/** Which tab(s) a row belongs to. */
export function invoiceTabs(inv, today) {
  const tabs = ['all'];
  if (inv.pending_invoice) { tabs.push('pending'); return tabs; }
  if (!isLiveInvoice(inv)) { tabs.push('cancelled'); return tabs; }
  if (owes(inv)) {
    tabs.push('outstanding');
    if (dueInfo(inv, today)?.overdue) tabs.push('overdue');
  } else {
    tabs.push('paid');
  }
  return tabs;
}

export function invoiceTabCounts(list, today) {
  const c = { all: 0, outstanding: 0, overdue: 0, paid: 0, pending: 0, cancelled: 0 };
  for (const inv of list) for (const t of invoiceTabs(inv, today)) c[t] += 1;
  return c;
}

export function matchesInvoiceSearch(inv, term) {
  const t = String(term || '').trim().toLowerCase();
  if (!t) return true;
  const hay = [inv.invoice_number, inv.customer_name, inv.customer_name_current, inv.quote_num, inv.order_num]
    .filter(Boolean).join(' ').toLowerCase();
  return t.split(/\s+/).every(w => hay.includes(w));
}

/**
 * Metrics strip. Money totals use live, issued invoices only.
 *  - collectionRate: collected / invoiced as a whole percent (null when nothing invoiced)
 *  - ageing: outstanding amount per bucket, summing to `outstanding`
 */
export function summariseInvoices(list, today) {
  const t = {
    invoiced: 0, collected: 0, outstanding: 0, invoiceCount: 0, owingCount: 0,
    overdue: 0, overdueCount: 0, dueSoon: 0, dueSoonCount: 0, undated: 0,
    pendingCount: 0, pendingValue: 0,
    ageing: Object.fromEntries(AGEING_BUCKETS.map(b => [b.key, 0])),
  };
  for (const inv of list) {
    if (inv.pending_invoice && !inv.suspended_at && !isCancelled(inv)) {
      t.pendingCount += 1; t.pendingValue += num(inv.total_value);
      continue;
    }
    if (!isLiveInvoice(inv)) continue;
    t.invoiced += num(inv.total_value);
    t.collected += num(inv.total_paid);
    t.invoiceCount += 1;
    if (!owes(inv)) continue;
    const bal = num(inv.balance);
    t.outstanding += bal; t.owingCount += 1;
    t.ageing[ageingBucket(inv, today)] += bal;
    const d = dueInfo(inv, today);
    if (d?.overdue) { t.overdue += bal; t.overdueCount += 1; }
    else if (d && d.tone === 'amber') { t.dueSoon += bal; t.dueSoonCount += 1; }
    if (daysPastDue(inv, today) === null) t.undated += bal;
  }
  t.collectionRate = t.invoiced > 0 ? Math.round((t.collected / t.invoiced) * 100) : null;
  return t;
}
