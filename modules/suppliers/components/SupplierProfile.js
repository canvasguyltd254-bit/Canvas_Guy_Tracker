"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n) =>
  "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function fmtDate(s) {
  if (!s) return "—";
  try {
    const d = new Date(s + "T00:00:00");
    return d.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return String(s).slice(0, 10);
  }
}

const PAYMENT_METHODS = ["Cash", "Bank Transfer", "M-Pesa", "Cheque", "Other"];

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales"];

const ss = {
  label: {
    display: "block", fontSize: "11px", fontWeight: 600, color: "#888",
    marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px",
  },
  input: {
    width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0",
    borderRadius: "6px", fontSize: "14px", background: "#fafafa",
    boxSizing: "border-box", fontFamily: "inherit",
  },
  textarea: {
    width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0",
    borderRadius: "6px", fontSize: "14px", background: "#fafafa",
    resize: "vertical", minHeight: "70px", fontFamily: "inherit", boxSizing: "border-box",
  },
};

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const colors = {
    "Unpaid":    { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D" },
    "Part Paid": { bg: "#DBEAFE", text: "#1E40AF", border: "#93C5FD" },
    "Paid":      { bg: "#D1FAE5", text: "#065F46", border: "#6EE7B7" },
  };
  const c = colors[status] || { bg: "#f5f5f5", text: "#666", border: "#ddd" };
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, color: c.text, background: c.bg, border: `1px solid ${c.border}`, padding: "2px 9px", borderRadius: "4px" }}>
      {status}
    </span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, color = "#1a1a1a", sub }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
      <div style={{ fontSize: "11px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "5px" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: "#aaa", marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────────

function OverviewTab({ supplier, stats, canWrite, onEdit }) {
  return (
    <div>
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "24px" }}>
        <StatCard label="Total purchased" value={fmt(stats.total_purchased)} />
        <StatCard label="Total paid" value={fmt(stats.total_paid)} color="#065F46" />
        <StatCard
          label="Balance owed"
          value={fmt(stats.current_balance)}
          color={stats.current_balance > 0 ? "#92400E" : "#065F46"}
        />
        {stats.opening_balance > 0 && (
          <StatCard
            label="Opening balance"
            value={fmt(stats.opening_balance)}
            color="#555"
            sub={supplier.opening_balance_date ? `as of ${fmtDate(supplier.opening_balance_date)}` : undefined}
          />
        )}
      </div>

      {/* Supplier info card */}
      <div style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "20px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>Supplier details</h3>
          {canWrite && (
            <button onClick={onEdit} style={{ padding: "6px 14px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              Edit
            </button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }} className="detail-grid">
          {supplier.contact_person && (
            <div>
              <div style={ss.label}>Contact person</div>
              <div style={{ fontSize: "13px", color: "#333" }}>{supplier.contact_person}</div>
            </div>
          )}
          {supplier.phone && (
            <div>
              <div style={ss.label}>Phone</div>
              <a href={`tel:${supplier.phone}`} style={{ fontSize: "13px", color: "#1565C0", textDecoration: "none" }}>{supplier.phone}</a>
            </div>
          )}
          {supplier.email && (
            <div>
              <div style={ss.label}>Email</div>
              <a href={`mailto:${supplier.email}`} style={{ fontSize: "13px", color: "#1565C0", textDecoration: "none" }}>{supplier.email}</a>
            </div>
          )}
          {supplier.materials_supplied && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={ss.label}>Materials supplied</div>
              <div style={{ fontSize: "13px", color: "#333" }}>{supplier.materials_supplied}</div>
            </div>
          )}
          {supplier.notes && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={ss.label}>Notes</div>
              <div style={{ fontSize: "13px", color: "#666", fontStyle: "italic", whiteSpace: "pre-line" }}>{supplier.notes}</div>
            </div>
          )}
          {supplier.opening_balance > 0 && (
            <div style={{ gridColumn: "1 / -1", background: "#f9f9f7", borderRadius: "8px", padding: "12px" }}>
              <div style={ss.label}>Opening balance</div>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#92400E" }}>{fmt(supplier.opening_balance)}</div>
              {supplier.opening_balance_date && <div style={{ fontSize: "12px", color: "#999", marginTop: "2px" }}>As of {fmtDate(supplier.opening_balance_date)}</div>}
              {supplier.opening_balance_notes && <div style={{ fontSize: "12px", color: "#666", marginTop: "4px", fontStyle: "italic" }}>{supplier.opening_balance_notes}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Purchases Tab ─────────────────────────────────────────────────────────────

function PurchasesTab({ purchases }) {
  if (!purchases.length) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ fontSize: "32px", marginBottom: "10px" }}>🧾</div>
        <div style={{ fontSize: "14px", color: "#999" }}>No purchases recorded yet.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {purchases.map((p, i) => {
        const balance = parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0);
        const linkedOrders = (p.purchase_order_links || []);
        return (
          <div key={p.id || i} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
              <div style={{ flex: "1 1 200px" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#1a1a1a", marginBottom: "3px" }}>
                  {fmtDate(p.purchase_date)}
                  {linkedOrders.length > 0 && (
                    <span style={{ marginLeft: "10px", fontSize: "12px", color: "#E8512A", fontWeight: 600 }}>
                      → {linkedOrders.map(l => l.orders?.order_num).filter(Boolean).join(", ")}
                    </span>
                  )}
                </div>
                {p.items_bought && (
                  <div style={{ fontSize: "12px", color: "#666", whiteSpace: "pre-line" }}>{p.items_bought}</div>
                )}
                {p.notes && <div style={{ fontSize: "11px", color: "#aaa", marginTop: "4px", fontStyle: "italic" }}>{p.notes}</div>}
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{fmt(p.total_amount)}</div>
                <div style={{ fontSize: "12px", color: "#065F46" }}>Paid: {fmt(p.amount_paid)}</div>
                {balance > 0 && <div style={{ fontSize: "12px", color: "#92400E", fontWeight: 600 }}>Owed: {fmt(balance)}</div>}
                <div style={{ marginTop: "4px" }}><StatusBadge status={p.payment_status} /></div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Totals footer */}
      <div style={{ background: "#1a1a1a", borderRadius: "10px", padding: "14px 16px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>Total — {purchases.length} purchase{purchases.length !== 1 ? "s" : ""}</span>
        <span style={{ fontSize: "13px", color: "#ccc" }}>
          {fmt(purchases.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0))} total ·{" "}
          <span style={{ color: "#6EE7B7" }}>{fmt(purchases.reduce((s, p) => s + parseFloat(p.amount_paid || 0), 0))} paid</span> ·{" "}
          <span style={{ color: "#FCD34D" }}>{fmt(purchases.reduce((s, p) => s + Math.max(parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0), 0), 0))} owed</span>
        </span>
      </div>
    </div>
  );
}

// ── Statement Tab ─────────────────────────────────────────────────────────────

function buildLedger(supplier, purchases, manualPayments, chatpesaAllocations) {
  const entries = [];

  // Opening balance line
  const ob = parseFloat(supplier.opening_balance || 0);
  if (ob > 0) {
    entries.push({
      date:        supplier.opening_balance_date || supplier.created_at?.slice(0, 10) || "—",
      type:        "Opening Balance",
      description: supplier.opening_balance_notes || "Balance brought forward",
      debit:       ob,
      credit:      0,
    });
  }

  // Purchase lines (debits)
  for (const p of purchases) {
    entries.push({
      date:        p.purchase_date || "—",
      type:        "Purchase",
      description: p.items_bought || "Purchase",
      ref:         p.id,
      debit:       parseFloat(p.total_amount || 0),
      credit:      0,
    });
  }

  // Manual payment lines (credits)
  for (const mp of manualPayments) {
    entries.push({
      date:        mp.payment_date || "—",
      type:        "Payment",
      description: [mp.payment_method, mp.reference, mp.note].filter(Boolean).join(" · ") || "Payment",
      debit:       0,
      credit:      parseFloat(mp.amount || 0),
    });
  }

  // Chatpesa allocation lines (credits)
  for (const ca of chatpesaAllocations) {
    const tx = ca.chatpesa_transactions || {};
    entries.push({
      date:        tx.transaction_date || ca.created_at?.slice(0, 10) || "—",
      type:        "Chatpesa",
      description: [tx.confirm_code, tx.description, ca.note].filter(Boolean).join(" · ") || "Chatpesa payment",
      debit:       0,
      credit:      parseFloat(ca.amount || tx.amount || 0),
    });
  }

  // Sort by date ascending
  entries.sort((a, b) => {
    const da = a.date === "—" ? "0000" : a.date;
    const db = b.date === "—" ? "0000" : b.date;
    return da.localeCompare(db);
  });

  // Add running balance
  let running = 0;
  for (const e of entries) {
    running += e.debit - e.credit;
    e.balance = running;
  }

  return entries;
}

function StatementTab({ supplier, purchases, manualPayments, chatpesaAllocations, onExportPDF, exportingPDF }) {
  const entries = buildLedger(supplier, purchases, manualPayments, chatpesaAllocations);
  const finalBal = entries.length ? entries[entries.length - 1].balance : 0;

  if (!entries.length) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ fontSize: "32px", marginBottom: "10px" }}>📋</div>
        <div style={{ fontSize: "14px", color: "#999" }}>No transactions to show.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "14px" }}>
        <button
          onClick={onExportPDF}
          disabled={exportingPDF}
          style={{ padding: "8px 18px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: exportingPDF ? "not-allowed" : "pointer", opacity: exportingPDF ? 0.6 : 1 }}
        >
          {exportingPDF ? "Generating…" : "Export PDF"}
        </button>
      </div>

      {/* Header row */}
      <div style={{ display: "grid", gridTemplateColumns: "90px 100px 1fr 90px 90px 90px", gap: "0", background: "#1a1a1a", borderRadius: "8px 8px 0 0", padding: "8px 12px" }} className="stmt-grid">
        {["Date", "Type", "Description", "Debit", "Credit", "Balance"].map((h, i) => (
          <div key={h} style={{ fontSize: "10px", fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: i >= 3 ? "right" : "left" }}>{h}</div>
        ))}
      </div>

      {/* Rows */}
      {entries.map((e, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 100px 1fr 90px 90px 90px", gap: "0", padding: "8px 12px", background: i % 2 === 0 ? "#f9f9f7" : "#fff", borderBottom: "1px solid #f0ede8" }} className="stmt-grid">
          <div style={{ fontSize: "12px", color: "#555" }}>{fmtDate(e.date)}</div>
          <div>
            <span style={{
              fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px",
              background: e.type === "Purchase" ? "#FEF3C7" : e.type === "Opening Balance" ? "#E3F2FD" : "#D1FAE5",
              color: e.type === "Purchase" ? "#92400E" : e.type === "Opening Balance" ? "#1565C0" : "#065F46",
            }}>{e.type}</span>
          </div>
          <div style={{ fontSize: "12px", color: "#444", paddingRight: "8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.description}>{e.description}</div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#92400E", textAlign: "right" }}>{e.debit > 0 ? fmt(e.debit).replace("KSh ", "") : "—"}</div>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "#065F46", textAlign: "right" }}>{e.credit > 0 ? fmt(e.credit).replace("KSh ", "") : "—"}</div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: e.balance > 0 ? "#92400E" : "#065F46", textAlign: "right" }}>
            {fmt(Math.abs(e.balance)).replace("KSh ", "")}{e.balance < 0 ? " CR" : ""}
          </div>
        </div>
      ))}

      {/* Closing balance */}
      <div style={{ background: "#E8512A", borderRadius: "0 0 8px 8px", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>Closing Balance — {entries.length} transaction{entries.length !== 1 ? "s" : ""}</span>
        <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff" }}>
          KSh {Number(Math.abs(finalBal)).toLocaleString("en-KE")}{finalBal < 0 ? " CR" : ""}
        </span>
      </div>
    </div>
  );
}

// ── Payments Tab ──────────────────────────────────────────────────────────────

function PaymentsTab({ manualPayments, chatpesaAllocations, purchases, canWrite, onRecordPayment }) {
  // Merge and sort all payments
  const allPayments = [
    ...manualPayments.map(mp => ({
      date:        mp.payment_date,
      type:        "Manual",
      method:      mp.payment_method || "Cash",
      description: [mp.reference, mp.note].filter(Boolean).join(" · ") || "—",
      amount:      parseFloat(mp.amount || 0),
      purchase_id: mp.supplier_purchase_id,
      id:          mp.id,
    })),
    ...chatpesaAllocations.map(ca => {
      const tx = ca.chatpesa_transactions || {};
      return {
        date:        tx.transaction_date || ca.created_at?.slice(0, 10),
        type:        "Chatpesa",
        method:      "M-Pesa",
        description: [tx.confirm_code, tx.description, ca.note].filter(Boolean).join(" · ") || "—",
        amount:      parseFloat(ca.amount || tx.amount || 0),
        purchase_id: ca.supplier_purchase_id,
        id:          ca.id,
      };
    }),
  ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div>
      {canWrite && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
          <button onClick={onRecordPayment} style={{ padding: "9px 18px", borderRadius: "7px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            + Record Payment
          </button>
        </div>
      )}

      {allPayments.length === 0 ? (
        <div style={{ padding: "60px 20px", textAlign: "center" }}>
          <div style={{ fontSize: "32px", marginBottom: "10px" }}>💳</div>
          <div style={{ fontSize: "14px", color: "#999" }}>No payments recorded yet.</div>
          {canWrite && (
            <button onClick={onRecordPayment} style={{ marginTop: "12px", padding: "8px 20px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              Record first payment
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {allPayments.map((p, i) => {
            const linkedPurchase = purchases.find(pur => pur.id === p.purchase_id);
            return (
              <div key={p.id || i} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: p.type === "Chatpesa" ? "#E8F5E9" : "#EDE7F6", color: p.type === "Chatpesa" ? "#2E7D32" : "#4527A0" }}>{p.type}</span>
                    <span style={{ fontSize: "11px", color: "#999" }}>{p.method}</span>
                    <span style={{ fontSize: "12px", color: "#555" }}>{fmtDate(p.date)}</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#444" }}>{p.description}</div>
                  {linkedPurchase && (
                    <div style={{ fontSize: "11px", color: "#E8512A", marginTop: "3px", fontWeight: 600 }}>
                      → {fmtDate(linkedPurchase.purchase_date)}: {linkedPurchase.items_bought?.slice(0, 50) || "Purchase"}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#065F46", flexShrink: 0 }}>{fmt(p.amount)}</div>
              </div>
            );
          })}

          {/* Total */}
          <div style={{ background: "#1a1a1a", borderRadius: "10px", padding: "14px 16px", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>{allPayments.length} payment{allPayments.length !== 1 ? "s" : ""}</span>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#6EE7B7" }}>{fmt(allPayments.reduce((s, p) => s + p.amount, 0))}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Record Payment Modal ───────────────────────────────────────────────────────

function RecordPaymentModal({ supplier, purchases, onClose, onSaved }) {
  const [form, setForm] = useState({
    supplier_purchase_id: "",
    payment_date: new Date().toISOString().split("T")[0],
    amount: "",
    payment_method: "Cash",
    reference: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const unpaidPurchases = purchases.filter(p => p.payment_status !== "Paid");

  const save = async () => {
    setError("");
    if (!form.amount || parseFloat(form.amount) <= 0) { setError("Amount must be greater than zero."); return; }
    if (!form.payment_date) { setError("Payment date is required."); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/suppliers/${supplier.id}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          supplier_purchase_id: form.supplier_purchase_id || null,
          amount: parseFloat(form.amount),
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "480px", maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "4px" }}>Record Payment</h2>
        <p style={{ fontSize: "13px", color: "#999", marginBottom: "20px" }}>to {supplier.name}</p>

        {error && (
          <div style={{ background: "#FFF5F5", border: "1px solid #FFCDD2", borderRadius: "6px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: "#C62828" }}>{error}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
          {/* Link to purchase (optional) */}
          {unpaidPurchases.length > 0 && (
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={ss.label}>Link to purchase (optional)</label>
              <select style={{ ...ss.input, cursor: "pointer" }} value={form.supplier_purchase_id} onChange={e => setForm({ ...form, supplier_purchase_id: e.target.value })}>
                <option value="">— General payment to supplier —</option>
                {unpaidPurchases.map(p => (
                  <option key={p.id} value={p.id}>
                    {fmtDate(p.purchase_date)} · {p.items_bought?.slice(0, 40) || "Purchase"} · Owed: {Number(Math.max(parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0), 0)).toLocaleString("en-KE")}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label style={ss.label}>Amount (KSh) *</label>
            <input style={ss.input} type="number" min="0.01" step="1" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" autoFocus />
          </div>
          <div>
            <label style={ss.label}>Payment date *</label>
            <input style={ss.input} type="date" value={form.payment_date} onChange={e => setForm({ ...form, payment_date: e.target.value })} />
          </div>
          <div>
            <label style={ss.label}>Payment method</label>
            <select style={{ ...ss.input, cursor: "pointer" }} value={form.payment_method} onChange={e => setForm({ ...form, payment_method: e.target.value })}>
              {PAYMENT_METHODS.map(m => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={ss.label}>Reference / Cheque no.</label>
            <input style={ss.input} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} placeholder="e.g. CHQ-0012" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Note</label>
            <input style={ss.input} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="e.g. Partial payment for Feb invoice" />
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
          <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Record Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main SupplierProfile ───────────────────────────────────────────────────────

export default function SupplierProfile({ supplierId }) {
  const router = useRouter();

  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [tab, setTab]           = useState("overview");
  const [userRole, setUserRole] = useState("viewer");
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [exportingPDF, setExportingPDF]         = useState(false);

  const canWrite = WRITE_ROLES.includes(userRole);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/suppliers/${supplierId}`);
      if (!res.ok) throw new Error("Supplier not found");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load");
      setData(json.data);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, [supplierId]);

  useEffect(() => {
    load();
    // Fetch user role
    (async () => {
      try {
        const { createClient } = await import("@/shared/supabase/client");
        const sb = createClient();
        const { data: { user } } = await sb.auth.getUser();
        if (user) {
          const { data: profile } = await sb.from("user_profiles").select("role").eq("id", user.id).single();
          if (profile) setUserRole(profile.role);
        }
      } catch {}
    })();
  }, [load]);

  const handleExportPDF = async () => {
    if (!data) return;
    setExportingPDF(true);
    try {
      const supplier = data;
      const entries  = buildLedger(supplier, data.purchases || [], data.manual_payments || [], data.chatpesa_allocations || []);

      const payload = {
        reportLabel: `${supplier.name} — Supplier Statement`,
        userName:    "",
        supplierStatement: {
          supplier: {
            name:         supplier.name,
            contact_person: supplier.contact_person,
            phone:        supplier.phone,
            email:        supplier.email,
            address:      supplier.address,
          },
          entries: entries.map(e => ({
            date:        e.date,
            type:        e.type,
            description: e.description,
            debit:       e.debit,
            credit:      e.credit,
            balance:     e.balance,
          })),
          stats: data.stats,
        },
      };

      const res = await fetch("/api/reports/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || j.error || "PDF failed");
      }

      const blob    = await res.blob();
      const url     = URL.createObjectURL(blob);
      const a       = document.createElement("a");
      a.href        = url;
      a.download    = `${supplier.name.replace(/[^a-zA-Z0-9]/g, "_")}_Statement.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("PDF error: " + err.message);
    }
    setExportingPDF(false);
  };

  if (loading) {
    return <div style={{ padding: "60px 20px", textAlign: "center", color: "#aaa", fontSize: "14px" }}>Loading supplier profile…</div>;
  }
  if (error || !data) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ fontSize: "14px", color: "#C62828", marginBottom: "12px" }}>{error || "Supplier not found"}</div>
        <button onClick={() => router.push("/suppliers")} style={{ padding: "8px 18px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
          ← Back to Suppliers
        </button>
      </div>
    );
  }

  const TABS = [
    { key: "overview",  label: "Overview" },
    { key: "purchases", label: `Purchases (${data.purchases?.length || 0})` },
    { key: "statement", label: "Statement" },
    { key: "payments",  label: `Payments (${(data.manual_payments?.length || 0) + (data.chatpesa_allocations?.length || 0)})` },
  ];

  return (
    <div style={{ padding: "20px 16px", maxWidth: "900px", margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "20px" }}>
        <button
          onClick={() => router.push("/suppliers")}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#999", fontSize: "13px", padding: 0, marginBottom: "8px", display: "flex", alignItems: "center", gap: "4px" }}
        >
          ← Suppliers
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: "#1a1a1a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: 700, flexShrink: 0 }}>
              {(data.name || "?").charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0, color: "#1a1a1a" }}>{data.name}</h1>
              {data.materials_supplied && <div style={{ fontSize: "13px", color: "#999", marginTop: "2px" }}>{data.materials_supplied}</div>}
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {data.stats?.current_balance > 0 && (
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", padding: "5px 12px", borderRadius: "6px" }}>
                Owes: {fmt(data.stats.current_balance)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "2px solid #e8e8e5", marginBottom: "20px" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: "10px 18px", fontSize: "13px", fontWeight: 600, border: "none", background: "none", cursor: "pointer",
            color: tab === t.key ? "#1a1a1a" : "#999",
            borderBottom: tab === t.key ? "2px solid #E8512A" : "2px solid transparent",
            marginBottom: "-2px",
          }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <OverviewTab
          supplier={data}
          stats={data.stats}
          canWrite={canWrite}
          onEdit={() => router.push("/suppliers")} // opens list with edit modal — simplest approach
        />
      )}
      {tab === "purchases" && (
        <PurchasesTab purchases={data.purchases || []} />
      )}
      {tab === "statement" && (
        <StatementTab
          supplier={data}
          purchases={data.purchases || []}
          manualPayments={data.manual_payments || []}
          chatpesaAllocations={data.chatpesa_allocations || []}
          onExportPDF={handleExportPDF}
          exportingPDF={exportingPDF}
        />
      )}
      {tab === "payments" && (
        <PaymentsTab
          manualPayments={data.manual_payments || []}
          chatpesaAllocations={data.chatpesa_allocations || []}
          purchases={data.purchases || []}
          canWrite={canWrite}
          onRecordPayment={() => setShowPaymentModal(true)}
        />
      )}

      {/* Record payment modal */}
      {showPaymentModal && (
        <RecordPaymentModal
          supplier={data}
          purchases={data.purchases || []}
          onClose={() => setShowPaymentModal(false)}
          onSaved={async () => {
            setShowPaymentModal(false);
            await load();
          }}
        />
      )}

      <style>{`
        @media (max-width: 640px) {
          .detail-grid { grid-template-columns: 1fr !important; }
          .stmt-grid { grid-template-columns: 80px 80px 1fr 70px 70px 70px !important; font-size: 11px !important; }
        }
      `}</style>
    </div>
  );
}
