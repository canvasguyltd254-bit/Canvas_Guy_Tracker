"use client";
import { useMemo, useState } from "react";
import {
  C, Badge, Btn, Empty, Loading, Mono, Notice, Panel, PanelHead, StatCard, Toolbar, TInput, TSelect,
  fmtKes, fmtDate,
} from "@/shared/ui/ds";
import {
  CHIPS, findDuplicateGroups, duplicateIndex, buildAttention, ageingTotals, summarise, chipCounts,
  matchesChip, matchesSearch, sortCustomers, owes, isOwing, isOverdue, isDormant, creditUsed, NEAR_LIMIT_RATIO,
} from "@/shared/lib/customerList";

const TERMS_COLORS = { "COD": "gray", "7 Days": "blue", "30 Days": "amber", "60 Days": "red" };
const CHIP_LABELS  = { all: "All", owes: "Owes money", overdue: "Overdue", dormant: "Dormant" };
const SORT_LABELS  = {
  owes: "Amount owed", name: "Name", lifetime: "Lifetime value",
  credit: "Credit used", last: "Last order", terms: "Terms",
};
// Text sorts read best A→Z first; every numeric/date sort reads best biggest/latest first.
const DEFAULT_DIR  = { name: "asc", terms: "asc" };

const todayIso = () => new Date().toISOString().slice(0, 10);

function Avatar({ name, size = 34 }) {
  const initials = (name || "?").split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const colors = [C.coral, C.ink, C.blue, C.green, C.purple, "#DB2777"];
  const idx = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div aria-hidden="true" style={{
      width: size, height: size, borderRadius: "50%", background: colors[idx],
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, fontSize: size * 0.36, fontWeight: 700, color: "#fff",
    }}>
      {initials}
    </div>
  );
}

function CreditBar({ customer }) {
  const used = creditUsed(customer);
  if (used === null) return <span style={{ color: C.faint }}>No limit</span>;
  const pct   = Math.round(used * 100);
  const color = used >= 1 ? C.red : used >= NEAR_LIMIT_RATIO ? C.amber : C.green;
  return (
    <div title={`${pct}% of ${fmtKes(customer.credit_limit)} limit used`} style={{ minWidth: 110 }}>
      <div style={{ height: 6, background: C.sunken, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: 6, background: color, borderRadius: 3 }} />
      </div>
      <div style={{ fontSize: 10.5, color: used >= NEAR_LIMIT_RATIO ? color : C.muted, marginTop: 3, fontWeight: used >= NEAR_LIMIT_RATIO ? 700 : 400 }}>
        {pct}% used
      </div>
    </div>
  );
}

function OwesCell({ customer }) {
  const s = customer._stats || {};
  if (!isOwing(customer)) return <span style={{ color: C.green, fontWeight: 600 }}>Nil</span>;
  const overdue = isOverdue(customer);
  return (
    <div>
      <Mono style={{ fontWeight: 700, color: overdue ? C.red : C.amber }}>{fmtKes(owes(customer))}</Mono>
      {overdue && (
        <div style={{ fontSize: 10.5, color: C.red, marginTop: 2 }}>
          {s.oldest_overdue_days ? `${s.oldest_overdue_days} day${s.oldest_overdue_days === 1 ? "" : "s"} overdue` : "Overdue"}
        </div>
      )}
    </div>
  );
}

function attentionSubtitle(item) {
  if (item.kind === "overdue") {
    const days = item.days ? ` · oldest ${item.days} day${item.days === 1 ? "" : "s"}` : "";
    return `${fmtKes(item.amount)} overdue${days}`;
  }
  if (item.kind === "limit") return `${Math.round(item.ratio * 100)}% of ${fmtKes(item.limit)} limit used`;
  return `${item.count} records share the same ${item.reason}`;
}

const AGEING_ROWS = [
  { key: "notYetDue", label: "Not yet due", color: C.green },
  { key: "d1_30",     label: "1–30 days",   color: "#BA7517" },
  { key: "d31_60",    label: "31–60 days",  color: "#D85A30" },
  { key: "d60p",      label: "Over 60 days", color: C.red },
];

export default function CustomerListView({ customers, loading, loadError, onRetry, canWrite, onAdd, onOpen }) {
  const [chip, setChip]       = useState("all");
  const [search, setSearch]   = useState("");
  const [sort, setSort]       = useState({ key: "owes", dir: "desc" });
  const [showAll, setShowAll] = useState(false);

  const today = useMemo(todayIso, []);

  const groups   = useMemo(() => findDuplicateGroups(customers), [customers]);
  const dupIndex = useMemo(() => duplicateIndex(groups), [groups]);
  const summary  = useMemo(() => summarise(customers, today), [customers, today]);
  const ageing   = useMemo(() => ageingTotals(customers), [customers]);
  const counts   = useMemo(() => chipCounts(customers, today), [customers, today]);
  const attention = useMemo(() => buildAttention(customers, groups), [customers, groups]);

  const rows = useMemo(() => {
    const filtered = (customers || []).filter(c => matchesChip(c, chip, today) && matchesSearch(c, search));
    return sortCustomers(filtered, sort.key, sort.dir);
  }, [customers, chip, search, sort, today]);

  const changeSort = key =>
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: DEFAULT_DIR[key] || "desc" });

  const reviewDuplicate = item => {
    const g = groups.find(x => x.ids[0] === item.customerId);
    const first = (customers || []).find(c => c.id === item.customerId);
    setChip("all");
    setSearch((first && (first.phone || first.name)) || (g && g.names[0]) || "");
  };

  const visibleAttention = showAll ? attention : attention.slice(0, 5);
  const ageingMax = Math.max(ageing.total, 1);

  if (loading) return <Loading />;

  if (loadError) {
    return (
      <Notice color="red" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ flex: 1 }}>{loadError}</span>
        <Btn small onClick={onRetry}>Retry</Btn>
      </Notice>
    );
  }

  const top = summary.topDebtor;

  const sortHeader = (key, label, right) => {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        style={{
          textAlign: right ? "right" : "left", padding: 0,
          borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
        }}
      >
        <button
          type="button"
          onClick={() => changeSort(key)}
          style={{
            all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%",
            padding: "10px 14px", textAlign: right ? "right" : "left",
            color: active ? C.ink : C.muted, fontSize: 10.5, fontWeight: 700,
            textTransform: "uppercase", letterSpacing: ".04em", fontFamily: "inherit",
          }}
        >
          {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
        </button>
      </th>
    );
  };

  return (
    <>
      <style>{`
        .cg-kpis  { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
        .cg-split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 12px; margin-bottom: 16px; align-items: start; }
        .cg-cards, .cg-mobile-sort { display: none; }
        .cg-row:hover { background: ${C.bg}; }
        .cg-row:focus-visible { outline: 2px solid ${C.coral}; outline-offset: -2px; }
        .cg-att:hover { background: ${C.bg}; }
        @media (max-width: 1024px) {
          .cg-kpis  { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .cg-split { grid-template-columns: minmax(0, 1fr); }
        }
        @media (max-width: 720px) {
          .cg-table { display: none; }
          .cg-cards { display: block; }
          .cg-mobile-sort { display: block; }
          .cg-kpis  { gap: 8px; }
        }
      `}</style>

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <div className="cg-kpis">
        <StatCard
          label="Active customers"
          value={summary.active}
          sub={`of ${summary.customers} · ${summary.dormant} dormant`}
        />
        <StatCard
          label="Open work value"
          value={fmtKes(summary.openWork)}
          mono
          sub={`${summary.activeOrders} active order${summary.activeOrders === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Receivables"
          value={fmtKes(summary.receivables)}
          mono
          alert={summary.overdue > 0}
          sub={summary.overdue > 0
            ? `${fmtKes(summary.overdue)} overdue · ${summary.overdueCustomers} customer${summary.overdueCustomers === 1 ? "" : "s"}`
            : "Nothing overdue"}
        />
        <StatCard
          label="Largest debtor"
          value={
            <span title={top ? top.name : undefined} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {top ? top.name : "—"}
            </span>
          }
          sub={top ? `${Math.round(top.share * 100)}% of receivables · ${fmtKes(top.amount)}` : "No one owes anything"}
        />
      </div>

      {/* ── Attention + ageing ──────────────────────────────────────────── */}
      <div className="cg-split">
        <Panel style={{ marginBottom: 0 }}>
          <PanelHead
            title="Needs attention"
            sub="Overdue accounts, credit limits and possible duplicate records"
            actions={attention.length > 5 && (
              <Btn small onClick={() => setShowAll(v => !v)}>
                {showAll ? "Show fewer" : `View all ${attention.length}`}
              </Btn>
            )}
          />
          {visibleAttention.length === 0 ? (
            <Empty message="Nothing needs attention right now." style={{ padding: "28px 24px" }} />
          ) : visibleAttention.map(item => (
            <div
              key={item.key}
              className="cg-att"
              role="button"
              tabIndex={0}
              onClick={() => item.kind === "duplicate" ? reviewDuplicate(item) : onOpen(item.customerId)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  item.kind === "duplicate" ? reviewDuplicate(item) : onOpen(item.customerId);
                }
              }}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 18px",
                borderTop: `1px solid ${C.line}`, cursor: "pointer",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{attentionSubtitle(item)}</div>
              </div>
              <Badge color={item.tone} style={{ flexShrink: 0 }}>{item.chip}</Badge>
            </div>
          ))}
        </Panel>

        <Panel style={{ marginBottom: 0 }}>
          <PanelHead title="Receivables ageing" sub="Unpaid balance by days past due" />
          {ageing.total <= 0 ? (
            <Empty message="No receivables outstanding." style={{ padding: "28px 24px" }} />
          ) : (
            <div style={{ padding: "14px 18px 16px" }}>
              {AGEING_ROWS.map(r => {
                const value = ageing[r.key] || 0;
                return (
                  <div key={r.key} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ color: C.ink }}>{r.label}</span>
                      <Mono style={{ color: value > 0 ? C.ink : C.faint }}>{fmtKes(value)}</Mono>
                    </div>
                    <div style={{ height: 6, background: C.sunken, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(value / ageingMax) * 100}%`, height: 6, background: r.color, borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
              <div style={{
                display: "flex", justifyContent: "space-between", paddingTop: 10,
                borderTop: `1px solid ${C.line}`, fontSize: 12.5, fontWeight: 700,
              }}>
                <span>Total</span><Mono>{fmtKes(ageing.total)}</Mono>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* ── Customers table ─────────────────────────────────────────────── */}
      <Panel>
        <Toolbar>
          <TInput
            type="search"
            aria-label="Search customers"
            placeholder="Search name, contact, phone or email"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ flex: "1 1 220px", minWidth: 0, width: "auto" }}
          />
          <div role="group" aria-label="Filter customers" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {CHIPS.map(k => {
              const on = chip === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setChip(k)}
                  style={{
                    border: `1px solid ${on ? C.ink : C.line}`,
                    background: on ? C.ink : C.card,
                    color: on ? "#fff" : C.ink,
                    borderRadius: 20, padding: "6px 12px", minHeight: 34,
                    fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  {CHIP_LABELS[k]} <span style={{ opacity: on ? 0.8 : 0.6, fontWeight: 600 }}>{counts[k]}</span>
                </button>
              );
            })}
          </div>
          <div className="cg-mobile-sort" style={{ width: "100%" }}>
            <TSelect
              aria-label="Sort customers"
              value={sort.key}
              onChange={e => setSort({ key: e.target.value, dir: DEFAULT_DIR[e.target.value] || "desc" })}
            >
              {Object.entries(SORT_LABELS).map(([k, label]) => <option key={k} value={k}>Sort: {label}</option>)}
            </TSelect>
          </div>
        </Toolbar>

        {rows.length === 0 ? (
          <Empty
            message={
              (customers || []).length === 0 ? "No customers yet."
                : search ? "No customers match your search."
                : "No customers in this view."
            }
            action={canWrite && (customers || []).length === 0 && <Btn onClick={onAdd}>Add first customer</Btn>}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="cg-table" style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {sortHeader("name", "Customer")}
                    {sortHeader("terms", "Terms")}
                    {sortHeader("lifetime", "Lifetime value", true)}
                    {sortHeader("owes", "Owes", true)}
                    {sortHeader("credit", "Credit used")}
                    {sortHeader("last", "Last order")}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(c => {
                    const s = c._stats || {};
                    const dup = dupIndex.get(c.id);
                    const overdue = isOverdue(c);
                    return (
                      <tr
                        key={c.id}
                        className="cg-row"
                        tabIndex={0}
                        onClick={() => onOpen(c.id)}
                        onKeyDown={e => { if (e.key === "Enter") onOpen(c.id); }}
                        style={{ cursor: "pointer" }}
                      >
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, boxShadow: overdue ? `inset 3px 0 0 ${C.red}` : "none", minWidth: 220 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Avatar name={c.name} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.ink }}>{c.name}</span>
                                {dup && <Badge color="blue" style={{ fontSize: 9.5 }}>Possible duplicate</Badge>}
                              </div>
                              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>
                                {[c.contact_person, c.phone].filter(Boolean).join(" · ") || "No contact details"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}` }}>
                          <Badge color={TERMS_COLORS[c.credit_terms] || "gray"}>{c.credit_terms}</Badge>
                        </td>
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontSize: 12.5 }}>
                          {s.total_sales > 0 ? <Mono>{fmtKes(s.total_sales)}</Mono> : <span style={{ color: C.faint }}>—</span>}
                          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>
                            {s.total_orders || 0} order{s.total_orders === 1 ? "" : "s"}
                          </div>
                        </td>
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontSize: 12.5 }}>
                          <OwesCell customer={c} />
                        </td>
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 12.5 }}>
                          <CreditBar customer={c} />
                        </td>
                        <td style={{ padding: "11px 14px", borderBottom: `1px solid ${C.line}`, fontSize: 12.5, color: C.muted, whiteSpace: "nowrap" }}>
                          {s.last_order_date ? fmtDate(s.last_order_date) : "No orders"}
                          {isDormant(c, today) && <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2 }}>Dormant</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="cg-cards">
              {rows.map(c => {
                const s = c._stats || {};
                const dup = dupIndex.get(c.id);
                const overdue = isOverdue(c);
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(c.id)}
                    onKeyDown={e => { if (e.key === "Enter") onOpen(c.id); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "13px 14px",
                      borderTop: `1px solid ${C.line}`, cursor: "pointer",
                      borderLeft: overdue ? `3px solid ${C.red}` : "3px solid transparent",
                    }}
                  >
                    <Avatar name={c.name} size={38} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{c.name}</span>
                        <Badge color={TERMS_COLORS[c.credit_terms] || "gray"}>{c.credit_terms}</Badge>
                        {dup && <Badge color="blue">Possible duplicate</Badge>}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                        {[c.contact_person, c.phone].filter(Boolean).join(" · ")}
                        {s.total_orders > 0 && ` · ${s.total_orders} order${s.total_orders === 1 ? "" : "s"}`}
                      </div>
                      {creditUsed(c) !== null && <div style={{ marginTop: 6, maxWidth: 180 }}><CreditBar customer={c} /></div>}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <OwesCell customer={c} />
                      <div style={{ fontSize: 10.5, color: C.faint, marginTop: 2 }}>owes</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ padding: "10px 18px", fontSize: 12, color: C.muted, borderTop: `1px solid ${C.line}` }}>
              Showing {rows.length} of {(customers || []).length} customers
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
