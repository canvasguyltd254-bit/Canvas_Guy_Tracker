"use client";
import { useState, useEffect, useMemo } from "react";
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
};

const EMPTY_PURCHASE = {
  supplier_id: "", order_ids: [], purchase_date: new Date().toISOString().split("T")[0],
  items_bought: "", total_amount: "", amount_paid: "", notes: "",
};

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

// ── Main component ────────────────────────────────────────────────────────────

export default function SuppliersModule() {
  const [userRole, setUserRole] = useState("viewer");
  const [tab, setTab] = useState("suppliers");   // "suppliers" | "purchases"
  const [loaded, setLoaded] = useState(false);

  // Data
  const [suppliers, setSuppliers]   = useState([]);
  const [purchases, setPurchases]   = useState([]);
  const [orders, setOrders]         = useState([]);

  // Supplier list state
  const [supplierSearch, setSupplierSearch] = useState("");
  const [expandedSupplier, setExpandedSupplier] = useState(null);

  // Purchase list state
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [filterStatus, setFilterStatus]     = useState("All");
  const [filterSupplier, setFilterSupplier] = useState("All");
  const [expandedPurchase, setExpandedPurchase] = useState(null);

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

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null); // { type, id, label }

  const canWrite  = WRITE_ROLES.includes(userRole);
  const canDelete = ["admin"].includes(userRole);

  const sb = createClient();

  // ── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (user) {
        const { data: profile } = await sb.from("user_profiles").select("role").eq("id", user.id).single();
        if (profile) setUserRole(profile.role);
      }
      await Promise.all([loadSuppliers(), loadPurchases(), loadOrders()]);
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
      supplier_id:    p.supplier_id || "",
      order_ids:      (p.purchase_order_links || []).map(l => l.order_id),
      purchase_date:  p.purchase_date || new Date().toISOString().split("T")[0],
      items_bought:   p.items_bought || "",
      total_amount:   p.total_amount || "",
      amount_paid:    p.amount_paid || "",
      notes:          p.notes || "",
    });
    setEditingPurchaseId(p.id);
    setShowPurchaseForm(true);
  };

  const savePurchase = async () => {
    if (!purchaseForm.supplier_id) { alert("Please select a supplier."); return; }
    if (!purchaseForm.total_amount || parseFloat(purchaseForm.total_amount) < 0) { alert("Total amount is required."); return; }
    setSavingPurchase(true);
    try {
      const url    = editingPurchaseId ? `/api/purchases/${editingPurchaseId}` : "/api/purchases";
      const method = editingPurchaseId ? "PATCH" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(purchaseForm) });
      const json   = await res.json();
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

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const url = deleteTarget.type === "supplier"
        ? `/api/suppliers/${deleteTarget.id}`
        : `/api/purchases/${deleteTarget.id}`;
      const res  = await fetch(url, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Delete failed");
      setDeleteTarget(null);
      if (deleteTarget.type === "supplier") {
        await loadSuppliers();
        setExpandedSupplier(null);
      } else {
        await loadPurchases();
        setExpandedPurchase(null);
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
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
              <div style={{ fontSize: "36px", marginBottom: "12px" }}>🏭</div>
              <div style={{ fontSize: "14px", color: "#999" }}>{supplierSearch ? "No suppliers match your search." : "No suppliers yet."}</div>
              {canWrite && !supplierSearch && (
                <button onClick={openAddSupplier} style={{ marginTop: "14px", padding: "8px 20px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  Add your first supplier
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {filteredSuppliers.map(s => {
                const sPurchases = purchases.filter(p => p.supplier_id === s.id);
                const sTotal     = sPurchases.reduce((sum, p) => sum + parseFloat(p.total_amount || 0), 0);
                const sBalance   = sPurchases.reduce((sum, p) => sum + (parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0)), 0);
                const isExpanded = expandedSupplier === s.id;

                return (
                  <div key={s.id} style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e8e8e5", borderLeft: "4px solid #E8512A", overflow: "hidden", cursor: "pointer" }}
                    onClick={() => setExpandedSupplier(isExpanded ? null : s.id)}>
                    {/* Row */}
                    <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 200px" }}>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#1a1a1a" }}>{s.name}</div>
                        {s.contact_person && <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>{s.contact_person}</div>}
                        {s.materials_supplied && <div style={{ fontSize: "11px", color: "#aaa", marginTop: "2px", fontStyle: "italic" }}>{s.materials_supplied}</div>}
                      </div>
                      <div style={{ display: "flex", gap: "20px", alignItems: "center", flexWrap: "wrap" }}>
                        {s.phone && <a href={`tel:${s.phone}`} onClick={e => e.stopPropagation()} style={{ fontSize: "13px", color: "#1565C0", textDecoration: "none", fontFamily: "monospace" }}>{s.phone}</a>}
                        <div style={{ fontSize: "12px", color: "#999" }}>
                          {sPurchases.length} purchase{sPurchases.length !== 1 ? "s" : ""}
                          {sTotal > 0 && <> · {fmt(sTotal)}</>}
                          {sBalance > 0 && <span style={{ color: "#92400E" }}> · {fmt(sBalance)} owed</span>}
                        </div>
                      </div>
                      <span style={{ fontSize: "16px", color: "#ccc", transition: "transform 0.15s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
                    </div>

                    {/* Expanded */}
                    {isExpanded && (
                      <div style={{ padding: "0 16px 16px", borderTop: "1px solid #f0ede8" }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", paddingTop: "14px" }} className="detail-grid">
                          {s.phone  && <div><div style={ss.label}>Phone</div><a href={`tel:${s.phone}`} style={{ fontSize: "13px", color: "#1565C0" }}>{s.phone}</a></div>}
                          {s.email  && <div><div style={ss.label}>Email</div><a href={`mailto:${s.email}`} style={{ fontSize: "13px", color: "#1565C0" }}>{s.email}</a></div>}
                          {s.materials_supplied && <div style={{ gridColumn: "1 / -1" }}><div style={ss.label}>Materials supplied</div><div style={{ fontSize: "13px", color: "#333" }}>{s.materials_supplied}</div></div>}
                          {s.notes  && <div style={{ gridColumn: "1 / -1" }}><div style={ss.label}>Notes</div><div style={{ fontSize: "13px", color: "#666", fontStyle: "italic" }}>{s.notes}</div></div>}
                        </div>

                        {/* Purchase mini-list */}
                        {sPurchases.length > 0 && (
                          <div style={{ marginTop: "16px" }}>
                            <div style={ss.label}>Purchases</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "6px" }}>
                              {sPurchases.slice(0, 5).map(p => (
                                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#f9f9f7", borderRadius: "6px", flexWrap: "wrap", gap: "6px" }}>
                                  <div>
                                    <span style={{ fontSize: "12px", color: "#333", fontWeight: 600 }}>{p.purchase_date}</span>
                                    {p.items_bought && <span style={{ fontSize: "12px", color: "#999", marginLeft: "8px" }}>{p.items_bought.substring(0, 50)}{p.items_bought.length > 50 ? "…" : ""}</span>}
                                  </div>
                                  <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#333" }}>{fmt(p.total_amount)}</span>
                                    <StatusBadge status={p.payment_status} />
                                  </div>
                                </div>
                              ))}
                              {sPurchases.length > 5 && <div style={{ fontSize: "12px", color: "#999", paddingLeft: "4px" }}>+{sPurchases.length - 5} more — see Purchases tab</div>}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div style={{ display: "flex", gap: "8px", marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #f0ede8", flexWrap: "wrap" }}>
                          {canWrite && (
                            <>
                              <button onClick={() => openAddPurchase(s.id)} style={{ padding: "7px 14px", borderRadius: "6px", border: "none", background: "#E8512A", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                                + Add Purchase
                              </button>
                              <button onClick={e => openEditSupplier(s, e)} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                                Edit
                              </button>
                            </>
                          )}
                          {canDelete && (
                            <button onClick={e => { e.stopPropagation(); setDeleteTarget({ type: "supplier", id: s.id, label: s.name }); }} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #FFCDD2", background: "#FFF5F5", color: "#C62828", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
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
              <div style={{ fontSize: "36px", marginBottom: "12px" }}>🧾</div>
              <div style={{ fontSize: "14px", color: "#999" }}>{purchaseSearch || filterStatus !== "All" || filterSupplier !== "All" ? "No purchases match your filters." : "No purchases yet."}</div>
              {canWrite && !purchaseSearch && filterStatus === "All" && filterSupplier === "All" && (
                <button onClick={() => openAddPurchase()} style={{ marginTop: "14px", padding: "8px 20px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  Record first purchase
                </button>
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
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: "8px", marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #f0ede8", flexWrap: "wrap" }}>
                          {canWrite && (
                            <button onClick={e => openEditPurchase(p, e)} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#333", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button onClick={e => { e.stopPropagation(); setDeleteTarget({ type: "purchase", id: p.id, label: `${p.suppliers?.name} — ${p.purchase_date}` }); }} style={{ padding: "7px 14px", borderRadius: "6px", border: "1.5px solid #FFCDD2", background: "#FFF5F5", color: "#C62828", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
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
              <div>
                <label style={ss.label}>Total amount (KSh) *</label>
                <input style={ss.input} type="number" min="0" step="1" value={purchaseForm.total_amount} onChange={e => setPurchaseForm({ ...purchaseForm, total_amount: e.target.value })} placeholder="0" />
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
          onClick={() => setDeleteTarget(null)}>
          <div style={{ background: "#fff", borderRadius: "12px", padding: "24px", width: "100%", maxWidth: "380px" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "24px", marginBottom: "12px" }}>⚠️</div>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>
              Delete {deleteTarget.type === "supplier" ? "Supplier" : "Purchase"}
            </h3>
            <p style={{ fontSize: "13px", color: "#666", marginBottom: "20px" }}>
              Delete <strong>{deleteTarget.label}</strong>? This cannot be undone.
              {deleteTarget.type === "supplier" && " Suppliers with purchases cannot be deleted."}
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteTarget(null)} style={{ padding: "9px 18px", borderRadius: "8px", border: "1.5px solid #e0e0e0", background: "#fff", color: "#666", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={confirmDelete} style={{ padding: "9px 18px", borderRadius: "8px", border: "none", background: "#C62828", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Delete</button>
            </div>
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
