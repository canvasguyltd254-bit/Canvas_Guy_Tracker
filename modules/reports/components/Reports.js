"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/shared/supabase/client";
import { ALL_STATUS_COLORS, CATEGORIES } from "@/modules/orders/components/constants";
import { generateReportPDF } from "@/shared/pdf/generateReport";

// ── Report type definitions ──
const REPORT_TYPES = [
  { id: "overdue",     label: "Overdue",            icon: "🔴", dateField: null },
  { id: "due-week",    label: "Due Orders",          icon: "📅", dateField: "due_date" },
  { id: "production",  label: "In Production",       icon: "🔨", dateField: null },
  { id: "ready",       label: "Ready for Delivery",  icon: "✅", dateField: null },
  { id: "receivables", label: "Receivables",         icon: "💰", dateField: null },
  { id: "collections", label: "Collections Due",     icon: "📋", dateField: "due_date" },
  { id: "sales-week",  label: "Sales by Period",     icon: "📈", dateField: "created_at" },
  { id: "completed",   label: "Completed",           icon: "🏁", dateField: "created_at" },
  { id: "workload",    label: "Workload",             icon: "⚙️", dateField: null },
];

const PROD_STATUSES = ["Material Check", "Production", "Quality Control", "Ready for Delivery"];
const FINANCIAL_REPORTS = ["receivables", "collections"];
const DATE_RANGE_REPORTS = ["due-week", "sales-week", "collections", "completed"];
const SUMMARY_KPI_REPORTS = ["receivables", "collections", "sales-week", "completed"];

const DATE_PRESETS = [
  { id: "this-week",    label: "This week" },
  { id: "last-week",    label: "Last week" },
  { id: "this-month",   label: "This month" },
  { id: "last-month",   label: "Last month" },
  { id: "this-quarter", label: "This quarter" },
  { id: "custom",       label: "Custom" },
];

// ── Date preset calculator ──
function getPresetRange(preset) {
  const now = new Date();
  const s = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const e = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  switch (preset) {
    case "this-week": {
      const ws = new Date(now); ws.setDate(now.getDate() - now.getDay());
      return [s(ws), e(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6))];
    }
    case "last-week": {
      const ws = new Date(now); ws.setDate(now.getDate() - now.getDay() - 7);
      return [s(ws), e(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6))];
    }
    case "this-month":
      return [s(new Date(now.getFullYear(), now.getMonth(), 1)), e(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
    case "last-month": {
      const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
      const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      return [s(new Date(y, m, 1)), e(new Date(y, m + 1, 0))];
    }
    case "this-quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return [s(new Date(now.getFullYear(), q * 3, 1)), e(new Date(now.getFullYear(), q * 3 + 3, 0))];
    }
    default:
      return [s(new Date(now.getFullYear(), now.getMonth(), 1)), e(now)];
  }
}

// Formats a Date as YYYY-MM-DD for <input type="date"> value
function toInputDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function Reports() {
  const searchParams = useSearchParams();
  const initialType = searchParams.get("type") || "production";

  const [reportType, setReportType] = useState(initialType);
  const [orders, setOrders] = useState([]);
  const [allItems, setAllItems] = useState({});
  const [payTotals, setPayTotals] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [userName, setUserName] = useState("");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("All");
  const [exporting, setExporting] = useState(false);

  // Sorting
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  // Date range
  const [datePreset, setDatePreset] = useState("this-month");
  const [dateFrom, setDateFrom] = useState(() => getPresetRange("this-month")[0]);
  const [dateTo, setDateTo]     = useState(() => getPresetRange("this-month")[1]);

  const sb = createClient();

  // ── Load all data once ──
  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: p } = await sb.from("user_profiles").select("display_name").eq("id", user.id).single();
        setUserName(p?.display_name || user.email?.split("@")[0] || "");
      }
      const { data: ord } = await sb.from("orders").select("*").order("due_date", { ascending: true, nullsFirst: false });
      setOrders(ord || []);
      const { data: items } = await sb.from("order_items").select("*").order("sort_order");
      if (items) {
        const m = {};
        items.forEach((i) => { if (!m[i.order_id]) m[i.order_id] = []; m[i.order_id].push(i); });
        setAllItems(m);
      }
      const { data: pays } = await sb.from("order_payments").select("order_id,amount");
      if (pays) {
        const t = {};
        pays.forEach((p) => { t[p.order_id] = (t[p.order_id] || 0) + parseFloat(p.amount); });
        setPayTotals(t);
      }
      setLoaded(true);
    })();
  }, []);

  // ── Date helpers ──
  const now = new Date();
  const getBalance = (o) => Math.max((parseFloat(o.total_value) || 0) - (payTotals[o.id] || 0), 0);
  const isOverdue  = (o) => o.due_date && !["Delivered", "Closed"].includes(o.status) && new Date(o.due_date + "T12:00:00") < now;

  const inRange = useCallback((dateStr) => {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d >= dateFrom && d <= dateTo;
  }, [dateFrom, dateTo]);

  // ── Filter logic per report type ──
  const filterFn = useMemo(() => ({
    overdue:     (o) => isOverdue(o),
    "due-week":  (o) => {
      if (!o.due_date || ["Delivered", "Closed"].includes(o.status)) return false;
      return inRange(o.due_date + "T12:00:00");
    },
    production:  (o) => o.status === "Production",
    ready:       (o) => o.status === "Ready for Delivery",
    receivables: (o) => !["Closed"].includes(o.status) && getBalance(o) > 0,
    collections: (o) => inRange(o.due_date + "T12:00:00") && getBalance(o) > 0,
    "sales-week":(o) => inRange(o.created_at),
    completed:   (o) => ["Delivered", "Closed"].includes(o.status) && inRange(o.created_at),
    workload:    (o) => PROD_STATUSES.includes(o.status),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [orders, payTotals, inRange]);

  // ── Apply filters + sorting ──
  const filtered = useMemo(() => {
    const fn = filterFn[reportType] || (() => true);
    let res = orders.filter((o) => {
      if (!fn(o)) return false;
      if (clientFilter !== "All" && o.client !== clientFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return [o.client, o.order_num, o.items, o.assigned_to, o.notes].filter(Boolean).join(" ").toLowerCase().includes(q);
      }
      return true;
    });

    if (sortField) {
      res = [...res].sort((a, b) => {
        let av, bv;
        if (sortField === "total_value") {
          av = parseFloat(a.total_value) || 0;
          bv = parseFloat(b.total_value) || 0;
          return sortDir === "asc" ? av - bv : bv - av;
        }
        if (sortField === "balance") {
          av = getBalance(a); bv = getBalance(b);
          return sortDir === "asc" ? av - bv : bv - av;
        }
        av = (a[sortField] || "").toString().toLowerCase();
        bv = (b[sortField] || "").toString().toLowerCase();
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return res;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, reportType, clientFilter, search, filterFn, sortField, sortDir]);

  // ── Unique clients for filter dropdown ──
  const clients = useMemo(() => {
    const fn = filterFn[reportType] || (() => true);
    const set = new Set(orders.filter(fn).map((o) => o.client));
    return Array.from(set).sort();
  }, [orders, reportType, filterFn]);

  // ── Workload summary (category breakdown) ──
  const workloadSummary = useMemo(() => {
    if (reportType !== "workload") return null;
    const catMap = {};
    filtered.forEach((o) => {
      const items = allItems[o.id] || [];
      if (items.length === 0) {
        catMap["Other"] = (catMap["Other"] || 0) + 1;
      } else {
        items.forEach((i) => { catMap[i.category || "Other"] = (catMap[i.category || "Other"] || 0) + (i.quantity || 1); });
      }
    });
    return CATEGORIES.map((cat) => ({ label: cat, qty: catMap[cat] || 0 })).filter((c) => c.qty > 0);
  }, [filtered, allItems, reportType]);

  // ── Total units ──
  const totalUnits = useMemo(() =>
    filtered.reduce((s, o) => {
      const items = allItems[o.id] || [];
      return s + (items.length > 0 ? items.reduce((t, i) => t + (i.quantity || 1), 0) : 1);
    }, 0),
  [filtered, allItems]);

  // ── Financial / Sales KPI summary ──
  const summaryKpis = useMemo(() => {
    if (!SUMMARY_KPI_REPORTS.includes(reportType) || filtered.length === 0) return null;
    const totalValue   = filtered.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);
    const totalPaid    = filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
    const totalBalance = filtered.reduce((s, o) => s + getBalance(o), 0);
    return { totalValue, totalPaid, totalBalance };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, payTotals, reportType]);

  // ── Report metadata ──
  const reportMeta  = REPORT_TYPES.find((r) => r.id === reportType) || REPORT_TYPES[0];
  const isFinancial = FINANCIAL_REPORTS.includes(reportType);
  const showDateRange = DATE_RANGE_REPORTS.includes(reportType);

  // ── Date range preset handler ──
  const applyPreset = (preset) => {
    setDatePreset(preset);
    if (preset !== "custom") {
      const [f, t] = getPresetRange(preset);
      setDateFrom(f);
      setDateTo(t);
    }
  };

  // ── Sort handler ──
  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  };
  const sortIcon = (field) => sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : " ⇅";

  // ── PDF Export ──
  const handleExport = async () => {
    setExporting(true);
    const parts = [];
    if (clientFilter !== "All") parts.push(`Client: ${clientFilter}`);
    if (showDateRange) parts.push(`${fmtDisplay(dateFrom)} – ${fmtDisplay(dateTo)}`);
    try {
      await generateReportPDF({
        title: reportMeta.label + " Report",
        subtitle: parts.join("  ·  ") || null,
        orders: filtered,
        allItems,
        payTotals,
        userName,
        showFinancials: isFinancial,
        workloadSummary: reportType === "workload" ? workloadSummary : null,
      });
    } catch (err) {
      alert("PDF error: " + err.message);
    }
    setExporting(false);
  };

  if (!loaded) return <div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>;

  // ── Formatters ──
  const fmtDate    = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
  const fmtKES     = (n) => n ? `KES ${Math.round(n).toLocaleString("en-KE")}` : "—";
  const fmtK       = (n) => {
    if (!n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
    return Math.round(n).toString();
  };
  const fmtDisplay = (d) => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

  const daySpan = Math.round((dateTo - dateFrom) / (1000 * 60 * 60 * 24));

  return (
    <div style={{ padding: "20px 16px" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>{reportMeta.icon} {reportMeta.label} Report</h1>
          <p style={{ fontSize: "13px", color: "#999" }}>
            {filtered.length} order{filtered.length !== 1 ? "s" : ""} · {totalUnits} units
            {showDateRange && <> · <span style={{ color: "#666" }}>{fmtDisplay(dateFrom)} – {fmtDisplay(dateTo)}</span></>}
          </p>
        </div>
        <button onClick={handleExport} disabled={exporting || filtered.length === 0} style={{
          padding: "10px 20px", borderRadius: "8px", border: "none",
          background: filtered.length === 0 ? "#e0e0e0" : "#1a1a1a", color: "#fff",
          fontSize: "13px", fontWeight: 600, cursor: filtered.length === 0 ? "not-allowed" : "pointer",
          opacity: exporting ? 0.6 : 1, whiteSpace: "nowrap",
        }}>
          {exporting ? "Generating..." : "📄 Download PDF"}
        </button>
      </div>

      {/* ── Report type tabs ── */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "14px", overflowX: "auto", paddingBottom: "4px" }}>
        {REPORT_TYPES.map((r) => (
          <button key={r.id}
            onClick={() => { setReportType(r.id); setClientFilter("All"); setSearch(""); setSortField(null); }}
            style={{
              padding: "7px 14px", borderRadius: "6px", flexShrink: 0,
              border: "1.5px solid " + (reportType === r.id ? "#1a1a1a" : "#e0e0e0"),
              background: reportType === r.id ? "#1a1a1a" : "#fff",
              color: reportType === r.id ? "#fff" : "#666",
              fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}>
            {r.icon} {r.label}
          </button>
        ))}
      </div>

      {/* ── Date range bar ── */}
      {showDateRange && (
        <div style={{ background: "#fff", border: "1.5px solid #e0e0e0", borderRadius: "8px", padding: "12px 14px", marginBottom: "12px" }}>
          <div style={{ fontSize: "10px", fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "8px" }}>
            Date range — {reportMeta.dateField === "due_date" ? "due date" : "order created"}
          </div>
          <div style={{ display: "flex", gap: "5px", marginBottom: "10px", flexWrap: "wrap" }}>
            {DATE_PRESETS.map((p) => (
              <button key={p.id} onClick={() => applyPreset(p.id)} style={{
                padding: "4px 11px", borderRadius: "5px", fontSize: "11px", cursor: "pointer", fontWeight: 500,
                border: "1.5px solid " + (datePreset === p.id ? "#1a1a1a" : "#e0e0e0"),
                background: datePreset === p.id ? "#1a1a1a" : "#f8f8f8",
                color: datePreset === p.id ? "#fff" : "#555",
              }}>{p.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" value={toInputDate(dateFrom)}
              onChange={(e) => { setDatePreset("custom"); setDateFrom(new Date(e.target.value + "T00:00:00")); }}
              style={{ padding: "6px 10px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "12px", background: "#f8f8f8" }} />
            <span style={{ color: "#aaa", fontSize: "13px" }}>→</span>
            <input type="date" value={toInputDate(dateTo)}
              onChange={(e) => { setDatePreset("custom"); setDateTo(new Date(e.target.value + "T23:59:59")); }}
              style={{ padding: "6px 10px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "12px", background: "#f8f8f8" }} />
            <span style={{ fontSize: "11px", color: "#aaa" }}>{daySpan} day{daySpan !== 1 ? "s" : ""}</span>
          </div>
        </div>
      )}

      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
        <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 180px", padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", minWidth: "140px" }} />
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", fontWeight: 500, cursor: "pointer" }}>
          <option value="All">All Clients ({clients.length})</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* ── Summary KPI strip (financial + sales + completed) ── */}
      {summaryKpis && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "8px", marginBottom: "14px" }}>
          {[
            { label: "Orders",          val: filtered.length,             color: "#1a1a1a", mono: false },
            { label: "Total Value (KES)", val: fmtK(summaryKpis.totalValue), color: "#1565C0", mono: true },
            { label: "Collected (KES)",  val: fmtK(summaryKpis.totalPaid),  color: "#2E7D32", mono: true },
            {
              label: "Outstanding (KES)",
              val: summaryKpis.totalBalance > 0 ? fmtK(summaryKpis.totalBalance) : "✓ Cleared",
              color: summaryKpis.totalBalance > 0 ? "#C62828" : "#2E7D32",
              mono: summaryKpis.totalBalance > 0,
            },
          ].map((k) => (
            <div key={k.label} style={{ background: "#fff", border: "1.5px solid #e0e0e0", borderRadius: "8px", padding: "12px 14px" }}>
              <div style={{ fontSize: "22px", fontWeight: 700, color: k.color, fontFamily: k.mono ? "'DM Mono',monospace" : undefined, letterSpacing: k.mono ? "-0.5px" : undefined, lineHeight: 1 }}>{k.val}</div>
              <div style={{ fontSize: "10px", color: "#888", marginTop: "5px" }}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Workload summary strip ── */}
      {workloadSummary && workloadSummary.length > 0 && (
        <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
          {workloadSummary.map((cat) => (
            <div key={cat.label} style={{ padding: "12px 16px", borderRadius: "8px", background: "#fff", border: "1.5px solid #e0e0e0", flex: "1 1 120px", minWidth: "110px" }}>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#E8512A", fontFamily: "'DM Mono',monospace" }}>{cat.qty}</div>
              <div style={{ fontSize: "11px", color: "#888", fontWeight: 500 }}>{cat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Data table ── */}
      {filtered.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center", background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5" }}>
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📊</div>
          <div style={{ fontSize: "14px", color: "#999" }}>No orders match this report.</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", background: "#fff", borderRadius: "10px", overflow: "hidden", border: "1px solid #e8e8e5" }}>
            <thead>
              <tr style={{ background: "#1a1a1a", color: "#fff", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("client")}>Client{sortIcon("client")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("order_num")}>Order #{sortIcon("order_num")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("due_date")}>Due Date{sortIcon("due_date")}</th>
                <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("status")}>Status{sortIcon("status")}</th>
                <th style={th}>Category</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "center" }}>Qty</th>
                <th style={th}>Size</th>
                <th style={th}>Finish</th>
                {!isFinancial && <th style={th}>Wood</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("total_value")}>Value{sortIcon("total_value")}</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right" }}>Paid</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right", cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("balance")}>Balance{sortIcon("balance")}</th>}
                {!isFinancial && <th style={th}>Notes</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => {
                const items   = allItems[order.id] || [];
                const paid    = payTotals[order.id] || 0;
                const tv      = parseFloat(order.total_value) || 0;
                const balance = Math.max(tv - paid, 0);
                const sc      = ALL_STATUS_COLORS[order.status] || {};

                if (items.length === 0) {
                  return (
                    <tr key={order.id} style={{ borderBottom: "2px solid #e8e8e5" }}>
                      <td style={{ ...td, fontWeight: 700 }}>{order.client}</td>
                      <td style={{ ...td, fontFamily: "'DM Mono',monospace", fontSize: "12px" }}>{order.order_num}</td>
                      <td style={td}>{fmtDate(order.due_date)}</td>
                      <td style={td}><StatusBadge status={order.status} colors={sc} /></td>
                      <td style={td}>—</td>
                      <td style={td}>{order.items || "—"}</td>
                      <td style={{ ...td, textAlign: "center" }}>—</td>
                      <td style={td}>—</td>
                      <td style={td}>—</td>
                      {!isFinancial && <td style={td}>—</td>}
                      {isFinancial && <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono',monospace" }}>{fmtKES(tv)}</td>}
                      {isFinancial && <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono',monospace" }}>{fmtKES(paid)}</td>}
                      {isFinancial && <td style={{ ...td, textAlign: "right", fontWeight: 700, color: balance > 0 ? "#C62828" : "#2E7D32", fontFamily: "'DM Mono',monospace" }}>{fmtKES(balance)}</td>}
                      {!isFinancial && <td style={{ ...td, fontSize: "11px", color: "#888" }}>{order.notes || ""}</td>}
                    </tr>
                  );
                }

                return items.map((item, idx) => (
                  <tr key={`${order.id}-${item.id}`} style={{
                    borderBottom: idx === items.length - 1 ? "2px solid #e8e8e5" : "1px solid #f0ede8",
                    background: idx % 2 === 1 ? "#FAFAF8" : "#fff",
                  }}>
                    {idx === 0 && (
                      <>
                        <td style={{ ...td, fontWeight: 700 }} rowSpan={items.length}>{order.client}</td>
                        <td style={{ ...td, fontFamily: "'DM Mono',monospace", fontSize: "12px" }} rowSpan={items.length}>{order.order_num}</td>
                        <td style={td} rowSpan={items.length}>{fmtDate(order.due_date)}</td>
                        <td style={td} rowSpan={items.length}><StatusBadge status={order.status} colors={sc} /></td>
                      </>
                    )}
                    <td style={td}>{item.category || "—"}</td>
                    <td style={td}>{item.description || "—"}</td>
                    <td style={{ ...td, textAlign: "center", fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{item.quantity || 1}</td>
                    <td style={td}>{item.size || "—"}</td>
                    <td style={{ ...td, fontSize: "11px" }}>{[item.finish_type, item.finish_color].filter(Boolean).join(" / ") || "—"}</td>
                    {!isFinancial && <td style={td}>{item.wood_type || "—"}</td>}
                    {isFinancial && idx === 0 && <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono',monospace" }} rowSpan={items.length}>{fmtKES(tv)}</td>}
                    {isFinancial && idx === 0 && <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono',monospace" }} rowSpan={items.length}>{fmtKES(paid)}</td>}
                    {isFinancial && idx === 0 && <td style={{ ...td, textAlign: "right", fontWeight: 700, color: balance > 0 ? "#C62828" : "#2E7D32", fontFamily: "'DM Mono',monospace" }} rowSpan={items.length}>{fmtKES(balance)}</td>}
                    {!isFinancial && <td style={{ ...td, fontSize: "11px", color: "#888" }}>{item.notes || ""}</td>}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Footer totals ── */}
      {filtered.length > 0 && (
        <div style={{ display: "flex", gap: "20px", marginTop: "16px", padding: "14px 16px", background: "#fff", borderRadius: "8px", border: "1px solid #e8e8e5", flexWrap: "wrap", fontSize: "13px" }}>
          <div><span style={{ color: "#888" }}>Orders:</span> <strong>{filtered.length}</strong></div>
          <div><span style={{ color: "#888" }}>Units:</span> <strong>{totalUnits}</strong></div>
          {(isFinancial || reportType === "sales-week" || reportType === "completed") && (() => {
            const tv  = filtered.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);
            const col = filtered.reduce((s, o) => s + (payTotals[o.id] || 0), 0);
            const bal = filtered.reduce((s, o) => s + getBalance(o), 0);
            return (
              <>
                <div><span style={{ color: "#888" }}>Total Value:</span> <strong style={{ fontFamily: "'DM Mono',monospace" }}>{fmtKES(tv)}</strong></div>
                {isFinancial
                  ? <div><span style={{ color: "#888" }}>Outstanding:</span> <strong style={{ color: "#C62828", fontFamily: "'DM Mono',monospace" }}>{fmtKES(bal)}</strong></div>
                  : <div><span style={{ color: "#888" }}>Collected:</span> <strong style={{ color: "#2E7D32", fontFamily: "'DM Mono',monospace" }}>{fmtKES(col)}</strong></div>
                }
              </>
            );
          })()}
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          table { font-size: 11px !important; }
          th, td { padding: 6px 8px !important; }
        }
        @media (max-width: 560px) {
          [data-kpi-grid] { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}

// ── Shared styles ──
const th = { padding: "10px 12px", textAlign: "left", fontWeight: 600 };
const td = { padding: "8px 12px", verticalAlign: "top" };

function StatusBadge({ status, colors }) {
  return (
    <span style={{
      fontSize: "10px", fontWeight: 700,
      color: colors.text || "#666", background: colors.bg || "#f5f5f5",
      padding: "3px 8px", borderRadius: "4px", whiteSpace: "nowrap",
    }}>{status}</span>
  );
}
