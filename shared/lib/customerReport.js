/**
 * shared/lib/customerReport.js
 *
 * Pure helpers behind the Customers → Reports tab: date-range presets, filtering
 * by customer and period, the searchable customer picker, and the KPI figures.
 * No React, no I/O.
 */

import { CANCELLED_STATUS } from './customerBalance.js';

const SETTLED = 0.5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar date (YYYY-MM-DD) of a timestamp in the viewer's timezone. */
export function localDateOf(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function formatDay(s) {
  if (!isIsoDate(s)) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ── period ──────────────────────────────────────────────────────────────────

export const PERIOD_PRESETS = [
  { key: 'this_week',    label: 'This week' },
  { key: 'last_week',    label: 'Last week' },
  { key: 'this_month',   label: 'This month' },
  { key: 'last_month',   label: 'Last month' },
  { key: 'last_3_months', label: 'Last 3 months' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'this_year',    label: 'This year' },
  { key: 'all',          label: 'All time' },
];

// Monday-based week (Kenya). Returns the Monday of the week containing y-m-d, as a UTC Date.
function mondayOf(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt;
}
const isoOf = dt => iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());

/** { from, to } (either may be null = open-ended) for a preset, relative to `today`. */
export function presetRange(key, today) {
  const [y, m, d] = today.split('-').map(Number);
  switch (key) {
    case 'this_week': {
      const mon = mondayOf(y, m, d);
      const sun = new Date(mon); sun.setUTCDate(sun.getUTCDate() + 6);
      return { from: isoOf(mon), to: isoOf(sun) };
    }
    case 'last_week': {
      const mon = mondayOf(y, m, d); mon.setUTCDate(mon.getUTCDate() - 7);
      const sun = new Date(mon); sun.setUTCDate(sun.getUTCDate() + 6);
      return { from: isoOf(mon), to: isoOf(sun) };
    }
    case 'this_quarter': {
      const qm = Math.floor((m - 1) / 3) * 3 + 1;
      const last = new Date(Date.UTC(y, qm + 2, 0)).getUTCDate();
      return { from: iso(y, qm, 1), to: iso(y, qm + 2, last) };
    }
    case 'this_month':
      return { from: iso(y, m, 1), to: today };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
      return { from: iso(py, pm, 1), to: iso(py, pm, last) };
    }
    case 'last_3_months': {
      const t = new Date(Date.UTC(y, m - 1 - 3, 1));
      const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      return { from: iso(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, lastDay)), to: today };
    }
    case 'this_year':
      return { from: iso(y, 1, 1), to: today };
    default:
      return { from: null, to: null };
  }
}

/** The preset whose range equals `range`, or 'custom'. */
export function matchPreset(range, today) {
  for (const p of PERIOD_PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === (range.from || null) && r.to === (range.to || null)) return p.key;
  }
  return 'custom';
}

export function describePeriod({ from, to } = {}) {
  if (from && to) return `${formatDay(from)} – ${formatDay(to)}`;
  if (from)       return `From ${formatDay(from)}`;
  if (to)         return `Up to ${formatDay(to)}`;
  return 'All time';
}

/** An error message for an unusable range, or '' when it is fine. */
export function validateRange({ from, to } = {}) {
  if (from && !isIsoDate(from)) return 'Enter a valid start date.';
  if (to && !isIsoDate(to))     return 'Enter a valid end date.';
  if (from && to && from > to)  return 'The start date must be on or before the end date.';
  return '';
}

// ── filtering ───────────────────────────────────────────────────────────────

/**
 * Orders for the Customer Orders report. Cancelled orders are excluded so the
 * totals agree with the receivables view; the period applies to the order date.
 */
export function filterOrders(orders, { customerId = null, from = null, to = null } = {}) {
  return (orders || []).filter(o => {
    if (o.status === CANCELLED_STATUS) return false;
    if (customerId && o.customer_id !== customerId) return false;
    if (from || to) {
      const day = localDateOf(o.created_at);
      if (!day) return false;
      if (from && day < from) return false;
      if (to && day > to) return false;
    }
    return true;
  });
}

export function filterReceivables(customers, { customerId = null } = {}) {
  return (customers || []).filter(c => !customerId || c.id === customerId);
}

// ── searchable customer picker ──────────────────────────────────────────────

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Customers matching `query` (name, contact, phone, email), best matches first. */
export function searchCustomers(customers, query, limit = 40) {
  const q = norm(query);
  const qDigits = q.replace(/\D/g, '');
  const scored = [];
  for (const c of customers || []) {
    const name = norm(c.name);
    let score;
    if (!q) score = 3;
    else if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (
      norm(c.contact_person).includes(q) || norm(c.email).includes(q) ||
      (qDigits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(qDigits))
    ) score = 2;
    else continue;
    scored.push({ c, score, name });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(x => x.c);
}

/** "Name · phone" so two customers with the same name can be told apart. */
export function customerOptionLabel(c) {
  return [c?.name, c?.phone].filter(Boolean).join(' · ');
}

// ── KPIs ────────────────────────────────────────────────────────────────────

export function orderBalance(order, paidMap) {
  return Math.max(0, num(order.total_value) - num(paidMap?.[order.id]));
}

/** days the order is past its due date with money still owing (0 when not late). */
export function daysLate(order, paidMap, today) {
  const due = order.due_date;
  if (!due || due >= today || orderBalance(order, paidMap) < SETTLED) return 0;
  const [dy, dm, dd] = due.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
}

export function orderKpis(orders, paidMap, today) {
  let value = 0, collected = 0, outstanding = 0, lateCount = 0, lateAmount = 0;
  for (const o of orders || []) {
    const bal = orderBalance(o, paidMap);
    value       += num(o.total_value);
    collected   += Math.min(num(paidMap?.[o.id]), num(o.total_value));
    outstanding += bal;
    if (daysLate(o, paidMap, today) > 0) { lateCount += 1; lateAmount += bal; }
  }
  return { count: (orders || []).length, value, collected, outstanding, lateCount, lateAmount };
}

export function receivableKpis(customers) {
  let sales = 0, outstanding = 0, overdue = 0, overdueCustomers = 0;
  for (const c of customers || []) {
    const s = c._stats || {};
    sales       += num(s.total_sales);
    outstanding += Math.max(0, num(s.outstanding));
    overdue     += num(s.overdue);
    if (num(s.overdue) >= SETTLED) overdueCustomers += 1;
  }
  return { count: (customers || []).length, sales, outstanding, overdue, overdueCustomers };
}
