/**
 * app/api/production/templates/route.js
 *
 * GET  /api/production/templates          — list all templates (with item count)
 *   ?category=Wall+Decoration             — filter by category (exact match)
 *   ?with_items=true                      — include full item arrays
 *
 * POST /api/production/templates          — create a new template (header only)
 *   body: { name, category, description? }
 *
 * Roles GET: admin, production_manager, production_staff
 * Roles POST: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'production_staff',
    ]);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const category  = searchParams.get('category');
    const withItems = searchParams.get('with_items') === 'true';

    let query = serviceClient
      .from('production_boq_templates')
      .select(withItems
        ? `id, name, category, description, is_active, created_at, updated_at,
           production_boq_template_items(
             id, sort_order, material_name, specification,
             unit, quantity_per_unit, waste_percentage, boq_line_type, notes
           )`
        : `id, name, category, description, is_active, created_at, updated_at,
           production_boq_template_items(id)`
      )
      .eq('is_active', true)
      .order('name');

    if (category) query = query.eq('category', category);

    const { data: templates, error } = await query;
    if (error) {
      console.error('Templates GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }

    // Attach item_count for convenience
    const out = (templates || []).map(t => ({
      ...t,
      item_count: Array.isArray(t.production_boq_template_items)
        ? t.production_boq_template_items.length
        : 0,
      items: withItems
        ? (t.production_boq_template_items || []).sort((a, b) => a.sort_order - b.sort_order)
        : undefined,
      production_boq_template_items: undefined,
    }));

    return NextResponse.json({ templates: out });
  } catch (err) {
    console.error('Templates GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { name, category, description } = body;
    if (!name?.trim())     return NextResponse.json({ error: 'name is required' },     { status: 400 });
    if (!category?.trim()) return NextResponse.json({ error: 'category is required' }, { status: 400 });

    const { data: template, error } = await serviceClient
      .from('production_boq_templates')
      .insert({
        name:        name.trim(),
        category:    category.trim(),
        description: description?.trim() || null,
        created_by:  user.id,
      })
      .select('id, name, category, description, is_active, created_at, updated_at')
      .single();

    if (error) {
      console.error('Templates POST:', error.message);
      return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
    }

    return NextResponse.json({ template: { ...template, item_count: 0, items: [] } }, { status: 201 });
  } catch (err) {
    console.error('Templates POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
