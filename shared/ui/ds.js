/**
 * Canvas Guy Tracker — Shared Design System
 *
 * Single source of truth for design tokens and UI primitives.
 * Import from any module:
 *   import { C, Btn, Panel, PanelHead, StatCard, Badge, Modal, ... } from '@/shared/ui/ds';
 *
 * Typography rules (enforced here, not in every module):
 *   – DM Sans  → headings, labels, body, forms (default body font via globals.css)
 *   – DM Mono  → order/quote/invoice numbers, dates in tables, financial figures
 *
 * Never add arbitrary `fontFamily: 'monospace'`. Use `C.mono` where needed.
 */

'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// ─── Design tokens ────────────────────────────────────────────────────────────
export const C = {
  // Brand
  coral:    '#E8512A',
  coralBg:  '#fde8e2',
  coralBd:  '#f5c2b0',

  // Neutrals
  ink:      '#181818',
  muted:    '#6b7280',
  faint:    '#9ca3af',
  line:     '#e7e3de',
  bg:       '#f7f6f3',
  card:     '#ffffff',

  // Semantic
  green:    '#16794a', greenBg:  '#eaf7ef', greenBd:  '#c6e7d4',
  amber:    '#96620a', amberBg:  '#fff5d9', amberBd:  '#ead69c',
  red:      '#a8362d', redBg:    '#fde9e7', redBd:    '#efc8c4',
  blue:     '#245e9b', blueBg:   '#eaf2fb', blueBd:   '#c7dbef',
  purple:   '#5b21b6', purpleBg: '#f0ebff', purpleBd: '#d4c5f9',

  // Typography
  mono: "var(--font-dm-mono, 'DM Mono', monospace)",

  // Sizing
  radius:   '12px',
  radiusSm: '8px',
};

// ─── Typography helpers ───────────────────────────────────────────────────────
/** Wrap any monetary / numeric / code value in DM Mono */
export const Mono = ({ children, style }) => (
  <span style={{ fontFamily: C.mono, ...style }}>{children}</span>
);

/** Format KES amounts — always rendered in DM Mono */
export const fmtKes = (n) =>
  'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtShortDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) : '—';

// ─── Badge ────────────────────────────────────────────────────────────────────
const BADGE_PALETTE = {
  blue:   [C.blueBg,   C.blue],
  green:  [C.greenBg,  C.green],
  amber:  [C.amberBg,  C.amber],
  red:    [C.redBg,    C.red],
  purple: [C.purpleBg, C.purple],
  gray:   ['#f1efeb',  C.muted],
  coral:  [C.coralBg,  C.coral],
};

export const Badge = ({ color = 'gray', children, style }) => {
  const [bg, fg] = BADGE_PALETTE[color] || BADGE_PALETTE.gray;
  return (
    <span style={{
      background: bg, color: fg,
      padding: '3px 9px', borderRadius: 20,
      fontWeight: 700, fontSize: 10.5,
      display: 'inline-flex', whiteSpace: 'nowrap',
      letterSpacing: '0.02em',
      ...style,
    }}>
      {children}
    </span>
  );
};

/** Status chip — pass `status` string, optionally a color map */
export const StatusBadge = ({ status, colorMap = {}, style }) => {
  const color = colorMap[status] || 'gray';
  return <Badge color={color} style={style}>{status}</Badge>;
};

// ─── Button ───────────────────────────────────────────────────────────────────
export const Btn = ({ primary, danger, small, onClick, disabled, children, style, type = 'button' }) => (
  <>
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={small ? 'ds-btn-small' : undefined}
      style={{
        border: primary
          ? `1px solid ${C.coral}`
          : danger
            ? `1px solid ${C.red}`
            : `1px solid ${C.line}`,
        background: primary ? C.coral : danger ? C.redBg : C.card,
        color: primary ? '#fff' : danger ? C.red : C.ink,
        padding: small ? '6px 11px' : '9px 15px',
        minHeight: small ? 36 : 44,
        borderRadius: C.radiusSm,
        fontWeight: 700,
        fontSize: small ? 12 : 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        whiteSpace: 'nowrap',
        transition: 'background 0.1s, border-color 0.1s',
        fontFamily: 'inherit',
        ...style,
      }}
    >
      {children}
    </button>
    <style>{`@media (max-width: 640px) { .ds-btn-small { min-height: 44px !important; } }`}</style>
  </>
);

// ─── Notice / Alert ───────────────────────────────────────────────────────────
const NOTICE_PALETTE = {
  blue:   [C.blueBg,  '#214e79', C.blueBd],
  green:  [C.greenBg, '#145b38', C.greenBd],
  amber:  [C.amberBg, '#75500b', C.amberBd],
  red:    [C.redBg,   '#792b25', C.redBd],
  coral:  [C.coralBg, '#a33a1e', C.coralBd],
};

export const Notice = ({ color = 'blue', children, style }) => {
  const [bg, fg, bd] = NOTICE_PALETTE[color] || NOTICE_PALETTE.blue;
  return (
    <div style={{
      background: bg, color: fg, border: `1px solid ${bd}`,
      borderRadius: 9, padding: '11px 14px',
      fontSize: 12.5, lineHeight: 1.5,
      ...style,
    }}>
      {children}
    </div>
  );
};

// ─── Panel (card) ─────────────────────────────────────────────────────────────
export const Panel = ({ children, style }) => (
  <div style={{
    background: C.card,
    border: `1px solid ${C.line}`,
    borderRadius: C.radius,
    overflow: 'hidden',
    marginBottom: 16,
    ...style,
  }}>
    {children}
  </div>
);

export const PanelHead = ({ title, sub, actions, style }) => (
  <div style={{
    padding: '15px 18px',
    borderBottom: `1px solid ${C.line}`,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    ...style,
  }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 800, fontSize: 15, color: C.ink }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{sub}</div>}
    </div>
    {actions && (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        {actions}
      </div>
    )}
  </div>
);

// ─── Toolbar (filter bar) ─────────────────────────────────────────────────────
export const Toolbar = ({ children, style }) => (
  <div style={{
    padding: '12px 18px',
    borderBottom: `1px solid ${C.line}`,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
    ...style,
  }}>
    {children}
  </div>
);

// ─── Text inputs (for use inside forms) ──────────────────────────────────────
const inputBase = {
  width: '100%',
  border: `1px solid ${C.line}`,
  borderRadius: C.radiusSm,
  padding: '9px 11px',
  fontSize: 13,
  outline: 'none',
  background: '#fafaf8',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  color: C.ink,
};
export const TInput  = ({ style, ...props }) => <input  style={{ ...inputBase, ...style }} {...props} />;
export const TSelect = ({ style, children, ...props }) => <select style={{ ...inputBase, ...style }} {...props}>{children}</select>;
export const TArea   = ({ style, ...props }) => <textarea style={{ ...inputBase, resize: 'vertical', ...style }} {...props} />;

// ─── Form field wrapper ───────────────────────────────────────────────────────
export const Field = ({ label, children, full, style }) => (
  <div style={{ gridColumn: full ? '1 / -1' : undefined, marginBottom: 12, ...style }}>
    <label style={{
      display: 'block',
      color: C.muted,
      fontWeight: 700,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      marginBottom: 5,
    }}>
      {label}
    </label>
    {children}
  </div>
);

// ─── Stat card ────────────────────────────────────────────────────────────────
export const StatCard = ({ label, value, sub, alert, mono = false, style }) => (
  <div style={{
    background: alert ? C.redBg : C.card,
    border: `1px solid ${alert ? C.redBd : C.line}`,
    borderRadius: C.radius,
    padding: 15,
    ...style,
  }}>
    <div style={{
      color: C.muted, fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
    }}>
      {label}
    </div>
    <div style={{
      fontSize: 23, fontWeight: 800, marginTop: 7,
      color: alert ? C.red : C.ink,
      fontFamily: mono ? C.mono : 'inherit',
    }}>
      {value}
    </div>
    {sub && <div style={{ color: C.muted, marginTop: 6, fontSize: 12 }}>{sub}</div>}
  </div>
);

// ─── Page header ─────────────────────────────────────────────────────────────
export const PageHeader = ({ title, description, actions, style }) => (
  <div style={{
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    marginBottom: 18,
    ...style,
  }}>
    <div style={{ flex: 1 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: C.ink }}>{title}</h1>
      {description && (
        <p style={{ margin: '5px 0 0', color: C.muted, fontSize: 13 }}>{description}</p>
      )}
    </div>
    {actions && (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        {actions}
      </div>
    )}
  </div>
);

// ─── Tabs ─────────────────────────────────────────────────────────────────────
export const TabBar = ({ tabs, active, onSelect, style }) => (
  <div style={{ position: 'relative', marginBottom: 18, ...style }}>
    <div className="tabbar-scroll" style={{
      display: 'flex',
      overflowX: 'auto',
      border: `1px solid ${C.line}`,
      background: C.card,
      borderRadius: 10,
      padding: '0 14px',
      scrollbarWidth: 'none',
      msOverflowStyle: 'none',
    }}>
      {tabs.map((t) => {
        const label = typeof t === 'string' ? t : t.label;
        const key   = typeof t === 'string' ? t : t.key ?? t.label;
        return (
          <button
            key={key}
            onClick={(e) => {
              onSelect(key);
              // Scroll active tab into view on mobile (use currentTarget to avoid cross-module querySelector issues)
              e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }}
            data-tabkey={key}
            style={{
              border: 0,
              background: 'transparent',
              padding: '13px 4px',
              marginRight: 24,
              color: active === key ? C.ink : C.muted,
              fontWeight: 700,
              fontSize: 13,
              minHeight: 44,
              borderBottom: `3px solid ${active === key ? C.coral : 'transparent'}`,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
    {/* Right-edge fade to hint at more tabs */}
    <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 32, pointerEvents: 'none', background: `linear-gradient(to right, transparent, ${C.card})`, borderRadius: '0 10px 10px 0' }} />
    <style>{`.tabbar-scroll::-webkit-scrollbar { display: none; }`}</style>
  </div>
);

// ─── Table primitives ─────────────────────────────────────────────────────────
export const Th = ({ children, right, style }) => (
  <th style={{
    textAlign: right ? 'right' : 'left',
    color: C.muted,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: '.04em',
    padding: '10px 14px',
    borderBottom: `1px solid ${C.line}`,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    ...style,
  }}>
    {children}
  </th>
);

export const Td = ({ children, right, sub, mono, muted, style }) => (
  <td style={{
    padding: '11px 14px',
    borderBottom: `1px solid ${C.line}`,
    textAlign: right ? 'right' : 'left',
    fontSize: 12.5,
    fontFamily: mono ? C.mono : 'inherit',
    color: muted ? C.muted : 'inherit',
    verticalAlign: 'middle',
    ...style,
  }}>
    {children}
    {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{sub}</div>}
  </td>
);

export const Table = ({ children, style }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', ...style }}>
      {children}
    </table>
  </div>
);

// ─── Empty state ──────────────────────────────────────────────────────────────
export const Empty = ({ message = 'No items found.', action, style }) => (
  <div style={{
    padding: '48px 24px',
    textAlign: 'center',
    color: C.muted,
    fontSize: 13,
    ...style,
  }}>
    <div style={{ marginBottom: action ? 12 : 0 }}>{message}</div>
    {action}
  </div>
);

// ─── Loading spinner text ─────────────────────────────────────────────────────
export const Loading = ({ style }) => (
  <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted, fontSize: 13, ...style }}>
    Loading…
  </div>
);

// ─── Modal ────────────────────────────────────────────────────────────────────
export const Modal = ({ title, onClose, footer, children, wide }) => {
  // Notify QuickActions to hide while this modal is open
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('quickactions:lock'));
    return () => window.dispatchEvent(new CustomEvent('quickactions:unlock'));
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: '72px 14px 60px',
      }}
    >
      <div style={{
        background: C.card, borderRadius: 13,
        width: '100%', maxWidth: wide ? 780 : 640,
        boxShadow: '0 24px 80px rgba(0,0,0,.3)', flexShrink: 0,
      }}>
        <div style={{
          padding: '15px 18px', borderBottom: `1px solid ${C.line}`,
          display: 'flex', alignItems: 'center',
        }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>{title}</h3>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', border: 0, background: 'none',
              fontSize: 22, cursor: 'pointer', color: C.muted, lineHeight: 1,
              minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
        {footer && (
          <div style={{
            padding: '15px 18px', borderBottom: `1px solid ${C.line}`,
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

// ─── Metric bar (for KPI progress) ───────────────────────────────────────────
export const MetricBar = ({ label, value, pct, style }) => (
  <div style={{ marginBottom: 12, ...style }}>
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      fontSize: 12, marginBottom: 5, color: C.ink,
    }}>
      <span>{label}</span>
      <strong style={{ fontFamily: C.mono }}>{value}</strong>
    </div>
    <div style={{ height: 9, background: '#eeeae5', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: C.coral, borderRadius: 8 }} />
    </div>
  </div>
);

// ─── Confirm / destructive dialog ─────────────────────────────────────────────
export const ConfirmDialog = ({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel, danger = true }) => (
  <Modal title={title} onClose={onCancel} footer={
    <>
      <Btn onClick={onCancel}>Cancel</Btn>
      <Btn primary={!danger} danger={danger} onClick={onConfirm}>{confirmLabel}</Btn>
    </>
  }>
    <p style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, margin: 0 }}>{message}</p>
  </Modal>
);

// ─── Section divider label ────────────────────────────────────────────────────
export const SectionLabel = ({ children, style }) => (
  <div style={{
    fontSize: 10, fontWeight: 700, color: C.muted,
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: 10,
    ...style,
  }}>
    {children}
  </div>
);
