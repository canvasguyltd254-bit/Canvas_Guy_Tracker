/**
 * app/api/production/jobs/[id]/materials/[mid]/route.js
 *
 * PATCH  /api/production/jobs/:id/materials/:mid  — update a material estimate
 * DELETE /api/production/jobs/:id/materials/:mid  — remove a material estimate
 *
 * PATCH body (all optional):
 *   material_name, specification, unit,
 *   quantity_per_unit, planned_quantity, waste_percentage,
 *   estimated_unit_cost, preferred_supplier_id, notes
 *
 * estimated_quantity and estimated_total_cost are GENERATED columns and
 * will update automatically.
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, mid } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Verify the material belongs to this job, and fetch current field values
    // so the cost_source_type validation below can use the merged (existing + patch) state
    // without a second mid-function query.
    const { data: existing } = await serviceClient
      .from('production_material_estimates')
      .select('id, job_id, boq_line_type, cost_source_type, preferred_supplier_id')
      .eq('id', mid)
      .eq('job_id', jobId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Material estimate not found' }, { status: 404 });
    }

    const patch = { updated_at: new Date().toISOString() };

    if (body.material_name !== undefined) {
      if (!body.material_name?.trim()) return NextResponse.json({ error: 'material_name cannot be empty' }, { status: 400 });
      patch.material_name = body.material_name.trim();
    }
    if (body.specification !== undefined) patch.specification = body.specification?.trim() || null;
    if (body.unit !== undefined) {
      if (!body.unit?.trim()) return NextResponse.json({ error: 'unit cannot be empty' }, { status: 400 });
      patch.unit = body.unit.trim();
    }
    if (body.quantity_per_unit !== undefined) {
      const v = parseFloat(body.quantity_per_unit);
      if (!v || v <= 0) return NextResponse.json({ error: 'quantity_per_unit must be > 0' }, { status: 400 });
      patch.quantity_per_unit = v;
    }
    if (body.planned_quantity !== undefined) {
      const v = parseInt(body.planned_quantity, 10);
      if (!v || v <= 0) return NextResponse.json({ error: 'planned_quantity must be > 0' }, { status: 400 });
      patch.planned_quantity = v;
    }
    if (body.waste_percentage !== undefined) {
      // Number.isFinite first: parseFloat('abc') is NaN and every comparison
      // against NaN is false, so a bare range check lets garbage reach the insert.
      const v = parseFloat(body.waste_percentage);
      if (!Number.isFinite(v) || v < 0 || v >= 100) {
        return NextResponse.json({ error: 'waste_percentage must be a number between 0 and 99.99' }, { status: 400 });
      }
      patch.waste_percentage = v;
    }
    if (body.estimated_unit_cost !== undefined) {
      if (body.estimated_unit_cost == null) {
        patch.estimated_unit_cost = null;
      } else {
        const v = parseFloat(body.estimated_unit_cost);
        if (!isFinite(v) || v < 0) {
          return NextResponse.json(
            { error: 'estimated_unit_cost must be a non-negative finite number' },
            { status: 400 }
          );
        }
        patch.estimated_unit_cost = v;
      }
    }
    // ── boq_line_type ─────────────────────────────────────────────────────────
    const VALID_BOQ_LINE_TYPES = [
      'material', 'consumable', 'packaging',
      'internal_labour', 'machine_time', 'outsourced_service',
    ];
    const INHOUSE_LINE_TYPES = ['internal_labour', 'machine_time'];

    if (body.boq_line_type !== undefined) {
      if (!VALID_BOQ_LINE_TYPES.includes(body.boq_line_type)) {
        return NextResponse.json(
          { error: `Invalid boq_line_type. Must be one of: ${VALID_BOQ_LINE_TYPES.join(', ')}` },
          { status: 400 }
        );
      }
      patch.boq_line_type = body.boq_line_type;
      // Changing to an in-house line type: auto-set source and clear supplier
      if (INHOUSE_LINE_TYPES.includes(body.boq_line_type)) {
        patch.cost_source_type      = 'in_house';
        patch.preferred_supplier_id = null;
      }
    }

    // ── cost_source_type ─────────────────────────────────────────────────────
    const VALID_COST_SOURCES = ['supplier', 'in_house', 'stock', 'manual'];
    if (body.cost_source_type !== undefined) {
      if (!VALID_COST_SOURCES.includes(body.cost_source_type)) {
        return NextResponse.json(
          { error: `Invalid cost_source_type. Must be one of: ${VALID_COST_SOURCES.join(', ')}` },
          { status: 400 }
        );
      }
      // Determine effective boq_line_type: incoming patch takes precedence over current DB value.
      // existing.boq_line_type was fetched in the ownership check above — no second query needed.
      const effectiveLineType = patch.boq_line_type ?? existing.boq_line_type;

      if (INHOUSE_LINE_TYPES.includes(effectiveLineType) && body.cost_source_type !== 'in_house') {
        return NextResponse.json(
          { error: `internal_labour and machine_time lines must use cost_source_type = 'in_house'` },
          { status: 400 },
        );
      }
      if (body.cost_source_type !== 'supplier') {
        // Non-supplier sources must not carry a supplier id
        patch.preferred_supplier_id = null;
      }
      patch.cost_source_type = body.cost_source_type;
    }

    // ── preferred_supplier_id ────────────────────────────────────────────────
    if (body.preferred_supplier_id !== undefined) {
      // Only allowed when cost_source_type is / will be 'supplier'.
      // Use the merged state: patch.cost_source_type (if changed this request) or existing DB value.
      const effectiveSource = patch.cost_source_type ?? existing.cost_source_type;
      if (body.preferred_supplier_id && effectiveSource && effectiveSource !== 'supplier') {
        return NextResponse.json(
          { error: `preferred_supplier_id may only be set when cost_source_type is 'supplier'` },
          { status: 400 }
        );
      }
      patch.preferred_supplier_id = body.preferred_supplier_id || null;
    }

    if (body.notes !== undefined) patch.notes = body.notes?.trim() || null;
    if (body.adjustment_quantity !== undefined) {
      if (body.adjustment_quantity == null || body.adjustment_quantity === '') {
        patch.adjustment_quantity = 0;
      } else {
        const v = parseFloat(body.adjustment_quantity);
        if (!Number.isFinite(v)) {
          return NextResponse.json({ error: 'adjustment_quantity must be a number' }, { status: 400 });
        }
        patch.adjustment_quantity = v;
      }
    }

    const { data: material, error } = await serviceClient
      .from('production_material_estimates')
      .update(patch)
      .eq('id', mid)
      .select(`
        id, material_name, specification, unit,
        quantity_per_unit, planned_quantity, waste_percentage,
        estimated_quantity, estimated_unit_cost, estimated_total_cost,
        adjustment_quantity,
        boq_line_type, cost_source_type,
        preferred_supplier_id, notes, updated_at
      `)
      .single();

    if (error) {
      console.error('Material PATCH:', error.message);
      return NextResponse.json({ error: 'Failed to update material estimate' }, { status: 500 });
    }

    return NextResponse.json({ material });
  } catch (err) {
    console.error('Material PATCH unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, mid } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    // Verify the material belongs to this job
    const { data: existing } = await serviceClient
      .from('production_material_estimates')
      .select('id')
      .eq('id', mid)
      .eq('job_id', jobId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Material estimate not found' }, { status: 404 });
    }

    const { error } = await serviceClient
      .from('production_material_estimates')
      .delete()
      .eq('id', mid);

    if (error) {
      console.error('Material DELETE:', error.message);
      return NextResponse.json({ error: 'Failed to delete material estimate' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Material DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
