/**
 * app/api/production/plans/[id]/route.js
 *
 * GET   /api/production/plans/:id  — plan detail with all jobs
 * PATCH /api/production/plans/:id  — update plan status / notes
 *
 * PATCH body: { status?, notes?, delivery_date?, cancelled_reason?, archive? }
 *   delivery_date: ISO date string (YYYY-MM-DD) — editable as schedule changes
 *   archive: true — sets archived_at (does not change status)
 *   status = 'Cancelled' — requires cancelled_reason
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { materialEmbed, visibleMaterialRows } from '@/shared/lib/production/materialAccess';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const VALID_STATUSES = ['Draft', 'Active', 'Paused', 'Completed', 'Cancelled'];

export async function GET(request, props) {
  const params = await props.params;
  try {
    const planId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { data: plan, error } = await serviceClient
      .from('production_plans')
      .select(`
        id, status, notes, delivery_date, cancelled_reason, archived_at, created_at, updated_at,
        orders(id, order_num, client, status, due_date, pricing_mode),
        production_jobs(
          id, job_num, order_item_id, status, priority, blocker_reason,
          category, description, size, finish_type, finish_color, wood_type,
          production_instructions,
          planned_quantity,
          in_production_qty, awaiting_qc_qty, rework_qty, accepted_qty, scrapped_qty,
          planned_start, planned_finish, actual_start, actual_finish,
          cancelled_at, cancelled_reason, completed_at,
          created_at, updated_at,
          production_job_assignments(
            id, assigned_quantity, status, planned_hours, notes,
            employees(id, name),
            production_operations(id, name, code)
          ),
          ${materialEmbed(role)},
          order_items(line_type)
        )
      `)
      .eq('id', planId)
      .single();

    if (error || !plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    // Strip charge lines (delivery fees, etc.) — only product jobs belong in the plan detail.
    // Strict equality — legacy NULLs classified by migration v1g.
    const isProductJob = j => j.order_items?.line_type === 'product';

    // Defensive: fetch job stages separately so this route works before and after
    // the production_v1e_stages migration has been applied.
    let enrichedJobs = (plan.production_jobs || []).filter(isProductJob);
    try {
      const jobIds = enrichedJobs.map(j => j.id);
      if (jobIds.length > 0) {
        const { data: stagesData } = await serviceClient
          .from('production_job_stages')
          .select('id, job_id, is_enabled')
          .in('job_id', jobIds);

        if (stagesData) {
          const byJob = {};
          for (const s of stagesData) {
            (byJob[s.job_id] ||= []).push(s);
          }
          enrichedJobs = enrichedJobs.map(j => ({
            ...j,
            production_job_stages: byJob[j.id] || [],
          }));
        }
      }
    } catch (_) {
      // stages table not yet available — attach empty arrays so callers don't crash
      enrichedJobs = enrichedJobs.map(j => ({
        ...j,
        production_job_stages: [],
      }));
    }

    enrichedJobs = enrichedJobs.map((j) => ({ ...j, production_material_estimates: visibleMaterialRows(j.production_material_estimates, role) }));
    return NextResponse.json({ plan: { ...plan, production_jobs: enrichedJobs } });
  } catch (err) {
    console.error('Production plan GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, props) {
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

    // Fetch current plan
    const { data: existing } = await serviceClient
      .from('production_plans')
      .select('id, status')
      .eq('id', planId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }

    const patch = { updated_at: new Date().toISOString() };

    // Status change
    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: `Invalid status: ${body.status}` }, { status: 400 });
      }

      // Guard: activating a Draft plan requires ALL active product jobs to have:
      //   1. at least one enabled production stage
      //   2. material estimates
      //   3. a team assignment
      // Charge lines (delivery fees, etc.) are excluded from these checks.
      if (body.status === 'Active' && existing.status === 'Draft') {
        const { data: allJobs, error: jobsErr } = await serviceClient
          .from('production_jobs')
          .select(`
            id, description,
            order_items(line_type),
            production_job_stages(id, is_enabled),
            production_material_estimates(id, estimated_unit_cost, cost_source_type, preferred_supplier_id, boq_line_type),
            production_job_assignments(id)
          `)
          .eq('plan_id', planId)
          .is('cancelled_at', null);

        if (jobsErr) {
          console.error('Production plan activation guard:', jobsErr.message);
          return NextResponse.json({ error: 'Failed to verify plan jobs' }, { status: 500 });
        }

        // Product lines only — strict equality, no fallback (v1g classified legacy NULLs)
        const planJobs = (allJobs || []).filter(
          j => j.order_items?.line_type === 'product'
        );

        if (planJobs.length === 0) {
          return NextResponse.json(
            { error: 'Cannot activate a plan with no products to produce.' },
            { status: 409 }
          );
        }

        // Step 2: all jobs have at least one enabled production stage
        const noStages = planJobs.filter(
          j => !(j.production_job_stages || []).some(s => s.is_enabled)
        );
        if (noStages.length > 0) {
          const names = noStages.map(j => j.description || j.id).join(', ');
          return NextResponse.json(
            { error: `Cannot activate: no production stages configured for: ${names}` },
            { status: 409 }
          );
        }

        // Step 3: all jobs have a BoQ (at least one material estimate)
        const noBoQ = planJobs.filter(j => (j.production_material_estimates?.length || 0) === 0);
        if (noBoQ.length > 0) {
          const names = noBoQ.map(j => j.description || j.id).join(', ');
          return NextResponse.json(
            { error: `Cannot activate: no material estimates (BoQ) for: ${names}` },
            { status: 409 }
          );
        }

        // Step 4: every material estimate must be fully costed:
        //   - unit cost IS NOT NULL
        //   - cost_source_type IS NOT NULL
        //   - if cost_source_type = 'supplier', preferred_supplier_id must be set
        //   - outsourced_service lines must have a supplier
        const isLineIncomplete = m => {
          if (m.estimated_unit_cost == null) return true;
          if (m.cost_source_type == null) return true;
          if (m.cost_source_type === 'supplier' && !m.preferred_supplier_id) return true;
          if (m.boq_line_type === 'outsourced_service' && !m.preferred_supplier_id) return true;
          return false;
        };
        const uncostedJobs = planJobs.filter(j =>
          (j.production_material_estimates || []).some(isLineIncomplete)
        );
        if (uncostedJobs.length > 0) {
          const names = uncostedJobs.map(j => j.description || j.id).join(', ');
          return NextResponse.json(
            { error: `Cannot activate: estimate is incomplete for: ${names}. Every BoQ line needs a unit cost and a cost source before activating.` },
            { status: 409 }
          );
        }

        // Step 5: all jobs have at least one team assignment
        const noTeam = planJobs.filter(j => (j.production_job_assignments?.length || 0) === 0);
        if (noTeam.length > 0) {
          const names = noTeam.map(j => j.description || j.id).join(', ');
          return NextResponse.json(
            { error: `Cannot activate: no team assigned for: ${names}` },
            { status: 409 }
          );
        }
      }

      // Guard: completing a plan requires all jobs to be Completed or Cancelled
      if (body.status === 'Completed') {
        const { count, error: countErr } = await serviceClient
          .from('production_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('plan_id', planId)
          .not('status', 'in', '("Completed","Cancelled")');
        if (countErr) {
          console.error('Production plan completion guard:', countErr.message);
          return NextResponse.json({ error: 'Failed to verify job completion status' }, { status: 500 });
        }
        if (count > 0) {
          return NextResponse.json(
            { error: `Cannot complete plan: ${count} job(s) are not yet Completed or Cancelled.` },
            { status: 409 }
          );
        }
      }

      patch.status = body.status;
      if (body.status === 'Cancelled') {
        patch.cancelled_reason = body.cancelled_reason || null;
        patch.cancelled_at     = new Date().toISOString();
        patch.cancelled_by     = user.id;
      }
    }

    if (body.notes !== undefined) patch.notes = body.notes;

    // Delivery date — must be a valid date string or null to clear
    if (body.delivery_date !== undefined) {
      if (body.delivery_date === null || body.delivery_date === '') {
        patch.delivery_date = null;
      } else {
        const d = new Date(body.delivery_date);
        if (isNaN(d.getTime())) {
          return NextResponse.json({ error: 'Invalid delivery_date — use YYYY-MM-DD format' }, { status: 400 });
        }
        patch.delivery_date = body.delivery_date;
      }
    }

    // Archive toggle
    if (body.archive === true && !existing.archived_at) {
      patch.archived_at = new Date().toISOString();
      patch.archived_by = user.id;
    }
    if (body.archive === false) {
      patch.archived_at = null;
      patch.archived_by = null;
    }

    const { data: updated, error } = await serviceClient
      .from('production_plans')
      .update(patch)
      .eq('id', planId)
      .select('id, status, notes, delivery_date, cancelled_reason, archived_at, updated_at')
      .single();

    if (error) {
      console.error('Production plan PATCH:', error.message);
      return NextResponse.json({ error: 'Failed to update plan' }, { status: 500 });
    }

    return NextResponse.json({ plan: updated });
  } catch (err) {
    console.error('Production plan PATCH unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
