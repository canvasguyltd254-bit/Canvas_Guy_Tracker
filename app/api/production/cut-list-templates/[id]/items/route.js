/**
 * app/api/production/cut-list-templates/[id]/items/route.js
 *
 * GET /api/production/cut-list-templates/:id/items  — list items
 * PUT /api/production/cut-list-templates/:id/items  — replace all items (atomic)
 *
 * PUT body: { items: Array<{ piece_name, width_cm?, height_cm?, thickness_mm?, quantity?, material_description?, notes?, sort_order? }> }
 *
 * PUT replaces the entire item list atomically — used by the template editor.
 * Items without an id are inserted; existing items not in the list are deleted.
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles PUT: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'production_staff',
    ]);
    if (authError) return authError;

    const { data: items, error } = await serviceClient
      .from('cut_list_template_items')
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order')
      .eq('template_id', params.id)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('Template items GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch template items' }, { status: 500 });
    }

    return NextResponse.json({ items: items || [] });
  } catch (err) {
    console.error('Template items GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request, props) {
  const params = await props.params;
  try {
    const templateId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!Array.isArray(body.items)) {
      return NextResponse.json({ error: 'items must be an array' }, { status: 400 });
    }

    // Guard: template must exist
    const { data: tpl } = await serviceClient
      .from('cut_list_templates')
      .select('id')
      .eq('id', templateId)
      .single();
    if (!tpl) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Validate and normalise items
    const validItems = body.items
      .filter(it => it.piece_name?.trim())
      .map((it, idx) => ({
        template_id:          templateId,
        piece_name:           it.piece_name.trim(),
        width_cm:             it.width_cm     != null ? parseFloat(it.width_cm)     : null,
        height_cm:            it.height_cm    != null ? parseFloat(it.height_cm)    : null,
        thickness_mm:         it.thickness_mm != null ? parseFloat(it.thickness_mm) : null,
        quantity:             it.quantity != null ? Math.max(1, parseInt(it.quantity, 10)) : 1,
        material_description: it.material_description?.trim() || null,
        notes:                it.notes?.trim()                 || null,
        sort_order:           it.sort_order != null ? parseInt(it.sort_order, 10) : idx,
      }));

    // Atomic replace. A DELETE followed by a separate INSERT is not safe here:
    // if the insert fails the delete has already committed and the template is
    // left empty with the previous items unrecoverable. The RPC validates the
    // whole payload before deleting and runs in a single transaction, and it
    // also touches updated_at.
    const { error: rpcErr } = await serviceClient.rpc('replace_cut_list_template_items', {
      p_template_id: templateId,
      p_items:       validItems.map(({ template_id, ...rest }) => rest),
    });

    if (rpcErr) {
      console.error('replace_cut_list_template_items RPC:', rpcErr.message);
      // Surface RAISE EXCEPTION messages (bad payload) as 400, not 500
      if (rpcErr.code === 'P0001') {
        return NextResponse.json({ error: rpcErr.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Failed to replace template items' }, { status: 500 });
    }

    // Read the committed rows back so the client gets server-assigned ids
    const { data: items } = await serviceClient
      .from('cut_list_template_items')
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order')
      .eq('template_id', templateId)
      .order('sort_order', { ascending: true });

    // The write already succeeded; a failed read-back should not look like a
    // failed save, so fall back to an empty array rather than undefined.
    return NextResponse.json({ items: items || [] });
  } catch (err) {
    console.error('Template items PUT unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
