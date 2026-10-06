/**
 * app/api/production/cut-list-templates/[id]/route.js
 *
 * GET    /api/production/cut-list-templates/:id  — get template + items
 * PATCH  /api/production/cut-list-templates/:id  — update name/description/is_active
 * DELETE /api/production/cut-list-templates/:id  — soft-delete (set is_active=false)
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles PATCH/DELETE: admin, production_manager
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

    const { data: template, error } = await serviceClient
      .from('cut_list_templates')
      .select(`
        id, name, description, is_active, created_at, updated_at,
        cut_list_template_items(
          id, piece_name, width_cm, height_cm, thickness_mm,
          quantity, material_description, notes, sort_order
        )
      `)
      .eq('id', params.id)
      .single();

    if (error || !template) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    template.cut_list_template_items = (template.cut_list_template_items || []).sort(
      (a, b) => a.sort_order - b.sort_order
    );

    return NextResponse.json({ template });
  } catch (err) {
    console.error('Template GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, props) {
  const params = await props.params;
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

    const { data: existing } = await serviceClient
      .from('cut_list_templates')
      .select('id')
      .eq('id', params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const patch = { updated_at: new Date().toISOString() };
    if (body.name        !== undefined) {
      if (!body.name?.trim()) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
      patch.name = body.name.trim();
    }
    if (body.description !== undefined) patch.description = body.description?.trim() || null;
    if (body.is_active   !== undefined) patch.is_active   = Boolean(body.is_active);

    const { data: template, error } = await serviceClient
      .from('cut_list_templates')
      .update(patch)
      .eq('id', params.id)
      .select('id, name, description, is_active, updated_at')
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
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data: existing } = await serviceClient
      .from('cut_list_templates')
      .select('id')
      .eq('id', params.id)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Soft-delete: set is_active = false so historical applications are preserved
    const { error } = await serviceClient
      .from('cut_list_templates')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', params.id);

    if (error) {
      console.error('Template DELETE:', error.message);
      return NextResponse.json({ error: 'Failed to archive template' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Template DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
