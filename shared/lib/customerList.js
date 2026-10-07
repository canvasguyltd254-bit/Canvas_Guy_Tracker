/**
 * shared/lib/customerList.js
 *
 * Pure helpers behind the Customers list screen: duplicate detection, filter
 * chips, sorting, credit usage, ageing totals and the needs-attention queue.
 * No React, no I/O — everything takes the `customers` array returned by
 * GET /api/customers (each row carries `_stats`) and returns plain data.
 */

export const DORMANT_AFTER_DAYS = 90;
export const NEAR_LIMIT_RATIO   = 0.8;
const SETTLED = 0.5;                 // matches SETTLED_TOLERANCE in customerBalance.js

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const statsOf = c => c?._stats || {};

// ── identity normalisation ───────────────────────────────────────────────────

/** Last 9 digits of a Kenyan-style number, or null when too short to trust. */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

export function normalizeName(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return s || null;
}

// ── duplicates ───────────────────────────────────────────────────────────────

/**
 * Groups of customer records that are probably the same party: same phone
 * (last 9 digits) or same normalised name. Overlapping matches are merged into
 * one group. Read-only — nothing here changes data.
 *
 * @returns {{ ids: string[], names: string[], reason: 'phone'|'name'|'phone and name' }[]}
 */
export function findDuplicateGroups(customers) {
  const list   = (customers || []).filter(c => c && c.id != null);
  const parent = new Map(list.map(c => [c.id, c.id]));
  const find   = id => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const byPhone = new Map();
  const byName  = new Map();
  for (const c of list) {
    const p = normalizePhone(c.phone);
    const n = normalizeName(c.name);
    if (p) (byPhone.get(p) || byPhone.set(p, []).get(p)).push(c.id);
    if (n) (byName.get(n)  || byName.set(n,  []).get(n)).push(c.id);
  }
  const reasons = new Map();   // root-independent: record per id which keys matched
  const mark = (ids, kind) => {
    for (const id of ids) {
      const set = reasons.get(id) || new Set();
      set.add(kind);
      reasons.set(id, set);
    }
  };
  for (const ids of byPhone.values()) if (ids.length > 1) { ids.slice(1).forEach(i => union(ids[0], i)); mark(ids, 'phone'); }
  for (const ids of byName.values())  if (ids.length > 1) { ids.slice(1).forEach(i => union(ids[0], i)); mark(ids, 'name'); }

  const groups = new Map();
  for (const c of list) {
    if (!reasons.has(c.id)) continue;
    const root = find(c.id);
    const g = groups.get(root) || { ids: [], names: [], kinds: new Set() };
    g.ids.push(c.id);
    g.names.push(c.name);
    reasons.get(c.id).forEach(k => g.kinds.add(k));
    groups.set(root, g);
  }
  return [...groups.values()]
    .filter(g => g.ids.length > 1)
    .map(g => ({
      ids: g.ids,
      names: g.names,
      reason: g.kinds.has('phone') && g.kinds.has('name') ? 'phone and name' : g.kinds.has('phone') ? 'phone' : 'name',
    }));
}

/** Map of customer id → the duplicate group it belongs to. */
export function duplicateIndex(groups) {
  const m = new Map();
  for (const g of groups || []) for (const id of g.ids) m.set(id, g);
  return m;
}

// ── per-customer derived values ─────────────────────────────────────────────

function dayDiff(fromIso, toIso) {
  const [fy, fm, fd] = String(fromIso).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = String(toIso).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export const owes      = c => Math.max(0, num(statsOf(c).outstanding));
export const isOwing   = c => owes(c) >= SETTLED;
export const isOverdue = c => num(statsOf(c).overdue) >= SETTLED;

/**
 * Dormant = no order in the last 90 days. A customer who has never ordered is
 * dormant only once the record itself is older than 90 days, so a brand-new
 * contact is not flagged on day one.
 */
export function isDormant(c, today, days = DORMANT_AFTER_DAYS) {
  const last = statsOf(c).last_order_date;
  if (last) return dayDiff(last, today) > days;
  const created = c?.created_at ? String(c.created_at).slice(0, 10) : null;
  return created ? dayDiff(created, today) > days : false;
}

/** Share of the credit limit in use (0–∞), or null when no limit is set. */
export function creditUsed(c) {
  const limit = num(c?.credit_limit);
  if (limit <= 0) return null;
  return owes(c) / limit;
}

export const isNearLimit = c => {
  const u = creditUsed(c);
  return u !== null && u >= NEAR_LIMIT_RATIO;
};

// ── chips, search, sort ─────────────────────────────────────────────────────

export const CHIPS = ['all', 'owes', 'overdue', 'dormant'];

export function matchesChip(c, chip, today) {
  switch (chip) {
    case 'owes':    return isOwing(c);
    case 'overdue': return isOverdue(c);
    case 'dormant': return isDormant(c, today);
    default:        return true;
  }
}

export function chipCounts(customers, today) {
  const out = { all: 0, owes: 0, overdue: 0, dormant: 0 };
  for (const c of customers || []) {
    out.all += 1;
    if (isOwing(c))          out.owes += 1;
    if (isOverdue(c))        out.overdue += 1;
    if (isDormant(c, today)) out.dormant += 1;
  }
  return out;
}

export function matchesSearch(c, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [c.name, c.contact_person, c.phone, c.email].filter(Boolean).join(' ').toLowerCase();
  if (hay.includes(q)) return true;
  const qDigits = q.replace(/\D/g, '');
  return qDigits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(qDigits);
}

const TERMS_ORDER = { 'COD': 0, '7 Days': 1, '30 Days': 2, '60 Days': 3 };

const SORTERS = {
  name:     c => String(c.name || '').toLowerCase(),
  terms:    c => TERMS_ORDER[c.credit_terms] ?? 99,
  lifetime: c => num(statsOf(c).total_sales),
  owes:     c => owes(c),
  credit:   c => creditUsed(c),                 // null = no limit
  last:     c => statsOf(c).last_order_date || null,
};

export const SORT_KEYS = Object.keys(SORTERS);

/**
 * Stable sort. Rows whose sort value is null (no credit limit, never ordered)
 * always go last regardless of direction, so they never crowd the top.
 */
export function sortCustomers(customers, key = 'owes', dir = 'desc') {
  const get = SORTERS[key] || SORTERS.owes;
  const sign = dir === 'asc' ? 1 : -1;
  return (customers || [])
    .map((c, i) => ({ c, i, v: get(c) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined, bn = b.v === null || b.v === undefined;
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      if (a.v < b.v) return -1 * sign;
      if (a.v > b.v) return  1 * sign;
      return a.i - b.i;
    })
    .map(x => x.c);
}

// ── aggregates ──────────────────────────────────────────────────────────────

export function ageingTotals(customers) {
  const t = { notYetDue: 0, d1_30: 0, d31_60: 0, d60p: 0 };
  for (const c of customers || []) {
    const s = statsOf(c);
    t.notYetDue += num(s.not_yet_due);
    t.d1_30     += num(s.overdue_aging?.d1_30);
    t.d31_60    += num(s.overdue_aging?.d31_60);
    t.d60p      += num(s.overdue_aging?.d60p);
  }
  t.overdue = t.d1_30 + t.d31_60 + t.d60p;
  t.total   = t.notYetDue + t.overdue;
  return t;
}

export function summarise(customers, today) {
  const list = customers || [];
  let receivables = 0, overdue = 0, overdueCustomers = 0, openWork = 0, activeOrders = 0, dormant = 0;
  let top = null;
  for (const c of list) {
    const s = statsOf(c);
    const o = owes(c);
    receivables += o;
    overdue     += num(s.overdue);
    if (isOverdue(c)) overdueCustomers += 1;
    openWork    += num(s.active_work_value);
    activeOrders += num(s.active_orders);
    if (isDormant(c, today)) dormant += 1;
    if (o > 0 && (!top || o > top.amount)) top = { id: c.id, name: c.name, amount: o };
  }
  return {
    customers: list.length,
    active: list.length - dormant,
    dormant,
    receivables,
    overdue,
    overdueCustomers,
    openWork,
    activeOrders,
    topDebtor: top ? { ...top, share: receivables > 0 ? top.amount / receivables : 0 } : null,
  };
}

// ── needs attention ─────────────────────────────────────────────────────────

/**
 * One ranked queue: overdue customers (largest first), customers near or over
 * their credit limit, then suspected duplicates. Each item links to a customer.
 */
export function buildAttention(customers, groups = []) {
  const items = [];
  const list = customers || [];

  list.filter(isOverdue)
    .sort((a, b) => num(statsOf(b).overdue) - num(statsOf(a).overdue))
    .forEach(c => {
      const s = statsOf(c);
      items.push({
        key: `overdue-${c.id}`, kind: 'overdue', tone: 'red', customerId: c.id,
        title: c.name, amount: num(s.overdue), days: s.oldest_overdue_days || 0,
        chip: 'Overdue',
      });
    });

  list.filter(isNearLimit)
    .sort((a, b) => creditUsed(b) - creditUsed(a))
    .forEach(c => {
      const used = creditUsed(c);
      items.push({
        key: `limit-${c.id}`, kind: 'limit', tone: used >= 1 ? 'red' : 'amber', customerId: c.id,
        title: c.name, ratio: used, limit: num(c.credit_limit),
        chip: used >= 1 ? 'Over limit' : 'Near limit',
      });
    });

  for (const g of groups) {
    items.push({
      key: `dup-${g.ids.join('-')}`, kind: 'duplicate', tone: 'blue', customerId: g.ids[0],
      title: g.names.join(' / '), count: g.ids.length, reason: g.reason,
      chip: 'Possible duplicate',
    });
  }
  return items;
}
