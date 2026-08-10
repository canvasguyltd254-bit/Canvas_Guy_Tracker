'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import calcTotals from '@/shared/lib/calcTotals';
import LineItemEditor, { BLANK_ITEM, BLANK_CHARGE } from '@/shared/components/LineItemEditor';
import InvoicesTab from '@/modules/crm/components/InvoicesTab';

// ─── Portal context ───────────────────────────────────────────────────────────
// { ref, isActive }
// ref      = the owning pane's DOM node; portal targets this so display:none hides portals.
// isActive = whether the owning tab is currently visible; gates Quick Actions lock.
const CrmPortalContext = React.createContext({ ref: null, isActive: true });

// useQuickActionsLock — lock Quick Actions while `active` is true, release on cleanup.
// Used by every overlay (Modal shell, QuoteFormModal, confirm portal) so all three paths
// respect both internal-tab visibility and workspace-level visibility.
function useQuickActionsLock(active) {
  useEffect(() => {
    if (!active) return;
    window.dispatchEvent(new CustomEvent('quickactions:lock'));
    return () => window.dispatchEvent(new CustomEvent('quickactions:unlock'));
  }, [active]);
}

// CrmTabPane — always in the DOM after first visit, hidden via display:none when inactive.
// Accepts workspaceActive so isActive = workspaceActive && (this tab is selected).
// This means switching CRM → Payroll in WorkspaceShell releases lock for any open modal.
function CrmTabPane({ name, activeTab, workspaceActive, visited, children }) {
  const paneRef = useRef(null);
  const isActive = workspaceActive && activeTab === name;
  return (
    <CrmPortalContext.Provider value={{ ref: paneRef, isActive }}>
      <div ref={paneRef} style={{ display: isActive ? 'block' : 'none', position: 'relative' }}>
        {visited && children}
      </div>
    </CrmPortalContext.Provider>
  );
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  coral: '#E8512A', coralBg: '#fde8e2',
  ink:   '#181818',
  muted: '#6b7280',
  line:  '#e7e3de',
  bg:    '#f7f6f3',
  card:  '#fff',
  green: '#16794a', greenBg: '#eaf7ef', greenBd: '#c6e7d4',
  amber: '#96620a', amberBg: '#fff5d9', amberBd: '#ead69c',
  red:   '#a8362d', redBg:   '#fde9e7', redBd:   '#efc8c4',
  blue:  '#245e9b', blueBg:  '#eaf2fb', blueBd:  '#c7dbef',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtDate   = (d) => d ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtKes    = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 });
const isOverdue = (d) => d && new Date(d) < new Date();
const isToday   = (d) => { if (!d) return false; const t = new Date(d), n = new Date(); return t.toDateString() === n.toDateString(); };

// ─── Primitives ───────────────────────────────────────────────────────────────
const BADGE_MAP = {
  blue:  [C.blueBg,  C.blue],
  green: [C.greenBg, C.green],
  amber: [C.amberBg, C.amber],
  red:   [C.redBg,   C.red],
  gray:  ['#f1efeb', C.muted],
};
const Badge = ({ color = 'gray', children }) => {
  const [bg, fg] = BADGE_MAP[color] || BADGE_MAP.gray;
  return <span style={{ background: bg, color: fg, padding: '3px 8px', borderRadius: 20, fontWeight: 700, fontSize: 10.5, display: 'inline-flex', whiteSpace: 'nowrap' }}>{children}</span>;
};
const Chip = ({ children }) => (
  <span style={{ background: '#efede9', color: C.ink, padding: '3px 8px', borderRadius: 20, fontWeight: 700, fontSize: 10.5, display: 'inline-flex', whiteSpace: 'nowrap' }}>{children}</span>
);
const Notice = ({ color = 'blue', children, style }) => {
  const map = { blue: [C.blueBg, '#214e79', C.blueBd], green: [C.greenBg, '#145b38', C.greenBd], amber: [C.amberBg, '#75500b', C.amberBd], red: [C.redBg, '#792b25', C.redBd] };
  const [bg, fg, bd] = map[color] || map.blue;
  return <div style={{ background: bg, color: fg, border: `1px solid ${bd}`, borderRadius: 9, padding: '11px 13px', fontSize: 12.5, lineHeight: 1.45, ...style }}>{children}</div>;
};
const Btn = ({ primary, small, onClick, disabled, children, style }) => (
  <button onClick={onClick} disabled={disabled} style={{
    border: primary ? `1px solid ${C.coral}` : `1px solid ${C.line}`,
    background: primary ? C.coral : C.card,
    color: primary ? '#fff' : C.ink,
    padding: small ? '6px 10px' : '9px 14px',
    borderRadius: 8, fontWeight: 700, fontSize: small ? 12 : 13,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
    display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', ...style,
  }}>{children}</button>
);
const Panel = ({ children, style }) => (
  <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16, ...style }}>{children}</div>
);
const PanelHead = ({ title, sub, actions }) => (
  <div style={{ padding: '15px 17px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 800, fontSize: 15, color: C.ink }}>{title}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{sub}</div>}
    </div>
    {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>{actions}</div>}
  </div>
);
const Toolbar = ({ children }) => (
  <div style={{ padding: '12px 17px', borderBottom: `1px solid ${C.line}`, display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
);
const TInput = ({ value, onChange, placeholder, style }) => (
  <input value={value} onChange={onChange} placeholder={placeholder}
    style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 8, padding: '8px 10px', fontSize: 12, flex: 1, minWidth: 190, outline: 'none', ...style }} />
);
const TSelect = ({ value, onChange, children, style }) => (
  <select value={value} onChange={onChange}
    style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 8, padding: '8px 10px', fontSize: 12, outline: 'none', ...style }}>
    {children}
  </select>
);
const StatCard = ({ label, value, sub, alert }) => (
  <div style={{ background: alert ? C.redBg : C.card, border: `1px solid ${alert ? C.redBd : C.line}`, borderRadius: 12, padding: 15 }}>
    <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
    <div style={{ fontSize: 23, fontWeight: 800, marginTop: 7, color: alert ? C.red : C.ink }}>{value}</div>
    {sub && <div style={{ color: C.muted, marginTop: 6, fontSize: 12 }}>{sub}</div>}
  </div>
);
const MetricBar = ({ label, value, pct }) => (
  <div style={{ marginBottom: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5, color: C.ink }}>
      <span>{label}</span><strong>{value}</strong>
    </div>
    <div style={{ height: 9, background: '#eeeae5', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${pct}%`, background: C.coral, borderRadius: 8 }} />
    </div>
  </div>
);

// table primitives
const Th = ({ children, right }) => (
  <th style={{ textAlign: right ? 'right' : 'left', color: C.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em', padding: '10px 14px', borderBottom: `1px solid ${C.line}`, fontWeight: 700 }}>{children}</th>
);
const Td = ({ children, right, sub, style }) => (
  <td style={{ padding: '11px 14px', borderBottom: `1px solid ${C.line}`, textAlign: right ? 'right' : 'left', fontSize: 12.5, ...style }}>
    {children}
    {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{sub}</div>}
  </td>
);

// ─── Stage / status badge helpers ─────────────────────────────────────────────
const stageColor   = { new: 'blue', contacted: 'amber', quoted: 'blue', won: 'green', lost: 'red' };
const statusColor  = { draft: 'gray', sent: 'blue', accepted: 'green', rejected: 'red', expired: 'amber', superseded: 'gray' };

// ─── Field input used in modals ───────────────────────────────────────────────
const Field = ({ label, children, full }) => (
  <div style={{ gridColumn: full ? '1 / -1' : undefined, marginBottom: 12 }}>
    <label style={{ display: 'block', color: C.muted, fontWeight: 700, fontSize: 11, marginBottom: 5 }}>{label}</label>
    {children}
  </div>
);
const Fi = ({ ...props }) => (
  <input {...props} style={{ width: '100%', border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', ...props.style }} />
);
const Fs = ({ ...props }) => (
  <select {...props} style={{ width: '100%', border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', ...props.style }} />
);
const Fta = ({ ...props }) => (
  <textarea {...props} style={{ width: '100%', border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', resize: 'vertical', ...props.style }} />
);

// ─── Modal shell ──────────────────────────────────────────────────────────────
const Modal = ({ title, onClose, footer, children, wide }) => {
  const { ref: portalRef, isActive } = React.useContext(CrmPortalContext);
  useQuickActionsLock(isActive);
  if (typeof document === 'undefined') return null;
  const target = portalRef?.current ?? document.body;
  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '72px 14px 60px' }}
    >
      <div style={{ background: C.card, borderRadius: 13, width: '100%', maxWidth: wide ? 760 : 640, boxShadow: '0 24px 80px rgba(0,0,0,.3)', flexShrink: 0 }}>
        <div style={{ padding: '15px 18px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>{title}</h3>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 0, background: 'none', fontSize: 22, cursor: 'pointer', color: C.muted, lineHeight: 1, padding: '0 4px' }}>×</button>
        </div>
        <div style={{ padding: 17 }}>{children}</div>
        {footer && <div style={{ padding: '15px 18px', borderTop: `1px solid ${C.line}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>,
    target,
  );
};

// ─── Quote form helpers ───────────────────────────────────────────────────────
const LINE_TYPES    = ['product', 'delivery', 'design', 'discount', 'other'];
const PRICING_MODES = [{ id: 'vat_exclusive', label: 'VAT Exclusive — add VAT on top' }, { id: 'vat_inclusive', label: 'VAT Inclusive — prices include VAT' }];
const PAYMENT_TERMS_QT = [
  { id: 'cash_before', label: 'Cash Before Production' },
  { id: '50_deposit',  label: '50% Deposit' },
  { id: '30_day',      label: '30 Day Credit' },
  { id: '60_day',      label: '60 Day Credit' },
  { id: 'custom',      label: 'Custom' },
];


// ─── Responsive hook ─────────────────────────────────────────────────────────
function useWindowWidth() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return w;
}


// ─── QuoteFormModal ───────────────────────────────────────────────────────────
function QuoteFormModal({ quote, enquiries, onSave, onClose, prefill = {} }) {
  const { ref: portalRef, isActive } = React.useContext(CrmPortalContext);
  useQuickActionsLock(isActive); // lock while modal is open and its tab is visible
  const isEdit  = !!quote;
  const winW    = useWindowWidth();
  const mobile      = winW < 640;
  const narrowPanel = winW < 860; // right panel < ~500px — stack pricing row

  // ── Customer state ──────────────────────────────────────────────────────────
  const [custQ, setCustQ]             = useState('');
  const [custResults, setCustResults] = useState([]);
  const [custLoading, setCustLoading] = useState(false);
  const [customer, setCustomer]       = useState(quote?.customers || null);
  const [useProspect, setUseProspect] = useState(!quote?.customer_id && !!quote?.prospect_name);

  const [form, setForm] = useState({
    customer_id:         quote?.customer_id         || prefill.customer_id  || '',
    prospect_name:       quote?.prospect_name       || prefill.prospect_name || '',
    prospect_contact:    quote?.prospect_contact    || '',
    enquiry_id:          quote?.enquiry_id          || prefill.enquiry_id   || '',
    project_description: quote?.project_description || '',
    payment_terms:       quote?.payment_terms       || 'cash_before',
    valid_until:         quote?.valid_until ? quote.valid_until.slice(0, 10) : '',
    pricing_mode:        quote?.pricing_mode        || 'vat_exclusive',
    tax_status:          quote?.tax_status          || 'taxable',
  });

  const patchForm = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Resolve prefill customer_id or enquiry_id on new-quote open
  useEffect(() => {
    if (isEdit) return;

    if (prefill.customer_id) {
      // Resolve customer → also sync tax_status to avoid wrong VAT calculation
      fetch('/api/customers').then(r => r.json()).then(j => {
        const found = (j.data || []).find(c => c.id === prefill.customer_id);
        if (found) {
          setCustomer(found);
          setForm(f => ({ ...f, tax_status: found.tax_status || f.tax_status }));
        }
      });
    } else if (prefill.enquiry_id) {
      // Resolve enquiry → populate its customer or prospect into the form
      const enq = (enquiries || []).find(e => e.id === prefill.enquiry_id);
      if (!enq) return;
      if (enq.customer_id) {
        fetch('/api/customers').then(r => r.json()).then(j => {
          const found = (j.data || []).find(c => c.id === enq.customer_id);
          if (found) {
            setCustomer(found);
            setForm(f => ({
              ...f,
              customer_id: found.id,
              tax_status:  found.tax_status || f.tax_status,
            }));
          }
        });
      } else if (enq.prospect_name) {
        setUseProspect(true);
        setForm(f => ({
          ...f,
          prospect_name:    enq.prospect_name    || f.prospect_name,
          prospect_contact: enq.prospect_contact || f.prospect_contact,
        }));
      }
    }
  }, []);

  // Product line items (line_type always 'product')
  const productQuoteItems = quote?.quote_items?.filter(it => (it.line_type || 'product') === 'product') || [];
  const chargeQuoteItems  = quote?.quote_items?.filter(it => (it.line_type || 'product') !== 'product') || [];

  const [items, setItems] = useState(
    productQuoteItems.length
      ? [...productQuoteItems].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map(it => ({ ...BLANK_ITEM(), ...it, unit_price: it.unit_price ?? '', discount_pct: it.discount_pct ?? '' }))
      : [BLANK_ITEM()],
  );
  const [charges, setCharges] = useState(
    chargeQuoteItems.length
      ? chargeQuoteItems.map(it => ({ _key: Math.random().toString(36).slice(2), line_type: it.line_type, description: it.description || '', amount: it.gross_amount ?? '' }))
      : [],
  );
  const [submitted, setSubmitted]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [err, setErr]               = useState('');

  // ── Validation ──────────────────────────────────────────────────────────────
  const runValidation = (f, its) => {
    const e = {};
    if (!useProspect && !f.customer_id)           e.customer             = 'Select a customer or switch to prospect';
    if (useProspect  && !f.prospect_name?.trim()) e.prospect_name        = 'Required';
    if (!f.project_description?.trim())           e.project_description  = 'Required';
    if (!f.valid_until)                           e.valid_until          = 'Required';
    its.forEach((it, i) => {
      if (!it.description?.trim())                             e[`item_${i}_desc`]  = 'Required';
      if (it.unit_price === '' || it.unit_price == null)       e[`item_${i}_price`] = 'Required';
    });
    return e;
  };
  const valErrs = submitted ? runValidation(form, items) : {};
  const hasErrs = Object.keys(valErrs).length > 0;

  // ── Customer search ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (useProspect || custQ.length < 2) { setCustResults([]); return; }
    setCustLoading(true);
    const t = setTimeout(async () => {
      const res = await fetch(`/api/customers?search=${encodeURIComponent(custQ)}&limit=10`);
      const j   = await res.json();
      setCustResults(j.data || []);
      setCustLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [custQ, useProspect]);

  const selectCustomer = (c) => {
    setCustomer(c);
    patchForm('customer_id', c.id);
    patchForm('tax_status', c.tax_status || 'taxable');
    setCustQ(''); setCustResults([]);
  };
  const clearCustomer = () => {
    setCustomer(null);
    patchForm('customer_id', '');
    patchForm('tax_status', 'taxable');
  };

  // ── Totals — used by buildPayload ────────────────────────────────────────────
  const { rows: calcRows, subtotal, vatAmount, total } = calcTotals(items, form.pricing_mode, '', form.tax_status);

  // Compute charge rows so we can include them in header totals
  const chargeRows = charges.filter(c => c.amount !== '' && c.amount != null).map((c, i) => {
    const amt    = parseFloat(c.amount) || 0;
    const vatAmt = form.tax_status === 'exempt' ? 0 : +(amt * 0.16 / 1.16).toFixed(2);
    const netAmt = +(amt - vatAmt).toFixed(2);
    return {
      line_type:     c.line_type || 'delivery',
      description:   c.description || '',
      quantity:      1,
      unit_price:    amt,
      discount_pct:  0,
      tax_treatment: form.tax_status === 'exempt' ? 'exempt' : 'standard',
      vat_rate:      form.tax_status === 'exempt' ? 0 : 0.16,
      net_amount:    netAmt,
      vat_amount:    vatAmt,
      gross_amount:  amt,
      sort_order:    calcRows.length + i,
      size: null, category: null, finish_type: null, finish_color: null, wood_type: null,
    };
  });
  // Header totals include both product items AND charges so the stored total is the true grand total
  const chargesNet   = chargeRows.reduce((s, c) => s + c.net_amount,   0);
  const chargesVat   = chargeRows.reduce((s, c) => s + c.vat_amount,   0);
  const chargesGross = chargeRows.reduce((s, c) => s + c.gross_amount, 0);

  // ── Payload builder ─────────────────────────────────────────────────────────
  const buildPayload = (targetStatus) => ({
    ...form,
    customer_id:      useProspect ? undefined : form.customer_id || undefined,
    prospect_name:    useProspect ? form.prospect_name  : undefined,
    prospect_contact: useProspect ? form.prospect_contact : undefined,
    subtotal:   +(subtotal  + chargesNet).toFixed(2),
    vat_amount: +(vatAmount + chargesVat).toFixed(2),
    total:      +(total     + chargesGross).toFixed(2),
    status: targetStatus,
    items: [
      // Product items — always line_type: 'product'
      ...calcRows.map((it, i) => ({
        line_type:     'product',
        description:   it.description  || '',
        quantity:      parseFloat(it.quantity)   || 1,
        unit_price:    parseFloat(it.unit_price) || 0,
        discount_pct:  it.discount_pct !== '' && it.discount_pct != null ? parseFloat(it.discount_pct) : 0,
        tax_treatment: form.tax_status === 'exempt' ? 'exempt' : (it.tax_treatment || 'standard'),
        vat_rate:      form.tax_status === 'exempt' ? 0 : 0.16,
        net_amount: it._net, vat_amount: it._vat, gross_amount: it._gross,
        sort_order: i, size: it.size || null,
        category:     it.category     || null,
        finish_type:  it.finish_type  || null,
        finish_color: it.finish_color || null,
        wood_type:    it.wood_type    || null,
      })),
      // Additional charges
      ...chargeRows,
    ],
  });

  // ── Persist helper ──────────────────────────────────────────────────────────
  const persist = async (payload) => {
    if (isEdit) {
      return fetch(`/api/crm/quotations/${quote.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    return fetch('/api/crm/quotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  };

  const save = async (targetStatus) => {
    setSubmitted(true);
    const errs = runValidation(form, items);
    if (Object.keys(errs).length) { setErr('Fix the highlighted fields before saving.'); return; }
    setErr(''); setSaving(true);
    const res  = await persist(buildPayload(targetStatus));
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setErr(json.error || 'Save failed'); return; }
    onSave();
  };

  const previewPdf = async () => {
    setSubmitted(true);
    const errs = runValidation(form, items);
    if (Object.keys(errs).length) { setErr('Fix the highlighted fields before previewing.'); return; }
    setErr(''); setPreviewing(true);
    // Persist as draft first (or update) to get a stable ID
    const res  = await persist(buildPayload('draft'));
    const json = await res.json();
    if (!res.ok) { setErr(json.error || 'Could not save draft for preview'); setPreviewing(false); return; }
    const id = json.data?.id || quote?.id;
    if (id) window.open(`/api/crm/quotations/${id}/pdf`, '_blank');
    setPreviewing(false);
  };

  // ── Style helpers ───────────────────────────────────────────────────────────
  const linkedEnq = enquiries?.find(e => e.id === form.enquiry_id);
  const col2 = mobile ? '1fr' : '1fr 1fr';
  const inpStyle = (errKey) => ({
    border: `1px solid ${submitted && valErrs[errKey] ? C.red : C.line}`,
    borderRadius: 8, padding: '9px 10px', fontSize: 13, width: '100%',
    outline: 'none', boxSizing: 'border-box', background: '#fff',
  });
  const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 5 };
  const ErrTip = ({ k }) => valErrs[k]
    ? <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{valErrs[k]}</div>
    : null;

  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: `${mobile ? 0 : '40px'} 0` }}
    >
      <div style={{
        background: C.card, borderRadius: mobile ? 0 : 14, width: '100%', maxWidth: 1000,
        boxShadow: '0 24px 80px rgba(0,0,0,.28)',
        display: 'flex', flexDirection: 'column',
        height: mobile ? '100dvh' : 'calc(100dvh - 80px)',
        margin: mobile ? 0 : '0 16px',
      }}>

        {/* ── Sticky header ── */}
        <div style={{ flexShrink: 0, padding: '18px 24px 14px', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: C.ink }}>
                {isEdit ? `Edit ${quote.quote_num}` : 'Create quotation'}
              </h2>
              <p style={{ margin: '3px 0 0', fontSize: 12, color: C.muted }}>
                {isEdit ? 'Update quote details and line items below.' : 'Draft quote · number generated when saved'}
              </p>
            </div>
            <button onClick={onClose}
              style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: C.ink, flexShrink: 0 }}>
              Close
            </button>
          </div>
          {submitted && hasErrs && (
            <div style={{ marginTop: 10 }}>
              <Notice color="red">{err || 'Fix the highlighted fields before saving.'}</Notice>
            </div>
          )}
          {err && !hasErrs && (
            <div style={{ marginTop: 10 }}><Notice color="red">{err}</Notice></div>
          )}
        </div>

        {/* ── Two-panel body ── */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: mobile ? 'column' : 'row', minHeight: 0 }}>

          {/* ── LEFT PANEL: Customer + Quote details ── */}
          <div style={{
            width: mobile ? '100%' : 320, flexShrink: 0,
            borderRight: mobile ? 'none' : `1px solid ${C.line}`,
            borderBottom: mobile ? `1px solid ${C.line}` : 'none',
            overflowY: mobile ? 'visible' : 'auto',
            padding: '20px 20px 24px',
            display: 'flex', flexDirection: 'column', gap: 22,
          }}>

            {/* ── CUSTOMER ── */}
            <section>
              {/* Customer / Prospect toggle */}
              <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 9, padding: 3, marginBottom: 14 }}>
                {[{ val: false, label: 'Customer' }, { val: true, label: 'Prospect' }].map(opt => (
                  <button key={String(opt.val)}
                    onClick={() => {
                      if (opt.val === useProspect) return;
                      setUseProspect(opt.val);
                      if (opt.val) { clearCustomer(); }
                    }}
                    style={{
                      flex: 1, border: 0, borderRadius: 7, padding: '7px 0', fontSize: 12.5, fontWeight: 700,
                      cursor: 'pointer', transition: 'all .15s',
                      background: useProspect === opt.val ? C.card : 'transparent',
                      color: useProspect === opt.val ? C.ink : C.muted,
                      boxShadow: useProspect === opt.val ? '0 1px 4px rgba(0,0,0,.10)' : 'none',
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Customer mode */}
              {!useProspect && (
                customer ? (
                  /* Confirmed customer card */
                  <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 9, padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{customer.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          {[customer.contact_person, customer.phone].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <button onClick={clearCustomer}
                        style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 7, padding: '4px 9px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', color: C.muted, flexShrink: 0 }}>
                        Change
                      </button>
                    </div>
                    <Badge color={form.tax_status === 'exempt' ? 'amber' : 'blue'}>
                      {form.tax_status === 'exempt' ? 'VAT Exempt' : 'Taxable · 16% VAT'}
                    </Badge>
                  </div>
                ) : (
                  /* Customer search */
                  <div style={{ position: 'relative' }}>
                    <input value={custQ} onChange={e => setCustQ(e.target.value)} placeholder="Search customers…"
                      style={inpStyle('customer')} />
                    <ErrTip k="customer" />
                    {custLoading && <span style={{ position: 'absolute', right: 10, top: 10, fontSize: 11, color: C.muted }}>searching…</span>}
                    {custResults.length > 0 && (
                      <div style={{ position: 'absolute', zIndex: 10, marginTop: 3, width: '100%', background: C.card, border: `1px solid ${C.line}`, borderRadius: 9, boxShadow: '0 6px 20px rgba(0,0,0,.12)', maxHeight: 200, overflowY: 'auto' }}>
                        {custResults.map(c => (
                          <button key={c.id} onClick={() => selectCustomer(c)}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 13px', border: 0, background: 'none', cursor: 'pointer', borderBottom: `1px solid ${C.line}` }}>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                            <div style={{ fontSize: 11, color: C.muted }}>{c.phone || c.email || ''}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}

              {/* Prospect mode */}
              {useProspect && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <label style={lbl}>Name *</label>
                    <input value={form.prospect_name} onChange={e => patchForm('prospect_name', e.target.value)}
                      placeholder="Company or person" style={inpStyle('prospect_name')} />
                    <ErrTip k="prospect_name" />
                  </div>
                  <div>
                    <label style={lbl}>Contact</label>
                    <input value={form.prospect_contact} onChange={e => patchForm('prospect_contact', e.target.value)}
                      placeholder="Phone or email" style={inpStyle()} />
                  </div>
                </div>
              )}

              {/* Enquiry picker — shown after customer is confirmed or in prospect mode */}
              {(customer || useProspect) && enquiries?.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <label style={lbl}>Linked enquiry</label>
                  <select value={form.enquiry_id} onChange={e => patchForm('enquiry_id', e.target.value)} style={inpStyle()}>
                    <option value="">— none —</option>
                    {enquiries.map(e => <option key={e.id} value={e.id}>{e.enq_num} · {e.customers?.name || e.prospect_name || 'Prospect'}</option>)}
                  </select>
                </div>
              )}
            </section>

            {/* ── QUOTE DETAILS ── */}
            <section>
              <h3 style={{ margin: '0 0 13px', fontSize: 13, fontWeight: 700, color: C.ink, textTransform: 'uppercase', letterSpacing: '.04em' }}>Quote details</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <div>
                  <label style={lbl}>Project description *</label>
                  <textarea value={form.project_description} onChange={e => patchForm('project_description', e.target.value)}
                    placeholder="What is this quote for?" rows={3}
                    style={{ ...inpStyle('project_description'), resize: 'vertical' }} />
                  <ErrTip k="project_description" />
                </div>
                <div>
                  <label style={lbl}>Payment terms</label>
                  <select value={form.payment_terms} onChange={e => patchForm('payment_terms', e.target.value)} style={inpStyle()}>
                    {PAYMENT_TERMS_QT.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Valid until *</label>
                  <input type="date" value={form.valid_until} onChange={e => patchForm('valid_until', e.target.value)} style={inpStyle('valid_until')} />
                  <ErrTip k="valid_until" />
                </div>
                <div>
                  <label style={lbl}>VAT pricing</label>
                  <select value={form.pricing_mode} onChange={e => patchForm('pricing_mode', e.target.value)} style={inpStyle()}>
                    {PRICING_MODES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              </div>
            </section>

          </div>

          {/* ── RIGHT PANEL: Line items ── */}
          <div style={{ flex: 1, overflowY: mobile ? 'visible' : 'auto', padding: '20px 20px 24px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>

            {/* ── Line item editor (shared component) ── */}
            <LineItemEditor
              mode="quote"
              items={items}
              charges={charges}
              pricingMode={form.pricing_mode}
              taxStatus={form.tax_status}
              submitted={submitted}
              valErrs={valErrs}
              narrowPanel={narrowPanel}
              onChange={setItems}
              onChargesChange={setCharges}
            />

          </div>

        </div>

        {/* ── Sticky footer ── */}
        <div style={{ flexShrink: 0, padding: '14px 24px', borderTop: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Btn onClick={onClose}>Cancel</Btn>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn onClick={() => save('draft')} disabled={saving || previewing}>
              {saving ? 'Saving…' : 'Save Draft'}
            </Btn>
            <Btn onClick={previewPdf} disabled={saving || previewing}>
              {previewing ? 'Opening…' : 'Preview PDF'}
            </Btn>
            <Btn primary onClick={() => save('sent')} disabled={saving || previewing}>
              {saving ? 'Saving…' : 'Save and Mark Sent'}
            </Btn>
          </div>
        </div>

      </div>
    </div>,
    portalRef?.current ?? document.body,
  );
}

// ─── Enquiry form modal ────────────────────────────────────────────────────────
function EnquiryFormModal({ onSave, onClose, prefill = {} }) {
  const [form, setForm] = useState({ prospect_name: prefill.prospect_name || '', prospect_contact: prefill.prospect_contact || '', description: '', category: '', source: 'whatsapp', estimated_value: '', stage: 'new' });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');
  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    setErr('');
    if (!form.prospect_name?.trim()) { setErr('Customer or prospect name is required'); return; }
    if (!form.description?.trim())   { setErr('Please describe what they are enquiring about'); return; }
    setSaving(true);
    const payload = {
      prospect_name:    form.prospect_name.trim(),
      prospect_contact: form.prospect_contact.trim() || undefined,
      description:      form.description.trim(),
      category:         form.category.trim() || undefined,
      source:           form.source || 'whatsapp',
      estimated_value:  form.estimated_value ? parseInt(form.estimated_value, 10) : 0,
      stage:            'new',
    };
    const res  = await fetch('/api/crm/enquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setErr(json.error || 'Failed to create enquiry'); return; }
    onSave();
  };

  return (
    <Modal title="New Enquiry" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save Enquiry'}</Btn></>}>
      {err && <Notice color="red" style={{ marginBottom: 12 }}>{err}</Notice>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Customer or prospect name *"><Fi value={form.prospect_name} onChange={f('prospect_name')} placeholder="Name" /></Field>
        <Field label="Source">
          <Fs value={form.source} onChange={f('source')}>
            {['whatsapp', 'email', 'walk_in', 'referral', 'instagram', 'website', 'architect'].map(s => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </Fs>
        </Field>
        <Field label="What are they enquiring about? *" full><Fta rows={3} value={form.description} onChange={f('description')} placeholder="Short requirement" /></Field>
        <Field label="Category"><Fi value={form.category} onChange={f('category')} placeholder="Mirror, furniture, frames…" /></Field>
        <Field label="Estimated value (KES)"><Fi type="number" value={form.estimated_value} onChange={f('estimated_value')} /></Field>
        <Field label="Contact"><Fi value={form.prospect_contact} onChange={f('prospect_contact')} placeholder="Phone or email" /></Field>
      </div>
    </Modal>
  );
}

// ─── Pipeline tab ─────────────────────────────────────────────────────────────
const STAGE_ORDER = ['new', 'contacted', 'quoted', 'won', 'lost'];
const KANBAN_COL  = { new: C.blueBg, contacted: C.amberBg, quoted: '#ede9f7', won: C.greenBg, lost: C.redBg };

function PipelineTab({ enquiries, stats }) {
  const columns = STAGE_ORDER.map(stage => ({ stage, items: enquiries.filter(e => e.stage === stage) }));
  const kpis = [
    { label: 'Open Pipeline',         value: `KES ${fmtKes(stats?.pipelineValue)}`,        sub: 'Draft and sent quotes only' },
    { label: 'Total Enquiries',        value: stats?.totalEnquiries ?? '—',                  sub: 'All time' },
    { label: 'Quotes Awaiting Reply',  value: stats?.quoteFunnel?.sent ?? '—',               sub: 'Sent, not accepted/rejected' },
    { label: 'Follow-ups Overdue',     value: stats?.followups?.overdue ?? '—',              sub: 'Action required', alert: (stats?.followups?.overdue || 0) > 0 },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {kpis.map(k => <StatCard key={k.label} {...k} />)}
      </div>
      <Panel>
        <PanelHead title="Sales Pipeline" sub="Five stages only. Follow-up is a task date, not a stage." />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STAGE_ORDER.length}, minmax(205px, 1fr))`, gap: 11, padding: 14, overflowX: 'auto' }}>
          {columns.map(({ stage, items }) => (
            <div key={stage} style={{ background: '#f1efeb', borderRadius: 10, padding: 9, minWidth: 205 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', margin: '2px 4px 10px' }}>
                <span>{stage}</span>
                <span style={{ background: '#fff', padding: '2px 7px', borderRadius: 20, fontSize: 10 }}>{items.length}</span>
              </div>
              {items.length === 0 && (
                <div style={{ textAlign: 'center', padding: '20px 0', color: C.muted, fontSize: 11, border: `2px dashed ${C.line}`, borderRadius: 9 }}>Empty</div>
              )}
              {items.map(e => (
                <div key={e.id} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 9, padding: 11, marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.customers?.name || e.prospect_name || '—'}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, margin: '5px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.title || e.category || '—'}
                  </div>
                  {e.estimated_value > 0 && (
                    <div style={{ fontSize: 13, fontWeight: 800, color: C.green }}>KES {fmtKes(e.estimated_value)}</div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 10.5 }}>
                    <Chip>{(e.source || '—').replace('_', ' ')}</Chip>
                    <span style={{ color: C.muted }}>{fmtDate(e.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// ─── Enquiries tab ────────────────────────────────────────────────────────────
function EnquiriesTab({ onRefresh, refreshKey = 0 }) {
  const [enquiries, setEnquiries] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [stage, setStage]         = useState('');
  const [q, setQ]                 = useState('');
  const [showForm, setShowForm]   = useState(false);
  const [expanded, setExpanded]   = useState(null); // enquiry id
  const [advancing, setAdvancing] = useState(null); // enquiry id being updated

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (stage) params.set('stage', stage);
    if (q)     params.set('q', q);
    const res = await fetch(`/api/crm/enquiries?${params}`);
    const json = await res.json();
    setEnquiries(json.data || []);
    setLoading(false);
  }, [stage, q, refreshKey]);

  useEffect(() => { load(); }, [load]);

  const advanceStage = async (enqId, newStage) => {
    setAdvancing(enqId);
    try {
      const res = await fetch(`/api/crm/enquiries/${enqId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: newStage }),
      });
      if (res.ok) { load(); onRefresh(); }
    } finally {
      setAdvancing(null);
    }
  };

  return (
    <div>
      <Panel>
        <PanelHead title="Enquiries" sub="New, Contacted, Quoted, Won or Lost. Quoted and Won update automatically."
          actions={<Btn primary small onClick={() => setShowForm(true)}>+ New Enquiry</Btn>} />
        <Toolbar>
          <TInput value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, enquiry or description" />
          <TSelect value={stage} onChange={e => setStage(e.target.value)}>
            <option value="">All stages</option>
            {STAGE_ORDER.map(s => <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>)}
          </TSelect>
        </Toolbar>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>{['Enquiry', 'Customer / Prospect', 'What they need', 'Source', 'Stage', 'Created', ''].map(h => <Th key={h}>{h}</Th>)}</tr>
              </thead>
              <tbody>
                {enquiries.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px 0', color: C.muted }}>No enquiries found</td></tr>
                )}
                {enquiries.map(e => {
                  const isOpen = expanded === e.id;
                  const pendingFollowup = (e.followups || []).find(f => !f.completed_at);
                  return (
                    <React.Fragment key={e.id}>
                      <tr style={{ background: C.card, borderBottom: isOpen ? 'none' : undefined }}>
                        <Td><strong>{e.enq_num || '—'}</strong></Td>
                        <Td>{e.customers?.name || e.prospect_name || '—'}</Td>
                        <Td style={{ maxWidth: 240 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || '—'}</div></Td>
                        <Td>{e.source ? <Chip>{e.source.replace('_', ' ')}</Chip> : '—'}</Td>
                        <Td><Badge color={stageColor[e.stage] || 'gray'}>{e.stage}</Badge></Td>
                        <Td style={{ color: C.muted, whiteSpace: 'nowrap' }}>{fmtDate(e.created_at)}</Td>
                        <Td><Btn small onClick={() => setExpanded(isOpen ? null : e.id)}>{isOpen ? 'Close' : 'View'}</Btn></Td>
                      </tr>
                      {isOpen && (
                        <tr style={{ background: C.coralBg }}>
                          <td colSpan={7} style={{ padding: '14px 16px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px 24px', fontSize: 12.5 }}>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Description</div>
                                <div style={{ color: C.ink }}>{e.description || '—'}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Category</div>
                                <div style={{ color: C.ink }}>{e.category || '—'}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Estimated Value</div>
                                <div style={{ color: C.ink }}>KES {(e.estimated_value || 0).toLocaleString('en-KE')}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Contact</div>
                                <div style={{ color: C.ink }}>{e.prospect_contact || e.customers?.phone || '—'}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Next Follow-up</div>
                                <div style={{ color: pendingFollowup ? C.ink : C.muted }}>{pendingFollowup ? fmtDate(pendingFollowup.due_date) : 'None scheduled'}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>Stage</div>
                                <Badge color={stageColor[e.stage] || 'gray'}>{e.stage}</Badge>
                              </div>
                            </div>
                            {/* Stage actions — only show relevant forward moves */}
                            {(e.stage === 'new' || e.stage === 'contacted') && (
                              <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                                {e.stage === 'new' && (
                                  <Btn small primary
                                    disabled={advancing === e.id}
                                    onClick={() => advanceStage(e.id, 'contacted')}>
                                    {advancing === e.id ? 'Saving…' : 'Mark as Contacted'}
                                  </Btn>
                                )}
                                {(e.stage === 'new' || e.stage === 'contacted') && (
                                  <Btn small
                                    style={{ color: C.red, border: `1px solid ${C.red}` }}
                                    disabled={advancing === e.id}
                                    onClick={() => advanceStage(e.id, 'lost')}>
                                    Mark as Lost
                                  </Btn>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {showForm && <EnquiryFormModal onSave={() => { setShowForm(false); load(); onRefresh(); }} onClose={() => setShowForm(false)} />}
    </div>
  );
}

// ─── Quotations tab ───────────────────────────────────────────────────────────
// Statuses still shown in the filter dropdown (superseded quotes from old revisions can still be viewed)
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'];

function QuotationsTab({ onRefresh, refreshKey = 0 }) {
  const { ref: portalRef, isActive } = React.useContext(CrmPortalContext);
  const [quotes, setQuotes]             = useState([]);
  const [loading, setLoading]           = useState(true);
  const [status, setStatus]             = useState('');
  const [q, setQ]                       = useState('');
  const [converting, setConv]           = useState(null);
  const [actioning, setActioning]       = useState(null);
  const [convErr, setConvErr]           = useState('');
  const [showForm, setShowForm]         = useState(false);
  const [editQuote, setEditQuote]       = useState(null);
  const [expanded, setExpanded]         = useState(null);
  const [enquiries, setEnquiries]       = useState([]);
  // changelog entries keyed by quotation id, loaded lazily on expand
  const [changelog, setChangelog]       = useState({});
  // { type: 'accept'|'reject'|'revise'|'convert', qt }
  const [confirmAction, setConfirmAction] = useState(null);
  useQuickActionsLock(!!confirmAction && isActive);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (q)      params.set('q', q);
    const res = await fetch(`/api/crm/quotations?${params}`);
    const json = await res.json();
    setQuotes(json.data || []);
    setLoading(false);
  }, [status, q, refreshKey]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetch('/api/crm/enquiries?limit=100').then(r => r.json()).then(j => setEnquiries(j.data || [])).catch(() => {}); }, []);

  const downloadPdf = async (id, num) => {
    const res = await fetch(`/api/crm/quotations/${id}/pdf`);
    if (!res.ok) { alert('PDF generation failed'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = `${num || id}_Quote.pdf`; a.click();
    URL.revokeObjectURL(url);
  };

  const convert = async (id) => {
    setConv(id); setConvErr('');
    const res  = await fetch(`/api/crm/quotations/${id}/convert`, { method: 'POST' });
    const json = await res.json();
    setConv(null);
    if (!res.ok) { setConvErr(json.error || 'Conversion failed'); return; }
    setConvErr('');
    load(); onRefresh();
  };

  const patchStatus = async (id, newStatus) => {
    setActioning(id);
    const res  = await fetch(`/api/crm/quotations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
    const json = await res.json();
    setActioning(null);
    if (!res.ok) { setConvErr(json.error || 'Action failed'); return; }
    setConvErr('');
    load();
  };

  const openEdit = async (qt) => {
    const res  = await fetch(`/api/crm/quotations/${qt.id}`);
    const json = await res.json();
    if (!res.ok) { alert(json.error || 'Could not load quote'); return; }
    setEditQuote(json.data); setShowForm(true);
  };

  const toggleExpand = async (id) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    // Lazily load changelog for this quote if not already fetched
    if (next && !changelog[next]) {
      const res  = await fetch(`/api/crm/quotations/${next}`);
      const json = await res.json();
      if (res.ok) {
        setChangelog(prev => ({ ...prev, [next]: json.data?.quote_activities || [] }));
      }
    }
  };

  const onFormSave = () => { setShowForm(false); setEditQuote(null); load(); onRefresh(); };

  return (
    <div>
      <Panel>
        <PanelHead title="Quotations" sub="Draft, Sent, Accepted, Rejected, Expired or Superseded."
          actions={<Btn primary small onClick={() => { setEditQuote(null); setShowForm(true); }}>+ New Quote</Btn>} />
        <Toolbar>
          <TInput value={q} onChange={e => setQ(e.target.value)} placeholder="Search quote, customer or project" />
          <TSelect value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {QUOTE_STATUSES.map(s => <option key={s} value={s} style={{ textTransform: 'capitalize' }}>{s}</option>)}
          </TSelect>
        </Toolbar>

        {convErr && <Notice color="red" style={{ margin: '10px 16px' }}>{convErr}</Notice>}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <Th>Quote</Th><Th>Customer</Th><Th>Project</Th>
                  <Th right>Total incl. VAT</Th><Th>Status</Th><Th>Valid Until</Th><Th>Action</Th>
                </tr>
              </thead>
              <tbody>
                {quotes.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px 0', color: C.muted }}>No quotations found</td></tr>
                )}
                {quotes.map(qt => {
                  const busy = actioning === qt.id || converting === qt.id;
                  const isExp = expanded === qt.id;
                  return (
                    <>
                      <tr key={qt.id} style={{ background: isExp ? C.bg : C.card, borderBottom: `1px solid ${C.line}` }}>
                        <Td>
                          <button onClick={() => toggleExpand(qt.id)} style={{ border: 0, background: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: C.ink, padding: 0 }}>
                            {qt.quote_num || '—'}
                          </button>
                          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>Rev {qt.revision || 1}</div>
                        </Td>
                        <Td>{qt.customers?.name || qt.prospect_name || '—'}
                          <div style={{ fontSize: 10.5, color: C.muted }}>{qt.customers ? 'Customer' : 'Prospect'}</div>
                        </Td>
                        <Td style={{ maxWidth: 200 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{qt.project_description || '—'}</div>
                        </Td>
                        <Td right><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{qt.total ? `KES ${fmtKes(qt.total)}` : '—'}</strong></Td>
                        <Td><Badge color={statusColor[qt.status] || 'gray'}>{qt.status}</Badge></Td>
                        <Td style={{ color: C.muted, whiteSpace: 'nowrap', fontSize: 11 }}>{fmtDate(qt.valid_until)}</Td>
                        <Td>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                            <Btn small onClick={() => downloadPdf(qt.id, qt.quote_num)}>PDF</Btn>
                            {/* Any quote that hasn't been converted can still be edited */}
                            {!qt.converted_order_id && <Btn small onClick={() => openEdit(qt)} disabled={busy}>Edit</Btn>}
                            {qt.status === 'draft' && <Btn small primary onClick={() => patchStatus(qt.id, 'sent')} disabled={busy}>{busy ? '…' : 'Send'}</Btn>}
                            {qt.status === 'sent' && <>
                              <Btn small
                                onClick={() => setConfirmAction({ type: 'accept', qt })}
                                disabled={busy || !qt.customer_id}
                                title={!qt.customer_id ? 'Edit quote and link to a customer profile before accepting' : 'Mark as accepted'}
                                style={{ background: C.greenBg, color: qt.customer_id ? C.green : C.muted, border: `1px solid ${qt.customer_id ? C.greenBd : C.line}` }}>
                                {busy ? '…' : 'Accept'}
                              </Btn>
                              <Btn small onClick={() => setConfirmAction({ type: 'reject', qt })} disabled={busy} style={{ background: C.redBg, color: C.red, border: `1px solid ${C.redBd}` }}>{busy ? '…' : 'Reject'}</Btn>
                            </>}
                            {qt.status === 'accepted' && !qt.converted_order_id && (
                              <Btn small primary
                                onClick={() => setConfirmAction({ type: 'convert', qt })}
                                disabled={busy || !qt.customer_id}
                                title={!qt.customer_id ? 'Link to a real customer profile before converting' : 'Convert to order'}
                              >{busy ? '…' : 'Convert to Order'}</Btn>
                            )}
                            {qt.converted_order_id && (
                              <>
                                <Badge color="green">Converted</Badge>
                                {qt.orders?.invoice_number && (
                                  <Btn small style={{ marginLeft: 4 }}
                                    onClick={() => window.open(`/api/crm/quotations/${qt.id}/pdf?invoice=1`, '_blank')}
                                    title={`Download Invoice ${qt.orders.invoice_number}`}>
                                    Invoice PDF
                                  </Btn>
                                )}
                              </>
                            )}
                          </div>
                        </Td>
                      </tr>

                      {isExp && (
                        <tr key={`${qt.id}-exp`}>
                          <td colSpan={7} style={{ background: C.bg, borderBottom: `1px solid ${C.line}`, padding: '0 16px 16px' }}>
                            {(() => {
                              const allItems   = [...(qt.quote_items || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                              const products   = allItems.filter(it => (it.line_type || 'product') === 'product');
                              const charges    = allItems.filter(it => (it.line_type || 'product') !== 'product');
                              const thStyle    = { textAlign: 'left', color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', paddingBottom: 5, paddingRight: 14, fontWeight: 700, whiteSpace: 'nowrap' };
                              const tdStyle    = { paddingRight: 14, paddingTop: 5, paddingBottom: 5, fontSize: 12, verticalAlign: 'top' };
                              const numStyle   = { ...tdStyle, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
                              const sectionLbl = (txt) => (
                                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.muted, marginTop: 14, marginBottom: 4 }}>{txt}</div>
                              );

                              // Products table
                              const ProductsTable = products.length > 0 && (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      {['#', 'Description', 'Qty', 'Unit Price', 'Disc %', 'Net', 'VAT', 'Gross'].map(h => (
                                        <th key={h} style={{ ...thStyle, textAlign: ['Qty','Unit Price','Disc %','Net','VAT','Gross'].includes(h) ? 'right' : 'left' }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {products.map((it, i) => (
                                      <tr key={it.id} style={{ borderTop: `1px solid ${C.line}` }}>
                                        <td style={{ ...tdStyle, color: C.muted, width: 20 }}>{i + 1}</td>
                                        <td style={{ ...tdStyle, maxWidth: 260 }}>{it.description || '—'}</td>
                                        <td style={{ ...numStyle }}>{it.quantity}</td>
                                        <td style={{ ...numStyle }}>{fmtKes(it.unit_price)}</td>
                                        <td style={{ ...numStyle }}>{it.discount_pct > 0 ? `${it.discount_pct}%` : '—'}</td>
                                        <td style={{ ...numStyle }}>{fmtKes(it.net_amount)}</td>
                                        <td style={{ ...numStyle }}>{fmtKes(it.vat_amount)}</td>
                                        <td style={{ ...numStyle, fontWeight: 700, color: C.ink }}>{fmtKes(it.gross_amount)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              );

                              // Charges table
                              const ChargesTable = charges.length > 0 && (
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      {['Type', 'Description', 'Amount'].map(h => (
                                        <th key={h} style={{ ...thStyle, textAlign: h === 'Amount' ? 'right' : 'left' }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {charges.map(it => (
                                      <tr key={it.id} style={{ borderTop: `1px solid ${C.line}` }}>
                                        <td style={{ ...tdStyle, width: 120 }}><Chip>{it.line_type}</Chip></td>
                                        <td style={tdStyle}>{it.description || '—'}</td>
                                        <td style={{ ...numStyle, fontWeight: 700 }}>KES {fmtKes(it.gross_amount)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              );

                              // Totals block
                              const productNet  = products.reduce((s, it) => s + parseFloat(it.net_amount  || 0), 0);
                              const productVat  = products.reduce((s, it) => s + parseFloat(it.vat_amount  || 0), 0);
                              const productGross= products.reduce((s, it) => s + parseFloat(it.gross_amount|| 0), 0);
                              const chargeGross = charges.reduce((s, it)  => s + parseFloat(it.gross_amount|| 0), 0);
                              const grandTotal  = productGross + chargeGross;

                              const TotalsBlock = allItems.length > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                                  <div style={{ minWidth: 240, background: C.card, borderRadius: 8, border: `1px solid ${C.line}`, overflow: 'hidden' }}>
                                    {[
                                      { label: 'Items subtotal (net)', value: `KES ${fmtKes(productNet)}`,   muted: true },
                                      { label: 'VAT (16%)',            value: `KES ${fmtKes(productVat)}`,   muted: true },
                                      ...(chargeGross > 0 ? [{ label: 'Additional charges', value: `KES ${fmtKes(chargeGross)}`, muted: true }] : []),
                                      { label: 'Grand Total',          value: `KES ${fmtKes(grandTotal)}`,   grand: true },
                                    ].map((r, i) => (
                                      <div key={i} style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        padding: '6px 12px',
                                        background: r.grand ? '#E8512A' : 'transparent',
                                        borderTop: i > 0 ? `1px solid ${C.line}` : 'none',
                                      }}>
                                        <span style={{ fontSize: 11, color: r.grand ? '#fff' : C.muted }}>{r.label}</span>
                                        <span style={{ fontSize: r.grand ? 13 : 12, fontWeight: r.grand ? 800 : 600, fontVariantNumeric: 'tabular-nums', color: r.grand ? '#fff' : C.ink }}>{r.value}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );

                              // Change log — show all activity types, split 'edited' entries into per-change lines
                              const log = changelog[qt.id];
                              const TYPE_COLOR = {
                                created: C.green, edited: '#2563eb', status_change: '#7c3aed',
                                superseded: C.muted, converted: C.green,
                              };
                              const TYPE_LABEL = {
                                created: 'created', edited: 'edited', status_change: 'status',
                                superseded: 'superseded', converted: 'converted',
                              };
                              const ChangeLog = (
                                <div style={{ marginTop: 16, borderTop: `1px dashed ${C.line}`, paddingTop: 10 }}>
                                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.muted, marginBottom: 8 }}>
                                    Revision Log <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(internal)</span>
                                  </div>
                                  {!log ? (
                                    <div style={{ fontSize: 11, color: C.muted }}>Loading…</div>
                                  ) : log.length === 0 ? (
                                    <div style={{ fontSize: 11, color: C.muted }}>No activity recorded.</div>
                                  ) : log.map(entry => {
                                    const typeColor = TYPE_COLOR[entry.activity_type] || C.muted;
                                    const typeLabel = TYPE_LABEL[entry.activity_type] || entry.activity_type;
                                    // Split 'edited' descriptions on ' · ' to show one bullet per change
                                    const lines = entry.activity_type === 'edited'
                                      ? (entry.description || '').split(' · ').filter(Boolean)
                                      : [entry.description];
                                    return (
                                      <div key={entry.id} style={{
                                        display: 'flex', gap: 10, fontSize: 11.5,
                                        marginBottom: 10, alignItems: 'flex-start',
                                        paddingBottom: 10, borderBottom: `1px solid ${C.line}`,
                                      }}>
                                        {/* Timestamp + type badge — fixed left column */}
                                        <div style={{ flexShrink: 0, minWidth: 140 }}>
                                          <div style={{ color: C.muted, fontSize: 10.5, whiteSpace: 'nowrap' }}>
                                            {new Date(entry.created_at).toLocaleString('en-KE', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                          </div>
                                          <div style={{ marginTop: 3 }}>
                                            <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '1px 6px', borderRadius: 4, background: typeColor + '18', color: typeColor, border: `1px solid ${typeColor}40` }}>
                                              {typeLabel}
                                            </span>
                                          </div>
                                        </div>
                                        {/* Change lines */}
                                        <div style={{ flex: 1 }}>
                                          {lines.map((line, li) => {
                                            // Highlight KES amounts and arrows
                                            const parts = line.split(/(KES [\d,]+(?:\.\d+)?|→)/g);
                                            return (
                                              <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: li < lines.length - 1 ? 4 : 0 }}>
                                                {entry.activity_type === 'edited' && lines.length > 1 && (
                                                  <span style={{ color: C.muted, flexShrink: 0, fontSize: 10 }}>–</span>
                                                )}
                                                <span style={{ color: C.ink }}>
                                                  {parts.map((p, pi) => {
                                                    if (p === '→') return <span key={pi} style={{ color: C.muted, margin: '0 2px' }}>→</span>;
                                                    if (/^KES /.test(p)) return <span key={pi} style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: C.ink }}>{p}</span>;
                                                    return <span key={pi}>{p}</span>;
                                                  })}
                                                </span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              );

                              return (
                                <>
                                  {products.length > 0 && <>{sectionLbl('Line Items')}{ProductsTable}</>}
                                  {charges.length > 0  && <>{sectionLbl('Additional Charges')}{ChargesTable}</>}
                                  {TotalsBlock}
                                  {ChangeLog}
                                </>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Notice color="amber">
        <strong>Conversion guard:</strong> the quotation must be Accepted and linked to a real customer profile. Conversion copies the accepted quote snapshot into the existing order tables and starts the order at <strong>Quote Approved</strong>.
      </Notice>

      {showForm && <QuoteFormModal quote={editQuote} enquiries={enquiries} onSave={onFormSave} onClose={() => { setShowForm(false); setEditQuote(null); }} />}

      {/* ── Confirm action overlay ── */}
      {confirmAction && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '26px 28px', maxWidth: 420, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
            {(() => {
              const { type, qt } = confirmAction;
              const cfg = {
                accept:  { title: 'Accept quote?',     body: `Mark ${qt.quote_num} as accepted. This signals the client has agreed.`,          btnLabel: 'Accept',           btnColor: C.green, btnBg: C.greenBg, btnBd: C.greenBd },
                reject:  { title: 'Reject quote?',     body: `Mark ${qt.quote_num} as rejected. The quote will be closed.`,                    btnLabel: 'Reject',           btnColor: C.red,   btnBg: C.redBg,   btnBd: C.redBd },
                convert: { title: 'Convert to order?', body: `Convert ${qt.quote_num} to a production order. This cannot be undone.`,          btnLabel: 'Convert to Order', btnColor: '#fff',  btnBg: C.coral,   btnBd: C.coral },
              }[type] || {};
              const doAction = async () => {
                setConfirmAction(null);
                if (type === 'accept')  await patchStatus(qt.id, 'accepted');
                if (type === 'reject')  await patchStatus(qt.id, 'rejected');
                if (type === 'convert') await convert(qt.id);
              };
              return (
                <>
                  <h3 style={{ margin: '0 0 10px', fontSize: 17, fontWeight: 800, color: C.ink }}>{cfg.title}</h3>
                  <p style={{ margin: '0 0 22px', fontSize: 13.5, color: C.muted, lineHeight: 1.55 }}>{cfg.body}</p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Btn onClick={() => setConfirmAction(null)}>Cancel</Btn>
                    <button onClick={doAction}
                      style={{ border: `1px solid ${cfg.btnBd}`, background: cfg.btnBg, color: cfg.btnColor, borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      {cfg.btnLabel}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>,
        portalRef?.current ?? document.body,
      )}
    </div>
  );
}

// ─── Follow-ups tab ───────────────────────────────────────────────────────────
function FollowupsTab({ onRefresh, refreshKey = 0 }) {
  const [followups, setFollowups]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState('pending');
  const [completing, setCompleting] = useState(null);
  const [nextDue, setNextDue]       = useState({});
  const [nextNote, setNextNote]     = useState({});
  const [showNew, setShowNew]       = useState(false);
  const [newForm, setNewForm]       = useState({ enquiry_id: '', quotation_id: '', due_date: '', note: '' });
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');
  const [enqList, setEnqList]       = useState([]);
  const [qtList, setQtList]         = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter === 'pending') params.set('pending', '1');
    const res  = await fetch(`/api/crm/followups?${params}`);
    const json = await res.json();
    const data = (json.data || []).sort((a, b) => {
      const aO = isOverdue(a.due_date) && !a.completed_at;
      const bO = isOverdue(b.due_date) && !b.completed_at;
      if (aO && !bO) return -1; if (!aO && bO) return 1;
      return new Date(a.due_date) - new Date(b.due_date);
    });
    setFollowups(data); setLoading(false);
  }, [filter, refreshKey]);

  useEffect(() => { load(); }, [load]);

  // Load enquiries + quotations for dropdowns
  useEffect(() => {
    fetch('/api/crm/enquiries?limit=200').then(r => r.json()).then(j => setEnqList(j.data || [])).catch(() => {});
    fetch('/api/crm/quotations?limit=200').then(r => r.json()).then(j => setQtList(j.data || [])).catch(() => {});
  }, []);

  const complete = async (id) => {
    setCompleting(id);
    await fetch(`/api/crm/followups/${id}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_due_date: nextDue[id] || undefined, next_note: nextNote[id] || undefined }),
    });
    setCompleting(null); load(); onRefresh();
  };

  const submitNew = async () => {
    setErr(''); setSaving(true);
    const body = { ...newForm };
    if (!body.enquiry_id)   delete body.enquiry_id;
    if (!body.quotation_id) delete body.quotation_id;
    const res  = await fetch('/api/crm/followups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setErr(json.error || 'Failed'); return; }
    setShowNew(false); setNewForm({ enquiry_id: '', quotation_id: '', due_date: '', note: '' }); load();
  };

  return (
    <div>
      <Panel>
        <PanelHead title="Follow-ups" sub="One work queue sorted overdue first. Completing a follow-up asks for the next action date."
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ display: 'flex', border: `1px solid ${C.line}`, borderRadius: 8, overflow: 'hidden' }}>
                {['pending', 'all'].map(f => (
                  <button key={f} onClick={() => setFilter(f)} style={{ border: 0, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', background: filter === f ? C.coral : 'transparent', color: filter === f ? '#fff' : C.muted, textTransform: 'capitalize' }}>{f}</button>
                ))}
              </div>
              <Btn small primary onClick={() => setShowNew(true)}>+ New Follow-up</Btn>
            </div>
          } />

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : followups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: C.muted, fontSize: 13 }}>No follow-ups</div>
        ) : (
          followups.map(f => {
            const over  = isOverdue(f.due_date) && !f.completed_at;
            const today = isToday(f.due_date) && !f.completed_at;
            return (
              <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 12, alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${C.line}` }}>
                <div style={{ padding: '6px 8px', borderRadius: 7, textAlign: 'center', fontSize: 11, fontWeight: 800,
                  background: over ? C.redBg : today ? C.amberBg : C.bg,
                  color: over ? C.red : today ? C.amber : C.muted }}>
                  {over ? 'Overdue' : today ? 'Today' : fmtDate(f.due_date)}
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: C.ink }}>
                    {f.enquiries ? (f.enquiries.customers?.name || f.enquiries.prospect_name || '—') :
                     f.quotations ? `${f.quotations.customers?.name || f.quotations.prospect_name || '—'} · ${f.quotations.quote_num || ''}` : '—'}
                  </div>
                  {f.note && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{f.note}</div>}
                  {f.completed_at && <div style={{ fontSize: 11, color: C.green, marginTop: 2 }}>✓ Completed {fmtDate(f.completed_at)}</div>}
                </div>
                {!f.completed_at && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }}>
                    <div style={{ display: 'flex', gap: 5 }}>
                      <input type="date" value={nextDue[f.id] || ''} onChange={e => setNextDue(d => ({ ...d, [f.id]: e.target.value }))}
                        style={{ border: `1px solid ${C.line}`, borderRadius: 7, padding: '5px 8px', fontSize: 11, flex: 1, outline: 'none' }} />
                      <input value={nextNote[f.id] || ''} onChange={e => setNextNote(d => ({ ...d, [f.id]: e.target.value }))}
                        placeholder="Note" style={{ border: `1px solid ${C.line}`, borderRadius: 7, padding: '5px 8px', fontSize: 11, flex: 1, outline: 'none' }} />
                    </div>
                    <Btn small primary onClick={() => complete(f.id)} disabled={completing === f.id}>{completing === f.id ? '…' : 'Mark Complete'}</Btn>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Panel>

      {showNew && (
        <Modal title="New Follow-up" onClose={() => setShowNew(false)}
          footer={<><Btn onClick={() => setShowNew(false)}>Cancel</Btn><Btn primary onClick={submitNew} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn></>}>
          {err && <Notice color="red" style={{ marginBottom: 12 }}>{err}</Notice>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Link to Enquiry (optional)">
              <TSelect value={newForm.enquiry_id} onChange={e => setNewForm(f => ({ ...f, enquiry_id: e.target.value, quotation_id: '' }))}>
                <option value="">— None —</option>
                {enqList.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.enq_num} · {e.customers?.name || e.prospect_name || '—'}{e.category ? ` · ${e.category}` : ''}
                  </option>
                ))}
              </TSelect>
            </Field>
            <Field label="Link to Quotation (optional)">
              <TSelect value={newForm.quotation_id} onChange={e => setNewForm(f => ({ ...f, quotation_id: e.target.value, enquiry_id: '' }))}>
                <option value="">— None —</option>
                {qtList.map(q => (
                  <option key={q.id} value={q.id}>
                    {q.quote_num} · {q.customers?.name || q.prospect_name || '—'} · {q.status}
                  </option>
                ))}
              </TSelect>
            </Field>
            <Field label="Due Date *"><Fi type="date" value={newForm.due_date} onChange={e => setNewForm(f => ({ ...f, due_date: e.target.value }))} /></Field>
            <Field label="Note"><Fi value={newForm.note} onChange={e => setNewForm(f => ({ ...f, note: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Insights tab ─────────────────────────────────────────────────────────────
function InsightsTab({ refreshKey = 0 }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoad] = useState(true);
  useEffect(() => { fetch('/api/crm/insights').then(r => r.json()).then(j => { setStats(j.data || {}); setLoad(false); }); }, [refreshKey]);

  if (loading) return <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted }}>Loading…</div>;

  const kpis = [
    { label: 'Total Enquiries',  value: stats.totalEnquiries  || 0, sub: 'All time' },
    { label: 'Total Quotations', value: stats.totalQuotations || 0, sub: `${stats.conversionRate || 0}% enquiry-to-quote` },
    { label: 'Orders Won',       value: stats.quoteFunnel?.accepted || 0, sub: 'Accepted quotes' },
    { label: 'Pipeline Value',   value: `KES ${fmtKes(stats.pipelineValue)}`, sub: 'Open enquiries' },
  ];
  const stageCounts  = stats.stageCounts  || {};
  const sourceBreak  = stats.sourceBreakdown || {};
  const stageMax     = Math.max(...Object.values(stageCounts),  1);
  const sourceEntries = Object.entries(sourceBreak).sort((a, b) => b[1].count - a[1].count);
  const sourceMax    = Math.max(...sourceEntries.map(([, v]) => v.count), 1);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {kpis.map(k => <StatCard key={k.label} {...k} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Panel>
          <PanelHead title="Enquiry Stage Funnel" />
          <div style={{ padding: 16 }}>
            {STAGE_ORDER.map(s => (
              <MetricBar key={s} label={s} value={stageCounts[s] || 0} pct={Math.round(((stageCounts[s] || 0) / stageMax) * 100)} />
            ))}
          </div>
        </Panel>
        <Panel>
          <PanelHead title="Quote Funnel" />
          <div style={{ padding: 16 }}>
            {Object.entries(stats.quoteFunnel || {}).map(([s, count]) => {
              const max = Math.max(...Object.values(stats.quoteFunnel || {}), 1);
              return <MetricBar key={s} label={s} value={count} pct={Math.round(count / max * 100)} />;
            })}
          </div>
        </Panel>
        <Panel style={{ gridColumn: '1 / -1' }}>
          <PanelHead title="Lead Sources" />
          <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {sourceEntries.map(([src, d]) => (
              <div key={src} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: C.ink, textTransform: 'capitalize' }}>{src.replace('_', ' ')}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: C.muted }}>{d.count} enq</span>
                  {d.value > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: C.green }}>KES {fmtKes(d.value)}</span>}
                </div>
              </div>
            ))}
            {sourceEntries.length === 0 && <span style={{ fontSize: 12, color: C.muted }}>No data</span>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────
const TABS = ['Pipeline', 'Enquiries', 'Quotations', 'Invoices', 'Follow-ups', 'Insights'];

export default function CrmModule({ defaultAction, defaultCustomerId, defaultEnquiryId, workspaceActive = true, actionNonce, refreshKey = 0 } = {}) {
  const containerRef = useRef(null);
  const [tab, setTab]           = useState('Pipeline');
  // visited: Set of tab names that have been mounted at least once (lazy keep-mounted)
  const [visited, setVisited]   = useState(() => new Set(['Pipeline']));
  // tabState: per-tab { key (refresh counter), stale (needs reload on next visit) }
  const [tabState, setTabState] = useState(() =>
    Object.fromEntries(TABS.map(t => [t, { key: 0, stale: false }]))
  );
  const [enquiries, setEnq]     = useState([]);
  const [enqLoading, setEnqL]   = useState(true);
  const [stats, setStats]       = useState(null);
  const [showEnqForm, setShowEnqForm]   = useState(false);
  const [showQtForm,  setShowQtForm]    = useState(false);
  const [enqPrefill,  setEnqPrefill]    = useState({});

  // When the workspace refreshKey bumps (15-min staleness), immediately refresh
  // the active CRM tab and lazily mark all other visited tabs stale so they
  // re-fetch only when the user next opens them. Skip on initial mount (key === 0).
  useEffect(() => {
    if (refreshKey === 0) return;
    setTabState(ts => {
      const next = { ...ts };
      TABS.forEach(t => {
        if (t === tab) {
          next[t] = { key: ts[t].key + 1, stale: false };   // refresh now
        } else if (visited.has(t)) {
          next[t] = { ...ts[t], stale: true };               // lazy on next open
        }
      });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // refresh() — bumps the active tab immediately; marks all other visited tabs stale.
  // Stale tabs re-fetch when the user next activates them (not eagerly).
  const refresh = useCallback(() => {
    setTabState(ts => {
      const next = { ...ts };
      next[tab] = { key: ts[tab].key + 1, stale: false };
      TABS.forEach(t => {
        if (t !== tab && visited.has(t)) next[t] = { ...ts[t], stale: true };
      });
      return next;
    });
  }, [tab, visited]);

  // handleTabChange — switches tab, mounts it if first visit, refreshes if stale.
  const handleTabChange = useCallback((t) => {
    setTab(t);
    setVisited(prev => { const next = new Set(prev); next.add(t); return next; });
    setTabState(ts => {
      if (!ts[t].stale) return ts;
      return { ...ts, [t]: { key: ts[t].key + 1, stale: false } };
    });
  }, []);

  // Open form triggered by ?new= query param (from Quick Actions)
  useEffect(() => {
    if (defaultAction === 'enquiry') {
      handleTabChange('Enquiries');
      if (defaultCustomerId) {
        // Resolve customer so EnquiryFormModal can prefill prospect_name
        fetch('/api/customers').then(r => r.json()).then(j => {
          const found = (j.data || []).find(c => c.id === defaultCustomerId);
          setEnqPrefill(found ? { prospect_name: found.name, prospect_contact: found.phone || found.contact_person || '' } : {});
          setShowEnqForm(true);
        }).catch(() => setShowEnqForm(true));
      } else {
        setShowEnqForm(true);
      }
    } else if (defaultAction === 'quote') {
      handleTabChange('Quotations');
      setShowQtForm(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAction, actionNonce]);

  useEffect(() => {
    setEnqL(true);
    fetch('/api/crm/enquiries?limit=200')
      .then(r => r.json()).then(j => { setEnq(j.data || []); setEnqL(false); }).catch(() => setEnqL(false));
    fetch('/api/crm/insights')
      .then(r => r.json()).then(j => setStats(j.data || null)).catch(() => {});
  }, [tabState.Pipeline.key]);

  return (
    <CrmPortalContext.Provider value={{ ref: containerRef, isActive: workspaceActive }}>
    <div ref={containerRef} style={{ position: 'relative', maxWidth: 1220, margin: '0 auto', padding: '24px 20px 60px', background: C.bg, minHeight: '100vh' }}>

      {/* Module header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: C.ink }}>Quotes & CRM</h1>
          <p style={{ margin: '5px 0 0', color: C.muted, fontSize: 13 }}>Track enquiries, quotations and follow-ups without changing the existing order workflow.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={() => setShowQtForm(true)}>+ Direct Quote</Btn>
          <Btn primary onClick={() => setShowEnqForm(true)}>+ New Enquiry</Btn>
        </div>
      </div>

      {/* Lean flow rule */}
      <Notice color="blue" style={{ marginBottom: 18 }}>
        <strong>Lean flow:</strong> Enquiry is optional. Quotation is optional. Only an accepted quotation can convert to an order.
        The order then follows the existing workflow from <strong>Quote Approved</strong>. Quotations have no financial effect.
      </Notice>

      {/* Tabs */}
      <div style={{ display: 'flex', overflowX: 'auto', border: `1px solid ${C.line}`, background: C.card, borderRadius: 10, padding: '0 14px', marginBottom: 18 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => handleTabChange(t)} style={{
            border: 0, background: 'transparent', padding: '13px 4px', marginRight: 24,
            color: tab === t ? C.ink : C.muted, fontWeight: 700, fontSize: 13,
            borderBottom: `3px solid ${tab === t ? C.coral : 'transparent'}`,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{t}</button>
        ))}
      </div>

      {/* Tab bodies — lazy keep-mounted: mount on first visit, hide not unmount thereafter.
          CrmTabPane provides its own portal ref + isActive so modals are per-tab isolated. */}
      <CrmTabPane name="Pipeline" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Pipeline')}>
        {enqLoading
          ? <div style={{ textAlign: 'center', padding: '60px 0', color: C.muted }}>Loading…</div>
          : <PipelineTab enquiries={enquiries} stats={stats} />}
      </CrmTabPane>
      <CrmTabPane name="Enquiries" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Enquiries')}>
        <EnquiriesTab onRefresh={refresh} refreshKey={tabState.Enquiries.key} />
      </CrmTabPane>
      <CrmTabPane name="Quotations" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Quotations')}>
        <QuotationsTab onRefresh={refresh} refreshKey={tabState.Quotations.key} />
      </CrmTabPane>
      <CrmTabPane name="Invoices" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Invoices')}>
        <InvoicesTab refreshKey={tabState.Invoices.key} />
      </CrmTabPane>
      <CrmTabPane name="Follow-ups" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Follow-ups')}>
        <FollowupsTab onRefresh={refresh} refreshKey={tabState['Follow-ups'].key} />
      </CrmTabPane>
      <CrmTabPane name="Insights" activeTab={tab} workspaceActive={workspaceActive} visited={visited.has('Insights')}>
        <InsightsTab refreshKey={tabState.Insights.key} />
      </CrmTabPane>

      {/* Global shortcuts */}
      {showEnqForm && <EnquiryFormModal prefill={enqPrefill} onSave={() => { setShowEnqForm(false); setEnqPrefill({}); refresh(); }} onClose={() => { setShowEnqForm(false); setEnqPrefill({}); }} />}
      {showQtForm  && <QuoteFormModal quote={null} enquiries={enquiries} prefill={{ customer_id: defaultCustomerId, enquiry_id: defaultEnquiryId }} onSave={() => { setShowQtForm(false); refresh(); }} onClose={() => setShowQtForm(false)} />}
    </div>
    </CrmPortalContext.Provider>
  );
}
