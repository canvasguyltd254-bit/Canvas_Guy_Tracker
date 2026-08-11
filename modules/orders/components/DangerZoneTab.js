'use client';

/**
 * DangerZoneTab.js — Admin-only suspend / hard-delete controls for an order.
 *
 * Props:
 *   orderId      string   — the order UUID
 *   orderNum     string   — e.g. "ORD-00042" (used as deletion confirmation token)
 *   onSuspended  fn()     — called after suspend/unsuspend so parent can refetch
 *   onDeleted    fn()     — called after hard delete so parent can redirect
 */

import { useState, useEffect, useCallback } from 'react';

// ── helpers ────────────────────────────────────────────────────────────────────

const btn = (extra = {}) => ({
  padding: '10px 18px',
  borderRadius: '7px',
  border: 'none',
  fontWeight: 700,
  fontSize: '13px',
  cursor: 'pointer',
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  ...extra,
});

const inp = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: '7px',
  border: '1.5px solid #d1d5db',
  fontSize: '13px',
  fontFamily: 'monospace',
  boxSizing: 'border-box',
};

function BlockerPill({ blocker }) {
  const label = blocker.detail
    ? blocker.detail
    : blocker.count !== undefined
    ? `${blocker.code.replace(/_/g, ' ')} (${blocker.count})`
    : blocker.code.replace(/_/g, ' ');

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      background: '#fef2f2', border: '1px solid #fca5a5',
      color: '#dc2626', borderRadius: '5px',
      padding: '3px 8px', fontSize: '11px', fontWeight: 600,
    }}>
      ✗ {label}
    </span>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export default function DangerZoneTab({ orderId, orderNum, onSuspended, onDeleted }) {
  const [eligibility, setEligibility] = useState(null);
  const [loadingElig, setLoadingElig] = useState(true);
  const [eligError,   setEligError]   = useState(null);

  // suspend form
  const [suspendReason, setSuspendReason] = useState('');
  const [suspending,    setSuspending]    = useState(false);
  const [suspendErr,    setSuspendErr]    = useState(null);

  // delete form
  const [confirmation,  setConfirmation]  = useState('');
  const [deleteReason,  setDeleteReason]  = useState('');
  const [deleting,      setDeleting]      = useState(false);
  const [deleteErr,     setDeleteErr]     = useState(null);

  // ── fetch eligibility ────────────────────────────────────────────────────────

  const fetchEligibility = useCallback(async () => {
    setLoadingElig(true);
    setEligError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/eligibility`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load eligibility');
      setEligibility(json.data ?? json);
    } catch (e) {
      setEligError(e.message);
    } finally {
      setLoadingElig(false);
    }
  }, [orderId]);

  useEffect(() => { fetchEligibility(); }, [fetchEligibility]);

  // ── suspend ──────────────────────────────────────────────────────────────────

  async function handleSuspend() {
    if (!suspendReason.trim()) { setSuspendErr('Reason is required.'); return; }
    setSuspending(true);
    setSuspendErr(null);
    try {
      const res  = await fetch(`/api/orders/${orderId}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: suspendReason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to suspend order');
      setSuspendReason('');
      await fetchEligibility();
      onSuspended?.();
    } catch (e) {
      setSuspendErr(e.message);
    } finally {
      setSuspending(false);
    }
  }

  async function handleUnsuspend() {
    setSuspending(true);
    setSuspendErr(null);
    try {
      const res  = await fetch(`/api/orders/${orderId}/suspend`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to unsuspend order');
      await fetchEligibility();
      onSuspended?.();
    } catch (e) {
      setSuspendErr(e.message);
    } finally {
      setSuspending(false);
    }
  }

  // ── hard delete ──────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (confirmation !== orderNum) { setDeleteErr(`Type "${orderNum}" exactly to confirm.`); return; }
    if (!deleteReason.trim())      { setDeleteErr('Deletion reason is required.'); return; }
    setDeleting(true);
    setDeleteErr(null);
    try {
      const res  = await fetch(`/api/orders/${orderId}/hard-delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation, reason: deleteReason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Deletion failed');
      onDeleted?.();
    } catch (e) {
      setDeleteErr(e.message);
    } finally {
      setDeleting(false);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────────

  if (loadingElig) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>
        Loading eligibility…
      </div>
    );
  }

  if (eligError) {
    return (
      <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#dc2626' }}>
        ⚠ {eligError}
      </div>
    );
  }

  const isSuspended = !!eligibility?.suspended;
  const canDelete   = !!eligibility?.canDelete;
  const blockers    = eligibility?.blockers || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Suspension banner (if currently suspended) ── */}
      {isSuspended && (
        <div style={{
          background: '#fffbeb', border: '1.5px solid #fcd34d',
          borderRadius: '10px', padding: '14px 16px',
          display: 'flex', alignItems: 'flex-start', gap: '10px',
        }}>
          <span style={{ fontSize: '18px', flexShrink: 0 }}>⏸</span>
          <div>
            <div style={{ fontWeight: 700, color: '#92400e', fontSize: '13px', marginBottom: '3px' }}>
              This order is suspended
            </div>
            {eligibility.suspensionReason && (
              <div style={{ fontSize: '12px', color: '#b45309', lineHeight: 1.5 }}>
                Reason: {eligibility.suspensionReason}
              </div>
            )}
            {eligibility.suspendedAt && (
              <div style={{ fontSize: '11px', color: '#b45309', marginTop: '2px' }}>
                Since: {new Date(eligibility.suspendedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Suspend / Unsuspend card ── */}
      <div style={{
        background: '#fff', border: '1.5px solid #e5e7eb',
        borderRadius: '10px', padding: '18px 20px',
      }}>
        <div style={{ fontWeight: 700, fontSize: '14px', color: '#111827', marginBottom: '4px' }}>
          {isSuspended ? 'Unsuspend order' : 'Suspend order'}
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '14px', lineHeight: 1.5 }}>
          {isSuspended
            ? 'Lifting the suspension restores the order to its current workflow stage. All blocked operations become available again immediately.'
            : 'Suspension freezes the order — status changes, payments, and batch creation are blocked until lifted. The order remains visible in its current stage.'}
        </div>

        {suspendErr && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#dc2626', marginBottom: '12px' }}>
            ⚠ {suspendErr}
          </div>
        )}

        {isSuspended ? (
          <button
            onClick={handleUnsuspend}
            disabled={suspending}
            style={btn({ background: suspending ? '#e5e7eb' : '#16a34a', color: suspending ? '#9ca3af' : '#fff', cursor: suspending ? 'default' : 'pointer' })}
          >
            {suspending ? 'Lifting suspension…' : '▶ Lift suspension'}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#374151', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Reason *
              </label>
              <input
                type="text"
                value={suspendReason}
                onChange={e => setSuspendReason(e.target.value)}
                placeholder="e.g. Client dispute pending resolution"
                style={{ ...inp, fontFamily: 'inherit' }}
                onKeyDown={e => e.key === 'Enter' && handleSuspend()}
              />
            </div>
            <button
              onClick={handleSuspend}
              disabled={suspending || !suspendReason.trim()}
              style={btn({
                background: (suspending || !suspendReason.trim()) ? '#e5e7eb' : '#d97706',
                color: (suspending || !suspendReason.trim()) ? '#9ca3af' : '#fff',
                cursor: (suspending || !suspendReason.trim()) ? 'default' : 'pointer',
              })}
            >
              {suspending ? 'Suspending…' : '⏸ Suspend'}
            </button>
          </div>
        )}
      </div>

      {/* ── Hard Delete card ── */}
      <div style={{
        background: '#fff', border: '1.5px solid #fca5a5',
        borderRadius: '10px', padding: '18px 20px',
      }}>
        <div style={{ fontWeight: 700, fontSize: '14px', color: '#dc2626', marginBottom: '4px' }}>
          ⚠ Hard delete order
        </div>
        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '14px', lineHeight: 1.5 }}>
          Permanently removes this order and all its items, notes, and activity log. <strong>This cannot be undone.</strong> Only available for orders in <em>Inquiry</em> or <em>Quote Approved</em> stage with no linked financial records.
        </div>

        {/* Eligibility status */}
        {canDelete ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px', fontSize: '12px', color: '#16a34a', fontWeight: 600 }}>
            ✓ This order is eligible for deletion
          </div>
        ) : (
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px', fontWeight: 600 }}>
              Deletion is blocked:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {blockers.length > 0
                ? blockers.map((b, i) => <BlockerPill key={i} blocker={b} />)
                : <BlockerPill blocker={{ detail: `Stage "${eligibility?.status}" is not deletable` }} />}
            </div>
          </div>
        )}

        {deleteErr && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#dc2626', marginBottom: '12px' }}>
            ⚠ {deleteErr}
          </div>
        )}

        {canDelete && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#374151', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Type <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: '3px', fontFamily: 'monospace', fontSize: '12px' }}>{orderNum}</code> to confirm *
              </label>
              <input
                type="text"
                value={confirmation}
                onChange={e => setConfirmation(e.target.value)}
                placeholder={orderNum}
                style={inp}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#374151', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Deletion reason *
              </label>
              <input
                type="text"
                value={deleteReason}
                onChange={e => setDeleteReason(e.target.value)}
                placeholder="e.g. Created in error / duplicate"
                style={{ ...inp, fontFamily: 'inherit' }}
              />
            </div>
            <div>
              <button
                onClick={handleDelete}
                disabled={deleting || confirmation !== orderNum || !deleteReason.trim()}
                style={btn({
                  background: (!deleting && confirmation === orderNum && deleteReason.trim()) ? '#dc2626' : '#e5e7eb',
                  color: (!deleting && confirmation === orderNum && deleteReason.trim()) ? '#fff' : '#9ca3af',
                  cursor: (!deleting && confirmation === orderNum && deleteReason.trim()) ? 'pointer' : 'default',
                })}
              >
                {deleting ? 'Deleting…' : '🗑 Permanently delete order'}
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
