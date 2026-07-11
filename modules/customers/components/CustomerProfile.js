"use client";
import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/shared/supabase/client";
import { useRouter } from "next/navigation";

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales", "sales"];
const VALID_TERMS = ["COD", "7 Days", "30 Days", "60 Days"];

const fmt  = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtD = (d) => d ? new Date(d).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "—";

const ss = {
  label:    { display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px" },
  input:    { width: "100%", padding: "8px 10px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "13px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" },
  textarea: { width: "100%", padding: "8px 10px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "13px", background: "#fafafa", resize: "vertical", minHeight: "60px", fontFamily: "inherit", boxSizing: "border-box" },
};

// ── Status badge ─────────────────────────────────────────────
const STATUS_COLORS = {
  "Inquiry":             { bg: "#F3F4F6", text: "#6B7280" },
  "Quoted":              { bg: "#EFF6FF", text: "#1D4ED8" },
  "Quote Approved":      { bg: "#DBEAFE", text: "#1E40AF" },
  "Deposit Paid":        { bg: "#FEF9C3", text: "#854D0E" },
  "In Production":       { bg: "#FFF7ED", text: "#C2410C" },
  "Quality Check":       { bg: "#FAF5FF", text: "#7E22CE" },
  "Ready for Delivery":  { bg: "#F0FDF4", text: "#15803D" },
  "Out for Delivery":    { bg: "#ECFDF5", text: "#065F46" },
  "Delivered":           { bg: "#D1FAE5", text: "#065F46" },
  "Closed":              { bg: "#F3F4F6", text: "#374151" },
  "Cancelled":           { bg: "#FEE2E2", text: "#991B1B" },
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || { bg: "#F3F4F6", text: "#6B7280" };
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, color: c.text, background: c.bg, padding: "2px 8px", borderRadius: "4px", whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

function StatCard({ label, value, sub, color = "#1a1a1a", accent }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${accent || "#e8e8e5"}`, borderRadius: "10px", padding: "14px 16px", borderTop: accent ? `3px solid ${accent}` : undefined }}>
      <div style={{ fontSize: "11px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: "#aaa", marginTop: "2px" }}>{sub}</div>}
    </div>
  );
}

// ── OVERVIEW TAB ──────────────────────────────────────────────
function OverviewTab({ customer, stats, onUpdated, canWrite }) {
  const [editing, setEditing]   = useState(false);
  const [form, setForm]         = useState({});
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  useEffect(() => {
    setForm({
      name:                 customer.name || "",
      contact_person:       customer.contact_person || "",
      phone:                customer.phone || "",
      email:                customer.email || "",
      address:              customer.address || "",
      kra_pin:              customer.kra_pin || "",
      credit_limit:         customer.credit_limit || "",
      credit_terms:         customer.credit_terms || "COD",
      opening_balance:      customer.opening_balance || "",
      opening_balance_date: customer.opening_balance_date || "",
      notes:                customer.notes || "",
    });
  }, [customer]);

  const handleSave = async () => {
    setSaving(true); setError("");
    try {
      const res  = await fetch(`/api/customers/${customer.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to save");
      setEditing(false);
      onUpdated();
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const outstanding = stats.outstanding || 0;
  const overdue     = stats.overdue     || 0;
  const creditLimit = parseFloat(customer.credit_limit || 0);
  const creditAvail = Math.max(0, creditLimit - outstanding);
  const creditUsedPct = creditLimit > 0 ? Math.min(100, (outstanding / creditLimit) * 100) : 0;

  return (
    <div>
      {/* Dashboard cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px", marginBottom: "20px" }}>
        <StatCard label="Total Sales"     value={fmt(stats.total_sales)}    color="#1a1a1a" />
        <StatCard label="Outstanding"     value={fmt(outstanding)}          color={outstanding > 0 ? "#92400E" : "#065F46"} accent={outstanding > 0 ? "#F59E0B" : undefined} />
        <StatCard label="Overdue"         value={fmt(overdue)}              color={overdue > 0 ? "#C62828" : "#065F46"}     accent={overdue > 0 ? "#EF4444" : undefined} />
        <StatCard label="Active Orders"   value={stats.active_orders || 0}  color="#1a1a1a" />
        <StatCard label="Active Quotes"   value={stats.active_quotes || 0}  color="#1a1a1a" />
        <StatCard label="Total Orders"    value={stats.total_orders || 0}   color="#1a1a1a" sub={`Since ${stats.customer_since || "—"}`} />
      </div>

      {/* Credit block */}
      {creditLimit > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "16px", marginBottom: "16px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "12px" }}>Credit</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={{ fontSize: "11px", color: "#999" }}>Limit</div>
              <div style={{ fontSize: "16px", fontWeight: 700 }}>{fmt(creditLimit)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "#999" }}>Outstanding</div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: outstanding > 0 ? "#92400E" : "#065F46" }}>{fmt(outstanding)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: "#999" }}>Available</div>
              <div style={{ fontSize: "16px", fontWeight: 700, color: creditAvail > 0 ? "#065F46" : "#C62828" }}>{fmt(creditAvail)}</div>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ height: "6px", background: "#f0ede8", borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${creditUsedPct}%`, background: creditUsedPct > 90 ? "#EF4444" : creditUsedPct > 70 ? "#F59E0B" : "#22C55E", borderRadius: "3px", transition: "width 0.3s" }} />
          </div>
          <div style={{ fontSize: "11px", color: "#aaa", marginTop: "4px" }}>
            {creditUsedPct.toFixed(0)}% used · {customer.credit_terms} terms
          </div>
        </div>
      )}

      {/* Customer details */}
      <div style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px" }}>Customer Details</div>
          {canWrite && !editing && (
            <button onClick={() => setEditing(true)} style={{ padding: "5px 14px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer", color: "#555" }}>
              Edit
            </button>
          )}
        </div>

        {!editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            {[
              { label: "Contact Person",  value: customer.contact_person },
              { label: "Phone",           value: customer.phone },
              { label: "Email",           value: customer.email },
              { label: "KRA PIN",         value: customer.kra_pin },
              { label: "Credit Terms",    value: customer.credit_terms },
              { label: "Credit Limit",    value: customer.credit_limit ? fmt(customer.credit_limit) : null },
              { label: "Last Order",      value: fmtD(stats.last_order_date) },
              { label: "Customer Since",  value: fmtD(stats.customer_since) },
            ].map(f => (
              <div key={f.label}>
                <div style={{ fontSize: "11px", color: "#aaa", fontWeight: 600 }}>{f.label}</div>
                <div style={{ fontSize: "13px", color: f.value ? "#1a1a1a" : "#ccc", marginTop: "2px" }}>{f.value || "—"}</div>
              </div>
            ))}
            {customer.address && (
              <div style={{ gridColumn: "1/-1" }}>
                <div style={{ fontSize: "11px", color: "#aaa", fontWeight: 600 }}>Address</div>
                <div style={{ fontSize: "13px", color: "#1a1a1a", marginTop: "2px" }}>{customer.address}</div>
              </div>
            )}
            {customer.notes && (
              <div style={{ gridColumn: "1/-1" }}>
                <div style={{ fontSize: "11px", color: "#aaa", fontWeight: 600 }}>Notes</div>
                <div style={{ fontSize: "13px", color: "#555", marginTop: "2px", whiteSpace: "pre-line" }}>{customer.notes}</div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={ss.label}>Customer name *</label>
              <input style={ss.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Contact person</label>
              <input style={ss.input} value={form.contact_person} onChange={e => setForm({ ...form, contact_person: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Phone</label>
              <input style={ss.input} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Email</label>
              <input style={ss.input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>KRA PIN</label>
              <input style={ss.input} value={form.kra_pin} onChange={e => setForm({ ...form, kra_pin: e.target.value })} />
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={ss.label}>Address</label>
              <input style={ss.input} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Credit limit (KSh)</label>
              <input style={ss.input} type="number" min="0" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Credit terms</label>
              <select style={ss.input} value={form.credit_terms} onChange={e => setForm({ ...form, credit_terms: e.target.value })}>
                {VALID_TERMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={ss.label}>Opening balance (KSh)</label>
              <input style={ss.input} type="number" min="0" value={form.opening_balance} onChange={e => setForm({ ...form, opening_balance: e.target.value })} />
            </div>
            <div>
              <label style={ss.label}>Opening balance date</label>
              <input style={ss.input} type="date" value={form.opening_balance_date} onChange={e => setForm({ ...form, opening_balance_date: e.target.value })} />
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label style={ss.label}>Notes</label>
              <textarea style={ss.textarea} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
            </div>
            {error && <div style={{ gridColumn: "1/-1", padding: "8px 12px", background: "#FEE2E2", color: "#991B1B", borderRadius: "6px", fontSize: "12px" }}>{error}</div>}
            <div style={{ gridColumn: "1/-1", display: "flex", gap: "8px" }}>
              <button onClick={() => setEditing(false)} style={{ flex: 1, padding: "9px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", color: "#666" }}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: "9px", borderRadius: "7px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ORDERS TAB ────────────────────────────────────────────────
function OrdersTab({ orders, customerId }) {
  const router = useRouter();
  const sorted = [...orders].sort((a, b) => b.created_at > a.created_at ? 1 : -1);

  if (!sorted.length) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ fontSize: "36px", marginBottom: "10px" }}>📋</div>
        <div style={{ fontSize: "14px", color: "#999" }}>No orders linked to this customer yet.</div>
        <div style={{ fontSize: "12px", color: "#ccc", marginTop: "6px" }}>New orders will appear here automatically.</div>
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #f0ede8" }}>
            {["Order","Date","Status","Value","Paid","Balance","Due Date"].map(h => (
              <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: "11px", fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(o => {
            const paid    = (o.order_payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            const balance = parseFloat(o.total_value || 0) - paid;
            const isOverdue = o.payment_due_date && o.payment_due_date < new Date().toISOString().split("T")[0] && balance > 0 && ['Partially Delivered','Delivered','Closed'].includes(o.status);
            return (
              <tr key={o.id}
                onClick={() => router.push(`/orders/${o.id}`)}
                style={{ borderBottom: "1px solid #f5f5f3", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "#fafaf8"}
                onMouseLeave={e => e.currentTarget.style.background = ""}>
                <td style={{ padding: "10px 10px" }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "12px", color: "#E8512A" }}>{o.order_num}</span>
                </td>
                <td style={{ padding: "10px 10px", color: "#666", whiteSpace: "nowrap" }}>{o.created_at?.split("T")[0]}</td>
                <td style={{ padding: "10px 10px" }}><StatusBadge status={o.status} /></td>
                <td style={{ padding: "10px 10px", fontWeight: 600 }}>{fmt(o.total_value)}</td>
                <td style={{ padding: "10px 10px", color: "#065F46" }}>{fmt(paid)}</td>
                <td style={{ padding: "10px 10px", fontWeight: 700, color: balance > 0 ? "#92400E" : "#065F46" }}>{fmt(balance)}</td>
                <td style={{ padding: "10px 10px", color: isOverdue ? "#C62828" : "#666", fontWeight: isOverdue ? 700 : 400, whiteSpace: "nowrap" }}>
                  {o.payment_due_date || "—"}
                  {isOverdue && " ⚠"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── STATEMENT TAB ─────────────────────────────────────────────
function StatementTab({ statement, customer }) {
  const [exporting, setExporting]     = useState(false);
  const [exportError, setExportError] = useState("");
  const [userName, setUserName]       = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserName(user.email || "");
    });
  }, []);

  const handleExport = async () => {
    setExporting(true); setExportError("");
    try {
      const body = {
        reportLabel: "Customer Statement",
        customerStatement: {
          customer: {
            name:         customer?.name         || "",
            phone:        customer?.phone        || "",
            email:        customer?.email        || "",
            address:      customer?.address      || "",
            credit_terms: customer?.credit_terms || "",
          },
          entries: statement || [],
        },
        userName,
      };
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
      const safeName = (customer?.name || "Customer").replace(/[^a-zA-Z0-9]/g, "_");
      a.download = `Statement_${safeName}_${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(`PDF error: ${err.message}`);
    }
    setExporting(false);
  };

  const TYPE_STYLE = {
    "Opening Balance": { color: "#374151", bg: "#F3F4F6" },
    "Invoice":         { color: "#C2410C", bg: "#FFF7ED" },
    "Payment":         { color: "#065F46", bg: "#D1FAE5" },
  };

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "8px" }}>
        <div style={{ fontSize: "13px", color: "#888" }}>
          {statement?.length ? `${statement.length} transaction${statement.length !== 1 ? "s" : ""}` : "No transactions"}
        </div>
        <button
          onClick={handleExport}
          disabled={exporting || !statement?.length}
          style={{ padding: "8px 18px", borderRadius: "7px", border: "none", fontSize: "13px", fontWeight: 700, cursor: exporting || !statement?.length ? "not-allowed" : "pointer",
            background: exporting || !statement?.length ? "#ccc" : "#1a1a1a", color: "#fff" }}>
          {exporting ? "Exporting…" : "Export Statement PDF"}
        </button>
      </div>

      {exportError && (
        <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#FEE2E2", color: "#991B1B", borderRadius: "6px", fontSize: "12px" }}>
          {exportError}
        </div>
      )}

      {!statement?.length ? (
        <div style={{ padding: "60px 20px", textAlign: "center" }}>
          <div style={{ fontSize: "36px", marginBottom: "10px" }}>📄</div>
          <div style={{ fontSize: "14px", color: "#999" }}>Statement is empty — no transactions yet.</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #f0ede8" }}>
                {["Date","Type","Description","Debit","Credit","Balance"].map(h => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: h === "Debit" || h === "Credit" || h === "Balance" ? "right" : "left", fontSize: "11px", fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {statement.map((entry, idx) => {
                const ts = TYPE_STYLE[entry.type] || TYPE_STYLE["Opening Balance"];
                return (
                  <tr key={idx} style={{ borderBottom: "1px solid #f5f5f3" }}>
                    <td style={{ padding: "9px 10px", color: "#666", whiteSpace: "nowrap" }}>{entry.date || "—"}</td>
                    <td style={{ padding: "9px 10px" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, color: ts.color, background: ts.bg, padding: "2px 8px", borderRadius: "4px" }}>{entry.type}</span>
                    </td>
                    <td style={{ padding: "9px 10px", color: "#555" }}>{entry.description}</td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontWeight: entry.debit > 0 ? 600 : 400, color: entry.debit > 0 ? "#C2410C" : "#ccc" }}>
                      {entry.debit > 0 ? fmt(entry.debit) : "—"}
                    </td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontWeight: entry.credit > 0 ? 600 : 400, color: entry.credit > 0 ? "#065F46" : "#ccc" }}>
                      {entry.credit > 0 ? fmt(entry.credit) : "—"}
                    </td>
                    <td style={{ padding: "9px 10px", textAlign: "right", fontWeight: 700, color: entry.balance > 0 ? "#92400E" : entry.balance < 0 ? "#065F46" : "#374151" }}>
                      {fmt(Math.abs(entry.balance))}{entry.balance < 0 ? " CR" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Closing balance footer */}
          {(() => {
            const last = statement[statement.length - 1];
            const bal  = last?.balance || 0;
            return (
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px", background: "#1a1a1a", borderRadius: "0 0 8px 8px", marginTop: "1px" }}>
                <span style={{ fontSize: "12px", color: "#E8512A", fontWeight: 700 }}>
                  Closing Balance:{" "}
                  <span style={{ color: "#fff", fontFamily: "monospace" }}>
                    {fmt(Math.abs(bal))}{bal < 0 ? " CR" : ""}
                  </span>
                </span>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ── TIMELINE TAB ──────────────────────────────────────────────
function TimelineTab({ timeline }) {
  const TYPE_ICON = {
    "customer_created": "🤝",
    "order_created":    "📋",
    "payment":          "💳",
    "status_change":    "🔄",
    "delivery":         "🚛",
    "note":             "📝",
  };

  const grouped = {};
  for (const item of timeline || []) {
    const date = (item.date || "").split("T")[0];
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(item);
  }

  const dates = Object.keys(grouped).sort((a, b) => b > a ? 1 : -1);

  if (!dates.length) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ fontSize: "36px", marginBottom: "10px" }}>🕐</div>
        <div style={{ fontSize: "14px", color: "#999" }}>No activity yet.</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {dates.map(date => (
        <div key={date} style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", paddingLeft: "36px" }}>
            {fmtD(date)}
          </div>
          {grouped[date].map((item, idx) => (
            <div key={idx} style={{ display: "flex", gap: "12px", marginBottom: "8px", paddingLeft: "4px" }}>
              <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#f9f8f6", border: "2px solid #e8e8e5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", flexShrink: 0 }}>
                {TYPE_ICON[item.type] || "·"}
              </div>
              <div style={{ flex: 1, paddingTop: "4px" }}>
                <div style={{ fontSize: "13px", color: "#1a1a1a" }}>{item.description}</div>
                {item.order_num && (
                  <div style={{ fontSize: "11px", color: "#E8512A", fontFamily: "monospace", marginTop: "2px" }}>{item.order_num}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── NOTES TAB ─────────────────────────────────────────────────
function NotesTab({ customerId, canWrite }) {
  const [notes, setNotes]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [newNote, setNewNote]   = useState("");
  const [saving, setSaving]     = useState(false);

  const loadNotes = useCallback(async () => {
    const res  = await fetch(`/api/customers/${customerId}/notes`);
    const json = await res.json();
    setNotes(json.data || []);
    setLoading(false);
  }, [customerId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const handleAdd = async () => {
    if (!newNote.trim()) return;
    setSaving(true);
    await fetch(`/api/customers/${customerId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: newNote }) });
    setNewNote("");
    await loadNotes();
    setSaving(false);
  };

  return (
    <div>
      {canWrite && (
        <div style={{ marginBottom: "16px" }}>
          <textarea
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            placeholder="Add an internal note…"
            style={{ width: "100%", padding: "10px 12px", border: "1.5px solid #e0e0e0", borderRadius: "8px", fontSize: "13px", resize: "vertical", minHeight: "70px", fontFamily: "inherit", boxSizing: "border-box", background: "#fafafa" }}
          />
          <button onClick={handleAdd} disabled={saving || !newNote.trim()}
            style={{ marginTop: "8px", padding: "8px 20px", borderRadius: "7px", border: "none", background: newNote.trim() ? "#1a1a1a" : "#e0e0e0", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: newNote.trim() ? "pointer" : "not-allowed" }}>
            {saving ? "Saving…" : "Add Note"}
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ color: "#aaa", fontSize: "13px" }}>Loading…</div>
      ) : notes.length === 0 ? (
        <div style={{ padding: "40px 20px", textAlign: "center", color: "#ccc", fontSize: "13px" }}>No notes yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {notes.map(n => (
            <div key={n.id} style={{ background: "#fafaf8", border: "1px solid #e8e8e5", borderRadius: "8px", padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", marginBottom: "6px" }}>
                <span style={{ fontSize: "12px", fontWeight: 600, color: "#888" }}>{n.author_name}</span>
                <span style={{ fontSize: "11px", color: "#ccc", whiteSpace: "nowrap" }}>{fmtD(n.created_at?.split("T")[0])}</span>
              </div>
              <div style={{ fontSize: "13px", color: "#333", whiteSpace: "pre-line" }}>{n.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── MAIN CustomerProfile ──────────────────────────────────────
export default function CustomerProfile({ customerId }) {
  const router                      = useRouter();
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState("overview");
  const [userRole, setUserRole]     = useState("");

  const loadProfile = useCallback(async () => {
    const res  = await fetch(`/api/customers/${customerId}`);
    const json = await res.json();
    if (json.success) setData(json.data);
    setLoading(false);
  }, [customerId]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", user.id).single();
      setUserRole(profile?.role || "");
    });
    loadProfile();
  }, [loadProfile]);

  const canWrite = WRITE_ROLES.includes(userRole);

  if (loading) return <div style={{ padding: "60px", textAlign: "center", color: "#aaa" }}>Loading…</div>;
  if (!data)   return <div style={{ padding: "60px", textAlign: "center", color: "#C62828" }}>Customer not found.</div>;

  const stats = data._stats || {};

  const TABS = [
    { key: "overview",  label: "Overview" },
    { key: "orders",    label: `Orders (${data.orders?.length || 0})` },
    { key: "statement", label: "Statement" },
    { key: "timeline",  label: "Timeline" },
    { key: "notes",     label: "Notes" },
  ];

  // Calculate terms days for "New Order" button
  const TERMS_DAYS = { "COD": 0, "7 Days": 7, "30 Days": 30, "60 Days": 60 };
  const creditTermsDays = TERMS_DAYS[data.credit_terms] || 0;
  const newOrderUrl = `/orders/new?customer_id=${customerId}&client=${encodeURIComponent(data.name)}&contact_person=${encodeURIComponent(data.contact_person || "")}&phone=${encodeURIComponent(data.phone || "")}&credit_terms_days=${creditTermsDays}`;

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "24px 16px" }}>
      {/* Back + header */}
      <button onClick={() => router.push("/customers")}
        style={{ background: "none", border: "none", cursor: "pointer", color: "#999", fontSize: "13px", marginBottom: "12px", padding: 0, display: "flex", alignItems: "center", gap: "4px" }}>
        ← Customers
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 4px" }}>{data.name}</h1>
          <div style={{ fontSize: "13px", color: "#888" }}>
            {[data.contact_person, data.phone, data.email].filter(Boolean).join(" · ")}
          </div>
          {data.kra_pin && <div style={{ fontSize: "12px", color: "#aaa", marginTop: "2px" }}>KRA: {data.kra_pin}</div>}
        </div>
        {canWrite && (
          <button onClick={() => router.push(newOrderUrl)}
            style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            + New Order
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: "20px", borderBottom: "2px solid #e8e8e5", overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: "10px 18px", fontSize: "13px", fontWeight: 600, border: "none", background: "none", cursor: "pointer",
            color: tab === t.key ? "#1a1a1a" : "#999",
            borderBottom: tab === t.key ? "2px solid #E8512A" : "2px solid transparent",
            marginBottom: "-2px", whiteSpace: "nowrap",
          }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview"  && <OverviewTab  customer={data} stats={stats} onUpdated={loadProfile} canWrite={canWrite} />}
      {tab === "orders"    && <OrdersTab    orders={data.orders || []} customerId={customerId} />}
      {tab === "statement" && <StatementTab statement={data.statement || []} customer={data} />}
      {tab === "timeline"  && <TimelineTab  timeline={data.timeline  || []} />}
      {tab === "notes"     && <NotesTab     customerId={customerId} canWrite={canWrite} />}
    </div>
  );
}
