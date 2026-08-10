'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/shared/context/AuthContext';

// Role → allowed quick-create actions
const ROLE_ACTIONS = {
  admin:              ['enquiry', 'quote', 'order', 'customer'],
  head_of_sales:      ['enquiry', 'quote', 'order', 'customer'],
  sales:              ['enquiry', 'quote', 'order', 'customer'],
  production_manager: ['order', 'customer'],
};

const ACTION_CONFIG = {
  enquiry:  { label: 'New Enquiry',  emoji: '📋', href: (p) => `/crm?new=enquiry${p.customer_id ? `&customer_id=${p.customer_id}` : ''}` },
  quote:    { label: 'New Quote',    emoji: '📄', href: (p) => `/crm?new=quote${p.customer_id ? `&customer_id=${p.customer_id}` : ''}${p.enquiry_id ? `&enquiry_id=${p.enquiry_id}` : ''}` },
  order:    { label: 'New Order',    emoji: '📦', href: (p) => `/orders/new${p.customer_id ? `?customer_id=${p.customer_id}` : ''}` },
  customer: { label: 'New Customer', emoji: '👤', href: (p) => `/customers?new=customer${p.prospect_name ? `&prospect_name=${encodeURIComponent(p.prospect_name)}` : ''}${p.phone ? `&phone=${encodeURIComponent(p.phone)}` : ''}` },
};

export default function QuickActions({ prefill = {} }) {
  const router   = useRouter();
  const pathname = usePathname();
  const { userRole, loaded } = useAuth();
  // CRM has its own visible New Enquiry / Direct Quote buttons — suppress the mobile FAB there
  const hideMobileFab = pathname === '/crm';
  const [open,   setOpen]   = useState(false);
  const [locked, setLocked] = useState(false); // true when any modal is open

  // Separate refs for desktop button and mobile FAB — both block outside-click
  const desktopRef = useRef(null);
  const fabRef     = useRef(null);

  const allowed = ROLE_ACTIONS[userRole] || [];

  // Listen for modal open/close signals from CrmModule Modal + CustomersModule
  useEffect(() => {
    let count = 0; // counter so nested modals don't prematurely unlock
    const lock   = () => { count++; setLocked(true);  };
    const unlock = () => { count = Math.max(0, count - 1); if (count === 0) setLocked(false); };
    window.addEventListener('quickactions:lock',   lock);
    window.addEventListener('quickactions:unlock', unlock);
    return () => {
      window.removeEventListener('quickactions:lock',   lock);
      window.removeEventListener('quickactions:unlock', unlock);
    };
  }, []);

  // Close dropdown on outside click — check both desktop and FAB refs
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      const inDesktop = desktopRef.current?.contains(e.target);
      const inFab     = fabRef.current?.contains(e.target);
      if (!inDesktop && !inFab) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close dropdown on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  if (!loaded || allowed.length === 0) return null;

  // Hide entirely when a modal is open
  if (locked) return null;

  const navigate = (actionKey) => {
    setOpen(false);
    router.push(ACTION_CONFIG[actionKey].href(prefill));
  };

  const menuItems = allowed.map((key) => {
    const cfg = ACTION_CONFIG[key];
    return (
      <button
        key={key}
        onClick={() => navigate(key)}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          width: '100%', padding: '9px 12px', borderRadius: '6px',
          border: 'none', background: 'transparent', color: '#ccc',
          fontSize: '13px', fontWeight: 500, cursor: 'pointer', textAlign: 'left',
          minHeight: 44,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,81,42,0.15)'; e.currentTarget.style.color = '#fff'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#ccc'; }}
      >
        <span style={{ fontSize: '15px' }}>{cfg.emoji}</span>
        <span>{cfg.label}</span>
      </button>
    );
  });

  const dropdownStyle = {
    background: '#252525',
    border: '1px solid #333',
    borderRadius: '10px',
    padding: '6px',
    minWidth: '192px',
    boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
  };

  return (
    <>
      {/* ── Desktop: button in header ── */}
      <div ref={desktopRef} className="qa-desktop" style={{ position: 'relative' }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            padding: '6px 13px', borderRadius: '6px', border: 'none',
            background: '#E8512A', color: '#fff', fontWeight: 700,
            fontSize: '13px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '5px',
            minHeight: 44,
          }}
        >
          <span style={{ fontSize: '15px', lineHeight: 1 }}>＋</span>
          <span className="nav-label">New</span>
          <span style={{ fontSize: '9px', opacity: 0.8, marginLeft: '1px' }}>▾</span>
        </button>

        {open && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setOpen(false)} />
            <div style={{
              ...dropdownStyle,
              position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 200,
            }}>
              {menuItems}
            </div>
          </>
        )}
      </div>

      {/* ── Mobile: FAB pinned above nav with safe-area ── */}
      {!hideMobileFab && <div ref={fabRef} className="qa-fab" style={{ position: 'fixed', bottom: 'calc(72px + env(safe-area-inset-bottom))', right: '20px', zIndex: 250 }}>
        {open && (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 249 }}
              onClick={() => setOpen(false)}
            />
            <div style={{
              ...dropdownStyle,
              position: 'absolute', bottom: '58px', right: 0, zIndex: 250,
            }}>
              {menuItems}
            </div>
          </>
        )}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            width: '50px', height: '50px', borderRadius: '50%',
            border: 'none', background: '#E8512A', color: '#fff',
            fontSize: '24px', fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(232,81,42,0.5)',
            position: 'relative', zIndex: 251, lineHeight: 1,
          }}
        >
          {open ? '✕' : '＋'}
        </button>
      </div>}

      <style>{`
        .qa-desktop { display: flex; }
        .qa-fab     { display: none;  }
        @media (max-width: 640px) {
          .qa-desktop { display: none;  }
          .qa-fab     { display: block; }
        }
      `}</style>
    </>
  );
}
