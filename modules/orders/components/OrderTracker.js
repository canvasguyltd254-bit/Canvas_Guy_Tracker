"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/shared/supabase/client";
import { useAuth } from "@/shared/context/AuthContext";
import {
  C, Btn, Badge, Modal, Panel, PanelHead, Toolbar, PageHeader,
  StatCard, Table, Th, Td, Field, TInput, TSelect, TArea,
  Notice, Empty, Loading, Mono, fmtKes, fmtDate,
} from "@/shared/ui/ds";
import {
  STATUSES, REPAIR_STATUSES, DELIVERY_VISIBLE_FROM, ALL_STATUS_COLORS,
  PAY_COLORS, CATEGORIES, FINISH_TYPES, WOOD_TYPES, REPAIR_REASONS,
  CUSTOMER_TYPES, PAYMENT_TERMS, DOC_TYPES, DOC_ICONS, ROLES_CAN_CREATE,
  ROLES_CAN_EDIT, ROLES_CAN_ADVANCE, ROLES_CAN_ADD_NOTES, ROLES_CAN_UPLOAD,
  ROLES_CAN_DELIVER, ROLES_CAN_PAY, ROLES_CAN_REPAIR, ROLES_CAN_REWORK,
  CREDIT_TERMS, HEAD_OF_SALES_CREDIT_LIMIT, REWORK_TARGETS, REWORK_REASONS,
  SALES_MAX_ADVANCE_TO, STATUS_BORDER_CLASS, ss, getPayStatus, getStatusList, genId,
} from "./constants";

async function logAct(sb, oid, t, d, o, n) {
  await sb.from("order_activities").insert({
    order_id: oid, activity_type: t, description: d,
    old_value: o || null, new_value: n || null,
  });
}

const isCreditOrd = (o) =>
  ["commercial", "reseller"].includes(o?.customer_type) &&
  CREDIT_TERMS.includes(o?.payment_terms);

// ─── Status badge using existing ALL_STATUS_COLORS ────────────────────────────
function StatusChip({ status, type }) {
  const c = (type === "payment" ? PAY_COLORS : ALL_STATUS_COLORS)[status] || { bg: "#eee", text: "#555", border: "#ddd" };
  return (
    <span style={{
      display: "inline-block", padding: "3px 9px", borderRadius: 20,
      fontSize: 10.5, fontWeight: 700, letterSpacing: "0.03em",
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      whiteSpace: "nowrap",
    }}>
      {status}
    </span>
  );
}

function TruncText({ text, lines }) {
  const [exp, setExp] = useState(false);
  if (!text) return null;
  const st = exp ? {} : { display: "-webkit-box", WebkitLineClamp: lines || 3, WebkitBoxOrient: "vertical", overflow: "hidden" };
  return (
    <div>
      <div style={{ ...st, fontSize: 13, color: C.ink, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{text}</div>
      {text.length > 150 && (
        <button onClick={() => setExp(!exp)} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 11, fontWeight: 700, padding: "4px 0" }}>
          {exp ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ─── Items Builder ─────────────────────────────────────────────────────────────
function ItemsBuilder({ items, onChange }) {
  const add = () => onChange([{
    _id: genId(), category: "Wall Decoration Canvas", description: "",
    quantity: 1, size: "", finish_type: "None", finish_color: "",
    wood_type: "", unit_price: "", notes: "",
  }, ...items]);
  const upd = (id, f, v) => onChange(items.map(i => i._id === id ? { ...i, [f]: v } : i));
  const del = (id) => onChange(items.filter(i => i._id !== id));

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em" }}>Order Items</label>
        <Btn small onClick={add} style={{ background: C.ink, color: "#fff", border: `1px solid ${C.ink}` }}>+ Add Item</Btn>
      </div>
      {items.length === 0 && (
        <div style={{ fontSize: 12, color: C.faint, padding: 16, textAlign: "center", background: "#fafaf8", borderRadius: 8, border: `1px dashed ${C.line}` }}>
          No items yet.
        </div>
      )}
      {items.map((item, idx) => (
        <div key={item._id} style={{ background: "#fafaf8", borderRadius: 10, border: `1px solid ${C.line}`, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: C.muted }}>Item {idx + 1}</span>
            <button type="button" onClick={() => del(item._id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Remove</button>
          </div>
          <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              { label: "Category", field: "category", type: "select", options: CATEGORIES },
              { label: "Qty", field: "quantity", type: "number" },
              { label: "Size", field: "size", type: "text", placeholder: "e.g. 60x40cm" },
              { label: "Finish Type", field: "finish_type", type: "select", options: FINISH_TYPES },
              { label: "Finish Color", field: "finish_color", type: "text", placeholder: "e.g. Dark Walnut" },
            ].map(({ label, field, type, options, placeholder }) => (
              <div key={field}>
                <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</label>
                {type === "select"
                  ? <TSelect value={item[field]} onChange={e => upd(item._id, field, e.target.value)} style={{ fontSize: 12, padding: "7px 9px" }}>
                      {options.map(o => <option key={o}>{o}</option>)}
                    </TSelect>
                  : <TInput type={type} value={item[field]} onChange={e => upd(item._id, field, type === "number" ? parseInt(e.target.value) || 1 : e.target.value)} placeholder={placeholder} style={{ fontSize: 12, padding: "7px 9px" }} min={type === "number" ? 1 : undefined} />
                }
              </div>
            ))}
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Wood Type</label>
              <TSelect value={item.wood_type} onChange={e => upd(item._id, "wood_type", e.target.value)} style={{ fontSize: 12, padding: "7px 9px" }}>
                <option value="">-</option>
                {WOOD_TYPES.map(w => <option key={w}>{w}</option>)}
              </TSelect>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Unit Price (KES)</label>
              <TInput type="number" value={item.unit_price} onChange={e => upd(item._id, "unit_price", e.target.value)} style={{ fontSize: 12, padding: "7px 9px" }} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description</label>
              <TInput type="text" value={item.description || ""} onChange={e => upd(item._id, "description", e.target.value)} placeholder="Details" style={{ fontSize: 12, padding: "7px 9px" }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Items Table ───────────────────────────────────────────────────────────────
function ItemsTable({ items }) {
  if (!items || items.length === 0) return null;
  const total = items.reduce((s, i) => (parseFloat(i.unit_price) || 0) * (i.quantity || 1) + s, 0);
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
        Items ({items.length})
      </div>
      <div className="items-table">
        <Table>
          <thead>
            <tr style={{ background: "#fafaf8" }}>
              {["#", "Category", "Description", "Qty", "Size", "Finish", "Wood", "Price"].map(h => <Th key={h}>{h}</Th>)}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={item.id || i}>
                <Td muted>{i + 1}</Td>
                <Td><strong>{item.category}</strong></Td>
                <Td muted>{item.description || "—"}</Td>
                <Td><strong>{item.quantity}</strong></Td>
                <Td>{item.size || "—"}</Td>
                <Td>{item.finish_type && item.finish_type !== "None" ? <>{item.finish_type}{item.finish_color && <span style={{ color: C.muted }}> - {item.finish_color}</span>}</> : "—"}</Td>
                <Td>{item.wood_type || "—"}</Td>
                <Td mono>{parseFloat(item.unit_price) ? fmtKes((parseFloat(item.unit_price)) * (item.quantity || 1)) : "—"}</Td>
              </tr>
            ))}
          </tbody>
          {total > 0 && (
            <tfoot>
              <tr style={{ background: "#fafaf8" }}>
                <td colSpan={7} style={{ padding: "10px 14px", fontWeight: 700, textAlign: "right", fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em" }}>Total</td>
                <Td mono><strong>{fmtKes(total)}</strong></Td>
              </tr>
            </tfoot>
          )}
        </Table>
      </div>
      {/* Mobile cards */}
      <div className="items-cards" style={{ display: "none", flexDirection: "column", gap: 8, marginTop: 6 }}>
        {items.map((item, i) => (
          <div key={item.id || i} style={{ background: "#fafaf8", borderRadius: 10, border: `1px solid ${C.line}`, padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{item.category}</div>
            {item.description && <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{item.description}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11 }}>
              <div><span style={{ color: C.muted }}>Qty:</span> <strong>{item.quantity}</strong></div>
              {item.size && <div><span style={{ color: C.muted }}>Size:</span> {item.size}</div>}
              {item.finish_type && item.finish_type !== "None" && <div><span style={{ color: C.muted }}>Finish:</span> {item.finish_type}{item.finish_color ? " - " + item.finish_color : ""}</div>}
              {item.wood_type && <div><span style={{ color: C.muted }}>Wood:</span> {item.wood_type}</div>}
              {parseFloat(item.unit_price) > 0 && <div><span style={{ color: C.muted }}>Price:</span> <strong style={{ fontFamily: C.mono }}>{fmtKes((parseFloat(item.unit_price)) * (item.quantity || 1))}</strong></div>}
            </div>
          </div>
        ))}
        {total > 0 && <div style={{ textAlign: "right", fontSize: 12, fontWeight: 700, padding: "4px 0", fontFamily: C.mono }}>Total: {fmtKes(total)}</div>}
      </div>
    </div>
  );
}

// ─── Notes Thread ──────────────────────────────────────────────────────────────
function NotesThread({ orderId, userRole, userName, orderStatus }) {
  const [notes, setNotes] = useState([]);
  const [text, setText] = useState("");
  const [ld, setLd] = useState(true);
  const sb = createClient();

  const load = useCallback(async () => {
    const { data } = await sb.from("order_notes").select("*").eq("order_id", orderId).order("created_at", { ascending: false });
    setNotes(data || []); setLd(false);
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!text.trim()) return;
    await sb.from("order_notes").insert({ order_id: orderId, content: text.trim(), author_name: userName || "Unknown" });
    await logAct(sb, orderId, "note", `Note: ${text.trim().slice(0, 80)}`);
    setText(""); await load();
  };

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Notes" />
      <div style={{ padding: "14px 16px" }}>
        {ROLES_CAN_ADD_NOTES.includes(userRole) && orderStatus !== "Closed" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <TInput value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }} placeholder="Add a note…" style={{ flex: 1 }} />
            <Btn primary onClick={add} disabled={!text.trim()}>Post</Btn>
          </div>
        )}
        {ld
          ? <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>
          : notes.length === 0
            ? <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic" }}>No notes yet.</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 250, overflowY: "auto" }}>
                {notes.map(n => (
                  <div key={n.id} style={{ padding: "9px 12px", background: C.bg, borderRadius: 8, border: `1px solid ${C.line}` }}>
                    <div style={{ fontSize: 13, color: C.ink, whiteSpace: "pre-wrap" }}>{n.content}</div>
                    <div style={{ fontSize: 10.5, color: C.muted, marginTop: 4, fontFamily: C.mono }}>
                      {n.author_name} · {new Date(n.created_at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })} {new Date(n.created_at).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                ))}
              </div>
        }
      </div>
    </Panel>
  );
}

// ─── Delivery Panel ────────────────────────────────────────────────────────────
function DeliveryPanel({ orderId, totalQty, userRole, payBalance, onDeliveryChange, orderStatus, onAutoAdvance }) {
  const [batches, setBatches] = useState([]);
  const [ld, setLd] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [qty, setQty] = useState(""); const [desc, setDesc] = useState("");
  const [loc, setLoc] = useState(""); const [delBy, setDelBy] = useState("");
  const [recBy, setRecBy] = useState(""); const [notes, setNotes] = useState("");
  const [authReason, setAuthReason] = useState("");
  const sb = createClient();

  const load = useCallback(async () => {
    const { data } = await sb.from("order_deliveries").select("*").eq("order_id", orderId).order("batch_number");
    setBatches(data || []); setLd(false);
    const t = (data || []).reduce((s, b) => s + (b.quantity || 0), 0);
    if (onDeliveryChange) onDeliveryChange(t);
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const delivered = batches.reduce((s, b) => s + (b.quantity || 0), 0);
  const remaining = Math.max((totalQty || 0) - delivered, 0);
  const pct = totalQty > 0 ? Math.round((delivered / totalQty) * 100) : 0;
  const needsAuth = payBalance > 0;
  const isAdmin = userRole === "admin";
  const canDeliver = ROLES_CAN_DELIVER.includes(userRole);
  const isClosed = orderStatus === "Closed";

  const resetForm = () => { setQty(""); setDesc(""); setLoc(""); setDelBy(""); setRecBy(""); setNotes(""); setAuthReason(""); setShowForm(false); setEditId(null); };
  const startEdit = (b) => { setEditId(b.id); setQty(String(b.quantity)); setDesc(b.description || ""); setLoc(b.delivery_location || ""); setDelBy(b.delivered_by || ""); setRecBy(b.received_by || ""); setNotes(b.notes || ""); setShowForm(true); };

  const record = async () => {
    const q = parseInt(qty);
    if (!q || q <= 0) return;
    const existingDel = editId ? delivered - ((batches.find(b => b.id === editId)?.quantity) || 0) : delivered;
    if (totalQty > 0 && (existingDel + q) > totalQty) { alert(`Delivery exceeds remaining units.\nTotal: ${totalQty}\nDelivered: ${existingDel}\nRemaining: ${totalQty - existingDel}\nEntered: ${q}`); return; }
    const payload = { quantity: q, description: desc.trim() || null, delivery_location: loc.trim() || null, delivered_by: delBy.trim() || null, received_by: recBy.trim() || null, notes: notes.trim() || null, auth_reason: authReason.trim() || null };
    if (editId) {
      setBatches(prev => prev.map(b => b.id === editId ? { ...b, ...payload } : b)); resetForm();
      try { const res = await fetch(`/api/orders/${orderId}/deliveries?batch_id=${editId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Failed to update batch"); } }
      catch (err) { alert(err.message); await load(); }
    } else {
      const tempBn = (batches.length > 0 ? Math.max(...batches.map(b => b.batch_number)) : 0) + 1;
      const tempBatch = { id: `temp-${Date.now()}`, batch_number: tempBn, quantity: q, ...payload, delivery_date: new Date().toISOString().split("T")[0] };
      setBatches(prev => [...prev, tempBatch]); resetForm();
      try {
        const res = await fetch(`/api/orders/${orderId}/deliveries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Failed to record delivery"); }
        await load();
        if (orderStatus === "Ready for Delivery" && onAutoAdvance) onAutoAdvance("Partially Delivered");
      } catch (err) { alert(err.message); setBatches(prev => prev.filter(b => b.id !== tempBatch.id)); }
    }
  };

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead
        title="Delivery Tracking"
        actions={canDeliver && !isClosed && <Btn small onClick={() => { if (showForm) resetForm(); else setShowForm(true); }} style={{ background: C.ink, color: "#fff", border: `1px solid ${C.ink}` }}>{showForm ? "Cancel" : "+ Record Batch"}</Btn>}
      />
      <div style={{ padding: "14px 16px" }}>
        {totalQty > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              {[
                { label: "Total", value: totalQty, color: C.ink, bg: "#f5f5f3" },
                { label: "Delivered", value: delivered, color: C.green, bg: C.greenBg },
                { label: "Remaining", value: remaining, color: remaining > 0 ? C.amber : C.muted, bg: remaining > 0 ? C.amberBg : "#f5f5f3" },
                { label: "Progress", value: `${pct}%`, color: pct >= 100 ? C.green : C.blue, bg: pct >= 100 ? C.greenBg : C.blueBg },
              ].map(({ label, value, color, bg }) => (
                <div key={label} style={{ background: bg, borderRadius: 8, padding: "9px 11px" }}>
                  <div style={{ color, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
                  <div style={{ fontWeight: 700, color, fontFamily: C.mono, marginTop: 2 }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? C.green : C.blue, borderRadius: 4 }} />
            </div>
          </div>
        )}
        {!ld && batches.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {batches.map(b => (
              <div key={b.id} style={{ padding: "9px 12px", background: C.bg, borderRadius: 8, border: `1px solid ${C.line}`, fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontWeight: 700 }}>Batch {b.batch_number} — {b.quantity} units</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ color: C.muted, fontSize: 11, fontFamily: C.mono }}>{new Date(b.delivery_date).toLocaleDateString("en-KE", { day: "numeric", month: "short" })}</span>
                    {canDeliver && !isClosed && <button onClick={() => startEdit(b)} style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 7px", fontSize: 10, color: C.blue, cursor: "pointer", fontWeight: 700 }}>Edit</button>}
                  </div>
                </div>
                {b.delivery_location && <div style={{ color: C.muted }}>{b.delivery_location}</div>}
                {b.description && <div style={{ color: C.muted }}>{b.description}</div>}
                {b.admin_authorized && <div style={{ fontSize: 10.5, color: C.amber, marginTop: 2 }}>Admin authorized{b.admin_auth_reason ? `: ${b.admin_auth_reason}` : ""}</div>}
              </div>
            ))}
          </div>
        )}
        {showForm && (
          <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.line}`, padding: 14, marginTop: 8 }}>
            {needsAuth && !isAdmin && <Notice color="red" style={{ marginBottom: 12 }}>Outstanding balance. Contact Admin to authorize delivery.</Notice>}
            {(canDeliver && (!needsAuth || isAdmin)) && (
              <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label="Quantity *"><TInput type="number" value={qty} onChange={e => setQty(e.target.value)} min="1" /></Field>
                <Field label="Location"><TInput type="text" value={loc} onChange={e => setLoc(e.target.value)} placeholder="Block A" /></Field>
                <Field label="Delivered By"><TInput type="text" value={delBy} onChange={e => setDelBy(e.target.value)} /></Field>
                <Field label="Received By"><TInput type="text" value={recBy} onChange={e => setRecBy(e.target.value)} /></Field>
                <Field label="Description" full><TInput type="text" value={desc} onChange={e => setDesc(e.target.value)} /></Field>
                {needsAuth && isAdmin && <Field label="Authorization Reason *" full><TInput type="text" value={authReason} onChange={e => setAuthReason(e.target.value)} placeholder="Reason for delivery with balance" /></Field>}
                <div style={{ gridColumn: "1 / -1" }}>
                  <Btn primary onClick={record} disabled={!parseInt(qty) || (needsAuth && isAdmin && !authReason.trim() && !editId)} style={{ background: parseInt(qty) ? C.green : undefined }}>
                    {editId ? "Update Batch" : "Record Delivery"}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── Payment Panel ─────────────────────────────────────────────────────────────
function PaymentPanel({ orderId, totalValue, userRole, onPaymentChange, orderStatus }) {
  const [payments, setPayments] = useState([]);
  const [ld, setLd] = useState(true);
  const [amt, setAmt] = useState(""); const [desc, setDesc] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().split("T")[0]);
  const sb = createClient();

  const load = useCallback(async () => {
    const { data } = await sb.from("order_payments").select("*").eq("order_id", orderId).order("payment_date");
    const l = data || []; setPayments(l); setLd(false);
    // Reversed payments no longer count toward the paid total — the reversal journal already backs it out in GL.
    const active = l.filter(p => !p.reversed_at);
    if (onPaymentChange) onPaymentChange(active.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0));
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const a = parseFloat(amt);
    if (!a || a <= 0 || !desc.trim()) return;
    const { data: _np, error: _ne } = await sb.from("order_payments").insert({ order_id: orderId, amount: a, description: desc.trim(), payment_date: payDate }).select().single();
    if (_ne) { alert("Failed to record payment: " + _ne.message); return; }
    if (_np?.id) {
      try { const _gr = await fetch(`/api/order-payments/${_np.id}/post`, { method: "POST" }); if (!_gr.ok) { const _gj = await _gr.json().catch(() => ({})); alert("Payment recorded but GL posting failed: " + (_gj.error || "unknown error") + "\nRetry from Accounting Review."); } }
      catch (e) { console.warn("GL post network error", e); }
    }
    await logAct(sb, orderId, "payment", `Payment: KES ${a.toLocaleString()} - ${desc.trim()}`);
    setAmt(""); setDesc(""); setPayDate(new Date().toISOString().split("T")[0]);
    await load();
  };

  const del = async (p) => {
    // Posted payments must be reversed (keeps the GL journal + audit trail intact),
    // never hard-deleted. Only ever-unposted payments can be removed outright.
    if (p.journal_entry_id) {
      const reason = prompt("This payment has been posted to the ledger. Enter a reason to reverse it (admin only):");
      if (!reason?.trim()) return;
      try {
        const res = await fetch(`/api/order-payments/${p.id}/reverse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          alert("Failed to reverse payment: " + (j.error || "unknown error"));
          return;
        }
      } catch (e) {
        alert("Failed to reverse payment: " + e.message);
        return;
      }
      await logAct(sb, orderId, "payment_deleted", `Reversed: KES ${parseFloat(p.amount).toLocaleString()} — ${reason.trim()}`);
      await load();
      return;
    }
    await sb.from("order_payments").delete().eq("id", p.id);
    await logAct(sb, orderId, "payment_deleted", `Removed: KES ${parseFloat(p.amount).toLocaleString()}`);
    await load();
  };

  const tp = payments.filter(p => !p.reversed_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const bal = (totalValue || 0) - tp;
  const pct = totalValue > 0 ? Math.round((tp / totalValue) * 100) : 0;
  const ps = getPayStatus(tp, totalValue);
  const canPay = ROLES_CAN_PAY.includes(userRole);

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Payments" actions={<StatusChip status={ps} type="payment" />} />
      <div style={{ padding: "14px 16px" }}>
        {totalValue > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 }}>
              <span style={{ fontFamily: C.mono }}>{fmtKes(tp)} of {fmtKes(totalValue)}</span>
              <span style={{ fontWeight: 700, color: pct >= 100 ? C.green : pct >= 50 ? C.blue : C.red, fontFamily: C.mono }}>{pct}%</span>
            </div>
            <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? C.green : pct >= 50 ? C.blue : C.coral, borderRadius: 4 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 5, fontFamily: C.mono }}>
              <span>Paid: {fmtKes(tp)}</span>
              <span>Balance: {fmtKes(Math.max(bal, 0))}</span>
            </div>
          </div>
        )}
        {!ld && payments.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
            {payments.map(p => {
              const isReversed = !!p.reversed_at;
              const isPosted   = !!p.journal_entry_id;
              return (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
                background: isReversed ? C.redBg : C.bg, borderRadius: 8,
                border: `1px solid ${isReversed ? C.redBd : C.line}`, fontSize: 12, flexWrap: "wrap",
              }}>
                <span style={{
                  fontWeight: 700, minWidth: 100, fontFamily: C.mono,
                  color: isReversed ? C.faint : C.green,
                  textDecoration: isReversed ? "line-through" : "none",
                }}>{fmtKes(parseFloat(p.amount))}</span>
                <span style={{ flex: 1, color: C.muted, minWidth: 80 }}>{p.description}</span>
                <span style={{ color: C.faint, fontSize: 11, fontFamily: C.mono }}>{new Date(p.payment_date).toLocaleDateString("en-KE", { day: "numeric", month: "short" })}</span>
                {isReversed && <Badge color="red">Reversed</Badge>}
                {!isReversed && userRole === "admin" && (
                  <button
                    onClick={() => { if (confirm(isPosted ? "Reverse this payment?" : "Delete this payment?")) del(p); }}
                    style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: isPosted ? 11 : 12, fontWeight: 700 }}
                  >
                    {isPosted ? "Reverse" : "×"}
                  </button>
                )}
              </div>
              );
            })}
          </div>
        )}
        {canPay && orderStatus !== "Closed" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <TInput type="number" placeholder="Amount" value={amt} onChange={e => setAmt(e.target.value)} style={{ maxWidth: 110 }} />
            <TInput type="text" placeholder="Description" value={desc} onChange={e => setDesc(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
            <TInput type="date" value={payDate} onChange={e => setPayDate(e.target.value)} style={{ maxWidth: 140 }} />
            <Btn primary onClick={add} disabled={!amt || !desc.trim()} style={{ background: amt && desc.trim() ? C.green : undefined }}>+ Add</Btn>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── Documents Panel ───────────────────────────────────────────────────────────
function DocumentsPanel({ orderId, userRole }) {
  const [docs, setDocs] = useState([]);
  const [ld, setLd] = useState(true);
  const [up, setUp] = useState(false);
  const [st, setSt] = useState("Invoice");
  const fr = useRef(null);
  const sb = createClient();

  const load = useCallback(async () => {
    const { data } = await sb.from("order_documents").select("*").eq("order_id", orderId).order("uploaded_at", { ascending: false });
    setDocs(data || []); setLd(false);
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { alert("Max 10MB."); return; }
    setUp(true);
    try {
      const ext = f.name.split(".").pop();
      const fp = `${orderId}/${Date.now()}.${ext}`;
      const { error: ue } = await sb.storage.from("order-documents").upload(fp, f, { contentType: f.type });
      if (ue) throw ue;
      await sb.from("order_documents").insert({ order_id: orderId, name: f.name, doc_type: st, file_path: fp, file_size: f.size, mime_type: f.type });
      await logAct(sb, orderId, "document", `Uploaded ${st}: ${f.name}`);
      await load();
    } catch (err) { alert("Failed: " + err.message); }
    setUp(false);
    if (fr.current) fr.current.value = "";
  };

  const view = async (d) => { const { data } = await sb.storage.from("order-documents").createSignedUrl(d.file_path, 3600); if (data?.signedUrl) window.open(data.signedUrl, "_blank"); };
  const dl = async (d) => { const { data } = await sb.storage.from("order-documents").download(d.file_path); if (data) { const u = URL.createObjectURL(data); const a = document.createElement("a"); a.href = u; a.download = d.name; a.click(); URL.revokeObjectURL(u); } };
  const rm = async (d) => { await sb.storage.from("order-documents").remove([d.file_path]); await sb.from("order_documents").delete().eq("id", d.id); await logAct(sb, orderId, "document_deleted", `Removed: ${d.name}`); await load(); };
  const fs = (b) => !b ? "" : b < 1024 ? b + "B" : b < 1048576 ? (b / 1024).toFixed(0) + "KB" : (b / 1048576).toFixed(1) + "MB";
  const canUp = ROLES_CAN_UPLOAD.includes(userRole);

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Documents" />
      <div style={{ padding: "14px 16px" }}>
        {ld
          ? <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>
          : docs.length > 0
            ? <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {docs.map(d => (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: C.bg, borderRadius: 8, border: `1px solid ${C.line}`, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 18 }}>{DOC_ICONS[d.doc_type] || "📎"}</span>
                    <div style={{ flex: 1, minWidth: 100 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                      <div style={{ fontSize: 10.5, color: C.muted, fontFamily: C.mono }}>
                        {d.doc_type} · {fs(d.file_size)} · {new Date(d.uploaded_at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      <Btn small onClick={() => view(d)} style={{ color: C.blue, border: `1px solid ${C.line}` }}>View</Btn>
                      <Btn small onClick={() => dl(d)} style={{ color: C.green, border: `1px solid ${C.line}` }}>DL</Btn>
                      {userRole === "admin" && <Btn small danger onClick={() => { if (confirm("Remove?")) rm(d); }}>×</Btn>}
                    </div>
                  </div>
                ))}
              </div>
            : <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic", paddingBottom: 10 }}>No documents.</div>
        }
        {canUp && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <TSelect value={st} onChange={e => setSt(e.target.value)} style={{ width: "auto" }}>
              {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
            </TSelect>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 14px", borderRadius: C.radiusSm, border: `1.5px dashed ${C.line}`, fontSize: 13, fontWeight: 600, color: C.muted, cursor: "pointer", background: C.card }}>
              {up ? "Uploading…" : "Upload"}
              <input ref={fr} type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx" onChange={upload} style={{ display: "none" }} />
            </label>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ─── Activity Timeline ─────────────────────────────────────────────────────────
function ActivityTimeline({ orderId }) {
  const [a, setA] = useState([]); const [l, setL] = useState(false);
  const sb = createClient();
  useEffect(() => {
    (async () => {
      const { data } = await sb.from("order_activities").select("*").eq("order_id", orderId).order("created_at", { ascending: false }).limit(30);
      setA(data || []); setL(true);
    })();
  }, [orderId]);
  if (!l) return null;
  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Activity" />
      <div style={{ padding: "12px 16px" }}>
        {a.length === 0
          ? <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic" }}>No activity.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 200, overflowY: "auto" }}>
              {a.map(x => (
                <div key={x.id} style={{ fontSize: 12, color: C.muted, padding: "5px 0", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 10 }}>
                  <span style={{ color: C.faint, fontSize: 11, minWidth: 65, flexShrink: 0, fontFamily: C.mono }}>{new Date(x.created_at).toLocaleDateString("en-KE", { day: "numeric", month: "short" })}</span>
                  <span>{x.description}</span>
                </div>
              ))}
            </div>
        }
      </div>
    </Panel>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────────────
function QuotePrompt({ onConfirm, onCancel }) {
  const [n, setN] = useState("");
  return (
    <Modal title="Enter Quote Number" onClose={onCancel}
      footer={<>
        <Btn onClick={() => onConfirm("")} style={{ color: C.muted }}>Skip</Btn>
        <Btn primary onClick={() => onConfirm(n.trim())}>Save</Btn>
      </>}
    >
      <Field label="Quote Number">
        <TInput value={n} onChange={e => setN(e.target.value)} placeholder="e.g. QT-001234" autoFocus />
      </Field>
    </Modal>
  );
}

function DepositPrompt({ onConfirm, onCancel }) {
  const [amt, setAmt] = useState(""); const [desc, setDesc] = useState("Deposit");
  const [dt, setDt] = useState(new Date().toISOString().split("T")[0]);
  const [inv, setInv] = useState("");
  const v = parseFloat(amt) > 0 && desc.trim();
  return (
    <Modal title="Record Deposit and Invoice" onClose={onCancel}
      footer={<>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn primary onClick={() => v && onConfirm({ amount: parseFloat(amt), description: desc.trim(), payment_date: dt, invoice_number: inv.trim() })} disabled={!v}>Record</Btn>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Field label="Invoice Number"><TInput type="text" value={inv} onChange={e => setInv(e.target.value)} placeholder="INV-001234" /></Field>
        <Field label="Amount (KES) *"><TInput type="number" value={amt} onChange={e => setAmt(e.target.value)} autoFocus /></Field>
        <Field label="Description *"><TInput type="text" value={desc} onChange={e => setDesc(e.target.value)} /></Field>
        <Field label="Date"><TInput type="date" value={dt} onChange={e => setDt(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function RepairForm({ parentOrder, onConfirm, onCancel }) {
  const [reason, setReason] = useState(REPAIR_REASONS[0]);
  const [type, setType] = useState("repair");
  const [desc, setDesc] = useState("");
  const [val, setVal] = useState("");
  return (
    <Modal title="Create Return / Repair" onClose={onCancel}
      footer={<>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn danger onClick={() => desc.trim() && onConfirm({ type, reason, description: desc.trim(), value: parseFloat(val) || 0 })} disabled={!desc.trim()}>Create</Btn>
      </>}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Field label="Type">
          <TSelect value={type} onChange={e => setType(e.target.value)}>
            <option value="repair">Repair</option>
            <option value="return">Return</option>
          </TSelect>
        </Field>
        <Field label="Reason">
          <TSelect value={reason} onChange={e => setReason(e.target.value)}>
            {REPAIR_REASONS.map(r => <option key={r}>{r}</option>)}
          </TSelect>
        </Field>
        <Field label="Description *"><TArea value={desc} onChange={e => setDesc(e.target.value)} rows={3} placeholder="What needs repair" /></Field>
        <Field label="Cost (KES)"><TInput type="number" value={val} onChange={e => setVal(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function CreditApprovalPrompt({ order, creditLimit, exposure, userRole, onConfirm, onCancel }) {
  const [note, setNote] = useState(""); const [approver, setApprover] = useState("");
  const orderVal = parseFloat(order.total_value) || 0;
  const newExposure = exposure + orderVal;
  const overLimit = creditLimit > 0 && newExposure > creditLimit;
  const isAdmin = userRole === "admin";
  const isHeadOfSales = userRole === "head_of_sales";
  const headOfSalesOverLimit = isHeadOfSales && orderVal > HEAD_OF_SALES_CREDIT_LIMIT;
  const canApprove = !overLimit || (overLimit && isAdmin);
  const fmt = n => `KES ${Math.round(n).toLocaleString("en-KE")}`;

  return (
    <Modal title="Credit Approval" onClose={onCancel}
      footer={<>
        <Btn onClick={onCancel}>Cancel</Btn>
        {canApprove && !headOfSalesOverLimit && <Btn primary onClick={() => approver.trim() && onConfirm({ approver: approver.trim(), note: note.trim(), creditLimit, exposure, newExposure, overLimit })} disabled={!approver.trim()} style={{ background: C.green }}>Approve Credit</Btn>}
      </>}
    >
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Reseller credit order — deposit gate bypass</p>
      <div style={{ background: C.bg, borderRadius: 10, padding: 14, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 13 }}>
        {[
          { label: "Client", value: order.client, mono: false },
          { label: "Order", value: order.order_num, mono: true },
          { label: "Payment Terms", value: PAYMENT_TERMS.find(p => p.id === order.payment_terms)?.label || order.payment_terms, mono: false },
          { label: "Order Value", value: fmt(orderVal), mono: true },
          { label: "Credit Limit", value: creditLimit > 0 ? fmt(creditLimit) : "Not set", mono: true },
          { label: "Current Exposure", value: fmt(exposure), mono: true },
        ].map(({ label, value, mono }) => (
          <div key={label}>
            <span style={{ color: C.muted, fontSize: 11, display: "block", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{label}</span>
            <strong style={{ fontFamily: mono ? C.mono : "inherit" }}>{value}</strong>
          </div>
        ))}
        <div style={{ gridColumn: "1/-1" }}>
          <span style={{ color: C.muted, fontSize: 11, display: "block", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>New Exposure After Approval</span>
          <strong style={{ fontFamily: C.mono, color: overLimit ? C.red : C.green }}>{fmt(newExposure)}{overLimit ? " — OVER LIMIT" : ""}</strong>
        </div>
      </div>
      {overLimit && <Notice color="red" style={{ marginBottom: 16 }}>{isAdmin ? "⚠️ Credit limit exceeded. As Admin you can override and approve." : "🚫 Credit limit exceeded. Only an Admin can approve this order."}</Notice>}
      {headOfSalesOverLimit && <Notice color="red" style={{ marginBottom: 16 }}>🚫 Order amount ({fmt(orderVal)}) exceeds your approval limit ({fmt(HEAD_OF_SALES_CREDIT_LIMIT)}). Please contact Admin.</Notice>}
      {canApprove && !headOfSalesOverLimit && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Approved By *"><TInput value={approver} onChange={e => setApprover(e.target.value)} placeholder="Your name" /></Field>
          <Field label="Approval Note"><TInput value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Approved per standing agreement" /></Field>
        </div>
      )}
    </Modal>
  );
}

function ReworkPrompt({ order, targetStatus, onConfirm, onCancel }) {
  const [reason, setReason] = useState(REWORK_REASONS[0]);
  const [notes, setNotes] = useState("");
  const [approver, setApprover] = useState("");
  const v = reason && approver.trim();
  return (
    <Modal title={`Send Back to ${targetStatus}`} onClose={onCancel}
      footer={<>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => v && onConfirm({ reason, approver: approver.trim(), notes: notes.trim() })} disabled={!v} style={{ background: v ? C.amber : undefined, color: v ? "#fff" : undefined, border: `1px solid ${C.amber}` }}>Confirm Send Back</Btn>
      </>}
    >
      <p style={{ fontSize: 13, color: C.muted, marginBottom: 14, fontFamily: C.mono }}>{order.order_num} — {order.client}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Field label="Reason *">
          <TSelect value={reason} onChange={e => setReason(e.target.value)}>
            {REWORK_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </TSelect>
        </Field>
        <Field label="Authorized By *"><TInput value={approver} onChange={e => setApprover(e.target.value)} placeholder="Your name" /></Field>
        <Field label="Additional Notes"><TArea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Optional details" /></Field>
      </div>
    </Modal>
  );
}

// ─── Order Form ────────────────────────────────────────────────────────────────
function OrderForm({ onSave, onCancel, initial, userRole }) {
  const FIELDS = ["client", "contact_person", "author", "items", "due_date", "assigned_to", "notes", "total_value", "quote_number", "invoice_number", "customer_type", "payment_terms", "batch_delivery"];
  const defaults = { client: "", contact_person: "", author: "", items: "", due_date: "", assigned_to: "", notes: "", total_value: "", quote_number: "", invoice_number: "", customer_type: "retail", payment_terms: "cash_before", batch_delivery: false };
  const initV = initial ? FIELDS.reduce((a, k) => { a[k] = initial[k] ?? ""; return a; }, {}) : defaults;
  const [form, setForm] = useState(initV);
  const [orderItems, setOrderItems] = useState([]);
  const [ldItems, setLdItems] = useState(false);
  const sb = createClient();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const valid = form.client.trim() && (orderItems.length > 0 || form.items?.trim());

  useEffect(() => {
    if (initial?.id) {
      (async () => {
        const { data } = await sb.from("order_items").select("*").eq("order_id", initial.id).order("sort_order");
        if (data) setOrderItems(data.map(d => ({ ...d, _id: d.id })));
        setLdItems(true);
      })();
    } else setLdItems(true);
  }, [initial]);

  return (
    <Panel style={{ marginBottom: 20 }}>
      <PanelHead title={initial ? "Edit Order" : "New Order"} />
      <div style={{ padding: 18 }}>
        <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { l: "Client Name *", k: "client", t: "text" },
            { l: "Client Contact", k: "contact_person", t: "text", p: "Name / phone / email" },
            { l: "Order Author", k: "author", t: "text", p: "Who owns this?" },
            { l: "Assigned To", k: "assigned_to", t: "text", p: "Workshop / person" },
            { l: "Due Date", k: "due_date", t: "date" },
            { l: "Order Value (KES)", k: "total_value", t: "number", p: "e.g. 150000" },
            { l: "Quote Number", k: "quote_number", t: "text", p: "From Manager.io" },
            { l: "Invoice Number", k: "invoice_number", t: "text", p: "From Manager.io" },
          ].map(({ l, k, t, p }) => (
            <Field key={k} label={l}>
              <TInput type={t} value={form[k] || ""} onChange={set(k)} placeholder={p} />
            </Field>
          ))}
          <Field label="Customer Type">
            <TSelect value={form.customer_type || "retail"} onChange={set("customer_type")}>
              {CUSTOMER_TYPES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </TSelect>
          </Field>
          <Field label="Payment Terms">
            <TSelect value={form.payment_terms || "cash_before"} onChange={set("payment_terms")}>
              {PAYMENT_TERMS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </TSelect>
          </Field>
          {["admin", "production_manager"].includes(userRole) && (
            <Field label="Batch Delivery">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button type="button" onClick={() => setForm({ ...form, batch_delivery: !form.batch_delivery })}
                  style={{ padding: "7px 14px", borderRadius: C.radiusSm, border: `1.5px solid ${form.batch_delivery ? C.green : C.line}`, background: form.batch_delivery ? C.greenBg : C.card, color: form.batch_delivery ? C.green : C.muted, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  {form.batch_delivery ? "Enabled" : "Disabled"}
                </button>
                <span style={{ fontSize: 11, color: C.faint }}>For large/phased deliveries</span>
              </div>
            </Field>
          )}
        </div>
        {ldItems && <ItemsBuilder items={orderItems} onChange={setOrderItems} />}
        <Field label="Additional Notes" style={{ marginTop: 14 }}>
          <TArea value={form.notes || ""} onChange={set("notes")} rows={2} placeholder="Special instructions, delivery address" />
        </Field>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <Btn primary onClick={() => valid && onSave(form, orderItems)} disabled={!valid}>{initial ? "Update" : "Add Order"}</Btn>
          <Btn onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </Panel>
  );
}

// ─── Main Order Tracker ────────────────────────────────────────────────────────
export default function OrderTracker() {
  const [orders, setOrders] = useState([]); const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null);
  const [filterStatus, setFilterStatus] = useState("All"); const [filterType, setFilterType] = useState("All");
  const [search, setSearch] = useState(""); const [dateRange, setDateRange] = useState("all");
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [itemSums, setItemSums] = useState({}); const [docCounts, setDocCounts] = useState({});
  const [payTotals, setPayTotals] = useState({}); const [delTotals, setDelTotals] = useState({});
  const [expItems, setExpItems] = useState([]); const [expTotalQty, setExpTotalQty] = useState(0);
  const [depositPrompt, setDepositPrompt] = useState(null); const [quotePrompt, setQuotePrompt] = useState(null);
  const [repairForm, setRepairForm] = useState(null); const [batchPrompt, setBatchPrompt] = useState(null);
  const { userRole = "viewer", displayName: userName } = useAuth();
  const [creditPrompt, setCreditPrompt] = useState(null); const [reworkPrompt, setReworkPrompt] = useState(null);
  const [adminSettings, setAdminSettings] = useState({});
  const sb = createClient();

  useEffect(() => {
    (async () => {
      const { data: sets } = await sb.from("admin_settings").select("*");
      if (sets) { const s = {}; sets.forEach(r => { s[r.key] = r.value; }); setAdminSettings(s); }
    })();
  }, []);

  const loadOrders = useCallback(async () => {
    const { data: ord } = await sb.from("orders").select("*").order("created_at", { ascending: false });
    if (ord) setOrders(ord);
    const { data: items } = await sb.from("order_items").select("order_id,category,quantity");
    if (items) { const m = {}; items.forEach(i => { if (!m[i.order_id]) m[i.order_id] = { qty: 0, cats: {} }; m[i.order_id].qty += (i.quantity || 1); m[i.order_id].cats[i.category] = (m[i.order_id].cats[i.category] || 0) + (i.quantity || 1); }); setItemSums(m); }
    const { data: docs } = await sb.from("order_documents").select("order_id");
    if (docs) { const c = {}; docs.forEach(d => { c[d.order_id] = (c[d.order_id] || 0) + 1; }); setDocCounts(c); }
    const { data: pays } = await sb.from("order_payments").select("order_id,amount,reversed_at").is("reversed_at", null);
    if (pays) { const t = {}; pays.forEach(p => { t[p.order_id] = (t[p.order_id] || 0) + parseFloat(p.amount); }); setPayTotals(t); }
    const { data: dels } = await sb.from("order_deliveries").select("order_id,quantity");
    if (dels) { const t = {}; dels.forEach(d => { t[d.order_id] = (t[d.order_id] || 0) + (d.quantity || 0); }); setDelTotals(t); }
    setLoaded(true);
  }, []);
  useEffect(() => { loadOrders(); }, [loadOrders]);

  const loadExpanded = useCallback(async (oid) => {
    const { data: items } = await sb.from("order_items").select("*").eq("order_id", oid).order("sort_order");
    setExpItems(items || []); setExpTotalQty((items || []).reduce((s, i) => s + (i.quantity || 1), 0));
  }, []);
  useEffect(() => { setExpItems([]); setExpTotalQty(0); if (expandedId) loadExpanded(expandedId); }, [expandedId, loadExpanded]);

  const saveItems = async (oid, items) => {
    await sb.from("order_items").delete().eq("order_id", oid);
    if (items.length > 0) {
      const rows = items.map((i, idx) => ({ order_id: oid, category: i.category, description: i.description || null, quantity: parseInt(i.quantity) || 1, size: i.size || null, finish_type: i.finish_type || null, finish_color: i.finish_color || null, wood_type: i.wood_type || null, unit_price: parseFloat(i.unit_price) || 0, notes: i.notes || null, sort_order: idx }));
      await sb.from("order_items").insert(rows);
    }
  };

  const addOrder = async (form, items) => {
    const summary = items.length > 0 ? items.map(i => `${i.quantity}x ${i.category}${i.size ? " - " + i.size : ""}`).join("\n") : form.items || "";
    const payload = { ...form, due_date: form.due_date || null, total_value: parseFloat(form.total_value) || 0, status: "Inquiry", items: summary, quote_number: form.quote_number || null, invoice_number: form.invoice_number || null, customer_type: form.customer_type || "retail", payment_terms: form.payment_terms || "cash_before", batch_delivery: form.batch_delivery || false };
    delete payload.order_num;
    const { data: created, error } = await sb.from("orders").insert(payload).select().single();
    if (error) { alert("Error: " + error.message); return; }
    if (created) {
      await saveItems(created.id, items);
      await logAct(sb, created.id, "created", `Order ${created.order_num} created for ${form.client}`);
      if (["reseller", "commercial"].includes(form.customer_type) && CREDIT_TERMS.includes(form.payment_terms)) {
        const { data: existing } = await sb.from("client_profiles").select("id").eq("client_name", form.client).single().catch(() => ({ data: null }));
        if (!existing) await sb.from("client_profiles").insert({ client_name: form.client, customer_type: form.customer_type, credit_limit: 0 });
      }
    }
    await loadOrders(); setShowForm(false);
    if (created && !payload.batch_delivery) {
      const tq = items.reduce((s, i) => s + (parseInt(i.quantity) || 1), 0);
      const ut = parseInt(adminSettings.batch_delivery_unit_threshold) || 20;
      const vt = parseInt(adminSettings.batch_delivery_value_threshold) || 500000;
      if (tq > ut || (parseFloat(payload.total_value) || 0) > vt) setBatchPrompt(created.id);
    }
  };

  const updateOrder = async (form, items) => {
    const old = orders.find(o => o.id === editId);
    const summary = items.length > 0 ? items.map(i => `${i.quantity}x ${i.category}${i.size ? " - " + i.size : ""}`).join("\n") : form.items || old?.items || "";
    const payload = { ...form, due_date: form.due_date || null, total_value: parseFloat(form.total_value) || 0, items: summary, quote_number: form.quote_number || null, invoice_number: form.invoice_number || null, customer_type: form.customer_type || "retail", payment_terms: form.payment_terms || "cash_before", batch_delivery: form.batch_delivery || false };
    delete payload.status;
    const { error } = await sb.from("orders").update(payload).eq("id", editId);
    if (error) { alert("Error: " + error.message); return; }
    await saveItems(editId, items); await logAct(sb, editId, "edited", "Order updated");
    await loadOrders(); setEditId(null);
  };

  const advanceStatus = async (id, oldSt, newSt) => {
    const order = orders.find(o => o.id === id);
    if (userRole === "head_of_sales" && newSt === "Closed") { alert("You cannot close orders. Contact Admin."); return; }
    const tp = payTotals[id] || 0; const tv = parseFloat(order?.total_value) || 0;
    const totalQty = itemSums[id]?.qty || order?.deliverable_units || 0; const totalDel = delTotals[id] || 0;
    const sList = getStatusList(order?.order_type);
    if (userRole === "sales" && sList.indexOf(newSt) > sList.indexOf(SALES_MAX_ADVANCE_TO)) { alert("Sales users can only advance orders up to Deposit Paid."); return; }
    if (oldSt === "Quote Approved" && isCreditOrd(order)) {
      const { data: profile } = await sb.from("client_profiles").select("credit_limit").eq("client_name", order.client).single();
      const creditLimit = parseFloat(profile?.credit_limit) || 0;
      const { data: clientOrders } = await sb.from("orders").select("id,total_value").eq("client", order.client).not("status", "in", "(Delivered,Closed)").neq("id", id);
      let exposure = 0;
      if (clientOrders) { for (const co of clientOrders) { const coPaid = payTotals[co.id] || 0; exposure += Math.max((parseFloat(co.total_value) || 0) - coPaid, 0); } }
      setCreditPrompt({ orderId: id, order, creditLimit, exposure }); return;
    }
    if (newSt === "Quote Approved" && !order.quote_number) { setQuotePrompt({ orderId: id, oldStatus: oldSt }); return; }
    if (newSt === "Deposit Paid" && tp <= 0) { setDepositPrompt({ orderId: id, oldStatus: oldSt }); return; }
    if (newSt === "Delivered" && order?.batch_delivery && totalQty > 0 && totalDel < totalQty) { alert(`Delivery not complete.\nDelivered: ${totalDel} of ${totalQty}\nRemaining: ${totalQty - totalDel}`); return; }
    if (newSt === "Closed") {
      if (order?.batch_delivery && totalQty > 0 && totalDel < totalQty) { alert(`Cannot close. Delivery: ${totalDel}/${totalQty}`); return; }
      if (tv > 0 && tp < tv) { alert(`Cannot close. Balance: ${fmtKes(tv - tp)}`); return; }
    }
    const _sr = await fetch(`/api/orders/${id}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: newSt }) });
    if (!_sr.ok) { const _sj = await _sr.json().catch(() => ({})); alert(_sj.error || "Failed to update status"); return; }
    setOrders(p => p.map(o => o.id === id ? { ...o, status: newSt } : o));
  };

  const handleCreditApproval = async (d) => {
    const { orderId, order, creditLimit, exposure } = creditPrompt;
    if (userRole === "head_of_sales" && (parseFloat(order.total_value) || 0) > HEAD_OF_SALES_CREDIT_LIMIT) { alert(`Credit limit exceeded.\nYour approval limit: ${fmtKes(HEAD_OF_SALES_CREDIT_LIMIT)}\nOrder amount: ${fmtKes(parseFloat(order.total_value))}\n\nPlease contact Admin for approval.`); setCreditPrompt(null); return; }
    const oldSt = order.status; const newSt = "Material Check";
    const _cr = await fetch(`/api/orders/${orderId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: newSt, creditApprovalRef: d.approver || "credit_approved" }) });
    if (!_cr.ok) { const _cj = await _cr.json().catch(() => ({})); alert(_cj.error || "Failed to approve credit order"); setCreditPrompt(null); return; }
    await logAct(sb, orderId, "credit_approved", `Credit approved by ${d.approver}. Terms: ${PAYMENT_TERMS.find(p => p.id === order.payment_terms)?.label}. Limit: ${fmtKes(creditLimit)}. Exposure: ${fmtKes(d.newExposure)}${d.overLimit ? " (OVER LIMIT — Admin override)" : ""}${d.note ? " — " + d.note : ""}`);
    await logAct(sb, orderId, "status_change", `Status: ${oldSt} -> ${newSt} (credit bypass)`, oldSt, newSt);
    setCreditPrompt(null); await loadOrders();
  };

  const handleRework = async (d) => {
    const { orderId, order, targetStatus } = reworkPrompt; const oldSt = order.status;
    const _rr = await fetch(`/api/orders/${orderId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: targetStatus, reason: d.reason }) });
    if (!_rr.ok) { const _rj = await _rr.json().catch(() => ({})); alert(_rj.error || "Failed to send back"); setReworkPrompt(null); return; }
    await logAct(sb, orderId, "rework", `Sent back: ${oldSt} -> ${targetStatus} by ${d.approver}. Reason: ${d.reason}${d.notes ? " — " + d.notes : ""}`);
    await logAct(sb, orderId, "status_change", `Status: ${oldSt} -> ${targetStatus} (rework)`, oldSt, targetStatus);
    setReworkPrompt(null); await loadOrders();
  };

  const handleQuoteConfirm = async (q) => {
    const { orderId } = quotePrompt;
    if (q) { const { error: _qe } = await sb.from("orders").update({ quote_number: q }).eq("id", orderId); if (_qe) { alert("Failed to save quote number: " + _qe.message); return; } }
    const _qr = await fetch(`/api/orders/${orderId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: "Quote Approved" }) });
    if (!_qr.ok) { const _qj = await _qr.json().catch(() => ({})); alert(_qj.error || "Failed to advance to Quote Approved"); }
    setQuotePrompt(null); await loadOrders();
  };

  const handleDepositConfirm = async (d) => {
    const { orderId } = depositPrompt;
    if (d.invoice_number) await sb.from("orders").update({ invoice_number: d.invoice_number }).eq("id", orderId);
    const { data: _dp, error: _de } = await sb.from("order_payments").insert({ order_id: orderId, amount: d.amount, description: d.description, payment_date: d.payment_date }).select().single();
    if (_de) { alert("Failed to record deposit: " + _de.message); setDepositPrompt(null); return; }
    if (_dp?.id) { try { const _gr = await fetch(`/api/order-payments/${_dp.id}/post`, { method: "POST" }); if (!_gr.ok) { const _gj = await _gr.json().catch(() => ({})); alert("Payment recorded but GL posting failed: " + (_gj.error || "unknown error") + "\nRetry from Accounting Review."); } } catch (e) { console.warn("GL post network error", e); } }
    await logAct(sb, orderId, "payment", `Deposit: ${fmtKes(d.amount)}`);
    const _sr = await fetch(`/api/orders/${orderId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: "Deposit Paid" }) });
    if (!_sr.ok) { const _sj = await _sr.json().catch(() => ({})); alert(_sj.error || "Failed to advance to Deposit Paid"); }
    setDepositPrompt(null); await loadOrders();
  };

  const handleRepairConfirm = async (d) => {
    const p = repairForm;
    const payload = { client: p.client, contact_person: p.contact_person, author: p.author, items: d.description, status: "Reported", order_type: d.type, parent_order_id: p.id, repair_reason: d.reason, total_value: d.value, assigned_to: p.assigned_to, notes: `${d.type.toUpperCase()} for ${p.order_num}`, quote_number: p.quote_number, invoice_number: p.invoice_number };
    const { data: created, error } = await sb.from("orders").insert(payload).select().single();
    if (error) { alert("Error: " + error.message); setRepairForm(null); return; }
    if (created) { await logAct(sb, created.id, "created", `${d.type} created - ${d.reason}`); await logAct(sb, p.id, "repair_created", `${d.type} ${created.order_num} created`); }
    setRepairForm(null); await loadOrders();
  };

  const deleteOrder = async (id) => {
    if (userRole !== "admin") { alert("Only admins can delete."); return; }
    const { data: docs } = await sb.from("order_documents").select("file_path").eq("order_id", id);
    if (docs?.length) await sb.storage.from("order-documents").remove(docs.map(d => d.file_path));
    await sb.from("orders").delete().eq("id", id);
    await loadOrders(); setExpandedId(null);
  };

  // ─── Filtering ───────────────────────────────────────────────────────────────
  const filtered = orders.filter(o => {
    if (filterStatus === "All" && o.status === "Closed") return false;
    if (filterStatus !== "All" && o.status !== filterStatus) return false;
    if (filterType === "standard" && (o.order_type === "repair" || o.order_type === "return")) return false;
    if (filterType === "repairs" && o.order_type !== "repair" && o.order_type !== "return") return false;
    if (dateRange !== "all") {
      const now = new Date(); const d = new Date(o.created_at);
      if (dateRange === "today") { const t = new Date(); t.setHours(0, 0, 0, 0); const tm = new Date(); tm.setHours(23, 59, 59, 999); if (d < t || d > tm) return false; }
      else if (dateRange === "week") { const ws = new Date(); ws.setDate(now.getDate() - now.getDay()); ws.setHours(0, 0, 0, 0); if (d < ws) return false; }
      else if (dateRange === "month") { const ms = new Date(now.getFullYear(), now.getMonth(), 1); if (d < ms) return false; }
      else if (dateRange === "range" && dateFrom && dateTo) { const df = new Date(dateFrom + "T00:00:00"); const dt = new Date(dateTo + "T23:59:59"); if (d < df || d > dt) return false; }
    }
    if (search) { const q = search.toLowerCase(); return [o.client, o.items, o.order_num, o.assigned_to, o.author, o.contact_person, o.notes, o.quote_number, o.invoice_number].filter(Boolean).join(" ").toLowerCase().includes(q); }
    return true;
  });

  const allSt = [...new Set([...STATUSES, ...REPAIR_STATUSES])];
  const stCounts = allSt.reduce((a, s) => { a[s] = orders.filter(o => o.status === s).length; return a; }, {});
  const canCreate = ROLES_CAN_CREATE.includes(userRole);
  const canEdit = ROLES_CAN_EDIT.includes(userRole);
  const canAdvance = ROLES_CAN_ADVANCE.includes(userRole);

  if (!loaded) return <Loading />;

  return (
    <div style={{ padding: "20px 16px" }}>
      {/* Modals */}
      {quotePrompt && <QuotePrompt onConfirm={handleQuoteConfirm} onCancel={() => setQuotePrompt(null)} />}
      {depositPrompt && <DepositPrompt onConfirm={handleDepositConfirm} onCancel={() => setDepositPrompt(null)} />}
      {repairForm && <RepairForm parentOrder={repairForm} onConfirm={handleRepairConfirm} onCancel={() => setRepairForm(null)} />}
      {creditPrompt && <CreditApprovalPrompt order={creditPrompt.order} creditLimit={creditPrompt.creditLimit} exposure={creditPrompt.exposure} userRole={userRole} onConfirm={handleCreditApproval} onCancel={() => setCreditPrompt(null)} />}
      {reworkPrompt && <ReworkPrompt order={reworkPrompt.order} targetStatus={reworkPrompt.targetStatus} onConfirm={handleRework} onCancel={() => setReworkPrompt(null)} />}
      {batchPrompt && (
        <Modal title="Enable Batch Delivery?" onClose={() => setBatchPrompt(null)}
          footer={<>
            <Btn onClick={() => setBatchPrompt(null)}>No</Btn>
            <Btn primary onClick={async () => { await sb.from("orders").update({ batch_delivery: true }).eq("id", batchPrompt); await loadOrders(); setBatchPrompt(null); }} style={{ background: C.green }}>Yes, Enable</Btn>
          </>}
        >
          <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>This order exceeds the threshold. Enable batch delivery for hotel, bulk, or multi-phase projects.</p>
        </Modal>
      )}

      {/* Page header */}
      <PageHeader
        title="All Orders"
        description={`${orders.length} total · ${orders.filter(o => !["Delivered", "Closed", "Redelivered"].includes(o.status)).length} active`}
        actions={canCreate && <Btn primary onClick={() => { setShowForm(true); setEditId(null); }} style={{ padding: "10px 20px", fontSize: 14 }}>+ New Order</Btn>}
        style={{ marginBottom: 16 }}
      />

      {/* Status filter pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 4 }}>
        {allSt.filter(s => stCounts[s] > 0 || STATUSES.includes(s)).map(s => {
          const active = filterStatus === s;
          const col = ALL_STATUS_COLORS[s] || { bg: "#f1efeb", text: C.muted, border: C.line };
          return (
            <div key={s} onClick={() => setFilterStatus(filterStatus === s ? "All" : s)}
              style={{ padding: "5px 11px", borderRadius: 20, cursor: "pointer", flexShrink: 0, background: active ? col.bg : C.card, border: `1.5px solid ${active ? col.border : C.line}`, fontSize: 11, whiteSpace: "nowrap", userSelect: "none" }}>
              <span style={{ fontWeight: 800, color: active ? col.text : C.ink, fontFamily: C.mono }}>{stCounts[s] || 0}</span>
              <span style={{ color: active ? col.text : C.muted, marginLeft: 5 }}>{s}</span>
            </div>
          );
        })}
      </div>

      {/* Search / filter toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <TInput type="text" placeholder="Search client, quote, invoice…" value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 180, maxWidth: 320 }} />
        <TSelect value={filterType} onChange={e => setFilterType(e.target.value)} style={{ maxWidth: 150 }}>
          <option value="All">All Types</option>
          <option value="standard">Orders</option>
          <option value="repairs">Repairs</option>
        </TSelect>
        <TSelect value={dateRange} onChange={e => { setDateRange(e.target.value); if (e.target.value !== "range") { setDateFrom(""); setDateTo(""); } }} style={{ maxWidth: 140 }}>
          <option value="all">All dates</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="range">Date range</option>
        </TSelect>
        {dateRange === "range" && (
          <>
            <TInput type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ maxWidth: 140 }} />
            <TInput type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ maxWidth: 140 }} />
          </>
        )}
        {(filterStatus !== "All" || filterType !== "All" || search || dateRange !== "all") && (
          <Btn onClick={() => { setFilterStatus("All"); setFilterType("All"); setSearch(""); setDateRange("all"); setDateFrom(""); setDateTo(""); }}>Clear</Btn>
        )}
      </div>

      {/* Forms */}
      {showForm && canCreate && <OrderForm onSave={addOrder} onCancel={() => setShowForm(false)} userRole={userRole} />}
      {editId && canEdit && <OrderForm initial={orders.find(o => o.id === editId)} onSave={updateOrder} onCancel={() => setEditId(null)} userRole={userRole} />}

      {/* Order list */}
      {filtered.length === 0
        ? <Empty message={orders.length === 0 ? "No orders yet." : "No orders match your filters."} />
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map(order => {
              const expanded = expandedId === order.id;
              const days = order.due_date ? Math.ceil((new Date(order.due_date + "T12:00:00") - new Date()) / 86400000) : null;
              const overdue = days !== null && days < 0 && !["Delivered", "Closed", "Redelivered"].includes(order.status);
              const tp = payTotals[order.id] || 0; const tv = parseFloat(order.total_value) || 0;
              const ps = getPayStatus(tp, tv); const pct = tv > 0 ? Math.round((tp / tv) * 100) : 0; const bal = tv - tp;
              const iS = itemSums[order.id]; const totalQty = iS?.qty || order.deliverable_units || 0; const totalDel = delTotals[order.id] || 0; const delPct = totalQty > 0 ? Math.round((totalDel / totalQty) * 100) : 0;
              const sList = getStatusList(order.order_type); const cIdx = sList.indexOf(order.status);
              const isCreditOrdFlag = isCreditOrd(order);
              let nextSt = cIdx < sList.length - 1 ? sList[cIdx + 1] : null;
              if (isCreditOrdFlag && order.status === "Quote Approved" && nextSt === "Deposit Paid") nextSt = "Material Check";
              const displayList = (isCreditOrdFlag ? sList.filter(s => s !== "Deposit Paid") : sList).filter(s => order.batch_delivery || s !== "Partially Delivered");
              const displayIdx = displayList.indexOf(order.status);
              const isCreditAdvance = isCreditOrdFlag && order.status === "Quote Approved" && nextSt === "Material Check";
              const reworkTarget = REWORK_TARGETS[order.status]; const canRework = reworkTarget && ROLES_CAN_REWORK.includes(userRole);
              const isRepair = order.order_type === "repair" || order.order_type === "return";
              const showDelivery = DELIVERY_VISIBLE_FROM.includes(order.status) && !isRepair && order.batch_delivery;
              const children = orders.filter(o => o.parent_order_id === order.id);
              const parentOrd = order.parent_order_id ? orders.find(o => o.id === order.parent_order_id) : null;
              const borderClass = STATUS_BORDER_CLASS[order.status] || "";

              return (
                <div key={order.id} className={`order-card ${borderClass}`} style={{ background: C.card, borderRadius: C.radius, border: `1.5px solid ${overdue ? "#ef9a9a" : C.line}`, overflow: "hidden", boxShadow: expanded ? "var(--shadow-lg)" : "var(--shadow-sm)" }}>
                  {/* Card header — click to expand */}
                  <div onClick={() => setExpandedId(expanded ? null : order.id)} style={{ padding: "12px 16px", cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 4 }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontFamily: C.mono, color: C.muted, fontWeight: 600, background: "#f0ede8", padding: "2px 7px", borderRadius: 4 }}>{order.order_num}</span>
                        {isRepair && <Badge color="red" style={{ fontSize: 9, textTransform: "uppercase" }}>{order.order_type}</Badge>}
                        {order.customer_type && order.customer_type !== "retail" && <Badge color={order.customer_type === "reseller" ? "purple" : "blue"} style={{ fontSize: 9, textTransform: "uppercase" }}>{order.customer_type}</Badge>}
                        {order.quote_number && <span style={{ fontSize: 10, color: C.blue, background: C.blueBg, padding: "1px 6px", borderRadius: 3, fontFamily: C.mono }}>Q:{order.quote_number}</span>}
                        {order.invoice_number && <span style={{ fontSize: 10, color: C.purple, background: C.purpleBg, padding: "1px 6px", borderRadius: 3, fontFamily: C.mono }}>I:{order.invoice_number}</span>}
                      </div>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <StatusChip status={order.status} />
                        {tv > 0 && <StatusChip status={ps} type="payment" />}
                        {tv > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: C.ink, fontFamily: C.mono, background: "#f7f7f5", padding: "2px 8px", borderRadius: 4 }}>{fmtKes(tv)}</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: overdue ? C.red : C.ink, marginBottom: 3, letterSpacing: "-0.3px" }}>
                      {order.client}
                      {docCounts[order.id] && <span style={{ fontSize: 10.5, color: C.green, marginLeft: 7 }}>{docCounts[order.id]} docs</span>}
                      {children.length > 0 && <span style={{ fontSize: 10.5, color: C.amber, marginLeft: 7 }}>{children.length} repairs</span>}
                    </div>
                    {iS
                      ? <div style={{ fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{Object.entries(iS.cats).map(([c, q]) => `${q}x ${c}`).join(" · ")}</div>
                      : <div style={{ fontSize: 12, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{order.items}</div>
                    }
                    {order.notes && <div style={{ fontSize: 11, color: C.amber, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>! {order.notes}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6, fontSize: 11, marginTop: 5 }}>
                      <div style={{ display: "flex", gap: 12, color: C.muted }}>
                        {tv > 0 && <span style={{ fontFamily: C.mono }}><strong style={{ color: C.ink }}>{pct}%</strong> paid · Bal: {fmtKes(Math.max(bal, 0))}</span>}
                        {showDelivery && totalQty > 0 && <span>{delPct}% delivered ({totalDel}/{totalQty})</span>}
                        {order.author && <span>by {order.author}</span>}
                      </div>
                      <div style={{ color: overdue ? C.red : C.muted, fontWeight: overdue ? 700 : 400, fontFamily: C.mono }}>
                        {order.due_date ? <>{new Date(order.due_date + "T12:00:00").toLocaleDateString("en-KE", { day: "numeric", month: "short" })}{overdue && ` · ${Math.abs(days)}d late`}</> : ""}
                      </div>
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {expanded && (
                    <div style={{ padding: "0 16px 18px", borderTop: `1px solid ${C.line}` }}>
                      <div className="detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
                        {[
                          { l: "Author", v: order.author },
                          { l: "Client Contact", v: order.contact_person },
                          { l: "Assigned To", v: order.assigned_to },
                          { l: "Created", v: new Date(order.created_at).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }), mono: true },
                          { l: "Order Value", v: tv ? fmtKes(tv) : "Not set", mono: true },
                          { l: "Due Date", v: order.due_date ? new Date(order.due_date + "T12:00:00").toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "Not set", mono: true },
                          { l: "Quote #", v: order.quote_number, mono: true },
                          { l: "Invoice #", v: order.invoice_number, mono: true },
                          { l: "Customer Type", v: CUSTOMER_TYPES.find(c => c.id === order.customer_type)?.label || "Retail" },
                          { l: "Payment Terms", v: PAYMENT_TERMS.find(p => p.id === order.payment_terms)?.label || "—" },
                          { l: "Batch Delivery", v: order.batch_delivery ? "Enabled" : "Standard" },
                        ].map(({ l, v, mono }) => (
                          <div key={l}>
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{l}</div>
                            <div style={{ fontSize: 13, color: C.ink, fontFamily: mono ? C.mono : "inherit" }}>{v || "—"}</div>
                          </div>
                        ))}
                        {isRepair && (
                          <div>
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Repair Reason</div>
                            <div style={{ fontSize: 13, color: C.red, fontWeight: 700 }}>{order.repair_reason || "—"}</div>
                          </div>
                        )}
                      </div>

                      {(parentOrd || children.length > 0) && (
                        <div style={{ marginTop: 14, padding: 12, background: C.amberBg, borderRadius: 9, border: `1px solid ${C.amberBd}` }}>
                          <div style={{ fontSize: 10.5, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>Linked Orders</div>
                          {parentOrd && <div style={{ fontSize: 12, color: C.ink }}>Original: <strong style={{ fontFamily: C.mono }}>{parentOrd.order_num}</strong> — {parentOrd.client}</div>}
                          {children.map(c => (
                            <div key={c.id} style={{ fontSize: 12, color: C.ink, padding: "2px 0" }}>
                              <Badge color="red" style={{ fontSize: 9, marginRight: 5, textTransform: "uppercase" }}>{c.order_type}</Badge>
                              <strong style={{ fontFamily: C.mono }}>{c.order_num}</strong> — {c.repair_reason} <StatusChip status={c.status} />
                            </div>
                          ))}
                        </div>
                      )}

                      <ItemsTable items={expItems} />
                      {order.items && !expItems.length && <div style={{ marginTop: 14 }}><div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Items</div><TruncText text={order.items} lines={3} /></div>}
                      {order.notes && <div style={{ marginTop: 12 }}><div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>Special Requests</div><TruncText text={order.notes} lines={3} /></div>}

                      {/* Workflow progress */}
                      <div style={{ marginTop: 18 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                          Workflow{isRepair ? " (Repair)" : ""}{isCreditOrdFlag && <span style={{ color: C.purple, marginLeft: 6 }}>(Credit)</span>}
                        </div>
                        <div style={{ display: "flex", gap: 2, marginBottom: 10 }}>
                          {displayList.map((s, i) => (
                            <div key={s} title={s} style={{ flex: 1, height: 6, borderRadius: 3, background: i <= displayIdx ? (ALL_STATUS_COLORS[s]?.text || C.ink) : C.line }} />
                          ))}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <StatusChip status={order.status} />
                          {canAdvance && nextSt && order.status !== "Closed" && !(userRole === "sales" && sList.indexOf(nextSt) > sList.indexOf(SALES_MAX_ADVANCE_TO))
                            ? <Btn primary onClick={() => advanceStatus(order.id, order.status, nextSt)} style={{ background: isCreditAdvance ? C.purple : C.ink, border: `1px solid ${isCreditAdvance ? C.purple : C.ink}` }}>{isCreditAdvance ? "Credit Approve" : `Next: ${nextSt}`}</Btn>
                            : !nextSt && <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>Complete</span>
                          }
                          {canRework && <Btn onClick={() => setReworkPrompt({ orderId: order.id, order, targetStatus: reworkTarget })} style={{ background: C.amberBg, color: C.amber, border: `1.5px solid ${C.amberBd}` }}>↩ Send Back</Btn>}
                        </div>
                      </div>

                      {showDelivery && <DeliveryPanel orderId={order.id} totalQty={expTotalQty || order.deliverable_units || 0} userRole={userRole} payBalance={Math.max(bal, 0)} onDeliveryChange={(d) => setDelTotals(p => ({ ...p, [order.id]: d }))} orderStatus={order.status} onAutoAdvance={async (newSt) => { const _ar = await fetch(`/api/orders/${order.id}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newStatus: newSt }) }); if (_ar.ok) setOrders(p => p.map(o => o.id === order.id ? { ...o, status: newSt } : o)); }} />}
                      <PaymentPanel orderId={order.id} totalValue={tv} userRole={userRole} orderStatus={order.status} onPaymentChange={(t) => setPayTotals(p => ({ ...p, [order.id]: t }))} />
                      <DocumentsPanel orderId={order.id} userRole={userRole} />
                      <NotesThread orderId={order.id} userRole={userRole} userName={userName} orderStatus={order.status} />
                      <ActivityTimeline orderId={order.id} />

                      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                        {order.status === "Closed" && <div style={{ padding: "10px 14px", background: "#f5f5f3", borderRadius: 8, fontSize: 12, color: C.muted, fontWeight: 600, textAlign: "center", width: "100%" }}>Order Archived — Read Only</div>}
                        {order.status !== "Closed" && canEdit && <Btn onClick={e => { e.stopPropagation(); setEditId(order.id); setExpandedId(null); }}>Edit</Btn>}
                        <Link href={`/orders/${order.id}/form`} onClick={e => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 15px", borderRadius: C.radiusSm, border: `1.5px solid ${C.coral}`, color: C.coral, fontWeight: 700, fontSize: 13, textDecoration: "none", background: C.card }}>📄 Full Form</Link>
                        {["Delivered", "Closed"].includes(order.status) && !isRepair && ROLES_CAN_REPAIR.includes(userRole) && <Btn onClick={e => { e.stopPropagation(); setRepairForm(order); }} style={{ background: C.amberBg, color: C.amber, border: `1px solid ${C.amberBd}` }}>Return / Repair</Btn>}
                        {order.status !== "Closed" && userRole === "admin" && <Btn danger onClick={e => { e.stopPropagation(); if (confirm("Delete permanently?")) deleteOrder(order.id); }}>Delete</Btn>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      }
      <style>{`
        @media(max-width:640px){.form-grid,.detail-grid{grid-template-columns:1fr!important}.items-table{display:none!important}.items-cards{display:flex!important}}
        @media(min-width:641px){.items-cards{display:none!important}}
      `}</style>
    </div>
  );
}
