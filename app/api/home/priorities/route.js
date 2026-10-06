/**
 * app/api/home/priorities/route.js
 *
 * GET /api/home/priorities
 *
 * Powers the Home page's "Needs your attention" queue and "Production floor"
 * strip. Every row here is a real, individually-traceable record (an order,
 * a job) — nothing here is synthesized or aggregated beyond what's needed
 * to sort it. Each queue item carries a `source` so the UI can route straight
 * to where the record actually lives.
 *
 * Cashflow-derived items (payment plans, etc.) are intentionally absent:
 * the forecast engine isn't exposed via an API route yet (see
 * /api/home/summary's cashflow.connected flag), so there is nothing real to
 * show here for that yet — omitting is the honest choice, not a placeholder.
 *
 * Response shape:
 *   {
 *     queue: [{
 *       type: 'customer_overdue' | 'production_blocked' | 'production_qc_ready',
 *       id, title, subtitle,
 *       chip: { tone: 'red'|'amber'|'blue', label },
 *       source: { module: 'customers'|'production', path },
 *       sortWeight: number,   // lower sorts first within the queue
 *     }],
 *     floor: [{
 *       jobId, jobNum, orderNum, client, description, category,
 *       plannedQuantity, acceptedQty, inProductionQty, awaitingQcQty,
 *       status, pct, blocked, blockerReason,
 *     }],
 *   }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, serviceClient } from '@/shared/lib/api-auth';
import { DELIVERED_STATUSES, CAN_SEE_PRODUCTION, CAN_SEE_CUSTOMERS } from '@/shared/lib/homeAccess';

const QUEUE_LIMIT = 25;
const FLOOR_STATUSES = ['Awaiting Materials', 'Materials Ready', 'In Production', 'Quality Control', 'Paused'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const today = new Date().toISOString().split('T')[0];
    const queue = [];
    let floorTask = Promise.resolve([]);
    const tasks = [];

    // ── Customer overdue collections ──────────────────────────────────────
    if (CAN_SEE_CUSTOMERS.includes(role)) {
      tasks.push(
        serviceClient
          .from('orders')
          .select('id, order_num, client, total_value, payment_due_date, order_payments(amount, reversed_at)')
          .in('status', DELIVERED_STATUSES)
          .not('payment_due_date', 'is', null)
          .lt('payment_due_date', today)
          .then(({ data, error }) => {
            if (error) { console.error('home/priorities customers:', error.message); return; }
            for (const order of (data || [])) {
              const paid = (order.order_payments || [])
                .filter(p => !p.reversed_at)
                .reduce((s, p) => s + parseFloat(p.amount || 0), 0);
              const remaining = parseFloat(order.total_value || 0) - paid;
              if (remaining <= 0.01) continue;
              const daysOverdue = Math.floor((Date.parse(today) - Date.parse(order.payment_due_date)) / 86400000);
              queue.push({
                type: 'customer_overdue',
                id: order.id,
                title: `${order.client} · ${order.order_num}`,
                subtitle: `KES ${remaining.toLocaleString('en-KE', { maximumFractionDigits: 0 })} outstanding · due ${order.payment_due_date}`,
                chip: { tone: 'red', label: `${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue` },
                source: { module: 'customers', path: `/customers?order=${order.id}` },
                sortWeight: -daysOverdue, // most overdue first (more negative sorts earlier)
              });
            }
          })
      );
    }

    // ── Production: blocked jobs + QC-ready jobs ──────────────────────────
    if (CAN_SEE_PRODUCTION.includes(role)) {
      tasks.push(
        serviceClient
          .from('production_jobs')
          .select('id, job_num, description, category, status, blocker_reason, awaiting_qc_qty, order_id, orders(order_num, client)')
          .not('status', 'in', '(Completed,Cancelled)')
          .then(({ data, error }) => {
            if (error) { console.error('home/priorities production:', error.message); return; }
            for (const job of (data || [])) {
              const isBlocked = job.status === 'Awaiting Materials' || (job.status === 'Paused' && !!job.blocker_reason);
              if (isBlocked) {
                queue.push({
                  type: 'production_blocked',
                  id: job.id,
                  title: `${job.description || job.category || 'Job'} · ${job.job_num}`,
                  subtitle: job.blocker_reason
                    ? `${job.orders?.order_num || ''} · ${job.blocker_reason}`
                    : `${job.orders?.order_num || ''} · awaiting materials`,
                  chip: { tone: 'amber', label: job.status === 'Paused' ? 'Paused' : 'Materials' },
                  source: { module: 'production', path: `/production/jobs/${job.id}` },
                  sortWeight: 0,
                });
              } else if ((job.awaiting_qc_qty || 0) > 0) {
                queue.push({
                  type: 'production_qc_ready',
                  id: job.id,
                  title: `${job.awaiting_qc_qty} unit${job.awaiting_qc_qty === 1 ? '' : 's'} awaiting quality control`,
                  subtitle: `${job.orders?.order_num || ''} · ${job.description || job.category || job.job_num}`,
                  chip: { tone: 'blue', label: 'QC ready' },
                  source: { module: 'production', path: `/production/jobs/${job.id}` },
                  sortWeight: 10,
                });
              }
            }
          })
      );

      // ── Production floor: everything currently active on the shop floor ──
      floorTask = serviceClient
          .from('production_jobs')
          .select(`
            id, job_num, description, category, status, blocker_reason,
            planned_quantity, accepted_qty, in_production_qty, awaiting_qc_qty,
            order_id, orders(order_num, client)
          `)
          .in('status', FLOOR_STATUSES)
          .then(({ data, error }) => {
            if (error) { console.error('home/priorities floor:', error.message); return []; }
            return (data || []).map(job => {
              const blocked = job.status === 'Awaiting Materials' || (job.status === 'Paused' && !!job.blocker_reason);
              const pct = job.planned_quantity > 0
                ? Math.round((job.accepted_qty / job.planned_quantity) * 100)
                : 0;
              return {
                jobId: job.id,
                jobNum: job.job_num,
                orderNum: job.orders?.order_num || null,
                client: job.orders?.client || null,
                description: job.description,
                category: job.category,
                plannedQuantity: job.planned_quantity,
                acceptedQty: job.accepted_qty,
                inProductionQty: job.in_production_qty,
                awaitingQcQty: job.awaiting_qc_qty,
                status: job.status,
                pct,
                blocked,
                blockerReason: job.blocker_reason || null,
              };
            });
          });
    }

    const [, floor] = await Promise.all([Promise.all(tasks), floorTask]);

    queue.sort((a, b) => a.sortWeight - b.sortWeight);

    return NextResponse.json({
      success: true,
      data: {
        queue: queue.slice(0, QUEUE_LIMIT),
        floor,
      },
    });
  } catch (err) {
    console.error('GET /api/home/priorities:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
