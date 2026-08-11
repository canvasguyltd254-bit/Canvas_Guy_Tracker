'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/shared/supabase/client';
import { DrawingsUpload } from '@/modules/orders/components/DrawingsUpload';
import DeliveryTab from '@/modules/orders/components/DeliveryTab';
import DangerZoneTab from '@/modules/orders/components/DangerZoneTab';
import {
  STATUSES, REPAIR_STATUSES, ALL_STATUS_COLORS,
  ROLES_CAN_ADVANCE, ROLES_CAN_REWORK, ROLES_CAN_REFUND,
  REWORK_TARGETS, REWORK_REASONS, REPAIR_REASONS,
  SALES_MAX_ADVANCE_TO, CREDIT_TERMS,
  HEAD_OF_SALES_CREDIT_LIMIT,
  CATEGORIES, FINISH_TYPES, WOOD_TYPES, CHARGE_TYPES,
  getStatusList,
} from '@/modules/orders/components/constants';

const CHARGE_TYPE_SET = new Set(CHARGE_TYPES || ['Delivery Fee','Design Fee','Installation Fee','Packaging','Other Charge']);
const isChargeItem = (item) => CHARGE_TYPE_SET.has(item.category);
const newLineItem = () => ({ _id: `new-${Date.now()}-${Math.random()}`, category: 'Wall Decoration Canvas', description: '', quantity: 1, size: '', finish_type: 'None', finish_color: '', wood_type: '', unit_price: '' });
const newChargeItem = () => ({ _id: `chg-${Date.now()}-${Math.random()}`, category: 'Delivery Fee', description: 'Delivery Fee', quantity: 1, unit_price: '' });

const supabase = createClient();

function fmtKES(n) { return 'KES ' + (parseFloat(n) || 0).toLocaleString('en-KE'); }
function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function itemSpec(item) {
  return [item.size, item.finish_type, item.finish_color, item.wood_type]
    .filter(Boolean).join(' · ') || item.description || '-';
}

// ── Overlay / Modal wrapper ──────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 999, padding: '20px',
    }}>
      <div style={{
        background: '#fff', borderRadius: '12px', width: '100%', maxWidth: '440px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #f3f4f6',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '15px', fontWeight: 700, color: '#111' }}>{title}</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: '18px',
            color: '#9ca3af', cursor: 'pointer', lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ padding: '20px' }}>{children}</div>
      </div>
    </div>
  );
}

// ── Notes Thread ─────────────────────────────────────────────────────────────
function NotesThread({ orderId }) {
  const [notes, setNotes]     = useState([]);
  const [text, setText]       = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const inputRef = useRef(null);

  const loadNotes = useCallback(async () => {
    const { data } = await supabase
      .from('order_notes').select('*').eq('order_id', orderId)
      .order('created_at', { ascending: false });
    setNotes(data || []);
    setLoading(false);
  }, [orderId]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const addNote = async () => {
    const content = text.trim();
    if (!content) return;
    setPosting(true);

    // Optimistic update — prepend the note immediately with a temp id
    const tempNote = { id: `temp-${Date.now()}`, content, author_name: 'You', created_at: new Date().toISOString() };
    setNotes(prev => [tempNote, ...prev]);
    setText('');

    try {
      const res = await fetch(`/api/orders/${orderId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to post note');
      }
      // Replace temp note with the real one from server (has real id + real author_name)
      await loadNotes();
    } catch {
      // Roll back
      setNotes(prev => prev.filter(n => n.id !== tempNote.id));
      setText(content);
    }
    setPosting(false);
    inputRef.current?.focus();
  };

  return (
    <div>
      <div className="notes-input-row" style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          ref={inputRef} type="text" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }}
          placeholder="Add a note... (Enter to post)"
          style={{ flex: 1, padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', background: '#fafafa' }}
        />
        <button onClick={addNote} disabled={!text.trim() || posting} className="notes-post-btn" style={{
          padding: '9px 18px', borderRadius: '7px', border: 'none',
          background: text.trim() && !posting ? '#1a1a1a' : '#e0e0e0',
          color: text.trim() && !posting ? '#fff' : '#aaa',
          fontWeight: 700, fontSize: '13px', cursor: text.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap',
          minHeight: 44,
        }}>
          {posting ? '...' : 'Post'}
        </button>
      </div>
      {loading ? (
        <p style={{ fontSize: '12px', color: '#bbb' }}>Loading notes...</p>
      ) : notes.length === 0 ? (
        <p style={{ fontSize: '13px', color: '#9ca3af', fontStyle: 'italic' }}>No notes yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto' }}>
          {notes.map(n => (
            <div key={n.id} style={{ padding: '10px 14px', background: '#f9fafb', borderRadius: '8px', border: '1px solid #e8e8e5' }}>
              <div style={{ fontSize: '13px', color: '#111', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{n.content}</div>
              <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '5px' }}>{n.author_name} · {fmtDateTime(n.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Attachments Panel ────────────────────────────────────────────────────────
const DOC_TYPES     = ['Invoice', 'Quotation', 'Delivery Sheet', 'Job Card', 'Other'];
const DOC_ICONS_MAP = { 'Delivery Sheet': '🚚', 'Invoice': '🧾', 'Quotation': '💰', 'Job Card': '🔧', 'Other': '📎' };
const UPLOAD_ROLES  = ['admin', 'production_manager', 'head_of_sales', 'sales', 'production_staff'];
const DELETE_ROLES  = ['admin', 'production_manager', 'head_of_sales'];

function fmtFileSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function AttachmentsPanel({ orderId, userRole, readOnly = false }) {
  const [tab, setTab]           = useState('documents');
  const [documents, setDocuments] = useState([]);
  const [drawings, setDrawings] = useState([]);
  const [docsLoading, setDocsLoading]           = useState(true);
  const [drawingsLoading, setDrawingsLoading]   = useState(true);
  const [docType, setDocType]   = useState('Invoice');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [docDeleteTarget, setDocDeleteTarget]   = useState(null); // doc object awaiting reason
  const [docDeleteReason, setDocDeleteReason]   = useState('');
  const [docDeleteLoading, setDocDeleteLoading] = useState(false);

  const canUpload = !readOnly && UPLOAD_ROLES.includes(userRole);
  const canDelete = !readOnly && DELETE_ROLES.includes(userRole);

  const loadDocuments = useCallback(async () => {
    const { data } = await supabase.from('order_documents').select('*').eq('order_id', orderId).order('uploaded_at', { ascending: false });
    setDocuments(data || []);
    setDocsLoading(false);
  }, [orderId]);

  const loadDrawings = useCallback(async () => {
    const { data } = await supabase.from('drawings').select('*').eq('order_id', orderId).is('deleted_at', null).order('uploaded_at', { ascending: false });
    setDrawings(data || []);
    setDrawingsLoading(false);
  }, [orderId]);

  useEffect(() => { loadDocuments(); loadDrawings(); }, [loadDocuments, loadDrawings]);

  const uploadDocument = async (file) => {
    setUploadError(null);
    setUploading(true);
    try {
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `${orderId}/${Date.now()}_${safeFileName}`;
      const { error: storageErr } = await supabase.storage.from('order-documents').upload(filePath, file);
      if (storageErr) throw storageErr;
      const { error: dbErr } = await supabase.from('order_documents').insert({ order_id: orderId, name: file.name, doc_type: docType, file_path: filePath, file_size: file.size });
      if (dbErr) throw dbErr;
      await loadDocuments();
    } catch (err) { setUploadError('Upload failed: ' + (err.message || err)); }
    setUploading(false);
  };

  const viewDocument = async (doc) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/documents?doc_id=${doc.id}`);
      const json = await res.json();
      if (json.signed_url) window.open(json.signed_url, '_blank');
      else alert('Could not open document: ' + (json.error || 'Unknown error'));
    } catch (err) {
      alert('Error opening document: ' + err.message);
    }
  };

  const deleteDocument = (doc) => {
    setDocDeleteTarget(doc);
    setDocDeleteReason('');
  };

  const confirmDeleteDocument = async () => {
    if (!docDeleteReason.trim() || !docDeleteTarget) return;
    const doc = docDeleteTarget;
    setDocDeleteLoading(true);
    setDocDeleteTarget(null);
    setDocDeleteReason('');
    try {
      const res = await fetch(`/api/orders/${orderId}/documents?doc_id=${doc.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: docDeleteReason.trim() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to delete document');
      }
      await loadDocuments();
    } catch (err) {
      alert('Delete failed: ' + err.message);
      await loadDocuments();
    }
    setDocDeleteLoading(false);
  };

  const tabBtn = (key, label) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: '10px 20px', border: 'none', background: 'transparent',
      borderBottom: tab === key ? '2px solid #E8512A' : '2px solid transparent',
      marginBottom: '-2px', color: tab === key ? '#E8512A' : '#6b7280',
      fontWeight: tab === key ? 700 : 500, fontSize: '13px', cursor: 'pointer',
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: '20px' }}>
        {tabBtn('documents', '📁 Documents')}
        {tabBtn('drawings', '📐 Drawings')}
      </div>

      {tab === 'documents' && (
        <div>
          {canUpload && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '14px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '16px' }}>
              <select value={docType} onChange={e => setDocType(e.target.value)} style={{ padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', background: '#fff' }}>
                {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <label style={{ cursor: uploading ? 'default' : 'pointer' }}>
                <input type="file" onChange={e => { if (e.target.files?.[0]) { uploadDocument(e.target.files[0]); e.target.value = ''; } }} disabled={uploading} style={{ display: 'none' }} />
                <span style={{ display: 'inline-block', padding: '8px 18px', borderRadius: '7px', border: `2px solid ${uploading ? '#e0e0e0' : '#E8512A'}`, color: uploading ? '#aaa' : '#E8512A', fontWeight: 700, fontSize: '13px' }}>
                  {uploading ? 'Uploading...' : '+ Upload Document'}
                </span>
              </label>
              {uploadError && <span style={{ fontSize: '12px', color: '#dc2626' }}>⚠ {uploadError}</span>}
            </div>
          )}
          {docsLoading ? (
            <p style={{ fontSize: '12px', color: '#bbb' }}>Loading documents...</p>
          ) : documents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af' }}>
              <div style={{ fontSize: '28px', opacity: 0.3, marginBottom: '10px' }}>📁</div>
              <p style={{ fontSize: '13px' }}>No documents uploaded yet</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {documents.map(doc => (
                <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px' }}>
                  <span style={{ fontSize: '18px', flexShrink: 0 }}>{DOC_ICONS_MAP[doc.doc_type] || '📎'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.name}</div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>{doc.doc_type}{doc.file_size ? ' · ' + fmtFileSize(doc.file_size) : ''}{doc.uploaded_at ? ' · ' + fmtDate(doc.uploaded_at) : ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button onClick={() => viewDocument(doc)} style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #e5e7eb', background: '#fff', color: '#E8512A', fontWeight: 600, fontSize: '12px', cursor: 'pointer' }}>View</button>
                    {canDelete && (
                      <button onClick={() => deleteDocument(doc)} style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }} title="Delete">×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'drawings' && (
        drawingsLoading ? (
          <p style={{ fontSize: '12px', color: '#bbb' }}>Loading drawings...</p>
        ) : (
          <DrawingsUpload orderId={orderId} drawings={drawings} onDrawingsUpdated={setDrawings} readOnly={!canUpload} canDelete={canDelete} />
        )
      )}

      {/* ── Delete Document Modal ── */}
      {docDeleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '28px', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', marginBottom: '4px' }}>Delete Document</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px', wordBreak: 'break-all' }}>
              <strong>{docDeleteTarget.name}</strong>
            </div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Reason for deletion <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              value={docDeleteReason}
              onChange={e => setDocDeleteReason(e.target.value)}
              placeholder="Explain why this document is being deleted…"
              rows={3}
              autoFocus
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setDocDeleteTarget(null); setDocDeleteReason(''); }}
                style={{ padding: '9px 20px', borderRadius: '7px', border: '1.5px solid #e0e0e0', background: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: '#374151' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteDocument}
                disabled={!docDeleteReason.trim() || docDeleteLoading}
                style={{ padding: '9px 20px', borderRadius: '7px', border: 'none', background: docDeleteReason.trim() && !docDeleteLoading ? '#dc2626' : '#fca5a5', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: docDeleteReason.trim() && !docDeleteLoading ? 'pointer' : 'not-allowed' }}
              >
                {docDeleteLoading ? 'Deleting…' : 'Delete Document'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Payment Panel ────────────────────────────────────────────────────────────
const CAN_ADD_PAYMENT    = ['admin', 'production_manager', 'head_of_sales', 'sales'];
// Hard-delete only ever applies to payments that were never posted to GL.
const CAN_DELETE_PAYMENT = ['admin', 'head_of_sales'];
// Reversing a posted payment must match the server-side rule in
// /api/order-payments/[id]/reverse (ROLES_REVERSE) — admin only.
const CAN_REVERSE_PAYMENT = ['admin'];

function PaymentPanel({ orderId, contractTotal, itemsSubtotal, chargeItems, userRole, orderStatus, payments, setPayments, readOnly = false }) {
  const [loading, setLoading]         = useState(true);
  const [amt, setAmt]                 = useState('');
  const [desc, setDesc]               = useState('');
  const [payDate, setPayDate]         = useState(new Date().toISOString().split('T')[0]);
  const [adding, setAdding]           = useState(false);
  const [addError, setAddError]       = useState('');
  const [pendingDelete, setPendingDelete] = useState(null); // payment obj awaiting reason
  const [deleteReason, setDeleteReason]   = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError]     = useState('');

  const loadPayments = useCallback(async () => {
    const { data } = await supabase.from('order_payments').select('*').eq('order_id', orderId).order('payment_date');
    setPayments(data || []);
    setLoading(false);
  }, [orderId, setPayments]);

  useEffect(() => { loadPayments(); }, [loadPayments]);

  // Reversed payments stay visible in the list for audit purposes but no longer
  // count toward what's actually been received — the reversal journal already
  // backs the receipt out in the GL.
  const totalPaid      = payments.filter(p => !p.reversed_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const rawBalance     = (contractTotal || 0) - totalPaid;
  const balance        = Math.max(rawBalance, 0);
  const isOverpaid     = rawBalance < -0.01;
  const pct            = contractTotal > 0 ? Math.min(Math.round((totalPaid / contractTotal) * 100), 100) : 0;
  const canAdd         = !readOnly && CAN_ADD_PAYMENT.includes(userRole) && orderStatus !== 'Closed';
  const canDelete      = !readOnly && CAN_DELETE_PAYMENT.includes(userRole);
  const canReverse     = !readOnly && CAN_REVERSE_PAYMENT.includes(userRole);
  const chargesSubtotal = (chargeItems || []).reduce((s, i) => s + (parseFloat(i.unit_price) || 0), 0);
  const barColor       = pct >= 100 ? '#16a34a' : pct >= 50 ? '#2563eb' : '#E8512A';

  const addPayment = async () => {
    setAddError('');
    const a = parseFloat(amt);
    if (!a || a <= 0 || !desc.trim()) return;

    // Block payment that would exceed contract total
    if (contractTotal > 0 && (totalPaid + a) > contractTotal + 0.01) {
      const remaining = contractTotal - totalPaid;
      setAddError(
        `Payment of KES ${a.toLocaleString()} would exceed the contract total. ` +
        `Remaining balance is KES ${Math.round(remaining).toLocaleString('en-KE')}.`
      );
      return;
    }

    setAdding(true);
    const tempPayment = { id: `temp-${Date.now()}`, amount: a, description: desc.trim(), payment_date: payDate };
    setPayments(prev => [...prev, tempPayment]);
    setAmt(''); setDesc(''); setPayDate(new Date().toISOString().split('T')[0]);

    try {
      const res = await fetch(`/api/orders/${orderId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: a, description: tempPayment.description, payment_date: payDate }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error || 'Failed to add payment');
      }
      // The payment record itself always succeeds at this point (cash was
      // actually received) — but surface a GL posting failure to the user
      // instead of silently swallowing it, since it needs a manual retry.
      if (json.gl_warning) {
        setAddError(json.gl_warning);
      }
      await loadPayments();
    } catch (e) {
      setPayments(prev => prev.filter(p => p.id !== tempPayment.id));
      setAddError(e.message);
    }
    setAdding(false);
  };

  // Opens the reason modal; actual deletion happens in confirmDeletePayment
  const deletePayment = (p) => {
    setPendingDelete(p);
    setDeleteReason('');
  };

  const confirmDeletePayment = async () => {
    if (!deleteReason.trim() || !pendingDelete) return;
    const p = pendingDelete;
    const reason = deleteReason.trim();
    const isPosted = !!p.journal_entry_id;
    setDeleteLoading(true);
    setDeleteError('');
    setPendingDelete(null);
    setDeleteReason('');
    try {
      if (isPosted) {
        // Posted payments are reversed, never hard-deleted — this keeps the
        // GL journal and the audit trail intact. The reversed row stays
        // visible in the list, marked accordingly, after reload.
        const res = await fetch(`/api/order-payments/${p.id}/reverse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error || 'Failed to reverse payment');
        }
      } else {
        setPayments(prev => prev.filter(x => x.id !== p.id));
        const res = await fetch(`/api/orders/${orderId}/payments?payment_id=${p.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error || 'Failed to delete payment');
        }
      }
    } catch (err) {
      setDeleteError(err.message);
    }
    await loadPayments();
    setDeleteLoading(false);
  };

  return (
    <div>
      {/* Data-error banner — shown only when overpayment already exists in DB */}
      {isOverpaid && (
        <div style={{ background: '#fef2f2', border: '1.5px solid #fca5a5', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', fontSize: '12px', color: '#dc2626', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span>
            <strong>Data error:</strong> payments recorded (KES {Math.round(totalPaid).toLocaleString('en-KE')}) exceed the contract total by{' '}
            <strong>KES {Math.round(Math.abs(rawBalance)).toLocaleString('en-KE')}</strong>.
            Check for duplicate or incorrect payment entries and delete the excess.
          </span>
        </div>
      )}

      {/* Summary card */}
      <div style={{ background: '#fff7ed', border: '2px solid #E8512A', borderRadius: '10px', padding: '20px 24px', marginBottom: '16px' }}>
        <div className="payment-summary-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', textAlign: 'center', marginBottom: '16px' }}>
          <div className="payment-contract-total">
            <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Contract Total</div>
            <div className="payment-summary-value" style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', color: '#111' }}>{fmtKES(contractTotal)}</div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Paid</div>
            <div className="payment-summary-value" style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', color: '#16a34a' }}>{fmtKES(totalPaid)}</div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#E8512A', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Balance Due</div>
            <div className="payment-summary-value" style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'monospace', color: balance > 0 ? '#E8512A' : '#16a34a' }}>
              {fmtKES(balance)}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        {contractTotal > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6b7280', marginBottom: '5px' }}>
              <span>KES {Math.round(totalPaid).toLocaleString('en-KE')} of KES {Math.round(contractTotal).toLocaleString('en-KE')}</span>
              <span style={{ fontWeight: 700, color: barColor }}>{pct}%</span>
            </div>
            <div style={{ height: '8px', background: '#e5e7eb', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: '4px', transition: 'width 0.3s' }} />
            </div>
          </div>
        )}

        {/* Reconciliation breakdown — items + each charge line */}
        {contractTotal > 0 && (itemsSubtotal > 0 || chargesSubtotal > 0) && (
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #fbd5b0', fontSize: '11px', color: '#92400e' }}>
            {itemsSubtotal > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>Items subtotal</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>KES {Math.round(itemsSubtotal).toLocaleString('en-KE')}</span>
              </div>
            )}
            {(chargeItems || []).map((ci, idx) => (
              <div key={ci.id || idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                <span>{ci.category}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>KES {Math.round(parseFloat(ci.unit_price) || 0).toLocaleString('en-KE')}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '1px solid #fbd5b0', paddingTop: '4px', marginTop: '4px' }}>
              <span>Contract Total</span>
              <span style={{ fontFamily: 'monospace' }}>KES {Math.round(contractTotal).toLocaleString('en-KE')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Payment list */}
      {deleteError && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: '#dc2626', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠ {deleteError}</span>
          <button onClick={() => setDeleteError('')} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>
      )}
      {loading && <p style={{ fontSize: '12px', color: '#bbb', marginBottom: '12px' }}>Loading payments...</p>}
      {!loading && payments.length === 0 && (
        <p style={{ fontSize: '13px', color: '#9ca3af', fontStyle: 'italic', marginBottom: '14px' }}>No payments recorded yet.</p>
      )}
      {!loading && payments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
          {payments.map(p => {
            const isReversed = !!p.reversed_at;
            const isPosted   = !!p.journal_entry_id;
            // Show a control only when the user's role is actually allowed to
            // perform it — reversal is admin-only (matches the reverse API's
            // own role check); hard delete is admin/head_of_sales and only
            // ever applies to payments that were never posted to GL.
            const showControl = !isReversed && (isPosted ? canReverse : canDelete);
            return (
              <div key={p.id} className="payment-history-card" style={{
                padding: '10px 14px',
                background: isReversed ? '#fef2f2' : '#fff',
                border: `1px solid ${isReversed ? '#fecaca' : '#e8e8e5'}`,
                borderRadius: '8px',
              }}>
                {/* Row 1: amount + date */}
                <div className="phc-top" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span className="phc-amount" style={{
                    fontWeight: 700, fontFamily: 'monospace',
                    color: isReversed ? '#9ca3af' : '#16a34a',
                    textDecoration: isReversed ? 'line-through' : 'none',
                    fontSize: '15px',
                  }}>
                    KES {parseFloat(p.amount).toLocaleString('en-KE')}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="phc-date" style={{ fontSize: '11px', color: '#9ca3af' }}>{fmtDate(p.payment_date)}</span>
                    {isReversed && (
                      <span style={{ fontSize: '9px', fontWeight: 700, color: '#9F1239', background: '#FFF1F2', border: '1px solid #fecaca', padding: '3px 7px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                        Reversed
                      </span>
                    )}
                  </div>
                </div>
                {/* Row 2: description */}
                <div className="phc-desc" style={{ fontSize: '13px', color: isReversed ? '#9ca3af' : '#374151', marginTop: '4px' }}>{p.description}</div>
                {/* Row 3: action */}
                {showControl && (
                  <div className="phc-actions" style={{ marginTop: '6px' }}>
                    <button
                      onClick={() => deletePayment(p)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: isPosted ? '11px' : '13px', fontWeight: 700, padding: '4px 0', minHeight: 44 }}
                      title={isPosted ? 'Reverse payment' : 'Delete'}
                    >
                      {isPosted ? 'Reverse' : '× Remove'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add payment */}
      {canAdd && (
        <div style={{ paddingTop: '12px', borderTop: '1px solid #f3f4f6' }}>
          {addError && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: '#dc2626' }}>
              ⚠ {addError}
            </div>
          )}
          <div className="payment-add-form" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '0 0 110px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>Amount (KES)</div>
              <input type="number" placeholder="0" value={amt}
                onChange={e => { setAmt(e.target.value); setAddError(''); }}
                style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>Description</div>
              <input type="text" placeholder="e.g. Deposit, Balance" value={desc}
                onChange={e => setDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addPayment(); }}
                style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: '0 0 140px' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', marginBottom: '4px' }}>Date</div>
              <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <button onClick={addPayment} disabled={!amt || !desc.trim() || adding} className="payment-add-btn" style={{
              padding: '9px 18px', borderRadius: '7px', border: 'none',
              background: amt && desc.trim() && !adding ? '#16a34a' : '#e0e0e0',
              color: amt && desc.trim() && !adding ? '#fff' : '#aaa',
              fontWeight: 700, fontSize: '13px', cursor: amt && desc.trim() ? 'pointer' : 'default',
              whiteSpace: 'nowrap', flex: '0 0 auto', minHeight: 44,
            }}>
              {adding ? '...' : '+ Add Payment'}
            </button>
          </div>
        </div>
      )}

      {/* ── Delete / Reverse Payment Modal ── */}
      {pendingDelete && (() => {
        const isPosted = !!pendingDelete.journal_entry_id;
        return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '28px', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', marginBottom: '4px' }}>{isPosted ? 'Reverse Payment' : 'Delete Payment'}</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: isPosted ? '8px' : '20px' }}>
              <strong>KES {parseFloat(pendingDelete.amount).toLocaleString('en-KE')}</strong>
              {pendingDelete.payment_method ? ` · ${pendingDelete.payment_method}` : ''}
              {pendingDelete.description ? ` · ${pendingDelete.description}` : ''}
            </div>
            {isPosted && (
              <div style={{ fontSize: '12px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px 12px', marginBottom: '12px' }}>
                This payment has been posted to the ledger. It will be reversed with a GL correction entry, not deleted — it stays visible in the list, marked "Reversed".
              </div>
            )}
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Reason for {isPosted ? 'reversal' : 'deletion'} <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder={`Explain why this payment is being ${isPosted ? 'reversed' : 'deleted'}…`}
              rows={3}
              autoFocus
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setPendingDelete(null); setDeleteReason(''); }}
                style={{ padding: '9px 20px', borderRadius: '7px', border: '1.5px solid #e0e0e0', background: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: '#374151' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeletePayment}
                disabled={!deleteReason.trim() || deleteLoading}
                style={{ padding: '9px 20px', borderRadius: '7px', border: 'none', background: deleteReason.trim() && !deleteLoading ? '#dc2626' : '#fca5a5', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: deleteReason.trim() && !deleteLoading ? 'pointer' : 'not-allowed' }}
              >
                {deleteLoading ? (isPosted ? 'Reversing…' : 'Deleting…') : (isPosted ? 'Reverse Payment' : 'Delete Payment')}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ── Activity Log ─────────────────────────────────────────────────────────────
const ACT_ICONS = {
  status_change:   '🔄',
  qc_approved:     '✅',
  rework:          '↩️',
  refund:          '💸',
  repair:          '🔧',
  payment:         '💰',
  payment_deleted: '🗑️',
  file_deleted:    '🗑️',
};

function ActivityLog({ orderId }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    supabase.from('order_activities').select('*').eq('order_id', orderId)
      .order('created_at', { ascending: false }).limit(60)
      .then(({ data }) => { setActivities(data || []); setLoading(false); });
  }, [orderId]);

  if (loading) return <p style={{ fontSize: '12px', color: '#bbb' }}>Loading activity...</p>;
  if (activities.length === 0) return <p style={{ fontSize: '13px', color: '#9ca3af', fontStyle: 'italic' }}>No activity recorded yet.</p>;

  return (
    <div style={{ position: 'relative', paddingLeft: '26px' }}>
      <div style={{ position: 'absolute', left: '8px', top: '6px', bottom: '6px', width: '2px', background: '#f0ede8', borderRadius: '2px' }} />
      {activities.map((a, i) => (
        <div key={a.id} style={{ position: 'relative', marginBottom: i < activities.length - 1 ? '14px' : 0 }}>
          <div style={{
            position: 'absolute', left: '-22px', top: '1px',
            width: '18px', height: '18px', borderRadius: '50%',
            background: '#fff', border: '2px solid #e5e7eb',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '8px',
          }}>
            {ACT_ICONS[a.activity_type] || '·'}
          </div>
          <div style={{ fontSize: '12px', color: '#111', lineHeight: 1.5 }}>{a.description}</div>
          <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>{fmtDateTime(a.created_at)}</div>
        </div>
      ))}
    </div>
  );
}

// ── P&L Tab ───────────────────────────────────────────────────────────────────
const PDF_ALLOWED_ROLES  = ['admin', 'production_manager', 'head_of_sales'];
const WRITE_ROLES_PNL    = ['admin', 'head_of_sales', 'production_manager'];
const EXPENSE_CATEGORIES = [
  'Sales Commission',
  'Transport Penalty',
  'Fine',
  'Boda/Bike Charges',
  'Delivery Charges',
  'Casual Labour',
  'Installation Expense',
  'Repair/Rework Expense',
  'Other Direct Expense',
];

function DirectExpenseModal({ orderId, orderNum, onSaved, onClose }) {
  const [form, setForm] = useState({
    expense_date:           new Date().toISOString().slice(0, 10),
    expense_category:       '',
    accounting_category_id: '',
    description:            '',
    payee_name:             '',
    amount:                 '',
    allocated_amount:       '',
    payment_status:         'unpaid',
    payment_method:         '',
    payment_reference:      '',
    receipt_url:            '',
    notes:                  '',
  });
  const [saving, setSaving]                   = useState(false);
  const [error, setError]                     = useState(null);
  const [categories, setCategories]           = useState([]);
  const [catsLoading, setCatsLoading]         = useState(true);
  const [extraLinks, setExtraLinks]           = useState([]);
  const [linkOrderNum, setLinkOrderNum]       = useState('');
  const [linkSearching, setLinkSearching]     = useState(false);
  const [linkOrderResult, setLinkOrderResult] = useState(null);

  // Load GL categories on mount
  useEffect(() => {
    fetch('/api/accounting-categories?for_direct_expenses=true')
      .then(r => r.json())
      .then(d => {
        const all = d.categories || d.data || d || [];
        setCategories(Array.isArray(all) ? all : []);
      })
      .catch(() => setCategories([]))
      .finally(() => setCatsLoading(false));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const totalExpense  = parseFloat(form.amount) || 0;
  const thisAlloc     = form.allocated_amount !== '' ? parseFloat(form.allocated_amount) : totalExpense;
  const extraTotal    = extraLinks.reduce((s, l) => s + (parseFloat(l.allocated_amount) || 0), 0);
  const allocTotal    = thisAlloc + extraTotal;
  const overAllocated = totalExpense > 0 && allocTotal > totalExpense + 0.01;

  const searchOrder = async () => {
    if (!linkOrderNum.trim()) return;
    setLinkSearching(true);
    setLinkOrderResult(null);
    try {
      const res  = await fetch(`/api/orders?search=${encodeURIComponent(linkOrderNum.trim())}&limit=5`);
      const d    = await res.json();
      const orders = (d.orders || d.data || []).filter(o => o.id !== orderId);
      setLinkOrderResult(orders.slice(0, 5));
    } catch { setLinkOrderResult([]); }
    setLinkSearching(false);
  };

  const addExtraLink = (order) => {
    if (extraLinks.find(l => l.order_id === order.id)) return;
    const remaining = Math.max(0, totalExpense - thisAlloc - extraTotal);
    setExtraLinks(prev => [...prev, {
      order_id: order.id,
      order_num: order.order_num,
      client: order.client,
      allocated_amount: remaining > 0 ? String(Math.round(remaining)) : '',
    }]);
    setLinkOrderNum('');
    setLinkOrderResult(null);
  };

  const removeExtraLink  = (oid) => setExtraLinks(prev => prev.filter(l => l.order_id !== oid));
  const updateExtraAlloc = (oid, val) => setExtraLinks(prev =>
    prev.map(l => l.order_id === oid ? { ...l, allocated_amount: val } : l)
  );

  const handleSave = async () => {
    setError(null);
    if (!form.accounting_category_id) return setError('GL Account is required');
    if (!form.description.trim())     return setError('Description is required');
    if (!form.amount || parseFloat(form.amount) <= 0) return setError('Amount must be positive');
    if (form.payment_status === 'paid' && !form.payment_method)
      return setError('Payment method is required when status is Paid');
    if (overAllocated) return setError('Total allocated amounts exceed the expense total');

    setSaving(true);
    try {
      // Pass ALL links in the POST body — single atomic request
      const body = {
        expense_date:           form.expense_date,
        expense_category:       form.expense_category || null,
        accounting_category_id: form.accounting_category_id,
        description:            form.description.trim(),
        payee_name:             form.payee_name.trim() || null,
        amount:                 parseFloat(form.amount),
        allocated_amount:       thisAlloc,
        payment_status:         form.payment_status,
        payment_method:         form.payment_status === 'paid' ? form.payment_method : null,
        payment_reference:      form.payment_reference.trim() || null,
        receipt_url:            form.receipt_url.trim() || null,
        notes:                  form.notes.trim() || null,
        extra_links:            extraLinks.map(l => ({
          order_id: l.order_id,
          allocated_amount: parseFloat(l.allocated_amount),
        })),
      };
      const res  = await fetch(`/api/orders/${orderId}/expenses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save expense');
      onSaved();
      onClose();
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const inpS = { width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '13px', background: '#fafafa', boxSizing: 'border-box' };
  const lblS = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#888', marginBottom: '4px', textTransform: 'uppercase' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Add Direct Expense</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#aaa' }}>✕</button>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#dc2626', marginBottom: 14 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lblS}>Expense Date *</label>
            <input type="date" value={form.expense_date} onChange={e => set('expense_date', e.target.value)} style={inpS} />
          </div>
          <div>
            <label style={lblS}>Business Category</label>
            <select value={form.expense_category} onChange={e => set('expense_category', e.target.value)} style={inpS}>
              <option value="">Select category…</option>
              {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>GL Account *</label>
          <select value={form.accounting_category_id} onChange={e => set('accounting_category_id', e.target.value)} style={inpS} disabled={catsLoading}>
            <option value="">{catsLoading ? 'Loading…' : 'Select GL account…'}</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>Description *</label>
          <input value={form.description} onChange={e => set('description', e.target.value)} placeholder="What was this expense for?" style={inpS} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lblS}>Payee Name</label>
            <input value={form.payee_name} onChange={e => set('payee_name', e.target.value)} placeholder="Optional" style={inpS} />
          </div>
          <div>
            <label style={lblS}>Total Amount (KES) *</label>
            <input type="number" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0" style={inpS} />
          </div>
        </div>

        {/* Order allocations */}
        <div style={{ background: '#f8f9fa', border: '1px solid #e8e8e5', borderRadius: 8, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Order Allocations</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#374151' }}>
              {orderNum} <span style={{ color: '#9ca3af', fontWeight: 400 }}>(this order)</span>
            </div>
            <div style={{ width: 130 }}>
              <input
                type="number"
                value={form.allocated_amount !== '' ? form.allocated_amount : form.amount}
                onChange={e => set('allocated_amount', e.target.value)}
                placeholder={form.amount || '0'}
                style={{ ...inpS, fontSize: 12 }}
              />
            </div>
          </div>

          {extraLinks.map(l => (
            <div key={l.order_id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{ flex: 1, fontSize: 12, color: '#374151' }}>{l.order_num} — {l.client}</div>
              <div style={{ width: 130 }}>
                <input type="number" value={l.allocated_amount} onChange={e => updateExtraAlloc(l.order_id, e.target.value)} placeholder="0" style={{ ...inpS, fontSize: 12 }} />
              </div>
              <button onClick={() => removeExtraLink(l.order_id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
            </div>
          ))}

          {totalExpense > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, paddingTop: 8, borderTop: '1px solid #e8e8e5', color: overAllocated ? '#dc2626' : allocTotal >= totalExpense - 0.01 ? '#16a34a' : '#92400e' }}>
              <span>{overAllocated ? '⚠ Over-allocated' : allocTotal >= totalExpense - 0.01 ? '✓ Fully allocated' : '⚠ Partially allocated'}</span>
              <span style={{ fontFamily: 'monospace' }}>KES {Math.round(allocTotal).toLocaleString('en-KE')} / {Math.round(totalExpense).toLocaleString('en-KE')}</span>
            </div>
          )}

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e8e8e5' }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Link to another order (optional)</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={linkOrderNum} onChange={e => setLinkOrderNum(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchOrder()} placeholder="Order # or client name" style={{ ...inpS, flex: 1, fontSize: 12 }} />
              <button onClick={searchOrder} disabled={linkSearching} style={{ padding: '8px 14px', border: '1.5px solid #e0e0e0', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}>
                {linkSearching ? '…' : 'Search'}
              </button>
            </div>
            {linkOrderResult && (
              <div style={{ marginTop: 6, border: '1px solid #e8e8e5', borderRadius: 6, overflow: 'hidden' }}>
                {linkOrderResult.length === 0
                  ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#9ca3af' }}>No orders found</div>
                  : linkOrderResult.map(o => (
                    <div key={o.id} onClick={() => addExtraLink(o)} style={{ padding: '8px 12px', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <span style={{ fontWeight: 600 }}>{o.order_num}</span>
                      <span style={{ color: '#6b7280' }}>{o.client}</span>
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        </div>

        {/* Payment */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={lblS}>Payment Status</label>
            <select value={form.payment_status} onChange={e => set('payment_status', e.target.value)} style={inpS}>
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
            </select>
          </div>
          <div>
            <label style={lblS}>Payment Method {form.payment_status === 'paid' ? '*' : ''}</label>
            <select value={form.payment_method} onChange={e => set('payment_method', e.target.value)} style={{ ...inpS, borderColor: form.payment_status === 'paid' && !form.payment_method ? '#fca5a5' : '#e0e0e0' }} disabled={form.payment_status === 'unpaid'}>
              <option value="">— None —</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank Transfer</option>
              <option value="chatpesa">Chatpesa</option>
              <option value="mpesa">M-Pesa</option>
            </select>
          </div>
        </div>

        {form.payment_status === 'paid' && (
          <div style={{ marginBottom: 12 }}>
            <label style={lblS}>Payment Reference</label>
            <input value={form.payment_reference} onChange={e => set('payment_reference', e.target.value)} placeholder="Receipt / transaction ref" style={inpS} />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={lblS}>Receipt URL</label>
          <input value={form.receipt_url} onChange={e => set('receipt_url', e.target.value)} placeholder="https://… (optional)" style={inpS} />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={lblS}>Notes</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} placeholder="Optional" style={{ ...inpS, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleSave} disabled={saving || overAllocated}
            style={{ flex: 1, padding: '10px', background: saving || overAllocated ? '#ccc' : '#E8512A', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: saving || overAllocated ? 'default' : 'pointer' }}>
            {saving ? 'Saving…' : 'Save Expense'}
          </button>
          <button onClick={onClose} style={{ flex: 1, padding: '10px', background: '#f5f5f5', color: '#666', border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ReverseExpenseModal({ expenseId, description, onReversed, onClose }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const handleReverse = async () => {
    if (!reason.trim()) return setError('Reversal reason is required');
    setSaving(true);
    try {
      const res  = await fetch(`/api/expenses/${expenseId}?reason=${encodeURIComponent(reason.trim())}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reversal failed');
      onReversed();
      onClose();
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 400 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Reverse Expense</h3>
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
          Reversing "<strong>{description}</strong>" will exclude it from the P&L. The record stays visible but is marked reversed.
        </p>
        {error && <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#dc2626', marginBottom: 12 }}>{error}</div>}
        <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 4 }}>Reversal Reason *</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="Entered in error / duplicate / etc."
          style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, marginBottom: 14, resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleReverse} disabled={saving}
            style={{ flex: 1, padding: 10, background: saving ? '#ccc' : '#dc2626', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Reversing…' : 'Confirm Reversal'}
          </button>
          <button onClick={onClose} style={{ flex: 1, padding: 10, background: '#f5f5f5', color: '#666', border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PnLTab({ orderId, orderNum, contractTotal, itemsSubtotal, chargeItems, payments, userRole }) {
  const [purchases, setPurchases]            = useState([]);
  const [labourAllocations, setLabourAllocs] = useState([]);
  const [directExpenses, setDirectExpenses]  = useState([]);
  const [totals, setTotals]                  = useState({ totalCost: 0, totalPurchaseCost: 0, totalLabourCost: 0, totalDirectExpenses: 0, totalPaidAP: 0, outstandingAP: 0 });
  const [hasUnallocatedPurchases, setHasUnallocated] = useState(false);
  const [loading, setLoading]                = useState(true);
  const [fetchError, setFetchError]          = useState(null);
  const [pdfLoading, setPdfLoading]          = useState(false);
  const [subTab, setSubTab]                  = useState('supplier');
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [reverseTarget, setReverseTarget]    = useState(null);

  const canWrite = WRITE_ROLES_PNL.includes(userRole);

  const load = () => {
    setLoading(true);
    fetch(`/api/orders/${orderId}/pnl`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setPurchases(d.purchases || []);
          setLabourAllocs(d.labourAllocations || []);
          setDirectExpenses(d.directExpenses || []);
          setTotals(d.totals || {});
          setHasUnallocated(!!d.hasUnallocatedPurchases);
        } else {
          setFetchError(d.error || 'Failed to load P&L data');
        }
        setLoading(false);
      })
      .catch(() => { setFetchError('Failed to load P&L data'); setLoading(false); });
  };

  useEffect(() => { load(); }, [orderId]);

  const exportPdf = async () => {
    setPdfLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/pnl/pdf`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'PDF generation failed'); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      const cd   = res.headers.get('content-disposition') || '';
      const m    = cd.match(/filename="?([^"]+)"?/);
      a.download = m ? m[1] : `${orderId}_PnL.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert('PDF export failed: ' + err.message); }
    setPdfLoading(false);
  };

  const totalPaid   = (payments || []).filter(p => !p.reversed_at).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const grossProfit = contractTotal - (totals.totalPurchaseCost || 0) - (totals.totalLabourCost || 0);
  const orderProfit = grossProfit - (totals.totalDirectExpenses || 0);
  const margin      = contractTotal > 0 ? (orderProfit / contractTotal) * 100 : 0;
  const profitColor = orderProfit >= 0 ? '#16a34a' : '#dc2626';

  const kpiCard = (label, value, color = '#111', sub = null) => (
    <div className="pnl-kpi-card" style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: '10px', padding: '14px 16px', textAlign: 'center', flex: '1 1 0', minWidth: 0 }}>
      <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '5px', letterSpacing: '0.05em' }}>{label}</div>
      <div className="pnl-kpi-value" style={{ fontSize: '18px', fontWeight: 800, fontFamily: 'monospace', color }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '3px' }}>{sub}</div>}
    </div>
  );

  if (loading)    return <p style={{ fontSize: '13px', color: '#bbb', padding: '24px 0' }}>Loading P&L data…</p>;
  if (fetchError) return <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#dc2626' }}>⚠ {fetchError}</div>;

  const tabBtn = (key, label, count) => (
    <button key={key} onClick={() => setSubTab(key)} style={{
      padding: '7px 14px', borderRadius: 6, border: '1.5px solid',
      borderColor: subTab === key ? '#1a1a1a' : '#e0e0e0',
      background: subTab === key ? '#1a1a1a' : '#fff',
      color: subTab === key ? '#fff' : '#666',
      fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
    }}>
      {label}
      {count != null && (
        <span style={{ background: subTab === key ? 'rgba(255,255,255,0.2)' : '#f3f4f6', color: subTab === key ? '#fff' : '#6b7280', borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 700 }}>
          {count}
        </span>
      )}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {showExpenseModal && (
        <DirectExpenseModal orderId={orderId} orderNum={orderNum} onSaved={load} onClose={() => setShowExpenseModal(false)} />
      )}
      {reverseTarget && (
        <ReverseExpenseModal expenseId={reverseTarget.id} description={reverseTarget.description} onReversed={load} onClose={() => setReverseTarget(null)} />
      )}

      {/* Sub-tab bar + PDF button */}
      <div className="pnl-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div className="pnl-tabs-row" style={{ display: 'flex', gap: 6 }}>
          {tabBtn('supplier', 'Supplier Costs', purchases.length + labourAllocations.length)}
          {tabBtn('expenses', 'Direct Expenses', directExpenses.length)}
          {tabBtn('summary',  'Profit Summary')}
        </div>
        {PDF_ALLOWED_ROLES.includes(userRole) && (
          <button onClick={exportPdf} disabled={pdfLoading} className="pnl-export-btn"
            style={{ padding: '7px 16px', borderRadius: 7, border: '1.5px solid #E8512A', background: '#fff', color: pdfLoading ? '#aaa' : '#E8512A', fontWeight: 700, fontSize: 12, cursor: pdfLoading ? 'default' : 'pointer', minHeight: 44 }}>
            {pdfLoading ? 'Generating…' : '↓ Export PDF'}
          </button>
        )}
      </div>

      {/* KPI bar */}
      <div className="pnl-kpi-grid" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {kpiCard('Contract', fmtKES(contractTotal))}
        {kpiCard('Supplier + Labour', fmtKES((totals.totalPurchaseCost || 0) + (totals.totalLabourCost || 0)), '#E8512A')}
        {kpiCard('Direct Expenses', fmtKES(totals.totalDirectExpenses || 0), '#9333ea')}
        {kpiCard(orderProfit >= 0 ? 'Order Profit' : 'Order Loss', fmtKES(Math.abs(orderProfit)), profitColor, `${Math.round(margin)}% margin`)}
      </div>

      {/* ── SUPPLIER COSTS ── */}
      {subTab === 'supplier' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {hasUnallocatedPurchases && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e' }}>
              ⚠ One or more linked purchases have no cost split set — full purchase total may overstate costs.
              Go to <strong>Suppliers → Purchase → Edit order links</strong> to allocate amounts.
            </div>
          )}

          <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              Supplier Purchases ({purchases.length})
            </div>
            {purchases.length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No supplier costs linked. Link purchases from the Suppliers module.</p>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 2fr 110px', gap: 8, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f0ede8' }}>
                  <span>Date</span><span>Supplier</span><span>Description</span><span style={{ textAlign: 'right' }}>Amount</span>
                </div>
                {purchases.map(p => (
                  <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 2fr 110px', gap: 8, fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f9f8f6', alignItems: 'start' }}>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDate(p.purchase_date)}</span>
                    <span style={{ fontWeight: 600, color: '#111' }}>{p.supplier?.name || '—'}</span>
                    <span style={{ color: '#6b7280', fontSize: 12 }}>{p.items_bought || '—'}</span>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>KES {Math.round(p.total_amount).toLocaleString('en-KE')}</div>
                      {p.allocated_amount != null && p.purchase_total > p.allocated_amount + 0.01 && (
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>of {Math.round(p.purchase_total).toLocaleString('en-KE')} total</div>
                      )}
                    </div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, paddingTop: 10, marginTop: 4, borderTop: '1px solid #e8e8e5', color: '#6b7280' }}>
                  <span>Supplier Costs Total</span>
                  <span style={{ fontFamily: 'monospace' }}>KES {Math.round(totals.totalPurchaseCost || 0).toLocaleString('en-KE')}</span>
                </div>
                {totals.outstandingAP > 0.01 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px' }}>
                    ⚠ KES {Math.round(totals.outstandingAP).toLocaleString('en-KE')} still owed to suppliers (outstanding AP)
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
              Skilled Labour ({labourAllocations.length})
            </div>
            {labourAllocations.length === 0 ? (
              <p style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No skilled labour allocated. Add order links from Payroll → Entries.</p>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 110px', gap: 8, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f0ede8' }}>
                  <span>Worker</span><span>Run</span><span>Period</span><span style={{ textAlign: 'right' }}>Amount</span>
                </div>
                {labourAllocations.map((l, i) => (
                  <div key={l.id || i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 110px', gap: 8, fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f9f8f6', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>{l.worker_name}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>
                      {l.run_num || '—'}
                      {l.run_status && <span style={{ marginLeft: 6, fontSize: 10, background: '#f3f4f6', borderRadius: 4, padding: '1px 5px' }}>{l.run_status}</span>}
                    </span>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>
                      {l.period_start && l.period_end
                        ? `${new Date(l.period_start + 'T00:00:00Z').toLocaleDateString('en-KE', { day: '2-digit', month: 'short' })} – ${new Date(l.period_end + 'T00:00:00Z').toLocaleDateString('en-KE', { day: '2-digit', month: 'short' })}`
                        : '—'}
                    </span>
                    <div style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>KES {Math.round(l.allocated_amount).toLocaleString('en-KE')}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, paddingTop: 10, marginTop: 4, borderTop: '1px solid #e8e8e5', color: '#6b7280' }}>
                  <span>Labour Total</span>
                  <span style={{ fontFamily: 'monospace' }}>KES {Math.round(totals.totalLabourCost || 0).toLocaleString('en-KE')}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── DIRECT EXPENSES ── */}
      {subTab === 'expenses' && (
        <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Direct Order Expenses</div>
            {canWrite && (
              <button onClick={() => setShowExpenseModal(true)}
                style={{ padding: '6px 14px', borderRadius: 6, border: '1.5px solid #E8512A', background: '#E8512A', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                + Direct Expense
              </button>
            )}
          </div>

          {directExpenses.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px 0', color: '#9ca3af' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
              <div style={{ fontSize: 13 }}>No direct expenses yet.</div>
              {canWrite && <div style={{ fontSize: 12, marginTop: 4 }}>Click <strong>+ Direct Expense</strong> to add one.</div>}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 140px 1fr 90px 80px 80px', gap: 8, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #f0ede8' }}>
                <span>Date</span><span>Category</span><span>Description</span><span style={{ textAlign: 'right' }}>Amount</span><span style={{ textAlign: 'center' }}>Status</span><span></span>
              </div>
              {directExpenses.map(e => {
                const isReversed = !!e.reversed_at;
                const rowStyle = isReversed ? { opacity: 0.55, background: '#fafafa' } : {};
                const textStyle = isReversed ? { textDecoration: 'line-through', color: '#9ca3af' } : {};
                return (
                <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '80px 140px 1fr 90px 100px 80px', gap: 8, fontSize: 13, padding: '9px 0', borderBottom: '1px solid #f9f8f6', alignItems: 'center', ...rowStyle }}>
                  <span style={{ fontSize: 11, color: '#9ca3af', ...textStyle }}>{fmtDate(e.expense_date)}</span>
                  <div style={{ ...textStyle }}>
                    {e.expense_category && (
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{e.expense_category}</div>
                    )}
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{e.category}</div>
                  </div>
                  <div>
                    <div style={{ color: '#374151', fontSize: 12, ...textStyle }}>{e.description}</div>
                    {e.payee_name && <div style={{ fontSize: 11, color: '#9ca3af' }}>Payee: {e.payee_name}</div>}
                    {isReversed && (
                      <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }} title={e.reversal_reason}>
                        Reversed{e.reversal_reason ? `: ${e.reversal_reason}` : ''}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, ...textStyle }}>KES {Math.round(e.allocated_amount).toLocaleString('en-KE')}</div>
                    {e.allocated_amount < e.amount - 0.01 && (
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>of {Math.round(e.amount).toLocaleString('en-KE')}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    {isReversed ? (
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 10, background: '#fee2e2', color: '#dc2626' }}>
                        Reversed
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 10, background: e.payment_status === 'paid' ? '#dcfce7' : '#fef3c7', color: e.payment_status === 'paid' ? '#15803d' : '#92400e' }}>
                        {e.payment_status === 'paid' ? 'Paid' : 'Unpaid'}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    {canWrite && userRole === 'admin' && !isReversed && (
                      <button onClick={() => setReverseTarget({ id: e.id, description: e.description })}
                        style={{ fontSize: 11, padding: '3px 8px', border: '1px solid #fca5a5', borderRadius: 5, color: '#dc2626', background: '#fef2f2', cursor: 'pointer' }}>
                        Reverse
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, paddingTop: 10, marginTop: 4, borderTop: '2px solid #e8e8e5', color: '#9333ea' }}>
                <span>Direct Expenses Total</span>
                <span style={{ fontFamily: 'monospace' }}>KES {Math.round(totals.totalDirectExpenses || 0).toLocaleString('en-KE')}</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PROFIT SUMMARY ── */}
      {subTab === 'summary' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: 10, overflow: 'hidden' }}>
            {[
              { label: 'Contract Value',      value: contractTotal,                                 bold: true, color: '#111' },
              { label: '− Supplier Costs',    value: -(totals.totalPurchaseCost || 0),             color: '#E8512A' },
              { label: '− Skilled Labour',    value: -(totals.totalLabourCost || 0),               color: '#E8512A' },
              { label: '= Gross Profit',      value: grossProfit,  bold: true, divider: true,      color: grossProfit >= 0 ? '#16a34a' : '#dc2626' },
              { label: '− Direct Expenses',   value: -(totals.totalDirectExpenses || 0),           color: '#9333ea' },
              { label: '= Order Profit',      value: orderProfit,  bold: true, divider: true, large: true, color: orderProfit >= 0 ? '#16a34a' : '#dc2626' },
            ].map((row, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 20px',
                borderTop: row.divider ? '2px solid #e8e8e5' : i > 0 ? '1px solid #f5f5f5' : 'none',
                background: row.large ? (orderProfit >= 0 ? '#f0fdf4' : '#fef2f2') : '#fff',
              }}>
                <span style={{ fontSize: row.large ? 14 : 13, fontWeight: row.bold ? 700 : 400, color: row.bold ? row.color : '#374151' }}>{row.label}</span>
                <span style={{ fontFamily: 'monospace', fontWeight: row.bold ? 800 : 600, fontSize: row.large ? 18 : 13, color: row.color }}>
                  KES {Math.round(Math.abs(row.value)).toLocaleString('en-KE')}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: profitColor + '18', borderTop: '1px solid #e8e8e5' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Order Margin</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 900, fontSize: 24, color: profitColor }}>{Math.round(margin)}%</span>
            </div>
          </div>

          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Revenue</div>
            {itemsSubtotal > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#374151' }}>
                <span>Items subtotal</span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(itemsSubtotal).toLocaleString('en-KE')}</span>
              </div>
            )}
            {(chargeItems || []).map((ci, idx) => (
              <div key={ci.id || idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13, color: '#374151' }}>
                <span>{ci.category}</span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(parseFloat(ci.unit_price) || 0).toLocaleString('en-KE')}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '1px solid #fbd5b0', paddingTop: 8, marginTop: 4, marginBottom: 10, fontSize: 13 }}>
              <span>Contract Total</span><span style={{ fontFamily: 'monospace' }}>KES {Math.round(contractTotal).toLocaleString('en-KE')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13, color: '#16a34a' }}>
              <span>Received from client</span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(totalPaid).toLocaleString('en-KE')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: contractTotal - totalPaid > 0.01 ? '#E8512A' : '#16a34a' }}>
              <span>Outstanding (receivable)</span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(Math.max(0, contractTotal - totalPaid)).toLocaleString('en-KE')}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function OrderFormPage() {
  const { id } = useParams();

  const [activeTab, setActiveTab]     = useState('info');
  const [order, setOrder]             = useState(null);
  const [items, setItems]             = useState([]);
  const [deliveries, setDeliveries]   = useState([]);
  const [userRole, setUserRole]       = useState('viewer');
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [editMode, setEditMode]       = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [editedItems, setEditedItems] = useState([]);
  const [editedNotes, setEditedNotes] = useState('');
  const [editedDueDate, setEditedDueDate] = useState('');
  const [editedDeliveryAddress, setEditedDeliveryAddress]           = useState('');
  const [editedDeliveryContact, setEditedDeliveryContact]           = useState('');
  const [editedDeliveryInstructions, setEditedDeliveryInstructions] = useState('');
  const [saving, setSaving]           = useState(false);

  // Payments state — lifted from PaymentPanel so PnLTab can read totalPaid.
  // Fetched here at the parent level so P&L has accurate data no matter which
  // tab the user visits first (PaymentPanel also refreshes on its own mount).
  const [payments, setPayments]       = useState([]);
  useEffect(() => {
    supabase
      .from('order_payments')
      .select('*')
      .eq('order_id', id)
      .order('payment_date')
      .then(({ data }) => setPayments(data || []));
  }, [id]);

  // Modal state
  const [modal, setModal]             = useState(null); // null | 'rework' | 'refund' | 'repair' | 'credit' | 'quote'
  const [advancing, setAdvancing]     = useState(false);
  const [actionError, setActionError] = useState(null);

  // Rework modal
  const [reworkReason, setReworkReason]   = useState(REWORK_REASONS[0]);
  const [reworkAuth, setReworkAuth]       = useState('');
  const [reworkNotes, setReworkNotes]     = useState('');

  // Refund modal
  const [refundRef, setRefundRef]         = useState('');
  const [refundNotes, setRefundNotes]     = useState('');

  // Repair modal
  const [repairType, setRepairType]       = useState('repair');
  const [repairReason, setRepairReason]   = useState(REPAIR_REASONS[0]);
  const [repairDesc, setRepairDesc]       = useState('');
  const [repairCost, setRepairCost]       = useState('');

  // Credit approval modal
  const [creditRef, setCreditRef]         = useState('');
  const [creditExposure, setCreditExposure] = useState(0);
  const [creditLimit, setCreditLimit]     = useState(0);

  // Quote confirm
  const [quoteNum, setQuoteNum]           = useState('');

  // Full item editing (admin + head_of_sales)
  const [deletedItemIds, setDeletedItemIds] = useState([]);

  // Increment to force order data refresh (used by DeliveryTab)
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshOrder = useCallback(() => setRefreshKey(k => k + 1), []);

  // Batch delivery toggle (admin / HoS / PM only)
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [enablingBatch, setEnablingBatch] = useState(false);

  // Customer linking
  const [showLinkCustomer, setShowLinkCustomer] = useState(false);
  const [customerSearch, setCustomerSearch]     = useState('');
  const [customerResults, setCustomerResults]   = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [linkingCustomer, setLinkingCustomer]   = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [ordRes, itemsRes, deliveriesRes, userRes] = await Promise.all([
          supabase.from('orders').select('*').eq('id', id).single(),
          supabase.from('order_items').select('*').eq('order_id', id).order('sort_order'),
          supabase.from('order_deliveries').select('*').eq('order_id', id).order('batch_number'),
          supabase.auth.getUser(),
        ]);

        if (ordRes.error) throw new Error(ordRes.error.message);
        if (!ordRes.data) throw new Error('Order not found');

        if (userRes.data?.user) {
          const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', userRes.data.user.id).single();
          if (profile?.role) setUserRole(profile.role);
        }

        const ord = ordRes.data;
        // Fetch linked customer name separately (safe — won't break load if table missing)
        if (ord.customer_id) {
          const { data: cust } = await supabase.from('customers').select('id, name').eq('id', ord.customer_id).maybeSingle();
          if (cust) ord._customer = cust;
        }
        setOrder(ord);
        setEditedNotes(ord.notes || '');
        setEditedDueDate(ord.due_date || '');
        setEditedDeliveryAddress(ord.delivery_address || '');
        setEditedDeliveryContact(ord.delivery_contact || '');
        setEditedDeliveryInstructions(ord.delivery_instructions || '');
        const loadedItems = itemsRes.data || [];
        setItems(loadedItems);
        setEditedItems(loadedItems.map(i => ({ ...i })));
        setDeliveries(deliveriesRes.data || []);

      } catch (err) {
        setError(err.message || 'Failed to load order');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, refreshKey]);

  // ── Customer search (for link modal) — must be before any early returns ───────
  useEffect(() => {
    if (!showLinkCustomer) return;
    const t = setTimeout(async () => {
      setCustomerSearching(true);
      const q = customerSearch.trim();
      let query = supabase.from('customers').select('id, name, contact_person, phone').order('name').limit(20);
      if (q) query = query.or(`name.ilike.%${q}%,contact_person.ilike.%${q}%,phone.ilike.%${q}%`);
      const { data } = await query;
      setCustomerResults(data || []);
      setCustomerSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [customerSearch, showLinkCustomer]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f9fafb' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
          <p style={{ color: '#6b7280', fontSize: '14px' }}>Loading order...</p>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f9fafb' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '8px' }}>Error</h1>
          <p style={{ color: '#6b7280', marginBottom: '20px' }}>{error || 'Order not found'}</p>
          <Link href="/orders" style={{ color: '#E8512A', fontWeight: 600, textDecoration: 'none' }}>← Back to Orders</Link>
        </div>
      </div>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────────

  // Suspension — all mutations are blocked; only read/view/unsuspend is allowed
  const isSuspended = !!order?.suspended_at;

  const PRE_PRODUCTION_STATUSES = ['Inquiry', 'Quote Approved', 'Deposit Paid', 'Material Check'];
  const canEditItems = !isSuspended && (['admin', 'head_of_sales'].includes(userRole) ||
    (userRole === 'sales' && PRE_PRODUCTION_STATUSES.includes(order?.status)));
  const displayItems    = editMode ? editedItems : items;
  const itemsSubtotal   = displayItems.filter(i => !isChargeItem(i)).reduce((s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);
  const chargesSubtotal = displayItems.filter(i => isChargeItem(i)).reduce((s, i) => s + (parseFloat(i.unit_price) || 0), 0);
  // In edit mode (canEditItems), reflect live edits; otherwise use saved order.total_value
  const contractTotal   = (editMode && canEditItems)
    ? itemsSubtotal + chargesSubtotal
    : parseFloat(order.total_value) || 0;

  const isCredit = ['reseller', 'commercial'].includes(order.customer_type)
    && CREDIT_TERMS.includes(order.payment_terms);

  const BATCH_ROLES    = ['admin', 'head_of_sales', 'production_manager'];
  const canToggleBatch = BATCH_ROLES.includes(userRole);
  const totalQty       = items.filter(i => !isChargeItem(i)).reduce((s, i) => s + (parseInt(i.quantity) || 1), 0);
  // Commercial and reseller clients can always use batch delivery;
  // other orders require qty > 20 OR value >= KES 500,000
  const isCommercialOrReseller = ['commercial', 'reseller'].includes(order.customer_type);
  const batchEligible  = isCommercialOrReseller || totalQty > 20 || contractTotal >= 500000;
  const batchWarning   = !order.batch_delivery && canToggleBatch && (contractTotal >= 500000 || totalQty >= 100);

  // Build status list: exclude "Cancelled / Refunded" always; exclude "Partially Delivered" always
  // (batch orders stay in Production until full completion — no Partially Delivered intermediate state)
  const sList = (() => {
    let base = getStatusList(order.order_type);
    base = base.filter(s => s !== 'Partially Delivered');
    return base;
  })();
  const cIdx  = sList.indexOf(order.status);
  const nextSt = cIdx >= 0 && cIdx < sList.length - 1 ? sList[cIdx + 1] : null;

  // Send-back: only specific REWORK_TARGETS, not any prev step
  const reworkTarget = REWORK_TARGETS[order.status] || null;
  const canRework    = ROLES_CAN_REWORK.includes(userRole);
  const canSendBack  = !isSuspended && !!reworkTarget && canRework;

  // Full Refund: Quote Approved only, ROLES_CAN_REFUND
  const canFullRefund = !isSuspended && order.status === 'Quote Approved' && ROLES_CAN_REFUND.includes(userRole);

  // Repair/Return: Closed only, admin only
  const canRepair = !isSuspended && order.status === 'Closed' && userRole === 'admin';

  // Next stage availability
  const isTerminal = order.status === 'Closed' || order.status === 'Redelivered' || order.status === 'Cancelled / Refunded';
  const canAdvance = !isSuspended && ROLES_CAN_ADVANCE.includes(userRole) && !isTerminal && !!nextSt;
  const salesBlocked = userRole === 'sales' && nextSt && sList.indexOf(nextSt) > sList.indexOf(SALES_MAX_ADVANCE_TO);

  // ── Edit save ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      // Compute new contract total from edited items
      const newTotal = editedItems
        .filter(i => !deletedItemIds.includes(i.id))
        .reduce((s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);

      // Update order metadata
      const orderUpdate = {
        notes: editedNotes,
        due_date: editedDueDate || null,
        delivery_address: editedDeliveryAddress || null,
        delivery_contact: editedDeliveryContact || null,
        delivery_instructions: editedDeliveryInstructions || null,
      };
      if (canEditItems) orderUpdate.total_value = newTotal;
      await supabase.from('orders').update(orderUpdate).eq('id', id);

      if (canEditItems) {
        // Delete removed items
        if (deletedItemIds.length > 0) {
          await supabase.from('order_items').delete().in('id', deletedItemIds);
        }
        // Insert new items (no id — identified by _id only)
        const newItems = editedItems.filter(i => !i.id && !deletedItemIds.includes(i.id));
        if (newItems.length > 0) {
          const rows = newItems.map((item, idx) => ({
            order_id: id,
            category: isChargeItem(item) ? item.category : item.category,
            description: item.description || item.category || null,
            quantity: isChargeItem(item) ? 1 : (parseInt(item.quantity) || 1),
            size: item.size || null,
            finish_type: item.finish_type || null,
            finish_color: item.finish_color || null,
            wood_type: item.wood_type || null,
            unit_price: parseFloat(item.unit_price) || 0,
            sort_order: (items.length - deletedItemIds.length) + idx,
          }));
          await supabase.from('order_items').insert(rows);
        }
        // Update changed existing items
        for (const item of editedItems.filter(i => i.id && !deletedItemIds.includes(i.id))) {
          const orig = items.find(i => i.id === item.id);
          if (!orig) continue;
          const changed = orig.quantity !== parseInt(item.quantity) ||
            parseFloat(orig.unit_price) !== parseFloat(item.unit_price) ||
            orig.category !== item.category ||
            (orig.description || '') !== (item.description || '') ||
            (orig.size || '') !== (item.size || '');
          if (changed) {
            await supabase.from('order_items').update({
              category: item.category,
              description: item.description || null,
              quantity: isChargeItem(item) ? 1 : (parseInt(item.quantity) || 1),
              size: item.size || null,
              finish_type: item.finish_type || null,
              finish_color: item.finish_color || null,
              wood_type: item.wood_type || null,
              unit_price: parseFloat(item.unit_price) || 0,
            }).eq('id', item.id);
          }
        }
      } else {
        // Non-admin/HoS: quantity-only edits
        for (const item of editedItems) {
          const orig = items.find(i => i.id === item.id);
          if (orig && orig.quantity !== item.quantity) {
            await supabase.from('order_items').update({ quantity: item.quantity }).eq('id', item.id);
          }
        }
      }

      const [{ data: refreshed }, { data: refreshedItems }] = await Promise.all([
        supabase.from('orders').select('*').eq('id', id).single(),
        supabase.from('order_items').select('*').eq('order_id', id).order('sort_order'),
      ]);
      if (refreshed?.customer_id) {
        const { data: cust } = await supabase.from('customers').select('id, name').eq('id', refreshed.customer_id).maybeSingle();
        if (cust) refreshed._customer = cust;
      }
      setOrder(refreshed);
      const loaded = refreshedItems || [];
      setItems(loaded);
      setEditedItems(loaded.map(i => ({ ...i })));
      setDeletedItemIds([]);
      setEditMode(false);
    } catch (err) {
      setError('Save failed: ' + (err.message || err));
    }
    setSaving(false);
  };

  const handleCancel = () => {
    setEditedItems(items.map(i => ({ ...i })));
    setEditedNotes(order.notes || '');
    setEditedDueDate(order.due_date || '');
    setEditedDeliveryAddress(order.delivery_address || '');
    setEditedDeliveryContact(order.delivery_contact || '');
    setEditedDeliveryInstructions(order.delivery_instructions || '');
    setDeletedItemIds([]);
    setEditMode(false);
  };

  // ── Item edit helpers (admin + head_of_sales) ─────────────────────────────
  const updItem = (_id_or_id, field, val) =>
    setEditedItems(prev => prev.map(i => (i._id === _id_or_id || i.id === _id_or_id) ? { ...i, [field]: val } : i));
  const delItem = (item) => {
    if (item.id) {
      // existing DB row — mark for deletion
      setDeletedItemIds(prev => [...prev, item.id]);
      setEditedItems(prev => prev.filter(i => i.id !== item.id));
    } else {
      // new unsaved row — just remove from state
      setEditedItems(prev => prev.filter(i => i._id !== item._id));
    }
  };
  const addItem = () => setEditedItems(prev => [...prev, newLineItem()]);
  const addCharge = () => setEditedItems(prev => [...prev, newChargeItem()]);

  // ── Status helpers ────────────────────────────────────────────────────────────
  const applyStatus = async (newStatus, extras = {}) => {
    setAdvancing(true);
    setActionError(null);

    // Optimistic update — reflect new status in UI immediately
    const prevOrder = order;
    setOrder(prev => ({ ...prev, status: newStatus, ...extras }));
    setModal(null);

    try {
      const res = await fetch(`/api/orders/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newStatus,
          reason: extras.reason,
          authorizedBy: extras.authorizedBy,
          refundReference: extras.refund_reference,
          creditApprovalRef: extras.credit_approval_ref,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
    } catch (err) {
      // Roll back optimistic update on failure
      setOrder(prevOrder);
      setModal(null);
      setActionError(err.message || 'Action failed');
    }
    setAdvancing(false);
  };

  // ── Advance: click handler ───────────────────────────────────────────────────
  const handleNextStage = async () => {
    if (!canAdvance || salesBlocked) return;
    setActionError(null);

    // Gate: moving to Quote Approved — confirm quote number exists
    if (nextSt === 'Quote Approved') {
      if (!order.quote_number) {
        setQuoteNum('');
        setModal('quote');
        return;
      }
      await applyStatus(nextSt);
      return;
    }

    // Gate: credit reseller advancing FROM Quote Approved → skip Deposit Paid
    if (order.status === 'Quote Approved' && isCredit) {
      // Load credit exposure
      const { data: cp } = await supabase.from('client_profiles').select('credit_limit, current_exposure').eq('client_name', order.client).maybeSingle();
      setCreditLimit(cp?.credit_limit || 0);
      setCreditExposure(cp?.current_exposure || 0);
      setCreditRef('');
      setModal('credit');
      return;
    }

    // Gate: non-credit advancing to Deposit Paid — check payments exist
    if (nextSt === 'Deposit Paid') {
      const { data: pmts } = await supabase.from('order_payments').select('id').eq('order_id', id).limit(1);
      if (!pmts || pmts.length === 0) {
        setActionError('A deposit payment must be recorded before advancing to Deposit Paid. Use the Financial Summary section below.');
        return;
      }
    }

    // All other advances: just apply
    await applyStatus(nextSt);
  };

  // ── Send Back ────────────────────────────────────────────────────────────────
  const handleSendBackClick = () => {
    setReworkReason(REWORK_REASONS[0]);
    setReworkAuth('');
    setReworkNotes('');
    setActionError(null);
    setModal('rework');
  };

  const confirmRework = async () => {
    if (!reworkAuth.trim()) { setActionError('Authorized by field is required.'); return; }
    // Pass reason + authorizedBy so the server logs them in the activity entry
    await applyStatus(reworkTarget, {
      reason: `${reworkReason}${reworkNotes.trim() ? ` — ${reworkNotes.trim()}` : ''}`,
      authorizedBy: reworkAuth.trim(),
    });
  };

  // ── Full Refund ───────────────────────────────────────────────────────────────
  const handleRefundClick = () => {
    setRefundRef('');
    setRefundNotes('');
    setActionError(null);
    setModal('refund');
  };

  const confirmRefund = async () => {
    if (!refundRef.trim()) { setActionError('Refund reference number is required.'); return; }
    await applyStatus('Cancelled / Refunded', {
      refund_reference: refundRef.trim(),
      reason: refundNotes.trim() || 'Full refund issued',
    });
  };

  // ── Repair / Return ────────────────────────────────────────────────────────────
  const handleRepairClick = () => {
    setRepairType('repair');
    setRepairReason(REPAIR_REASONS[0]);
    setRepairDesc('');
    setRepairCost('');
    setActionError(null);
    setModal('repair');
  };

  const confirmRepair = async () => {
    if (!repairDesc.trim()) { setActionError('Please describe the issue.'); return; }
    setAdvancing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/orders/${id}/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repair_type:   repairType,
          repair_reason: repairReason,
          repair_desc:   repairDesc.trim(),
          repair_cost:   parseFloat(repairCost) || 0,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);

      setModal(null);
      // Navigate to the new repair/return order
      window.location.href = `/orders/${json.order_id}/form`;
    } catch (err) {
      setActionError(err.message || 'Failed to create repair order');
      setAdvancing(false);
    }
  };

  // ── Credit Approval ────────────────────────────────────────────────────────────
  const confirmCredit = async () => {
    if (!creditRef.trim()) { setActionError('Credit approval reference is required.'); return; }
    const orderTotal = contractTotal;
    const newExposure = creditExposure + orderTotal;

    // head_of_sales can only approve up to their limit
    if (userRole === 'head_of_sales' && orderTotal > HEAD_OF_SALES_CREDIT_LIMIT) {
      setActionError(`Head of Sales can only approve up to KES ${HEAD_OF_SALES_CREDIT_LIMIT.toLocaleString()}. This order requires admin approval.`);
      return;
    }
    if (creditLimit > 0 && newExposure > creditLimit) {
      setActionError(`This order (KES ${orderTotal.toLocaleString()}) would bring ${order.client}'s exposure to KES ${newExposure.toLocaleString()}, exceeding their credit limit of KES ${creditLimit.toLocaleString()}.`);
      return;
    }

    // Credit approved: skip Deposit Paid, go to Material Check.
    // The server reads order.total_value + client_profiles.current_exposure from DB
    // and writes the new exposure atomically — no client-side update needed.
    await applyStatus('Material Check', { credit_approval_ref: creditRef.trim() });
  };

  // ── Inline quote confirm ───────────────────────────────────────────────────────
  const confirmQuote = async () => {
    if (!quoteNum.trim()) { setActionError('Quote number is required.'); return; }
    // Save quote number + advance
    await supabase.from('orders').update({ quote_number: quoteNum.trim() }).eq('id', id);
    setOrder(prev => ({ ...prev, quote_number: quoteNum.trim() }));
    await applyStatus('Quote Approved');
  };

  // ── Enable batch delivery ─────────────────────────────────────────────────────
  const enableBatchDelivery = async () => {
    setEnablingBatch(true);
    try {
      const { error } = await supabase.from('orders').update({ batch_delivery: true }).eq('id', id);
      if (error) throw new Error(error.message);
      setBatchConfirm(false);
      refreshOrder();
    } catch (err) {
      alert('Error enabling batch delivery: ' + err.message);
    }
    setEnablingBatch(false);
  };


  const linkCustomerToOrder = async (customer) => {
    setLinkingCustomer(true);
    try {
      const res  = await fetch(`/api/orders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customer.id }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to link customer');
      setOrder(prev => ({ ...prev, customer_id: customer.id, _customer: customer }));
      setShowLinkCustomer(false);
      setCustomerSearch('');
    } catch (err) {
      alert('Error linking customer: ' + err.message);
    }
    setLinkingCustomer(false);
  };

  // ── Styles ────────────────────────────────────────────────────────────────────
  const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '24px', marginBottom: '24px' };
  const sectionLabel = { fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '16px' };
  const fieldLabel = { fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' };
  const fieldValue = { fontSize: '13px', fontWeight: 600, color: '#111' };
  const inpStyle = { width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', background: '#fafafa' };
  const lbl = { display: 'block', fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' };

  // Status colours
  const sc = ALL_STATUS_COLORS[order.status] || { bg: '#FED7AA', text: '#92400E', border: '#FDB97A' };

  return (
    <div className="order-page" style={{ background: '#f9fafb', minHeight: '100vh' }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div className="order-workflow-header print-hidden-header" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ background: '#111827', color: '#fff' }}>

        {/* Row 1: Back | Order num · Client | Edit/Save */}
        <div className="order-header-row1 print-hidden" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid #374151' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <Link href="/orders" style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}>← Orders</Link>
            <div className="order-header-divider" style={{ width: '1px', height: '14px', background: '#374151', flexShrink: 0 }} />
            <div className="order-header-identity" style={{ minWidth: 0, overflow: 'hidden' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#fff', fontFamily: 'monospace', letterSpacing: '-0.3px', display: 'block' }}>{order.order_num}</span>
              <span className="order-header-client" style={{ fontSize: '12px', color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{order.client}</span>
            </div>
          </div>
          <div className="order-header-actions" style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: '12px' }}>
            {isSuspended ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 12px', borderRadius: '6px', background: 'rgba(245,158,11,0.15)', border: '1px solid #f59e0b', color: '#f59e0b', fontWeight: 700, fontSize: '11px' }}>
                ⏸ SUSPENDED
              </span>
            ) : editMode ? (
              <>
                <button onClick={handleSave} disabled={saving} className="order-header-btn" style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: '#E8512A', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer', minHeight: 44 }}>
                  {saving ? 'Saving...' : '✓ Save'}
                </button>
                <button onClick={handleCancel} className="order-header-btn" style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid #4b5563', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: '12px', cursor: 'pointer', minHeight: 44 }}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setEditMode(true)} className="order-header-btn" style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: '#E8512A', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer', minHeight: 44 }}>
                  ✎ Edit
                </button>
                <button onClick={() => window.print()} className="order-print-btn order-header-btn" style={{ padding: '6px 14px', borderRadius: '6px', border: '1.5px solid #E8512A', background: 'transparent', color: '#E8512A', fontWeight: 700, fontSize: '12px', cursor: 'pointer', minHeight: 44 }}>
                  Print
                </button>
                <div style={{ position: 'relative' }} className="order-more-btn">
                  <button onClick={() => setMobileMenuOpen(o => !o)} style={{ display: 'flex', padding: '6px 12px', borderRadius: '6px', border: '1.5px solid #4b5563', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: '14px', cursor: 'pointer', minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
                    ⋯
                  </button>
                  {mobileMenuOpen && (
                    <>
                      <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setMobileMenuOpen(false)} />
                      <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 200, background: '#1f2937', border: '1px solid #374151', borderRadius: '8px', padding: '4px', minWidth: '140px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                        <button onClick={() => { window.print(); setMobileMenuOpen(false); }} style={{ display: 'flex', width: '100%', padding: '9px 12px', border: 'none', background: 'transparent', color: '#d1d5db', fontSize: '13px', fontWeight: 500, cursor: 'pointer', borderRadius: '5px', textAlign: 'left', minHeight: 44, alignItems: 'center', gap: '8px' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          🖨 Print
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Row 2: Progress bar */}
        <div style={{ padding: '7px 20px 0' }} className="print-hidden order-progress-row">
          <div style={{ display: 'flex', gap: '2px' }}>
            {sList.map((s, i) => {
              const c = ALL_STATUS_COLORS[s] || { text: '#555' };
              return <div key={s} title={s} style={{ flex: 1, height: '3px', borderRadius: '2px', background: i <= cIdx ? (c.text || '#888') : '#374151', transition: 'background 0.2s' }} />;
            })}
          </div>
        </div>

        {/* Row 3: Previous Stage | Current · Step X/N | Next Stage */}
        <div className="order-workflow-row print-hidden" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 20px 10px' }}>

          {/* Left: Send Back */}
          <div className="order-workflow-back" style={{ flex: 1 }}>
            {canSendBack && !isTerminal && (
              <button onClick={handleSendBackClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #f59e0b', background: 'transparent', color: '#f59e0b', fontWeight: 700, fontSize: '11px', cursor: 'pointer', minHeight: 44 }}>
                ↩ {reworkTarget}
              </button>
            )}
          </div>

          {/* Centre: current status + step counter */}
          <div className="order-workflow-status" style={{ textAlign: 'center', flex: 1 }}>
            <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 600 }}>
              {isTerminal ? order.status : `${order.status} · ${Math.max(cIdx + 1, 1)} of ${sList.length}`}
            </span>
            {actionError && (
              <div style={{ fontSize: '10px', color: '#f87171', marginTop: '2px' }}>⚠ {actionError}</div>
            )}
          </div>

          {/* Right: Next Stage / special actions */}
          <div className="order-workflow-next" style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: '6px', alignItems: 'center' }}>
            {canAdvance && !salesBlocked && (
              <button onClick={handleNextStage} disabled={advancing} style={{ padding: '5px 14px', borderRadius: '5px', border: 'none', background: advancing ? '#374151' : '#16a34a', color: '#fff', fontWeight: 700, fontSize: '11px', cursor: advancing ? 'default' : 'pointer', minHeight: 44 }}>
                {advancing ? '...' : `→ ${nextSt}`}
              </button>
            )}
            {salesBlocked && canAdvance && (
              <span style={{ fontSize: '10px', color: '#6b7280', fontStyle: 'italic' }}>Max: {SALES_MAX_ADVANCE_TO}</span>
            )}
            {canFullRefund && (
              <button onClick={handleRefundClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #f43f5e', background: 'transparent', color: '#f43f5e', fontWeight: 700, fontSize: '11px', cursor: 'pointer', minHeight: 44 }}>
                💸 Refund
              </button>
            )}
            {canRepair && (
              <button onClick={handleRepairClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #8b5cf6', background: 'transparent', color: '#8b5cf6', fontWeight: 700, fontSize: '11px', cursor: 'pointer', minHeight: 44 }}>
                🔧 Repair
              </button>
            )}
          </div>
        </div>
        </div>{/* end dark header inner */}

        {/* ── Suspended banner ── */}
        {isSuspended && (
          <div style={{ background: 'rgba(245,158,11,0.12)', borderBottom: '1px solid #f59e0b', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '8px' }} className="print-hidden">
            <span style={{ fontSize: '16px' }}>⏸</span>
            <span style={{ color: '#92400e', fontWeight: 700, fontSize: '13px' }}>Order Suspended</span>
            {order.suspension_reason && (
              <span style={{ color: '#78350f', fontSize: '12px' }}>— {order.suspension_reason}</span>
            )}
          </div>
        )}

        {/* ── Tab bar ── */}
        <div style={{ position: 'relative', background: '#fff', borderBottom: '1px solid #e5e7eb' }} className="print-hidden order-tab-bar order-tabs-sticky">
          <div className="order-tab-scroll" style={{ display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {[
              { id: 'info',     label: 'Info',     icon: '📋' },
              { id: 'payments', label: 'Payments', icon: '💰' },
              { id: 'pnl',      label: 'P&L',      icon: '📊' },
              { id: 'delivery', label: 'Delivery', icon: '🚚' },
              { id: 'drawings', label: 'Files',    icon: '📐' },
              { id: 'activity', label: 'Activity', icon: '🕐' },
              ...(userRole === 'admin' ? [{ id: 'danger', label: 'Danger Zone', icon: '⚠' }] : []),
            ].map(t => (
              <button key={t.id} data-order-tab={t.id} onClick={(e) => {
                setActiveTab(t.id);
                e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              }} style={{
                padding: '10px 16px', border: 'none', background: 'transparent',
                borderBottom: activeTab === t.id ? '2.5px solid #E8512A' : '2.5px solid transparent',
                color: activeTab === t.id ? '#E8512A' : '#6b7280',
                fontWeight: activeTab === t.id ? 700 : 500,
                fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: '5px',
                minHeight: 44, flexShrink: 0,
              }}>
                <span>{t.icon}</span>
                <span className="tab-label">{t.label}</span>
              </button>
            ))}
          </div>
          {/* Fade edges */}
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 20, pointerEvents: 'none', background: 'linear-gradient(to left, transparent, #fff)' }} />
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 32, pointerEvents: 'none', background: 'linear-gradient(to right, transparent, #fff)' }} />
        </div>
        <style>{`.order-tab-scroll::-webkit-scrollbar { display: none; }`}</style>
      </div>{/* end workflow header */}

      {/* ── MAIN ───────────────────────────────────────────────────────────── */}
      <main className="order-main" style={{ maxWidth: '860px', margin: '0 auto', padding: '20px 16px', width: '100%', boxSizing: 'border-box' }}>

        {/* ═══════════════════════════════════════════════════
            TAB: INFO
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'info' && (<>

          {/* Batch delivery warning banner */}
          {batchWarning && (
            <div style={{ background: '#fffbeb', border: '1.5px solid #fcd34d', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <span style={{ fontSize: '16px', flexShrink: 0 }}>⚠️</span>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#92400e', marginBottom: '3px' }}>
                  This order should use batch delivery
                </div>
                <div style={{ fontSize: '12px', color: '#b45309', lineHeight: 1.5 }}>
                  {contractTotal >= 500000 && totalQty >= 100
                    ? `Contract value (${fmtKES(contractTotal)}) and item count (${totalQty} units) both exceed batch delivery thresholds (KES 500k / 100 units).`
                    : contractTotal >= 500000
                    ? `Contract value (${fmtKES(contractTotal)}) exceeds the KES 500,000 batch delivery threshold.`
                    : `Total item count (${totalQty} units) exceeds the 100-unit batch delivery threshold.`}
                  {' '}Use the <strong>Enable Batch Delivery</strong> button in the General Info card below to unlock the fulfilment planner.
                </div>
              </div>
            </div>
          )}

          {/* Order + Client cards */}
          <div className="order-info-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
            <div className="order-card" style={card}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#111', textTransform: 'uppercase', marginBottom: '16px' }}>General info</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div><div style={fieldLabel}>Order date</div><div style={fieldValue}>{fmtDate(order.created_at)}</div></div>
                <div>
                  <div style={fieldLabel}>Due date</div>
                  {editMode ? (
                    <input type="date" value={editedDueDate} onChange={e => setEditedDueDate(e.target.value)} style={{ fontSize: '13px', padding: '4px 8px', border: '1.5px solid #e5e7eb', borderRadius: '6px' }} />
                  ) : (
                    <div style={fieldValue}>{fmtDate(order.due_date)}</div>
                  )}
                </div>
                <div><div style={fieldLabel}>Status</div><div style={fieldValue}>{order.status}</div></div>
                <div><div style={fieldLabel}>Payment terms</div><div style={fieldValue}>{order.payment_terms || '-'}</div></div>
                {order.quote_number && <div><div style={fieldLabel}>Quote #</div><div style={fieldValue}>{order.quote_number}</div></div>}
                {order.invoice_number && <div><div style={fieldLabel}>Invoice #</div><div style={fieldValue}>{order.invoice_number}</div></div>}
                {order.batch_delivery ? (
                  <div style={{ gridColumn: '1/-1' }}>
                    <div style={{ display: 'inline-block', background: '#dcfce7', color: '#166534', fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px' }}>✓ Batch delivery</div>
                  </div>
                ) : canToggleBatch && batchEligible && (
                  <div style={{ gridColumn: '1/-1' }}>
                    {!batchConfirm ? (
                      <button
                        onClick={() => setBatchConfirm(true)}
                        style={{ fontSize: '12px', fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1.5px solid #fcd34d', padding: '5px 14px', borderRadius: '6px', cursor: 'pointer' }}
                      >
                        ⚡ Enable Batch Delivery
                      </button>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: '#fffbeb', border: '1.5px solid #fcd34d', borderRadius: '7px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12px', color: '#92400e', flex: '1 1 200px' }}>
                          ⚠ Once enabled, batch delivery cannot be turned off. Confirm?
                        </span>
                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          <button
                            onClick={enableBatchDelivery}
                            disabled={enablingBatch}
                            style={{ padding: '5px 16px', borderRadius: '5px', border: 'none', background: '#f59e0b', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer', opacity: enablingBatch ? 0.6 : 1 }}
                          >
                            {enablingBatch ? '...' : 'Enable'}
                          </button>
                          <button
                            onClick={() => setBatchConfirm(false)}
                            style={{ padding: '5px 12px', borderRadius: '5px', border: '1px solid #d1d5db', background: '#fff', color: '#6b7280', fontSize: '12px', cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {isCredit && <div style={{ gridColumn: '1/-1' }}><div style={{ display: 'inline-block', background: '#EDE7F6', color: '#512DA8', fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '4px' }}>Credit client</div></div>}
              </div>
            </div>

            <div className="order-card" style={card}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#111', textTransform: 'uppercase', marginBottom: '16px' }}>Client</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div><div style={fieldLabel}>Company</div><div style={fieldValue}>{order.client}</div></div>
                {order.contact_person && <div><div style={fieldLabel}>Contact person</div><div style={fieldValue}>{order.contact_person}</div></div>}
                {order.author && <div><div style={fieldLabel}>Sales rep</div><div style={fieldValue}>{order.author}</div></div>}
                {order.customer_type && <div><div style={fieldLabel}>Customer type</div><div style={fieldValue}>{order.customer_type}</div></div>}

                {/* Customer profile link */}
                <div>
                  <div style={fieldLabel}>Customer profile</div>
                  {order.customer_id ? (
                    <div className="customer-profile-row" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
                      <Link href={`/customers/${order.customer_id}`} className="customer-profile-link" style={{ fontSize: '13px', color: '#E8512A', fontWeight: 600, textDecoration: 'none', minWidth: 0, overflowWrap: 'anywhere' }}>
                        {order._customer?.name || order.client} ↗
                      </Link>
                      {['admin', 'head_of_sales', 'production_manager', 'sales'].includes(userRole) && (
                        <button onClick={() => { setCustomerSearch(''); setShowLinkCustomer(true); }} style={{ fontSize: '11px', color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', minHeight: 44, flexShrink: 0 }}>
                          Change
                        </button>
                      )}
                    </div>
                  ) : (
                    ['admin', 'head_of_sales', 'production_manager', 'sales'].includes(userRole) ? (
                      <button onClick={() => { setCustomerSearch(''); setShowLinkCustomer(true); }} style={{ fontSize: '12px', color: '#E8512A', background: '#fff7f5', border: '1px dashed #E8512A', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontWeight: 600 }}>
                        + Link to customer profile
                      </button>
                    ) : (
                      <div style={fieldValue}>Not linked</div>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Link customer modal */}
            {showLinkCustomer && (
              <Modal title="Link to Customer Profile" onClose={() => setShowLinkCustomer(false)}>
                <div style={{ padding: '20px' }}>
                  <input
                    autoFocus
                    placeholder="Search by name, contact, or phone…"
                    value={customerSearch}
                    onChange={e => setCustomerSearch(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', boxSizing: 'border-box', marginBottom: '12px' }}
                  />
                  {customerSearching && <div style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'center', padding: '8px' }}>Searching…</div>}
                  <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {customerResults.map(c => (
                      <button
                        key={c.id}
                        disabled={linkingCustomer}
                        onClick={() => linkCustomerToOrder(c)}
                        style={{ textAlign: 'left', padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: '7px', background: order.customer_id === c.id ? '#fff7f5' : '#fafafa', cursor: 'pointer', width: '100%' }}
                      >
                        <div style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a1a' }}>{c.name}</div>
                        {c.contact_person && <div style={{ fontSize: '11px', color: '#6b7280' }}>{c.contact_person}{c.phone ? ` · ${c.phone}` : ''}</div>}
                      </button>
                    ))}
                    {!customerSearching && customerResults.length === 0 && (
                      <div style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'center', padding: '16px' }}>
                        {customerSearch ? 'No customers found' : 'Type to search customers'}
                      </div>
                    )}
                  </div>
                </div>
              </Modal>
            )}
          </div>

          {/* Line Items */}
          <div style={{ marginBottom: '24px' }}>
            <div style={sectionLabel}>📦 Line items</div>
            <div className={`order-items-desktop${editMode ? ' order-items-edit-active' : ''}`} style={{ ...card, padding: '0', overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb', background: '#f9fafb' }}>
                      <th style={{ textAlign: 'left', padding: '10px 14px', fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', width: '22%' }}>Category</th>
                      <th style={{ textAlign: 'left', padding: '10px 14px', fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Size / Spec</th>
                      <th style={{ textAlign: 'right', padding: '10px 14px', fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', width: '60px' }}>Qty</th>
                      <th style={{ textAlign: 'right', padding: '10px 14px', fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', width: '120px' }}>Unit price</th>
                      <th style={{ textAlign: 'right', padding: '10px 14px', fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', width: '110px' }}>Total</th>
                      {editMode && canEditItems && <th style={{ width: '36px' }} />}
                    </tr>
                  </thead>
                  <tbody>
                    {displayItems.length === 0 ? (
                      <tr>
                        <td colSpan={editMode && canEditItems ? 6 : 5} style={{ padding: '28px', textAlign: 'center', color: '#9ca3af' }}>No items</td>
                      </tr>
                    ) : displayItems.map(item => {
                      const key = item.id || item._id;
                      const isCharge = isChargeItem(item);
                      const rowTotal = isCharge
                        ? (parseFloat(item.unit_price) || 0)
                        : (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
                      return (
                        <tr key={key} style={{ borderBottom: '1px solid #f3f4f6', background: isCharge ? '#fafff9' : undefined }}>
                          <td style={{ padding: '10px 14px' }}>
                            {editMode && canEditItems ? (
                              <select value={item.category} onChange={e => { updItem(key, 'category', e.target.value); if (isChargeItem({ category: e.target.value })) updItem(key, 'description', e.target.value); }} style={{ width: '100%', padding: '5px 7px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '12px', background: '#fff' }}>
                                {isCharge ? (CHARGE_TYPES || []).map(t => <option key={t}>{t}</option>) : CATEGORIES.map(c => <option key={c}>{c}</option>)}
                              </select>
                            ) : (
                              <span style={{ fontWeight: 600, color: isCharge ? '#6b7280' : '#111' }}>
                                {item.category}
                                {isCharge && <span style={{ marginLeft: '6px', fontSize: '9px', background: '#EDE9FE', color: '#7C3AED', padding: '1px 5px', borderRadius: '3px', fontWeight: 700 }}>charge</span>}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '10px 14px' }}>
                            {isCharge ? <span style={{ fontSize: '12px', color: '#9ca3af' }}>—</span>
                              : editMode && canEditItems ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                  <input type="text" value={item.size || ''} placeholder="Size (e.g. 60×90cm)"
                                    onChange={e => updItem(key, 'size', e.target.value)}
                                    style={{ width: '100%', padding: '5px 7px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '12px', boxSizing: 'border-box' }} />
                                  <div style={{ display: 'flex', gap: '5px' }}>
                                    <select value={item.finish_type || 'None'}
                                      onChange={e => updItem(key, 'finish_type', e.target.value)}
                                      style={{ flex: 1, padding: '5px 6px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '11px', background: '#fff' }}>
                                      {FINISH_TYPES.map(f => <option key={f}>{f}</option>)}
                                    </select>
                                    <input type="text" value={item.finish_color || ''} placeholder="Color"
                                      onChange={e => updItem(key, 'finish_color', e.target.value)}
                                      style={{ flex: 1, padding: '5px 7px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '11px', boxSizing: 'border-box' }} />
                                  </div>
                                  <select value={item.wood_type || ''}
                                    onChange={e => updItem(key, 'wood_type', e.target.value)}
                                    style={{ width: '100%', padding: '5px 6px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '11px', background: '#fff' }}>
                                    <option value="">— Wood type —</option>
                                    {WOOD_TYPES.map(w => <option key={w}>{w}</option>)}
                                  </select>
                                  <input type="text" value={item.description || ''} placeholder="Description / notes"
                                    onChange={e => updItem(key, 'description', e.target.value)}
                                    style={{ width: '100%', padding: '5px 7px', border: '1.5px solid #e0e0e0', borderRadius: '6px', fontSize: '11px', boxSizing: 'border-box' }} />
                                </div>
                              ) : (
                                <span style={{ color: '#6b7280', fontSize: '12px' }}>{itemSpec(item)}</span>
                              )}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {isCharge ? <span style={{ color: '#9ca3af', fontFamily: 'monospace' }}>—</span>
                              : editMode ? (
                                <input type="number" min="1" value={item.quantity} onChange={e => updItem(key, 'quantity', parseInt(e.target.value) || 1)} style={{ width: '52px', padding: '5px 6px', border: '1.5px solid #e5e7eb', borderRadius: '6px', textAlign: 'right', fontSize: '12px' }} />
                              ) : (
                                <span style={{ fontFamily: 'monospace' }}>{item.quantity}</span>
                              )}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {editMode && canEditItems ? (
                              <input type="number" min="0" value={item.unit_price} onChange={e => updItem(key, 'unit_price', e.target.value)} style={{ width: '90px', padding: '5px 6px', border: '1.5px solid #e5e7eb', borderRadius: '6px', textAlign: 'right', fontSize: '12px' }} />
                            ) : (
                              <span style={{ fontFamily: 'monospace' }}>{fmtKES(item.unit_price)}</span>
                            )}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#374151' }}>{fmtKES(rowTotal)}</td>
                          {editMode && canEditItems && (
                            <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                              <button onClick={() => delItem(item)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '17px', lineHeight: 1, padding: '0 4px' }}>×</button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {itemsSubtotal > 0 && (
                      <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                        <td colSpan={editMode && canEditItems ? 4 : 3} style={{ padding: '8px 14px', textAlign: 'right', fontSize: '11px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Items</td>
                        <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: '12px', color: '#374151' }}>{fmtKES(itemsSubtotal)}</td>
                        {editMode && canEditItems && <td />}
                      </tr>
                    )}
                    {chargesSubtotal > 0 && (
                      <tr style={{ background: '#f9fafb' }}>
                        <td colSpan={editMode && canEditItems ? 4 : 3} style={{ padding: '4px 14px', textAlign: 'right', fontSize: '11px', color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Charges</td>
                        <td style={{ padding: '4px 14px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, fontSize: '12px', color: '#374151' }}>{fmtKES(chargesSubtotal)}</td>
                        {editMode && canEditItems && <td />}
                      </tr>
                    )}
                    {editMode && canEditItems && (
                      <tr style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td colSpan={6} style={{ padding: '10px 14px' }}>
                          <button onClick={addItem} style={{ fontSize: '12px', color: '#E8512A', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', marginRight: '20px' }}>+ Add item</button>
                          <button onClick={addCharge} style={{ fontSize: '12px', color: '#7C3AED', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>+ Add charge</button>
                        </td>
                      </tr>
                    )}
                    {editMode && canEditItems && contractTotal > 0 && (
                      <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                        <td colSpan={4} style={{ padding: '10px 14px', textAlign: 'right', fontSize: '12px', fontWeight: 700, color: '#15803d' }}>Contract total</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: '15px', fontWeight: 800, color: '#15803d' }}>KES {contractTotal.toLocaleString()}</td>
                        <td />
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Mobile item cards — hidden on desktop, hidden in edit mode */}
            {!editMode && (
              <div className="order-items-mobile">
                {displayItems.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', background: '#fff', borderRadius: '10px', border: '1px solid #e5e7eb' }}>No items</div>
                ) : displayItems.map(item => {
                  const key = item.id || item._id;
                  const isCharge = isChargeItem(item);
                  const rowTotal = isCharge
                    ? (parseFloat(item.unit_price) || 0)
                    : (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
                  return (
                    <div key={key} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 700, color: isCharge ? '#6b7280' : '#111' }}>{item.category}</span>
                        {isCharge && <span style={{ fontSize: '9px', background: '#EDE9FE', color: '#7C3AED', padding: '2px 6px', borderRadius: '3px', fontWeight: 700 }}>charge</span>}
                      </div>
                      {!isCharge && itemSpec(item) && (
                        <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '10px', lineHeight: 1.5 }}>{itemSpec(item)}</div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
                        {!isCharge && (
                          <>
                            <div><div style={{ fontSize: '9px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '2px' }}>Quantity</div><div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.quantity}</div></div>
                            <div><div style={{ fontSize: '9px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '2px' }}>Unit price</div><div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{fmtKES(item.unit_price)}</div></div>
                          </>
                        )}
                        <div style={{ gridColumn: isCharge ? '1 / -1' : undefined }}>
                          <div style={{ fontSize: '9px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '2px' }}>Total</div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '15px', color: '#111' }}>{fmtKES(rowTotal)}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {/* Totals card */}
                {displayItems.length > 0 && (
                  <div style={{ background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: '10px', padding: '14px 16px' }}>
                    {itemsSubtotal > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px', color: '#374151' }}>
                        <span>Items subtotal</span><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmtKES(itemsSubtotal)}</span>
                      </div>
                    )}
                    {chargesSubtotal > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px', color: '#374151' }}>
                        <span>Charges</span><span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{fmtKES(chargesSubtotal)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: 800, color: '#15803d', borderTop: contractTotal > 0 && (itemsSubtotal > 0 || chargesSubtotal > 0) ? '1px solid #86efac' : undefined, paddingTop: contractTotal > 0 ? '8px' : undefined, marginTop: contractTotal > 0 ? '4px' : undefined }}>
                      <span>Contract total</span><span style={{ fontFamily: 'monospace' }}>{fmtKES(contractTotal)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Order Notes */}
          {(order.notes || editMode) && (
            <div style={{ marginBottom: '24px' }}>
              <div style={sectionLabel}>📋 Order notes</div>
              <div className="order-card" style={card}>
                {editMode ? (
                  <textarea value={editedNotes} onChange={e => setEditedNotes(e.target.value)} rows={3}
                    placeholder="Internal order notes..."
                    style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: '8px', fontSize: '13px', resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                  />
                ) : (
                  <p style={{ fontSize: '13px', color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap', margin: 0 }}>{order.notes}</p>
              )}
            </div>
          </div>
        )}

        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: PAYMENTS
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'payments' && (<>
          <div style={sectionLabel}>💰 Financial summary</div>
          <div className="order-card" style={{ ...card, marginBottom: '24px' }}>
            <PaymentPanel
              orderId={id}
              contractTotal={contractTotal}
              itemsSubtotal={itemsSubtotal}
              chargeItems={displayItems.filter(i => isChargeItem(i))}
              userRole={userRole}
              orderStatus={order.status}
              payments={payments}
              setPayments={setPayments}
              readOnly={isSuspended}
            />
          </div>
          <div style={sectionLabel}>💬 Notes</div>
          <div className="order-card" style={card}><NotesThread orderId={id} /></div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: P&L
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'pnl' && (<>
          <div style={sectionLabel}>📊 Project P&amp;L</div>
          <div className="order-card" style={card}>
            <PnLTab
              orderId={id}
              orderNum={order?.order_num || id}
              contractTotal={contractTotal}
              itemsSubtotal={itemsSubtotal}
              chargeItems={displayItems.filter(i => isChargeItem(i))}
              payments={payments}
              userRole={userRole}
            />
          </div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: DELIVERY
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'delivery' && (
          <DeliveryTab
            orderId={id}
            order={order}
            userRole={userRole}
            onUpdate={refreshOrder}
            readOnly={isSuspended}
          />
        )}

        {/* ═══════════════════════════════════════════════════
            TAB: FILES (drawings)
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'drawings' && (<>
          <div style={sectionLabel}>📐 Files & drawings</div>
          <div className="order-card" style={card}><AttachmentsPanel orderId={id} userRole={userRole} readOnly={isSuspended} /></div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: ACTIVITY
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'activity' && (<>
          <div style={sectionLabel}>🕐 Activity log</div>
          <div className="order-card" style={card}><ActivityLog orderId={id} /></div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: DANGER ZONE (admin only)
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'danger' && userRole === 'admin' && (<>
          <div style={sectionLabel}>⚠ Danger Zone</div>
          <DangerZoneTab
            orderId={id}
            orderNum={order?.order_num}
            onSuspended={async () => {
              // Refresh suspension fields in header without full page reload
              const { data } = await supabase
                .from('orders')
                .select('suspended_at, suspension_reason')
                .eq('id', id)
                .single();
              if (data) setOrder(o => ({ ...o, ...data }));
            }}
            onDeleted={() => {
              window.location.href = '/orders';
            }}
          />
        </>)}

      </main>

      {/* ── MODALS ─────────────────────────────────────────────────────────── */}

      {/* Quote Confirm */}
      {modal === 'quote' && (
        <Modal title="Confirm Quote" onClose={() => setModal(null)}>
          <p style={{ fontSize: '13px', color: '#374151', marginBottom: '16px' }}>
            Enter the quote number to advance this order to <strong>Quote Approved</strong>.
          </p>
          <div style={{ marginBottom: '14px' }}>
            <label style={lbl}>Quote Number *</label>
            <input type="text" value={quoteNum} onChange={e => setQuoteNum(e.target.value)} placeholder="e.g. QT-001234" style={inpStyle} autoFocus />
          </div>
          {actionError && <p style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px' }}>⚠ {actionError}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setModal(null)} style={{ padding: '9px 18px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={confirmQuote} disabled={advancing || !quoteNum.trim()} style={{ padding: '9px 18px', borderRadius: '7px', border: 'none', background: quoteNum.trim() ? '#16a34a' : '#e0e0e0', color: quoteNum.trim() ? '#fff' : '#aaa', fontWeight: 700, fontSize: '13px', cursor: quoteNum.trim() ? 'pointer' : 'default' }}>
              {advancing ? '...' : 'Confirm → Quote Approved'}
            </button>
          </div>
        </Modal>
      )}

      {/* Credit Approval */}
      {modal === 'credit' && (
        <Modal title="Credit Approval Required" onClose={() => setModal(null)}>
          <div style={{ padding: '12px 14px', background: '#EDE7F6', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', color: '#512DA8' }}>
            <strong>{order.client}</strong> is a credit client ({order.payment_terms}). Deposit Paid step will be bypassed. This order goes directly to Material Check.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '14px' }}>
            <div style={{ padding: '10px 14px', background: '#f9fafb', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>Credit Limit</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800 }}>KES {creditLimit.toLocaleString()}</div>
            </div>
            <div style={{ padding: '10px 14px', background: '#f9fafb', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>Current Exposure</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800 }}>KES {creditExposure.toLocaleString()}</div>
            </div>
            <div style={{ padding: '10px 14px', background: '#fffbeb', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>This Order</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800 }}>KES {contractTotal.toLocaleString()}</div>
            </div>
            <div style={{ padding: '10px 14px', background: creditLimit > 0 && (creditExposure + contractTotal) > creditLimit ? '#fee2e2' : '#dcfce7', borderRadius: '8px' }}>
              <div style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>New Exposure</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800 }}>KES {(creditExposure + contractTotal).toLocaleString()}</div>
            </div>
          </div>
          {userRole === 'head_of_sales' && contractTotal > HEAD_OF_SALES_CREDIT_LIMIT && (
            <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: '8px', marginBottom: '14px', fontSize: '12px', color: '#dc2626' }}>
              This order exceeds your KES {HEAD_OF_SALES_CREDIT_LIMIT.toLocaleString()} approval limit. Only Admin can approve.
            </div>
          )}
          <div style={{ marginBottom: '14px' }}>
            <label style={lbl}>Approval Reference *</label>
            <input type="text" value={creditRef} onChange={e => setCreditRef(e.target.value)} placeholder="Credit approval ref or authoriser name" style={inpStyle} autoFocus />
          </div>
          {actionError && <p style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px' }}>⚠ {actionError}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setModal(null)} style={{ padding: '9px 18px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={confirmCredit} disabled={advancing || !creditRef.trim() || (userRole === 'head_of_sales' && contractTotal > HEAD_OF_SALES_CREDIT_LIMIT)} style={{ padding: '9px 18px', borderRadius: '7px', border: 'none', background: creditRef.trim() ? '#512DA8' : '#e0e0e0', color: creditRef.trim() ? '#fff' : '#aaa', fontWeight: 700, fontSize: '13px', cursor: creditRef.trim() ? 'pointer' : 'default' }}>
              {advancing ? '...' : '→ Approve & Send to Material Check'}
            </button>
          </div>
        </Modal>
      )}

      {/* Rework / Send Back */}
      {modal === 'rework' && (
        <Modal title={`Send Back to ${reworkTarget}`} onClose={() => setModal(null)}>
          <p style={{ fontSize: '13px', color: '#374151', marginBottom: '16px' }}>
            This will move the order from <strong>{order.status}</strong> back to <strong>{reworkTarget}</strong>.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label style={lbl}>Reason *</label>
              <select value={reworkReason} onChange={e => setReworkReason(e.target.value)} style={inpStyle}>
                {REWORK_REASONS.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Authorized By *</label>
              <input type="text" value={reworkAuth} onChange={e => setReworkAuth(e.target.value)} placeholder="Name of person authorizing this" style={inpStyle} autoFocus />
            </div>
            <div>
              <label style={lbl}>Additional Notes</label>
              <textarea value={reworkNotes} onChange={e => setReworkNotes(e.target.value)} rows={2} placeholder="What needs to be fixed?" style={{ ...inpStyle, resize: 'vertical' }} />
            </div>
          </div>
          {actionError && <p style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px' }}>⚠ {actionError}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setModal(null)} style={{ padding: '9px 18px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={confirmRework} disabled={advancing || !reworkAuth.trim()} style={{ padding: '9px 18px', borderRadius: '7px', border: 'none', background: reworkAuth.trim() ? '#f59e0b' : '#e0e0e0', color: reworkAuth.trim() ? '#fff' : '#aaa', fontWeight: 700, fontSize: '13px', cursor: reworkAuth.trim() ? 'pointer' : 'default' }}>
              {advancing ? '...' : `↩ Send Back to ${reworkTarget}`}
            </button>
          </div>
        </Modal>
      )}

      {/* Full Refund */}
      {modal === 'refund' && (
        <Modal title="Issue Full Refund" onClose={() => setModal(null)}>
          <div style={{ padding: '12px 14px', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', color: '#9f1239' }}>
            ⚠ This will mark the order as <strong>Cancelled / Refunded</strong>. This action is permanent.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label style={lbl}>Refund Reference Number *</label>
              <input type="text" value={refundRef} onChange={e => setRefundRef(e.target.value)} placeholder="e.g. MPESA reference, bank ref" style={inpStyle} autoFocus />
            </div>
            <div>
              <label style={lbl}>Notes</label>
              <textarea value={refundNotes} onChange={e => setRefundNotes(e.target.value)} rows={2} placeholder="Reason for refund..." style={{ ...inpStyle, resize: 'vertical' }} />
            </div>
          </div>
          {actionError && <p style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px' }}>⚠ {actionError}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setModal(null)} style={{ padding: '9px 18px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={confirmRefund} disabled={advancing || !refundRef.trim()} style={{ padding: '9px 18px', borderRadius: '7px', border: 'none', background: refundRef.trim() ? '#f43f5e' : '#e0e0e0', color: refundRef.trim() ? '#fff' : '#aaa', fontWeight: 700, fontSize: '13px', cursor: refundRef.trim() ? 'pointer' : 'default' }}>
              {advancing ? '...' : '💸 Issue Full Refund'}
            </button>
          </div>
        </Modal>
      )}

      {/* Repair / Return */}
      {modal === 'repair' && (
        <Modal title="Create Repair / Return Order" onClose={() => setModal(null)}>
          <p style={{ fontSize: '13px', color: '#374151', marginBottom: '16px' }}>
            A new linked order will be created and you'll be redirected to it.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
            <div>
              <label style={lbl}>Type *</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {['repair', 'return'].map(t => (
                  <button key={t} type="button" onClick={() => setRepairType(t)} style={{
                    flex: 1, padding: '9px', borderRadius: '7px', cursor: 'pointer',
                    border: `2px solid ${repairType === t ? '#8b5cf6' : '#e0e0e0'}`,
                    background: repairType === t ? '#f5f3ff' : '#fff',
                    color: repairType === t ? '#8b5cf6' : '#6b7280',
                    fontWeight: 700, fontSize: '13px', textTransform: 'capitalize',
                  }}>{t === 'repair' ? '🔧 Repair' : '↩ Return'}</button>
                ))}
              </div>
            </div>
            <div>
              <label style={lbl}>Reason *</label>
              <select value={repairReason} onChange={e => setRepairReason(e.target.value)} style={inpStyle}>
                {REPAIR_REASONS.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Description *</label>
              <textarea value={repairDesc} onChange={e => setRepairDesc(e.target.value)} rows={3} placeholder="Describe the issue in detail..." style={{ ...inpStyle, resize: 'vertical' }} />
            </div>
            <div>
              <label style={lbl}>Estimated Cost (KES)</label>
              <input type="number" min="0" value={repairCost} onChange={e => setRepairCost(e.target.value)} placeholder="0" style={inpStyle} />
            </div>
          </div>
          {actionError && <p style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px' }}>⚠ {actionError}</p>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button onClick={() => setModal(null)} style={{ padding: '9px 18px', borderRadius: '7px', border: '1px solid #e0e0e0', background: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={confirmRepair} disabled={advancing || !repairDesc.trim()} style={{ padding: '9px 18px', borderRadius: '7px', border: 'none', background: repairDesc.trim() ? '#8b5cf6' : '#e0e0e0', color: repairDesc.trim() ? '#fff' : '#aaa', fontWeight: 700, fontSize: '13px', cursor: repairDesc.trim() ? 'pointer' : 'default' }}>
              {advancing ? 'Creating...' : `🔧 Create ${repairType === 'repair' ? 'Repair' : 'Return'} Order`}
            </button>
          </div>
        </Modal>
      )}

      <style>{`
        @media print {
          .print-hidden { display: none !important; }
          .print-hidden-header { position: static !important; background: #fff !important; color: #000 !important; border-bottom: 2px solid #111 !important; }
          .order-tab-bar { display: none !important; }
          body { background: white; }
          main { padding: 0.5in; max-width: 100%; }
          button { display: none !important; }
        }

        /* ── Order page containment ─────────────────── */
        .order-page { width: 100%; max-width: 100%; min-width: 0; overflow-x: hidden; box-sizing: border-box; }

        /* ── Desktop: full header sticky ───────────── */
        .order-workflow-header { position: sticky; top: 0; z-index: 10; }

        /* ── Desktop: hide mobile items ────────────── */
        .order-items-mobile { display: none; }

        /* ── Desktop: hide mobile-only controls ───── */
        .order-more-btn { display: none; }

        /* ── Tab scroll: hide scrollbar ────────────── */
        .order-tab-scroll::-webkit-scrollbar { display: none; }
        .order-tab-scroll { scrollbar-width: none; -ms-overflow-style: none; }

        /* ═══════ MOBILE (max-width: 700px) ═══════ */
        @media (max-width: 700px) {
          .order-main { padding: 14px 12px 32px !important; }

          /* Un-sticky workflow header; tab bar becomes sticky */
          .order-workflow-header { position: static !important; }
          .order-tabs-sticky {
            position: sticky !important; top: 0 !important; z-index: 20 !important;
            background: #fff; border-bottom: 1px solid #e5e7eb;
          }

          /* Header row 1: print button hidden, ⋯ shown */
          .order-print-btn { display: none !important; }
          .order-more-btn { display: flex !important; align-items: center; justify-content: center; }
          .order-header-btn { min-height: 44px !important; }

          /* Workflow row: grid layout with status spanning full width */
          .order-workflow-row {
            display: grid !important;
            grid-template-areas: "status status" "back next" !important;
            grid-template-columns: 1fr 1fr !important;
            gap: 8px !important;
            padding: 8px 14px 12px !important;
          }
          .order-workflow-back { grid-area: back; }
          .order-workflow-status { grid-area: status; text-align: center !important; }
          .order-workflow-next { grid-area: next; }
          .order-workflow-back button, .order-workflow-next button {
            width: 100%; min-height: 44px !important;
          }

          /* Info grid: single column */
          .order-info-grid { grid-template-columns: 1fr !important; }

          /* Line items: hide table, show cards */
          .order-items-desktop { display: none !important; }
          .order-items-desktop.order-items-edit-active { display: block !important; }
          .order-items-mobile { display: flex; flex-direction: column; gap: 10px; }

          /* Payment summary */
          .payment-summary-grid { grid-template-columns: 1fr 1fr !important; }
          .payment-contract-total { grid-column: 1 / -1 !important; text-align: center; }
          .payment-summary-value { font-size: clamp(18px, 5vw, 24px) !important; overflow-wrap: anywhere; }

          /* P&L KPI grid */
          .pnl-kpi-grid { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; flex-wrap: unset !important; }
          .pnl-kpi-card { flex: unset !important; }
          .pnl-kpi-value { font-size: clamp(16px, 5vw, 22px) !important; overflow-wrap: anywhere; }

          /* P&L controls */
          .pnl-controls { flex-direction: column !important; align-items: stretch !important; }
          .pnl-tabs-row { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
          .pnl-tabs-row button { min-height: 44px !important; white-space: normal !important; text-align: center; }
          .pnl-export-btn { width: 100% !important; min-height: 44px !important; margin-top: 4px; }

          /* Add payment form */
          .payment-add-form { flex-direction: column !important; }
          .payment-add-form > div { flex: 1 1 auto !important; width: 100% !important; max-width: 100% !important; }
          .payment-add-btn { width: 100% !important; min-height: 44px !important; }

          /* Notes */
          .notes-input-row { flex-direction: column !important; }
          .notes-post-btn { width: 100% !important; min-height: 44px !important; padding: 12px !important; }

          /* Customer profile */
          .customer-profile-row { flex-wrap: wrap !important; }
          .customer-profile-link { min-width: 0; overflow-wrap: anywhere; }

          /* Card padding */
          .order-card { padding: 14px 16px !important; }
        }

        /* Hide text labels on very narrow screens — icons stay */
        @media (max-width: 380px) {
          .tab-label { display: none !important; }
        }
      `}</style>
    </div>
  );
}
