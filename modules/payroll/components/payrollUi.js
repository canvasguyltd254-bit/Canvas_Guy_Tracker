'use client';

/**
 * Small UI primitives and a fetch helper for the Temporary Workers screens.
 * (The main PayrollModule keeps private copies of its own; these use the same design tokens.)
 */
import React from 'react';
import { C } from '@/shared/ui/ds';

export const fmt  = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const fmtD = (s) => s ? new Date(s).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDT = (s) => s ? new Date(s).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

/** fetch -> { ok, data, error, status, code }. Never throws; parses text before JSON (413s are plain text). */
export async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) return { ok: false, status: res.status, code: json?.code, error: json?.error || `Request failed (${res.status})` };
    return { ok: true, status: res.status, data: json };
  } catch {
    return { ok: false, error: 'Network error. Check your connection and try again.' };
  }
}

export const inputStyle = {
  width: '100%', padding: '9px 11px', border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13,
  boxSizing: 'border-box', fontFamily: 'inherit', background: '#fafaf8', color: C.ink,
};

const BADGES = {
  draft: ['#fef9c3', '#854d0e'], approved: ['#dbeafe', '#1e40af'], paid: ['#dcfce7', '#166534'], voided: ['#f3f4f6', '#6b7280'],
  planned: ['#f3f4f6', '#374151'], active: ['#dcfce7', '#166534'], completed: ['#ede9fe', '#5b21b6'], cancelled: ['#f3f4f6', '#6b7280'],
  open: ['#fef9c3', '#854d0e'], printed: ['#dbeafe', '#1e40af'], signed: ['#dcfce7', '#166534'],
};
export function Badge({ label, tone }) {
  const [bg, color] = tone || BADGES[label] || [C.bg, C.ink];
  return <span style={{ background: bg, color, borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{String(label || '').replace(/_/g, ' ')}</span>;
}
export const AdminBadge = ({ text = 'Admin approval needed' }) => <Badge label={text} tone={['#fff5d9', '#96620a']} />;

export function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
      <div style={{ width: 26, height: 26, border: `3px solid ${C.line}`, borderTopColor: C.coral, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    </div>
  );
}

export function Banner({ message, tone = 'error', onDismiss }) {
  if (!message) return null;
  const t = tone === 'error' ? [C.redBg, C.redBd, C.red] : tone === 'warn' ? [C.amberBg, C.amberBd, C.amber] : [C.blueBg, C.blueBd, C.blue];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{ background: t[0], border: `1px solid ${t[1]}`, borderRadius: 9, padding: '10px 14px', color: t[2], fontSize: 13, marginBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span>{message}</span>
      {onDismiss && <button onClick={onDismiss} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: t[2] }}>×</button>}
    </div>
  );
}

export function Empty({ children }) { return <div style={{ textAlign: 'center', padding: '36px 16px', color: C.muted, fontSize: 13 }}>{children}</div>; }

export function Card({ children, style }) {
  return <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, ...style }}>{children}</div>;
}

export function Modal({ title, onClose, children, width = 560 }) {
  React.useEffect(() => {
    window.dispatchEvent(new Event('quickactions:lock'));
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => { window.dispatchEvent(new Event('quickactions:unlock')); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '40px 12px' }}>
      <div style={{ background: C.card, borderRadius: 13, padding: 22, width, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: `1px solid ${C.line}`, paddingBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: C.muted, minWidth: 44, minHeight: 44 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint, required, error }) {
  // The label is tied to the field's real control (the last input/select/textarea child) so clicking the label focuses it
  // and screen readers announce it; the hint is attached as its description.
  const id = React.useId();
  const kids = React.Children.toArray(children);
  let idx = -1;
  kids.forEach((k, i) => { if (React.isValidElement(k) && ['input', 'select', 'textarea'].includes(k.type) && !k.props.id) idx = i; });
  const content = kids.map((k, i) => i === idx
    ? React.cloneElement(k, { id, 'aria-required': required || undefined, 'aria-describedby': hint && !error ? `${id}-hint` : undefined, 'aria-invalid': error ? true : undefined })
    : k);
  return (
    <div style={{ marginBottom: 13 }}>
      <label htmlFor={idx >= 0 ? id : undefined} style={{ display: 'block', fontSize: 11, fontWeight: 700, marginBottom: 5, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}{required && <span style={{ color: C.red }} aria-hidden="true"> *</span>}
      </label>
      {content}
      {hint && !error && <div id={`${id}-hint`} style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{hint}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export function Btn({ onClick, disabled, loading, children, variant = 'primary', small = false, title, style }) {
  const v = {
    primary:   { background: C.coral,   color: '#fff',  border: `1px solid ${C.coral}` },
    secondary: { background: C.card,    color: C.ink,   border: `1px solid ${C.line}` },
    danger:    { background: C.redBg,   color: C.red,    border: `1px solid ${C.redBd}` },
    success:   { background: C.greenBg, color: C.green,  border: `1px solid ${C.greenBd}` },
  }[variant];
  const off = disabled || loading;
  return (
    <button onClick={onClick} disabled={off} title={title} style={{
      padding: small ? '6px 11px' : '9px 15px', borderRadius: C.radiusSm, cursor: off ? 'not-allowed' : 'pointer', fontWeight: 700,
      fontSize: small ? 12 : 13, opacity: off ? 0.45 : 1, fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: small ? 32 : 38, ...v, ...style,
    }}>{loading ? '…' : children}</button>
  );
}

export const th = { textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', color: C.muted, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' };
export const td = { padding: '9px 10px', fontSize: 13, borderBottom: `1px solid ${C.line}`, verticalAlign: 'top' };
export const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

export function Table({ children }) {
  return <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table></div>;
}
