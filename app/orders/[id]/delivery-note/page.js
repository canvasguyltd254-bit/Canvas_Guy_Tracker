'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/shared/supabase/client';

const supabase = createClient();

const fmtDate = d => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : '—';

const fmtKES = v => {
  const n = parseFloat(v) || 0;
  return `KES ${Math.round(n).toLocaleString('en-KE')}`;
};

export default function DeliveryNotePage() {
  const { id } = useParams();

  const [order, setOrder]         = useState(null);
  const [items, setItems]         = useState([]);
  const [payments, setPayments]   = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const [ordRes, itemsRes, paysRes, docsRes] = await Promise.all([
          supabase.from('orders').select('*').eq('id', id).single(),
          supabase.from('order_items').select('*').eq('order_id', id).order('sort_order'),
          supabase.from('order_payments').select('*').eq('order_id', id).order('payment_date'),
          supabase.from('order_documents').select('*').eq('order_id', id).order('created_at'),
        ]);
        if (ordRes.error) throw new Error(ordRes.error.message);
        setOrder(ordRes.data);
        setItems(itemsRes.data || []);
        setPayments(paysRes.data || []);
        setDocuments(docsRes.data || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <p style={{ color: '#9ca3af', fontSize: '14px' }}>Preparing delivery note...</p>
    </div>
  );

  if (error || !order) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <p style={{ color: '#dc2626' }}>Error: {error || 'Order not found'}</p>
    </div>
  );

  const totalPaid    = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const balance      = Math.max((parseFloat(order.total_value) || 0) - totalPaid, 0);
  const regularItems = items.filter(i => !['Delivery Fee','Installation Fee','Design Fee','Rush Fee','Discount'].includes(i.category));
  const chargeItems  = items.filter(i => ['Delivery Fee','Installation Fee','Design Fee','Rush Fee','Discount'].includes(i.category));

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #f3f3f3; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }

        .page {
          background: #fff;
          max-width: 800px;
          margin: 32px auto;
          padding: 40px 48px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.1);
        }

        .print-btn {
          display: block;
          margin: 0 auto 24px;
          max-width: 800px;
          text-align: right;
          padding: 0 48px;
        }

        @media print {
          body { background: #fff; }
          .no-print { display: none !important; }
          .page { margin: 0; box-shadow: none; padding: 24px 32px; }
        }

        table { border-collapse: collapse; width: 100%; }
        th, td { text-align: left; padding: 8px 10px; font-size: 12px; }
        thead tr { background: #111827; color: #fff; }
        tbody tr:nth-child(even) { background: #f9fafb; }
        tbody tr { border-bottom: 1px solid #f0f0ee; }
        .mono { font-family: 'Courier New', monospace; }
        .right { text-align: right; }
        .label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; margin-bottom: 3px; }
        .value { font-size: 13px; font-weight: 600; color: #111; }
      `}</style>

      {/* Print button — hidden on print */}
      <div className="no-print print-btn">
        <button
          onClick={() => window.print()}
          style={{
            padding: '9px 20px', background: '#E8512A', color: '#fff',
            border: 'none', borderRadius: '7px', fontWeight: 700,
            fontSize: '13px', cursor: 'pointer',
          }}
        >
          🖨 Print / Save PDF
        </button>
      </div>

      <div className="page">

        {/* ── Header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', borderBottom: '3px solid #E8512A', paddingBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <img
              src="/canvas-guy-logo.png"
              alt="Canvas Guy Limited"
              style={{ width: '72px', height: '72px', objectFit: 'contain' }}
            />
            <div>
              <div style={{ fontSize: '11px', color: '#6b7280', lineHeight: 1.6 }}>
                Nairobi, Kenya<br />
                info@canvasguy.co.ke
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#111', letterSpacing: '-0.3px' }}>DELIVERY NOTE</div>
            <div style={{ fontFamily: 'monospace', fontSize: '13px', color: '#E8512A', fontWeight: 700, marginTop: '4px' }}>{order.order_num}</div>
            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '6px' }}>
              Date: {fmtDate(new Date().toISOString().split('T')[0])}<br />
              Delivery date: {fmtDate(order.due_date)}
            </div>
          </div>
        </div>

        {/* ── Client + Delivery grid ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '28px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: '8px' }}>Deliver To</div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#111', marginBottom: '4px' }}>{order.client}</div>
            {order.contact_person && <div style={{ fontSize: '12px', color: '#374151' }}>{order.contact_person}</div>}
            {order.delivery_contact && order.delivery_contact !== order.contact_person && (
              <div style={{ fontSize: '12px', color: '#374151' }}>📞 {order.delivery_contact}</div>
            )}
            {order.delivery_address && (
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '6px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{order.delivery_address}</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: '8px' }}>Order Details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {order.quote_number && (
                <div><span className="label">Quote # </span><span className="value mono">{order.quote_number}</span></div>
              )}
              {order.invoice_number && (
                <div><span className="label">Invoice # </span><span className="value mono">{order.invoice_number}</span></div>
              )}
              <div><span className="label">Sales rep </span><span className="value">{order.author || '—'}</span></div>
              <div><span className="label">Payment terms </span><span className="value">{order.payment_terms || '—'}</span></div>
            </div>
          </div>
        </div>

        {/* Special instructions */}
        {order.delivery_instructions && (
          <div style={{ background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: '7px', padding: '10px 14px', marginBottom: '24px', fontSize: '12px', color: '#92400e' }}>
            <span style={{ fontWeight: 700 }}>Special instructions: </span>{order.delivery_instructions}
          </div>
        )}

        {/* ── Line items table ── */}
        <div style={{ marginBottom: '24px' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: '8px' }}>Items</div>
          <table>
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>Category</th>
                <th>Description / Size</th>
                <th className="right" style={{ width: '50px' }}>Qty</th>
                <th className="right" style={{ width: '100px' }}>Unit Price</th>
                <th className="right" style={{ width: '100px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {regularItems.map((item, idx) => {
                const rowTotal = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
                const spec = [item.size, item.finish_type, item.finish_color, item.wood_type].filter(Boolean).join(' · ');
                return (
                  <tr key={item.id}>
                    <td style={{ color: '#9ca3af' }}>{idx + 1}</td>
                    <td style={{ fontWeight: 600 }}>{item.category}</td>
                    <td style={{ color: '#6b7280' }}>{spec || item.description || '—'}</td>
                    <td className="right mono">{item.quantity}</td>
                    <td className="right mono">{fmtKES(item.unit_price)}</td>
                    <td className="right mono" style={{ fontWeight: 700 }}>{fmtKES(rowTotal)}</td>
                  </tr>
                );
              })}
              {regularItems.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>No items</td></tr>
              )}
            </tbody>
            <tfoot>
              {/* Items subtotal */}
              <tr style={{ borderTop: '2px solid #e5e7eb' }}>
                <td colSpan={5} style={{ textAlign: 'right', fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', padding: '8px 10px' }}>Items subtotal</td>
                <td className="right mono" style={{ fontWeight: 700, padding: '8px 10px' }}>
                  {fmtKES(regularItems.reduce((s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0))}
                </td>
              </tr>
              {/* Charge lines */}
              {chargeItems.map(ci => (
                <tr key={ci.id}>
                  <td colSpan={5} style={{ textAlign: 'right', fontSize: '11px', fontWeight: 600, color: '#6b7280', padding: '4px 10px' }}>{ci.category}</td>
                  <td className="right mono" style={{ fontWeight: 600, padding: '4px 10px' }}>{fmtKES(ci.unit_price)}</td>
                </tr>
              ))}
              {/* Contract total */}
              <tr style={{ background: '#111827' }}>
                <td colSpan={5} style={{ textAlign: 'right', fontSize: '12px', fontWeight: 800, color: '#fff', padding: '10px' }}>Contract Total</td>
                <td className="right mono" style={{ fontWeight: 800, color: '#E8512A', fontSize: '14px', padding: '10px' }}>{fmtKES(order.total_value)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── Payment summary ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px', marginBottom: '28px' }}>
          {[
            { label: 'Contract Total', value: fmtKES(order.total_value), color: '#111' },
            { label: 'Amount Paid',    value: fmtKES(totalPaid),          color: '#16a34a' },
            { label: 'Balance Due',    value: fmtKES(balance),            color: balance > 0 ? '#E8512A' : '#16a34a' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ border: '1.5px solid #e5e7eb', borderRadius: '8px', padding: '12px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: '9px', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '4px' }}>{label}</div>
              <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '14px', color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* ── Attachments / photos reference ── */}
        {documents.length > 0 && (
          <div style={{ marginBottom: '28px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: '8px' }}>Attached Documents & Photos</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {documents.map((doc, idx) => (
                <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', padding: '5px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ color: '#9ca3af', minWidth: '20px' }}>{idx + 1}.</span>
                  <span style={{ flex: 1, color: '#374151' }}>{doc.name}</span>
                  <span style={{ color: '#9ca3af', fontSize: '10px', background: '#f3f4f6', padding: '2px 6px', borderRadius: '3px' }}>{doc.doc_type}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Signature block ── */}
        <div style={{ borderTop: '2px solid #e5e7eb', paddingTop: '24px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '24px' }}>
          {['Prepared by (Canvas Guy)', 'Delivered by', 'Received by (Client)'].map(label => (
            <div key={label}>
              <div style={{ borderBottom: '1.5px solid #374151', marginBottom: '6px', height: '36px' }} />
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
              <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '3px' }}>Name &amp; Date</div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ marginTop: '32px', textAlign: 'center', fontSize: '10px', color: '#d1d5db', borderTop: '1px solid #f3f4f6', paddingTop: '12px' }}>
          Canvas Guy Limited · Nairobi, Kenya · {order.order_num}
        </div>

      </div>
    </>
  );
}
