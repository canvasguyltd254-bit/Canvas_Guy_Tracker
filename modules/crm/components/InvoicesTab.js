'use client';

/**
 * Shared InvoicesTab component — used in CrmModule (all invoices) and
 * CustomerProfile (filtered to one customer).
 *
 * Props:
 *   customerId  — if set, hides customer column and pre-filters to this customer
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AGEING_BUCKETS, isLiveInvoice, owes, dueInfo, invoiceTabs, invoiceTabCounts,
  matchesInvoiceSearch, summariseInvoices,
} from '@/shared/lib/invoiceView';
import { isCancelled } from '@/shared/lib/reports/orderRules';

const isCancelledStatus = (inv) => isCancelled(inv);

// ─── Design tokens (duplicated from CrmModule for portability) ────────────────
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

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—';
const fmtKes = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0 });

// Returns a readable quote reference for both CRM and legacy direct orders.
// CRM orders: "QT-2026-0012 R2" (revision appended only when it exists and quote_num is present).
// Legacy direct orders: the stored quote_number value (e.g. "12735") or "Direct Order".
const formatQuoteRef = (inv) => {
  if (!inv.quote_num) return 'Direct Order';
  return inv.quote_revision != null
    ? `${inv.quote_num} R${inv.quote_revision}`
    : inv.quote_num;
};

const BADGE_MAP = {
  blue:  [C.blueBg,  C.blue],
  green: [C.greenBg, C.green],
  amber: [C.amberBg, C.amber],
  red:   [C.redBg,   C.red],
  gray:  ['#f1efeb', C.muted],
};
const Badge = ({ color = 'gray', children }) => {
  const [bg, fg] = BADGE_MAP[color] || BADGE_MAP.gray;
  return (
    <span style={{ background: bg, color: fg, padding: '3px 8px', borderRadius: 20, fontWeight: 700, fontSize: 10.5, display: 'inline-flex', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
};

const Btn = ({ small, onClick, disabled, children }) => (
  <button onClick={onClick} disabled={disabled} style={{
    border: `1px solid ${C.line}`, background: C.card, color: C.ink,
    padding: small ? '5px 10px' : '8px 14px',
    borderRadius: 8, fontWeight: 700, fontSize: small ? 11.5 : 13,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
    display: 'inline-flex', alignItems: 'center', gap: 4,
  }}>{children}</button>
);

const Th = ({ children, right }) => (
  <th style={{ textAlign: right ? 'right' : 'left', color: C.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em', padding: '10px 14px', borderBottom: `1px solid ${C.line}`, fontWeight: 700 }}>{children}</th>
);
const Td = ({ children, right, style }) => (
  <td style={{ padding: '11px 14px', borderBottom: `1px solid ${C.line}`, textAlign: right ? 'right' : 'left', fontSize: 12.5, ...style }}>{children}</td>
);

const statusColor = { draft: 'gray', sent: 'blue', accepted: 'green', rejected: 'red', expired: 'amber', superseded: 'gray' };
const pmtStatusColor = { unpaid: 'red', part_paid: 'amber', paid: 'green' };
const pmtStatusLabel = { unpaid: 'Unpaid', part_paid: 'Part Paid', paid: 'Paid' };
const vatModeLabel   = { vat_exclusive: 'Excl. VAT', vat_inclusive: 'Incl. VAT', none: 'No VAT' };

// ─── InvoiceDetailPanel ───────────────────────────────────────────────────────
function InvoiceDetailPanel({ orderId, onClose }) {
  const [data, setData]      = useState(null);
  const [loading, setLoad]   = useState(true);
  const [err, setErr]        = useState(null);
  const [downloading, setDl] = useState(false);
  const [section, setSection]= useState('summary');

  useEffect(() => {
    setLoad(true);
    fetch(`/api/crm/invoices/${orderId}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setErr(j.error); setLoad(false); return; }
        setData(j);
        setLoad(false);
      })
      .catch(e => { console.error('Invoice detail fetch failed:', e); setErr('Failed to load invoice'); setLoad(false); });
  }, [orderId]);

  const handleDownloadPdf = async () => {
    if (!data?.invoice?.invoice_number) return;
    setDl(true);
    try {
      const res = await fetch(`/api/crm/invoices/${orderId}/pdf`);
      if (!res.ok) throw new Error('PDF generation failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${data.invoice.invoice_number}_Invoice.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('PDF download failed: ' + e.message);
    } finally {
      setDl(false);
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px 0', color: C.muted }}>Loading invoice…</div>;
  if (err) return (
    <div style={{ background: C.redBg, color: C.red, border: `1px solid ${C.redBd}`, borderRadius: 8, padding: '11px 14px', fontSize: 12.5 }}>{err}</div>
  );
  if (!data || !data.invoice) return null;

  const { invoice, vatBreakdown, quoteHistory, trackerProgress, deliveryHistory, paymentHistory } = data;
  const adjustments = data.adjustments || [];

  const SECTIONS = [
    { key: 'summary',  label: 'Summary' },
    { key: 'items',    label: 'Line Items' },
    { key: 'history',  label: 'Quote Revisions' },
    { key: 'adjustments', label: `Adjustments${adjustments.length ? ` (${adjustments.length})` : ''}` },
    { key: 'tracker',  label: 'Tracker' },
    { key: 'delivery', label: 'Delivery' },
    { key: 'payments', label: 'Payments' },
  ];

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: '#fafaf8', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.line}`, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 14, color: C.ink }}>{invoice.invoice_number || 'Pending Invoice'}</strong>
          {invoice.pending_invoice && <Badge color="amber" style={{ marginLeft: 8 }}>Pending</Badge>}
          <span style={{ marginLeft: 10, fontSize: 11.5, color: C.muted }}>{invoice.order_num}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!invoice.pending_invoice && (
            <Btn small onClick={handleDownloadPdf} disabled={downloading}>
              {downloading ? 'Generating…' : '↓ PDF'}
            </Btn>
          )}
          <button onClick={onClose} style={{ border: 0, background: 'transparent', fontSize: 18, cursor: 'pointer', color: C.muted, padding: '0 4px' }}>✕</button>
        </div>
      </div>

      {/* Section nav */}
      <div style={{ display: 'flex', overflowX: 'auto', background: '#f3f1ec', borderBottom: `1px solid ${C.line}`, padding: '0 12px', gap: 0 }}>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)} style={{
            border: 0, background: 'transparent', padding: '9px 4px', marginRight: 18,
            color: section === s.key ? C.ink : C.muted,
            fontWeight: 700, fontSize: 11.5,
            borderBottom: `2px solid ${section === s.key ? C.coral : 'transparent'}`,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}>{s.label}</button>
        ))}
      </div>

      <div style={{ padding: '14px 16px' }}>

        {/* Summary */}
        {section === 'summary' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {[
              ['Invoice #',       invoice.invoice_number || '—'],
              ['Invoice Date',    fmtDate(invoice.invoice_issued_at)],
              ['Customer',        invoice.customer?.name || invoice.client],
              ['Quote Ref',       formatQuoteRef(invoice)],
              ['Order #',         invoice.order_num],
              ['VAT Mode',        vatModeLabel[invoice.pricing_mode] || invoice.pricing_mode],
              ['Payment Terms',   invoice.payment_terms?.replace(/_/g, ' ')],
              ['Due Date',        fmtDate(invoice.payment_due_date || invoice.due_date)],
              ['Order Status',    invoice.status],
              ['Total Value',     `KES ${fmtKes(invoice.total_value)}`],
              ['Total Paid',      `KES ${fmtKes(invoice.total_paid)}`],
              ['Balance',         `KES ${fmtKes(invoice.balance)}`],
            ].map(([label, value]) => (
              <div key={label} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: '9px 12px' }}>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Line Items */}
        {section === 'items' && !vatBreakdown && (
          <div style={{ color: C.muted, fontSize: 13, padding: '16px 0' }}>Line item data not available — the quotation may have no items or failed to load.</div>
        )}
        {section === 'items' && vatBreakdown && (
          <>
            <div style={{ marginBottom: 10, fontSize: 12, color: C.muted }}>
              Lines and totals come from the order's current items.
              {vatBreakdown.quotation && (
                <> Original quotation <strong>{vatBreakdown.quotation.quote_num} R{vatBreakdown.quotation.revision}</strong> was KES {fmtKes(vatBreakdown.quotation.original_total)}
                  {vatBreakdown.quotation.changed && <>; current order total is KES {fmtKes(vatBreakdown.quotation.current_total)} (see Adjustments).</>}
                </>
              )}
              {vatBreakdown.total_mismatch && (
                <Badge color="red" style={{ marginLeft: 6 }}>Stored order total (KES {fmtKes(vatBreakdown.order_total_value)}) differs from lines</Badge>
              )}
              {' '}Pricing: <strong>{vatModeLabel[vatBreakdown.pricing_mode]}</strong>
              {vatBreakdown.tax_status === 'exempt' && <Badge color="gray" style={{ marginLeft: 6 }}>Tax Exempt</Badge>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr>
                  {['Description', 'Category', 'Qty', 'Unit', 'Net', 'VAT', 'Gross'].map((h, i) => (
                    <Th key={h} right={i > 2}>{h}</Th>
                  ))}
                </tr></thead>
                <tbody>
                  {vatBreakdown.items.map((item, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? C.card : '#fafaf8' }}>
                      <Td>{item.description}</Td>
                      <Td>{item.category || '—'}</Td>
                      <Td right>{item.quantity}</Td>
                      <Td right>{fmtKes(item.unit_price)}</Td>
                      <Td right>{fmtKes(item.net_amount)}</Td>
                      <Td right>{fmtKes(item.vat_amount)}</Td>
                      <Td right><strong>{fmtKes(item.gross_amount)}</strong></Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: '#efede9' }}>
                    <td colSpan={4} style={{ padding: '9px 14px', fontWeight: 700, fontSize: 12 }}>Total</td>
                    <Td right><strong>{fmtKes(vatBreakdown.subtotal)}</strong></Td>
                    <Td right><strong>{fmtKes(vatBreakdown.vat_amount)}</strong></Td>
                    <Td right><strong style={{ color: C.coral }}>KES {fmtKes(vatBreakdown.total)}</strong></Td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        {/* Quote Revisions */}
        {section === 'history' && (
          <div style={{ overflowX: 'auto' }}>
            {quoteHistory.length === 0
              ? <div style={{ color: C.muted, fontSize: 13 }}>No revision history.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <Th>Quote #</Th><Th>Rev</Th><Th>Status</Th>
                    <Th right>Subtotal</Th><Th right>VAT</Th><Th right>Total</Th>
                    <Th>Accepted</Th>
                  </tr></thead>
                  <tbody>
                    {quoteHistory.map((q, i) => (
                      <tr key={q.id} style={{ background: q.converted_order_id ? C.greenBg : i % 2 === 0 ? C.card : '#fafaf8' }}>
                        <Td><strong>{q.quote_num}</strong></Td>
                        <Td>R{q.revision}</Td>
                        <Td>
                          <Badge color={statusColor[q.status] || 'gray'}>{q.status}</Badge>
                          {q.converted_order_id && <Badge color="green" style={{ marginLeft: 4 }}>Converted</Badge>}
                        </Td>
                        <Td right>{fmtKes(q.subtotal)}</Td>
                        <Td right>{fmtKes(q.vat_amount)}</Td>
                        <Td right><strong>{fmtKes(q.total)}</strong></Td>
                        <Td>{fmtDate(q.accepted_at)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>
        )}

        {/* Adjustments since quotation */}
        {section === 'adjustments' && (
          <div style={{ overflowX: 'auto' }}>
            {adjustments.length === 0
              ? <div style={{ color: C.muted, fontSize: 13 }}>No adjustments since the order was created.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <Th>Date</Th><Th>User</Th><Th>Reason</Th><Th>Changed line</Th>
                    <Th right>Before</Th><Th right>After</Th><Th right>Change (gross)</Th>
                  </tr></thead>
                  <tbody>
                    {adjustments.map((ev, ei) => (
                      <React.Fragment key={ev.event_id}>
                        {ev.lines.map((l, li) => {
                          const ref = l.after || l.before || {};
                          const fmtSnap = (x) => x ? `${x.quantity} × ${fmtKes(x.unit_price)} = ${fmtKes(x.gross)}` : '—';
                          const typeLabel = { item_added: 'Added', item_removed: 'Removed', item_changed: 'Changed' }[l.type] || l.type;
                          return (
                            <tr key={li} style={{ background: ei % 2 === 0 ? C.card : '#fafaf8' }}>
                              <Td>{li === 0 ? fmtDate(ev.created_at) : ''}</Td>
                              <Td>{li === 0 ? ev.user : ''}</Td>
                              <Td>{li === 0 ? ev.reason : ''}</Td>
                              <Td><Badge color={l.type === 'item_removed' ? 'red' : l.type === 'item_added' ? 'green' : 'gray'}>{typeLabel}</Badge> {ref.description || ref.category || '—'}</Td>
                              <Td right>{fmtSnap(l.before)}</Td>
                              <Td right>{fmtSnap(l.after)}</Td>
                              <Td right>{l.gross_delta >= 0 ? '+' : '−'}{fmtKes(Math.abs(l.gross_delta))}</Td>
                            </tr>
                          );
                        })}
                        {(
                          <tr style={{ background: '#efede9' }}>
                            <td colSpan={6} style={{ padding: '6px 14px', fontSize: 11.5, fontWeight: 700, textAlign: 'right' }}>Event total</td>
                            <Td right><strong>{ev.gross_delta >= 0 ? '+' : '−'}{fmtKes(Math.abs(ev.gross_delta))}</strong></Td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>
        )}

        {/* Tracker */}
        {section === 'tracker' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {trackerProgress.map((s, i) => (
              <div key={s.stage} style={{
                background: s.reached_at ? (s.is_current ? C.coralBg : C.greenBg) : '#f3f1ec',
                border: `1px solid ${s.reached_at ? (s.is_current ? '#e8a98d' : C.greenBd) : C.line}`,
                borderRadius: 8, padding: '10px 13px', minWidth: 140, flex: '1 1 140px',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Stage {i + 1}</div>
                <div style={{ fontWeight: 800, fontSize: 12.5, color: s.is_current ? C.coral : s.reached_at ? C.green : C.muted }}>{s.stage}</div>
                <div style={{ fontSize: 10.5, color: C.muted, marginTop: 3 }}>
                  {s.reached_at ? fmtDate(s.reached_at) : 'Not reached'}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Delivery */}
        {section === 'delivery' && (
          <>
            {deliveryHistory.length === 0
              ? <div style={{ color: C.muted, fontSize: 13 }}>No delivery records yet.</div>
              : deliveryHistory.map((b, bi) => (
                <div key={bi} style={{ marginBottom: 12, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ background: '#efede9', borderBottom: `1px solid ${C.line}`, padding: '9px 13px', display: 'flex', gap: 10, alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>{b.batch_number != null ? `Batch #${b.batch_number}` : 'Delivery'}</strong>
                    <Badge color={b.status === 'Delivered' ? 'green' : b.status === 'Quality Control' ? 'blue' : 'amber'}>{b.status}</Badge>
                    {b.actual_delivery_date && <span style={{ fontSize: 11, color: C.muted }}>Delivered {fmtDate(b.actual_delivery_date)}</span>}
                    <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 12 }}>KES {fmtKes(b.batch_value)}</span>
                  </div>
                  {b.items.length > 0 && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                      <thead><tr>
                        <Th>Item</Th><Th right>Planned</Th><Th right>Delivered</Th><Th right>Rejected</Th><Th right>Line Value</Th>
                      </tr></thead>
                      <tbody>
                        {b.items.map((item, ii) => (
                          <tr key={ii} style={{ background: ii % 2 === 0 ? C.card : '#fafaf8' }}>
                            <Td>{item.description}</Td>
                            <Td right>{item.quantity_planned}</Td>
                            <Td right>{item.quantity_delivered}</Td>
                            <Td right>{item.quantity_rejected || 0}</Td>
                            <Td right>KES {fmtKes(item.line_value)}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))
            }
          </>
        )}

        {/* Payments */}
        {section === 'payments' && (
          <>
            {paymentHistory.length === 0
              ? <div style={{ color: C.muted, fontSize: 13 }}>No payment records.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <Th>Date</Th><Th>Description</Th><Th right>Amount</Th><Th right>Running Balance</Th><Th>Status</Th>
                  </tr></thead>
                  <tbody>
                    {paymentHistory.map((p, i) => (
                      <tr key={p.id} style={{
                        background: i % 2 === 0 ? C.card : '#fafaf8',
                        opacity: p.is_reversed ? 0.55 : 1,
                      }}>
                        <Td>{fmtDate(p.payment_date)}</Td>
                        <Td style={p.is_reversed ? { textDecoration: 'line-through' } : {}}>{p.description || '—'}</Td>
                        <Td right style={p.is_reversed ? { textDecoration: 'line-through' } : {}}>KES {fmtKes(p.amount)}</Td>
                        <Td right>
                          {p.is_reversed ? <Badge color="red">Reversed</Badge> : `KES ${fmtKes(p.running_balance)}`}
                        </Td>
                        <Td>
                          {p.is_reversed ? <Badge color="red">Reversed</Badge> : <Badge color="green">Posted</Badge>}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#efede9' }}>
                      <td colSpan={2} style={{ padding: '9px 14px', fontWeight: 700, fontSize: 12 }}>Total Paid</td>
                      <Td right><strong style={{ color: C.green }}>KES {fmtKes(invoice.total_paid)}</strong></Td>
                      <Td right><strong style={{ color: invoice.balance > 0 ? C.red : C.green }}>KES {fmtKes(invoice.balance)}</strong></Td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              )
            }
          </>
        )}

      </div>
    </div>
  );
}

// ─── InvoicesTab (exported) ───────────────────────────────────────────────────
// Metrics, tabs and urgency come from shared/lib/invoiceView.js; this component
// only lays them out. Search and tabs run in the browser (so counts stay right);
// the date range, VAT mode and order status are server filters under "More filters".
const TAB_LABEL = { all: 'All', outstanding: 'Outstanding', overdue: 'Overdue', paid: 'Paid', pending: 'Pending issuance', cancelled: 'Cancelled' };
const TONE_COLOR = { red: C.red, amber: C.amber, muted: C.muted };
const AGE_COLOR = { current: '#9ca3af', d1_30: '#e6a23c', d31_60: '#e8772a', d61_90: '#d9472b', d90p: '#a8362d', nodate: '#cfcac3' };

function useWidth() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return w;
}

const Stat = ({ label, value, sub, alert, onClick }) => (
  <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    style={{ background: alert ? C.redBg : C.card, border: `1px solid ${alert ? C.redBd : C.line}`, borderRadius: 10, padding: '12px 14px', cursor: onClick ? 'pointer' : 'default' }}>
    <div style={{ color: alert ? C.red : C.muted, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 5, color: alert ? C.red : C.ink, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    {sub && <div style={{ color: C.muted, marginTop: 2, fontSize: 11 }}>{sub}</div>}
  </div>
);

export default function InvoicesTab({ customerId, refreshKey = 0 } = {}) {
  const [invoices, setInvoices]   = useState([]);
  const [loading, setLoad]        = useState(true);
  const [loadErr, setLoadErr]     = useState('');
  const [expandedId, setExpanded] = useState(null);
  const [tab, setTab]             = useState('all');
  const [search, setSearch]       = useState('');
  const [showMore, setShowMore]   = useState(false);
  const [fVatMode,     setFVatMode]     = useState('');
  const [fOrderStatus, setFOrderStatus] = useState('');
  const [fDateFrom,    setFDateFrom]    = useState('');
  const [fDateTo,      setFDateTo]      = useState('');
  const width  = useWidth();
  const mobile = width < 760;

  const today = useMemo(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }, []);

  const fetchInvoices = useCallback(() => {
    setLoad(true); setLoadErr('');
    const p = new URLSearchParams();
    if (customerId)    p.set('customer_id',  customerId);
    if (fVatMode)      p.set('vat_mode',     fVatMode);
    if (fOrderStatus)  p.set('order_status', fOrderStatus);
    if (fDateFrom)     p.set('date_from',    fDateFrom);
    if (fDateTo)       p.set('date_to',      fDateTo);
    fetch(`/api/crm/invoices?${p}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setLoadErr(j.error); setLoad(false); return; }
        setInvoices(j.invoices || []);
        setLoad(false);
      })
      .catch(err => { console.error('invoices fetch failed:', err); setLoadErr('Could not load invoices.'); setLoad(false); });
  }, [customerId, fVatMode, fOrderStatus, fDateFrom, fDateTo, refreshKey]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  const searched = useMemo(() => invoices.filter(i => matchesInvoiceSearch(i, search)), [invoices, search]);
  const counts   = useMemo(() => invoiceTabCounts(searched, today), [searched, today]);
  const summary  = useMemo(() => summariseInvoices(invoices, today), [invoices, today]);
  const visible  = useMemo(() => (tab === 'all' ? searched : searched.filter(i => invoiceTabs(i, today).includes(tab))), [searched, tab, today]);

  const ORDER_STATUS_OPTIONS = [
    'Quote Approved', 'Deposit Paid', 'Material Check', 'Production',
    'Quality Control', 'Ready for Delivery', 'Partially Delivered', 'Delivered', 'Closed',
  ];
  const inputStyle = { border: `1px solid ${C.line}`, background: C.card, borderRadius: 8, padding: '7px 10px', fontSize: 12, outline: 'none' };
  const filtersActive = !!(fVatMode || fOrderStatus || fDateFrom || fDateTo);

  const cards = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
      <Stat label="Invoiced" value={`KES ${fmtKes(summary.invoiced)}`} sub={`${summary.invoiceCount} invoice${summary.invoiceCount === 1 ? '' : 's'}`} />
      <Stat label="Collected" value={`KES ${fmtKes(summary.collected)}`} sub={summary.collectionRate === null ? '—' : `${summary.collectionRate}% of invoiced`} />
      <Stat label="Outstanding" value={`KES ${fmtKes(summary.outstanding)}`} sub={`${summary.owingCount} invoice${summary.owingCount === 1 ? '' : 's'} owing`} onClick={() => setTab('outstanding')} />
      <Stat label="Overdue" value={`KES ${fmtKes(summary.overdue)}`} sub={summary.overdueCount > 0 ? `${summary.overdueCount} past due date` : 'Nothing overdue'} alert={summary.overdueCount > 0} onClick={() => setTab('overdue')} />
      <Stat label="Due in 7 days" value={`KES ${fmtKes(summary.dueSoon)}`} sub={`${summary.dueSoonCount} invoice${summary.dueSoonCount === 1 ? '' : 's'}`} />
      {summary.pendingCount > 0 && <Stat label="Pending issuance" value={summary.pendingCount} sub={`KES ${fmtKes(summary.pendingValue)} awaiting deposit`} onClick={() => setTab('pending')} />}
    </div>
  );

  const ageing = summary.outstanding > 0 && (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Outstanding by age past due date</div>
      <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', background: C.line }} role="img"
        aria-label={AGEING_BUCKETS.filter(b => summary.ageing[b.key] > 0).map(b => `${b.label}: KES ${fmtKes(summary.ageing[b.key])}`).join(', ')}>
        {AGEING_BUCKETS.map(b => summary.ageing[b.key] > 0 && (
          <div key={b.key} style={{ width: `${(summary.ageing[b.key] / summary.outstanding) * 100}%`, background: AGE_COLOR[b.key] }} title={`${b.label}: KES ${fmtKes(summary.ageing[b.key])}`} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 8, fontSize: 11.5 }}>
        {AGEING_BUCKETS.map(b => summary.ageing[b.key] > 0 && (
          <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.ink }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: AGE_COLOR[b.key] }} />
            {b.label} <strong style={{ fontVariantNumeric: 'tabular-nums' }}>KES {fmtKes(summary.ageing[b.key])}</strong>
          </span>
        ))}
      </div>
    </div>
  );

  const filters = (
    <div style={{ padding: '12px 14px 0' }}>
      <div role="tablist" aria-label="Invoice status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.keys(TAB_LABEL).map(t => {
          const active = tab === t;
          const n = counts[t] ?? 0;
          if ((t === 'pending' || t === 'cancelled') && n === 0 && !active) return null;
          return (
            <button key={t} type="button" role="tab" aria-selected={active} onClick={() => setTab(t)}
              style={{ border: `1px solid ${active ? C.ink : C.line}`, background: active ? C.ink : C.card, color: active ? '#fff' : C.ink, borderRadius: 20, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >{TAB_LABEL[t]} <span style={{ opacity: 0.7, fontWeight: 600 }}>{n}</span></button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingBottom: showMore ? 8 : 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={customerId ? 'Search invoice, quote or order number' : 'Search invoice, customer, quote or order number'}
          style={{ ...inputStyle, flex: 1, minWidth: 220, padding: '8px 10px' }} />
        <button type="button" onClick={() => setShowMore(s => !s)} aria-expanded={showMore}
          style={{ ...inputStyle, cursor: 'pointer', fontWeight: 700, color: filtersActive ? C.coral : C.muted, borderColor: filtersActive ? C.coral : C.line, whiteSpace: 'nowrap' }}>
          {showMore ? 'Hide filters' : filtersActive ? 'Filters on' : 'More filters'}
        </button>
      </div>
      {showMore && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 12 }}>
          <select value={fVatMode} onChange={e => setFVatMode(e.target.value)} style={{ ...inputStyle, minWidth: 130 }} aria-label="VAT mode">
            <option value="">All VAT modes</option>
            <option value="vat_exclusive">Excl. VAT</option>
            <option value="vat_inclusive">Incl. VAT</option>
            <option value="none">No VAT</option>
          </select>
          <select value={fOrderStatus} onChange={e => setFOrderStatus(e.target.value)} style={{ ...inputStyle, minWidth: 140 }} aria-label="Order status">
            <option value="">All order statuses</option>
            {ORDER_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <label style={{ fontSize: 11.5, color: C.muted, display: 'inline-flex', alignItems: 'center', gap: 5 }}>Invoice date from
            <input type="date" value={fDateFrom} onChange={e => setFDateFrom(e.target.value)} style={inputStyle} /></label>
          <label style={{ fontSize: 11.5, color: C.muted, display: 'inline-flex', alignItems: 'center', gap: 5 }}>to
            <input type="date" value={fDateTo} onChange={e => setFDateTo(e.target.value)} style={inputStyle} /></label>
          {filtersActive && <Btn small onClick={() => { setFVatMode(''); setFOrderStatus(''); setFDateFrom(''); setFDateTo(''); }}>Clear</Btn>}
        </div>
      )}
    </div>
  );

  const invoiceCell = inv => (
    <div>
      {inv.pending_invoice
        ? <Badge color="amber">Pending</Badge>
        : <strong style={{ color: C.coral, whiteSpace: 'nowrap' }}>{inv.invoice_number}</strong>}
      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{fmtDate(inv.invoice_issued_at)}</div>
    </div>
  );
  const customerCell = inv => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inv.customer_name}>{inv.customer_name || '—'}</div>
      <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1 }}>
        <span style={{ fontFamily: 'monospace' }}>{inv.order_num}</span>{inv.quote_num ? ` · ${formatQuoteRef(inv)}` : ''}
      </div>
    </div>
  );
  const balanceCell = (inv, align) => {
    const live = isLiveInvoice(inv);
    const due = dueInfo(inv, today);
    return (
      <div style={{ textAlign: align }}>
        {!live
          ? <span style={{ color: C.muted }}>—</span>
          : owes(inv)
            ? <strong style={{ color: due?.overdue ? C.red : C.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtKes(inv.balance)}</strong>
            : <Badge color="green">Paid</Badge>}
        {live && inv.total_paid > 0 && owes(inv) && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1 }}>{fmtKes(inv.total_paid)} paid</div>}
      </div>
    );
  };
  const dueCell = inv => {
    const due = dueInfo(inv, today);
    if (!due) return <span style={{ color: C.muted }}>—</span>;
    return (
      <div>
        <div style={{ color: TONE_COLOR[due.tone], fontWeight: due.tone === 'muted' ? 500 : 700, fontSize: 12 }}>{due.text}</div>
        {inv.payment_due_date && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1 }}>{fmtDate(inv.payment_due_date)}</div>}
      </div>
    );
  };
  const deliveryCell = inv => {
    const pct = inv.total_units > 0 ? Math.round((inv.delivered_units / inv.total_units) * 100) : 0;
    return inv.total_units > 0 ? (
      <div style={{ minWidth: 84 }}>
        <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 3 }}>{inv.delivered_units}/{inv.total_units} delivered</div>
        <div style={{ height: 4, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? C.green : C.coral, borderRadius: 4 }} />
        </div>
      </div>
    ) : <span style={{ color: C.muted }}>—</span>;
  };
  const statusBadge = inv => (
    <Badge color={
      isCancelledStatus(inv) ? 'red' :
      inv.status === 'Closed' || inv.status === 'Delivered' ? 'green' :
      inv.status === 'Quality Control' ? 'blue' :
      inv.status === 'Production' ? 'amber' : 'gray'
    }>{inv.status}</Badge>
  );

  const body = loading ? (
    <div style={{ textAlign: 'center', padding: '50px 0', color: C.muted }}>Loading invoices…</div>
  ) : visible.length === 0 ? (
    <div style={{ textAlign: 'center', padding: '44px 16px', color: C.muted }}>
      <div style={{ fontWeight: 700, marginBottom: 5 }}>{invoices.length === 0 ? 'No invoices found' : 'No invoices match these filters'}</div>
      <div style={{ fontSize: 12 }}>{invoices.length === 0 ? 'Invoices appear when a quotation is converted to an order.' : 'Try a different tab or search.'}</div>
      {invoices.length > 0 && (search || tab !== 'all') && <div style={{ marginTop: 10 }}><Btn small onClick={() => { setSearch(''); setTab('all'); }}>Clear filters</Btn></div>}
    </div>
  ) : mobile ? (
    <div style={{ padding: '0 12px 12px', display: 'grid', gap: 10 }}>
      {visible.map(inv => {
        const open = expandedId === inv.id;
        return (
          <div key={inv.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: open ? C.bg : C.card, overflow: 'hidden' }}>
            <div style={{ padding: 12 }} onClick={() => setExpanded(open ? null : inv.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                {invoiceCell(inv)}{statusBadge(inv)}
              </div>
              {!customerId && <div style={{ marginTop: 8 }}>{customerCell(inv)}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10, gap: 8 }}>
                <div><div style={{ fontSize: 10.5, color: C.muted }}>Total</div><strong style={{ fontVariantNumeric: 'tabular-nums' }}>KES {fmtKes(inv.total_value)}</strong></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 10.5, color: C.muted }}>Balance</div>{balanceCell(inv, 'right')}</div>
              </div>
              <div style={{ marginTop: 8 }}>{dueCell(inv)}</div>
            </div>
            {open && <div style={{ padding: '0 10px 12px' }}><InvoiceDetailPanel orderId={inv.id} onClose={() => setExpanded(null)} /></div>}
          </div>
        );
      })}
    </div>
  ) : (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <Th>Invoice</Th>
            {!customerId && <Th>Customer</Th>}
            {customerId && <Th>Order</Th>}
            <Th right>Total</Th><Th right>Balance</Th><Th>Payment due</Th><Th>Delivery</Th><Th>Order status</Th>
          </tr>
        </thead>
        <tbody>
          {visible.map(inv => {
            const open = expandedId === inv.id;
            return (
              <React.Fragment key={inv.id}>
                <tr onClick={() => setExpanded(open ? null : inv.id)} style={{ background: open ? C.coralBg : C.card, cursor: 'pointer' }}>
                  <Td style={{ whiteSpace: 'nowrap', width: 1 }}>{invoiceCell(inv)}</Td>
                  <Td style={{ maxWidth: 300 }}>{customerId
                    ? <span><span style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{inv.order_num}</span>{inv.quote_num ? <div style={{ fontSize: 10.5, color: C.muted }}>{formatQuoteRef(inv)}</div> : null}</span>
                    : customerCell(inv)}</Td>
                  <Td right style={{ whiteSpace: 'nowrap' }}><strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKes(inv.total_value)}</strong></Td>
                  <Td right style={{ whiteSpace: 'nowrap' }}>{balanceCell(inv, 'right')}</Td>
                  <Td style={{ whiteSpace: 'nowrap' }}>{dueCell(inv)}</Td>
                  <Td>{deliveryCell(inv)}</Td>
                  <Td style={{ whiteSpace: 'nowrap' }}>{statusBadge(inv)}</Td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={7} style={{ padding: '0 14px 14px', background: '#f7f6f3' }}>
                      <InvoiceDetailPanel orderId={inv.id} onClose={() => setExpanded(null)} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {loadErr && <div style={{ background: C.redBg, color: C.red, border: `1px solid ${C.redBd}`, borderRadius: 8, padding: '11px 14px', fontSize: 12.5, marginBottom: 12 }}>{loadErr}</div>}
      {cards}
      {ageing}
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
        {filters}
        {body}
      </div>
    </div>
  );
}
