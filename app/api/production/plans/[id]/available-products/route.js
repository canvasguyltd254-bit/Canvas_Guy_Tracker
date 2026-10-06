/**
 * app/api/production/plans/[id]/available-products/route.js
 *
 * GET /api/production/plans/:id/available-products
 *
 * Returns product-line order items from the plan's order that still have
 * UNALLOCATED quantity — i.e. units ordered but not yet covered by a
 * production job. This is the data source for the "+ Add product" picker.
 *
 * Business rule: a job can only be created from a product that already exists
 * on the linked order. No new products can be invented in the production module.
 *
 * ── Allocation maths — MUST mirror create_production_job() ───────────────────
 * The RPC (production_v1_schema.sql) computes available quantity as:
 *
 *     SELECT COALESCE(SUM(planned_quantity), 0)
 *     FROM   production_jobs
 *     WHERE  order_item_id = p_order_item_id
 *       AND  status != 'Cancelled';
 *
 * Two details matter and are reproduced exactly below:
 *   1. The sum is NOT scoped to a plan — it spans every job for that order item.
 *   2. Cancellation is determined by `status != 'Cancelled'`, NOT by
 *      `cancelled_at IS NULL`. Those two can drift; the RPC's predicate wins.
 *
 * If this route and the RPC disagree, the picker offers a quantity the RPC
 * then rejects — so keep them in lockstep.
 *
 * Response:
 *   { items: [{ id, description, size, finish_type, finish_color, wood_type,
 *               category, unit_price,
 *               quantity,           // total ordered
 *               allocated_quantity, // already covered by active jobs
 *               remaining_quantity  // what can still be added  (> 0)
 *            }] }
 *
 * Partially-allocated items ARE returned, with their remaining balance, so a
 * line can be split across several jobs (e.g. by finish or by batch).
 * Fully-allocated items are omitted.
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const planId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    // Resolve the plan's order
    const { data: plan } = await serviceClient
      .from('production_plans')
      .select('id, order_id')
      .eq('id', planId)
      .single();

    if (!plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    // All product lines on the order
    const { data: orderItems, error } = await serviceClient
      .from('order_items')
      .select(`
        id, description, size, finish_type, finish_color, wood_type,
        quantity, unit_price, line_type, category
      `)
      .eq('order_id', plan.order_id)
      .eq('line_type', 'product')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Available products GET (items):', error.message);
      return NextResponse.json({ error: 'Failed to fetch order items' }, { status: 500 });
    }

    const itemIds = (orderItems || []).map(i => i.id);
    if (itemIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    // Allocated quantity per order item — mirrors the RPC predicate exactly:
    // every non-Cancelled job for that item, across all plans.
    const { data: jobs, error: jobsErr } = await serviceClient
      .from('production_jobs')
      .select('order_item_id, planned_quantity, status')
      .in('order_item_id', itemIds)
      .neq('status', 'Cancelled');

    if (jobsErr) {
      console.error('Available products GET (jobs):', jobsErr.message);
      return NextResponse.json({ error: 'Failed to fetch existing jobs' }, { status: 500 });
    }

    const allocatedByItem = {};
    for (const j of (jobs || [])) {
      if (!j.order_item_id) continue;
      allocatedByItem[j.order_item_id] =
        (allocatedByItem[j.order_item_id] || 0) + (j.planned_quantity || 0);
    }

    // Keep only items with quantity still to allocate
    const items = (orderItems || [])
      .map(item => {
        const ordered   = item.quantity || 0;
        const allocated = allocatedByItem[item.id] || 0;
        return {
          ...item,
          allocated_quantity: allocated,
          remaining_quantity: ordered - allocated,
        };
      })
      .filter(item => item.remaining_quantity > 0);

    return NextResponse.json({ items });
  } catch (err) {
    console.error('Available products GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
