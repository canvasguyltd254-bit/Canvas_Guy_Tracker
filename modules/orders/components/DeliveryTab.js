'use client';

/**
 * modules/orders/components/DeliveryTab.js
 *
 * Fulfilment tab for the order form.
 *
 * Lock rule:
 *   Module is read-only until order.status is in DELIVERY_VISIBLE_FROM
 *   (Ready for Delivery, Partially Delivered, Delivered, Closed).
 *
 * Two flows based on order.batch_delivery:
 *   false → Simple: Generate Delivery Note + Mark Delivered
 *   true  → Batch:  Fulfilment Summary + Batch Cards + Batch Planner
 *
 * Props:
 *   orderId   string  — order UUID
 *   order     object  — full order row
 *   userRole  string  — current user's role
 *   onUpdate  fn      — called after any mutation so parent can refresh
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/shared/supabase/client';
import {
  BATCH_STATUS_COLORS,
  BATCH_STATUS_TRANSITIONS,
  ROLES_CAN_CREATE_BATCH,
  ROLES_CAN_UPDATE_BATCH,
  DELIVERY_VISIBLE_FROM,
} from './constants';

const supabase = createClient();

// Statuses where delivery actions are active
const ACTIVE_STATUSES = new Set(DELIVERY_VISIBLE_FROM);

const fmtDate = d =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const fmtKES = v => `KES ${Math.round(parseFloat(v) || 0).toLocaleString('en-KE')}`;

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const c = BATCH_STATUS_COLORS[status] || { bg: '#f3f4f6', text: '#374151', border: '#d1d5db' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 9px', borderRadius: 20,
      fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {status}
    </span>
  );
}

function QtyBar({ ordered, batched, delivered }) {
  const deliveredPct = ordered > 0 ? Math.min((delivered / ordered) * 100, 100) : 0;
  const batchedPct   = ordered > 0 ? Math.min(((batched - delivered) / ordered) * 100, 100 - deliveredPct) : 0;
  return (
    <div style={{ height: 5, borderRadius: 3, background: '#f3f4f6', marginTop: 4, overflow: 'hidden', display: 'flex' }}>
      <div style={{ width: `${deliveredPct}%`, background: '#22c55e', borderRadius: '3px 0 0 3px' }} />
      <div style={{ width: `${batchedPct}%`, background: '#93c5fd' }} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function DeliveryTab({ orderId, order, userRole, onUpdate }) {
  // Batch orders are accessible from Production onwards; simple orders need Ready for Delivery+
  const isBatch   = !!order?.batch_delivery;
  const isActive  = ACTIVE_STATUSES.has(order?.status) || (isBatch && order?.status === 'Production');
  const canAct    = ROLES_CAN_CREATE_BATCH.includes(userRole);
  // Sales can edit delivery details + mark delivered in simple flow, but cannot create/manage batches
  const canDeliveryAct = canAct || userRole === 'sales';
  const isAlreadyDelivered = ['Delivered', 'Closed'].includes(order?.status);

  // ── Batch data (only needed for batch flow) ──────────────────────────────────
  const [fulfillment, setFulfillment] = useState([]);
  const [batches, setBatches]         = useState([]);
  const [loading, setLoading]         = useState(isBatch);
  const [loadError, setLoadError]     = useState(null);

  // ── Delivery details edit ────────────────────────────────────────────────────
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsForm, setDetailsForm] = useState({
    delivery_address:      order?.delivery_address      || '',
    delivery_contact:      order?.delivery_contact      || '',
    delivery_instructions: order?.delivery_instructions || '',
  });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError]   = useState(null);

  // ── Simple delivery ──────────────────────────────────────────────────────────
  const [simpleSaving, setSimpleSaving] = useState(false);
  const [simpleError, setSimpleError]   = useState(null);
  const [simpleConfirm, setSimpleConfirm] = useState(false);

  // ── Batch planner ────────────────────────────────────────────────────────────
  const [showPlanner, setShowPlanner]   = useState(false);
  const [plannerQtys, setPlannerQtys]   = useState({});
  const [plannerForm, setPlannerForm]   = useState({
    planned_date: '', driver: '', vehicle: '', delivery_location: '', notes: '',
  });
  const [plannerError, setPlannerError]   = useState(null);
  const [plannerSaving, setPlannerSaving] = useState(false);

  // ── Delivered quantities modal ───────────────────────────────────────────────
  const [deliveredModal, setDeliveredModal]   = useState(null);
  const [deliveredQtys, setDeliveredQtys]     = useState({});
  const [deliveredSaving, setDeliveredSaving] = useState(false);
  const [deliveredError, setDeliveredError]   = useState(null);

  // ── Fetch batch data ─────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!isBatch) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [fRes, bRes] = await Promise.all([
        supabase
          .from('order_item_fulfillment')
          .select('*')
          .eq('order_id', orderId)
          .order('category'),
        supabase
          .from('delivery_batches')
          .select(`
            *,
            delivery_batch_items (
              id, order_item_id, quantity_planned, quantity_delivered, quantity_rejected, rejection_reason,
              order_items ( id, category, description, size, quantity, unit_price )
            )
          `)
          .eq('order_id', orderId)
          .order('batch_number', { ascending: true }),
      ]);
      if (fRes.error) throw new Error(fRes.error.message);
      if (bRes.error) throw new Error(bRes.error.message);
      setFulfillment(fRes.data || []);
      setBatches(bRes.data || []);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [orderId, isBatch]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Delivery details save ────────────────────────────────────────────────────

  const saveDetails = async () => {
    setDetailsSaving(true);
    setDetailsError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detailsForm),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save');
      setEditingDetails(false);
      if (onUpdate) onUpdate();
    } catch (e) {
      setDetailsError(e.message);
    } finally {
      setDetailsSaving(false);
    }
  };

  // ── Simple: Mark Delivered ───────────────────────────────────────────────────

  const markDelivered = async () => {
    setSimpleSaving(true);
    setSimpleError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'Delivered' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update order');
      setSimpleConfirm(false);
      if (onUpdate) onUpdate();
    } catch (e) {
      setSimpleError(e.message);
    } finally {
      setSimpleSaving(false);
    }
  };

  // ── Batch: Create batch ──────────────────────────────────────────────────────

  const openPlanner = () => {
    const initial = {};
    fulfillment.forEach(f => { if (f.remaining_qty > 0) initial[f.order_item_id] = 0; });
    setPlannerQtys(initial);
    setPlannerForm({ planned_date: '', driver: '', vehicle: '', delivery_location: '', notes: '' });
    setPlannerError(null);
    setShowPlanner(true);
  };

  const createBatch = async () => {
    setPlannerError(null);
    const items = Object.entries(plannerQtys)
      .filter(([, qty]) => qty > 0)
      .map(([order_item_id, quantity_planned]) => ({
        order_item_id,
        quantity_planned: parseInt(quantity_planned, 10),
      }));
    if (items.length === 0) { setPlannerError('Enter at least one item quantity to create a batch.'); return; }
    const overAllocated = items.filter(item => {
      const f = fulfillment.find(f => f.order_item_id === item.order_item_id);
      return f && item.quantity_planned > f.remaining_qty;
    });
    if (overAllocated.length > 0) { setPlannerError('Some quantities exceed remaining available. Reduce them and try again.'); return; }
    setPlannerSaving(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...plannerForm, items }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to create batch');
      setShowPlanner(false);
      await loadData();
      if (onUpdate) onUpdate();
    } catch (e) {
      setPlannerError(e.message);
    } finally {
      setPlannerSaving(false);
    }
  };

  // ── Batch: Advance status ────────────────────────────────────────────────────

  const advanceBatch = async (batch, newStatus, reason) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/batches/${batch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus, reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update batch');
      await loadData();
      if (onUpdate) onUpdate();
    } catch (e) {
      alert(e.message);
    }
  };

  // ── Batch: Record delivered/rejected quantities ──────────────────────────────

  const openDeliveredModal = (batch) => {
    const initial = {};
    (batch.delivery_batch_items || []).forEach(item => {
      initial[item.id] = { qty_delivered: item.quantity_planned, qty_rejected: 0 };
    });
    setDeliveredQtys(initial);
    setDeliveredError(null);
    setDeliveredModal({ batch });
  };

  const saveDeliveredQtys = async () => {
    if (!deliveredModal) return;
    setDeliveredSaving(true);
    setDeliveredError(null);
    try {
      const items = Object.entries(deliveredQtys).map(([id, v]) => ({
        id,
        quantity_delivered: parseInt(v.qty_delivered, 10) || 0,
        quantity_rejected:  parseInt(v.qty_rejected,  10) || 0,
      }));
      const res = await fetch(`/api/orders/${orderId}/batches/${deliveredModal.batch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save');
      await advanceBatch(deliveredModal.batch, 'Delivered');
      setDeliveredModal(null);
    } catch (e) {
      setDeliveredError(e.message);
    } finally {
      setDeliveredSaving(false);
    }
  };

  // ── Batch: Action buttons per batch card ─────────────────────────────────────

  const canUpdate = ROLES_CAN_UPDATE_BATCH.includes(userRole);

  function BatchActions({ batch }) {
    const transitions   = BATCH_STATUS_TRANSITIONS[batch.status] || [];
    if (transitions.length === 0) return null;
    const primaryNext   = transitions.find(s => !['Cancelled', 'Rejected', 'Returned'].includes(s));
    const exceptionNext = transitions.filter(s => ['Cancelled', 'Rejected', 'Returned'].includes(s));
    const btn = (label, onClick, color, bg, border) => (
      <button onClick={onClick} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${border}`, background: bg, color }}>
        {label}
      </button>
    );
    return (
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <a
          href={`/orders/${orderId}/delivery-note?batch=${batch.id}`}
          target="_blank"
          style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: '1px solid #d1d5db', background: '#fff', color: '#374151', textDecoration: 'none' }}
        >
          🖨 Delivery Note
        </a>
        <a
          href={`/orders/${orderId}/delivery-note?batch=${batch.id}&show=amounts`}
          target="_blank"
          style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: '1px solid #d1d5db', background: '#fff', color: '#374151', textDecoration: 'none' }}
        >
          🖨 Internal Copy
        </a>
        {primaryNext && canUpdate && (
          primaryNext === 'Delivered'
            ? btn('✓ Mark Delivered', () => openDeliveredModal(batch), '#15803d', '#f0fdf4', '#bbf7d0')
            : primaryNext === 'Signed'
              ? btn('✓ Mark Signed', () => advanceBatch(batch, 'Signed'), '#065f46', '#ecfdf5', '#6ee7b7')
              : btn(`→ ${primaryNext}`, () => advanceBatch(batch, primaryNext), '#1d4ed8', '#eff6ff', '#bfdbfe')
        )}
        {exceptionNext.includes('Cancelled') && canAct &&
          btn('Cancel', () => { const r = window.prompt('Reason for cancellation?'); if (r !== null) advanceBatch(batch, 'Cancelled', r); }, '#9ca3af', '#f9fafb', '#e5e7eb')
        }
        {exceptionNext.includes('Rejected') && canUpdate &&
          btn('Rejected', () => advanceBatch(batch, 'Rejected'), '#dc2626', '#fef2f2', '#fecaca')
        }
        {exceptionNext.includes('Returned') && canUpdate &&
          btn('Returned', () => advanceBatch(batch, 'Returned'), '#b45309', '#fefce8', '#fde68a')
        }
      </div>
    );
  }

  // ── Totals ───────────────────────────────────────────────────────────────────

  const totalOrdered   = fulfillment.reduce((s, f) => s + (f.ordered_qty   || 0), 0);
  const totalBatched   = fulfillment.reduce((s, f) => s + (f.batched_qty   || 0), 0);
  const totalDelivered = fulfillment.reduce((s, f) => s + (f.delivered_qty || 0), 0);
  const totalRemaining = fulfillment.reduce((s, f) => s + (f.remaining_qty || 0), 0);

  // ── Shared styles ─────────────────────────────────────────────────────────────

  const card = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
    padding: '16px 18px', marginBottom: 14,
  };
  const inputStyle = {
    width: '100%', padding: '7px 10px', border: '1px solid #d1d5db',
    borderRadius: 6, fontSize: 13, color: '#111', outline: 'none', background: '#fafafa',
  };
  const sectionLabel = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 10,
  };
  const fieldLabel = {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 2,
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 20, background: '#f9fafb', minHeight: 400 }}>

      {/* ── 1. Delivery Details — always visible ── */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={sectionLabel}>Delivery Details</div>
          {!editingDetails && canDeliveryAct && (
            <button
              onClick={() => {
                setDetailsForm({
                  delivery_address:      order?.delivery_address      || '',
                  delivery_contact:      order?.delivery_contact      || '',
                  delivery_instructions: order?.delivery_instructions || '',
                });
                setDetailsError(null);
                setEditingDetails(true);
              }}
              style={{ padding: '4px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, background: '#fff', cursor: 'pointer', color: '#374151' }}
            >
              Edit
            </button>
          )}
        </div>

        {editingDetails ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Delivery Address</div>
              <textarea value={detailsForm.delivery_address} onChange={e => setDetailsForm(f => ({ ...f, delivery_address: e.target.value }))} rows={3} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Full delivery address" />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Delivery Contact</div>
              <input type="text" value={detailsForm.delivery_contact} onChange={e => setDetailsForm(f => ({ ...f, delivery_contact: e.target.value }))} style={inputStyle} placeholder="Contact name and number" />
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Special Instructions</div>
              <textarea value={detailsForm.delivery_instructions} onChange={e => setDetailsForm(f => ({ ...f, delivery_instructions: e.target.value }))} rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Any instructions for the delivery team" />
            </div>
            {detailsError && <div style={{ color: '#dc2626', fontSize: 12 }}>{detailsError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveDetails} disabled={detailsSaving} style={{ padding: '7px 16px', background: '#E8512A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: detailsSaving ? 0.6 : 1 }}>
                {detailsSaving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditingDetails(false)} style={{ padding: '7px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
            <div>
              <div style={fieldLabel}>Deliver To</div>
              <div style={{ fontWeight: 600, color: '#111' }}>{order?.client}</div>
              {order?.delivery_address
                ? <div style={{ color: '#6b7280', marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{order.delivery_address}</div>
                : <div style={{ color: '#d1d5db', fontStyle: 'italic' }}>No address set</div>
              }
            </div>
            <div>
              <div style={fieldLabel}>Contact</div>
              {order?.delivery_contact
                ? <div style={{ color: '#374151' }}>{order.delivery_contact}</div>
                : <div style={{ color: '#d1d5db', fontStyle: 'italic' }}>No contact set</div>
              }
              {order?.delivery_instructions && (
                <div style={{ marginTop: 10, background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6, padding: '7px 10px', color: '#92400e', fontSize: 11 }}>
                  <span style={{ fontWeight: 700 }}>Instructions: </span>{order.delivery_instructions}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 2. Locked — order not yet Ready for Delivery ── */}
      {!isActive && (
        <div style={{ ...card, textAlign: 'center', padding: '28px 20px', background: '#f9fafb', border: '1px dashed #e5e7eb' }}>
          <div style={{ fontSize: 20, marginBottom: 8 }}>🔒</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Delivery not yet available</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>
            Delivery actions unlock once the order reaches Ready for Delivery.
          </div>
        </div>
      )}

      {/* ── 3. SIMPLE FLOW — batch_delivery = false ── */}
      {isActive && !isBatch && (
        <div style={card}>
          <div style={sectionLabel}>Delivery</div>

          {isAlreadyDelivered ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#15803d' }}>Order Delivered</div>
                {order?.actual_delivery_date && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{fmtDate(order.actual_delivery_date)}</div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Print buttons — side by side */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <a
                  href={`/orders/${orderId}/delivery-note`}
                  target="_blank"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 12px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, color: '#374151', textDecoration: 'none', textAlign: 'center' }}
                >
                  🖨 Delivery Note
                </a>
                <a
                  href={`/orders/${orderId}/delivery-note?show=amounts`}
                  target="_blank"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 12px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, color: '#374151', textDecoration: 'none', textAlign: 'center' }}
                >
                  🖨 Internal Copy
                </a>
              </div>

              {/* Mark Delivered — full width */}
              {canDeliveryAct && !simpleConfirm && (
                <button
                  onClick={() => setSimpleConfirm(true)}
                  style={{ width: '100%', padding: '11px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >
                  ✓ Mark Delivered
                </button>
              )}

              {canDeliveryAct && simpleConfirm && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '12px' }}>
                  <div style={{ fontSize: 12, color: '#374151', marginBottom: 8, fontWeight: 600 }}>Confirm this order has been delivered?</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button
                      onClick={markDelivered}
                      disabled={simpleSaving}
                      style={{ padding: '9px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 5, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: simpleSaving ? 0.6 : 1 }}
                    >
                      {simpleSaving ? 'Saving…' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => setSimpleConfirm(false)}
                      style={{ padding: '9px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 5, fontSize: 13, cursor: 'pointer', color: '#374151' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {simpleError && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#dc2626' }}>{simpleError}</div>
          )}
        </div>
      )}

      {/* ── 4. BATCH FLOW — batch_delivery = true ── */}
      {isActive && isBatch && (
        <>
          {/* Loading */}
          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading fulfilment data…</div>
          )}

          {loadError && (
            <div style={{ padding: 16, color: '#dc2626', fontSize: 13 }}>Error: {loadError}</div>
          )}

          {!loading && !loadError && (
            <>
              {/* ── 4a. Fulfilment Summary ── */}
              {fulfillment.length > 0 && (
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <div style={sectionLabel}>Fulfilment Summary</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#6b7280' }}>
                      <span style={{ display: 'inline-block', width: 10, height: 5, background: '#22c55e', borderRadius: 2 }} /> Delivered
                      <span style={{ display: 'inline-block', width: 10, height: 5, background: '#93c5fd', borderRadius: 2 }} /> In batch
                    </div>
                  </div>
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                      <tr>
                        {['Item', 'Ordered', 'Batched', 'Delivered', 'Remaining'].map(h => (
                          <th key={h} style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9ca3af', padding: '0 10px 8px', textAlign: h === 'Item' ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fulfillment.map(f => (
                        <tr key={f.order_item_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '9px 10px' }}>
                            <div style={{ fontWeight: 600, fontSize: 12, color: '#111' }}>{f.category}</div>
                            {f.description && <div style={{ fontSize: 11, color: '#9ca3af' }}>{f.description}{f.size ? ` · ${f.size}` : ''}</div>}
                            <QtyBar ordered={f.ordered_qty} batched={f.batched_qty} delivered={f.delivered_qty} />
                          </td>
                          <td style={{ textAlign: 'right', padding: '9px 10px', fontFamily: 'monospace', fontSize: 12, color: '#111' }}>{f.ordered_qty}</td>
                          <td style={{ textAlign: 'right', padding: '9px 10px', fontFamily: 'monospace', fontSize: 12, color: '#1d4ed8' }}>{f.batched_qty || '—'}</td>
                          <td style={{ textAlign: 'right', padding: '9px 10px', fontFamily: 'monospace', fontSize: 12, color: '#15803d' }}>{f.delivered_qty || '—'}</td>
                          <td style={{ textAlign: 'right', padding: '9px 10px', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: f.remaining_qty > 0 ? '#E8512A' : '#9ca3af' }}>
                            {f.remaining_qty > 0 ? f.remaining_qty : '✓'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid #e5e7eb' }}>
                        <td style={{ padding: '8px 10px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Totals</td>
                        <td style={{ textAlign: 'right', padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#111' }}>{totalOrdered}</td>
                        <td style={{ textAlign: 'right', padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#1d4ed8' }}>{totalBatched || '—'}</td>
                        <td style={{ textAlign: 'right', padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>{totalDelivered || '—'}</td>
                        <td style={{ textAlign: 'right', padding: '8px 10px', fontFamily: 'monospace', fontWeight: 700, color: totalRemaining > 0 ? '#E8512A' : '#15803d' }}>
                          {totalRemaining > 0 ? totalRemaining : '✓ All batched'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* ── 4b. Batch list header ── */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={sectionLabel}>Delivery Batches {batches.length > 0 && `(${batches.length})`}</div>
                {canAct && totalRemaining > 0 && (
                  <button onClick={openPlanner} style={{ padding: '6px 14px', background: '#E8512A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    + Create Batch
                  </button>
                )}
                {canAct && totalRemaining === 0 && fulfillment.length > 0 && (
                  <span style={{ fontSize: 11, color: '#15803d', fontWeight: 600 }}>✓ All items batched</span>
                )}
              </div>

              {batches.length === 0 && (
                <div style={{ ...card, textAlign: 'center', padding: '32px 20px', color: '#9ca3af', fontSize: 13 }}>
                  No batches yet.{canAct ? ' Create the first batch to start planning delivery.' : ''}
                </div>
              )}

              {/* ── 4c. Batch cards ── */}
              {batches.map(batch => {
                const c = BATCH_STATUS_COLORS[batch.status] || {};
                const borderColor = ['Cancelled', 'Signed'].includes(batch.status) ? '#e5e7eb' : (c.border || '#e5e7eb');
                const batchItems  = batch.delivery_batch_items || [];
                const pieceCount  = batchItems.reduce((s, i) => s + (i.quantity_planned || 0), 0);
                const batchValue  = batchItems.reduce((s, i) => s + (i.quantity_planned || 0) * (i.order_items?.unit_price || 0), 0);
                const hasSignedCopy  = !!batch.signed_copy_path;
                const showActuals = ['Delivered', 'Signed', 'Returned', 'Rejected'].includes(batch.status);

                return (
                  <div key={batch.id} style={{ ...card, borderLeft: `3px solid ${borderColor}`, opacity: batch.status === 'Cancelled' ? 0.6 : 1 }}>
                    {/* Header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Batch {batch.batch_number}</div>
                        <StatusBadge status={batch.status} />
                      </div>
                      <BatchActions batch={batch} />
                    </div>

                    {/* Metrics */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 12, fontSize: 11 }}>
                      <div>
                        <div style={fieldLabel}>{batch.actual_delivery_date ? 'Delivered' : 'Planned'}</div>
                        <div style={{ color: '#374151' }}>{fmtDate(batch.actual_delivery_date || batch.planned_date)}</div>
                      </div>
                      <div>
                        <div style={fieldLabel}>Driver</div>
                        <div style={{ color: batch.driver ? '#374151' : '#9ca3af' }}>{batch.driver || '—'}</div>
                      </div>
                      <div>
                        <div style={fieldLabel}>Pieces</div>
                        <div style={{ color: '#374151', fontWeight: 600 }}>{pieceCount}</div>
                      </div>
                      <div>
                        <div style={fieldLabel}>Value</div>
                        <div style={{ color: '#374151', fontWeight: 600 }}>{fmtKES(batchValue)}</div>
                      </div>
                    </div>

                    {/* Items + docs */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginTop: 10 }}>
                      {batchItems.length > 0 && (
                        <div style={{ flex: 1, background: '#f9fafb', borderRadius: 6, padding: '7px 10px', fontSize: 11, color: '#6b7280', lineHeight: 1.7 }}>
                          {batchItems.map((item, idx) => {
                            const d = item.quantity_delivered;
                            const r = item.quantity_rejected;
                            return (
                              <span key={item.id}>
                                {idx > 0 && ' · '}
                                <span style={{ color: '#374151', fontWeight: 600 }}>{item.quantity_planned}×</span> {item.order_items?.category || '—'}
                                {showActuals && d !== item.quantity_planned && (
                                  <span style={{ color: '#dc2626' }}> ({d} del{r > 0 ? `, ${r} rej` : ''})</span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ flexShrink: 0, fontSize: 11, lineHeight: 2 }}>
                        <div style={{ color: '#374151' }}><span style={{ color: '#22c55e' }}>✓</span> Delivery Note</div>
                        <div style={{ color: hasSignedCopy ? '#374151' : '#9ca3af' }}>
                          {hasSignedCopy ? <span style={{ color: '#22c55e' }}>✓</span> : <span style={{ color: '#d1d5db' }}>□</span>} Signed Copy
                        </div>
                      </div>
                    </div>

                    {batch.notes && <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>{batch.notes}</div>}
                    {batch.status === 'Cancelled' && batch.cancelled_reason && (
                      <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af' }}>Cancelled: {batch.cancelled_reason}</div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </>
      )}

      {/* ── 5. Batch Planner slide-in ── */}
      {showPlanner && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
          onClick={e => { if (e.target === e.currentTarget) setShowPlanner(false); }}
        >
          <div style={{ background: '#fff', width: 420, maxWidth: '95vw', height: '100%', overflowY: 'auto', padding: '24px 22px', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>Create Batch {batches.length + 1}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{order?.order_num} · {order?.client}</div>
              </div>
              <button onClick={() => setShowPlanner(false)} style={{ background: 'none', border: 'none', fontSize: 20, color: '#9ca3af', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 10 }}>Items — enter quantity for this batch</div>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', padding: '0 0 8px', textAlign: 'left' }}>Item</th>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', padding: '0 6px 8px', textAlign: 'right' }}>Ordered</th>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#1d4ed8', padding: '0 6px 8px', textAlign: 'right' }}>Batched</th>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#15803d', padding: '0 6px 8px', textAlign: 'right' }}>Delivered</th>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#E8512A', padding: '0 6px 8px', textAlign: 'right' }}>Available</th>
                    <th style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', padding: '0 8px 8px', textAlign: 'right' }}>This Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {fulfillment.map(f => {
                    const isDisabled = f.remaining_qty <= 0;
                    const qty = plannerQtys[f.order_item_id] || 0;
                    const isOver = qty > f.remaining_qty;
                    return (
                      <tr key={f.order_item_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '9px 0' }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: isDisabled ? '#9ca3af' : '#111' }}>{f.category}</div>
                          {f.description && <div style={{ fontSize: 10, color: '#9ca3af' }}>{f.description}</div>}
                        </td>
                        <td style={{ textAlign: 'right', padding: '9px 6px', fontFamily: 'monospace', fontSize: 12, color: '#374151' }}>{f.ordered_qty}</td>
                        <td style={{ textAlign: 'right', padding: '9px 6px', fontFamily: 'monospace', fontSize: 12, color: '#1d4ed8' }}>{f.batched_qty || '—'}</td>
                        <td style={{ textAlign: 'right', padding: '9px 6px', fontFamily: 'monospace', fontSize: 12, color: '#15803d' }}>{f.delivered_qty || '—'}</td>
                        <td style={{ textAlign: 'right', padding: '9px 6px', fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: isDisabled ? '#9ca3af' : '#E8512A' }}>{isDisabled ? '—' : f.remaining_qty}</td>
                        <td style={{ textAlign: 'right', padding: '9px 8px' }}>
                          <input
                            type="number" min={0} max={f.remaining_qty}
                            value={isDisabled ? 0 : qty}
                            disabled={isDisabled}
                            onChange={e => { const v = parseInt(e.target.value, 10) || 0; setPlannerQtys(q => ({ ...q, [f.order_item_id]: Math.min(v, f.remaining_qty) })); }}
                            style={{ width: 64, padding: '5px 8px', border: `1px solid ${isOver ? '#fca5a5' : '#d1d5db'}`, borderRadius: 5, fontSize: 12, textAlign: 'center', outline: 'none', background: isDisabled ? '#f9fafb' : '#fff', color: isDisabled ? '#d1d5db' : (isOver ? '#dc2626' : '#111') }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 10 }}>Logistics</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Planned date</div>
                  <input type="date" value={plannerForm.planned_date} onChange={e => setPlannerForm(f => ({ ...f, planned_date: e.target.value }))} style={inputStyle} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Driver</div>
                    <input type="text" value={plannerForm.driver} onChange={e => setPlannerForm(f => ({ ...f, driver: e.target.value }))} style={inputStyle} placeholder="Driver name" />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Vehicle</div>
                    <input type="text" value={plannerForm.vehicle} onChange={e => setPlannerForm(f => ({ ...f, vehicle: e.target.value }))} style={inputStyle} placeholder="Plate / reg" />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Delivery location</div>
                  <input type="text" value={plannerForm.delivery_location} onChange={e => setPlannerForm(f => ({ ...f, delivery_location: e.target.value }))} style={inputStyle} placeholder="Specific site / bay" />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Notes</div>
                  <textarea value={plannerForm.notes} onChange={e => setPlannerForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Instructions for driver or warehouse team" />
                </div>
              </div>
            </div>

            {plannerError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#dc2626', marginBottom: 14 }}>
                {plannerError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, paddingTop: 16, borderTop: '1px solid #f3f4f6' }}>
              <button onClick={createBatch} disabled={plannerSaving} style={{ flex: 1, padding: '9px 0', background: '#E8512A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: plannerSaving ? 0.6 : 1 }}>
                {plannerSaving ? 'Creating…' : 'Create Batch'}
              </button>
              <button onClick={() => setShowPlanner(false)} style={{ padding: '9px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 6. Delivered quantities modal ── */}
      {deliveredModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 4 }}>Record Delivery — Batch {deliveredModal.batch.batch_number}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Enter actual quantities delivered and rejected.</div>
            <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 16 }}>
              <thead>
                <tr>
                  <th style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', padding: '0 0 8px', textAlign: 'left' }}>Item</th>
                  <th style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', padding: '0 6px 8px', textAlign: 'center' }}>Planned</th>
                  <th style={{ fontSize: 10, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', padding: '0 6px 8px', textAlign: 'center' }}>Delivered</th>
                  <th style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', padding: '0 0 8px', textAlign: 'center' }}>Rejected</th>
                </tr>
              </thead>
              <tbody>
                {(deliveredModal.batch.delivery_batch_items || []).map(item => {
                  const current = deliveredQtys[item.id] || { qty_delivered: item.quantity_planned, qty_rejected: 0 };
                  const total   = (parseInt(current.qty_delivered, 10) || 0) + (parseInt(current.qty_rejected, 10) || 0);
                  const isOver  = total > item.quantity_planned;
                  const qtyInput = (field, color) => (
                    <input
                      type="number" min={0} max={item.quantity_planned}
                      value={current[field]}
                      onChange={e => setDeliveredQtys(q => ({ ...q, [item.id]: { ...current, [field]: e.target.value } }))}
                      style={{ width: 56, padding: '4px 6px', border: `1px solid ${isOver ? '#fca5a5' : '#d1d5db'}`, borderRadius: 5, fontSize: 12, textAlign: 'center', outline: 'none', color }}
                    />
                  );
                  return (
                    <tr key={item.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 0', fontSize: 12, color: '#374151', fontWeight: 600 }}>{item.order_items?.category}</td>
                      <td style={{ textAlign: 'center', padding: '8px 6px', fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{item.quantity_planned}</td>
                      <td style={{ textAlign: 'center', padding: '8px 6px' }}>{qtyInput('qty_delivered', '#15803d')}</td>
                      <td style={{ textAlign: 'center', padding: '8px 0'  }}>{qtyInput('qty_rejected',  '#dc2626')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {deliveredError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#dc2626', marginBottom: 12 }}>
                {deliveredError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveDeliveredQtys} disabled={deliveredSaving} style={{ flex: 1, padding: '8px 0', background: '#15803d', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: deliveredSaving ? 0.6 : 1 }}>
                {deliveredSaving ? 'Saving…' : 'Confirm Delivery'}
              </button>
              <button onClick={() => setDeliveredModal(null)} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
