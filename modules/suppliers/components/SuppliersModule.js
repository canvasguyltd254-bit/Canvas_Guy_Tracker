"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/shared/supabase/client";
import { useAuth } from "@/shared/context/AuthContext";
import PaymentsTab from "./PaymentsTab";
import {
  C, Btn, Badge, Modal, PageHeader, StatCard, TabBar,
  Field, TInput, TSelect, TArea,
  Notice, Empty, Loading, Mono, fmtKes,
} from "@/shared/ui/ds";

// ── Constants ─────────────────────────────────────────────────────────────────

const WRITE_ROLES = ["admin", "production_manager", "head_of_sales"];

const STATUS_COLORS = {
  "Unpaid":    "amber",
  "Part Paid": "blue",
  "Paid":      "green",
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

const PAYMENT_METHODS = ["Cash", "M-Pesa", "Bank Transfer", "Cheque", "Other"];

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// ── Sub-components ────────────────────────────────────────────────────────────

function Avatar({ name, size = 40 }) {
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const colors   = [C.coral, C.ink, C.blue, C.green, C.purple, "#DB2777"];
  const idx      = name ? name.charCodeAt(0) % colors.length : 0;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: colors[idx],
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, fontSize: size * 0.35, fontWeight: 700, color: "#fff",
      letterSpacing: "-0.5px",
    }}>
      {initials}
    </div>
  );
}

function SummaryBar({ purchases }) {
  const total      = purchases.reduce((s, p) => s + parseFloat(p.total_amount || 0), 0);
  const paid       = purchases.reduce((s, p) => s + parseFloat(p.amount_paid  || 0), 0);
  const balance    = total - paid;
  const unpaidCount = purchases.filter(p => p.payment_status !== "Paid").length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 20 }}>
      <StatCard label="Total spend"  value={fmtKes(total)}    mono />
      <StatCard label="Total paid"   value={fmtKes(paid)}     mono />
      <StatCard label="Outstanding"  value={fmtKes(balance)}  mono alert={balance > 0} />
      <StatCard label="Unpaid bills" value={unpaidCount}           alert={unpaidCount > 0} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SuppliersModule() {
  const { userRole = 'viewer', loaded: authLoaded } = useAuth();
  const [tab, setTab] = useState("suppliers");
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
  const [deleteTarget, setDeleteTarget]           = useState(null);
  const [deleteError, setDeleteError]             = useState("");
  const [deleteJournalId, setDeleteJournalId]     = useState(null);
  const [showReversalInput, setShowReversalInput] = useState(false);
  const [reversalReason, setReversalReason]       = useState("");
  const [reversing, setReversing]                 = useState(false);

  const canWrite  = WRITE_ROLES.includes(userRole);
  const canDelete = ["admin"].includes(userRole);

  const router = useRouter();
  const sb = createClient();

  // ── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!authLoaded) return;
    (async () => {
      await Promise.all([loadSuppliers(), loadPurchases(), loadOrders(), loadAccountingCategories()]);
      setLoaded(true);
    })();
  }, [authLoaded]);

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

      // For posted purchases, only send editable fields — locked fields are rejected with 409
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

  if (!loaded) return <Loading style={{ padding: 60 }} />;

  const totalAP        = suppliers.reduce((sum, s) => sum + (s._stats?.balance_owed    || 0), 0);
  const thisMonthSpend = suppliers.reduce((sum, s) => sum + (s._stats?.this_month_spend || 0), 0);
  const paidUpCount    = suppliers.filter(s => (s._stats?.balance_owed || 0) <= 0).length;

  return (
    <div style={{ padding: "20px 16px" }}>

      <PageHeader
        title="Suppliers"
        description={`${suppliers.length} supplier${suppliers.length !== 1 ? "s" : ""} · ${purchases.length} purchase${purchases.length !== 1 ? "s" : ""}`}
        actions={canWrite && (
          <>
            <Btn onClick={() => openAddPurchase()}>+ Purchase</Btn>
            <Btn primary onClick={openAddSupplier}>+ Supplier</Btn>
          </>
        )}
      />

      {/* KPI Bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 18 }}>
        <StatCard label="Suppliers"        value={suppliers.length} />
        <StatCard label="Total AP balance" value={fmtKes(totalAP)}                          mono alert={totalAP > 0} />
        <StatCard label="This month"       value={fmtKes(thisMonthSpend)}                   mono />
        <StatCard label="Paid up"          value={`${paidUpCount} / ${suppliers.length}`} />
      </div>

      <TabBar
        tabs={[
          { key: "suppliers", label: `Suppliers (${suppliers.length})` },
          { key: "purchases", label: `Purchases (${purchases.length})` },
          { key: "payments",  label: "Payments" },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {/* ── SUPPLIERS TAB ─────────────────────────────────────────────────── */}
      {tab === "suppliers" && (
        <>
          <TInput
            type="text" placeholder="Search suppliers…" value={supplierSearch}
            onChange={e => setSupplierSearch(e.target.value)}
            style={{ marginBottom: 14 }}
          />

          {filteredSuppliers.length === 0 ? (
            <Empty
              message={supplierSearch ? "No suppliers match your search." : "No suppliers yet."}
              action={canWrite && !supplierSearch && (
                <Btn onClick={openAddSupplier}>+ Add supplier</Btn>
              )}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredSuppliers.map(s => (
                <div key={s.id}
                  style={{
                    background: C.card, border: `1px solid ${C.line}`,
                    borderRadius: C.radius, padding: "13px 16px",
                    display: "flex", alignItems: "center", gap: 12,
                    cursor: "pointer", transition: "background 0.12s",
                  }}
                  onClick={() => router.push(`/suppliers/${s.id}`)}
                  onMouseEnter={e => e.currentTarget.style.background = "#faf9f7"}
                  onMouseLeave={e => e.currentTarget.style.background = C.card}
                >
                  <Avatar name={s.name} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 0" }}>{s.name}</span>
                      {s.materials_supplied && (
                        <span style={{ fontSize: 10, fontWeight: 600, background: "#f0ede8", color: C.muted, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 90, flexShrink: 0 }}>
                          {s.materials_supplied.split(",")[0].trim()}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[s.phone, s.contact_person].filter(Boolean).join(" · ")}
                      {(s._stats?.purchase_count || 0) > 0 && ` · ${s._stats.purchase_count} purchase${s._stats.purchase_count !== 1 ? "s" : ""}`}
                    </div>
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {(s._stats?.balance_owed || 0) > 0 ? (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.red, whiteSpace: "nowrap", fontFamily: C.mono }}>
                          {fmt(s._stats.balance_owed)} owed
                        </div>
                        {(() => { const tot = (s._stats?.total_purchased || 0) + parseFloat(s.opening_balance || 0); return tot > 0 && (
                          <div style={{ fontSize: 10, color: C.faint, marginTop: 1, whiteSpace: "nowrap" }}>of {fmt(tot)}</div>
                        ); })()}
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.green, whiteSpace: "nowrap" }}>Paid up</div>
                        {(s._stats?.total_purchased || 0) > 0 && <div style={{ fontSize: 10, color: C.faint, marginTop: 1, whiteSpace: "nowrap" }}>{fmt(s._stats.total_purchased)}</div>}
                      </>
                    )}
                  </div>

                  {canWrite && !isMobile && (
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                      <Btn small onClick={e => openEditSupplier(s, e)}>Edit</Btn>
                      <Btn small onClick={() => openAddPurchase(s.id)}>+ Purchase</Btn>
                    </div>
                  )}

                  <span style={{ color: C.faint, fontSize: 14, flexShrink: 0 }}>›</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── PURCHASES TAB ─────────────────────────────────────────────────── */}
      {tab === "purchases" && (
        <>
          <SummaryBar purchases={purchases} />

          {/* Filters */}
          <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <TInput
              type="text" placeholder="Search purchases…" value={purchaseSearch}
              onChange={e => setPurchaseSearch(e.target.value)}
              style={{ flex: "1 1 200px", minWidth: 160 }}
            />
            <TSelect value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ width: "auto" }}>
              <option value="All">All statuses</option>
              <option value="Unpaid">Unpaid</option>
              <option value="Part Paid">Part Paid</option>
              <option value="Paid">Paid</option>
            </TSelect>
            <TSelect value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)} style={{ width: "auto" }}>
              <option value="All">All suppliers</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </TSelect>
          </div>

          {filteredPurchases.length === 0 ? (
            <Empty
              message={purchaseSearch || filterStatus !== "All" || filterSupplier !== "All" ? "No purchases match your filters." : "No purchases yet."}
              action={canWrite && !purchaseSearch && filterStatus === "All" && filterSupplier === "All" && (
                <Btn onClick={() => openAddPurchase()}>+ Record purchase</Btn>
              )}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filteredPurchases.map(p => {
                const balance    = parseFloat(p.total_amount || 0) - parseFloat(p.amount_paid || 0);
                const isExpanded = expandedPurchase === p.id;

                return (
                  <div key={p.id}
                    style={{
                      background: C.card, borderRadius: C.radius,
                      border: `1px solid ${C.line}`,
                      borderLeft: `4px solid ${p.payment_status === "Paid" ? C.greenBd : p.payment_status === "Part Paid" ? C.blueBd : C.amberBd}`,
                      overflow: "hidden", cursor: "pointer",
                    }}
                    onClick={() => setExpandedPurchase(isExpanded ? null : p.id)}>

                    {/* Row */}
                    <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 200px" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{p.suppliers?.name || "Unknown supplier"}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          <Mono>{p.purchase_date}</Mono>
                          {(p.purchase_order_links || []).length > 0 && (
                            <span style={{ color: C.coral, marginLeft: 8 }}>
                              → {p.purchase_order_links.map(l => l.orders?.order_num).filter(Boolean).join(", ")}
                            </span>
                          )}
                        </div>
                        {p.items_bought && <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{p.items_bought.substring(0, 80)}{p.items_bought.length > 80 ? "…" : ""}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink, fontFamily: C.mono }}>{fmt(p.total_amount)}</div>
                          {balance > 0 && <div style={{ fontSize: 11, color: C.amber, fontFamily: C.mono }}>{fmt(balance)} owed</div>}
                        </div>
                        <Badge color={STATUS_COLORS[p.payment_status] || "gray"}>{p.payment_status}</Badge>
                        {p.journal_entry_id
                          ? <Badge color="green">Posted</Badge>
                          : <Badge color="amber">Unposted</Badge>}
                      </div>
                      <span style={{ fontSize: 16, color: C.faint, transition: "transform 0.15s", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}>▾</span>
                    </div>

                    {/* Expanded */}
                    {isExpanded && (
                      <div style={{ padding: "0 16px 16px", borderTop: `1px solid ${C.line}` }} onClick={e => e.stopPropagation()}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, paddingTop: 14 }} className="detail-grid">
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Supplier</div>
                            <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{p.suppliers?.name}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Date</div>
                            <Mono style={{ fontSize: 13, color: C.ink }}>{p.purchase_date}</Mono>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Total amount</div>
                            <Mono style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{fmt(p.total_amount)}</Mono>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Amount paid</div>
                            <Mono style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>{fmt(p.amount_paid)}</Mono>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Balance</div>
                            <Mono style={{ fontSize: 13, fontWeight: 700, color: balance > 0 ? C.amber : C.green }}>{fmt(balance)}</Mono>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Status</div>
                            <Badge color={STATUS_COLORS[p.payment_status] || "gray"}>{p.payment_status}</Badge>
                          </div>
                          {(p.purchase_order_links || []).length > 0 && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>
                                Linked order{p.purchase_order_links.length !== 1 ? "s" : ""}
                              </div>
                              {p.purchase_order_links.map(l => (
                                <div key={l.order_id} style={{ fontSize: 13, color: C.coral, fontWeight: 600, marginBottom: 2, fontFamily: C.mono }}>
                                  {l.orders?.order_num} — {l.orders?.client}
                                </div>
                              ))}
                            </div>
                          )}
                          {p.items_bought && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Items bought</div>
                              <div style={{ fontSize: 13, color: C.ink, whiteSpace: "pre-line" }}>{p.items_bought}</div>
                            </div>
                          )}
                          {p.notes && (
                            <div style={{ gridColumn: "1 / -1" }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Notes</div>
                              <div style={{ fontSize: 13, color: C.muted, fontStyle: "italic" }}>{p.notes}</div>
                            </div>
                          )}
                          {(() => {
                            const cat = accountingCategories.find(c => c.id === p.accounting_category_id);
                            return cat ? (
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Accounting category</div>
                                <div style={{ fontSize: 13, color: C.ink }}>{cat.label}</div>
                              </div>
                            ) : null;
                          })()}
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>Journal entry</div>
                            {p.journal_entry_id
                              ? <Badge color="green">✓ Posted</Badge>
                              : <Badge color="amber">Not posted</Badge>}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: 8, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                          {canWrite && <Btn small onClick={e => openEditPurchase(p, e)}>Edit</Btn>}
                          {canDelete && (
                            <Btn small danger onClick={e => { e.stopPropagation(); openDeleteModal({ type: "purchase", id: p.id, label: `${p.suppliers?.name} — ${p.purchase_date}` }); }}>
                              Delete
                            </Btn>
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

      {/* ── PAYMENTS TAB ──────────────────────────────────────────────────── */}
      {tab === "payments" && <PaymentsTab suppliers={suppliers} />}

      {/* ── SUPPLIER FORM MODAL ───────────────────────────────────────────── */}
      {showSupplierForm && (
        <Modal
          title={editingSupplierId ? "Edit Supplier" : "Add Supplier"}
          onClose={() => { setShowSupplierForm(false); setEditingSupplierId(null); }}
          footer={
            <>
              <Btn onClick={() => { setShowSupplierForm(false); setEditingSupplierId(null); }}>Cancel</Btn>
              <Btn primary onClick={saveSupplier} disabled={savingSupplier}>
                {savingSupplier ? "Saving…" : editingSupplierId ? "Update" : "Add Supplier"}
              </Btn>
            </>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="form-grid">
            <Field label="Supplier name *" full>
              <TInput value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} placeholder="e.g. Karuri Timber Ltd" />
            </Field>
            <Field label="Contact person">
              <TInput value={supplierForm.contact_person} onChange={e => setSupplierForm({ ...supplierForm, contact_person: e.target.value })} placeholder="e.g. James Karuri" />
            </Field>
            <Field label="Phone">
              <TInput type="tel" value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} placeholder="e.g. 0712 XXX XXX" />
            </Field>
            <Field label="Email" full>
              <TInput type="email" value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} placeholder="e.g. info@karuri.co.ke" />
            </Field>
            <Field label="Materials supplied" full>
              <TInput value={supplierForm.materials_supplied} onChange={e => setSupplierForm({ ...supplierForm, materials_supplied: e.target.value })} placeholder="e.g. Mahogany, MDF, Plywood" />
            </Field>
            <Field label="Notes" full>
              <TArea value={supplierForm.notes} onChange={e => setSupplierForm({ ...supplierForm, notes: e.target.value })} placeholder="e.g. Best pricing on bulk orders above 50 boards" />
            </Field>

            {/* Opening balance section */}
            {(() => {
              const editingSupplier = editingSupplierId ? suppliers.find(s => s.id === editingSupplierId) : null;
              const obPosted = !!(editingSupplier?.opening_balance_journal_entry_id);
              const readOnlyStyle = obPosted ? { opacity: 0.5, cursor: "not-allowed", background: "#f5f5f5" } : {};
              return (
                <div style={{ gridColumn: "1 / -1", borderTop: `1px dashed ${C.line}`, paddingTop: 14, marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Opening Balance (optional)</span>
                    {obPosted && <Badge color="green">Posted — read only</Badge>}
                  </div>
                  {obPosted && (
                    <Notice color="amber" style={{ marginBottom: 10 }}>
                      This opening balance has been posted to the General Ledger. To change it, create a reversal entry from the journal.
                    </Notice>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                    <Field label="Amount owed (KSh)">
                      <TInput type="number" min="0" step="1" readOnly={obPosted} style={readOnlyStyle}
                        value={supplierForm.opening_balance}
                        onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance: e.target.value })}
                        placeholder="0" />
                    </Field>
                    <Field label="As of date">
                      <TInput type="date" readOnly={obPosted} style={readOnlyStyle}
                        value={supplierForm.opening_balance_date}
                        onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance_date: e.target.value })} />
                    </Field>
                    <Field label="Notes on opening balance" full>
                      <TInput readOnly={obPosted} style={readOnlyStyle}
                        value={supplierForm.opening_balance_notes}
                        onChange={e => !obPosted && setSupplierForm({ ...supplierForm, opening_balance_notes: e.target.value })}
                        placeholder="e.g. Balance carried forward from before Jan 2025" />
                    </Field>
                  </div>
                </div>
              );
            })()}
          </div>
        </Modal>
      )}

      {/* ── PURCHASE FORM MODAL ───────────────────────────────────────────── */}
      {showPurchaseForm && (
        <Modal
          title={editingPurchaseId ? "Edit Purchase" : "Record Purchase"}
          onClose={() => { setShowPurchaseForm(false); setEditingPurchaseId(null); }}
          footer={
            <>
              <Btn onClick={() => { setShowPurchaseForm(false); setEditingPurchaseId(null); }}>Cancel</Btn>
              <Btn primary onClick={savePurchase} disabled={savingPurchase}>
                {savingPurchase ? "Saving…" : editingPurchaseId ? "Update" : "Record Purchase"}
              </Btn>
            </>
          }
        >
          {editingPurchaseId && purchases.find(p => p.id === editingPurchaseId)?.journal_entry_id && (
            <Notice color="amber" style={{ marginBottom: 16 }}>
              <strong>Posted purchase — </strong>supplier, date, amounts and category are locked by the General Ledger. Only description, notes and linked orders can be changed.
            </Notice>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="form-grid">
            {/* Supplier picker */}
            <Field label="Supplier *" full>
              {purchaseForm.supplier_id ? (() => {
                const linked = suppliers.find(s => s.id === purchaseForm.supplier_id);
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: `1.5px solid ${C.ink}`, borderRadius: C.radiusSm, background: "#f9f9f7" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{linked?.name}</span>
                      {linked?.contact_person && <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{linked.contact_person}</span>}
                      {linked?.materials_supplied && <span style={{ fontSize: 11, color: C.faint, marginLeft: 8, fontStyle: "italic" }}>{linked.materials_supplied}</span>}
                    </div>
                    <button type="button" onClick={() => setPurchaseForm({ ...purchaseForm, supplier_id: "" })}
                      style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 16, padding: "0 4px", lineHeight: 1 }}>✕</button>
                  </div>
                );
              })() : (
                <button type="button" onClick={() => { setSupplierPickerSearch(""); setShowSupplierPicker(true); }}
                  style={{ width: "100%", padding: "9px 12px", border: `1.5px dashed ${C.line}`, borderRadius: C.radiusSm, background: "#fafafa", color: C.muted, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                  + Select a supplier…
                </button>
              )}
            </Field>

            {/* Linked orders */}
            <Field label="Linked customer orders (optional)" full>
              {purchaseForm.order_ids.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                  {purchaseForm.order_ids.map(oid => {
                    const linked = orders.find(o => o.id === oid);
                    return (
                      <div key={oid} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", border: `1.5px solid ${C.coralBd}`, borderRadius: C.radiusSm, background: C.coralBg }}>
                        <Mono style={{ fontSize: 13, fontWeight: 700, color: C.coral }}>{linked?.order_num}</Mono>
                        <span style={{ fontSize: 12, color: C.ink }}>{linked?.client}</span>
                        <button type="button" onClick={() => setPurchaseForm({ ...purchaseForm, order_ids: purchaseForm.order_ids.filter(id => id !== oid) })}
                          style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 14, padding: "0 2px", lineHeight: 1 }}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button type="button" onClick={() => { setOrderPickerSearch(""); setShowOrderPicker(true); }}
                style={{ width: "100%", padding: "9px 12px", border: `1.5px dashed ${C.line}`, borderRadius: C.radiusSm, background: "#fafafa", color: C.muted, fontSize: 13, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                {purchaseForm.order_ids.length > 0 ? "+ Add another order…" : "+ Link to a customer order…"}
              </button>
            </Field>

            <Field label="Purchase date" full>
              <TInput type="date" value={purchaseForm.purchase_date} onChange={e => setPurchaseForm({ ...purchaseForm, purchase_date: e.target.value })} />
            </Field>
            <Field label="Items bought" full>
              <TArea value={purchaseForm.items_bought} onChange={e => setPurchaseForm({ ...purchaseForm, items_bought: e.target.value })} placeholder="e.g. 20 boards Mahogany 2×4, 5 sheets MDF 18mm" rows={3} />
            </Field>
            <Field label="Accounting category" full>
              <TSelect value={purchaseForm.accounting_category_id} onChange={e => setPurchaseForm({ ...purchaseForm, accounting_category_id: e.target.value })}>
                <option value="">— Select category (optional) —</option>
                {accountingCategories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </TSelect>
            </Field>
            <Field label="Total amount (KSh) *">
              <TInput type="number" min="0.01" step="1" value={purchaseForm.total_amount} onChange={e => setPurchaseForm({ ...purchaseForm, total_amount: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Amount paid (KSh)">
              <TInput type="number" min="0" step="1" value={purchaseForm.amount_paid} onChange={e => setPurchaseForm({ ...purchaseForm, amount_paid: e.target.value })} placeholder="0" />
            </Field>

            {purchaseForm.total_amount && (
              <div style={{ gridColumn: "1 / -1" }}>
                <Notice color="blue" style={{ fontSize: 12 }}>
                  Balance: <Mono style={{ fontWeight: 700, color: C.ink }}>
                    {fmt((parseFloat(purchaseForm.total_amount) || 0) - (parseFloat(purchaseForm.amount_paid) || 0))}
                  </Mono>
                  &nbsp;·&nbsp;Status will be auto-set to&nbsp;
                  <strong>
                    {(parseFloat(purchaseForm.amount_paid) || 0) <= 0 ? "Unpaid"
                      : (parseFloat(purchaseForm.amount_paid) || 0) >= (parseFloat(purchaseForm.total_amount) || 0) ? "Paid"
                      : "Part Paid"}
                  </strong>
                </Notice>
              </div>
            )}

            {/* Initial payment method — only for new purchases when amount_paid > 0 */}
            {!editingPurchaseId && parseFloat(purchaseForm.amount_paid) > 0 && (
              <>
                <Field label="Payment method">
                  <TSelect value={purchaseForm.initial_payment_method} onChange={e => setPurchaseForm({ ...purchaseForm, initial_payment_method: e.target.value })}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </TSelect>
                </Field>
                <Field label="Payment reference">
                  <TInput value={purchaseForm.initial_payment_reference} onChange={e => setPurchaseForm({ ...purchaseForm, initial_payment_reference: e.target.value })} placeholder="e.g. QDK91XMPL" />
                </Field>
              </>
            )}

            <Field label="Notes" full>
              <TArea value={purchaseForm.notes} onChange={e => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} placeholder="e.g. Invoice #1234, paid via M-Pesa" rows={2} />
            </Field>
          </div>
        </Modal>
      )}

      {/* ── SUPPLIER PICKER MODAL (nested, zIndex 300) ───────────────────── */}
      {showSupplierPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setShowSupplierPicker(false)}>
          <div style={{ background: C.card, borderRadius: C.radius, width: "100%", maxWidth: 480, maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: C.ink }}>Select supplier</div>
                <TInput autoFocus type="text" placeholder="Search by name, contact or materials…"
                  value={supplierPickerSearch} onChange={e => setSupplierPickerSearch(e.target.value)} />
              </div>
              <button onClick={() => setShowSupplierPicker(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 20, padding: "0 4px", flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {(() => {
                const q = supplierPickerSearch.trim().toLowerCase();
                const filt = q
                  ? suppliers.filter(s => [s.name, s.contact_person, s.phone, s.materials_supplied].filter(Boolean).join(" ").toLowerCase().includes(q))
                  : suppliers;
                if (filt.length === 0) return (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: C.muted, fontSize: 13 }}>No suppliers match "{supplierPickerSearch}"</div>
                );
                return filt.map(s => (
                  <button key={s.id} type="button"
                    onClick={() => { setPurchaseForm({ ...purchaseForm, supplier_id: s.id }); setShowSupplierPicker(false); }}
                    style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 20px", border: "none", borderBottom: `1px solid ${C.line}`, background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#f9f9f7"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: C.ink, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                      {s.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{s.name}</div>
                      <div style={{ fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {[s.contact_person, s.materials_supplied].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {s.phone && <Mono style={{ flexShrink: 0, fontSize: 12, color: C.faint }}>{s.phone}</Mono>}
                  </button>
                ));
              })()}
            </div>
            <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.line}`, fontSize: 12, color: C.faint, textAlign: "right" }}>
              {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      )}

      {/* ── ORDER PICKER MODAL (nested, zIndex 300) ──────────────────────── */}
      {showOrderPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 10001, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={() => setShowOrderPicker(false)}>
          <div style={{ background: C.card, borderRadius: C.radius, width: "100%", maxWidth: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: C.ink }}>Link customer orders</div>
                <TInput autoFocus type="text" placeholder="Search by order number or client name…"
                  value={orderPickerSearch} onChange={e => setOrderPickerSearch(e.target.value)} />
              </div>
              <button onClick={() => setShowOrderPicker(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 20, padding: "0 4px", flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {(() => {
                const BLOCKED = ["Closed", "Cancelled", "Cancelled/Refunded", "Refunded"];
                const q = orderPickerSearch.trim().toLowerCase();
                const eligible = orders.filter(o => !BLOCKED.includes(o.status));
                const filt = q
                  ? eligible.filter(o => (o.order_num || "").toLowerCase().includes(q) || (o.client || "").toLowerCase().includes(q))
                  : eligible;
                if (filt.length === 0) return (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: C.muted, fontSize: 13 }}>
                    {q ? `No open orders match "${orderPickerSearch}"` : "No open orders available"}
                  </div>
                );
                return filt.slice(0, 80).map(o => {
                  const isSelected = purchaseForm.order_ids.includes(o.id);
                  return (
                    <button key={o.id} type="button"
                      onClick={() => setPurchaseForm({ ...purchaseForm, order_ids: isSelected ? purchaseForm.order_ids.filter(id => id !== o.id) : [...purchaseForm.order_ids, o.id] })}
                      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 20px", border: "none", borderBottom: `1px solid ${C.line}`, background: isSelected ? C.coralBg : "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#fef8f6"; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "none"; }}>
                      <div style={{ width: 20, flexShrink: 0, textAlign: "center" }}>
                        {isSelected && <span style={{ color: C.coral, fontWeight: 700, fontSize: 14 }}>✓</span>}
                      </div>
                      <div style={{ width: 80, flexShrink: 0 }}>
                        <Mono style={{ fontSize: 13, fontWeight: 700, color: C.coral }}>{o.order_num}</Mono>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.client}</div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: C.muted, background: C.bg, padding: "2px 8px", borderRadius: 4 }}>{o.status}</span>
                      </div>
                    </button>
                  );
                });
              })()}
            </div>
            <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: C.faint }}>
                {purchaseForm.order_ids.length > 0
                  ? `${purchaseForm.order_ids.length} order${purchaseForm.order_ids.length !== 1 ? "s" : ""} selected`
                  : `${orders.filter(o => !["Closed","Cancelled","Cancelled/Refunded","Refunded"].includes(o.status)).length} open orders`}
              </span>
              <Btn primary onClick={() => setShowOrderPicker(false)}>Done</Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRM MODAL ──────────────────────────────────────────── */}
      {deleteTarget && (
        <Modal
          title={`Delete ${deleteTarget.type === "supplier" ? "Supplier" : "Purchase"}`}
          onClose={() => { if (!reversing) { setDeleteTarget(null); setDeleteError(""); setDeleteJournalId(null); setShowReversalInput(false); setReversalReason(""); } }}
        >
          <p style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
            Delete <strong style={{ color: C.ink }}>{deleteTarget.label}</strong>? This cannot be undone.
            {deleteTarget.type === "supplier" && " Suppliers with purchases cannot be deleted."}
          </p>

          {/* 409 error — journal entry blocks deletion */}
          {deleteError && !showReversalInput && (
            <Notice color="amber" style={{ marginBottom: 14 }}>
              <div style={{ marginBottom: deleteJournalId ? 10 : 0 }}>{deleteError}</div>
              {deleteJournalId && (
                <Btn small danger onClick={() => { setShowReversalInput(true); setDeleteError(""); }}>
                  Reverse journal entry first
                </Btn>
              )}
            </Notice>
          )}

          {/* Reversal reason input */}
          {showReversalInput && (
            <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: C.radiusSm, padding: "12px 14px", marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Why are you reversing this journal entry?</div>
              <TArea autoFocus
                style={{ minHeight: 50, marginBottom: 10 }}
                value={reversalReason}
                onChange={e => setReversalReason(e.target.value)}
                placeholder="e.g. Wrong category — re-posting with correct account" />
              {deleteError && <div style={{ fontSize: 12, color: C.red, marginBottom: 8 }}>{deleteError}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={() => { setShowReversalInput(false); setDeleteError(""); setReversalReason(""); }}>Back</Btn>
                <Btn danger onClick={confirmReversal} disabled={reversing || !reversalReason.trim()}>
                  {reversing ? "Reversing…" : "Reverse & delete"}
                </Btn>
              </div>
            </div>
          )}

          {!showReversalInput && (
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn onClick={() => { setDeleteTarget(null); setDeleteError(""); setDeleteJournalId(null); }}>Cancel</Btn>
              {!deleteError && <Btn danger onClick={confirmDelete}>Delete</Btn>}
            </div>
          )}
        </Modal>
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
