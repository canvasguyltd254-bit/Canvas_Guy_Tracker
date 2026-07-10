"use client";
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@/shared/supabase/client";
import { useRouter } from "next/navigation";

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales", "sales"];
const VALID_TERMS = ["COD", "7 Days", "30 Days", "60 Days"];

const fmt  = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtN = (n) => Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = (d) => {
  if (!d) return "—";
  const dd = new Date(String(d).length <= 10 ? d + "T12:00:00" : d);
  return dd.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
};

const EMPTY_FORM = {
  name: "", contact_person: "", phone: "", email: "",
  address: "", kra_pin: "", credit_limit: "", credit_terms: "COD",
  opening_balance: "", opening_balance_date: "", notes: "",
};

const ss = {
  label:    { display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px" },
  input:    { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" },
  textarea: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa", resize: "vertical", minHeight: "70px", fontFamily: "inherit", boxSizing: "border-box" },
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

function TermsBadge({ terms }) {
  const colors = {
    "COD":     { bg: "#F3F4F6", text: "#374151", border: "#D1D5DB" },
    "7 Days":  { bg: "#DBEAFE", text: "#1E40AF", border: "#93C5FD" },
    "30 Days": { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D" },
    "60 Days": { bg: "#FEE2E2", text: "#991B1B", border: "#FCA5A5" },
  };
  const c = colors[terms] || colors["COD"];
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, color: c.text, background: c.bg, border: `1px solid ${c.border}`, padding: "2px 8px", borderRadius: "4px" }}>
      {terms}
    </span>
  );
}

function Avatar({ name, size = 38 }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#E8512A","#1a1a1a","#2563EB","#059669","#7C3AED","#DB2777"];
  const idx = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: colors[idx], display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: size * 0.38, fontWeight: 700, color: "#fff" }}>
      {initials}
    </div>
  );
}


// ── CUSTOMER REPORTS TAB ──────────────────────────────────────────────────────
function CustomerReportsTab({ customers }) {
  const [reportType, setReportType]       = useState("customer-receivables");
  const [orders, setOrders]               = useState([]);
  const [payTotals, setPayTotals]         = useState({});
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [customerFilter, setCustomerFilter] = useState("All");
  const [dateFrom, setDateFrom]           = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d; });
  const [dateTo, setDateTo]               = useState(new Date());
  const [exporting, setExporting]         = useState(false);
  const [exportError, setExportError]     = useState("");
  const [userName, setUserName]           = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserName(user.email || "");
    });
  }, []);

  useEffect(() => {
    if (reportType === "customer-orders") fetchOrders();
  }, [reportType]);

  const fetchOrders = async () => {
    setLoadingOrders(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("orders")
      .select("id, order_num, client, created_at, due_date, status, total_value, customer_id, customers(name), order_payments(amount)")
      .not("customer_id", "is", null)
      .order("created_at", { ascending: false });
    if (data) {
      const pt = {};
      const mapped = data.map(o => {
        const paid = (o.order_payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
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
        { label: "Orders",      value: filtered.length, color: "#1a1a1a" },
        { label: "Total Value", value: fmt(tv),         color: "#1a1a1a" },
        { label: "Collected",   value: fmt(tp),         color: "#065F46" },
        { label: "Outstanding", value: fmt(tb),         color: tb > 0 ? "#92400E" : "#065F46" },
      ];
    }
    const to  = filtered.reduce((s, c) => s + (c._stats?.outstanding || 0), 0);
    const tod = filtered.reduce((s, c) => s + (c._stats?.overdue || 0), 0);
    const ts  = filtered.reduce((s, c) => s + (c._stats?.total_sales || 0), 0);
    return [
      { label: "Customers",   value: filtered.length, color: "#1a1a1a" },
      { label: "Total Sales", value: fmt(ts),         color: "#1a1a1a" },
      { label: "Outstanding", value: fmt(to),         color: to > 0 ? "#92400E" : "#065F46" },
      { label: "Overdue",     value: fmt(tod),        color: tod > 0 ? "#C62828" : "#065F46" },
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
          userName,
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
          userName,
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

  const thS = { padding: "8px 10px", fontSize: "11px", fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" };
  const tdS = { padding: "9px 10px", fontSize: "13px" };
  const tdR = { padding: "9px 10px", fontSize: "13px", textAlign: "right", fontFamily: "'DM Mono', monospace" };

  const loading = isOrdersReport && loadingOrders;

  const totalsBar = (items) => (
    <div style={{ display: "flex", gap: "24px", padding: "12px 16px", background: "#1a1a1a", borderRadius: "0 0 12px 12px", flexWrap: "wrap" }}>
      {items.map(t => (
        <span key={t.label} style={{ fontSize: "12px", color: t.accent ? t.accent : "#E8512A" }}>
          {t.label ? <>{t.label}: <span style={{ color: "#fff", fontFamily: "monospace" }}>{t.value}</span></> : <span style={{ color: "#fff", fontWeight: 700 }}>{t.value}</span>}
        </span>
      ))}
    </div>
  );

  return (
    <div>
      {/* Report type selector */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
        {[
          { key: "customer-receivables", label: "Customer Receivables" },
          { key: "customer-orders",      label: "Customer Orders" },
        ].map(rt => (
          <button key={rt.key}
            onClick={() => { setReportType(rt.key); setCustomerFilter("All"); }}
            style={{ padding: "8px 16px", borderRadius: "8px", border: "1.5px solid", fontSize: "13px", fontWeight: 600, cursor: "pointer",
              borderColor: reportType === rt.key ? "#E8512A" : "#e0e0e0",
              background:  reportType === rt.key ? "#E8512A" : "#fff",
              color:       reportType === rt.key ? "#fff"    : "#555" }}>
            {rt.label}
          </button>
        ))}
      </div>

      {/* Filters + Export */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
        <select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: "7px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", fontFamily: "inherit" }}>
          {clientNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        {isOrdersReport && (
          <>
            <input type="date"
              value={dateFrom instanceof Date ? dateFrom.toISOString().split("T")[0] : ""}
              onChange={e => setDateFrom(e.target.value ? new Date(e.target.value) : null)}
              style={{ padding: "8px 10px", borderRadius: "7px", border: "1.5px solid #e0e0e0", fontSize: "13px" }} />
            <span style={{ color: "#aaa", fontSize: "13px" }}>to</span>
            <input type="date"
              value={dateTo instanceof Date ? dateTo.toISOString().split("T")[0] : ""}
              onChange={e => setDateTo(e.target.value ? new Date(e.target.value) : null)}
              style={{ padding: "8px 10px", borderRadius: "7px", border: "1.5px solid #e0e0e0", fontSize: "13px" }} />
          </>
        )}
        <button onClick={handleExport} disabled={exporting || filtered.length === 0 || loading}
          style={{ marginLeft: "auto", padding: "8px 18px", borderRadius: "7px", border: "none", fontSize: "13px", fontWeight: 700, cursor: "pointer",
            background: (exporting || filtered.length === 0 || loading) ? "#ccc" : "#1a1a1a", color: "#fff" }}>
          {exporting ? "Exporting…" : "Export PDF"}
        </button>
      </div>

      {exportError && (
        <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#FEE2E2", color: "#991B1B", borderRadius: "6px", fontSize: "12px" }}>
          {exportError}
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "16px" }}>
        {kpis.map(k => (
          <div key={k.label} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
            <div style={{ fontSize: "11px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>{k.label}</div>
            <div style={{ fontSize: "17px", fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ padding: "60px 20px", textAlign: "center", color: "#aaa" }}>Loading orders…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center", background: "#fff", borderRadius: "12px", border: "1px solid #e5e5e5" }}>
          <div style={{ fontSize: "32px", marginBottom: "10px" }}>📊</div>
          <div style={{ fontSize: "14px", color: "#999" }}>No data for this report.</div>
        </div>
      ) : isOrdersReport ? (
        <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e8e8e5", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f9f8f6", borderBottom: "2px solid #e8e8e5" }}>
                <th style={{ ...thS, textAlign: "left" }}>Customer</th>
                <th style={{ ...thS, textAlign: "left" }}>Order #</th>
                <th style={{ ...thS, textAlign: "left" }}>Date</th>
                <th style={{ ...thS, textAlign: "left" }}>Status</th>
                <th style={{ ...thS, textAlign: "right" }}>Value (KES)</th>
                <th style={{ ...thS, textAlign: "right" }}>Paid (KES)</th>
                <th style={{ ...thS, textAlign: "right" }}>Balance (KES)</th>
                <th style={{ ...thS, textAlign: "left" }}>Due Date</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, idx) => {
                const paid  = payTotals[o.id] || 0;
                const bal   = Math.max(parseFloat(o.total_value || 0) - paid, 0);
                const isOD  = o.due_date && o.due_date < new Date().toISOString().split("T")[0] && bal > 0;
                const sc    = STATUS_COLORS[o.status] || { bg: "#F3F4F6", text: "#6B7280" };
                return (
                  <tr key={o.id} style={{ background: idx % 2 === 0 ? "#fff" : "#FAFAF8", borderBottom: "1px solid #e8e8e5" }}>
                    <td style={{ ...tdS, fontWeight: 700 }}>{o.customer_name}</td>
                    <td style={{ ...tdS, fontFamily: "monospace", fontSize: "12px", color: "#E8512A" }}>{o.order_num}</td>
                    <td style={{ ...tdS, color: "#666", whiteSpace: "nowrap" }}>{fmtDate(o.created_at)}</td>
                    <td style={tdS}>
                      <span style={{ fontSize: "11px", fontWeight: 700, color: sc.text, background: sc.bg, padding: "2px 8px", borderRadius: "4px" }}>{o.status}</span>
                    </td>
                    <td style={tdR}>{fmtN(o.total_value)}</td>
                    <td style={{ ...tdR, color: "#065F46" }}>{fmtN(paid)}</td>
                    <td style={{ ...tdR, fontWeight: 700, color: bal > 0 ? "#92400E" : "#065F46" }}>{fmtN(bal)}</td>
                    <td style={{ ...tdS, color: isOD ? "#C62828" : "#666", fontWeight: isOD ? 700 : 400, whiteSpace: "nowrap" }}>
                      {o.due_date || "—"}{isOD && " ⚠"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {totalsBar([
            { value: `${filtered.length} Orders` },
            { label: "Total Value", value: `KSh ${fmtN(filtered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0))}` },
            { label: "Collected",   value: `KSh ${fmtN(filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0))}` },
            { label: "Outstanding", value: `KSh ${fmtN(Math.max(filtered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0) - filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0), 0))}` },
          ])}
        </div>
      ) : (
        <div style={{ background: "#fff", borderRadius: "12px", border: "1px solid #e8e8e5", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ background: "#f9f8f6", borderBottom: "2px solid #e8e8e5" }}>
                <th style={{ ...thS, textAlign: "left" }}>Customer</th>
                <th style={{ ...thS, textAlign: "left" }}>Terms</th>
                <th style={{ ...thS, textAlign: "right" }}>Total Sales</th>
                <th style={{ ...thS, textAlign: "right" }}>Outstanding</th>
                <th style={{ ...thS, textAlign: "right" }}>Overdue</th>
                <th style={{ ...thS, textAlign: "right" }}>Credit Limit</th>
                <th style={{ ...thS, textAlign: "right" }}>Avail. Credit</th>
                <th style={{ ...thS, textAlign: "center" }}>Orders</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, idx) => {
                const stats = c._stats || {};
                const ts    = stats.total_sales || 0;
                const out   = stats.outstanding  || 0;
                const ovd   = stats.overdue      || 0;
                const cl    = parseFloat(c.credit_limit || 0);
                const avail = Math.max(cl - out, 0);
                return (
                  <tr key={c.id} style={{ background: idx % 2 === 0 ? "#fff" : "#FAFAF8", borderBottom: "1px solid #e8e8e5" }}>
                    <td style={{ ...tdS, fontWeight: 700 }}>{c.name}</td>
                    <td style={tdS}><TermsBadge terms={c.credit_terms} /></td>
                    <td style={tdR}>{fmtN(ts)}</td>
                    <td style={{ ...tdR, fontWeight: 700, color: out > 0 ? "#92400E" : "#065F46" }}>{fmtN(out)}</td>
                    <td style={{ ...tdR, color: ovd > 0 ? "#C62828" : "#aaa" }}>{fmtN(ovd)}</td>
                    <td style={tdR}>{cl > 0 ? fmtN(cl) : "—"}</td>
                    <td style={{ ...tdR, color: cl > 0 ? (avail > 0 ? "#065F46" : "#C62828") : "#aaa" }}>{cl > 0 ? fmtN(avail) : "—"}</td>
                    <td style={{ ...tdS, textAlign: "center" }}>{stats.total_orders || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {totalsBar([
            { value: `${filtered.length} Customer${filtered.length !== 1 ? "s" : ""}` },
            { label: "Total Sales",  value: `KSh ${fmtN(filtered.reduce((s, c) => s + (c._stats?.total_sales || 0), 0))}` },
            { label: "Outstanding",  value: `KSh ${fmtN(filtered.reduce((s, c) => s + (c._stats?.outstanding || 0), 0))}` },
            { label: "Overdue",      value: `KSh ${fmtN(filtered.reduce((s, c) => s + (c._stats?.overdue || 0), 0))}` },
          ])}
        </div>
      )}
    </div>
  );
}


// ── MAIN MODULE ───────────────────────────────────────────────────────────────
export default function CustomersModule() {
  const router = useRouter();
  const [customers, setCustomers]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [userRole, setUserRole]       = useState("");
  const [view, setView]               = useState("list");   // "list" | "reports"
  const [search, setSearch]           = useState("");
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", user.id).single();
      setUserRole(profile?.role || "");
    });
    loadCustomers();
  }, []);

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

  const totalOutstanding = customers.reduce((s, c) => s + (c._stats?.outstanding || 0), 0);
  const totalOverdue     = customers.reduce((s, c) => s + (c._stats?.overdue || 0), 0);
  const overdueCount     = customers.filter(c => (c._stats?.overdue || 0) > 0).length;

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
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0 }}>Customers</h1>
          <p style={{ fontSize: "13px", color: "#999", margin: "4px 0 0" }}>Customer accounts and credit management</p>
        </div>
        {canWrite && view === "list" && (
          <button onClick={() => { setShowForm(true); setForm(EMPTY_FORM); setFormError(""); }}
            style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>
            + Add Customer
          </button>
        )}
      </div>

      {/* View toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: "20px", borderBottom: "2px solid #e8e8e5" }}>
        {[
          { key: "list",    label: `Customers (${customers.length})` },
          { key: "reports", label: "Reports" },
        ].map(v => (
          <button key={v.key} onClick={() => setView(v.key)} style={{
            padding: "10px 18px", fontSize: "13px", fontWeight: 600, border: "none", background: "none", cursor: "pointer",
            color: view === v.key ? "#1a1a1a" : "#999",
            borderBottom: view === v.key ? "2px solid #E8512A" : "2px solid transparent",
            marginBottom: "-2px", whiteSpace: "nowrap",
          }}>{v.label}</button>
        ))}
      </div>

      {/* Reports view */}
      {view === "reports" ? (
        <CustomerReportsTab customers={customers} />
      ) : (
        <>
          {/* Summary bar */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "20px" }}>
            {[
              { label: "Customers",         value: customers.length,     color: "#1a1a1a" },
              { label: "Total Outstanding", value: fmt(totalOutstanding), color: totalOutstanding > 0 ? "#92400E" : "#065F46" },
              { label: "Overdue",           value: fmt(totalOverdue),    color: totalOverdue > 0 ? "#C62828" : "#065F46" },
              { label: "With Overdue",      value: overdueCount,         color: overdueCount > 0 ? "#C62828" : "#065F46" },
            ].map(card => (
              <div key={card.label} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
                <div style={{ fontSize: "11px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>{card.label}</div>
                <div style={{ fontSize: "18px", fontWeight: 700, color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Search */}
          <input type="text" placeholder="Search customers…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", padding: "10px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "14px", background: "#fff", marginBottom: "14px", boxSizing: "border-box" }} />

          {/* List */}
          {loading ? (
            <div style={{ padding: "60px 20px", textAlign: "center", color: "#aaa" }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center" }}>
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>🤝</div>
              <div style={{ fontSize: "15px", color: "#999" }}>{search ? "No customers match your search." : "No customers yet."}</div>
              {canWrite && !search && (
                <button onClick={() => setShowForm(true)} style={{ marginTop: "12px", padding: "9px 20px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  Add first customer
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {filtered.map(c => {
                const stats       = c._stats || {};
                const outstanding = stats.outstanding || 0;
                const overdue     = stats.overdue     || 0;
                const creditAvail = Math.max(0, parseFloat(c.credit_limit || 0) - outstanding);

                return (
                  <div key={c.id}
                    onClick={() => router.push(`/customers/${c.id}`)}
                    style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5", borderLeft: overdue > 0 ? "4px solid #EF4444" : "4px solid transparent", padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: "14px", transition: "box-shadow 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)"}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>
                    <Avatar name={c.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{c.name}</span>
                        <TermsBadge terms={c.credit_terms} />
                        {overdue > 0 && (
                          <span style={{ fontSize: "11px", fontWeight: 700, color: "#991B1B", background: "#FEE2E2", border: "1px solid #FCA5A5", padding: "2px 7px", borderRadius: "4px" }}>
                            Overdue
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "12px", color: "#888", marginTop: "3px" }}>
                        {[c.contact_person, c.phone].filter(Boolean).join(" · ")}
                        {stats.total_orders > 0 && ` · ${stats.total_orders} order${stats.total_orders !== 1 ? "s" : ""}`}
                        {stats.last_order_date && ` · Last: ${stats.last_order_date}`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {outstanding > 0 ? (
                        <>
                          <div style={{ fontSize: "14px", fontWeight: 700, color: overdue > 0 ? "#C62828" : "#92400E" }}>{fmt(outstanding)}</div>
                          <div style={{ fontSize: "11px", color: "#aaa" }}>outstanding</div>
                        </>
                      ) : (
                        <>
                          <div style={{ fontSize: "13px", fontWeight: 600, color: "#065F46" }}>Nil</div>
                          <div style={{ fontSize: "11px", color: "#aaa" }}>outstanding</div>
                        </>
                      )}
                      {parseFloat(c.credit_limit || 0) > 0 && (
                        <div style={{ fontSize: "11px", color: "#999", marginTop: "2px" }}>
                          {fmt(creditAvail)} avail.
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

      {/* Add Customer Modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => setShowForm(false)}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "560px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "20px", margin: "0 0 20px" }}>Add Customer</h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Customer name *</label>
                <input style={ss.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Westgate Shopping Mall" />
              </div>
              <div>
                <label style={ss.label}>Contact person</label>
                <input style={ss.input} value={form.contact_person} onChange={e => setForm({ ...form, contact_person: e.target.value })} placeholder="e.g. Mary Njeru" />
              </div>
              <div>
                <label style={ss.label}>Phone</label>
                <input style={ss.input} type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="0712 XXX XXX" />
              </div>
              <div>
                <label style={ss.label}>Email</label>
                <input style={ss.input} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div>
                <label style={ss.label}>KRA PIN (optional)</label>
                <input style={ss.input} value={form.kra_pin} onChange={e => setForm({ ...form, kra_pin: e.target.value })} placeholder="A000000000X" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Address</label>
                <input style={ss.input} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="e.g. Westlands, Nairobi" />
              </div>
              <div>
                <label style={ss.label}>Credit limit (KSh)</label>
                <input style={ss.input} type="number" min="0" step="1000" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} placeholder="0" />
              </div>
              <div>
                <label style={ss.label}>Credit terms</label>
                <select style={ss.input} value={form.credit_terms} onChange={e => setForm({ ...form, credit_terms: e.target.value })}>
                  {VALID_TERMS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={ss.label}>Opening balance (KSh)</label>
                <input style={ss.input} type="number" min="0" step="1" value={form.opening_balance} onChange={e => setForm({ ...form, opening_balance: e.target.value })} placeholder="0" />
              </div>
              <div>
                <label style={ss.label}>Opening balance date</label>
                <input style={ss.input} type="date" value={form.opening_balance_date} onChange={e => setForm({ ...form, opening_balance_date: e.target.value })} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Notes</label>
                <textarea style={ss.textarea} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes…" />
              </div>
            </div>

            {formError && <div style={{ marginTop: "12px", padding: "8px 12px", background: "#FEE2E2", color: "#991B1B", borderRadius: "6px", fontSize: "12px" }}>{formError}</div>}

            <div style={{ display: "flex", gap: "8px", marginTop: "20px" }}>
              <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: "10px", borderRadius: "8px", border: "none", background: "#E8512A", color: "#fff", fontSize: "14px", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Add Customer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
