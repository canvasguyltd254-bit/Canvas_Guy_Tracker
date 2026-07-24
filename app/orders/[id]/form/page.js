'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/shared/supabase/client';
import { DrawingsUpload } from '@/modules/orders/components/DrawingsUpload';
import DeliveryTab from '@/modules/orders/components/DeliveryTab';
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
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          ref={inputRef} type="text" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }}
          placeholder="Add a note... (Enter to post)"
          style={{ flex: 1, padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', background: '#fafafa' }}
        />
        <button onClick={addNote} disabled={!text.trim() || posting} style={{
          padding: '9px 18px', borderRadius: '7px', border: 'none',
          background: text.trim() && !posting ? '#1a1a1a' : '#e0e0e0',
          color: text.trim() && !posting ? '#fff' : '#aaa',
          fontWeight: 700, fontSize: '13px', cursor: text.trim() ? 'pointer' : 'default', whiteSpace: 'nowrap',
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

function AttachmentsPanel({ orderId, userRole }) {
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

  const canUpload = UPLOAD_ROLES.includes(userRole);
  const canDelete = DELETE_ROLES.includes(userRole);

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
const CAN_DELETE_PAYMENT = ['admin', 'head_of_sales'];

function PaymentPanel({ orderId, contractTotal, itemsSubtotal, chargeItems, userRole, orderStatus, payments, setPayments }) {
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

  const totalPaid      = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const rawBalance     = (contractTotal || 0) - totalPaid;
  const balance        = Math.max(rawBalance, 0);
  const isOverpaid     = rawBalance < -0.01;
  const pct            = contractTotal > 0 ? Math.min(Math.round((totalPaid / contractTotal) * 100), 100) : 0;
  const canAdd         = CAN_ADD_PAYMENT.includes(userRole) && orderStatus !== 'Closed';
  const canDelete      = CAN_DELETE_PAYMENT.includes(userRole);
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to add payment');
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
    setDeleteLoading(true);
    setDeleteError('');
    setPayments(prev => prev.filter(x => x.id !== p.id));
    setPendingDelete(null);
    setDeleteReason('');
    try {
      const res = await fetch(`/api/orders/${orderId}/payments?payment_id=${p.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to delete payment');
      }
    } catch (err) {
      setDeleteError(err.message);
      await loadPayments();
    }
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', textAlign: 'center', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Contract Total</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', color: '#111' }}>{fmtKES(contractTotal)}</div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Paid</div>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', color: '#16a34a' }}>{fmtKES(totalPaid)}</div>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: '#E8512A', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px' }}>Balance Due</div>
            <div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'monospace', color: balance > 0 ? '#E8512A' : '#16a34a' }}>
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
          {payments.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: '#fff', border: '1px solid #e8e8e5', borderRadius: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: '#16a34a', fontFamily: 'monospace', minWidth: '100px' }}>KES {parseFloat(p.amount).toLocaleString('en-KE')}</span>
              <span style={{ flex: 1, fontSize: '13px', color: '#374151', minWidth: '80px' }}>{p.description}</span>
              <span style={{ fontSize: '11px', color: '#9ca3af' }}>{fmtDate(p.payment_date)}</span>
              {canDelete && (
                <button onClick={() => deletePayment(p)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '13px', fontWeight: 700, padding: '0 4px' }} title="Delete">×</button>
              )}
            </div>
          ))}
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
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
            <button onClick={addPayment} disabled={!amt || !desc.trim() || adding} style={{
              padding: '9px 18px', borderRadius: '7px', border: 'none',
              background: amt && desc.trim() && !adding ? '#16a34a' : '#e0e0e0',
              color: amt && desc.trim() && !adding ? '#fff' : '#aaa',
              fontWeight: 700, fontSize: '13px', cursor: amt && desc.trim() ? 'pointer' : 'default',
              whiteSpace: 'nowrap', flex: '0 0 auto',
            }}>
              {adding ? '...' : '+ Add'}
            </button>
          </div>
        </div>
      )}

      {/* ── Delete Payment Modal ── */}
      {pendingDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '28px', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', marginBottom: '4px' }}>Delete Payment</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
              <strong>KES {parseFloat(pendingDelete.amount).toLocaleString('en-KE')}</strong>
              {pendingDelete.payment_method ? ` · ${pendingDelete.payment_method}` : ''}
              {pendingDelete.description ? ` · ${pendingDelete.description}` : ''}
            </div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Reason for deletion <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder="Explain why this payment is being deleted…"
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
                {deleteLoading ? 'Deleting…' : 'Delete Payment'}
              </button>
            </div>
          </div>
        </div>
      )}
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
const PDF_ALLOWED_ROLES = ['admin', 'production_manager', 'head_of_sales'];

function PnLTab({ orderId, contractTotal, itemsSubtotal, chargeItems, payments, userRole }) {
  const [purchases, setPurchases]               = useState([]);
  const [totals, setTotals]                     = useState({ totalCost: 0, totalPaidAP: 0, outstandingAP: 0 });
  const [hasUnallocatedPurchases, setHasUnallocated] = useState(false);
  const [loading, setLoading]                   = useState(true);
  const [fetchError, setFetchError]             = useState(null);
  const [pdfLoading, setPdfLoading]             = useState(false);

  const exportPdf = async () => {
    setPdfLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/pnl/pdf`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'PDF generation failed');
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      const cd   = res.headers.get('content-disposition') || '';
      const match = cd.match(/filename="?([^"]+)"?/);
      a.download  = match ? match[1] : `${orderId}_PnL.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('PDF export failed: ' + err.message);
    }
    setPdfLoading(false);
  };

  useEffect(() => {
    fetch(`/api/orders/${orderId}/pnl`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setPurchases(d.purchases || []);
          setTotals(d.totals || { totalCost: 0, totalPaidAP: 0, outstandingAP: 0 });
          setHasUnallocated(!!d.hasUnallocatedPurchases);
        } else {
          setFetchError(d.error || 'Failed to load P&L data');
        }
        setLoading(false);
      })
      .catch(() => { setFetchError('Failed to load P&L data'); setLoading(false); });
  }, [orderId]);

  const totalPaid   = (payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalCost   = totals.totalCost;
  const grossProfit = contractTotal - totalCost;
  const margin      = contractTotal > 0 ? (grossProfit / contractTotal) * 100 : 0;
  const profitColor = grossProfit >= 0 ? '#16a34a' : '#dc2626';
  const chargesSubtotalLocal = (chargeItems || []).reduce((s, i) => s + (parseFloat(i.unit_price) || 0), 0);
  void chargesSubtotalLocal; // used via chargeItems map below

  const kpiCard = (label, value, color = '#111', sub = null) => (
    <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: '10px', padding: '16px 18px', textAlign: 'center', flex: '1 1 0' }}>
      <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', marginBottom: '6px', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: 'monospace', color }}>{value}</div>
      {sub && <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '4px' }}>{sub}</div>}
    </div>
  );

  if (loading) return <p style={{ fontSize: '13px', color: '#bbb', padding: '24px 0' }}>Loading P&L data...</p>;
  if (fetchError) return <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#dc2626' }}>⚠ {fetchError}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Export button — only for admin, production_manager, head_of_sales */}
      {PDF_ALLOWED_ROLES.includes(userRole) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={exportPdf}
            disabled={pdfLoading}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '7px', border: '1.5px solid #E8512A', background: pdfLoading ? '#f9fafb' : '#fff', color: pdfLoading ? '#aaa' : '#E8512A', fontWeight: 700, fontSize: '13px', cursor: pdfLoading ? 'default' : 'pointer' }}
          >
            {pdfLoading ? 'Generating…' : '↓ Export PDF'}
          </button>
        </div>
      )}

      {/* Unallocated-purchase warning — shown when any linked purchase has no split amounts */}
      {hasUnallocatedPurchases && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: '#92400e', lineHeight: 1.5 }}>
          ⚠ One or more linked purchases have no cost split set. The full purchase amount is shown here, which may overstate costs if the purchase is shared across multiple orders.
          Go to the <strong>Supplier profile → Purchases tab</strong> and click <strong>Edit order links</strong> to allocate amounts.
        </div>
      )}

      {/* KPI row */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {kpiCard('Contract Total', fmtKES(contractTotal))}
        {kpiCard('Total Costs', fmtKES(totalCost), '#E8512A')}
        {kpiCard('Gross Profit', fmtKES(grossProfit), profitColor)}
        {kpiCard('Gross Margin', `${Math.round(margin)}%`, profitColor, grossProfit < 0 ? 'Loss-making' : margin >= 50 ? 'Healthy' : 'Low margin')}
      </div>

      {/* Revenue breakdown */}
      <div style={{ background: '#fff7ed', border: '2px solid #E8512A', borderRadius: '10px', padding: '18px 22px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '12px' }}>Revenue</div>
        <div style={{ fontSize: '13px', color: '#374151' }}>
          {itemsSubtotal > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span>Items subtotal</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(itemsSubtotal).toLocaleString('en-KE')}</span>
            </div>
          )}
          {(chargeItems || []).map((ci, idx) => (
            <div key={ci.id || idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span>{ci.category}</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(parseFloat(ci.unit_price) || 0).toLocaleString('en-KE')}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '1px solid #fbd5b0', paddingTop: '8px', marginTop: '4px', marginBottom: '12px' }}>
            <span>Contract Total</span>
            <span style={{ fontFamily: 'monospace' }}>KES {Math.round(contractTotal).toLocaleString('en-KE')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#16a34a' }}>
            <span>Received from client</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(totalPaid).toLocaleString('en-KE')}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: contractTotal - totalPaid > 0.01 ? '#E8512A' : '#16a34a' }}>
            <span>Outstanding (receivable)</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>KES {Math.round(Math.max(0, contractTotal - totalPaid)).toLocaleString('en-KE')}</span>
          </div>
        </div>
      </div>

      {/* Cost breakdown */}
      <div style={{ background: '#fff', border: '1px solid #e8e8e5', borderRadius: '10px', padding: '18px 22px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '14px' }}>
          Supplier Costs ({purchases.length} purchase{purchases.length !== 1 ? 's' : ''} linked)
        </div>

        {purchases.length === 0 ? (
          <p style={{ fontSize: '13px', color: '#9ca3af', fontStyle: 'italic' }}>
            No supplier costs linked to this order yet. Link purchases from the Suppliers module.
          </p>
        ) : (
          <>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 2fr 110px', gap: '8px', fontSize: '10px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', paddingBottom: '6px', borderBottom: '1px solid #f0ede8' }}>
              <span>Date</span>
              <span>Supplier</span>
              <span>Description</span>
              <span style={{ textAlign: 'right' }}>Amount</span>
            </div>

            {/* Purchase rows */}
            {purchases.map(p => (
              <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 2fr 110px', gap: '8px', fontSize: '13px', color: '#374151', padding: '8px 0', borderBottom: '1px solid #f9f8f6', alignItems: 'start' }}>
                <span style={{ fontSize: '11px', color: '#9ca3af' }}>{fmtDate(p.purchase_date)}</span>
                <span style={{ fontWeight: 600, color: '#111' }}>{p.supplier?.name || '—'}</span>
                <span style={{ color: '#6b7280', fontSize: '12px' }}>{p.items_bought || '—'}</span>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                    KES {Math.round(p.total_amount).toLocaleString('en-KE')}
                  </div>
                  {/* Hint when this is a split allocation, not the full purchase */}
                  {p.allocated_amount != null && p.purchase_total > p.allocated_amount + 0.01 && (
                    <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '1px' }}>
                      of {Math.round(p.purchase_total).toLocaleString('en-KE')} total
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Total row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '14px', paddingTop: '12px', marginTop: '4px', borderTop: '2px solid #e8e8e5' }}>
              <span style={{ color: '#374151' }}>Total Costs</span>
              <span style={{ fontFamily: 'monospace', color: '#E8512A' }}>KES {Math.round(totalCost).toLocaleString('en-KE')}</span>
            </div>

            {/* AP status note */}
            {totals.outstandingAP > 0.01 && (
              <div style={{ marginTop: '10px', fontSize: '12px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '8px 12px' }}>
                ⚠ KES {Math.round(totals.outstandingAP).toLocaleString('en-KE')} still owed to suppliers (outstanding AP)
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom profit summary */}
      {contractTotal > 0 && (
        <div style={{ background: grossProfit >= 0 ? '#f0fdf4' : '#fef2f2', border: `2px solid ${profitColor}`, borderRadius: '10px', padding: '16px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: grossProfit >= 0 ? '#15803d' : '#b91c1c', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>
              {grossProfit >= 0 ? '✓ Gross Profit' : '✗ Gross Loss'}
            </div>
            <div style={{ fontSize: '22px', fontWeight: 900, fontFamily: 'monospace', color: profitColor }}>
              KES {Math.round(Math.abs(grossProfit)).toLocaleString('en-KE')}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: '4px' }}>Gross Margin</div>
            <div style={{ fontSize: '32px', fontWeight: 900, fontFamily: 'monospace', color: profitColor }}>{Math.round(margin)}%</div>
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
  const PRE_PRODUCTION_STATUSES = ['Inquiry', 'Quote Approved', 'Deposit Paid', 'Material Check'];
  const canEditItems = ['admin', 'head_of_sales'].includes(userRole) ||
    (userRole === 'sales' && PRE_PRODUCTION_STATUSES.includes(order?.status));
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
  const canSendBack  = !!reworkTarget && canRework;

  // Full Refund: Quote Approved only, ROLES_CAN_REFUND
  const canFullRefund = order.status === 'Quote Approved' && ROLES_CAN_REFUND.includes(userRole);

  // Repair/Return: Closed only, admin only
  const canRepair = order.status === 'Closed' && userRole === 'admin';

  // Next stage availability
  const isTerminal = order.status === 'Closed' || order.status === 'Redelivered' || order.status === 'Cancelled / Refunded';
  const canAdvance = ROLES_CAN_ADVANCE.includes(userRole) && !isTerminal && !!nextSt;
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
    <div style={{ background: '#f9fafb', minHeight: '100vh' }}>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10 }} className="print-hidden-header">
        <div style={{ background: '#111827', color: '#fff' }}>

        {/* Row 1: Back | Order num · Client · Status | Edit/Save */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid #374151' }} className="print-hidden">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <Link href="/orders" style={{ color: '#9ca3af', fontSize: '12px', fontWeight: 600, textDecoration: 'none', flexShrink: 0 }}>← Orders</Link>
            <div style={{ width: '1px', height: '14px', background: '#374151', flexShrink: 0 }} />
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#fff', fontFamily: 'monospace', letterSpacing: '-0.3px', flexShrink: 0 }}>{order.order_num}</span>
            <span style={{ fontSize: '12px', color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.client}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0, marginLeft: '12px' }}>
            {editMode ? (
              <>
                <button onClick={handleSave} disabled={saving} style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: '#E8512A', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
                  {saving ? 'Saving...' : '✓ Save'}
                </button>
                <button onClick={handleCancel} style={{ padding: '6px 14px', borderRadius: '6px', border: '1px solid #4b5563', background: 'transparent', color: '#d1d5db', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setEditMode(true)} style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: '#E8512A', color: '#fff', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
                  ✎ Edit
                </button>
                <button onClick={() => window.print()} style={{ padding: '6px 14px', borderRadius: '6px', border: '1.5px solid #E8512A', background: 'transparent', color: '#E8512A', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}>
                  Print
                </button>
              </>
            )}
          </div>
        </div>

        {/* Row 2: Progress bar */}
        <div style={{ padding: '7px 20px 0' }} className="print-hidden">
          <div style={{ display: 'flex', gap: '2px' }}>
            {sList.map((s, i) => {
              const c = ALL_STATUS_COLORS[s] || { text: '#555' };
              return <div key={s} title={s} style={{ flex: 1, height: '3px', borderRadius: '2px', background: i <= cIdx ? (c.text || '#888') : '#374151', transition: 'background 0.2s' }} />;
            })}
          </div>
        </div>

        {/* Row 3: Previous Stage | Current · Step X/N | Next Stage */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 20px 10px' }} className="print-hidden">

          {/* Left: Send Back */}
          <div style={{ flex: 1 }}>
            {canSendBack && !isTerminal && (
              <button onClick={handleSendBackClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #f59e0b', background: 'transparent', color: '#f59e0b', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}>
                ↩ {reworkTarget}
              </button>
            )}
          </div>

          {/* Centre: current status + step counter */}
          <div style={{ textAlign: 'center', flex: 1 }}>
            <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 600 }}>
              {isTerminal ? order.status : `${order.status} · ${Math.max(cIdx + 1, 1)} of ${sList.length}`}
            </span>
            {actionError && (
              <div style={{ fontSize: '10px', color: '#f87171', marginTop: '2px' }}>⚠ {actionError}</div>
            )}
          </div>

          {/* Right: Next Stage / special actions */}
          <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', gap: '6px', alignItems: 'center' }}>
            {canAdvance && !salesBlocked && (
              <button onClick={handleNextStage} disabled={advancing} style={{ padding: '5px 14px', borderRadius: '5px', border: 'none', background: advancing ? '#374151' : '#16a34a', color: '#fff', fontWeight: 700, fontSize: '11px', cursor: advancing ? 'default' : 'pointer' }}>
                {advancing ? '...' : `→ ${nextSt}`}
              </button>
            )}
            {salesBlocked && canAdvance && (
              <span style={{ fontSize: '10px', color: '#6b7280', fontStyle: 'italic' }}>Max: {SALES_MAX_ADVANCE_TO}</span>
            )}
            {canFullRefund && (
              <button onClick={handleRefundClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #f43f5e', background: 'transparent', color: '#f43f5e', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}>
                💸 Refund
              </button>
            )}
            {canRepair && (
              <button onClick={handleRepairClick} style={{ padding: '5px 12px', borderRadius: '5px', border: '1.5px solid #8b5cf6', background: 'transparent', color: '#8b5cf6', fontWeight: 700, fontSize: '11px', cursor: 'pointer' }}>
                🔧 Repair
              </button>
            )}
          </div>
        </div>
        </div>{/* end dark header inner */}

        {/* ── Tab bar ── */}
        <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }} className="print-hidden order-tab-bar">
          {[
            { id: 'info',     label: 'Info',     icon: '📋' },
            { id: 'payments', label: 'Payments', icon: '💰' },
            { id: 'pnl',      label: 'P&L',      icon: '📊' },
            { id: 'delivery', label: 'Delivery', icon: '🚚' },
            { id: 'drawings', label: 'Files',    icon: '📐' },
            { id: 'activity', label: 'Activity', icon: '🕐' },
          ].map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              padding: '10px 16px', border: 'none', background: 'transparent',
              borderBottom: activeTab === t.id ? '2.5px solid #E8512A' : '2.5px solid transparent',
              color: activeTab === t.id ? '#E8512A' : '#6b7280',
              fontWeight: activeTab === t.id ? 700 : 500,
              fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: '5px',
            }}>
              <span>{t.icon}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>{/* end sticky wrapper */}

      {/* ── MAIN ───────────────────────────────────────────────────────────── */}
      <main style={{ maxWidth: '860px', margin: '0 auto', padding: '20px 16px' }}>

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
          <div className="order-cards-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
            <div style={card}>
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

            <div style={card}>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Link href={`/customers/${order.customer_id}`} style={{ fontSize: '13px', color: '#E8512A', fontWeight: 600, textDecoration: 'none' }}>
                        {order._customer?.name || order.client} ↗
                      </Link>
                      {['admin', 'head_of_sales', 'production_manager', 'sales'].includes(userRole) && (
                        <button onClick={() => { setCustomerSearch(''); setShowLinkCustomer(true); }} style={{ fontSize: '11px', color: '#6b7280', background: 'none', border: '1px solid #e5e7eb', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>
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
            <div style={{ ...card, padding: '0', overflow: 'hidden' }}>
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
          </div>

          {/* Order Notes */}
          {(order.notes || editMode) && (
            <div style={{ marginBottom: '24px' }}>
              <div style={sectionLabel}>📋 Order notes</div>
              <div style={card}>
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
          <div style={{ ...card, marginBottom: '24px' }}>
            <PaymentPanel
              orderId={id}
              contractTotal={contractTotal}
              itemsSubtotal={itemsSubtotal}
              chargeItems={displayItems.filter(i => isChargeItem(i))}
              userRole={userRole}
              orderStatus={order.status}
              payments={payments}
              setPayments={setPayments}
            />
          </div>
          <div style={sectionLabel}>💬 Notes</div>
          <div style={card}><NotesThread orderId={id} /></div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: P&L
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'pnl' && (<>
          <div style={sectionLabel}>📊 Project P&amp;L</div>
          <div style={card}>
            <PnLTab
              orderId={id}
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
          />
        )}

        {/* ═══════════════════════════════════════════════════
            TAB: FILES (drawings)
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'drawings' && (<>
          <div style={sectionLabel}>📐 Files & drawings</div>
          <div style={card}><AttachmentsPanel orderId={id} userRole={userRole} /></div>
        </>)}

        {/* ═══════════════════════════════════════════════════
            TAB: ACTIVITY
            ═══════════════════════════════════════════════════ */}
        {activeTab === 'activity' && (<>
          <div style={sectionLabel}>🕐 Activity log</div>
          <div style={card}><ActivityLog orderId={id} /></div>
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
        /* ── Mobile responsive ── */
        @media (max-width: 640px) {
          .order-cards-grid {
            grid-template-columns: 1fr !important;
          }
          main {
            padding: 12px !important;
          }
        }
        /* Hide text labels on very narrow screens — icons stay */
        @media (max-width: 380px) {
          .tab-label { display: none !important; }
        }
      `}</style>
    </div>
  );
}
