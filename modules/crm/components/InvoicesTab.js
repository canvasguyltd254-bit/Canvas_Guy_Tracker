'use client';

/**
 * Shared InvoicesTab component — used in CrmModule (all invoices) and
 * CustomerProfile (filtered to one customer).
 *
 * Props:
 *   customerId  — if set, hides customer column and pre-filters to this customer
 */

import React, { useState, useEffect, useCallback } from 'react';

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

  const SECTIONS = [
    { key: 'summary',  label: 'Summary' },
    { key: 'items',    label: 'Line Items' },
    { key: 'history',  label: 'Quote Revisions' },
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
              ['Quote Ref',       invoice.quote_num ? `${invoice.quote_num} R${invoice.quote_revision}` : '—'],
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
              Amounts snapshotted at conversion — never recalculated.
              Pricing: <strong>{vatModeLabel[vatBreakdown.pricing_mode]}</strong>
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
export default function InvoicesTab({ customerId, refreshKey = 0 } = {}) {
  const [invoices, setInvoices]   = useState([]);
  const [loading, setLoad]        = useState(true);
  const [expandedId, setExpanded] = useState(null);

  const [fCustomer,    setFCustomer]    = useState('');
  const [fInvoice,     setFInvoice]     = useState('');
  const [fQuote,       setFQuote]       = useState('');
  const [fOrder,       setFOrder]       = useState('');
  const [fVatMode,     setFVatMode]     = useState('');
  const [fPmtStatus,   setFPmtStatus]   = useState('');
  const [fOrderStatus, setFOrderStatus] = useState('');
  const [fDateFrom,    setFDateFrom]    = useState('');
  const [fDateTo,      setFDateTo]      = useState('');

  const fetchInvoices = useCallback(() => {
    setLoad(true);
    const p = new URLSearchParams();
    if (customerId)    p.set('customer_id',    customerId);
    if (fCustomer)     p.set('customer',        fCustomer);
    if (fInvoice)      p.set('invoice',         fInvoice);
    if (fQuote)        p.set('quote',           fQuote);
    if (fOrder)        p.set('order',           fOrder);
    if (fVatMode)      p.set('vat_mode',        fVatMode);
    if (fPmtStatus)    p.set('payment_status',  fPmtStatus);
    if (fOrderStatus)  p.set('order_status',    fOrderStatus);
    if (fDateFrom)     p.set('date_from',       fDateFrom);
    if (fDateTo)       p.set('date_to',         fDateTo);
    fetch(`/api/crm/invoices?${p}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { console.error('invoices fetch error:', j.error); setLoad(false); return; }
        setInvoices(j.invoices || []);
        setLoad(false);
      })
      .catch(err => { console.error('invoices fetch failed:', err); setLoad(false); });
  }, [customerId, fCustomer, fInvoice, fQuote, fOrder, fVatMode, fPmtStatus, fOrderStatus, fDateFrom, fDateTo, refreshKey]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  const issuedInvoices = invoices.filter(i => !i.pending_invoice);
  const totalValue  = issuedInvoices.reduce((s, i) => s + i.total_value, 0);
  const totalPaid   = issuedInvoices.reduce((s, i) => s + i.total_paid,  0);
  const totalBal    = issuedInvoices.reduce((s, i) => s + i.balance,     0);
  const pendingCount = invoices.filter(i => i.pending_invoice).length;

  const ORDER_STATUS_OPTIONS = [
    'Quote Approved', 'Deposit Paid', 'Material Check', 'Production',
    'Quality Control', 'Ready for Delivery', 'Partially Delivered', 'Delivered', 'Closed',
  ];

  const inputStyle = { border: `1px solid ${C.line}`, background: C.card, borderRadius: 8, padding: '7px 10px', fontSize: 12, outline: 'none' };
  const selectStyle = { ...inputStyle, minWidth: 130 };

  return (
    <div>
      {/* KPI bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        {[
          ['Invoiced', `KES ${fmtKes(totalValue)}`, `${issuedInvoices.length} invoice${issuedInvoices.length !== 1 ? 's' : ''}`, false],
          ['Collected', `KES ${fmtKes(totalPaid)}`, null, false],
          ['Outstanding', `KES ${fmtKes(totalBal)}`, null, totalBal > 0],
          ...(pendingCount > 0 ? [['Pending Issuance', String(pendingCount), 'awaiting deposit', false]] : []),
        ].map(([label, value, sub, alert]) => (
          <div key={label} style={{
            background: alert ? C.redBg : C.card,
            border: `1px solid ${alert ? C.redBd : C.line}`,
            borderRadius: 10, padding: '13px 15px',
          }}>
            <div style={{ color: C.muted, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6, color: alert ? C.red : C.ink }}>{value}</div>
            {sub && <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.line}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {!customerId && (
            <input value={fCustomer} onChange={e => setFCustomer(e.target.value)}
              placeholder="Search customer…" style={{ ...inputStyle, minWidth: 150 }} />
          )}
          <input value={fInvoice}  onChange={e => setFInvoice(e.target.value)}  placeholder="Invoice #…"  style={{ ...inputStyle, minWidth: 120 }} />
          <input value={fQuote}    onChange={e => setFQuote(e.target.value)}     placeholder="Quote #…"    style={{ ...inputStyle, minWidth: 120 }} />
          <input value={fOrder}    onChange={e => setFOrder(e.target.value)}     placeholder="Order #…"    style={{ ...inputStyle, minWidth: 120 }} />
          <select value={fVatMode} onChange={e => setFVatMode(e.target.value)} style={selectStyle}>
            <option value="">All VAT modes</option>
            <option value="vat_exclusive">Excl. VAT</option>
            <option value="vat_inclusive">Incl. VAT</option>
            <option value="none">No VAT</option>
          </select>
          <select value={fPmtStatus} onChange={e => setFPmtStatus(e.target.value)} style={selectStyle}>
            <option value="">All payment</option>
            <option value="unpaid">Unpaid</option>
            <option value="part_paid">Part Paid</option>
            <option value="paid">Paid</option>
          </select>
          <select value={fOrderStatus} onChange={e => setFOrderStatus(e.target.value)} style={selectStyle}>
            <option value="">All statuses</option>
            {ORDER_STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" value={fDateFrom} onChange={e => setFDateFrom(e.target.value)} title="Invoice date from" style={inputStyle} />
          <input type="date" value={fDateTo}   onChange={e => setFDateTo(e.target.value)}   title="Invoice date to"   style={inputStyle} />
        </div>

        {/* Table */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '50px 0', color: C.muted }}>Loading invoices…</div>
        ) : invoices.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 0', color: C.muted }}>
            <svg width="42" height="42" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}
              style={{ display: 'block', margin: '0 auto 12px', opacity: 0.3 }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div style={{ fontWeight: 700, marginBottom: 5 }}>No invoices found</div>
            <div style={{ fontSize: 12 }}>Invoices appear when a quotation is converted to an order.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Invoice #</Th>
                  {!customerId && <Th>Customer</Th>}
                  <Th>Quote</Th>
                  <Th>Order</Th>
                  <Th>VAT Mode</Th>
                  <Th right>Total</Th>
                  <Th right>Paid</Th>
                  <Th right>Balance</Th>
                  <Th>Payment</Th>
                  <Th>Delivery</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv, i) => {
                  const isExpanded = expandedId === inv.id;
                  const delivPct   = inv.total_units > 0
                    ? Math.round((inv.delivered_units / inv.total_units) * 100) : 0;
                  const colSpan    = customerId ? 11 : 12;
                  return (
                    <React.Fragment key={inv.id}>
                      <tr
                        onClick={() => setExpanded(isExpanded ? null : inv.id)}
                        style={{
                          background: isExpanded ? C.coralBg : i % 2 === 0 ? C.card : '#fafaf8',
                          cursor: 'pointer',
                        }}
                      >
                        <Td>
                          {inv.pending_invoice
                            ? <Badge color="amber">Pending</Badge>
                            : <strong style={{ color: C.coral }}>{inv.invoice_number}</strong>
                          }
                          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>{fmtDate(inv.invoice_issued_at)}</div>
                        </Td>
                        {!customerId && (
                          <Td>
                            <div style={{ fontWeight: 700 }}>{inv.customer_name}</div>
                            <div style={{ fontSize: 10.5, color: C.muted }}>{inv.customer_type?.replace(/_/g, ' ')}</div>
                          </Td>
                        )}
                        <Td>{inv.quote_num ? `${inv.quote_num} R${inv.quote_revision}` : '—'}</Td>
                        <Td><span style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{inv.order_num}</span></Td>
                        <Td>{vatModeLabel[inv.pricing_mode] || inv.pricing_mode}</Td>
                        <Td right><strong>{fmtKes(inv.total_value)}</strong></Td>
                        <Td right style={{ color: C.green }}>{fmtKes(inv.total_paid)}</Td>
                        <Td right style={{ color: inv.balance > 0 ? C.red : C.green }}>{fmtKes(inv.balance)}</Td>
                        <Td>
                          <Badge color={pmtStatusColor[inv.payment_status] || 'gray'}>
                            {pmtStatusLabel[inv.payment_status] || inv.payment_status}
                          </Badge>
                        </Td>
                        <Td>
                          {inv.total_units > 0 ? (
                            <div style={{ minWidth: 80 }}>
                              <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>
                                {inv.delivered_units}/{inv.total_units}
                              </div>
                              <div style={{ height: 4, background: C.line, borderRadius: 4, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${delivPct}%`, background: delivPct >= 100 ? C.green : C.coral, borderRadius: 4 }} />
                              </div>
                            </div>
                          ) : '—'}
                        </Td>
                        <Td>
                          <Badge color={
                            inv.status === 'Closed' || inv.status === 'Delivery' ? 'green' :
                            inv.status === 'Quality Control' ? 'blue' :
                            inv.status === 'Production' ? 'amber' : 'gray'
                          }>{inv.status}</Badge>
                        </Td>
                        <Td>
                          <span style={{ fontSize: 11, color: C.muted }}>{isExpanded ? '▲' : '▼'}</span>
                        </Td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={colSpan} style={{ padding: '0 14px 14px', background: '#f7f6f3' }}>
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
        )}
      </div>
    </div>
  );
}
