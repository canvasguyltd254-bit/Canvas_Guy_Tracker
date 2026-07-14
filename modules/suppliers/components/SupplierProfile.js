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

const PAYMENT_METHODS = ["Cash", "M-Pesa", "Bank Transfer", "Other"];

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

function OverviewTab({ supplier, stats, canWrite, canReverseOB, onEdit, onReverseOB }) {
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                <div style={{ flex: 1 }}>
                  <div style={ss.label}>Opening balance</div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#92400E" }}>{fmt(supplier.opening_balance)}</div>
                  {supplier.opening_balance_date && <div style={{ fontSize: "12px", color: "#999", marginTop: "2px" }}>As of {fmtDate(supplier.opening_balance_date)}</div>}
                  {supplier.opening_balance_notes && <div style={{ fontSize: "12px", color: "#666", marginTop: "4px", fontStyle: "italic" }}>{supplier.opening_balance_notes}</div>}
                  {supplier.opening_balance_journal_entry_id && (
                    <div style={{ fontSize: "11px", color: "#065F46", background: "#D1FAE5", border: "1px solid #6EE7B7", borderRadius: "4px", padding: "2px 7px", marginTop: "6px", display: "inline-block" }}>
                      ✓ Posted to GL
                    </div>
                  )}
                </div>
                {canReverseOB && supplier.opening_balance_journal_entry_id && (
                  <button
                    onClick={onReverseOB}
                    style={{ flexShrink: 0, padding: "6px 12px", borderRadius: "6px", border: "1.5px solid #FCA5A5", background: "#FEF2F2", color: "#991B1B", fontSize: "12px", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
                  >
                    Reverse & Correct
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Reverse Opening Balance Modal ─────────────────────────────────────────────

function ReverseOBModal({ supplier, onClose, onSuccess }) {
  const [reason, setReason]   = useState("");
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState("");

  const handleReverse = async () => {
    const trimmed = reason.trim();
    if (!trimmed) { setError("Please enter a reason for the reversal."); return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/journal-entries/${supplier.opening_balance_journal_entry_id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Reversal failed");
      onSuccess();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "440px" }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ fontSize: "17px", fontWeight: 700, margin: "0 0 6px" }}>Reverse Opening Balance</h2>
        <p style={{ fontSize: "13px", color: "#666", margin: "0 0 18px", lineHeight: 1.5 }}>
          This will create an equal-and-opposite journal entry and unlock the opening balance so you can correct it.
          The original posted amount was <strong>KSh {Number(supplier.opening_balance || 0).toLocaleString("en-KE")}</strong>.
        </p>

        <label style={ss.label}>Reason for reversal *</label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Opening balance corrected from 788,347 to 673,652"
          rows={3}
          style={{ ...ss.textarea, marginBottom: "16px" }}
        />

        {error && (
          <div style={{ fontSize: "13px", color: "#C62828", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: "6px", padding: "8px 12px", marginBottom: "14px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ padding: "8px 18px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={handleReverse}
            disabled={saving || !reason.trim()}
            style={{ padding: "8px 18px", borderRadius: "7px", border: "none", background: saving ? "#ccc" : "#C62828", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Reversing…" : "Confirm Reversal"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Supplier Modal ───────────────────────────────────────────────────────

function EditSupplierModal({ supplier, onClose, onSaved }) {
  const obPosted = !!(supplier.opening_balance_journal_entry_id);

  const [form, setForm]   = useState({
    name:                  supplier.name                  || "",
    contact_person:        supplier.contact_person        || "",
    phone:                 supplier.phone                 || "",
    email:                 supplier.email                 || "",
    materials_supplied:    supplier.materials_supplied    || "",
    notes:                 supplier.notes                 || "",
    opening_balance:       supplier.opening_balance       || "",
    opening_balance_date:  supplier.opening_balance_date  || "",
    opening_balance_notes: supplier.opening_balance_notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { setError("Supplier name is required."); return; }
    setSaving(true);
    setError("");
    try {
      const body = {
        name:                  form.name.trim(),
        contact_person:        form.contact_person.trim()        || null,
        phone:                 form.phone.trim()                 || null,
        email:                 form.email.trim()                 || null,
        materials_supplied:    form.materials_supplied.trim()    || null,
        notes:                 form.notes.trim()                 || null,
        opening_balance_notes: form.opening_balance_notes.trim() || null,
        // Only send OB fields if not posted to GL
        ...(!obPosted && {
          opening_balance:      parseFloat(form.opening_balance)      || null,
          opening_balance_date: form.opening_balance_date             || null,
        }),
      };
      const res  = await fetch(`/api/suppliers/${supplier.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  const inputStyle  = { ...ss.input };
  const lockedStyle = { ...ss.input, opacity: 0.55, cursor: "not-allowed", background: "#f5f5f5" };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "20px" }}>Edit Supplier</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }} className="form-grid">
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Supplier name *</label>
            <input style={inputStyle} type="text" value={form.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Timber Express" />
          </div>
          <div>
            <label style={ss.label}>Contact person</label>
            <input style={inputStyle} type="text" value={form.contact_person} onChange={e => set("contact_person", e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <label style={ss.label}>Phone</label>
            <input style={inputStyle} type="tel" value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="+254 7xx xxx xxx" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Email</label>
            <input style={inputStyle} type="email" value={form.email} onChange={e => set("email", e.target.value)} placeholder="email@example.com" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Materials supplied</label>
            <input style={inputStyle} type="text" value={form.materials_supplied} onChange={e => set("materials_supplied", e.target.value)} placeholder="e.g. Timber, MDF, Upholstery fabric" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Notes</label>
            <textarea style={ss.textarea} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Payment terms, lead times, etc." rows={3} />
          </div>

          {/* Opening balance — locked when posted to GL */}
          <div style={{ gridColumn: "1 / -1", borderTop: "1px dashed #e0e0e0", paddingTop: "14px", marginTop: "4px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#555", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Opening balance</div>
            {obPosted && (
              <div style={{ fontSize: "12px", color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "6px", padding: "8px 12px", marginBottom: "10px" }}>
                Posted to GL — go to Overview tab and click <strong>Reverse & Correct</strong> to change the amount.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div>
                <label style={ss.label}>Amount (KSh)</label>
                <input
                  style={obPosted ? lockedStyle : inputStyle}
                  type="number" min="0" step="1"
                  value={form.opening_balance}
                  onChange={e => set("opening_balance", e.target.value)}
                  placeholder="0"
                  disabled={obPosted}
                />
              </div>
              <div>
                <label style={ss.label}>As of date</label>
                <input
                  style={obPosted ? lockedStyle : inputStyle}
                  type="date"
                  value={form.opening_balance_date}
                  onChange={e => set("opening_balance_date", e.target.value)}
                  disabled={obPosted}
                />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Notes on opening balance</label>
                <input
                  style={inputStyle}
                  type="text"
                  value={form.opening_balance_notes}
                  onChange={e => set("opening_balance_notes", e.target.value)}
                  placeholder="e.g. Pre-tracker debt from invoices Jan–Mar"
                />
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div style={{ fontSize: "13px", color: "#C62828", background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: "6px", padding: "8px 12px", marginTop: "14px" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
          <button onClick={onClose} disabled={saving} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: saving ? "#ccc" : "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add Purchase Modal ────────────────────────────────────────────────────────

const EMPTY_ADD_PURCHASE = {
  purchase_date: new Date().toISOString().split("T")[0],
  items_bought: "",
  total_amount: "",
  amount_paid: "",
  accounting_category_id: "",
  initial_payment_method: "Cash",
  initial_payment_reference: "",
  notes: "",
  order_ids: [],
};

function AddPurchaseModal({ supplier, onClose, onSaved }) {
  const [form, setForm] = useState({ ...EMPTY_ADD_PURCHASE });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [categories, setCategories] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderSearch, setOrderSearch] = useState("");
  const [showOrderPicker, setShowOrderPicker] = useState(false);

  useEffect(() => {
    fetch("/api/accounting-categories").then(r => r.json()).then(d => {
      if (d.success) setCategories(d.data || []);
    }).catch(() => {});
    fetch("/api/orders?status=all&limit=200").then(r => r.json()).then(d => {
      if (d.success || Array.isArray(d.data)) setOrders(d.data || []);
    }).catch(() => {});
  }, []);

  const totalAmt = parseFloat(form.total_amount) || 0;
  const paidAmt  = parseFloat(form.amount_paid)  || 0;

  const save = async () => {
    setError("");
    if (!form.total_amount || totalAmt <= 0) { setError("Total amount must be greater than zero."); return; }
    if (paidAmt > totalAmt + 0.01) { setError("Amount paid cannot exceed total amount."); return; }
    setSaving(true);
    try {
      const body = {
        supplier_id:                supplier.id,
        purchase_date:              form.purchase_date,
        items_bought:               form.items_bought.trim() || null,
        total_amount:               totalAmt,
        amount_paid:                paidAmt,
        accounting_category_id:     form.accounting_category_id || null,
        notes:                      form.notes.trim() || null,
        order_ids:                  form.order_ids,
        ...(paidAmt > 0 ? {
          initial_payment_method:    form.initial_payment_method,
          initial_payment_reference: form.initial_payment_reference.trim() || null,
        } : {}),
      };
      const res  = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  const filteredOrders = orders.filter(o =>
    !form.order_ids.includes(o.id) &&
    ((o.order_num || "").toLowerCase().includes(orderSearch.toLowerCase()) ||
     (o.client   || "").toLowerCase().includes(orderSearch.toLowerCase()))
  ).slice(0, 30);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "520px", maxHeight: "92vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "4px" }}>Record Purchase</h2>
        <p style={{ fontSize: "13px", color: "#999", marginBottom: "20px" }}>from {supplier.name}</p>

        {error && (
          <div style={{ background: "#FFF5F5", border: "1px solid #FFCDD2", borderRadius: "6px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: "#C62828" }}>{error}</div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
          {/* Purchase date */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Purchase date</label>
            <input style={ss.input} type="date" value={form.purchase_date} onChange={e => setForm({ ...form, purchase_date: e.target.value })} />
          </div>

          {/* Items bought */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Items bought</label>
            <textarea style={ss.textarea} value={form.items_bought} onChange={e => setForm({ ...form, items_bought: e.target.value })} placeholder="e.g. 20 boards Mahogany 2×4, 5 sheets MDF 18mm" rows={3} />
          </div>

          {/* Accounting category */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Accounting category</label>
            <select style={{ ...ss.input, cursor: "pointer" }} value={form.accounting_category_id} onChange={e => setForm({ ...form, accounting_category_id: e.target.value })}>
              <option value="">— Select category (optional) —</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>

          {/* Amounts */}
          <div>
            <label style={ss.label}>Total amount (KSh) *</label>
            <input style={ss.input} type="number" min="0.01" step="1" value={form.total_amount} onChange={e => setForm({ ...form, total_amount: e.target.value })} placeholder="0" autoFocus />
          </div>
          <div>
            <label style={ss.label}>Amount paid (KSh)</label>
            <input style={ss.input} type="number" min="0" step="1" value={form.amount_paid} onChange={e => setForm({ ...form, amount_paid: e.target.value })} placeholder="0" />
          </div>

          {/* Balance preview */}
          {totalAmt > 0 && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: "12px", color: "#999", padding: "8px 12px", background: "#f9f9f7", borderRadius: "6px" }}>
                Balance: <strong style={{ color: "#1a1a1a" }}>{fmt(totalAmt - paidAmt)}</strong>
                &nbsp;·&nbsp;Status will be:&nbsp;
                <strong>{paidAmt <= 0 ? "Unpaid" : paidAmt >= totalAmt ? "Paid" : "Part Paid"}</strong>
              </div>
            </div>
          )}

          {/* Initial payment method — only when amount_paid > 0 */}
          {paidAmt > 0 && (
            <>
              <div>
                <label style={ss.label}>Payment method</label>
                <select style={{ ...ss.input, cursor: "pointer" }} value={form.initial_payment_method} onChange={e => setForm({ ...form, initial_payment_method: e.target.value })}>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={ss.label}>Payment reference</label>
                <input style={ss.input} value={form.initial_payment_reference} onChange={e => setForm({ ...form, initial_payment_reference: e.target.value })} placeholder="e.g. QDK91XMPL" />
              </div>
            </>
          )}

          {/* Link to orders */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Linked customer orders (optional)</label>
            {form.order_ids.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                {form.order_ids.map(oid => {
                  const o = orders.find(x => x.id === oid);
                  return (
                    <div key={oid} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 10px", border: "1.5px solid #E8512A", borderRadius: "6px", background: "#fff8f6" }}>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#E8512A" }}>{o?.order_num || oid.slice(0, 8)}</span>
                      {o?.client && <span style={{ fontSize: "12px", color: "#333" }}>{o.client}</span>}
                      <button type="button" onClick={() => setForm({ ...form, order_ids: form.order_ids.filter(id => id !== oid) })} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "14px", padding: "0 2px", lineHeight: 1 }}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
            <button type="button" onClick={() => { setOrderSearch(""); setShowOrderPicker(true); }} style={{ width: "100%", padding: "9px 12px", border: "1.5px dashed #d0d0d0", borderRadius: "6px", background: "#fafafa", color: "#999", fontSize: "13px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
              {form.order_ids.length > 0 ? "+ Add another order…" : "+ Link to a customer order…"}
            </button>
          </div>

          {/* Notes */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={ss.label}>Notes</label>
            <textarea style={ss.textarea} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Invoice #1234" rows={2} />
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
          <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Record Purchase"}
          </button>
        </div>
      </div>

      {/* Order picker */}
      {showOrderPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => setShowOrderPicker(false)}>
          <div style={{ background: "#fff", borderRadius: "12px", width: "100%", maxWidth: "460px", maxHeight: "65vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid #f0ede8" }}>
              <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "10px" }}>Link to order</div>
              <input autoFocus type="text" placeholder="Search order number or client…" value={orderSearch} onChange={e => setOrderSearch(e.target.value)}
                style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "13px", fontFamily: "inherit", boxSizing: "border-box" }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
              {filteredOrders.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", fontSize: "13px", color: "#bbb" }}>No orders found</div>
              ) : filteredOrders.map(o => (
                <button key={o.id} onClick={() => { setForm(f => ({ ...f, order_ids: [...f.order_ids, o.id] })); setShowOrderPicker(false); }}
                  style={{ width: "100%", padding: "10px 14px", border: "none", background: "none", textAlign: "left", cursor: "pointer", borderRadius: "6px", display: "flex", alignItems: "center", gap: "10px" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#f9f8f6"}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#E8512A", minWidth: "60px" }}>{o.order_num}</span>
                  <span style={{ fontSize: "13px", color: "#333", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.client}</span>
                  <span style={{ fontSize: "11px", color: "#bbb" }}>{o.status}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Link Orders Modal ─────────────────────────────────────────────────────────
//
// Option B — each order link carries its own allocated amount.
// State: orderLinks = [{ order_id, amount }]
// The sum of amounts shows against the purchase total so the user can
// see exactly how much is allocated vs. unallocated.

function LinkOrdersModal({ purchase, onClose, onSaved }) {
  // Initialise from existing links; carry forward any saved amounts
  const existingLinks = (purchase.purchase_order_links || []).map(l => ({
    order_id: l.order_id,
    amount:   l.amount != null ? String(l.amount) : "",
  }));
  const [orderLinks, setOrderLinks] = useState(existingLinks);
  const [orders,     setOrders]     = useState([]);
  const [search,     setSearch]     = useState("");
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState("");

  const purchaseTotal = parseFloat(purchase.total_amount || 0);

  useEffect(() => {
    fetch("/api/orders?status=all&limit=200")
      .then(r => r.json())
      .then(d => { if (d.success) setOrders(d.data || []); })
      .catch(() => {});
  }, []);

  const linkedIds = orderLinks.map(l => l.order_id);
  const linked    = orders.filter(o => linkedIds.includes(o.id));
  const filtered  = orders.filter(o =>
    !linkedIds.includes(o.id) &&
    ((o.order_num || "").toLowerCase().includes(search.toLowerCase()) ||
     (o.client    || "").toLowerCase().includes(search.toLowerCase()))
  ).slice(0, 40);

  // Running allocation total
  const allocated = orderLinks.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const remaining = purchaseTotal - allocated;
  const overAlloc = remaining < -0.01;

  const addOrder  = (orderId) => {
    // Pre-fill with remaining unallocated amount (capped at 0)
    const pre = Math.max(remaining, 0);
    setOrderLinks(ls => [...ls, { order_id: orderId, amount: pre > 0 ? String(Math.round(pre)) : "" }]);
    setSearch("");
  };
  const removeOrder = (orderId) => setOrderLinks(ls => ls.filter(l => l.order_id !== orderId));
  const setAmount   = (orderId, val) => setOrderLinks(ls => ls.map(l => l.order_id === orderId ? { ...l, amount: val } : l));

  const save = async () => {
    setError("");
    if (overAlloc) { setError(`Allocated (${fmt(allocated)}) exceeds purchase total (${fmt(purchaseTotal)}). Reduce one or more amounts.`); return; }
    setSaving(true);
    try {
      const order_links = orderLinks.map(l => ({
        order_id: l.order_id,
        amount:   l.amount !== "" && l.amount !== null ? parseFloat(l.amount) : null,
      }));
      const res  = await fetch(`/api/purchases/${purchase.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_links }),
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
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "#fff", borderRadius: "12px", width: "100%", maxWidth: "520px", maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid #f0ede8" }}>
          <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "2px" }}>Split Purchase Across Orders</div>
          <div style={{ fontSize: "12px", color: "#999" }}>
            {fmtDate(purchase.purchase_date)}
            {purchase.items_bought ? ` · ${purchase.items_bought.slice(0, 55)}${purchase.items_bought.length > 55 ? "…" : ""}` : ""}
          </div>
          {/* Allocation progress bar */}
          <div style={{ marginTop: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "5px" }}>
              <span style={{ fontSize: "11px", color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.4px" }}>Allocated</span>
              <span style={{ fontSize: "12px", fontWeight: 700, color: overAlloc ? "#C62828" : allocated > 0 ? "#065F46" : "#999" }}>
                {fmt(allocated)} / {fmt(purchaseTotal)}
              </span>
            </div>
            <div style={{ height: "5px", background: "#f0ede8", borderRadius: "3px", overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: "3px", transition: "width 0.2s, background 0.2s",
                width: purchaseTotal > 0 ? `${Math.min(allocated / purchaseTotal * 100, 100)}%` : "0%",
                background: overAlloc ? "#C62828" : allocated >= purchaseTotal - 0.01 ? "#065F46" : "#E8512A",
              }} />
            </div>
            {purchaseTotal > 0 && Math.abs(remaining) > 0.01 && (
              <div style={{ fontSize: "11px", marginTop: "4px", color: overAlloc ? "#C62828" : "#999" }}>
                {overAlloc ? `⚠ Over by ${fmt(Math.abs(remaining))}` : `${fmt(remaining)} unallocated`}
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {/* Linked orders with amount inputs */}
          {linked.length > 0 && (
            <div style={{ marginBottom: "16px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>Linked orders</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {linked.map(o => {
                  const link = orderLinks.find(l => l.order_id === o.id);
                  return (
                    <div key={o.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 12px", border: "1.5px solid #E8512A", borderRadius: "8px", background: "#fff8f6" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "13px", fontWeight: 700, color: "#E8512A" }}>{o.order_num}</div>
                        {o.client && <div style={{ fontSize: "11px", color: "#666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.client}</div>}
                      </div>
                      {/* Amount input */}
                      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                        <span style={{ fontSize: "11px", color: "#888" }}>KSh</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={link?.amount ?? ""}
                          onChange={e => setAmount(o.id, e.target.value)}
                          placeholder="amount"
                          style={{ width: "100px", padding: "5px 8px", border: "1.5px solid #e0e0e0", borderRadius: "5px", fontSize: "13px", fontFamily: "inherit", textAlign: "right" }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeOrder(o.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#ccc", fontSize: "16px", padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
                        title="Remove"
                      >✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Search to add more orders */}
          <div style={{ fontSize: "11px", fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
            {linked.length > 0 ? "Add another order" : "Search orders"}
          </div>
          <input
            type="text"
            placeholder="Search order number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus={linked.length === 0}
            style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "7px", fontSize: "14px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit", marginBottom: "8px" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "20px", textAlign: "center", fontSize: "13px", color: "#bbb" }}>
                {search ? "No orders match" : "No orders available"}
              </div>
            ) : filtered.map(o => (
              <button
                key={o.id}
                type="button"
                onClick={() => addOrder(o.id)}
                style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%", padding: "9px 10px", border: "none", borderRadius: "6px", background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                onMouseEnter={e => e.currentTarget.style.background = "#f9f8f6"}
                onMouseLeave={e => e.currentTarget.style.background = "none"}
              >
                <span style={{ fontSize: "13px", fontWeight: 700, color: "#1a1a1a", minWidth: "70px" }}>{o.order_num}</span>
                <span style={{ fontSize: "12px", color: "#666", flex: 1 }}>{o.client}</span>
                <span style={{ fontSize: "11px", color: "#bbb" }}>{o.status}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "14px 20px", borderTop: "1px solid #f0ede8" }}>
          {error && (
            <div style={{ fontSize: "12px", color: "#C62828", marginBottom: "10px" }}>{error}</div>
          )}
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button onClick={onClose} disabled={saving} style={{ padding: "9px 18px", borderRadius: "7px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || overAlloc}
              style={{ padding: "9px 20px", borderRadius: "7px", border: "none", background: (saving || overAlloc) ? "#ccc" : "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: (saving || overAlloc) ? "not-allowed" : "pointer" }}
            >
              {saving ? "Saving…" : "Save links"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Purchases Tab ─────────────────────────────────────────────────────────────

function PurchasesTab({ purchases, canWrite, onAddPurchase, onLinkOrders }) {
  if (!purchases.length) {
    return (
      <div style={{ padding: "60px 20px", textAlign: "center" }}>
        <div style={{ width: "48px", height: "48px", background: "#f0ede8", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
          </svg>
        </div>
        <div style={{ fontSize: "14px", fontWeight: 500, color: "#555", marginBottom: "4px" }}>No purchases yet</div>
        <div style={{ fontSize: "12px", color: "#999", marginBottom: canWrite ? "16px" : 0 }}>Purchases from this supplier will appear here.</div>
        {canWrite && (
          <button onClick={onAddPurchase} style={{ padding: "9px 20px", borderRadius: "7px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            + Record Purchase
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {/* Header row with Add button */}
      {canWrite && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "4px" }}>
          <button onClick={onAddPurchase} style={{ padding: "8px 16px", borderRadius: "7px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
            + Record Purchase
          </button>
        </div>
      )}
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
            {/* Order link button */}
            {canWrite && p.id && (
              <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #f0ede8" }}>
                <button
                  onClick={() => onLinkOrders(p)}
                  style={{ padding: "5px 12px", borderRadius: "5px", border: "1.5px solid #e0e0e0", background: "none", color: "#555", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                >
                  {linkedOrders.length > 0 ? "✏ Edit order links" : "+ Link to order"}
                </button>
              </div>
            )}
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
        <div style={{ width: "48px", height: "48px", background: "#f0ede8", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="2" width="14" height="20" rx="2"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>
          </svg>
        </div>
        <div style={{ fontSize: "14px", fontWeight: 500, color: "#555", marginBottom: "4px" }}>No transactions yet</div>
        <div style={{ fontSize: "12px", color: "#999" }}>Purchases and payments will appear in the ledger here.</div>
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

      {/* Scrollable table wrapper — prevents horizontal overflow on small screens */}
      <div style={{ overflowX: "auto" }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: "90px 100px 1fr 90px 90px 90px", gap: "0", background: "#1a1a1a", borderRadius: "8px 8px 0 0", padding: "8px 12px", minWidth: "520px" }} className="stmt-grid">
          {["Date", "Type", "Description", "Debit", "Credit", "Balance"].map((h, i) => (
            <div key={h} style={{ fontSize: "10px", fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: i >= 3 ? "right" : "left" }}>{h}</div>
          ))}
        </div>

        {/* Rows */}
        {entries.map((e, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 100px 1fr 90px 90px 90px", gap: "0", padding: "8px 12px", background: i % 2 === 0 ? "#f9f9f7" : "#fff", borderBottom: "1px solid #f0ede8", minWidth: "520px" }} className="stmt-grid">
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
        <div style={{ background: "#E8512A", borderRadius: "0 0 8px 8px", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", minWidth: "520px" }}>
          <span style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>Closing Balance — {entries.length} transaction{entries.length !== 1 ? "s" : ""}</span>
          <span style={{ fontSize: "14px", fontWeight: 700, color: "#fff" }}>
            KSh {Number(Math.abs(finalBal)).toLocaleString("en-KE")}{finalBal < 0 ? " CR" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Link Payment to Purchase Modal ────────────────────────────────────────────

function LinkPaymentModal({ payment, purchases, onClose, onSaved }) {
  const [selectedPurchaseId, setSelectedPurchaseId] = useState(payment.purchase_id || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Show all purchases so user can re-link or clear the link
  const save = async () => {
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/manual-payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payment.id, supplier_purchase_id: selectedPurchaseId || null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to update link");
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "460px" }}
        onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px" }}>Link Payment to Purchase</h2>
        <p style={{ fontSize: "13px", color: "#999", marginBottom: "20px" }}>
          {fmt(payment.amount)} · {fmtDate(payment.date)} · {payment.method}
        </p>

        {error && (
          <div style={{ background: "#FFF5F5", border: "1px solid #FFCDD2", borderRadius: "6px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: "#C62828" }}>{error}</div>
        )}

        <label style={ss.label}>Select purchase</label>
        <select style={{ ...ss.input, cursor: "pointer", marginBottom: "20px" }}
          value={selectedPurchaseId}
          onChange={e => setSelectedPurchaseId(e.target.value)}>
          <option value="">— Unlinked (general payment) —</option>
          {purchases.map(p => {
            const balance = parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0);
            return (
              <option key={p.id} value={p.id}>
                {fmtDate(p.purchase_date)} · {p.items_bought?.slice(0, 40) || "Purchase"} · Owed: {Number(Math.max(balance, 0)).toLocaleString("en-KE")}
              </option>
            );
          })}
        </select>

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save Link"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Payments Tab ──────────────────────────────────────────────────────────────

function PaymentsTab({ manualPayments, chatpesaAllocations, purchases, canWrite, onRecordPayment, onReload }) {
  const [linkingPayment, setLinkingPayment] = useState(null); // the manual payment being linked

  // Merge and sort all payments; track _type so we know which support linking
  const allPayments = [
    ...manualPayments.map(mp => ({
      _type:       "manual",
      id:          mp.id,
      date:        mp.payment_date,
      type:        "Manual",
      method:      mp.payment_method || "Cash",
      description: [mp.reference, mp.note].filter(Boolean).join(" · ") || "—",
      amount:      parseFloat(mp.amount || 0),
      purchase_id: mp.supplier_purchase_id,
      // keep raw object for linking modal
      _raw: mp,
    })),
    ...chatpesaAllocations.map(ca => {
      const tx = ca.chatpesa_transactions || {};
      return {
        _type:       "chatpesa",
        id:          ca.id,
        date:        tx.transaction_date || ca.created_at?.slice(0, 10),
        type:        "Chatpesa",
        method:      "M-Pesa",
        description: [tx.confirm_code, tx.description, ca.note].filter(Boolean).join(" · ") || "—",
        amount:      parseFloat(ca.amount || tx.amount || 0),
        purchase_id: ca.supplier_purchase_id,
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
          <div style={{ width: "48px", height: "48px", background: "#f0ede8", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
            </svg>
          </div>
          <div style={{ fontSize: "14px", fontWeight: 500, color: "#555", marginBottom: "4px" }}>No payments yet</div>
          <div style={{ fontSize: "12px", color: "#999", marginBottom: canWrite ? "14px" : "0" }}>Payments made to this supplier will appear here.</div>
          {canWrite && (
            <button onClick={onRecordPayment} style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
              + Record payment
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {allPayments.map((p, i) => {
            const linkedPurchase = purchases.find(pur => pur.id === p.purchase_id);
            const canLink = canWrite && p._type === "manual";
            return (
              <div key={p.id || i} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
                <div style={{ flex: "1 1 200px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: p.type === "Chatpesa" ? "#E8F5E9" : "#EDE7F6", color: p.type === "Chatpesa" ? "#2E7D32" : "#4527A0" }}>{p.type}</span>
                    <span style={{ fontSize: "11px", color: "#999" }}>{p.method}</span>
                    <span style={{ fontSize: "12px", color: "#555" }}>{fmtDate(p.date)}</span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#444" }}>{p.description}</div>
                  {linkedPurchase ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "11px", color: "#E8512A", fontWeight: 600 }}>
                        → {fmtDate(linkedPurchase.purchase_date)}: {linkedPurchase.items_bought?.slice(0, 45) || "Purchase"}
                      </span>
                      {canLink && (
                        <button onClick={() => setLinkingPayment(p)}
                          style={{ fontSize: "11px", color: "#999", background: "none", border: "1px solid #e0e0e0", borderRadius: "4px", padding: "1px 7px", cursor: "pointer", fontFamily: "inherit" }}>
                          Change
                        </button>
                      )}
                    </div>
                  ) : (
                    canLink && (
                      <button onClick={() => setLinkingPayment(p)}
                        style={{ marginTop: "5px", fontSize: "12px", color: "#E8512A", background: "#fff8f6", border: "1.5px solid #E8512A", borderRadius: "5px", padding: "3px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>
                        + Link to purchase
                      </button>
                    )
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

      {/* Link to purchase modal */}
      {linkingPayment && (
        <LinkPaymentModal
          payment={linkingPayment}
          purchases={purchases}
          onClose={() => setLinkingPayment(null)}
          onSaved={async () => {
            setLinkingPayment(null);
            onReload();
          }}
        />
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
  const [showEditModal, setShowEditModal]             = useState(false);
  const [showPaymentModal, setShowPaymentModal]       = useState(false);
  const [showPurchaseModal, setShowPurchaseModal]     = useState(false);
  const [showReverseOBModal, setShowReverseOBModal]   = useState(false);
  const [linkingPurchase, setLinkingPurchase]         = useState(null); // purchase being order-linked
  const [exportingPDF, setExportingPDF]               = useState(false);

  const canWrite = WRITE_ROLES.includes(userRole);

  // silent=true → background refresh; skips the skeleton so open modals aren't torn down
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
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
    if (!silent) setLoading(false);
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
    return (
      <div style={{ padding: "20px 16px", maxWidth: "900px", margin: "0 auto" }}>
        <style>{`
          @keyframes cg-shimmer {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          .cg-skel {
            background: linear-gradient(90deg, #e8e8e5 25%, #f0ede8 50%, #e8e8e5 75%);
            background-size: 200% 100%;
            animation: cg-shimmer 1.4s infinite;
            border-radius: 6px;
          }
        `}</style>
        {/* Back + header skeleton */}
        <div className="cg-skel" style={{ height: "13px", width: "80px", marginBottom: "16px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "24px" }}>
          <div className="cg-skel" style={{ width: "44px", height: "44px", borderRadius: "50%", flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="cg-skel" style={{ height: "22px", width: "55%", marginBottom: "8px" }} />
            <div className="cg-skel" style={{ height: "13px", width: "30%" }} />
          </div>
        </div>
        {/* Tabs skeleton */}
        <div style={{ display: "flex", gap: "8px", borderBottom: "2px solid #e8e8e5", marginBottom: "20px", paddingBottom: "10px" }}>
          {[80, 110, 90, 110].map((w, i) => (
            <div key={i} className="cg-skel" style={{ height: "13px", width: `${w}px` }} />
          ))}
        </div>
        {/* Stat cards skeleton */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "24px" }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
              <div className="cg-skel" style={{ height: "11px", width: "70%", marginBottom: "10px" }} />
              <div className="cg-skel" style={{ height: "20px", width: "85%" }} />
            </div>
          ))}
        </div>
        {/* Detail card skeleton */}
        <div style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "20px" }}>
          <div className="cg-skel" style={{ height: "15px", width: "120px", marginBottom: "20px" }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i}>
                <div className="cg-skel" style={{ height: "10px", width: "50%", marginBottom: "7px" }} />
                <div className="cg-skel" style={{ height: "14px", width: "80%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
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
          canReverseOB={userRole === "admin"}
          onEdit={() => setShowEditModal(true)}
          onReverseOB={() => setShowReverseOBModal(true)}
        />
      )}
      {tab === "purchases" && (
        <PurchasesTab
          purchases={data.purchases || []}
          canWrite={canWrite}
          onAddPurchase={() => setShowPurchaseModal(true)}
          onLinkOrders={p => setLinkingPurchase(p)}
        />
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
          onReload={load}
        />
      )}

      {/* Add purchase modal */}
      {showPurchaseModal && (
        <AddPurchaseModal
          supplier={data}
          onClose={() => setShowPurchaseModal(false)}
          onSaved={async () => {
            setShowPurchaseModal(false);
            await load();
          }}
        />
      )}

      {/* Link orders modal */}
      {linkingPurchase && (
        <LinkOrdersModal
          purchase={linkingPurchase}
          onClose={() => setLinkingPurchase(null)}
          onSaved={async () => {
            setLinkingPurchase(null);
            await load();
          }}
        />
      )}

      {/* Edit supplier modal */}
      {showEditModal && (
        <EditSupplierModal
          supplier={data}
          onClose={() => setShowEditModal(false)}
          onSaved={async () => {
            setShowEditModal(false);
            await load();
          }}
        />
      )}

      {/* Reverse opening balance modal */}
      {showReverseOBModal && (
        <ReverseOBModal
          supplier={data}
          onClose={() => setShowReverseOBModal(false)}
          onSuccess={async () => {
            setShowReverseOBModal(false);
            // Silent reload so the page doesn't skeleton-flash while we
            // immediately open the Edit modal with the OB fields now unlocked.
            await load(true);
            setShowEditModal(true);
          }}
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
