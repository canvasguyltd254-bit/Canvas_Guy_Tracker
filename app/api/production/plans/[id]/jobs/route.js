/**
 * app/api/production/plans/[id]/jobs/route.js
 *
 * POST /api/production/plans/:id/jobs
 *
 * Adds a product from the plan's linked order as a new production job.
 *
 * Business rule: a job can only be created from an order_item that already
 * exists on the linked order. No new products can be invented in the
 * production module — the picker is fed by GET ./available-products.
 *
 * Delegates to the create_production_job RPC, which:
 *   - resolves order_id from the plan
 *   - locks the order_item row (FOR UPDATE) to prevent concurrent over-allocation
 *   - enforces SUM(active planned_quantity) + new qty <= order_item.quantity
 *   - allocates the next job number via next_job_num()
 *   - fires trg_auto_create_job_stages to seed the stage rows
 *
 * Body:
 *   {
 *     order_item_id: uuid    (required)
 *     planned_quantity: int  (required, > 0)
 *     category?, description?, size?, finish_type?, finish_color?, wood_type?,
 *     production_instructions?, priority?, planned_start?, planned_finish?
 *   }
 *
 * Returns: { job: { id, job_num, ... } }
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const planId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { order_item_id } = body;
    if (!order_item_id) {
      return NextResponse.json({ error: 'order_item_id is required' }, { status: 400 });
    }

    const qty = parseInt(body.planned_quantity, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      return NextResponse.json(
        { error: 'planned_quantity must be a positive integer' },
        { status: 400 }
      );
    }

    // Guard: plan must exist and must still be editable
    const { data: plan } = await serviceClient
      .from('production_plans')
      .select('id, status, order_id')
      .eq('id', planId)
      .single();

    if (!plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    if (plan.status === 'Cancelled') {
      return NextResponse.json(
        { error: 'Cannot add products to a cancelled plan' },
        { status: 409 }
      );
    }

    // Guard: the order item must belong to this plan's order and be a product line.
    // This is the hard enforcement of "no new products from the production module".
    const { data: item } = await serviceClient
      .from('order_items')
      .select('id, order_id, line_type')
      .eq('id', order_item_id)
      .single();

    if (!item || item.order_id !== plan.order_id) {
      return NextResponse.json(
        { error: 'That product is not on this plan\'s order' },
        { status: 400 }
      );
    }
    if (item.line_type !== 'product') {
      return NextResponse.json(
        { error: 'Only product lines can be added to a production plan' },
        { status: 400 }
      );
    }

    // Create the job atomically — the RPC holds the quantity guard and row lock
    const { data: jobId, error } = await serviceClient.rpc('create_production_job', {
      p_plan_id:                 planId,
      p_order_item_id:           order_item_id,
      p_planned_quantity:        qty,
      p_category:                body.category                ?? null,
      p_description:             body.description             ?? null,
      p_size:                    body.size                    ?? null,
      p_finish_type:             body.finish_type             ?? null,
      p_finish_color:            body.finish_color            ?? null,
      p_wood_type:               body.wood_type               ?? null,
      p_production_instructions: body.production_instructions ?? null,
      p_priority:                Number.isInteger(body.priority) ? body.priority : 0,
      p_planned_start:           body.planned_start           ?? null,
      p_planned_finish:          body.planned_finish          ?? null,
      p_created_by:              user.id,
    });

    if (error) {
      console.error('create_production_job RPC:', error.message);
      // Surface RPC RAISE EXCEPTION messages (over-allocation, missing item) to the client
      if (error.code === 'P0001') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Failed to add product to plan' }, { status: 500 });
    }

    // Return the created job so the UI can render without a full refetch
    const { data: job } = await serviceClient
      .from('production_jobs')
      .select(`
        id, job_num, order_item_id, status, planned_quantity,
        category, description, size, finish_type, finish_color, wood_type,
        priority, planned_start, planned_finish, created_at
      `)
      .eq('id', jobId)
      .single();

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    console.error('Plan jobs POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
