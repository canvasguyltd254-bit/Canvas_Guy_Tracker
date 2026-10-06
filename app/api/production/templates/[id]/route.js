/**
 * app/api/production/templates/[id]/route.js
 *
 * GET    /api/production/templates/:id  — fetch template with all items
 * PATCH  /api/production/templates/:id  — update name, category, description
 * DELETE /api/production/templates/:id  — soft-delete (sets is_active = false)
 *
 * Roles GET: admin, production_manager, production_staff
 * Roles PATCH/DELETE: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, props) {
  const params = await props.params;
  try {
    const { id } = params;
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'production_staff']);
    if (authError) return authError;

    const { data: template, error } = await serviceClient
      .from('production_boq_templates')
      .select(`
        id, name, category, description, is_active, created_at, updated_at,
        production_boq_template_items(
          id, sort_order, material_name, specification,
          unit, quantity_per_unit, waste_percentage, boq_line_type, notes
        )
      `)
      .eq('id', id)
      .single();

    if (error || !template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const items = (template.production_boq_template_items || [])
      .sort((a, b) => a.sort_order - b.sort_order);

    return NextResponse.json({
      template: {
        ...template,
        items,
        item_count: items.length,
        production_boq_template_items: undefined,
      },
    });
  } catch (err) {
    console.error('Template GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const { id } = params;
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const patch = { updated_at: new Date().toISOString() };
    if (body.name     !== undefined) {
      if (!body.name?.trim()) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      patch.name = body.name.trim();
    }
    if (body.category !== undefined) {
      if (!body.category?.trim()) return NextResponse.json({ error: 'category cannot be empty' }, { status: 400 });
      patch.category = body.category.trim();
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || null;

    const { data: template, error } = await serviceClient
      .from('production_boq_templates')
      .update(patch)
      .eq('id', id)
      .select('id, name, category, description, is_active, updated_at')
      .single();

    if (error) {
      console.error('Template PATCH:', error.message);
      return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
    }

    return NextResponse.json({ template });
  } catch (err) {
    console.error('Template PATCH unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { id } = params;
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    // Soft-delete: set is_active = false so existing jobs that loaded this template
    // keep working, but it no longer appears in the templates list.
    const { error } = await serviceClient
      .from('production_boq_templates')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error('Template DELETE:', error.message);
      return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Template DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
