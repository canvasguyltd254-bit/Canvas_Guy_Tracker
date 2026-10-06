/**
 * app/api/production/templates/[id]/items/route.js
 *
 * PUT  /api/production/templates/:id/items
 *   Replace the full item list for a template atomically.
 *   Body: { items: [{ material_name, specification?, unit, quantity_per_unit, waste_percentage?, boq_line_type?, notes? }] }
 *   Items are inserted in array order; sort_order = array index.
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function PUT(request, props) {
  const params = await props.params;
  try {
    const { id: templateId } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { items } = body;
    if (!Array.isArray(items)) {
      return NextResponse.json({ error: 'items must be an array' }, { status: 400 });
    }

    const VALID_BOQ_LINE_TYPES = [
      'material', 'consumable', 'packaging',
      'internal_labour', 'machine_time', 'outsourced_service',
    ];

    // Validate each item
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.material_name?.trim()) {
        return NextResponse.json({ error: `Item ${i + 1}: material_name is required` }, { status: 400 });
      }
      if (!it.unit?.trim()) {
        return NextResponse.json({ error: `Item ${i + 1}: unit is required` }, { status: 400 });
      }
      const qpu = parseFloat(it.quantity_per_unit);
      if (!qpu || qpu <= 0) {
        return NextResponse.json({ error: `Item ${i + 1}: quantity_per_unit must be > 0` }, { status: 400 });
      }
      if (it.boq_line_type !== undefined && it.boq_line_type !== null) {
        if (!VALID_BOQ_LINE_TYPES.includes(it.boq_line_type)) {
          return NextResponse.json(
            { error: `Item ${i + 1}: invalid boq_line_type "${it.boq_line_type}". Must be one of: ${VALID_BOQ_LINE_TYPES.join(', ')}` },
            { status: 400 },
          );
        }
      }
    }

    // Verify the template exists before calling the RPC
    const { data: tmpl } = await serviceClient
      .from('production_boq_templates')
      .select('id')
      .eq('id', templateId)
      .single();

    if (!tmpl) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Atomically replace all items via the PostgreSQL RPC (single transaction).
    // The RPC validates inputs, deletes existing items, and inserts the new list.
    const rpcPayload = items.map((it, idx) => ({
      sort_order:        idx,
      material_name:     it.material_name.trim(),
      specification:     it.specification?.trim() || null,
      unit:              it.unit.trim(),
      quantity_per_unit: parseFloat(it.quantity_per_unit),
      waste_percentage:  parseFloat(it.waste_percentage) || 0,
      boq_line_type:     it.boq_line_type || 'material',
      notes:             it.notes?.trim() || null,
    }));

    const { error: rpcErr } = await serviceClient.rpc('replace_boq_template_items', {
      p_template_id: templateId,
      p_items:       rpcPayload,
    });

    if (rpcErr) {
      console.error('replace_boq_template_items RPC:', rpcErr.message);
      return NextResponse.json(
        { error: rpcErr.message || 'Failed to replace template items' },
        { status: 500 },
      );
    }

    // Fetch the saved items to return canonical state
    const { data: saved, error: fetchErr } = await serviceClient
      .from('production_boq_template_items')
      .select('id, sort_order, material_name, specification, unit, quantity_per_unit, waste_percentage, boq_line_type, notes')
      .eq('template_id', templateId)
      .order('sort_order');

    if (fetchErr) {
      console.error('Template items re-fetch:', fetchErr.message);
      return NextResponse.json({ error: 'Items saved but could not re-fetch' }, { status: 500 });
    }

    return NextResponse.json({ items: saved || [] });
  } catch (err) {
    console.error('Template items PUT unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
