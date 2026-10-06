/**
 * GET /api/orders/:id/production-costing
 * Order-level production costing: per-job summaries + an order roll-up with ONE authoritative source per cost.
 * Roles: admin, production_manager (wage data). Everyone else gets 403 — nothing is redacted-and-returned.
 * See shared/lib/production/orderCosting.js for the source rules (attendance beats payroll allocation per worker).
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';
import { summariseJobCosting } from '@/shared/lib/production/labourCosting';
import { combineOrderLabour, rollupOrderCosting } from '@/shared/lib/production/orderCosting';
import calcTotals from '@/shared/lib/calcTotals';

export async function GET(_request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    const orderId = params.id;

    const { data: order } = await serviceClient.from('orders').select('id, order_num, pricing_mode').eq('id', orderId).maybeSingle();
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    const { data: jobs, error: jErr } = await serviceClient.from('production_jobs')
      .select('id, job_num, status, planned_quantity, order_item_id, production_plans!inner(order_id, status)')
      .eq('production_plans.order_id', orderId).neq('status', 'Cancelled');
    if (jErr) { console.error('Order costing (jobs):', jErr.message); return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 }); }
    // Draft plans are not live work.
    const liveJobs = (jobs || []).filter((j) => ['Active', 'Paused', 'Completed'].includes(j.production_plans?.status));
    const ids = liveJobs.map((j) => j.id);
    const pending = { labour: false, actuals: false };
    const empty = { data: [], error: null };

    const [stRes, asRes, teRes, ln0] = ids.length ? await Promise.all([
      serviceClient.from('production_job_stages').select('id, job_id, stage_label, sort_order').in('job_id', ids),
      serviceClient.from('production_job_assignments')
        .select('id, job_id, stage_id, employee_id, planned_attendance_units, planned_overtime_days, planned_sunday_units, planned_labour_cost')
        .in('job_id', ids).in('status', ['Assigned', 'In Progress', 'Completed']),
      serviceClient.from('production_time_entries')
        .select('id, job_id, stage_id, assignment_id, employee_id, status, attendance_units, has_overtime, is_sunday, actual_labour_cost, employees(name)').in('job_id', ids),
      serviceClient.from('production_material_estimates')
        .select('job_id, boq_line_type, estimated_total_cost, issued_quantity, actual_unit_cost').in('job_id', ids),
    ]) : [empty, empty, empty, empty];
    let asg = asRes.data || [], te = teRes.data || [], lines = ln0.data || [];
    if (asRes.error) { if (!isMissingSchema(asRes.error)) return NextResponse.json({ error: 'Failed to load assignments' }, { status: 500 }); pending.labour = true; asg = []; }
    if (teRes.error) { if (!isMissingSchema(teRes.error)) return NextResponse.json({ error: 'Failed to load time entries' }, { status: 500 }); pending.labour = true; te = []; }
    if (ln0.error) {
      if (!isMissingSchema(ln0.error)) return NextResponse.json({ error: 'Failed to load BoQ lines' }, { status: 500 });
      pending.actuals = true;
      ({ data: lines } = await serviceClient.from('production_material_estimates').select('job_id, boq_line_type, estimated_total_cost').in('job_id', ids));
      lines = lines || [];
    }

    const by = (arr, k) => arr.reduce((m, x) => ((m[x[k]] ||= []).push(x), m), {});
    const sBy = by(stRes.data || [], 'job_id'), aBy = by(asg, 'job_id'), tBy = by(te, 'job_id'), lBy = by(lines, 'job_id');
    const jobSummaries = liveJobs.map((j) => ({
      job_id: j.id, job_num: j.job_num, status: j.status,
      summary: summariseJobCosting({ stages: sBy[j.id] || [], assignments: aBy[j.id] || [], entries: tBy[j.id] || [], lines: lBy[j.id] || [], selling_value: null }),
    }));

    // Labour: approved attendance wins per worker; payroll allocations only for workers with no attendance here.
    const approved = te.filter((e) => e.status === 'approved').map((e) => ({ ...e, employee_name: e.employees?.name ?? null }));
    const { data: allocs, error: alErr } = await serviceClient.from('payroll_order_allocations')
      .select('allocated_amount, payroll_entries(employee_id, snapshot_name)').eq('order_id', orderId);
    if (alErr) { console.error('Order costing (payroll allocations):', alErr.message); return NextResponse.json({ error: 'Failed to load payroll allocations' }, { status: 500 }); }
    const labour = combineOrderLabour({
      entries: approved,
      allocations: (allocs || []).map((a) => ({ employee_id: a.payroll_entries?.employee_id ?? null, worker_name: a.payroll_entries?.snapshot_name ?? null, allocated_amount: a.allocated_amount })),
    });

    // Direct expenses attributable to the order (active only).
    const { data: expLinks, error: exErr } = await serviceClient.from('order_direct_expense_links')
      .select('allocated_amount, order_direct_expenses(reversed_at)').eq('order_id', orderId);
    if (exErr) { console.error('Order costing (expenses):', exErr.message); return NextResponse.json({ error: 'Failed to load direct expenses' }, { status: 500 }); }
    const deliveryActual = (expLinks || []).filter((l) => l.order_direct_expenses && !l.order_direct_expenses.reversed_at).reduce((s, l) => s + Number(l.allocated_amount || 0), 0);

    // Revenue excluding VAT, from the order's items.
    const { data: items } = await serviceClient.from('order_items').select('quantity, unit_price, discount_pct, tax_treatment').eq('order_id', orderId);
    const revenue = (items || []).length ? calcTotals(items, order.pricing_mode || 'vat_exclusive', 0, 'standard').subtotal : null;

    const roll = rollupOrderCosting({ jobSummaries: jobSummaries.map((j) => j.summary), labour, delivery: { planned: null, actual: deliveryActual }, revenueExVat: revenue });
    return NextResponse.json({
      order_id: orderId, order_num: order.order_num, rollup: roll, labour, jobs: jobSummaries.map((j) => ({
        job_id: j.job_id, job_num: j.job_num, status: j.status,
        categories: Object.fromEntries(Object.entries(j.summary.categories).map(([k, v]) => [k, { planned: v.planned, actual: v.actual, provisional: !!v.provisional }])),
        total_planned: j.summary.total_planned, total_actual: j.summary.total_actual, actual_is_incomplete: j.summary.actual_is_incomplete,
      })),
      migration_pending: pending.labour || pending.actuals, pending,
      notes: [
        'Revenue is the order items\' total excluding VAT, before any order-level discount.',
        'Labour actual = approved attendance. Payroll order allocations are used only for workers with no attendance on this order (provisional); never both.',
        'Delivery/installation shows all active direct expenses allocated to the order; it has no budget yet. Supplier purchases are not added here — materials come from issued quantities.',
      ],
    });
  } catch (err) {
    console.error('Order production-costing unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
