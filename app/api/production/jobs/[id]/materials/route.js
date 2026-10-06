/**
 * app/api/production/jobs/[id]/materials/route.js
 *
 * GET  /api/production/jobs/:id/materials  — list material estimates for a job
 * POST /api/production/jobs/:id/materials  — add a material estimate
 *
 * POST body:
 *   {
 *     material_name:      string  (required)
 *     specification?:     string
 *     unit:               string  (required, e.g. "sheet", "metre", "kg")
 *     quantity_per_unit:  number  (required, > 0)
 *     planned_quantity?:  number  (defaults to job.planned_quantity)
 *     waste_percentage?:  number  (0–99.99, default 0)
 *     estimated_unit_cost?: number
 *     boq_line_type?:     string  (material|consumable|packaging|internal_labour|machine_time|outsourced_service, default "material")
 *     cost_source_type?:  string  (supplier|in_house|stock|manual)
 *                                 auto-set to 'in_house' for internal_labour/machine_time
 *     preferred_supplier_id?: uuid  (required when cost_source_type = 'supplier')
 *     notes?:             string
 *   }
 *
 * estimated_quantity and estimated_total_cost are GENERATED columns —
 * never sent in the body.
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles POST: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { fetchJobMaterials } from '@/shared/lib/production/materialAccess';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    // Cost columns are selected only for roles allowed to see them (see materialAccess.js).
    const { materials, error } = await fetchJobMaterials(serviceClient, jobId, role);
    if (error) {
      console.error('Materials GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch materials' }, { status: 500 });
    }

    return NextResponse.json({ materials });
  } catch (err) {
    console.error('Materials GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, props) {
  const params = await props.params;
  try {
    const jobId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      material_name, specification, unit,
      quantity_per_unit, planned_quantity,
      waste_percentage, estimated_unit_cost,
      adjustment_quantity,
      boq_line_type, cost_source_type,
      preferred_supplier_id, notes,
    } = body;

    if (!material_name?.trim()) {
      return NextResponse.json({ error: 'material_name is required' }, { status: 400 });
    }
    if (!unit?.trim()) {
      return NextResponse.json({ error: 'unit is required' }, { status: 400 });
    }
    const qpu = parseFloat(quantity_per_unit);
    if (!qpu || qpu <= 0) {
      return NextResponse.json({ error: 'quantity_per_unit must be > 0' }, { status: 400 });
    }

    // ── boq_line_type validation ──────────────────────────────────────────────
    const VALID_BOQ_LINE_TYPES = [
      'material', 'consumable', 'packaging',
      'internal_labour', 'machine_time', 'outsourced_service',
    ];
    const INHOUSE_LINE_TYPES = ['internal_labour', 'machine_time'];
    const VALID_COST_SOURCES  = ['supplier', 'in_house', 'stock', 'manual'];

    const effectiveLineType = boq_line_type || 'material';
    if (!VALID_BOQ_LINE_TYPES.includes(effectiveLineType)) {
      return NextResponse.json(
        { error: `Invalid boq_line_type. Must be one of: ${VALID_BOQ_LINE_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    // In-house types always have cost_source_type = 'in_house' and no supplier
    let effectiveCostSource = cost_source_type || null;
    let effectiveSupplierId = preferred_supplier_id || null;

    if (INHOUSE_LINE_TYPES.includes(effectiveLineType)) {
      // Auto-correct: labour/machine lines are always in-house; any supplier is cleared
      effectiveCostSource = 'in_house';
      effectiveSupplierId = null;
    } else {
      if (effectiveCostSource !== null) {
        if (!VALID_COST_SOURCES.includes(effectiveCostSource)) {
          return NextResponse.json(
            { error: `Invalid cost_source_type. Must be one of: ${VALID_COST_SOURCES.join(', ')}` },
            { status: 400 },
          );
        }
        // Non-supplier sources must not carry a supplier id
        if (effectiveCostSource !== 'supplier') {
          effectiveSupplierId = null;
        }
      }

      // outsourced_service: once a source is given it must be 'supplier' + id
      if (effectiveLineType === 'outsourced_service' && effectiveCostSource !== null) {
        if (effectiveCostSource !== 'supplier') {
          return NextResponse.json(
            { error: "outsourced_service lines must use cost_source_type = 'supplier'" },
            { status: 400 },
          );
        }
        if (!effectiveSupplierId) {
          return NextResponse.json(
            { error: "outsourced_service lines require a preferred_supplier_id when cost_source_type is set" },
            { status: 400 },
          );
        }
      }

      // supplier source always requires an id
      if (effectiveCostSource === 'supplier' && !effectiveSupplierId) {
        return NextResponse.json(
          { error: "preferred_supplier_id is required when cost_source_type is 'supplier'" },
          { status: 400 },
        );
      }
    }

    // Fetch job to get planned_quantity default
    const { data: job } = await serviceClient
      .from('production_jobs')
      .select('id, planned_quantity, status')
      .eq('id', jobId)
      .single();

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const pq = planned_quantity != null ? parseInt(planned_quantity, 10) : job.planned_quantity;
    if (!pq || pq <= 0) {
      return NextResponse.json({ error: 'planned_quantity must be > 0' }, { status: 400 });
    }

    // NOTE on NaN: parseFloat('abc') is NaN, and every comparison against NaN is
    // false — so `if (waste < 0 || waste >= 100)` passes garbage straight through
    // to the insert. Each numeric field below is therefore range-checked via
    // Number.isFinite first, never by comparison alone.
    const waste = waste_percentage != null ? parseFloat(waste_percentage) : 0;
    if (!Number.isFinite(waste) || waste < 0 || waste >= 100) {
      return NextResponse.json({ error: 'waste_percentage must be a number between 0 and 99.99' }, { status: 400 });
    }

    let unitCost = null;
    if (estimated_unit_cost != null && estimated_unit_cost !== '') {
      unitCost = parseFloat(estimated_unit_cost);
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        return NextResponse.json({ error: 'estimated_unit_cost must be a number of 0 or more' }, { status: 400 });
      }
    }

    let adjustment = 0;
    if (adjustment_quantity != null && adjustment_quantity !== '') {
      adjustment = parseFloat(adjustment_quantity);
      if (!Number.isFinite(adjustment)) {
        return NextResponse.json({ error: 'adjustment_quantity must be a number' }, { status: 400 });
      }
    }

    const { data: material, error } = await serviceClient
      .from('production_material_estimates')
      .insert({
        job_id:               jobId,
        material_name:        material_name.trim(),
        specification:        specification?.trim() || null,
        unit:                 unit.trim(),
        quantity_per_unit:    qpu,
        planned_quantity:     pq,
        waste_percentage:     waste,
        estimated_unit_cost:  unitCost,
        adjustment_quantity:  adjustment,
        boq_line_type:        effectiveLineType,
        cost_source_type:     effectiveCostSource,
        preferred_supplier_id: effectiveSupplierId,
        notes:                notes?.trim() || null,
        created_by:           user.id,
      })
      .select(`
        id, material_name, specification, unit,
        quantity_per_unit, planned_quantity, waste_percentage,
        estimated_quantity, estimated_unit_cost, estimated_total_cost,
        adjustment_quantity,
        boq_line_type, cost_source_type,
        preferred_supplier_id, notes, created_at
      `)
      .single();

    if (error) {
      console.error('Materials POST:', error.message);
      return NextResponse.json({ error: 'Failed to add material estimate' }, { status: 500 });
    }

    return NextResponse.json({ material }, { status: 201 });
  } catch (err) {
    console.error('Materials POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
