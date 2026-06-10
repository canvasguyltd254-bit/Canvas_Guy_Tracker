"use client";
import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/shared/supabase/client";
import { ALL_STATUS_COLORS, CATEGORIES } from "@/modules/orders/components/constants";
import { generateReportPDF } from "@/shared/pdf/generateReport";

// ── Report type definitions ──
const REPORT_TYPES = [
  { id: "overdue", label: "Overdue", icon: "🔴" },
  { id: "due-week", label: "Due This Week", icon: "📅" },
  { id: "production", label: "In Production", icon: "🔨" },
  { id: "ready", label: "Ready for Delivery", icon: "✅" },
  { id: "receivables", label: "Receivables", icon: "💰" },
  { id: "collections", label: "Collections Due", icon: "📋" },
  { id: "sales-week", label: "Sales This Week", icon: "📈" },
  { id: "workload", label: "Workload", icon: "⚙️" },
];

const PROD_STATUSES = ["Material Check", "Production", "Quality Control", "Ready for Delivery"];
const FINANCIAL_REPORTS = ["receivables", "collections"];

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
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);

  const isOverdue = (o) => o.due_date && !["Delivered", "Closed"].includes(o.status) && new Date(o.due_date + "T12:00:00") < now;
  const isDueThisWeek = (o) => {
    if (!o.due_date || ["Delivered", "Closed"].includes(o.status)) return false;
    const d = new Date(o.due_date + "T12:00:00");
    return d >= now && d <= weekEnd;
  };
  const getBalance = (o) => Math.max((parseFloat(o.total_value) || 0) - (payTotals[o.id] || 0), 0);

  // ── Filter logic per report type ──
  const filterFn = useMemo(() => ({
    overdue: (o) => isOverdue(o),
    "due-week": (o) => isDueThisWeek(o),
    production: (o) => o.status === "Production",
    ready: (o) => o.status === "Ready for Delivery",
    receivables: (o) => !["Closed"].includes(o.status) && getBalance(o) > 0,
    collections: (o) => isDueThisWeek(o) && getBalance(o) > 0,
    "sales-week": (o) => new Date(o.created_at) >= weekStart,
    workload: (o) => PROD_STATUSES.includes(o.status),
  }), [orders, payTotals]);

  // ── Apply filters ──
  const filtered = useMemo(() => {
    const fn = filterFn[reportType] || (() => true);
    return orders.filter((o) => {
      if (!fn(o)) return false;
      if (clientFilter !== "All" && o.client !== clientFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return [o.client, o.order_num, o.items, o.assigned_to, o.notes].filter(Boolean).join(" ").toLowerCase().includes(q);
      }
      return true;
    });
  }, [orders, reportType, clientFilter, search, filterFn]);

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
        items.forEach((i) => {
          catMap[i.category || "Other"] = (catMap[i.category || "Other"] || 0) + (i.quantity || 1);
        });
      }
    });
    return CATEGORIES.map((cat) => ({ label: cat, qty: catMap[cat] || 0 })).filter((c) => c.qty > 0);
  }, [filtered, allItems, reportType]);

  // ── Totals ──
  const totalUnits = useMemo(() => {
    return filtered.reduce((s, o) => {
      const items = allItems[o.id] || [];
      return s + (items.length > 0 ? items.reduce((t, i) => t + (i.quantity || 1), 0) : 1);
    }, 0);
  }, [filtered, allItems]);

  // ── Report metadata ──
  const reportMeta = REPORT_TYPES.find((r) => r.id === reportType) || REPORT_TYPES[0];
  const isFinancial = FINANCIAL_REPORTS.includes(reportType);

  // ── PDF Export ──
  const handleExport = async () => {
    setExporting(true);
    try {
      await generateReportPDF({
        title: reportMeta.label + " Report",
        subtitle: clientFilter !== "All" ? `Client: ${clientFilter}` : null,
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

  const fmtDate = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";
  const fmtKES = (n) => n ? `KES ${Math.round(n).toLocaleString("en-KE")}` : "—";

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>{reportMeta.icon} {reportMeta.label} Report</h1>
          <p style={{ fontSize: "13px", color: "#999" }}>
            {filtered.length} order{filtered.length !== 1 ? "s" : ""} · {totalUnits} units
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

      {/* Report type tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "14px", overflowX: "auto", paddingBottom: "4px" }}>
        {REPORT_TYPES.map((r) => (
          <button key={r.id} onClick={() => { setReportType(r.id); setClientFilter("All"); setSearch(""); }}
            style={{
              padding: "7px 14px", borderRadius: "6px", border: "1.5px solid " + (reportType === r.id ? "#1a1a1a" : "#e0e0e0"),
              background: reportType === r.id ? "#1a1a1a" : "#fff",
              color: reportType === r.id ? "#fff" : "#666",
              fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
            }}>
            {r.icon} {r.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
        <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 180px", padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", minWidth: "140px" }} />
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", fontWeight: 500, cursor: "pointer" }}>
          <option value="All">All Clients ({clients.length})</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Workload summary strip */}
      {workloadSummary && workloadSummary.length > 0 && (
        <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
          {workloadSummary.map((cat) => (
            <div key={cat.label} style={{
              padding: "12px 16px", borderRadius: "8px", background: "#fff",
              border: "1.5px solid #e0e0e0", flex: "1 1 120px", minWidth: "110px",
            }}>
              <div style={{ fontSize: "24px", fontWeight: 800, color: "#E8512A", fontFamily: "'DM Mono',monospace" }}>{cat.qty}</div>
              <div style={{ fontSize: "11px", color: "#888", fontWeight: 500 }}>{cat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Data table */}
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
                <th style={th}>Client</th>
                <th style={th}>Order #</th>
                <th style={th}>Due Date</th>
                <th style={th}>Status</th>
                <th style={th}>Category</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "center" }}>Qty</th>
                <th style={th}>Size</th>
                <th style={th}>Finish</th>
                {!isFinancial && <th style={th}>Wood</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right" }}>Value</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right" }}>Paid</th>}
                {isFinancial && <th style={{ ...th, textAlign: "right" }}>Balance</th>}
                {!isFinancial && <th style={th}>Notes</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => {
                const items = allItems[order.id] || [];
                const paid = payTotals[order.id] || 0;
                const tv = parseFloat(order.total_value) || 0;
                const balance = Math.max(tv - paid, 0);
                const sc = ALL_STATUS_COLORS[order.status] || {};

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
                    {idx === 0 ? (
                      <>
                        <td style={{ ...td, fontWeight: 700 }} rowSpan={items.length}>{order.client}</td>
                        <td style={{ ...td, fontFamily: "'DM Mono',monospace", fontSize: "12px" }} rowSpan={items.length}>{order.order_num}</td>
                        <td style={td} rowSpan={items.length}>{fmtDate(order.due_date)}</td>
                        <td style={td} rowSpan={items.length}><StatusBadge status={order.status} colors={sc} /></td>
                      </>
                    ) : null}
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

      {/* Footer totals */}
      {filtered.length > 0 && (
        <div style={{
          display: "flex", gap: "20px", marginTop: "16px", padding: "14px 16px",
          background: "#fff", borderRadius: "8px", border: "1px solid #e8e8e5",
          flexWrap: "wrap", fontSize: "13px",
        }}>
          <div><span style={{ color: "#888" }}>Orders:</span> <strong>{filtered.length}</strong></div>
          <div><span style={{ color: "#888" }}>Units:</span> <strong>{totalUnits}</strong></div>
          {isFinancial && (
            <>
              <div><span style={{ color: "#888" }}>Total Value:</span> <strong style={{ fontFamily: "'DM Mono',monospace" }}>{fmtKES(filtered.reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0))}</strong></div>
              <div><span style={{ color: "#888" }}>Outstanding:</span> <strong style={{ color: "#C62828", fontFamily: "'DM Mono',monospace" }}>{fmtKES(filtered.reduce((s, o) => s + getBalance(o), 0))}</strong></div>
            </>
          )}
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          table { font-size: 11px !important; }
          th, td { padding: 6px 8px !important; }
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
      fontSize: "10px", fontWeight: 700, color: colors.text || "#666",
      background: colors.bg || "#f5f5f5", padding: "3px 8px", borderRadius: "4px",
      whiteSpace: "nowrap",
    }}>{status}</span>
  );
}
