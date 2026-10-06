/**
 * app/api/production/cut-list-templates/route.js
 *
 * GET  /api/production/cut-list-templates         — list active templates
 * POST /api/production/cut-list-templates         — create a new template
 *
 * GET ?include_inactive=true  — include archived/inactive templates
 *
 * POST body:
 *   {
 *     name:         string   (required)
 *     description?: string
 *     items?:       Array<{ piece_name, width_cm?, height_cm?, thickness_mm?, quantity?, material_description?, notes?, sort_order? }>
 *   }
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles POST: admin, production_manager
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
    const includeInactive = searchParams.get('include_inactive') === 'true';

    let query = serviceClient
      .from('cut_list_templates')
      .select(`
        id, name, description, is_active, created_at, updated_at,
        cut_list_template_items(
          id, piece_name, width_cm, height_cm, thickness_mm,
          quantity, material_description, notes, sort_order
        )
      `)
      .order('name', { ascending: true });

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const { data: templates, error } = await query;

    if (error) {
      console.error('Cut list templates GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }

    // Sort items within each template by sort_order
    const sorted = (templates || []).map(t => ({
      ...t,
      cut_list_template_items: (t.cut_list_template_items || []).sort(
        (a, b) => a.sort_order - b.sort_order
      ),
    }));

    return NextResponse.json({ templates: sorted });
  } catch (err) {
    console.error('Cut list templates GET unexpected:', err.message);
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

    const { name, description, items } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    // Create the template
    const { data: template, error: tErr } = await serviceClient
      .from('cut_list_templates')
      .insert({
        name:        name.trim(),
        description: description?.trim() || null,
        is_active:   true,
        created_by:  user.id,
      })
      .select('id, name, description, is_active, created_at')
      .single();

    if (tErr) {
      console.error('Cut list template POST (create):', tErr.message);
      return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
    }

    // Insert items if provided
    let templateItems = [];
    if (Array.isArray(items) && items.length > 0) {
      const rows = items
        .filter(it => it.piece_name?.trim())
        .map((it, idx) => ({
          template_id:          template.id,
          piece_name:           it.piece_name.trim(),
          width_cm:             it.width_cm     != null ? parseFloat(it.width_cm)     : null,
          height_cm:            it.height_cm    != null ? parseFloat(it.height_cm)    : null,
          thickness_mm:         it.thickness_mm != null ? parseFloat(it.thickness_mm) : null,
          quantity:             it.quantity != null ? Math.max(1, parseInt(it.quantity, 10)) : 1,
          material_description: it.material_description?.trim() || null,
          notes:                it.notes?.trim()                 || null,
          sort_order:           it.sort_order != null ? parseInt(it.sort_order, 10) : idx,
        }));

      if (rows.length > 0) {
        const { data: inserted, error: iErr } = await serviceClient
          .from('cut_list_template_items')
          .insert(rows)
          .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order');

        if (iErr) {
          console.error('Cut list template items POST:', iErr.message);
          // Template created but items failed — return partial result with warning
          return NextResponse.json(
            { template, items: [], warning: 'Template created but items could not be saved' },
            { status: 207 }
          );
        }
        templateItems = inserted || [];
      }
    }

    return NextResponse.json(
      { template: { ...template, cut_list_template_items: templateItems } },
      { status: 201 }
    );
  } catch (err) {
    console.error('Cut list template POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
