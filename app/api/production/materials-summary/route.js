/**
 * app/api/production/materials-summary/route.js
 *
 * GET /api/production/materials-summary
 *
 * Returns the full Order → Job → Material hierarchy for costing.
 * No N+1: one query fetches everything in one round-trip.
 *
 * Query params:
 *   plan_status  — comma-separated plan statuses to include, default "Active"
 *                  e.g. ?plan_status=Draft,Active
 *   costing      — "needs_costing" | "fully_costed" | omit for all
 *
 * Response shape:
 *   { orders: [ { order_id, order_num, client, due_date, jobs: [...] } ] }
 *
 * Each job:
 *   { job_id, job_num, name, specification, planned_quantity,
 *     size, finish_type, finish_color, wood_type, status,
 *     costing_status, total_lines, costed_lines, estimated_subtotal,
 *     materials: [ { id, material_name, specification, unit,
 *                    estimated_quantity, estimated_unit_cost,
 *                    estimated_total_cost, preferred_supplier } ] }
 *
 * Only product jobs are returned (strict line_type = 'product'; legacy NULLs classified by v1g).
 * Cancelled jobs are excluded.
 *
 * Roles: admin, production_manager, head_of_sales, production_staff
 */

export const runtime = 'nodejs';

import { NextResponse }                         from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);   // costing view: managers only
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const planStatusParam  = searchParams.get('plan_status') || 'Active';
    const costingFilter    = searchParams.get('costing') || null; // needs_costing | fully_costed

    const planStatuses = planStatusParam.split(',').map(s => s.trim()).filter(Boolean);

    // ── Single query: plans → jobs → materials + supplier ─────────────────────
    let query = serviceClient
      .from('production_plans')
      .select(`
        id,
        orders(id, order_num, client, due_date),
        production_jobs(
          id, job_num, order_item_id, status,
          category, description, size,
          finish_type, finish_color, wood_type,
          planned_quantity,
          cancelled_at,
          order_items(line_type),
          production_material_estimates(
            id, material_name, specification, unit,
            estimated_quantity, estimated_unit_cost, estimated_total_cost,
            boq_line_type, cost_source_type, preferred_supplier_id,
            suppliers(id, name)
          )
        )
      `)
      .is('archived_at', null)
      .order('created_at', { ascending: false });

    if (planStatuses.length === 1) {
      query = query.eq('status', planStatuses[0]);
    } else {
      query = query.in('status', planStatuses);
    }

    const { data: plans, error } = await query;
    if (error) {
      console.error('materials-summary GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch materials summary' }, { status: 500 });
    }

    // ── Derive costing_status from material lines ──────────────────────────────
    // A line is "estimate complete" when:
    //   estimated_unit_cost IS NOT NULL
    //   AND cost_source_type IS NOT NULL
    //   AND (cost_source_type != 'supplier' OR preferred_supplier_id IS NOT NULL)
    function isLineComplete(m) {
      if (m.estimated_unit_cost == null) return false;
      if (!m.cost_source_type) return false;
      if (m.cost_source_type === 'supplier' && !m.preferred_supplier_id) return false;
      if (m.boq_line_type === 'outsourced_service' && !m.preferred_supplier_id) return false;
      return true;
    }
    function costingStatus(materials) {
      if (!materials || materials.length === 0) return 'boq_missing';
      const allComplete  = materials.every(isLineComplete);
      const someComplete = materials.some(isLineComplete);
      if (allComplete)  return 'fully_costed';
      if (someComplete) return 'partial';
      return 'not_costed';
    }

    // ── Transform plans → orders array ────────────────────────────────────────
    const orderMap = new Map(); // order_id → order entry

    for (const plan of (plans || [])) {
      const order = plan.orders;
      if (!order) continue;

      if (!orderMap.has(order.id)) {
        orderMap.set(order.id, {
          order_id:  order.id,
          order_num: order.order_num,
          client:    order.client,
          due_date:  order.due_date,
          plan_id:   plan.id,
          jobs:      [],
        });
      }

      const entry = orderMap.get(order.id);

      for (const job of (plan.production_jobs || [])) {
        // Product jobs only; exclude cancelled (strict equality — v1g classified legacy NULLs)
        if (job.cancelled_at) continue;
        if (job.order_items?.line_type !== 'product') continue;

        const materials = (job.production_material_estimates || []).map(m => ({
          id:                   m.id,
          material_name:        m.material_name,
          specification:        m.specification || null,
          unit:                 m.unit,
          boq_line_type:        m.boq_line_type || 'material',
          cost_source_type:     m.cost_source_type || null,
          estimated_quantity:   m.estimated_quantity != null ? Number(m.estimated_quantity) : null,
          estimated_unit_cost:  m.estimated_unit_cost != null ? Number(m.estimated_unit_cost) : null,
          estimated_total_cost: m.estimated_total_cost != null ? Number(m.estimated_total_cost) : null,
          preferred_supplier:   m.suppliers ? { id: m.suppliers.id, name: m.suppliers.name } : null,
        }));

        const status    = costingStatus(materials);
        const costedCt  = materials.filter(isLineComplete).length;
        const subtotal  = materials.reduce((s, m) => s + (m.estimated_total_cost || 0), 0);

        entry.jobs.push({
          job_id:            job.id,
          job_num:           job.job_num,
          name:              job.description || job.category || 'Untitled',
          size:              job.size        || null,
          finish_type:       job.finish_type || null,
          finish_color:      job.finish_color || null,
          wood_type:         job.wood_type   || null,
          planned_quantity:  job.planned_quantity,
          status:            job.status,
          costing_status:    status,
          total_lines:       materials.length,
          costed_lines:      costedCt,
          estimated_subtotal: subtotal,
          materials,
        });
      }
    }

    let orders = Array.from(orderMap.values()).filter(o => o.jobs.length > 0);

    // ── Costing filter ─────────────────────────────────────────────────────────
    if (costingFilter === 'needs_costing') {
      orders = orders.map(o => ({
        ...o,
        jobs: o.jobs.filter(j => j.costing_status !== 'fully_costed'),
      })).filter(o => o.jobs.length > 0);
    } else if (costingFilter === 'fully_costed') {
      orders = orders.map(o => ({
        ...o,
        jobs: o.jobs.filter(j => j.costing_status === 'fully_costed'),
      })).filter(o => o.jobs.length > 0);
    }

    // ── Order-level summary rollup ─────────────────────────────────────────────
    orders = orders.map(o => {
      const totalJobs       = o.jobs.length;
      const fullyCostedJobs = o.jobs.filter(j => j.costing_status === 'fully_costed').length;
      const uncostedLines   = o.jobs.reduce((s, j) => s + (j.total_lines - j.costed_lines), 0);
      const orderSubtotal   = o.jobs.reduce((s, j) => s + j.estimated_subtotal, 0);
      return { ...o, total_jobs: totalJobs, fully_costed_jobs: fullyCostedJobs, uncosted_lines: uncostedLines, estimated_subtotal: orderSubtotal };
    });

    return NextResponse.json({ orders });
  } catch (err) {
    console.error('materials-summary GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
