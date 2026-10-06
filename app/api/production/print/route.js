/**
 * GET /api/production/print?type=card|shortage|pack&scope=job|all&job_id=
 *
 * Returns the DATA for a print (the HTML is built client-side by
 * shared/lib/production/printSheets.js). Money is enforced here, server-side:
 *   card, shortage — no cost column is ever selected; the response contains no
 *                    financial field at all.
 *   pack           — admin / production_manager only; adds estimated material
 *                    cost and payroll-allocated labour cost.
 *
 * scope=job needs job_id; scope=all = every active job.
 * Tolerant of v2a–v2d not being applied.
 */

export const runtime = 'nodejs';

import { isMissingSchema } from '@/shared/lib/production/dbErrors';
import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { workingDaysBetween } from '@/shared/lib/production/workerLoad';

const ACTIVE = ['Planned', 'Awaiting Materials', 'Materials Ready', 'In Production', 'Quality Control', 'Paused'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'card';
    const scope = searchParams.get('scope') || 'job';
    const jobId = searchParams.get('job_id');

    if (!['card', 'shortage', 'pack'].includes(type)) return NextResponse.json({ error: 'Unknown print type' }, { status: 400 });
    if (!['job', 'visible', 'order', 'all'].includes(scope)) return NextResponse.json({ error: 'Unknown print scope' }, { status: 400 });
    if (scope === 'job' && !jobId) return NextResponse.json({ error: 'job_id is required for scope=job' }, { status: 400 });
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const jobIds = (searchParams.get('job_ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (scope === 'visible') {
      if (!jobIds.length) return NextResponse.json({ error: 'job_ids is required for scope=visible' }, { status: 400 });
      if (jobIds.length > 200) return NextResponse.json({ error: 'Too many jobs selected (max 200)' }, { status: 400 });
      if (!jobIds.every((x) => UUID.test(x))) return NextResponse.json({ error: 'job_ids must be ids' }, { status: 400 });
    }
    const orderId = searchParams.get('order_id');
    if (scope === 'order' && !(orderId && UUID.test(orderId))) return NextResponse.json({ error: 'order_id is required for scope=order' }, { status: 400 });

    const authError = type === 'pack'
      ? requireRole(user, role, ['admin', 'production_manager'])
      : requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;

    const money = type === 'pack';

    // ── Jobs ────────────────────────────────────────────────────────────────
    const matCols = `id, material_name, specification, unit, estimated_quantity, readiness, short_note${money ? ', estimated_total_cost, boq_line_type' : ''}`;
    const jobCols = (v2) => `
      id, job_num, order_id, description, category, size, finish_type, finish_color, wood_type,
      planned_quantity, production_instructions, order_item_id, status,
      ${v2 ? 'production_due_date,' : ''}
      production_plans(status, orders(id, order_num)),
      production_job_stages(id, stage_key, stage_label, sort_order, is_enabled, status${v2 ? ', production_job_stage_schedules(planned_start_date, planned_end_date)' : ''}),
      production_material_estimates(${v2 ? matCols : matCols.replace(', readiness, short_note', '')})`;

    const run = (v2) => {
      let q = serviceClient.from('production_jobs').select(jobCols(v2));
      if (scope === 'job') q = q.eq('id', jobId);
      else if (scope === 'visible') q = q.in('id', jobIds).in('status', ACTIVE).order('job_num');
      else if (scope === 'order') q = q.eq('order_id', orderId).in('status', ACTIVE).order('job_num');
      else q = q.in('status', ACTIVE).order('job_num');
      return q;
    };
    let { data: jobs, error } = await run(true);
    if (error && isMissingSchema(error)) ({ data: jobs, error } = await run(false));   // v2b/v2d not applied yet
    if (error) {
      console.error('Production print GET (jobs):', error.message);
      return NextResponse.json({ error: 'Failed to load print data' }, { status: 500 });
    }
    // Draft/cancelled plans never reach the shop floor (a single job requested by id is still allowed).
    if (scope !== 'job') jobs = (jobs || []).filter((j) => ['Active', 'Paused'].includes(j.production_plans?.status));
    if (scope === 'job' && !(jobs || []).length) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const ids = (jobs || []).map((j) => j.id);

    // ── Assignments (who is on which stage) ─────────────────────────────────
    const asgByStage = {};
    const hoursRows = [];
    if (ids.length) {
      const { data: asg } = await serviceClient
        .from('production_job_assignments')
        .select('job_id, stage_id, status, planned_start_date, planned_end_date, planned_hours_per_day, employees(name)')
        .in('job_id', ids).neq('status', 'Removed');
      for (const a of asg || []) {
        if (!a.stage_id) continue;
        (asgByStage[a.stage_id] ||= []).push(a);
      }
    }

    // ── Drawings linked to each job (shop-floor card only; no money) ───────────
    const drawingsByJob = {};
    if (type === 'card' && ids.length) {
      const { data: dr, error: drErr } = await serviceClient
        .from('production_job_drawings')
        .select('job_id, linked_at, drawings(id, file_name, file_url, category, notes, created_at)')
        .in('job_id', ids).order('linked_at', { ascending: true });
      if (drErr) console.warn('Production print (drawings):', drErr.message);
      else for (const d of dr || []) {
        if (!d.drawings) continue;
        (drawingsByJob[d.job_id] ||= []).push({
          file_name: d.drawings.file_name, url: d.drawings.file_url, category: d.drawings.category,
          notes: d.drawings.notes, uploaded_at: (d.drawings.created_at || '').slice(0, 10) || null,
        });
      }
    }

    // ── Actual material usage (pack only; v2f columns, tolerant) ───────────────
    const actualsByLine = {};
    let actualsLoaded = true;
    if (money && ids.length) {
      const { data: ac, error: acErr } = await serviceClient
        .from('production_material_estimates')
        .select('id, issued_quantity, actual_unit_cost')
        .in('job_id', ids);
      if (acErr) actualsLoaded = false;   // v2f not applied: pack shows "Not recorded"
      else for (const r of ac || []) actualsByLine[r.id] = r;
    }

    // ── Blockers (open) ─────────────────────────────────────────────────────
    const blockersByJob = {};
    if (ids.length) {
      const { data: bl, error: blErr } = await serviceClient
        .from('production_job_blockers')
        .select('job_id, reason, expected_resolution_date, supplier_po_ref, employees:owner_employee_id(name)')
        .in('job_id', ids).is('resolved_at', null);
      if (!blErr) for (const b of bl || []) (blockersByJob[b.job_id] ||= []).push({
        reason: b.reason, owner_name: b.employees?.name ?? null,
        expected_resolution_date: b.expected_resolution_date, supplier_po_ref: b.supplier_po_ref,
      });
    }

    // ── Labour cost (pack only) ─────────────────────────────────────────────
    const labourByOrder = {};
    let labourLoaded = true;
    if (money && ids.length) {
      const orderIds = [...new Set((jobs || []).map((j) => j.production_plans?.orders?.id).filter(Boolean))];
      if (orderIds.length) {
        const { data: lab, error: labErr } = await serviceClient
          .from('payroll_order_allocations')
          .select('order_id, order_item_id, allocated_amount, payroll_entries(snapshot_name, payroll_runs(status))')
          .in('order_id', orderIds);
        if (labErr) labourLoaded = false;
        else for (const r of lab || []) (labourByOrder[r.order_id] ||= []).push(r);
      }
    }

    const out = (jobs || []).map((j) => {
      const order = j.production_plans?.orders || null;
      const stages = (j.production_job_stages || [])
        .filter((s) => s.is_enabled !== false)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((s) => {
          const sch = Array.isArray(s.production_job_stage_schedules) ? s.production_job_stage_schedules[0] : s.production_job_stage_schedules;
          const people = asgByStage[s.id] || [];
          if (money) {
            for (const a of people) {
              if (a.planned_start_date && a.planned_end_date && Number(a.planned_hours_per_day) > 0) {
                hoursRows.push({
                  job_id: j.id, worker: a.employees?.name || 'Worker', stage_label: s.stage_label,
                  hours: workingDaysBetween(a.planned_start_date, a.planned_end_date).length * Number(a.planned_hours_per_day),
                });
              }
            }
          }
          return {
            stage_label: s.stage_label, status: s.status,
            start: sch?.planned_start_date ?? null, end: sch?.planned_end_date ?? null,
            workers: [...new Set(people.map((a) => a.employees?.name).filter(Boolean))],
          };
        });

      const base = {
        job_num: j.job_num, name: j.description || j.category || 'Untitled', order_num: order?.order_num ?? null,
        size: j.size, finish_type: j.finish_type, finish_color: j.finish_color, wood_type: j.wood_type,
        planned_quantity: j.planned_quantity, production_instructions: j.production_instructions,
        production_due_date: j.production_due_date ?? null,
        drawings: drawingsByJob[j.id] || [],
        stages, blockers: blockersByJob[j.id] || [],
        materials: (j.production_material_estimates || []).map((m) => ({
          material_name: m.material_name, specification: m.specification, unit: m.unit,
          estimated_quantity: m.estimated_quantity != null ? Number(m.estimated_quantity) : null,
          readiness: m.readiness || 'unchecked', short_note: m.short_note || null,
          ...(money ? { estimated_total_cost: m.estimated_total_cost != null ? Number(m.estimated_total_cost) : null } : {}),
        })),
      };
      if (!money) return base;

      const rows = labourByOrder[order?.id] || [];
      const shape = (r) => ({ worker: r.payroll_entries?.snapshot_name || 'Worker', amount: Number(r.allocated_amount || 0), run_status: r.payroll_entries?.payroll_runs?.status || 'draft' });
      return {
        ...base,
        finance: {
          // Internal labour and machine time are in-house costs: labour comes from worker
          // assignments / approved time (see the job Costing panel), so those BoQ lines are not
          // repeated here as "materials".
          materials: (j.production_material_estimates || []).filter((m) => !['internal_labour', 'machine_time'].includes(m.boq_line_type)).map((m) => {
            const a = actualsByLine[m.id] || {};
            const issued = a.issued_quantity != null ? Number(a.issued_quantity) : null;
            const unit = a.actual_unit_cost != null ? Number(a.actual_unit_cost) : null;
            return {
              material_name: m.material_name, unit: m.unit,
              estimated_quantity: m.estimated_quantity != null ? Number(m.estimated_quantity) : null,
              estimated_total_cost: m.estimated_total_cost != null ? Number(m.estimated_total_cost) : null,
              issued_quantity: issued, actual_unit_cost: unit,
              actual_total_cost: issued != null && unit != null ? Math.round(issued * unit * 100) / 100 : null,
            };
          }),
          actuals_loaded: actualsLoaded,
          labour: {
            loaded: labourLoaded,
            item_level: rows.filter((r) => r.order_item_id && r.order_item_id === j.order_item_id).map(shape),
            order_level: rows.filter((r) => !r.order_item_id).map(shape),
          },
          planned_hours: hoursRows.filter((h) => h.job_id === j.id).map(({ worker, stage_label, hours }) => ({ worker, stage_label, hours })),
        },
      };
    });

    return NextResponse.json({ type, scope, jobs: out });
  } catch (err) {
    console.error('Production print GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
