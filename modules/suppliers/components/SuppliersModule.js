"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/shared/supabase/client";
import PaymentsTab from "./PaymentsTab";

// ── Constants ─────────────────────────────────────────────────────────────────

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales"];

const STATUS_COLORS = {
  "Unpaid":    { bg: "#FEF3C7", text: "#92400E", border: "#FCD34D" },
  "Part Paid": { bg: "#DBEAFE", text: "#1E40AF", border: "#93C5FD" },
  "Paid":      { bg: "#D1FAE5", text: "#065F46", border: "#6EE7B7" },
};

const EMPTY_SUPPLIER = {
  name: "", contact_person: "", phone: "", email: "",
  materials_supplied: "", notes: "",
  opening_balance: "", opening_balance_date: "", opening_balance_notes: "",
};

const EMPTY_PURCHASE = {
  supplier_id: "", order_ids: [], purchase_date: new Date().toISOString().split("T")[0],
  items_bought: "", total_amount: "", amount_paid: "", notes: "",
  accounting_category_id: "", initial_payment_method: "Cash", initial_payment_reference: "",
};

const PAYMENT_METHODS = ["Cash", "M-Pesa", "Bank Transfer", "Other"];

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const ss = {
  label: { display: "block", fontSize: "11px", fontWeight: 600, color: "#888", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.5px" },
  input: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" },
  textarea: { width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "6px", fontSize: "14px", background: "#fafafa", resize: "vertical", minHeight: "70px", fontFamily: "inherit", boxSizing: "border-box" },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || { bg: "#f5f5f5", text: "#666", border: "#ddd" };
  return (
    <span style={{ fontSize: "11px", fontWeight: 700, color: c.text, background: c.bg, border: `1px solid ${c.border}`, padding: "2px 9px", borderRadius: "4px", letterSpacing: "0.3px" }}>
      {status}
    </span>
  );
}

function SummaryBar({ purchases }) {
  const total   = purchases.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
  const paid    = purchases.reduce((s, p) => s + parseFloat(p.amount_paid  || 0), 0);
  const balance = total - paid;
  const unpaidCount = purchases.filter(p => p.payment_status !== "Paid").length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "10px", marginBottom: "20px" }}>
      {[
        { label: "Total spend",    value: fmt(total),   color: "#1a1a1a" },
        { label: "Total paid",     value: fmt(paid),    color: "#065F46" },
        { label: "Outstanding",    value: fmt(balance), color: balance > 0 ? "#92400E" : "#065F46" },
        { label: "Unpaid bills",   value: unpaidCount,  color: unpaidCount > 0 ? "#C62828" : "#065F46" },
      ].map(card => (
        <div key={card.label} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "14px 16px" }}>
          <div style={{ fontSize: "11px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "5px" }}>{card.label}</div>
          <div style={{ fontSize: "18px", fontWeight: 700, color: card.color }}>{card.value}</div>
        </div>
      ))}
    </div>
  );
}

function Avatar({ name, size = 40 }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors   = ["#E8512A", "#1a1a1a", "#2563EB", "#059669", "#7C3AED", "#DB2777"];
  const idx      = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: colors[idx], display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: size * 0.35, fontWeight: 700, color: "#fff", letterSpacing: "-0.5px" }}>
      {initials}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SuppliersModule() {
  const [userRole, setUserRole] = useState("viewer");
  const [tab, setTab] = useState("suppliers");   // "suppliers" | "purchases"
  const [loaded, setLoaded] = useState(false);

  // Data
  const [suppliers, setSuppliers]             = useState([]);
  const [purchases, setPurchases]             = useState([]);
  const [orders, setOrders]                   = useState([]);
  const [accountingCategories, setAccountingCategories] = useState([]);

  // Supplier list state
  const [supplierSearch, setSupplierSearch] = useState("");

  // Purchase list state
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [filterStatus, setFilterStatus]     = useState("All");
  const [filterSupplier, setFilterSupplier] = useState("All");
  const [expandedPurchase, setExpandedPurchase] = useState(null);

  // Mobile detection
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Supplier modal
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editingSupplierId, setEditingSupplierId] = useState(null);
  const [supplierForm, setSupplierForm] = useState(EMPTY_SUPPLIER);
  const [savingSupplier, setSavingSupplier] = useState(false);

  // Purchase modal
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [purchaseForm, setPurchaseForm] = useState(EMPTY_PURCHASE);
  const [savingPurchase, setSavingPurchase] = useState(false);

  // Supplier picker modal
  const [showSupplierPicker, setShowSupplierPicker] = useState(false);
  const [supplierPickerSearch, setSupplierPickerSearch] = useState("");

  // Order picker modal
  const [showOrderPicker, setShowOrderPicker] = useState(false);
  const [orderPickerSearch, setOrderPickerSearch] = useState("");

  // Delete confirm + reversal flow
  const [deleteTarget, setDeleteTarget]       = useState(null); // { type, id, label }
  const [deleteError, setDeleteError]         = useState("");
  const [deleteJournalId, setDeleteJournalId] = useState(null);
  const [showReversalInput, setShowReversalInput] = useState(false);
  const [reversalReason, setReversalReason]   = useState("");
  const [reversing, setReversing]             = useState(false);

  const canWrite  = WRITE_ROLES.includes(userRole);
  const canDelete = ["admin"].includes(userRole);

  const router = useRouter();
  const sb = createClient();

  // ── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: profile } = await sb.from("user_profiles").select("role").eq("id", user.id).single();
        if (profile) setUserRole(profile.role);
      }
      await Promise.all([loadSuppliers(), loadPurchases(), loadOrders(), loadAccountingCategories()]);
      setLoaded(true);
    })();
  }, []);

  const loadSuppliers = async () => {
    const res = await fetch("/api/suppliers");
    const json = await res.json();
    setSuppliers(json.data || []);
  };

  const loadPurchases = async () => {
    const res = await fetch("/api/purchases");
    const json = await res.json();
    setPurchases(json.data || []);
  };

  const loadOrders = async () => {
    const { data } = await sb
      .from("orders")
      .select("id, order_num, client, status")
      .order("created_at", { ascending: false })
      .limit(200);
    setOrders(data || []);
  };

  const loadAccountingCategories = async () => {
    const res  = await fetch("/api/accounting-categories?for_purchases=true");
    const json = await res.json();
    setAccountingCategories(json.data || []);
  };

  // ── Derived data ───────────────────────────────────────────────────────────

  const filteredSuppliers = useMemo(() => {
    if (!supplierSearch) return suppliers;
    const q = supplierSearch.toLowerCase();
    return suppliers.filter(s =>
      [s.name, s.contact_person, s.phone, s.email, s.materials_supplied, s.notes]
        .filter(Boolean).join(" ").toLowerCase().includes(q)
    );
  }, [suppliers, supplierSearch]);

  const filteredPurchases = useMemo(() => {
    return purchases.filter(p => {
      if (filterStatus !== "All" && p.payment_status !== filterStatus) return false;
      if (filterSupplier !== "All" && p.supplier_id !== filterSupplier) return false;
      if (purchaseSearch) {
        const q = purchaseSearch.toLowerCase();
        const text = [
          p.suppliers?.name,
          ...(p.purchase_order_links || []).flatMap(l => [l.orders?.order_num, l.orders?.client]),
          p.items_bought, p.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }, [purchases, filterStatus, filterSupplier, purchaseSearch]);

  // ── Supplier CRUD ──────────────────────────────────────────────────────────

  const openAddSupplier = () => {
    setSupplierForm(EMPTY_SUPPLIER);
    setEditingSupplierId(null);
    setShowSupplierForm(true);
  };

  const openEditSupplier = (s, e) => {
    e.stopPropagation();
    setSupplierForm({
      name: s.name || "", contact_person: s.contact_person || "",
      phone: s.phone || "", email: s.email || "",
      materials_supplied: s.materials_supplied || "", notes: s.notes || "",
      opening_balance: s.opening_balance != null ? String(s.opening_balance) : "",
      opening_balance_date: s.opening_balance_date || "",
      opening_balance_notes: s.opening_balance_notes || "",
    });
    setEditingSupplierId(s.id);
    setShowSupplierForm(true);
  };

  const saveSupplier = async () => {
    if (!supplierForm.name.trim()) { alert("Supplier name is required."); return; }
    setSavingSupplier(true);
    try {
      const url    = editingSupplierId ? `/api/suppliers/${editingSupplierId}` : "/api/suppliers";
      const method = editingSupplierId ? "PATCH" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(supplierForm) });
      const json   = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      setShowSupplierForm(false);
      setEditingSupplierId(null);
      await loadSuppliers();
    } catch (err) {
      alert("Error: " + err.message);
    }
    setSavingSupplier(false);
  };

  // ── Purchase CRUD ──────────────────────────────────────────────────────────

  const openAddPurchase = (presetSupplierId = "") => {
    setPurchaseForm({ ...EMPTY_PURCHASE, supplier_id: presetSupplierId, purchase_date: new Date().toISOString().split("T")[0] });
    setEditingPurchaseId(null);
    setShowPurchaseForm(true);
  };

  const openEditPurchase = (p, e) => {
    e.stopPropagation();
    setPurchaseForm({
      supplier_id:             p.supplier_id || "",
      order_ids:               (p.purchase_order_links || []).map(l => l.order_id),
      purchase_date:           p.purchase_date || new Date().toISOString().split("T")[0],
      items_bought:            p.items_bought || "",
      total_amount:            p.total_amount || "",
      amount_paid:             p.amount_paid || "",
      notes:                   p.notes || "",
      accounting_category_id:  p.accounting_category_id || "",
      // Do not resend initial_payment fields on edit — the payment already exists
      initial_payment_method:  "Cash",
      initial_payment_reference: "",
    });
    setEditingPurchaseId(p.id);
    setShowPurchaseForm(true);
  };

  const savePurchase = async () => {
    if (!purchaseForm.supplier_id) { alert("Please select a supplier."); return; }
    if (!purchaseForm.total_amount || parseFloat(purchaseForm.total_amount) <= 0) { alert("Total amount must be greater than zero."); return; }
    setSavingPurchase(true);
    try {
      const url    = editingPurchaseId ? `/api/purchases/${editingPurchaseId}` : "/api/purchases";
      const method = editingPurchaseId ? "PATCH" : "POST";

      // For posted purchases, only send editable fields — locked fields (supplier_id,
      // purchase_date, total_amount, amount_paid, accounting_category_id) are rejected
      // with a 409 if sent while a journal entry exists.
      let body = purchaseForm;
      if (editingPurchaseId) {
        const existing = purchases.find(p => p.id === editingPurchaseId);
        if (existing?.journal_entry_id) {
          body = {
            items_bought: purchaseForm.items_bought,
            notes:        purchaseForm.notes,
            order_ids:    purchaseForm.order_ids,
          };
        }
      }

      const res  = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      setShowPurchaseForm(false);
      setEditingPurchaseId(null);
      await loadPurchases();
    } catch (err) {
      alert("Error: " + err.message);
    }
    setSavingPurchase(false);
  };

  // ── Delete ─────────────────────────────────────────────────────────────────

  const openDeleteModal = (target) => {
    setDeleteTarget(target);
    setDeleteError("");
    setDeleteJournalId(null);
    setShowReversalInput(false);
    setReversalReason("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    try {
      const url = deleteTarget.type === "supplier"
        ? `/api/suppliers/${deleteTarget.id}`
        : `/api/purchases/${deleteTarget.id}`;
      const res  = await fetch(url, { method: "DELETE" });
      const json = await res.json();
      if (res.status === 409) {
        setDeleteError(json.error || "Cannot delete — there is a posted journal entry.");
        if (json.journal_entry_id) setDeleteJournalId(json.journal_entry_id);
        return;
      }
      if (!json.success) throw new Error(json.error || "Delete failed");
      setDeleteTarget(null);
      if (deleteTarget.type === "supplier") {
        await loadSuppliers();
      } else {
        await loadPurchases();
        setExpandedPurchase(null);
      }
    } catch (err) {
      setDeleteError("Error: " + err.message);
    }
  };

  const confirmReversal = async () => {
    if (!deleteJournalId || !reversalReason.trim()) return;
    setReversing(true);
    setDeleteError("");
    try {
      const res  = await fetch(`/api/journal-entries/${deleteJournalId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reversalReason.trim() }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Reversal failed");
      // Reversal succeeded — now retry the delete
      setDeleteJournalId(null);
      setShowReversalInput(false);
      setReversalReason("");
      await confirmDelete();
    } catch (err) {
      setDeleteError("Reversal failed: " + err.message);
    }
    setReversing(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!loaded) return <div style={{ padding: "40px", textAlign: "center", color: "#aaa" }}>Loading...</div>;

  return (
    <div style={{ padding: "20px 16px" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>Suppliers</h1>
          <p style={{ fontSize: "13px", color: "#999" }}>
            {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""} · {purchases.length} purchase{purchases.length !== 1 ? "s" : ""}
          </p>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => openAddPurchase()} style={{
              padding: "9px 18px", borderRadius: "7px", border: "1.5px solid #e0e0e0",
              background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer",
            }}>+ Purchase</button>
            <button onClick={openAddSupplier} style={{
              padding: "9px 18px", borderRadius: "7px", border: "none",
              background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer",
            }}>+ Supplier</button>
          </div>
        )}
      </div>

      {/* ── KPI Bar ── */}
      {(() => {
        const totalAP        = suppliers.reduce((sum, s) => sum + (s._stats?.balance_owed    || 0), 0);
        const thisMonthSpend = suppliers.reduce((sum, s) => sum + (s._stats?.this_month_spend || 0), 0);
        const paidUpCount    = suppliers.filter(s => (s._stats?.balance_owed || 0) <= 0).length;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px", marginBottom: "18px" }}>
            {[
              { label: "Suppliers",        value: suppliers.length,                        color: "#1a1a1a" },
              { label: "Total AP balance", value: fmt(totalAP),                            color: totalAP > 0 ? "#C62828" : "#065F46" },
              { label: "This month",       value: fmt(thisMonthSpend),                     color: "#E8512A" },
              { label: "Paid up",          value: `${paidUpCount} / ${suppliers.length}`,  color: "#065F46" },
            ].map(card => (
              <div key={card.label} style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "12px 14px" }}>
                <div style={{ fontSize: "10px", color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>{card.label}</div>
                <div style={{ fontSize: "17px", fontWeight: 700, color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "0", marginBottom: "20px", borderBottom: "2px solid #e8e8e5" }}>
        {[
          { key: "suppliers", label: `Suppliers (${suppliers.length})` },
          { key: "purchases", label: `Purchases (${purchases.length})` },
          { key: "payments",  label: "Payments" },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: "10px 20px", fontSize: "13px", fontWeight: 600,
            border: "none", background: "none", cursor: "pointer",
            color: tab === t.key ? "#1a1a1a" : "#999",
            borderBottom: tab === t.key ? "2px solid #E8512A" : "2px solid transparent",
            marginBottom: "-2px",
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── SUPPLIERS TAB ────────────────────────────────────────── */}
      {tab === "suppliers" && (
        <>
          <input
            type="text" placeholder="Search suppliers..." value={supplierSearch}
            onChange={e => setSupplierSearch(e.target.value)}
            style={{ width: "100%", padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "14px", background: "#fff", marginBottom: "14px", boxSizing: "border-box" }}
          />

          {filteredSuppliers.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center" }}>
              <div style={{ width: "52px", height: "52px", background: "#f0ede8", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
              </div>
              <div style={{ fontSize: "14px", fontWeight: 500, color: "#555", marginBottom: "4px" }}>{supplierSearch ? "No suppliers match your search." : "No suppliers yet."}</div>
              {!supplierSearch && <div style={{ fontSize: "12px", color: "#999", marginBottom: "14px" }}>Add your first supplier to start tracking purchases.</div>}
              {canWrite && !supplierSearch && (
                <button onClick={openAddSupplier} style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  + Add supplier
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {filteredSuppliers.map(s => (
                <div key={s.id}
                  style={{ background: "#fff", border: "1px solid #e8e8e5", borderRadius: "10px", padding: "13px 16px", display: "flex", alignItems: "center", gap: "12px", cursor: "pointer", transition: "background 0.12s" }}
                  onClick={() => router.push(`/suppliers/${s.id}`)}
                  onMouseEnter={e => e.currentTarget.style.background = "#faf9f7"}
                  onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                >
                  <Avatar name={s.name} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Name row — chip truncated, both nowrap */}
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                      <span style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 0" }}>{s.name}</span>
                      {s.materials_supplied && (
                        <span style={{ fontSize: "10px", fontWeight: 600, background: "#f0ede8", color: "#555", padding: "2px 8px", borderRadius: "10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "90px", flexShrink: 0 }}>
                          {s.materials_supplied.split(",")[0].trim()}
                        </span>
                      )}
                    </div>
                    {/* Subtitle — phone · contact, single line */}
                    <div style={{ fontSize: "12px", color: "#888", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[s.phone, s.contact_person].filter(Boolean).join(" · ")}
                      {(s._stats?.purchase_count || 0) > 0 && ` · ${s._stats.purchase_count} purchase${s._stats.purchase_count !== 1 ? "s" : ""}`}
                    </div>
                  </div>

                  {/* Balance — compact on mobile */}
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {(s._stats?.balance_owed || 0) > 0 ? (
                      <>
                        <div style={{ fontSize: "13px", fontWeight: 700, color: "#C62828", whiteSpace: "nowrap" }}>{fmt(s._stats.balance_owed)} owed</div>
                        {(s._stats?.total_purchased || 0) > 0 && (
                          <div style={{ fontSize: "10px", color: "#bbb", marginTop: "1px", whiteSpace: "nowrap" }}>of {fmt(s._stats.total_purchased)}</div>
                        )}
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: "13px", fontWeight: 600, color: "#16a34a", whiteSpace: "nowrap" }}>Paid up</div>
                        {(s._stats?.total_purchased || 0) > 0 && <div style={{ fontSize: "10px", color: "#bbb", marginTop: "1px", whiteSpace: "nowrap" }}>{fmt(s._stats.total_purchased)}</div>}
                      </>
                    )}
                  </div>

                  {/* Action buttons — hidden on mobile (access via profile) */}
                  {canWrite && !isMobile && (
                    <div style={{ display: "flex", gap: "4px", flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                      <button
                        onClick={e => openEditSupplier(s, e)}
                        style={{ padding: "5px 10px", borderRadius: "5px", border: "1px solid #e8e5e0", background: "none", color: "#888", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
                      >Edit</button>
                      <button
                        onClick={() => openAddPurchase(s.id)}
                        style={{ padding: "5px 10px", borderRadius: "5px", border: "1px solid #e8e5e0", background: "none", color: "#555", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
                      >+ Purchase</button>
                    </div>
                  )}

                  <span style={{ color: "#ccc", fontSize: "14px", flexShrink: 0 }}>›</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── PURCHASES TAB ────────────────────────────────────────── */}
      {tab === "purchases" && (
        <>
          <SummaryBar purchases={purchases} />

          {/* Filters */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
            <input
              type="text" placeholder="Search purchases..." value={purchaseSearch}
              onChange={e => setPurchaseSearch(e.target.value)}
              style={{ flex: "1 1 200px", padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "14px", background: "#fff", minWidth: "160px" }}
            />
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", cursor: "pointer" }}>
              <option value="All">All statuses</option>
              <option value="Unpaid">Unpaid</option>
              <option value="Part Paid">Part Paid</option>
              <option value="Paid">Paid</option>
            </select>
            <select value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={{ padding: "9px 14px", borderRadius: "8px", border: "1.5px solid #e0e0e0", fontSize: "13px", background: "#fff", cursor: "pointer" }}>
              <option value="All">All suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          {filteredPurchases.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center" }}>
              <div style={{ width: "52px", height: "52px", background: "#f0ede8", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
              </div>
              <div style={{ fontSize: "14px", fontWeight: 500, color: "#555", marginBottom: "4px" }}>{purchaseSearch || filterStatus !== "All" || filterSupplier !== "All" ? "No purchases match your filters." : "No purchases yet."}</div>
              {canWrite && !purchaseSearch && filterStatus === "All" && filterSupplier === "All" && (
                <>
                  <div style={{ fontSize: "12px", color: "#999", marginBottom: "14px" }}>Record purchases from your suppliers to track spend.</div>
                  <button onClick={() => openAddPurchase()} style={{ padding: "8px 20px", borderRadius: "6px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                    + Record purchase
                  </button>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {filteredPurchases.map(p => {
                const balance    = parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0);
                const isExpanded = expandedPurchase === p.id;
                const sc         = STATUS_COLORS[p.payment_status] || {};

                return (
                  <div key={p.id} style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5", borderLeft: `4px solid ${sc.border || "#e0e0e0"}`, overflow: "hidden", cursor: "pointer" }}
                    onClick={() => setExpandedPurchase(isExpanded ? null : p.id)}>
                    {/* Row */}
                    <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 200px" }}>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{p.suppliers?.name || "Unknown supplier"}</div>
                        <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>
                          {p.purchase_date}
                          {(p.purchase_order_links || []).length > 0 && (
                            <span style={{ color: "#E8512A", marginLeft: "8px" }}>
                              → {p.purchase_order_links.map(l => l.orders?.order_num).filter(Boolean).join(", ")}
                            </span>
                          )}
                        </div>
                        {p.items_bought && <div style={{ fontSize: "11px", color: "#aaa", marginTop: "2px" }}>{p.items_bought.substring(0, 80)}{p.items_bought.length > 80 ? "…" : ""}</div>}
                      </div>
                      <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{fmt(p.total_amount)}</div>
                          {balance > 0 && <div style={{ fontSize: "11px", color: "#92400E" }}>{fmt(balance)} owed</div>}
                        </div>
                        <StatusBadge status={p.payment_status} />
                        {p.journal_entry_id
                          ? <span style={{ fontSize: "10px", fontWeight: 700, color: "#065F46", background: "#D1FAE5", border: "1px solid #6EE7B7", padding: "2px 7px", borderRadius: "4px", whiteSpace: "nowrap" }}>Posted</span>
                          : <span style={{ fontSize: "10px", fontWeight: 600, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", padding: "2px 7px", borderRadius: "4px", whiteSpace: "nowrap" }}>Unposted</span>
                        }
                      </div>
                      <span style={{ fontSize: "16px", color: "#ccc", transition: "transform 0.15s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
                    </div>

                    {/* Expanded */}
                    {isExpanded && (
                      <div style={{ padding: "0 16px 16px", borderTop: "1px solid #f0ede8" }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", paddingTop: "14px" }} className="detail-grid">
                          <div><div style={ss.label}>Supplier</div><div style={{ fontSize: "13px", color: "#333", fontWeight: 600 }}>{p.suppliers?.name}</div></div>
                          <div><div style={ss.label}>Date</div><div style={{ fontSize: "13px", color: "#333" }}>{p.purchase_date}</div></div>
                          <div><div style={ss.label}>Total amount</div><div style={{ fontSize: "13px", fontWeight: 700, color: "#1a1a1a" }}>{fmt(p.total_amount)}</div></div>
                          <div><div style={ss.label}>Amount paid</div><div style={{ fontSize: "13px", color: "#065F46", fontWeight: 700 }}>{fmt(p.amount_paid)}</div></div>
                          <div><div style={ss.label}>Balance</div><div style={{ fontSize: "13px", fontWeight: 700, color: balance > 0 ? "#92400E" : "#065F46" }}>{fmt(balance)}</div></div>
                          <div><div style={ss.label}>Status</div><StatusBadge status={p.payment_status} /></div>
                          {(p.purchase_order_links || []).length > 0 && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={ss.label}>Linked order{p.purchase_order_links.length !== 1 ? "s" : ""}</div>
                              {p.purchase_order_links.map(l => (
                                <div key={l.order_id} style={{ fontSize: "13px", color: "#E8512A", fontWeight: 600, marginBottom: "2px" }}>
                                  {l.orders?.order_num} — {l.orders?.client}
                                </div>
                              ))}
                            </div>
                          )}
                          {p.items_bought && <div style={{ gridColumn: "1 / -1" }}><div style={ss.label}>Items bought</div><div style={{ fontSize: "13px", color: "#333", whiteSpace: "pre-line" }}>{p.items_bought}</div></div>}
                          {p.notes && <div style={{ gridColumn: "1 / -1" }}><div style={ss.label}>Notes</div><div style={{ fontSize: "13px", color: "#666", fontStyle: "italic" }}>{p.notes}</div></div>}
                          {(() => {
                            const cat = accountingCategories.find(c => c.id === p.accounting_category_id);
                            return cat ? (
                              <div><div style={ss.label}>Accounting category</div><div style={{ fontSize: "13px", color: "#333" }}>{cat.label}</div></div>
                            ) : null;
                          })()}
                          <div>
                            <div style={ss.label}>Journal entry</div>
                            {p.journal_entry_id
                              ? <span style={{ fontSize: "12px", fontWeight: 700, color: "#065F46", background: "#D1FAE5", border: "1px solid #6EE7B7", padding: "3px 8px", borderRadius: "4px" }}>✓ Posted</span>
                              : <span style={{ fontSize: "12px", fontWeight: 600, color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", padding: "3px 8px", borderRadius: "4px" }}>Not posted</span>
                            }
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: "8px", marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #f0ede8", flexWrap: "wrap" }}>
                          {canWrite && (
                            <button onClick={e => openEditPurchase(p, e)} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button onClick={e => { e.stopPropagation(); openDeleteModal({ type: "purchase", id: p.id, label: `${p.suppliers?.name} — ${p.purchase_date}` }); }} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #FFCDD2", background: "#FFF5F5", color: "#C62828", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── PAYMENTS TAB ─────────────────────────────────────────── */}
      {tab === "payments" && (
        <PaymentsTab suppliers={suppliers} />
      )}

      {/* ── SUPPLIER FORM MODAL ───────────────────────────────────── */}
      {showSupplierForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => { setShowSupplierForm(false); setEditingSupplierId(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "20px" }}>
              {editingSupplierId ? "Edit Supplier" : "Add Supplier"}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }} className="form-grid">
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Supplier name *</label>
                <input style={ss.input} value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} placeholder="e.g. Karuri Timber Ltd" />
              </div>
              <div>
                <label style={ss.label}>Contact person</label>
                <input style={ss.input} value={supplierForm.contact_person} onChange={e => setSupplierForm({ ...supplierForm, contact_person: e.target.value })} placeholder="e.g. James Karuri" />
              </div>
              <div>
                <label style={ss.label}>Phone</label>
                <input style={ss.input} type="tel" value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} placeholder="e.g. 0712 XXX XXX" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Email</label>
                <input style={ss.input} type="email" value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} placeholder="e.g. info@karuri.co.ke" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Materials supplied</label>
                <input style={ss.input} value={supplierForm.materials_supplied} onChange={e => setSupplierForm({ ...supplierForm, materials_supplied: e.target.value })} placeholder="e.g. Mahogany, MDF, Plywood" />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Notes</label>
                <textarea style={ss.textarea} value={supplierForm.notes} onChange={e => setSupplierForm({ ...supplierForm, notes: e.target.value })} placeholder="e.g. Best pricing on bulk orders above 50 boards" />
              </div>
              {/* ── Opening balance (existing debt before tracker was set up) ── */}
              {(() => {
                const editingSupplier = editingSupplierId ? suppliers.find(s => s.id === editingSupplierId) : null;
                const obPosted = !!(editingSupplier?.opening_balance_journal_entry_id);
                const obInputStyle = { ...ss.input, ...(obPosted ? { opacity: 0.5, cursor: "not-allowed", background: "#f5f5f5" } : {}) };
                return (
                  <div style={{ gridColumn: "1 / -1", borderTop: "1px dashed #e0e0e0", paddingTop: "14px", marginTop: "4px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                      <span style={{ fontSize: "11px", fontWeight: 600, color: "#999", textTransform: "uppercase", letterSpacing: "0.5px" }}>Opening Balance (optional)</span>
                      {obPosted && <span style={{ fontSize: "10px", fontWeight: 700, color: "#065F46", background: "#D1FAE5", border: "1px solid #6EE7B7", padding: "2px 7px", borderRadius: "4px" }}>Posted — read only</span>}
                    </div>
                    {obPosted && (
                      <div style={{ fontSize: "12px", color: "#92400E", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "6px", padding: "8px 12px", marginBottom: "10px" }}>
                        This opening balance has been posted to the General Ledger. To change it, create a reversal entry from the journal.
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                      <div>
                        <label style={ss.label}>Amount owed (KSh)</label>
                        <input style={obInputStyle} type="number" min="0" step="1" readOnly={obPosted} value={supplierForm.opening_balance} onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance: e.target.value })} placeholder="0" />
                      </div>
                      <div>
                        <label style={ss.label}>As of date</label>
                        <input style={obInputStyle} type="date" readOnly={obPosted} value={supplierForm.opening_balance_date} onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance_date: e.target.value })} />
                      </div>
                      <div style={{ gridColumn: "1 / -1" }}>
                        <label style={ss.label}>Notes on opening balance</label>
                        <input style={obInputStyle} readOnly={obPosted} value={supplierForm.opening_balance_notes} onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance_notes: e.target.value })} placeholder="e.g. Balance carried forward from before Jan 2025" />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
              <button onClick={() => { setShowSupplierForm(false); setEditingSupplierId(null); }} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveSupplier} disabled={savingSupplier} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: savingSupplier ? "not-allowed" : "pointer", opacity: savingSupplier ? 0.6 : 1 }}>
                {savingSupplier ? "Saving..." : editingSupplierId ? "Update" : "Add Supplier"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PURCHASE FORM MODAL ───────────────────────────────────── */}
      {showPurchaseForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => { setShowPurchaseForm(false); setEditingPurchaseId(null); }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "520px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "20px" }}>
              {editingPurchaseId ? "Edit Purchase" : "Record Purchase"}
            </h2>
            {editingPurchaseId && purchases.find(p => p.id === editingPurchaseId)?.journal_entry_id && (
              <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "7px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: "#92400E" }}>
                <strong>Posted purchase — </strong>supplier, date, amounts and category are locked by the General Ledger. Only description, notes and linked orders can be changed.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }} className="form-grid">
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Supplier *</label>
                {purchaseForm.supplier_id ? (() => {
                  const linked = suppliers.find(s => s.id === purchaseForm.supplier_id);
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "9px 12px", border: "1.5px solid #1a1a1a", borderRadius: "6px", background: "#f9f9f7" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: "13px", fontWeight: 700, color: "#1a1a1a" }}>{linked?.name}</span>
                        {linked?.contact_person && <span style={{ fontSize: "12px", color: "#888", marginLeft: "8px" }}>{linked.contact_person}</span>}
                        {linked?.materials_supplied && <span style={{ fontSize: "11px", color: "#aaa", marginLeft: "8px", fontStyle: "italic" }}>{linked.materials_supplied}</span>}
                      </div>
                      <button type="button" onClick={() => setPurchaseForm({ ...purchaseForm, supplier_id: "" })} style={{ background: "none", border: "none", cursor: "pointer", color: "#999", fontSize: "16px", padding: "0 4px", lineHeight: 1 }} title="Change supplier">✕</button>
                    </div>
                  );
                })() : (
                  <button type="button" onClick={() => { setSupplierPickerSearch(""); setShowSupplierPicker(true); }} style={{ width: "100%", padding: "9px 12px", border: "1.5px dashed #d0d0d0", borderRadius: "6px", background: "#fafafa", color: "#999", fontSize: "13px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                    + Select a supplier…
                  </button>
                )}
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Linked customer orders (optional)</label>
                {purchaseForm.order_ids.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                    {purchaseForm.order_ids.map(oid => {
                      const linked = orders.find(o => o.id === oid);
                      return (
                        <div key={oid} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 10px", border: "1.5px solid #E8512A", borderRadius: "6px", background: "#fff8f6" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700, color: "#E8512A" }}>{linked?.order_num}</span>
                          <span style={{ fontSize: "12px", color: "#333" }}>{linked?.client}</span>
                          <button type="button" onClick={() => setPurchaseForm({ ...purchaseForm, order_ids: purchaseForm.order_ids.filter(id => id !== oid) })} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "14px", padding: "0 2px", lineHeight: 1 }}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button type="button" onClick={() => { setOrderPickerSearch(""); setShowOrderPicker(true); }} style={{ width: "100%", padding: "9px 12px", border: "1.5px dashed #d0d0d0", borderRadius: "6px", background: "#fafafa", color: "#999", fontSize: "13px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                  {purchaseForm.order_ids.length > 0 ? "+ Add another order…" : "+ Link to a customer order…"}
                </button>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Purchase date</label>
                <input style={ss.input} type="date" value={purchaseForm.purchase_date} onChange={e => setPurchaseForm({ ...purchaseForm, purchase_date: e.target.value })} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Items bought</label>
                <textarea style={ss.textarea} value={purchaseForm.items_bought} onChange={e => setPurchaseForm({ ...purchaseForm, items_bought: e.target.value })} placeholder="e.g. 20 boards Mahogany 2×4, 5 sheets MDF 18mm" rows={3} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Accounting category</label>
                <select style={ss.input} value={purchaseForm.accounting_category_id} onChange={e => setPurchaseForm({ ...purchaseForm, accounting_category_id: e.target.value })}>
                  <option value="">— Select category (optional) —</option>
                  {accountingCategories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label style={ss.label}>Total amount (KSh) *</label>
                <input style={ss.input} type="number" min="0.01" step="1" value={purchaseForm.total_amount} onChange={e => setPurchaseForm({ ...purchaseForm, total_amount: e.target.value })} placeholder="0" />
              </div>
              <div>
                <label style={ss.label}>Amount paid (KSh)</label>
                <input style={ss.input} type="number" min="0" step="1" value={purchaseForm.amount_paid} onChange={e => setPurchaseForm({ ...purchaseForm, amount_paid: e.target.value })} placeholder="0" />
              </div>
              {purchaseForm.total_amount && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={{ fontSize: "12px", color: "#999", padding: "8px 12px", background: "#f9f9f7", borderRadius: "6px" }}>
                    Balance: <strong style={{ color: "#1a1a1a" }}>
                      {fmt((parseFloat(purchaseForm.total_amount) || 0) - (parseFloat(purchaseForm.amount_paid) || 0))}
                    </strong>
                    &nbsp;·&nbsp;Status will be auto-set to&nbsp;
                    <strong>
                      {(parseFloat(purchaseForm.amount_paid) || 0) <= 0 ? "Unpaid"
                        : (parseFloat(purchaseForm.amount_paid) || 0) >= (parseFloat(purchaseForm.total_amount) || 0) ? "Paid"
                        : "Part Paid"}
                    </strong>
                  </div>
                </div>
              )}
              {/* Initial payment method — only shown for new purchases when amount_paid > 0 */}
              {!editingPurchaseId && parseFloat(purchaseForm.amount_paid) > 0 && (
                <>
                  <div>
                    <label style={ss.label}>Payment method</label>
                    <select style={ss.input} value={purchaseForm.initial_payment_method} onChange={e => setPurchaseForm({ ...purchaseForm, initial_payment_method: e.target.value })}>
                      {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={ss.label}>Payment reference</label>
                    <input style={ss.input} value={purchaseForm.initial_payment_reference} onChange={e => setPurchaseForm({ ...purchaseForm, initial_payment_reference: e.target.value })} placeholder="e.g. QDK91XMPL" />
                  </div>
                </>
              )}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={ss.label}>Notes</label>
                <textarea style={ss.textarea} value={purchaseForm.notes} onChange={e => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} placeholder="e.g. Invoice #1234, paid via M-Pesa" rows={2} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "20px" }}>
              <button onClick={() => { setShowPurchaseForm(false); setEditingPurchaseId(null); }} style={{ padding: "10px 20px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={savePurchase} disabled={savingPurchase} style={{ padding: "10px 24px", borderRadius: "8px", border: "none", background: "#E8512A", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: savingPurchase ? "not-allowed" : "pointer", opacity: savingPurchase ? 0.6 : 1 }}>
                {savingPurchase ? "Saving..." : editingPurchaseId ? "Update" : "Record Purchase"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SUPPLIER PICKER MODAL ────────────────────────────────── */}
      {showSupplierPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => setShowSupplierPicker(false)}>
          <div style={{ background: "#fff", borderRadius: "12px", width: "100%", maxWidth: "480px", maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid #f0ede8", display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "10px" }}>Select supplier</div>
                <input
                  autoFocus
                  type="text"
                  placeholder="Search by name, contact or materials…"
                  value={supplierPickerSearch}
                  onChange={e => setSupplierPickerSearch(e.target.value)}
                  style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "7px", fontSize: "14px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" }}
                />
              </div>
              <button onClick={() => setShowSupplierPicker(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "20px", padding: "0 4px", flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>

            {/* Supplier list */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {(() => {
                const q = supplierPickerSearch.trim().toLowerCase();
                const filtered = q
                  ? suppliers.filter(s =>
                      [s.name, s.contact_person, s.phone, s.materials_supplied]
                        .filter(Boolean).join(" ").toLowerCase().includes(q)
                    )
                  : suppliers;

                if (filtered.length === 0) return (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "#aaa", fontSize: "13px" }}>
                    No suppliers match "{supplierPickerSearch}"
                  </div>
                );

                return filtered.map(s => (
                  <button key={s.id} type="button"
                    onClick={() => { setPurchaseForm({ ...purchaseForm, supplier_id: s.id }); setShowSupplierPicker(false); }}
                    style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", padding: "12px 20px", border: "none", borderBottom: "1px solid #f5f3ef", background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#f9f9f7"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#1a1a1a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, flexShrink: 0 }}>
                      {s.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#1a1a1a" }}>{s.name}</div>
                      <div style={{ fontSize: "12px", color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[s.contact_person, s.materials_supplied].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {s.phone && (
                      <div style={{ flexShrink: 0, fontSize: "12px", color: "#aaa", fontFamily: "monospace" }}>{s.phone}</div>
                    )}
                  </button>
                ));
              })()}
            </div>

            {/* Footer */}
            <div style={{ padding: "12px 20px", borderTop: "1px solid #f0ede8", fontSize: "12px", color: "#bbb", textAlign: "right" }}>
              {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      )}

      {/* ── ORDER PICKER MODAL ───────────────────────────────────── */}
      {showOrderPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => setShowOrderPicker(false)}>
          <div style={{ background: "#fff", borderRadius: "12px", width: "100%", maxWidth: "520px", maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid #f0ede8", display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "10px" }}>Link customer orders</div>
                <input
                  autoFocus
                  type="text"
                  placeholder="Search by order number or client name…"
                  value={orderPickerSearch}
                  onChange={e => setOrderPickerSearch(e.target.value)}
                  style={{ width: "100%", padding: "9px 12px", border: "1.5px solid #e0e0e0", borderRadius: "7px", fontSize: "14px", background: "#fafafa", boxSizing: "border-box", fontFamily: "inherit" }}
                />
              </div>
              <button onClick={() => setShowOrderPicker(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "20px", padding: "0 4px", flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>

            {/* Order list */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {(() => {
                const BLOCKED = ["Closed", "Cancelled", "Cancelled/Refunded", "Refunded"];
                const q = orderPickerSearch.trim().toLowerCase();
                const eligible = orders.filter(o => !BLOCKED.includes(o.status));
                const filtered = q
                  ? eligible.filter(o => (o.order_num || "").toLowerCase().includes(q) || (o.client || "").toLowerCase().includes(q))
                  : eligible;

                if (filtered.length === 0) return (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: "#aaa", fontSize: "13px" }}>
                    {q ? `No open orders match "${orderPickerSearch}"` : "No open orders available"}
                  </div>
                );

                return filtered.slice(0, 80).map(o => {
                  const isSelected = purchaseForm.order_ids.includes(o.id);
                  return (
                    <button key={o.id} type="button"
                      onClick={() => {
                        setPurchaseForm({
                          ...purchaseForm,
                          order_ids: isSelected
                            ? purchaseForm.order_ids.filter(id => id !== o.id)
                            : [...purchaseForm.order_ids, o.id],
                        });
                      }}
                      style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", padding: "12px 20px", border: "none", borderBottom: "1px solid #f5f3ef", background: isSelected ? "#fff8f6" : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#fef8f6"; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "none"; }}>
                      <div style={{ width: "20px", flexShrink: 0, textAlign: "center" }}>
                        {isSelected && <span style={{ color: "#E8512A", fontWeight: 700, fontSize: "14px" }}>✓</span>}
                      </div>
                      <div style={{ width: "80px", flexShrink: 0 }}>
                        <span style={{ fontSize: "13px", fontWeight: 700, color: "#E8512A", fontFamily: "monospace" }}>{o.order_num}</span>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "13px", fontWeight: 600, color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.client}</div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        <span style={{ fontSize: "11px", color: "#888", background: "#f5f3ef", padding: "2px 8px", borderRadius: "4px" }}>{o.status}</span>
                      </div>
                    </button>
                  );
                });
              })()}
            </div>

            {/* Footer */}
            <div style={{ padding: "12px 20px", borderTop: "1px solid #f0ede8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "12px", color: "#aaa" }}>
                {purchaseForm.order_ids.length > 0
                  ? `${purchaseForm.order_ids.length} order${purchaseForm.order_ids.length !== 1 ? "s" : ""} selected`
                  : `${orders.filter(o => !["Closed","Cancelled","Cancelled/Refunded","Refunded"].includes(o.status)).length} open orders`}
              </span>
              <button onClick={() => setShowOrderPicker(false)} style={{ padding: "8px 20px", borderRadius: "7px", border: "none", background: "#1a1a1a", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRM ────────────────────────────────────────── */}
      {deleteTarget && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={() => { if (!reversing) { setDeleteTarget(null); setDeleteError(""); setDeleteJournalId(null); setShowReversalInput(false); setReversalReason(""); } }}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "400px" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "24px", marginBottom: "12px" }}>⚠️</div>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>
              Delete {deleteTarget.type === "supplier" ? "Supplier" : "Purchase"}
            </h3>
            <p style={{ fontSize: "13px", color: "#666", marginBottom: "16px" }}>
              Delete <strong>{deleteTarget.label}</strong>? This cannot be undone.
              {deleteTarget.type === "supplier" && " Suppliers with purchases cannot be deleted."}
            </p>

            {/* 409 error — journal entry blocks deletion */}
            {deleteError && !showReversalInput && (
              <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: "7px", padding: "12px 14px", marginBottom: "14px" }}>
                <div style={{ fontSize: "12px", color: "#92400E", marginBottom: deleteJournalId ? "10px" : 0 }}>{deleteError}</div>
                {deleteJournalId && (
                  <button
                    onClick={() => { setShowReversalInput(true); setDeleteError(""); }}
                    style={{ padding: "6px 14px", borderRadius: "6px", border: "none", background: "#92400E", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                    Reverse journal entry first
                  </button>
                )}
              </div>
            )}

            {/* Reversal reason input */}
            {showReversalInput && (
              <div style={{ background: "#f9f9f7", border: "1px solid #e0e0e0", borderRadius: "7px", padding: "12px 14px", marginBottom: "14px" }}>
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#333", marginBottom: "8px" }}>Why are you reversing this journal entry?</div>
                <textarea
                  autoFocus
                  style={{ ...ss.textarea, minHeight: "50px", marginBottom: "10px" }}
                  value={reversalReason}
                  onChange={e => setReversalReason(e.target.value)}
                  placeholder="e.g. Wrong category — re-posting with correct account"
                />
                {deleteError && <div style={{ fontSize: "12px", color: "#C62828", marginBottom: "8px" }}>{deleteError}</div>}
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={() => { setShowReversalInput(false); setDeleteError(""); setReversalReason(""); }} style={{ flex: 1, padding: "7px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>Back</button>
                  <button onClick={confirmReversal} disabled={reversing || !reversalReason.trim()} style={{ flex: 2, padding: "7px", borderRadius: "6px", border: "none", background: reversalReason.trim() && !reversing ? "#1a1a1a" : "#ccc", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: reversalReason.trim() && !reversing ? "pointer" : "not-allowed" }}>
                    {reversing ? "Reversing…" : "Reverse & delete"}
                  </button>
                </div>
              </div>
            )}

            {!showReversalInput && (
              <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                <button onClick={() => { setDeleteTarget(null); setDeleteError(""); setDeleteJournalId(null); }} style={{ padding: "9px 18px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                {!deleteError && <button onClick={confirmDelete} style={{ padding: "9px 18px", borderRadius: "8px", border: "none", background: "#C62828", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Delete</button>}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 640px) {
          .detail-grid { grid-template-columns: 1fr !important; }
          .form-grid   { grid-template-columns: 1fr !important; }
          .form-grid > div[style*="1 / -1"] { grid-column: 1 !important; }
        }
      `}</style>
    </div>
  );
}
