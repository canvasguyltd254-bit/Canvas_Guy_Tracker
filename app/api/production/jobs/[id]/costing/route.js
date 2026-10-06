/**
 * GET /api/production/jobs/:id/costing
 *
 * Planned vs actual cost for one job, computed on the server from persisted rows:
 *   materials / machine / outsourced / packaging  — BoQ lines (+ recorded actuals)
 *   internal labour — plan from worker assignments (rate snapshots), actual from
 *                     APPROVED time entries only; BoQ labour lines are superseded
 *                     by assignments so they are never added twice
 *   selling value   — this job's share of the order item, VAT-exclusive, before any
 *                     order-level discount
 * Wage figures are confidential: callers outside admin / production_manager get a
 * redacted summary (hours and warnings only).
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';
import { summariseJobCosting, redactLabourCost, canSeeLabourCost } from '@/shared/lib/production/labourCosting';
import calcTotals from '@/shared/lib/calcTotals';

export async function GET(_request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;
    const jobId = params.id;

    const { data: job, error: jErr } = await serviceClient.from('production_jobs')
      .select('id, job_num, planned_quantity, order_item_id, production_plans(orders(id, pricing_mode, customer_id))')
      .eq('id', jobId).maybeSingle();
    if (jErr) { console.error('Job costing (job):', jErr.message); return NextResponse.json({ error: 'Failed to load job' }, { status: 500 }); }
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const pending = { labour: false, actuals: false };

    const { data: stages } = await serviceClient.from('production_job_stages')
      .select('id, stage_label, sort_order, is_enabled').eq('job_id', jobId).order('sort_order');

    let asgSel = 'id, stage_id, employee_id, planned_attendance_units, planned_overtime_days, planned_sunday_units, daily_rate_snapshot, planned_labour_cost, employees(name)';
    let { data: asg, error: aErr } = await serviceClient.from('production_job_assignments').select(asgSel).eq('job_id', jobId).in('status', ['Assigned', 'In Progress', 'Completed']);
    if (aErr) {
      if (!isMissingSchema(aErr)) { console.error('Job costing (assignments):', aErr.message); return NextResponse.json({ error: 'Failed to load assignments' }, { status: 500 }); }
      pending.labour = true; asg = [];
    }

    let entries = [];
    const { data: te, error: tErr } = await serviceClient.from('production_time_entries')
      .select('id, stage_id, assignment_id, status, attendance_units, has_overtime, is_sunday, actual_labour_cost').eq('job_id', jobId);
    if (tErr) {
      if (!isMissingSchema(tErr)) { console.error('Job costing (time entries):', tErr.message); return NextResponse.json({ error: 'Failed to load time entries' }, { status: 500 }); }
      pending.labour = true;
    } else entries = te || [];

    let { data: lines, error: lErr } = await serviceClient.from('production_material_estimates')
      .select('boq_line_type, estimated_total_cost, issued_quantity, actual_unit_cost').eq('job_id', jobId);
    if (lErr) {
      if (!isMissingSchema(lErr)) { console.error('Job costing (lines):', lErr.message); return NextResponse.json({ error: 'Failed to load BoQ lines' }, { status: 500 }); }
      pending.actuals = true;
      ({ data: lines } = await serviceClient.from('production_material_estimates').select('boq_line_type, estimated_total_cost').eq('job_id', jobId));
    }

    // Selling value: this job's share of its order item (VAT-exclusive).
    let selling = null;
    const order = job.production_plans?.orders;
    if (job.order_item_id && canSeeLabourCost(role)) {
      const { data: item } = await serviceClient.from('order_items')
        .select('quantity, unit_price, discount_pct, tax_treatment').eq('id', job.order_item_id).maybeSingle();
      if (item && Number(item.quantity) > 0) {
        const t = calcTotals([item], order?.pricing_mode || 'vat_exclusive', 0, 'standard');
        selling = Math.round(t.subtotal * (Number(job.planned_quantity) / Number(item.quantity)) * 100) / 100;
      }
    }

    const summary = summariseJobCosting({
      stages: stages || [],
      assignments: (asg || []).map((a) => ({ ...a, employee_name: a.employees?.name ?? null })),
      entries, lines: lines || [], selling_value: selling,
    });
    const body = canSeeLabourCost(role) ? summary : redactLabourCost(summary);
    return NextResponse.json({
      job_id: jobId, job_num: job.job_num, costing: body, migration_pending: pending.labour || pending.actuals, pending,
      notes: ['Selling value is the job\'s share of the order item, VAT-exclusive, before any order-level discount.'],
    });
  } catch (err) {
    console.error('Job costing unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
