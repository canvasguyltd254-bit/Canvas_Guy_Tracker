'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import AppShell from '@/shared/ui/AppShell';
import { createClient } from '@/shared/supabase/client';
import { STATUSES, REPAIR_STATUSES, ALL_STATUS_COLORS } from '@/modules/orders/components/constants';

const supabase = createClient();
const ALL_STATUSES = [...new Set([...STATUSES, ...REPAIR_STATUSES])];

export default function OrdersListPage() {
  const [orders, setOrders]             = useState([]);
  const [payTotals, setPayTotals]       = useState({});
  const [loading, setLoading]           = useState(true);
  const [searchTerm, setSearchTerm]     = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  const [filterType, setFilterType]     = useState('All');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: ord }, { data: pays }] = await Promise.all([
        supabase
          .from('orders')
          .select('id, order_num, client, due_date, status, total_value, order_type, created_at')
          .order('created_at', { ascending: false }),
        supabase.from('order_payments').select('order_id, amount'),
      ]);
      setOrders(ord || []);
      if (pays) {
        const t = {};
        pays.forEach(p => { t[p.order_id] = (t[p.order_id] || 0) + parseFloat(p.amount || 0); });
        setPayTotals(t);
      }
      setLoading(false);
    })();
  }, []);

  const statusCounts = useMemo(() =>
    ALL_STATUSES.reduce((acc, s) => {
      acc[s] = orders.filter(o => o.status === s).length;
      return acc;
    }, {}),
  [orders]);

  const filteredOrders = useMemo(() => orders.filter(o => {
    if (filterStatus !== 'Closed' && o.status === 'Closed') return false;
    if (filterStatus !== 'All' && o.status !== filterStatus) return false;
    if (filterType === 'standard' && (o.order_type === 'repair' || o.order_type === 'return')) return false;
    if (filterType === 'repairs' && o.order_type !== 'repair' && o.order_type !== 'return') return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return [o.order_num, o.client].filter(Boolean).join(' ').toLowerCase().includes(q);
    }
    return true;
  }), [orders, filterStatus, filterType, searchTerm]);

  const isFiltering = filterStatus !== 'All' || filterType !== 'All' || !!searchTerm;
  const clearFilters = () => { setFilterStatus('All'); setFilterType('All'); setSearchTerm(''); };

  const fmtDate = d => d
    ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '—';

  return (
    <AppShell>
      <div style={{ background: '#f7f7f5', minHeight: 'calc(100vh - 56px)' }}>

        {/* ── Page Header ── */}
        <div style={{
          background: '#fff', borderBottom: '1px solid #e5e7eb',
          position: 'sticky', top: '56px', zIndex: 9,
        }}>
          <div style={{ padding: '16px 20px 0' }}>

            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <div>
                <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#111', margin: 0 }}>Orders</h1>
                <p style={{ fontSize: '12px', color: '#9ca3af', margin: '2px 0 0' }}>
                  {filteredOrders.length} shown
                  {filterStatus === 'All' && (
                    <span style={{ marginLeft: '6px', color: '#bbb' }}>
                      · {orders.filter(o => o.status === 'Closed').length} closed hidden
                    </span>
                  )}
                </p>
              </div>
              <Link href="/orders/new" style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                padding: '8px 16px', borderRadius: '7px',
                background: '#E8512A', color: '#fff',
                fontWeight: 700, fontSize: '13px', textDecoration: 'none',
              }}>
                + New Order
              </Link>
            </div>

            {/* Status pills */}
            <div style={{ display: 'flex', gap: '5px', overflowX: 'auto', paddingBottom: '12px', WebkitOverflowScrolling: 'touch' }}>
              <button onClick={() => setFilterStatus('All')} style={{
                flexShrink: 0, padding: '5px 12px', borderRadius: '6px', cursor: 'pointer', border: '1.5px solid',
                background: filterStatus === 'All' ? '#1a1a1a' : '#fff',
                borderColor: filterStatus === 'All' ? '#1a1a1a' : '#e0e0e0',
                fontSize: '11px', whiteSpace: 'nowrap', fontWeight: 700,
                color: filterStatus === 'All' ? '#fff' : '#888',
              }}>
                <span style={{ fontFamily: 'monospace' }}>{orders.filter(o => o.status !== 'Closed').length}</span>
                <span style={{ marginLeft: '4px' }}>All Active</span>
              </button>

              {ALL_STATUSES.map(s => {
                const count  = statusCounts[s] || 0;
                const colors = ALL_STATUS_COLORS[s] || { bg: '#eee', text: '#333', border: '#ccc' };
                const active = filterStatus === s;
                return (
                  <button key={s} onClick={() => setFilterStatus(prev => prev === s ? 'All' : s)} style={{
                    flexShrink: 0, padding: '5px 10px', borderRadius: '6px', cursor: 'pointer', border: '1.5px solid',
                    background: active ? colors.bg : '#fff',
                    borderColor: active ? colors.border : '#e0e0e0',
                    fontSize: '11px', whiteSpace: 'nowrap',
                  }}>
                    <span style={{ fontWeight: 700, fontFamily: 'monospace', color: active ? colors.text : '#555' }}>{count}</span>
                    <span style={{ color: active ? colors.text : '#888', marginLeft: '4px' }}>{s}</span>
                  </button>
                );
              })}
            </div>

            {/* Search + filters */}
            <div style={{ display: 'flex', gap: '10px', paddingBottom: '14px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: '200px', position: 'relative' }}>
                <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: '13px' }}>🔍</span>
                <input
                  type="text"
                  placeholder="Search order number or client..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{
                    width: '100%', paddingLeft: '32px', paddingRight: '10px',
                    paddingTop: '7px', paddingBottom: '7px',
                    border: '1.5px solid #e0e0e0', borderRadius: '7px',
                    fontSize: '13px', outline: 'none', boxSizing: 'border-box', background: '#fafafa',
                  }}
                />
              </div>
              <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{
                padding: '7px 12px', border: '1.5px solid #e0e0e0', borderRadius: '7px',
                fontSize: '13px', outline: 'none', background: '#fafafa', cursor: 'pointer',
              }}>
                <option value="All">All Types</option>
                <option value="standard">Orders</option>
                <option value="repairs">Repairs</option>
              </select>
              {isFiltering && (
                <button onClick={clearFilters} style={{
                  padding: '7px 14px', border: '1.5px solid #e0e0e0', borderRadius: '7px',
                  fontSize: '12px', fontWeight: 600, color: '#9ca3af', background: '#fff', cursor: 'pointer',
                }}>Clear</button>
              )}
            </div>
          </div>
        </div>

        {/* ── Orders Grid ── */}
        <main style={{ padding: '20px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
              <div style={{ textAlign: 'center', color: '#9ca3af' }}>
                <div style={{ fontSize: '28px', marginBottom: '10px' }}>⏳</div>
                <p style={{ fontSize: '14px' }}>Loading orders...</p>
              </div>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '32px', marginBottom: '10px' }}>📋</div>
                <p style={{ color: '#9ca3af', fontSize: '14px', marginBottom: '12px' }}>
                  {orders.length === 0 ? 'No orders yet' : 'No orders match this filter'}
                </p>
                {isFiltering && (
                  <button onClick={clearFilters} style={{ color: '#E8512A', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px' }}>
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: '14px' }}>
              {filteredOrders.map(order => {
                const colors  = ALL_STATUS_COLORS[order.status] || { bg: '#E5E7EB', text: '#374151', border: '#D1D5DB' };
                const tv      = parseFloat(order.total_value) || 0;
                const paid    = payTotals[order.id] || 0;
                const balance = Math.max(tv - paid, 0);
                const payPct  = tv > 0 ? Math.min(Math.round((paid / tv) * 100), 100) : 0;
                const fullPay = payPct >= 100;

                return (
                  <Link key={order.id} href={`/orders/${order.id}/form`} style={{ textDecoration: 'none', display: 'block' }}>
                    <div
                      style={{
                        background: '#fff',
                        border: '1px solid #e8e8e5',
                        borderLeft: `4px solid ${colors.text}`,
                        borderRadius: '10px',
                        padding: '14px 16px',
                        cursor: 'pointer',
                        transition: 'box-shadow 0.15s, transform 0.12s',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        height: '100%',
                        boxSizing: 'border-box',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.1)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.boxShadow = 'none';
                        e.currentTarget.style.transform = 'none';
                      }}
                    >
                      {/* Header */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '10px', color: '#9ca3af', fontFamily: 'monospace', letterSpacing: '.05em', marginBottom: '2px' }}>
                            {order.order_num}
                          </div>
                          <div style={{ fontSize: '14px', fontWeight: 700, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {order.client}
                          </div>
                        </div>
                        <span style={{
                          background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
                          fontSize: '9px', fontWeight: 700, padding: '3px 7px', borderRadius: '4px',
                          textTransform: 'uppercase', letterSpacing: '0.4px', whiteSpace: 'nowrap', flexShrink: 0,
                        }}>
                          {order.status}
                        </span>
                      </div>

                      {/* Due + Value */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '9px', color: '#aaa', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', marginBottom: '2px' }}>Due</div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#333' }}>{fmtDate(order.due_date)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '9px', color: '#aaa', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.5px', marginBottom: '2px' }}>Value</div>
                          <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: '#111' }}>
                            {tv > 0 ? `KES ${Math.round(tv).toLocaleString('en-KE')}` : '—'}
                          </div>
                        </div>
                      </div>

                      {/* Payment progress bar */}
                      {tv > 0 && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                            <span style={{ fontSize: '10px', color: '#888' }}>Payment</span>
                            <span style={{ fontSize: '10px', fontFamily: 'monospace', color: fullPay ? '#16a34a' : '#555' }}>
                              {fullPay
                                ? '✓ Fully paid'
                                : balance > 0
                                  ? `KES ${Math.round(balance).toLocaleString('en-KE')} due`
                                  : `${payPct}%`}
                            </span>
                          </div>
                          <div style={{ height: '5px', background: '#f0f0ee', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: '3px',
                              width: `${payPct}%`,
                              background: fullPay ? '#16a34a' : '#E8512A',
                              transition: 'width 0.3s',
                            }} />
                          </div>
                        </div>
                      )}

                      {/* Footer */}
                      <div style={{ borderTop: '1px solid #f3f3f1', paddingTop: '8px', display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
                        <span style={{ fontSize: '10px', fontWeight: 600, color: '#E8512A' }}>View details →</span>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
