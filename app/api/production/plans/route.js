/**
 * app/api/production/plans/route.js
 *
 * GET  /api/production/plans  — list all plans (with order ref + job summary)
 * POST /api/production/plans  — create a plan for an order via RPC
 *
 * POST body: { order_id: uuid, notes?: string }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const status    = searchParams.get('status')   || null;
    const archived  = searchParams.get('archived') === 'true';

    let query = serviceClient
      .from('production_plans')
      .select(`
        id, status, notes, delivery_date, cancelled_reason, archived_at, created_at, updated_at,
        orders(id, order_num, client, status, due_date),
        production_jobs(
          id, status, planned_quantity, accepted_qty, scrapped_qty, cancelled_at,
          order_items(line_type)
        )
      `)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }
    if (!archived) {
      query = query.is('archived_at', null);
    }

    const { data: plans, error } = await query;
    if (error) {
      console.error('Production plans GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch production plans' }, { status: 500 });
    }

    // Helper: is this job linked to a product order item?
    // Strict equality — legacy NULLs have been classified by migration v1g.
    const isProductJob = j => j.order_items?.line_type === 'product';

    // Enrich each plan with computed job summary (product jobs only)
    const enriched = (plans || []).map(plan => {
      const allJobs  = plan.production_jobs || [];
      const jobs     = allJobs.filter(isProductJob);   // defensive: product lines only
      const active   = jobs.filter(j => j.cancelled_at === null);
      const total    = active.reduce((s, j) => s + j.planned_quantity, 0);
      const accepted = active.reduce((s, j) => s + j.accepted_qty, 0);
      const completed = active.filter(j => j.status === 'Completed').length;

      return {
        ...plan,
        _summary: {
          total_jobs:      jobs.length,    // product lines only (charges excluded)
          active_jobs:     active.length,
          completed_jobs:  completed,
          planned_units:   total,
          accepted_units:  accepted,
          pct_complete:    total > 0 ? Math.round((accepted / total) * 100) : 0,
        },
      };
    });

    return NextResponse.json({ plans: enriched });
  } catch (err) {
    console.error('Production plans GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { order_id, notes } = body;
    if (!order_id) {
      return NextResponse.json({ error: 'order_id is required' }, { status: 400 });
    }

    const { data: planId, error } = await serviceClient.rpc('create_production_plan', {
      p_order_id:   order_id,
      p_notes:      notes || null,
      p_created_by: user.id,
    });

    if (error) {
      console.error('create_production_plan RPC:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Fetch the new plan with full detail
    const { data: plan } = await serviceClient
      .from('production_plans')
      .select(`
        id, status, notes, created_at,
        orders(id, order_num, client, status),
        production_jobs(id, status, planned_quantity, job_num, category, description)
      `)
      .eq('id', planId)
      .single();

    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    console.error('Production plans POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
