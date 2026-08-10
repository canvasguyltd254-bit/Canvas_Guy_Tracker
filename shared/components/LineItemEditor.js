'use client';

/**
 * shared/components/LineItemEditor.js
 *
 * Shared line-item editor used by both the Quote Form (CRM) and the Order Form.
 *
 * Props:
 *   mode              'quote' | 'order'
 *   items             Array of product line items
 *   charges           Array of additional charges — quote mode only
 *   pricingMode       'vat_inclusive' | 'vat_exclusive' | 'none'  (default 'none')
 *   taxStatus         'standard' | 'exempt'
 *   headerDiscountPct Global discount % fallback (quote mode)
 *   submitted         Bool — gates inline validation error display
 *   valErrs           { item_${i}_desc, item_${i}_price }
 *   narrowPanel       Bool — collapse 5-col pricing grid to 3-col + wrap row
 *   readOnly          Bool — render collapsed read-only cards (order mode)
 *   onChange          (items) => void
 *   onChargesChange   (charges) => void  — quote mode only
 *
 * Exported helpers used by parent forms to initialise state:
 *   BLANK_ITEM()       — blank product line item
 *   BLANK_CHARGE()     — blank additional charge (quote mode)
 *   CHARGE_TYPE_SET    — Set of charge category strings (order mode detection)
 */

import { useState } from 'react';
import calcTotals from '@/shared/lib/calcTotals';

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  coral: '#E8512A', coralBg: '#fde8e2',
  ink:   '#181818',
  muted: '#9a8f86',
  line:  '#e7e3de',
  bg:    '#f7f6f3',
  card:  '#fff',
  red:   '#dc2626', redBg: '#fef2f2',
};

// ─── Shared constants ─────────────────────────────────────────────────────────
export const PRODUCT_CATEGORIES = [
  'Wall Decoration Canvas', 'Mirrors', 'Furniture', 'Assorted Timber Products', 'Other',
];
export const CHARGE_CATEGORIES = [
  'Delivery Fee', 'Design Fee', 'Installation Fee', 'Packaging', 'Other Charge',
];
export const CHARGE_TYPE_SET = new Set(CHARGE_CATEGORIES);

const FINISH_TYPES = ['None', 'Stain', 'PU Hard Finish', 'One Coat', 'NC'];
const WOOD_TYPES   = [
  '', 'Mahogany', 'Mvule', 'Mango', 'Muringa', 'Cypress', 'Teak', 'Pine',
  'White Oak', 'MDF', 'Veneer', 'Laminated Board', 'Veneered Board', 'Plain Board',
];

const fmtKes = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 });

// ─── Blank-item factories ─────────────────────────────────────────────────────
export const BLANK_ITEM = () => ({
  _key: Math.random().toString(36).slice(2),
  line_type: 'product',
  category: 'Wall Decoration Canvas',
  description: '', quantity: 1, unit_price: '', discount_pct: '',
  tax_treatment: 'standard', size: '',
  finish_type: 'None', finish_color: '', wood_type: '',
});

// Quote-mode additional charge (flat amount, separate from items[])
export const BLANK_CHARGE = () => ({
  _key: Math.random().toString(36).slice(2),
  line_type: 'delivery', description: '', amount: '',
});

// Order-mode charge (stored inline in items[] via category)
const BLANK_ORDER_CHARGE = () => ({
  _key: Math.random().toString(36).slice(2),
  category: 'Delivery Fee',
  description: 'Delivery Fee',
  quantity: 1, unit_price: '',
  finish_type: 'None', finish_color: '', wood_type: '', size: '',
});

// ─── Component ────────────────────────────────────────────────────────────────
export default function LineItemEditor({
  mode              = 'quote',
  items             = [],
  charges           = [],
  pricingMode       = 'none',
  taxStatus         = 'standard',
  headerDiscountPct = 0,
  submitted         = false,
  valErrs           = {},
  narrowPanel       = false,
  readOnly          = false,
  onChange,
  onChargesChange,
}) {
  const [activeItem, setActiveItem] = useState(
    items.length > 0 ? items.length - 1 : 0,
  );
  const [activeReadOnlyItem, setActiveReadOnlyItem] = useState(null);

  // ── Computed totals ──────────────────────────────────────────────────────────
  const useVat = pricingMode !== 'none';

  const calcRows = useVat
    ? calcTotals(items, pricingMode, headerDiscountPct, taxStatus).rows
    : items.map(item => {
        const qty   = parseFloat(item.quantity)   || 1;
        const price = parseFloat(item.unit_price) || 0;
        const gross = Math.round(price * qty * 100) / 100;
        return { ...item, _net: gross, _vat: 0, _gross: gross };
      });

  const totals = useVat
    ? calcTotals(items, pricingMode, headerDiscountPct, taxStatus)
    : (() => {
        const t = calcRows.reduce((s, r) => s + (r._gross || 0), 0);
        return { subtotal: t, vatAmount: 0, total: t };
      })();

  // ── Item mutation helpers ────────────────────────────────────────────────────
  const setItem = (i, patch) =>
    onChange(items.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  const removeItem = (i) => {
    if (mode === 'quote' && items.length <= 1) return; // quote requires ≥1 item
    onChange(items.filter((_, idx) => idx !== i));
    setActiveItem(prev => Math.max(0, prev >= i ? prev - 1 : prev));
  };

  const addItem = () => {
    onChange([...items, BLANK_ITEM()]);
    setActiveItem(items.length);
  };

  const addOrderCharge = () => {
    onChange([...items, BLANK_ORDER_CHARGE()]);
    setActiveItem(items.length);
  };

  const moveItem = (i, dir) => {
    const arr = [...items], j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
    setActiveItem(j);
  };

  const applyDiscountToAll = (pct) =>
    onChange(items.map(it => ({ ...it, discount_pct: pct })));

  // ── Charge helpers (quote mode) ──────────────────────────────────────────────
  const setCharge    = (i, patch) => onChargesChange(charges.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  const removeCharge = (i) => onChargesChange(charges.filter((_, idx) => idx !== i));

  // ── Order-mode charge detection ──────────────────────────────────────────────
  const isChargeItem = (item) => CHARGE_TYPE_SET.has(item.category);

  // In order mode, split items by type for visual grouping;
  // indices refer to position in the original items[] array
  const productIdxs = mode === 'order'
    ? items.map((it, i) => i).filter(i => !isChargeItem(items[i]))
    : items.map((_, i) => i);
  const chargeIdxs  = mode === 'order'
    ? items.map((it, i) => i).filter(i => isChargeItem(items[i]))
    : [];

  // ── Shared style helpers ─────────────────────────────────────────────────────
  const iInp = (errKey) => ({
    border: `1px solid ${submitted && valErrs[errKey] ? C.red : C.line}`,
    borderRadius: 7, padding: '8px 10px', fontSize: 13,
    width: '100%', outline: 'none', boxSizing: 'border-box', background: '#fff',
  });
  const iLbl = {
    display: 'block', fontSize: 11, fontWeight: 700, color: C.muted,
    marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.03em',
  };

  // ── Read-only card (order mode, !editMode) — click to expand specs ───────────
  const renderReadOnly = (item, i) => {
    const calc     = calcRows[i] || {};
    const isCharge = mode === 'order' && isChargeItem(item);
    const subtitle = [item.category, item.size].filter(Boolean).join(' · ');
    const isOpen   = activeReadOnlyItem === i;
    const itemKey  = item._key || item._id || item.id || i;
    const gross    = calc._gross ?? (parseFloat(item.unit_price) || 0) * (parseFloat(item.quantity) || 1);

    return (
      <div key={itemKey} style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.bg, overflow: 'hidden' }}>
        {/* Collapsed row — always visible */}
        <div
          onClick={() => setActiveReadOnlyItem(isOpen ? null : i)}
          style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px',
            cursor: 'pointer', userSelect: 'none',
          }}>
          <div style={{ width: 22, height: 22, borderRadius: 5, background: C.card, border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: C.muted, flexShrink: 0 }}>
            {i + 1}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: C.ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.description || item.category || 'No description'}
            </div>
            {subtitle && !isOpen && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
            )}
          </div>
          {isCharge && (
            <span style={{ fontSize: 9, fontWeight: 700, background: '#EDE9FE', color: '#7C3AED', padding: '2px 6px', borderRadius: 3, flexShrink: 0 }}>charge</span>
          )}
          {!isCharge && !isOpen && (
            <span style={{ fontSize: 11, color: C.muted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>×{item.quantity || 1}</span>
          )}
          <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>
            KES {fmtKes(gross)}
          </span>
          <span style={{ color: C.muted, fontSize: 12, flexShrink: 0, transition: 'transform .15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none' }}>›</span>
        </div>

        {/* Expanded detail panel */}
        {isOpen && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', background: C.card }}>
            {!isCharge && (
              <>
                <div>
                  <div style={iLbl}>Category</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{item.category || '—'}</div>
                </div>
                <div>
                  <div style={iLbl}>Size</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{item.size || '—'}</div>
                </div>
                <div>
                  <div style={iLbl}>Finish</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{[item.finish_type, item.finish_color].filter(Boolean).join(' · ') || '—'}</div>
                </div>
                <div>
                  <div style={iLbl}>Wood Type</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{item.wood_type || '—'}</div>
                </div>
                <div>
                  <div style={iLbl}>Quantity</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{item.quantity || 1}</div>
                </div>
                <div>
                  <div style={iLbl}>Unit Price</div>
                  <div style={{ fontSize: 13, color: C.ink }}>KES {fmtKes(item.unit_price)}</div>
                </div>
                {useVat && calc._net != null && (
                  <>
                    <div>
                      <div style={iLbl}>Net</div>
                      <div style={{ fontSize: 13, color: C.ink }}>KES {fmtKes(calc._net)}</div>
                    </div>
                    <div>
                      <div style={iLbl}>VAT 16%</div>
                      <div style={{ fontSize: 13, color: C.ink }}>KES {fmtKes(calc._vat)}</div>
                    </div>
                  </>
                )}
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={iLbl}>Line Total</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>KES {fmtKes(gross)}</div>
                </div>
              </>
            )}
            {isCharge && (
              <>
                <div>
                  <div style={iLbl}>Charge Type</div>
                  <div style={{ fontSize: 13, color: C.ink }}>{item.category || '—'}</div>
                </div>
                <div>
                  <div style={iLbl}>Amount</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>KES {fmtKes(item.unit_price)}</div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Editable item card ────────────────────────────────────────────────────────
  const renderEditCard = (i, { isCharge = false } = {}) => {
    const item       = items[i];
    const calc       = calcRows[i] || {};
    const isOpen     = activeItem === i;
    const hasDist    = useVat && item.discount_pct !== '' && item.discount_pct != null;
    const descErr    = valErrs[`item_${i}_desc`];
    const priceErr   = valErrs[`item_${i}_price`];
    const itemHasErr = !!(descErr || priceErr);
    const itemKey    = item._key || item._id || item.id || i;

    // ── Collapsed card ──────────────────────────────────────────────────────────
    if (!isOpen) {
      return (
        <div key={itemKey} onClick={() => setActiveItem(i)}
          style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px',
            border: `1px solid ${itemHasErr ? C.red : C.line}`,
            borderRadius: 8, background: itemHasErr ? C.redBg : C.bg,
            cursor: 'pointer', userSelect: 'none',
          }}>
          <div style={{ width: 22, height: 22, borderRadius: 5, background: C.card, border: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: C.muted, flexShrink: 0 }}>
            {i + 1}
          </div>
          <span style={{ flex: 1, fontSize: 13, color: item.description ? C.ink : C.muted, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.description || (mode === 'order' ? item.category : '') || 'No description'}
          </span>
          {mode === 'order' && isCharge && (
            <span style={{ fontSize: 9, fontWeight: 700, background: '#EDE9FE', color: '#7C3AED', padding: '2px 6px', borderRadius: 3, flexShrink: 0 }}>charge</span>
          )}
          {itemHasErr
            ? <span style={{ fontSize: 11, color: C.red, fontWeight: 700, flexShrink: 0 }}>Incomplete !</span>
            : <span style={{ fontSize: 13, fontWeight: 700, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {calc._gross != null ? `KES ${fmtKes(calc._gross)}` : '—'}
              </span>
          }
          <span style={{ color: C.muted, fontSize: 12, flexShrink: 0 }}>›</span>
        </div>
      );
    }

    // ── Expanded card ────────────────────────────────────────────────────────────
    // Pricing grid columns — 5 col (wide) or 3 col (narrow, size+gross wrap to row 2)
    const pricingCols = narrowPanel
      ? 'minmax(120px,1fr) minmax(70px,0.5fr) minmax(80px,0.55fr)'
      : useVat
        ? 'minmax(140px,1.4fr) minmax(75px,0.5fr) minmax(80px,0.55fr) minmax(95px,0.7fr) minmax(120px,0.8fr)'
        : 'minmax(140px,1.4fr) minmax(75px,0.5fr) minmax(95px,0.7fr) minmax(120px,0.8fr)';

    // Production spec grid: 4 cols in quote (includes category), 3 in order, 2 on narrow
    const specColCount = narrowPanel ? 2 : (mode === 'quote' ? 4 : 3);

    return (
      <div key={itemKey} style={{ border: `1px solid ${C.coral}`, borderRadius: 9, background: C.card, overflow: 'hidden' }}>

        {/* ── Expanded header bar ── */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', background: C.coralBg, borderBottom: '1px solid #f3cfc6', gap: 6 }}>
          <div style={{ width: 22, height: 22, borderRadius: 5, background: C.coral, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
            {i + 1}
          </div>
          <span style={{ flex: 1, fontWeight: 700, fontSize: 12.5, color: C.ink, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.description || (mode === 'order' ? item.category : '') || 'New item'}
          </span>
          <button onClick={() => moveItem(i, -1)} disabled={i === 0}
            style={{ border: 0, background: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? '#d0cbc5' : C.muted, fontSize: 10, minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>▲</button>
          <button onClick={() => moveItem(i, 1)} disabled={i === items.length - 1}
            style={{ border: 0, background: 'none', cursor: i === items.length - 1 ? 'default' : 'pointer', color: i === items.length - 1 ? '#d0cbc5' : C.muted, fontSize: 10, minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>▼</button>
          <button onClick={() => removeItem(i)}
            style={{ border: 0, background: 'none', cursor: 'pointer', color: C.red, fontSize: 12, fontWeight: 600, minHeight: 44, padding: '0 8px', display: 'inline-flex', alignItems: 'center' }}>Remove</button>
          <button onClick={() => setActiveItem(null)}
            style={{ border: 0, background: 'none', cursor: 'pointer', color: C.muted, fontSize: 11.5, fontWeight: 600, minHeight: 44, padding: '0 6px', display: 'inline-flex', alignItems: 'center' }}>Collapse ‹</button>
        </div>

        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Income type — order mode only (category drives product vs. charge) */}
          {mode === 'order' && (
            <div>
              <label style={iLbl}>Category / type</label>
              <select
                value={item.category || 'Wall Decoration Canvas'}
                onChange={e => {
                  const cat = e.target.value;
                  setItem(i, {
                    category: cat,
                    description: CHARGE_TYPE_SET.has(cat) ? cat : item.description,
                  });
                }}
                style={iInp()}>
                <optgroup label="Products">
                  {PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </optgroup>
                <optgroup label="Charges">
                  {CHARGE_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </optgroup>
              </select>
            </div>
          )}

          {/* Description */}
          <div>
            <label style={iLbl}>Description{mode === 'quote' ? ' *' : ''}</label>
            <input value={item.description} onChange={e => setItem(i, { description: e.target.value })}
              placeholder="What are we making?" style={iInp(`item_${i}_desc`)} />
            {submitted && descErr && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{descErr}</div>}
          </div>

          {/* Pricing — non-charge items */}
          {!isCharge && (
            <div style={{ display: 'grid', gridTemplateColumns: pricingCols, gap: 8, alignItems: 'end' }}>

              {/* Unit price */}
              <div style={{ minWidth: 0 }}>
                <label style={iLbl}>Unit price (KES) *</label>
                <input type="number" value={item.unit_price} placeholder="0"
                  onChange={e => setItem(i, { unit_price: e.target.value })}
                  style={{ ...iInp(`item_${i}_price`), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
                {submitted && priceErr && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{priceErr}</div>}
              </div>

              {/* Qty */}
              <div style={{ minWidth: 0 }}>
                <label style={iLbl}>Qty</label>
                <input type="number" value={item.quantity} placeholder="1"
                  onChange={e => setItem(i, { quantity: e.target.value })}
                  style={{ ...iInp(), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
              </div>

              {/* Discount — only in VAT mode */}
              {useVat && !narrowPanel && (
                <div style={{ minWidth: 0 }}>
                  <label style={iLbl}>Disc %</label>
                  <input type="number" value={item.discount_pct} placeholder="—"
                    onChange={e => setItem(i, { discount_pct: e.target.value })}
                    style={{ ...iInp(), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Size — wide layout only (wraps to row 2 when narrow) */}
              {!narrowPanel && (
                <div style={{ minWidth: 0 }}>
                  <label style={iLbl}>Size</label>
                  <input value={item.size || ''} onChange={e => setItem(i, { size: e.target.value })} placeholder="60×40"
                    style={{ ...iInp(), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Gross/Total chip — wide layout only */}
              {!narrowPanel && (
                <div style={{ minWidth: 0, textAlign: 'right', paddingBottom: 1 }}>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>
                    {useVat ? (pricingMode === 'vat_exclusive' ? 'Gross' : 'Net') : 'Total'}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {calc._gross != null ? fmtKes(calc._gross) : '—'}
                  </div>
                </div>
              )}

              {/* Narrow: Size + Gross wrap to row 2 */}
              {narrowPanel && (
                <>
                  <div style={{ minWidth: 0, gridColumn: '1 / 2' }}>
                    <label style={iLbl}>Size</label>
                    <input value={item.size || ''} onChange={e => setItem(i, { size: e.target.value })} placeholder="60×40"
                      style={{ ...iInp(), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
                  </div>
                  <div style={{ minWidth: 0, gridColumn: '2 / 4', textAlign: 'right', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 1 }}>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>
                      {useVat ? (pricingMode === 'vat_exclusive' ? 'Gross' : 'Net') : 'Total'}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {calc._gross != null ? fmtKes(calc._gross) : '—'}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Flat amount — order-mode charge items */}
          {isCharge && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={iLbl}>Amount (KES)</label>
                <input type="number" value={item.unit_price} placeholder="0"
                  onChange={e => setItem(i, { unit_price: e.target.value })}
                  style={{ ...iInp(), textAlign: 'right', width: '100%', boxSizing: 'border-box' }} />
              </div>
              <div style={{ textAlign: 'right', paddingBottom: 1 }}>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 4 }}>Total</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {item.unit_price ? fmtKes(parseFloat(item.unit_price) || 0) : '—'}
                </div>
              </div>
            </div>
          )}

          {/* Production specs — non-charge items */}
          {!isCharge && (
            <div style={{ background: C.bg, borderRadius: 8, padding: '10px 11px 9px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.coral, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 9, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Production specs</span>
                <div style={{ flex: 1, height: 1, background: C.line }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${specColCount}, 1fr)`, gap: 8 }}>
                {/* Category shown in specs for quote mode (order uses top-level income type selector) */}
                {mode === 'quote' && (
                  <div>
                    <label style={iLbl}>Category</label>
                    <select value={item.category || 'Wall Decoration Canvas'} onChange={e => setItem(i, { category: e.target.value })} style={iInp()}>
                      {PRODUCT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label style={iLbl}>Finish</label>
                  <select value={item.finish_type || 'None'} onChange={e => setItem(i, { finish_type: e.target.value })} style={iInp()}>
                    {FINISH_TYPES.map(f => <option key={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label style={iLbl}>Colour</label>
                  <input value={item.finish_color || ''} onChange={e => setItem(i, { finish_color: e.target.value })} placeholder="Dark Walnut" style={iInp()} />
                </div>
                <div>
                  <label style={iLbl}>Material</label>
                  <select value={item.wood_type || ''} onChange={e => setItem(i, { wood_type: e.target.value })} style={iInp()}>
                    {WOOD_TYPES.map(w => <option key={w} value={w}>{w || '— none —'}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Apply discount to all lines shortcut */}
          {hasDist && items.length > 1 && (
            <button onClick={() => applyDiscountToAll(item.discount_pct)}
              style={{ border: 0, background: 'none', color: C.coral, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '2px 0', alignSelf: 'flex-start' }}>
              Apply {item.discount_pct}% to all lines
            </button>
          )}

        </div>
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* ── Items header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.ink, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          Line items
        </h3>
        {!readOnly && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={addItem}
              style={{ border: `1px solid ${C.coral}`, background: C.coralBg, color: C.coral, borderRadius: 7, padding: '5px 11px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              + Add item
            </button>
            {mode === 'order' && (
              <button onClick={addOrderCharge}
                style={{ border: `1px solid ${C.line}`, background: C.card, color: C.muted, borderRadius: 7, padding: '5px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                + Add charge
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Product items ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {productIdxs.length === 0 && (
          <div style={{ padding: '14px 0', textAlign: 'center', color: C.muted, fontSize: 12.5, border: `2px dashed ${C.line}`, borderRadius: 8 }}>
            No items yet — click &quot;+ Add item&quot;
          </div>
        )}
        {productIdxs.map(i =>
          readOnly
            ? renderReadOnly(items[i], i)
            : renderEditCard(i, { isCharge: false })
        )}
      </div>

      {/* ── Order-mode additional charges ── */}
      {mode === 'order' && (chargeIdxs.length > 0 || !readOnly) && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1, height: 1, background: C.line }} />
            <span style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
              Additional charges
            </span>
            <div style={{ flex: 1, height: 1, background: C.line }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {chargeIdxs.length === 0 && !readOnly && (
              <div style={{ fontSize: 12, color: C.muted, padding: '4px 0' }}>
                None — delivery, design, installation, discounts go here.
              </div>
            )}
            {chargeIdxs.map(i =>
              readOnly
                ? renderReadOnly(items[i], i)
                : renderEditCard(i, { isCharge: true })
            )}
          </div>
        </div>
      )}

      {/* ── Quote-mode additional charges flat table ── */}
      {mode === 'quote' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 24, height: 1, background: C.line }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Additional charges
              </span>
            </div>
            <button onClick={() => onChargesChange([...charges, BLANK_CHARGE()])}
              style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: C.muted }}>
              + Add charge
            </button>
          </div>

          {charges.length === 0 ? (
            <div style={{ fontSize: 12, color: C.muted, padding: '6px 0' }}>
              No additional charges — delivery, design, installation, discounts go here.
            </div>
          ) : (
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 9, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 110px 32px', background: C.bg, borderBottom: `1px solid ${C.line}`, padding: '6px 10px' }}>
                {['Type', 'Description', 'Amount (KES)', ''].map(h => (
                  <div key={h} style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em' }}>{h}</div>
                ))}
              </div>
              {charges.map((c, ci) => (
                <div key={c._key} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 110px 32px', borderBottom: ci < charges.length - 1 ? `1px solid ${C.line}` : 'none', padding: '6px 10px', alignItems: 'center', background: C.card }}>
                  <select value={c.line_type} onChange={e => setCharge(ci, { line_type: e.target.value })}
                    style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px', fontSize: 12.5, outline: 'none', background: '#fff', marginRight: 8 }}>
                    <option value="delivery">Delivery</option>
                    <option value="design">Design fee</option>
                    <option value="installation">Installation</option>
                    <option value="discount">Discount</option>
                    <option value="other">Other</option>
                  </select>
                  <input value={c.description} onChange={e => setCharge(ci, { description: e.target.value })}
                    placeholder="Notes (optional)"
                    style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px', fontSize: 12.5, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box', marginRight: 8 }} />
                  <input type="number" value={c.amount} onChange={e => setCharge(ci, { amount: e.target.value })}
                    placeholder="0"
                    style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: '6px 8px', fontSize: 12.5, outline: 'none', background: '#fff', textAlign: 'right', width: '100%', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums' }} />
                  <button onClick={() => removeCharge(ci)}
                    style={{ border: 0, background: 'none', cursor: 'pointer', color: C.red, fontSize: 14, fontWeight: 700, padding: '2px 4px', textAlign: 'center' }}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Totals bar ── */}
      <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 9, padding: '11px 14px', marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, fontSize: 13, flexWrap: 'wrap', alignItems: 'baseline' }}>
          {useVat && (
            <>
              <span style={{ color: C.muted }}>
                Subtotal <strong style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtKes(totals.subtotal)}</strong>
              </span>
              <span style={{ color: C.muted }}>
                VAT <strong style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtKes(totals.vatAmount)}</strong>
              </span>
            </>
          )}
          <span style={{ fontWeight: 800, fontSize: 15, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
            KES {fmtKes(totals.total)}
          </span>
        </div>
      </div>

    </div>
  );
}
