'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createClient } from '@/shared/supabase/client';
import { ALL_STATUS_COLORS, STATUSES } from '@/modules/orders/components/constants';

// Statuses to show in the pipeline (exclude terminal ones)
const PIPELINE_STATUSES = STATUSES.filter(
  s => !['Delivered', 'Closed', 'Cancelled / Refunded'].includes(s)
);

// Statuses counted as "active production workload"
const WORKLOAD_STATUSES = ['Material Check', 'Production', 'Quality Control'];

// Statuses counted as "completed"
const COMPLETED_STATUSES = ['Delivered', 'Closed'];

function fmtK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(Math.round(n));
}

function fmtDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({ label, value, color, href, icon }) {
  const inner = (
    <div style={{
      background: '#fff', border: '1.5px solid #E0DDD8', borderRadius: '10px',
      padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '14px',
    }}>
      {icon && (
        <div style={{
          width: '40px', height: '40px', borderRadius: '8px', flexShrink: 0,
          background: `${color || '#E8512A'}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '18px',
        }}>{icon}</div>
      )}
      <div>
        <div style={{
          fontSize: '26px', fontWeight: 800, color: color || '#1a1a1a',
          fontFamily: "'DM Mono', monospace", letterSpacing: '-1px', lineHeight: 1,
        }}>
          {value}
        </div>
        <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', fontWeight: 500 }}>
          {label}
        </div>
      </div>
    </div>
  );
  return href
    ? <Link href={href} style={{ textDecoration: 'none', display: 'block' }}>{inner}</Link>
    : <div>{inner}</div>;
}

function PipelineBar({ status, count, max }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const c = ALL_STATUS_COLORS[status] || { text: '#888' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' }}>
      <div style={{ width: '130px', fontSize: '12px', color: '#555', flexShrink: 0, fontWeight: 500 }}>
        {status}
      </div>
      <div style={{ flex: 1, height: '6px', background: '#f0ede8', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: c.text, borderRadius: '3px', transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ width: '20px', fontSize: '12px', fontWeight: 700, color: '#333', textAlign: 'right', fontFamily: 'monospace', flexShrink: 0 }}>
        {count}
      </div>
    </div>
  );
}

function WorkloadBar({ category, count, max }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const BAR_COLORS = {
    'Wall Decoration Canvas': '#E8512A',
    'Mirrors': '#1565C0',
    'Furniture': '#2E7D32',
    'Assorted Timber Products': '#795548',
    'Other': '#9E9E9E',
  };
  const color = BAR_COLORS[category] || '#888';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '3px 0' }}>
      <div style={{ width: '90px', fontSize: '11px', color: '#555', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {category}
      </div>
      <div style={{ flex: 1, height: '5px', background: '#f0ede8', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: color, borderRadius: '3px' }} />
      </div>
      <div style={{ width: '24px', fontSize: '11px', fontWeight: 700, color: '#333', textAlign: 'right', fontFamily: 'monospace', flexShrink: 0 }}>
        {count}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [orders, setOrders]         = useState([]);
  const [activities, setActivities] = useState([]);
  const [payTotals, setPayTotals]   = useState({});
  const [delTotals, setDelTotals]   = useState({});
  const [itemData, setItemData]     = useState([]);
  const [loaded, setLoaded]         = useState(false);

  const sb = createClient();

  useEffect(() => {
    (async () => {
      const [ordRes, actRes, payRes, delRes, itemRes] = await Promise.all([
        sb.from('orders').select('*').order('created_at', { ascending: false }),
        sb.from('order_activities').select('*').order('created_at', { ascending: false }).limit(25),
        sb.from('order_payments').select('order_id, amount'),
        sb.from('order_deliveries').select('order_id, quantity'),
        sb.from('order_items').select('order_id, quantity, category'),
      ]);

      setOrders(ordRes.data || []);
      setActivities(actRes.data || []);

      if (payRes.data) {
        const t = {};
        payRes.data.forEach(p => { t[p.order_id] = (t[p.order_id] || 0) + parseFloat(p.amount); });
        setPayTotals(t);
      }
      if (delRes.data) {
        const t = {};
        delRes.data.forEach(d => { t[d.order_id] = (t[d.order_id] || 0) + (d.quantity || 0); });
        setDelTotals(t);
      }
      setItemData(itemRes.data || []);
      setLoaded(true);
    })();
  }, []);

  if (!loaded) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#aaa' }}>Loading...</div>;
  }

  // ── Derived metrics ─────────────────────────────────────────────────────

  const now = new Date();

  const outstandingReceivables = orders
    .filter(o => !COMPLETED_STATUSES.includes(o.status))
    .reduce((s, o) => {
      const tv = parseFloat(o.total_value) || 0;
      const tp = payTotals[o.id] || 0;
      return s + Math.max(tv - tp, 0);
    }, 0);

  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - now.getDay());
  thisWeekStart.setHours(0, 0, 0, 0);
  const salesThisWeek = orders
    .filter(o => new Date(o.created_at) >= thisWeekStart)
    .reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);

  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);

  const dueThisWeek = orders.filter(o => {
    if (!o.due_date || COMPLETED_STATUSES.includes(o.status)) return false;
    const d = new Date(o.due_date + 'T12:00:00');
    return d >= now && d <= weekEnd;
  });

  const overdueOrders = orders.filter(o => {
    if (!o.due_date || COMPLETED_STATUSES.includes(o.status)) return false;
    return new Date(o.due_date + 'T12:00:00') < now;
  });

  const completedOrders  = orders.filter(o => COMPLETED_STATUSES.includes(o.status));
  const inProduction     = orders.filter(o => o.status === 'Production');

  // Items in workload statuses
  const workloadOrderIds = new Set(
    orders.filter(o => WORKLOAD_STATUSES.includes(o.status)).map(o => o.id)
  );
  const workloadItems    = itemData.filter(i => workloadOrderIds.has(i.order_id));
  const prodUnitsTotal   = workloadItems.reduce((s, i) => s + (i.quantity || 1), 0);

  // Collections due this week
  const collectionsThisWeek = dueThisWeek.reduce((s, o) => {
    const tv = parseFloat(o.total_value) || 0;
    const tp = payTotals[o.id] || 0;
    return s + Math.max(tv - tp, 0);
  }, 0);
  const collectionOrderCount = dueThisWeek.filter(o => {
    const tv = parseFloat(o.total_value) || 0;
    return (payTotals[o.id] || 0) < tv;
  }).length;

  // ── Pipeline ────────────────────────────────────────────────────────────
  const pipeline = PIPELINE_STATUSES
    .map(s => ({ status: s, count: orders.filter(o => o.status === s).length }))
    .filter(p => p.count > 0);
  const pipelineMax = pipeline.reduce((m, p) => Math.max(m, p.count), 0);

  // ── Production workload by category ────────────────────────────────────
  const workloadByCategory = {};
  workloadItems.forEach(i => {
    const cat = i.category || 'Other';
    workloadByCategory[cat] = (workloadByCategory[cat] || 0) + (i.quantity || 1);
  });
  const workloadEntries = Object.entries(workloadByCategory).sort((a, b) => b[1] - a[1]);
  const workloadMax     = workloadEntries.reduce((m, [, v]) => Math.max(m, v), 0);

  // ── Alerts ──────────────────────────────────────────────────────────────
  const itemSums = {};
  itemData.forEach(i => { itemSums[i.order_id] = (itemSums[i.order_id] || 0) + (i.quantity || 1); });

  const stalledOrders = orders.filter(o =>
    !COMPLETED_STATUSES.includes(o.status) &&
    (now - new Date(o.updated_at)) / 86400000 > 3
  );

  const partialDeliveries = orders.filter(o => {
    if (!['Partially Delivered', 'Ready for Delivery'].includes(o.status)) return false;
    const tq = itemSums[o.id] || 0;
    const td = delTotals[o.id] || 0;
    return tq > 0 && td > 0 && td < tq;
  });

  const alerts = [
    ...overdueOrders.map(o => ({
      dot: '#C62828',
      text: `${o.order_num} — ${o.client} overdue since ${fmtDate(o.due_date)}`,
    })),
    ...stalledOrders.map(o => ({
      dot: '#FF6F00',
      text: `${o.order_num} — ${o.client} stalled ${Math.floor((now - new Date(o.updated_at)) / 86400000)}d in ${o.status}`,
    })),
    ...partialDeliveries.map(o => ({
      dot: '#1565C0',
      text: `${o.order_num} — ${o.client} partial delivery (${delTotals[o.id] || 0}/${itemSums[o.id] || 0} units)`,
    })),
  ];

  // ── This week calendar ──────────────────────────────────────────────────
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    return {
      date: d,
      orders: orders.filter(o => {
        if (!o.due_date) return false;
        return new Date(o.due_date + 'T12:00:00').toDateString() === d.toDateString();
      }),
    };
  });

  // ── KPI config ──────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Outstanding (KES)',     value: fmtK(outstandingReceivables), color: '#6D28D9', href: '/reports?type=receivables', icon: '💰' },
    { label: 'Sales this week (KES)', value: fmtK(salesThisWeek),          color: '#1565C0', href: '/reports?type=sales-week',  icon: '📈' },
    { label: 'Total orders',          value: orders.length,                  color: '#1a1a1a', href: '/orders',                   icon: '📋' },
    { label: 'In production',         value: inProduction.length,            color: '#E65100', href: '/reports?type=production',  icon: '🔨' },
    { label: 'Due this week',         value: dueThisWeek.length,             color: '#1565C0', href: '/reports?type=due-week',   icon: '📅' },
    { label: 'Overdue',               value: overdueOrders.length,           color: overdueOrders.length > 0 ? '#C62828' : '#999', href: '/reports?type=overdue', icon: '⚠️' },
    { label: 'Completed',             value: completedOrders.length,         color: '#2E7D32', href: '/orders?status=Delivered', icon: '✅' },
    { label: 'Units in production',   value: prodUnitsTotal,                 color: '#E65100', href: '/reports?type=workload',   icon: '⚙️' },
  ];

  // ── Shared panel style ──────────────────────────────────────────────────
  const panel = {
    background: '#fff',
    borderRadius: '10px',
    padding: '18px 20px',
    border: '1px solid #e8e8e5',
  };
  const panelTitle = {
    fontSize: '11px', fontWeight: 700, color: '#888',
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '14px',
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '20px 16px' }}>

      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '20px', gap: '8px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px', flexShrink: 0 }}>Dashboard</h1>
        <span style={{ fontSize: '12px', color: '#aaa' }}>
          {now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      </div>

      {/* KPI strip — money first, operations second */}
      <div className="dash-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
        {kpis.map(k => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* 3-column lower section */}
      <div className="dash-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>

        {/* ── Col 1: This Week ── */}
        <div style={panel}>
          <div style={panelTitle}>This Week</div>
          {weekDays.map(({ date, orders: dayOrders }) => {
            const isToday = date.toDateString() === now.toDateString();
            return (
              <div key={date.toISOString()} style={{
                display: 'flex', gap: '10px', padding: '6px 8px', borderRadius: '6px', marginBottom: '2px',
                background: isToday ? '#FFFDE7' : 'transparent',
                border: isToday ? '1px solid #FFD54F' : '1px solid transparent',
              }}>
                <div style={{ width: '36px', flexShrink: 0 }}>
                  <div style={{ fontSize: '9px', color: '#999', fontWeight: 700 }}>
                    {date.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase()}
                  </div>
                  <div style={{ fontSize: '17px', fontWeight: 700, color: isToday ? '#E65100' : '#333', fontFamily: "'DM Mono', monospace", lineHeight: 1.1 }}>
                    {date.getDate()}
                  </div>
                </div>
                <div style={{ flex: 1, paddingTop: '1px' }}>
                  {dayOrders.length === 0 ? (
                    <div style={{ fontSize: '11px', color: '#ccc' }}>No deadlines</div>
                  ) : dayOrders.map(o => {
                    const isOd = new Date(o.due_date + 'T12:00:00') < now && !COMPLETED_STATUSES.includes(o.status);
                    const sc = ALL_STATUS_COLORS[o.status] || { text: '#999' };
                    return (
                      <div key={o.id} style={{ fontSize: '11px', color: isOd ? '#C62828' : '#333', fontWeight: isOd ? 700 : 400, padding: '1px 0' }}>
                        <span style={{ color: isOd ? '#C62828' : sc.text, fontWeight: 700 }}>● </span>
                        <Link href={`/orders/${o.id}/form`} style={{ color: 'inherit', textDecoration: 'none' }}>
                          {o.order_num} — {o.client}
                        </Link>
                        {isOd && ' ⚠'}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Col 2: Alerts + Recent Activity ── */}
        <div style={panel}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <span style={{ ...panelTitle, marginBottom: 0 }}>Alerts</span>
            {alerts.length > 0 && (
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#C62828', background: '#FEE2E2', padding: '2px 8px', borderRadius: '4px' }}>
                {alerts.length}
              </span>
            )}
          </div>

          {alerts.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#bbb', textAlign: 'center', padding: '12px 0 20px' }}>All clear</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '20px' }}>
              {alerts.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 10px', borderRadius: '6px', background: '#FFFBF0', border: `1px solid ${a.dot}33` }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: a.dot, flexShrink: 0, marginTop: '4px' }} />
                  <span style={{ fontSize: '11px', color: '#333', flex: 1, lineHeight: 1.4 }}>{a.text}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ borderTop: '1px solid #f0ede8', paddingTop: '14px' }}>
            <div style={panelTitle}>Recent Activity</div>
            {activities.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#bbb', textAlign: 'center' }}>No activity</div>
            ) : activities.slice(0, 10).map(a => (
              <div key={a.id} style={{ display: 'flex', gap: '8px', padding: '5px 0', borderBottom: '1px solid #f5f5f5', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '10px', color: '#aaa', flexShrink: 0, width: '44px', marginTop: '1px' }}>
                  {new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
                <span style={{ fontSize: '11px', color: '#555', lineHeight: 1.4 }}>{a.description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Col 3: Pipeline + Workload + Collections + Contacts ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Pipeline */}
          <div style={panel}>
            <div style={panelTitle}>Pipeline</div>
            {pipeline.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#bbb', textAlign: 'center', padding: '8px 0' }}>No active orders</div>
            ) : pipeline.map(p => (
              <PipelineBar key={p.status} status={p.status} count={p.count} max={pipelineMax} />
            ))}
          </div>

          {/* Production Workload */}
          {workloadEntries.length > 0 && (
            <div style={panel}>
              <div style={panelTitle}>Production Workload</div>
              <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '10px' }}>
                {prodUnitsTotal} units · {workloadOrderIds.size} orders in production
              </div>
              {workloadEntries.map(([cat, count]) => (
                <WorkloadBar key={cat} category={cat} count={count} max={workloadMax} />
              ))}
            </div>
          )}

          {/* Outstanding Collections */}
          {collectionsThisWeek > 0 && (
            <div style={{ ...panel, borderLeft: '3px solid #6D28D9' }}>
              <div style={panelTitle}>Outstanding Collections</div>
              <div style={{ fontSize: '24px', fontWeight: 800, color: '#6D28D9', fontFamily: "'DM Mono', monospace", letterSpacing: '-0.5px', lineHeight: 1 }}>
                KES {collectionsThisWeek.toLocaleString()}
              </div>
              <div style={{ fontSize: '11px', color: '#aaa', marginTop: '5px' }}>
                Due this week · {collectionOrderCount} {collectionOrderCount === 1 ? 'order' : 'orders'}
              </div>
            </div>
          )}

          {/* Contacts directory */}
          <Link href="/contacts" style={{ ...panel, textDecoration: 'none', color: '#333', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '2px' }}>Supplier &amp; Contact Directory</div>
              <div style={{ fontSize: '11px', color: '#aaa' }}>View the team contact list</div>
            </div>
            <span style={{ color: '#ccc', fontSize: '18px' }}>→</span>
          </Link>

        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .dash-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 768px) {
          .dash-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

    </div>
  );
}
