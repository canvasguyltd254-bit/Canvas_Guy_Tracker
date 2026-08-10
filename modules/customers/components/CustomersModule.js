"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/shared/supabase/client";
import { useRouter } from "next/navigation";
import { useAuth } from "@/shared/context/AuthContext";
import {
  C, Btn, Badge, Modal, PageHeader, StatCard, TabBar,
  Table, Th, Td, Field, TInput, TSelect, TArea,
  Notice, Empty, Loading, Mono, fmtKes, fmtDate,
} from "@/shared/ui/ds";

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales", "sales"];
const VALID_TERMS = ["COD", "7 Days", "30 Days", "60 Days"];

const fmtN = (n) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const EMPTY_FORM = {
  name: "", contact_person: "", phone: "", email: "",
  address: "", kra_pin: "", credit_limit: "", credit_terms: "COD",
  opening_balance: "", opening_balance_date: "", notes: "",
};

const STATUS_COLORS = {
  "Inquiry":            { bg: "#F3F4F6", text: "#6B7280" },
  "Quoted":             { bg: "#EFF6FF", text: "#1D4ED8" },
  "Quote Approved":     { bg: "#DBEAFE", text: "#1E40AF" },
  "Deposit Paid":       { bg: "#FEF9C3", text: "#854D0E" },
  "In Production":      { bg: "#FFF7ED", text: "#C2410C" },
  "Quality Check":      { bg: "#FAF5FF", text: "#7E22CE" },
  "Ready for Delivery": { bg: "#F0FDF4", text: "#15803D" },
  "Out for Delivery":   { bg: "#ECFDF5", text: "#065F46" },
  "Delivered":          { bg: "#D1FAE5", text: "#065F46" },
  "Closed":             { bg: "#F3F4F6", text: "#374151" },
  "Cancelled":          { bg: "#FEE2E2", text: "#991B1B" },
};

const TERMS_COLORS = {
  "COD":     "gray",
  "7 Days":  "blue",
  "30 Days": "amber",
  "60 Days": "red",
};

function TermsBadge({ terms }) {
  return <Badge color={TERMS_COLORS[terms] || "gray"}>{terms}</Badge>;
}

function Avatar({ name, size = 38 }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = [C.coral, C.ink, C.blue, C.green, C.purple, "#DB2777"];
  const idx = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: colors[idx],
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, fontSize: size * 0.38, fontWeight: 700, color: "#fff",
    }}>
      {initials}
    </div>
  );
}


// ── CUSTOMER REPORTS TAB ──────────────────────────────────────────────────────
function CustomerReportsTab({ customers }) {
  const { displayName }                   = useAuth();
  const [reportType, setReportType]       = useState("customer-receivables");
  const [orders, setOrders]               = useState([]);
  const [payTotals, setPayTotals]         = useState({});
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("All");
  const [dateFrom, setDateFrom]           = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d; });
  const [dateTo, setDateTo]               = useState(new Date());
  const [exporting, setExporting]         = useState(false);
  const [exportError, setExportError]     = useState("");

  useEffect(() => {
    if (reportType === "customer-orders") fetchOrders();
  }, [reportType]);

  const fetchOrders = async () => {
    setLoadingOrders(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("orders")
      .select("id, order_num, client, created_at, due_date, status, total_value, customer_id, customers(name), order_payments(amount, reversed_at)")
      .not("customer_id", "is", null)
      .order("created_at", { ascending: false });
    if (data) {
      const pt = {};
      const mapped = data.map(o => {
        // Reversed payments no longer count as paid — the reversal journal
        // already backs the receipt out in the GL.
        const paid = (o.order_payments || []).filter(p => !p.reversed_at).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        pt[o.id] = paid;
        return { ...o, customer_name: o.customers?.name || o.client };
      });
      setPayTotals(pt);
      setOrders(mapped);
    }
    setLoadingOrders(false);
  };

  const isOrdersReport = reportType === "customer-orders";

  const filtered = useMemo(() => {
    if (isOrdersReport) {
      return orders.filter(o => {
        if (customerFilter !== "All" && o.customer_name !== customerFilter) return false;
        if (dateFrom && o.created_at < dateFrom.toISOString()) return false;
        if (dateTo) {
          const end = new Date(dateTo); end.setDate(end.getDate() + 1);
          if (o.created_at >= end.toISOString()) return false;
        }
        return true;
      });
    }
    if (customerFilter !== "All") return customers.filter(c => c.name === customerFilter);
    return customers;
  }, [isOrdersReport, customers, orders, customerFilter, dateFrom, dateTo]);

  const clientNames = useMemo(() => {
    const names = isOrdersReport
      ? [...new Set(orders.map(o => o.customer_name))]
      : customers.map(c => c.name);
    return ["All", ...names.sort()];
  }, [isOrdersReport, customers, orders]);

  const kpis = useMemo(() => {
    if (isOrdersReport) {
      const tv = filtered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
      const tp = filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
      const tb = Math.max(tv - tp, 0);
      return [
        { label: "Orders",      value: filtered.length,     sub: "in range" },
        { label: "Total Value", value: fmtKes(tv), mono: true },
        { label: "Collected",   value: fmtKes(tp), mono: true },
        { label: "Outstanding", value: fmtKes(tb), mono: true, alert: tb > 0 },
      ];
    }
    const to  = filtered.reduce((s, c) => s + (c._stats?.outstanding || 0), 0);
    const tod = filtered.reduce((s, c) => s + (c._stats?.overdue || 0), 0);
    const ts  = filtered.reduce((s, c) => s + (c._stats?.total_sales || 0), 0);
    return [
      { label: "Customers",   value: filtered.length },
      { label: "Total Sales", value: fmtKes(ts),  mono: true },
      { label: "Outstanding", value: fmtKes(to),  mono: true, alert: to > 0 },
      { label: "Overdue",     value: fmtKes(tod), mono: true, alert: tod > 0 },
    ];
  }, [filtered, payTotals, isOrdersReport]);

  const handleExport = async () => {
    setExporting(true); setExportError("");
    try {
      let body;
      if (isOrdersReport) {
        body = {
          reportLabel: "Customer Orders",
          customerOrders: filtered.map(o => ({
            customer_name: o.customer_name,
            order_num:     o.order_num,
            created_at:    o.created_at,
            due_date:      o.due_date,
            status:        o.status,
            total_value:   o.total_value,
            amount_paid:   payTotals[o.id] || 0,
          })),
          dateFrom: dateFrom ? dateFrom.toISOString() : null,
          dateTo:   dateTo   ? dateTo.toISOString()   : null,
          userName: displayName,
        };
      } else {
        body = {
          reportLabel: "Customer Receivables",
          customerReceivables: filtered.map(c => ({
            name:         c.name,
            credit_terms: c.credit_terms,
            total_sales:  c._stats?.total_sales || 0,
            outstanding:  c._stats?.outstanding || 0,
            overdue:      c._stats?.overdue || 0,
            credit_limit: parseFloat(c.credit_limit || 0),
            total_orders: c._stats?.total_orders || 0,
          })),
          userName: displayName,
        };
      }

      const res = await fetch("/api/reports/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || err.error || "Export failed");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${isOrdersReport ? "Customer_Orders" : "Customer_Receivables"}_${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(`PDF error: ${err.message}`);
    }
    setExporting(false);
  };

  const loading = isOrdersReport && loadingOrders;

  const totalsBar = (items) => (
    <div style={{ display: "flex", gap: 24, padding: "12px 16px", background: C.ink, borderRadius: "0 0 12px 12px", flexWrap: "wrap" }}>
      {items.map(t => (
        <span key={t.label} style={{ fontSize: 12, color: C.coral }}>
          {t.label
            ? <>{t.label}: <span style={{ color: "#fff", fontFamily: C.mono }}>{t.value}</span></>
            : <span style={{ color: "#fff", fontWeight: 700 }}>{t.value}</span>}
        </span>
      ))}
    </div>
  );

  return (
    <div>
      {/* Report type selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { key: "customer-receivables", label: "Customer Receivables" },
          { key: "customer-orders",      label: "Customer Orders" },
        ].map(rt => (
          <button key={rt.key}
            onClick={() => { setReportType(rt.key); setCustomerFilter("All"); }}
            style={{
              padding: "8px 16px", borderRadius: C.radiusSm,
              border: `1.5px solid ${reportType === rt.key ? C.coral : C.line}`,
              background: reportType === rt.key ? C.coral : C.card,
              color:      reportType === rt.key ? "#fff"  : C.muted,
              fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
            }}>
            {rt.label}
          </button>
        ))}
      </div>

      {/* Filters + Export */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <TSelect value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} style={{ minWidth: 160 }}>
          {clientNames.map(n => <option key={n} value={n}>{n}</option>)}
        </TSelect>
        {isOrdersReport && (
          <>
            <TInput type="date"
              value={dateFrom instanceof Date ? dateFrom.toISOString().split("T")[0] : ""}
              onChange={e => setDateFrom(e.target.value ? new Date(e.target.value) : null)}
              style={{ width: "auto" }} />
            <span style={{ color: C.faint, fontSize: 13 }}>to</span>
            <TInput type="date"
              value={dateTo instanceof Date ? dateTo.toISOString().split("T")[0] : ""}
              onChange={e => setDateTo(e.target.value ? new Date(e.target.value) : null)}
              style={{ width: "auto" }} />
          </>
        )}
        <Btn primary onClick={handleExport} disabled={exporting || filtered.length === 0 || loading}
          style={{ marginLeft: "auto" }}>
          {exporting ? "Exporting…" : "Export PDF"}
        </Btn>
      </div>

      {exportError && <Notice color="red" style={{ marginBottom: 12 }}>{exportError}</Notice>}

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        {kpis.map(k => (
          <StatCard key={k.label} label={k.label} value={k.value} sub={k.sub} mono={k.mono} alert={k.alert} />
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <Empty message="No data for this report." />
      ) : isOrdersReport ? (
        <div style={{ background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Order #</Th>
                <Th>Date</Th>
                <Th>Status</Th>
                <Th right>Value (KES)</Th>
                <Th right>Paid (KES)</Th>
                <Th right>Balance (KES)</Th>
                <Th>Due Date</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const paid  = payTotals[o.id] || 0;
                const bal   = Math.max(parseFloat(o.total_value || 0) - paid, 0);
                const isOD  = o.due_date && o.due_date < new Date().toISOString().split("T")[0] && bal > 0;
                const sc    = STATUS_COLORS[o.status] || { bg: "#F3F4F6", text: "#6B7280" };
                return (
                  <tr key={o.id}>
                    <Td style={{ fontWeight: 700 }}>{o.customer_name}</Td>
                    <Td><Mono style={{ color: C.coral, fontSize: 12 }}>{o.order_num}</Mono></Td>
                    <Td mono muted>{fmtDate(o.created_at)}</Td>
                    <Td>
                      <span style={{ fontSize: 11, fontWeight: 700, color: sc.text, background: sc.bg, padding: "2px 8px", borderRadius: 4 }}>{o.status}</span>
                    </Td>
                    <Td right mono>{fmtN(o.total_value)}</Td>
                    <Td right mono style={{ color: C.green }}>{fmtN(paid)}</Td>
                    <Td right mono style={{ fontWeight: 700, color: bal > 0 ? C.amber : C.green }}>{fmtN(bal)}</Td>
                    <Td mono style={{ color: isOD ? C.red : C.muted, fontWeight: isOD ? 700 : 400 }}>
                      {o.due_date || "—"}{isOD && " ⚠"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {totalsBar([
            { value: `${filtered.length} Orders` },
            { label: "Total Value", value: `KES ${fmtN(filtered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0))}` },
            { label: "Collected",   value: `KES ${fmtN(filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0))}` },
            { label: "Outstanding", value: `KES ${fmtN(Math.max(filtered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0) - filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0), 0))}` },
          ])}
        </div>
      ) : (
        <div style={{ background: C.card, borderRadius: C.radius, border: `1px solid ${C.line}` }}>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Terms</Th>
                <Th right>Total Sales</Th>
                <Th right>Outstanding</Th>
                <Th right>Overdue</Th>
                <Th right>Credit Limit</Th>
                <Th right>Avail. Credit</Th>
                <Th>Orders</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const stats = c._stats || {};
                const ts    = stats.total_sales || 0;
                const out   = stats.outstanding  || 0;
                const ovd   = stats.overdue      || 0;
                const cl    = parseFloat(c.credit_limit || 0);
                const avail = Math.max(cl - out, 0);
                return (
                  <tr key={c.id}>
                    <Td style={{ fontWeight: 700 }}>{c.name}</Td>
                    <Td><TermsBadge terms={c.credit_terms} /></Td>
                    <Td right mono>{fmtN(ts)}</Td>
                    <Td right mono style={{ fontWeight: 700, color: out > 0 ? C.amber : C.green }}>{fmtN(out)}</Td>
                    <Td right mono style={{ color: ovd > 0 ? C.red : C.faint }}>{fmtN(ovd)}</Td>
                    <Td right mono muted>{cl > 0 ? fmtN(cl) : "—"}</Td>
                    <Td right mono style={{ color: cl > 0 ? (avail > 0 ? C.green : C.red) : C.faint }}>{cl > 0 ? fmtN(avail) : "—"}</Td>
                    <Td muted>{stats.total_orders || 0}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {totalsBar([
            { value: `${filtered.length} Customer${filtered.length !== 1 ? "s" : ""}` },
            { label: "Total Sales",  value: `KES ${fmtN(filtered.reduce((s, c) => s + (c._stats?.total_sales || 0), 0))}` },
            { label: "Outstanding",  value: `KES ${fmtN(filtered.reduce((s, c) => s + (c._stats?.outstanding || 0), 0))}` },
            { label: "Overdue",      value: `KES ${fmtN(filtered.reduce((s, c) => s + (c._stats?.overdue || 0), 0))}` },
          ])}
        </div>
      )}
    </div>
  );
}


// ── MAIN MODULE ───────────────────────────────────────────────────────────────
export default function CustomersModule({ defaultAction, defaultProspectName, defaultPhone, actionNonce, refreshKey = 0 } = {}) {
  const router = useRouter();
  const { userRole = '', loaded: authLoaded } = useAuth();
  const [customers, setCustomers]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [view, setView]               = useState("list");   // "list" | "reports"
  const [search, setSearch]           = useState("");
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState("");

  useEffect(() => {
    if (!authLoaded) return;
    loadCustomers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, refreshKey]);

  // Open new-customer form triggered by ?new=customer query param
  useEffect(() => {
    if (defaultAction === 'customer' && authLoaded && WRITE_ROLES.includes(userRole)) {
      setForm({ ...EMPTY_FORM, name: defaultProspectName || '', phone: defaultPhone || '' });
      setFormError('');
      setShowForm(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAction, actionNonce, authLoaded, userRole]);

  const loadCustomers = async () => {
    setLoading(true);
    const res  = await fetch("/api/customers");
    const json = await res.json();
    setCustomers(json.data || []);
    setLoading(false);
  };

  const canWrite = WRITE_ROLES.includes(userRole);

  const filtered = useMemo(() => {
    if (!search) return customers;
    const q = search.toLowerCase();
    return customers.filter(c =>
      [c.name, c.contact_person, c.phone, c.email].filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [customers, search]);

  const totalWorkValue   = customers.reduce((s, c) => s + (c._stats?.active_work_value || 0), 0);
  const totalOutstanding = customers.reduce((s, c) => s + (c._stats?.outstanding || 0), 0);
  const totalOverdue     = customers.reduce((s, c) => s + (c._stats?.overdue || 0), 0);

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("Customer name is required."); return; }
    setSaving(true); setFormError("");
    try {
      const res  = await fetch("/api/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to create customer");
      setShowForm(false);
      setForm(EMPTY_FORM);
      await loadCustomers();
    } catch (err) {
      setFormError(err.message);
    }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>

      <PageHeader
        title="Customers"
        description="Customer accounts and credit management"
        actions={canWrite && view === "list" && (
          <Btn primary onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError(""); }}>
            + Add Customer
          </Btn>
        )}
      />

      <TabBar
        tabs={[
          { key: "list",    label: `Customers (${customers.length})` },
          { key: "reports", label: "Reports" },
        ]}
        active={view}
        onSelect={setView}
      />

      {/* Reports view */}
      {view === "reports" ? (
        <CustomerReportsTab customers={customers} />
      ) : (
        <>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 20 }}>
            <StatCard label="Customers"        value={customers.length} />
            <StatCard label="Total Work Value" value={fmtKes(totalWorkValue)}   mono />
            <StatCard label="Outstanding"      value={fmtKes(totalOutstanding)} mono alert={totalOutstanding > 0} />
            <StatCard label="Overdue"          value={fmtKes(totalOverdue)}     mono alert={totalOverdue > 0} />
          </div>

          {/* Search */}
          <TInput
            type="text" placeholder="Search customers…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ marginBottom: 14 }}
          />

          {/* List */}
          {loading ? (
            <Loading />
          ) : filtered.length === 0 ? (
            <Empty
              message={search ? "No customers match your search." : "No customers yet."}
              action={canWrite && !search && (
                <Btn onClick={() => setShowForm(true)}>Add first customer</Btn>
              )}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map(c => {
                const stats       = c._stats || {};
                const outstanding = stats.outstanding || 0;
                const overdue     = stats.overdue     || 0;
                const creditAvail = Math.max(0, parseFloat(c.credit_limit || 0) - outstanding);

                return (
                  <div key={c.id}
                    onClick={() => router.push(`/customers/${c.id}`)}
                    style={{
                      background: C.card, borderRadius: C.radius,
                      border: `1px solid ${C.line}`,
                      borderLeft: overdue > 0 ? `4px solid ${C.red}` : `4px solid transparent`,
                      padding: "14px 16px", cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 14,
                      transition: "box-shadow 0.15s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
                    <Avatar name={c.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{c.name}</span>
                        <TermsBadge terms={c.credit_terms} />
                        {overdue > 0 && <Badge color="red">Overdue</Badge>}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                        {[c.contact_person, c.phone].filter(Boolean).join(" · ")}
                        {stats.total_orders > 0 && ` · ${stats.total_orders} order${stats.total_orders !== 1 ? "s" : ""}`}
                        {stats.last_order_date && ` · Last: ${stats.last_order_date}`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {outstanding > 0 ? (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 700, color: overdue > 0 ? C.red : C.amber, fontFamily: C.mono }}>
                            {fmtKes(outstanding)}
                          </div>
                          <div style={{ fontSize: 11, color: C.faint }}>outstanding</div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: 13, fontWeight: 600, color: C.green }}>Nil</div>
                          <div style={{ fontSize: 11, color: C.faint }}>outstanding</div>
                        </>
                      )}
                      {parseFloat(c.credit_limit || 0) > 0 && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>
                          <Mono>{fmtKes(creditAvail)}</Mono> avail.
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Add Customer Modal — Modal auto-dispatches quickactions:lock/unlock */}
      {showForm && (
        <Modal
          title="Add Customer"
          onClose={() => setShowForm(false)}
          footer={
            <>
              <Btn onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn primary onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Add Customer"}
              </Btn>
            </>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="form-grid">
            <Field label="Customer name *" full>
              <TInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Westgate Shopping Mall" />
            </Field>
            <Field label="Contact person">
              <TInput value={form.contact_person} onChange={e => setForm({ ...form, contact_person: e.target.value })} placeholder="e.g. Mary Njeru" />
            </Field>
            <Field label="Phone">
              <TInput type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0712 XXX XXX" />
            </Field>
            <Field label="Email">
              <TInput type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
            </Field>
            <Field label="KRA PIN (optional)">
              <TInput value={form.kra_pin} onChange={e => setForm({ ...form, kra_pin: e.target.value })} placeholder="A000000000X" />
            </Field>
            <Field label="Address" full>
              <TInput value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="e.g. Westlands, Nairobi" />
            </Field>
            <Field label="Credit limit (KSh)">
              <TInput type="number" min="0" step="1000" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Credit terms">
              <TSelect value={form.credit_terms} onChange={e => setForm({ ...form, credit_terms: e.target.value })}>
                {VALID_TERMS.map(t => <option key={t} value={t}>{t}</option>)}
              </TSelect>
            </Field>
            <Field label="Opening balance (KSh)">
              <TInput type="number" min="0" step="1" value={form.opening_balance} onChange={e => setForm({ ...form, opening_balance: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Opening balance date">
              <TInput type="date" value={form.opening_balance_date} onChange={e => setForm({ ...form, opening_balance_date: e.target.value })} />
            </Field>
            <Field label="Notes" full>
              <TArea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes…" />
            </Field>
          </div>

          {formError && <Notice color="red" style={{ marginTop: 14 }}>{formError}</Notice>}
        </Modal>
      )}
    </div>
  );
}
