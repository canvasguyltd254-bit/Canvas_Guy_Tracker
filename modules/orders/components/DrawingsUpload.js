'use client';

import { useState, useEffect } from 'react';

const ALLOWED_EXT = ['dxf', 'pdf', 'png', 'jpg', 'jpeg'];

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(fileName) {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'dxf': return '📐';
    case 'pdf': return '📄';
    case 'png':
    case 'jpg':
    case 'jpeg': return '🖼️';
    default: return '📎';
  }
}

export function DrawingsUpload({ orderId, drawings = [], onDrawingsUpdated, readOnly = false, canDelete = false }) {
  const [uploading, setUploading]         = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError]                 = useState(null);
  const [dragActive, setDragActive]       = useState(false);
  const [activeDrawings, setActiveDrawings] = useState([]);
  const [deleteTarget, setDeleteTarget]   = useState(null); // {id, file_name}
  const [deleteReason, setDeleteReason]   = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Filter out soft-deleted drawings
  useEffect(() => {
    setActiveDrawings(drawings.filter(d => !d.deleted_at));
  }, [drawings]);

  // Group drawings by file extension
  const groupedDrawings = activeDrawings.reduce((acc, drawing) => {
    const ext = drawing.file_name?.split('.').pop()?.toLowerCase() || 'other';
    if (!acc[ext]) acc[ext] = [];
    acc[ext].push(drawing);
    return acc;
  }, {});

  // Sort each group newest first
  Object.keys(groupedDrawings).forEach(key => {
    groupedDrawings[key].sort((a, b) =>
      new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()
    );
  });

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const handleFiles = async (files) => {
    for (const file of Array.from(files)) {
      await uploadFile(file);
    }
  };

  const uploadFile = async (file) => {
    setError(null);
    setUploading(true);
    setUploadProgress(0);

    // Validate extension
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setError(`File type .${ext} not allowed. Use DXF, PDF, PNG, or JPG.`);
      setUploading(false);
      return;
    }

    // Validate size (70MB)
    if (file.size > 70 * 1024 * 1024) {
      setError(`File too large. Maximum 70MB allowed.`);
      setUploading(false);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Simulate progress
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + Math.random() * 30, 90));
      }, 200);

      const response = await fetch(`/api/orders/${orderId}/drawings`, {
        method: 'POST',
        body: formData,
      });

      clearInterval(progressInterval);
      setUploadProgress(100);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Upload failed');
      }

      const data = await response.json();

      if (data.success && data.drawing) {
        const updated = [...activeDrawings, data.drawing];
        setActiveDrawings(updated);
        if (onDrawingsUpdated) onDrawingsUpdated(updated);
      }

      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
      }, 500);

    } catch (err) {
      setError(`Failed to upload ${file.name}: ${err.message}`);
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // Opens the reason modal; actual deletion happens in confirmDelete
  const handleDelete = (drawingId, fileName) => {
    setDeleteTarget({ id: drawingId, file_name: fileName });
    setDeleteReason('');
    setError(null);
  };

  const confirmDelete = async () => {
    if (!deleteReason.trim() || !deleteTarget) return;
    const target = deleteTarget;
    setDeleteLoading(true);
    setDeleteTarget(null);
    setDeleteReason('');
    try {
      const response = await fetch(`/api/orders/${orderId}/drawings?drawing_id=${target.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReason.trim() }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Delete failed');
      }
      const updated = activeDrawings.filter(d => d.id !== target.id);
      setActiveDrawings(updated);
      if (onDrawingsUpdated) onDrawingsUpdated(updated);
    } catch (err) {
      setError(err.message);
    }
    setDeleteLoading(false);
  };

  const handleDownload = async (drawingId, fileName) => {
    try {
      const response = await fetch(`/api/orders/${orderId}/drawings?drawing_id=${drawingId}`);

      if (!response.ok) throw new Error('Failed to get download URL');

      const data = await response.json();
      if (data.signed_url) {
        window.open(data.signed_url, '_blank');
      }

    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Upload Zone */}
      {!readOnly && (
        <>
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${dragActive ? '#E8512A' : '#d1d5db'}`,
              borderRadius: '8px',
              padding: '32px',
              textAlign: 'center',
              background: dragActive ? '#fff5f2' : '#f9fafb',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: '28px', marginBottom: '12px', opacity: 0.5 }}>⬆</div>
            <p style={{ fontSize: '13px', color: '#374151', marginBottom: '6px', fontWeight: 600 }}>
              Drag and drop DXF, PDF, PNG, or JPG files here
            </p>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '14px' }}>Max 70MB per file</p>
            <label style={{ display: 'inline-block', cursor: 'pointer' }}>
              <input
                type="file"
                multiple
                accept=".dxf,.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={e => e.target.files && handleFiles(e.target.files)}
                disabled={uploading}
                style={{ display: 'none' }}
              />
              <span style={{
                display: 'inline-block',
                padding: '8px 18px',
                borderRadius: '7px',
                border: '2px solid #E8512A',
                color: '#E8512A',
                fontWeight: 700,
                fontSize: '13px',
                cursor: 'pointer',
              }}>
                Browse Files
              </span>
            </label>
          </div>

          {/* Upload Progress */}
          {uploading && (
            <div style={{ padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#1e40af' }}>Uploading...</span>
                <span style={{ fontSize: '12px', color: '#3b82f6' }}>{Math.round(uploadProgress)}%</span>
              </div>
              <div style={{ background: '#bfdbfe', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${uploadProgress}%`, background: '#3b82f6', borderRadius: '4px', transition: 'width 0.2s' }} />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '12px', color: '#dc2626', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span>{error}</span>
            </div>
          )}
        </>
      )}

      {/* Drawings grouped by type */}
      {Object.keys(groupedDrawings).length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {Object.entries(groupedDrawings).map(([fileType, files]) => (
            <div key={fileType}>
              <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#111', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {getFileIcon(files[0].file_name)} {fileType.toUpperCase()} Files
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {files.map(drawing => (
                  <div
                    key={drawing.id}
                    style={{
                      padding: '10px 14px',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: '#fff',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: '13px', fontWeight: 600, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {drawing.file_name}
                      </p>
                      <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>
                        {formatFileSize(drawing.file_size)} · {formatDate(drawing.uploaded_at)}
                      </p>
                      {drawing.drawing_type && drawing.drawing_type !== 'general' && (
                        <span style={{ fontSize: '10px', background: '#ffedd5', color: '#c2410c', padding: '1px 6px', borderRadius: '3px', marginTop: '4px', display: 'inline-block', textTransform: 'capitalize' }}>
                          {drawing.drawing_type}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginLeft: '12px', flexShrink: 0 }}>
                      <button
                        onClick={() => handleDownload(drawing.id, drawing.file_name)}
                        title="Download"
                        style={{ padding: '6px 10px', borderRadius: '5px', border: '1px solid #e5e7eb', background: '#fff', color: '#E8512A', cursor: 'pointer', fontSize: '13px' }}
                      >
                        ↓
                      </button>
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(drawing.id, drawing.file_name)}
                          title="Delete"
                          style={{ padding: '6px 10px', borderRadius: '5px', border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: '13px' }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : !uploading ? (
        <div style={{ padding: '40px', textAlign: 'center', color: '#9ca3af' }}>
          <div style={{ fontSize: '28px', opacity: 0.3, marginBottom: '10px' }}>📄</div>
          <p style={{ fontSize: '13px' }}>No drawings uploaded yet</p>
          {!readOnly && <p style={{ fontSize: '11px', marginTop: '4px' }}>Upload drawings using the form above</p>}
        </div>
      ) : null}

      {/* Read-only badge */}
      {readOnly && activeDrawings.length > 0 && (
        <div style={{ padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px', fontSize: '12px', color: '#1d4ed8' }}>
          📎 {activeDrawings.length} drawing{activeDrawings.length !== 1 ? 's' : ''} attached to this order
        </div>
      )}

      {/* ── Delete File Modal ── */}
      {deleteTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#fff', borderRadius: '12px', padding: '28px', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#111', marginBottom: '4px' }}>Delete File</div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px', wordBreak: 'break-all' }}>
              <strong>{deleteTarget.file_name}</strong>
            </div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
              Reason for deletion <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder="Explain why this file is being deleted…"
              rows={3}
              autoFocus
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setDeleteTarget(null); setDeleteReason(''); }}
                style={{ padding: '9px 20px', borderRadius: '7px', border: '1.5px solid #e0e0e0', background: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: '#374151' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!deleteReason.trim() || deleteLoading}
                style={{ padding: '9px 20px', borderRadius: '7px', border: 'none', background: deleteReason.trim() && !deleteLoading ? '#dc2626' : '#fca5a5', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: deleteReason.trim() && !deleteLoading ? 'pointer' : 'not-allowed' }}
              >
                {deleteLoading ? 'Deleting…' : 'Delete File'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
