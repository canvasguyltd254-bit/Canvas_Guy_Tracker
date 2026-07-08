'use client';

/**
 * app/orders/[id]/delivery-note/page.js
 *
 * Two variants controlled by query params:
 *
 *   ?batch=[batchId]  — scope items to a specific delivery batch (uses quantity_planned)
 *                       omit to show all order items
 *
 *   ?show=amounts     — renders unit prices, line totals, payment summary
 *                       title becomes "INTERNAL COPY"
 *                       omit for driver-friendly quantities-only version
 *                       title is "DELIVERY NOTE"
 */

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { createClient } from '@/shared/supabase/client';

const supabase = createClient();

const fmtDate = d => d
  ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : '—';

const fmtKES = v => `KES ${Math.round(parseFloat(v) || 0).toLocaleString('en-KE')}`;

const CHARGE_CATEGORIES = ['Delivery Fee', 'Installation Fee', 'Design Fee', 'Rush Fee', 'Discount'];

export default function DeliveryNotePage() {
  const { id }        = useParams();
  const searchParams  = useSearchParams();
  const batchId       = searchParams.get('batch');
  const showAmounts   = searchParams.get('show') === 'amounts';

  const [order,    setOrder]    = useState(null);
  const [items,    setItems]    = useState([]);   // display items (order or batch scoped)
  const [batch,    setBatch]    = useState(null);  // batch row if batchId is set
  const [payments, setPayments] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    async function load() {
      try {
        // Always fetch the order
        const ordRes = await supabase.from('orders').select('*').eq('id', id).single();
        if (ordRes.error) throw new Error(ordRes.error.message);
        setOrder(ordRes.data);

        if (batchId) {
          // ── Batch-scoped mode ────────────────────────────────────────────
          const [batchRes, paysRes] = await Promise.all([
            supabase
              .from('delivery_batches')
              .select(`
                *,
                delivery_batch_items (
                  id, quantity_planned, quantity_delivered,
                  order_items ( id, category, description, size, finish_type, finish_color, wood_type, unit_price, sort_order )
                )
              `)
              .eq('id', batchId)
              .eq('order_id', id)
              .single(),
            supabase.from('order_payments').select('*').eq('order_id', id).order('payment_date'),
          ]);
          if (batchRes.error) throw new Error(batchRes.error.message);
          setBatch(batchRes.data);
          setPayments(paysRes.data || []);

          // Build display items from batch items, sorted by order_items.sort_order
          const batchItems = (batchRes.data?.delivery_batch_items || [])
            .sort((a, b) => (a.order_items?.sort_order || 0) - (b.order_items?.sort_order || 0))
            .map(bi => ({
              ...bi.order_items,
              quantity: bi.quantity_planned,        // planned qty for this batch
              quantity_delivered: bi.quantity_delivered,
            }));
          setItems(batchItems);

        } else {
          // ── Full order mode ──────────────────────────────────────────────
          const [itemsRes, paysRes] = await Promise.all([
            supabase.from('order_items').select('*').eq('order_id', id).order('sort_order'),
            supabase.from('order_payments').select('*').eq('order_id', id).order('payment_date'),
          ]);
          setItems(itemsRes.data || []);
          setPayments(paysRes.data || []);
        }

      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, batchId]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <p style={{ color: '#9ca3af', fontSize: 14 }}>Preparing delivery note…</p>
    </div>
  );

  if (error || !order) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <p style={{ color: '#dc2626' }}>Error: {error || 'Order not found'}</p>
    </div>
  );

  const regularItems   = items.filter(i => !CHARGE_CATEGORIES.includes(i.category));
  const chargeItems    = items.filter(i => CHARGE_CATEGORIES.includes(i.category));
  const totalPaid      = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const balance        = Math.max((parseFloat(order.total_value) || 0) - totalPaid, 0);
  const totalPieces    = regularItems.reduce((s, i) => s + (parseInt(i.quantity) || 0), 0);
  const itemsSubtotal  = regularItems.reduce((s, i) => s + (parseFloat(i.unit_price) || 0) * (parseInt(i.quantity) || 1), 0);

  // Batch logistics (driver, date, vehicle) — prefer batch data when available
  const deliveryDate = batch?.actual_delivery_date || batch?.planned_date || order.due_date;
  const driver       = batch?.driver       || null;
  const vehicle      = batch?.vehicle      || null;
  const batchNum     = batch?.batch_number || null;
  const deliveryLoc  = batch?.delivery_location || order.delivery_address;

  const docTitle = showAmounts ? 'INTERNAL COPY' : 'DELIVERY NOTE';

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

        .toolbar {
          max-width: 800px;
          margin: 0 auto 16px;
          padding: 0 48px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .toggle-link {
          font-size: 12px;
          color: #6b7280;
          text-decoration: none;
          padding: 5px 10px;
          border: 1px solid #e5e7eb;
          border-radius: 5px;
          background: #fff;
        }
        .toggle-link:hover { background: #f9fafb; }

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
        .center { text-align: center; }
      `}</style>

      {/* ── Toolbar (hidden on print) ── */}
      <div className="no-print toolbar">
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Toggle between the two versions */}
          {showAmounts ? (
            <a
              href={`/orders/${id}/delivery-note${batchId ? `?batch=${batchId}` : ''}`}
              className="toggle-link"
            >
              ← Switch to Delivery Note
            </a>
          ) : (
            <a
              href={`/orders/${id}/delivery-note?${batchId ? `batch=${batchId}&` : ''}show=amounts`}
              className="toggle-link"
            >
              Switch to Internal Copy →
            </a>
          )}
        </div>
        <button
          onClick={() => window.print()}
          style={{
            padding: '9px 20px', background: '#E8512A', color: '#fff',
            border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}
        >
          🖨 Print / Save PDF
        </button>
      </div>

      <div className="page">

        {/* ── Header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28, borderBottom: '3px solid #E8512A', paddingBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <img src="/canvas-guy-logo.png" alt="Canvas Guy Limited" style={{ width: 64, height: 64, objectFit: 'contain' }} />
            <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.7 }}>
              Nairobi, Kenya<br />
              info@canvasguy.co.ke
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#111', letterSpacing: '-0.3px' }}>{docTitle}</div>
            {showAmounts && (
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#dc2626', marginTop: 2 }}>CONFIDENTIAL</div>
            )}
            <div style={{ fontFamily: 'monospace', fontSize: 13, color: '#E8512A', fontWeight: 700, marginTop: 4 }}>
              {order.order_num}{batchNum ? ` · Batch ${batchNum}` : ''}
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
              Date: {fmtDate(new Date().toISOString().split('T')[0])}<br />
              {batchId ? `Delivery date: ${fmtDate(deliveryDate)}` : `Due: ${fmtDate(order.due_date)}`}
            </div>
          </div>
        </div>

        {/* ── Client + Delivery info ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 6 }}>Deliver To</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#111', marginBottom: 4 }}>{order.client}</div>
            {order.contact_person && <div style={{ fontSize: 12, color: '#374151' }}>{order.contact_person}</div>}
            {order.delivery_contact && order.delivery_contact !== order.contact_person && (
              <div style={{ fontSize: 12, color: '#374151' }}>📞 {order.delivery_contact}</div>
            )}
            {deliveryLoc && (
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{deliveryLoc}</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 6 }}>
              {batchId ? 'Logistics' : 'Order Details'}
            </div>
            {batchId ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Driver </span><span style={{ fontWeight: 600, color: '#111' }}>{driver || '—'}</span></div>
                <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Vehicle </span><span style={{ fontWeight: 600, color: '#111' }}>{vehicle || '—'}</span></div>
                <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Date </span><span style={{ fontWeight: 600, color: '#111' }}>{fmtDate(deliveryDate)}</span></div>
                {showAmounts && order.invoice_number && (
                  <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Invoice # </span><span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#111' }}>{order.invoice_number}</span></div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {order.quote_number && <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Quote # </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{order.quote_number}</span></div>}
                {order.invoice_number && <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Invoice # </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{order.invoice_number}</span></div>}
                <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Sales rep </span><span style={{ fontWeight: 600 }}>{order.author || '—'}</span></div>
                <div style={{ fontSize: 12 }}><span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af' }}>Payment terms </span><span style={{ fontWeight: 600 }}>{order.payment_terms || '—'}</span></div>
              </div>
            )}
          </div>
        </div>

        {/* Special instructions */}
        {order.delivery_instructions && (
          <div style={{ background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: 7, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: '#92400e' }}>
            <span style={{ fontWeight: 700 }}>Special instructions: </span>{order.delivery_instructions}
          </div>
        )}
        {batch?.notes && (
          <div style={{ background: '#f0f9ff', border: '1.5px solid #bae6fd', borderRadius: 7, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: '#0369a1' }}>
            <span style={{ fontWeight: 700 }}>Batch notes: </span>{batch.notes}
          </div>
        )}

        {/* ── Items table ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 8 }}>
            Items {batchId ? `— Batch ${batchNum}` : ''}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th>Category</th>
                <th>Description / Spec</th>
                <th className="center" style={{ width: 54 }}>Qty</th>
                {showAmounts && <>
                  <th className="right" style={{ width: 100 }}>Unit Price</th>
                  <th className="right" style={{ width: 100 }}>Total</th>
                </>}
              </tr>
            </thead>
            <tbody>
              {regularItems.length === 0 && (
                <tr><td colSpan={showAmounts ? 6 : 4} style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>No items</td></tr>
              )}
              {regularItems.map((item, idx) => {
                const spec     = [item.size, item.finish_type, item.finish_color, item.wood_type].filter(Boolean).join(' · ');
                const rowTotal = (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1);
                return (
                  <tr key={item.id}>
                    <td style={{ color: '#9ca3af' }}>{idx + 1}</td>
                    <td style={{ fontWeight: 700 }}>{item.category}</td>
                    <td style={{ color: '#6b7280' }}>{spec || item.description || '—'}</td>
                    <td className="center mono" style={{ fontWeight: 700, fontSize: 14 }}>{item.quantity}</td>
                    {showAmounts && <>
                      <td className="right mono">{fmtKES(item.unit_price)}</td>
                      <td className="right mono" style={{ fontWeight: 700 }}>{fmtKES(rowTotal)}</td>
                    </>}
                  </tr>
                );
              })}
            </tbody>

            {showAmounts && (
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan={showAmounts ? 5 : 3} style={{ textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', padding: '8px 10px' }}>Items subtotal</td>
                  <td className="right mono" style={{ fontWeight: 700, padding: '8px 10px' }}>{fmtKES(itemsSubtotal)}</td>
                </tr>
                {chargeItems.map(ci => (
                  <tr key={ci.id}>
                    <td colSpan={5} style={{ textAlign: 'right', fontSize: 11, fontWeight: 600, color: '#6b7280', padding: '4px 10px' }}>{ci.category}</td>
                    <td className="right mono" style={{ fontWeight: 600, padding: '4px 10px' }}>{fmtKES(ci.unit_price)}</td>
                  </tr>
                ))}
                <tr style={{ background: '#111827' }}>
                  <td colSpan={5} style={{ textAlign: 'right', fontSize: 12, fontWeight: 800, color: '#fff', padding: 10 }}>Contract Total</td>
                  <td className="right mono" style={{ fontWeight: 800, color: '#E8512A', fontSize: 14, padding: 10 }}>{fmtKES(order.total_value)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* ── Piece count (always shown) ── */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: showAmounts ? 20 : 28 }}>
          <div style={{ border: '1.5px solid #e5e7eb', borderRadius: 7, padding: '8px 20px', textAlign: 'center', minWidth: 100 }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: '0.08em', marginBottom: 2 }}>Total Pieces</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 18, color: '#111' }}>{totalPieces}</div>
          </div>
        </div>

        {/* ── Payment summary (amounts mode only) ── */}
        {showAmounts && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 28 }}>
            {[
              { label: 'Contract Total', value: fmtKES(order.total_value),  color: '#111' },
              { label: 'Amount Paid',    value: fmtKES(totalPaid),          color: '#16a34a' },
              { label: 'Balance Due',    value: fmtKES(balance),            color: balance > 0 ? '#E8512A' : '#16a34a' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
                <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: 14, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Signature block ── */}
        <div style={{ borderTop: '2px solid #e5e7eb', paddingTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24 }}>
          {['Prepared by (Canvas Guy)', 'Delivered by', 'Received by (Client)'].map(label => (
            <div key={label}>
              <div style={{ borderBottom: '1.5px solid #374151', marginBottom: 6, height: 40 }} />
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
              <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>Name &amp; Date</div>
            </div>
          ))}
        </div>

        {/* ── Footer ── */}
        <div style={{ marginTop: 28, textAlign: 'center', fontSize: 10, color: '#d1d5db', borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
          Canvas Guy Limited · Nairobi, Kenya · {order.order_num}
          {showAmounts && <span style={{ color: '#fca5a5' }}> · CONFIDENTIAL — FOR AUTHORISED RECIPIENTS ONLY</span>}
        </div>

      </div>
    </>
  );
}
