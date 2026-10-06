/**
 * app/api/production/jobs/[id]/cut-list/route.js
 *
 * GET  /api/production/jobs/:id/cut-list   — list cut list items for a job
 * POST /api/production/jobs/:id/cut-list   — add a cut list item
 *
 * POST body:
 *   {
 *     piece_name:           string  (required)
 *     width_cm?:            number
 *     height_cm?:           number
 *     thickness_mm?:        number
 *     quantity?:            integer (default 1, > 0)
 *     material_description?: string
 *     notes?:               string
 *     sort_order?:          integer (default: appended after existing items)
 *   }
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles POST/PATCH/DELETE: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
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

    const { data: items, error } = await serviceClient
      .from('job_cut_list_items')
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order, created_at, updated_at')
      .eq('job_id', jobId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Cut list GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch cut list' }, { status: 500 });
    }

    return NextResponse.json({ items: items || [] });
  } catch (err) {
    console.error('Cut list GET unexpected:', err.message);
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

    const { piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order } = body;

    if (!piece_name?.trim()) {
      return NextResponse.json({ error: 'piece_name is required' }, { status: 400 });
    }

    const qty = quantity != null ? parseInt(quantity, 10) : 1;
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
    }

    // Guard: job must exist
    const { data: job } = await serviceClient
      .from('production_jobs')
      .select('id')
      .eq('id', jobId)
      .single();
    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // Determine sort_order: append after last item if not provided
    let effectiveSortOrder = sort_order != null ? parseInt(sort_order, 10) : null;
    if (effectiveSortOrder === null) {
      const { data: last } = await serviceClient
        .from('job_cut_list_items')
        .select('sort_order')
        .eq('job_id', jobId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      effectiveSortOrder = last ? last.sort_order + 1 : 0;
    }

    const { data: item, error } = await serviceClient
      .from('job_cut_list_items')
      .insert({
        job_id:               jobId,
        piece_name:           piece_name.trim(),
        width_cm:             width_cm     != null ? parseFloat(width_cm)     : null,
        height_cm:            height_cm    != null ? parseFloat(height_cm)    : null,
        thickness_mm:         thickness_mm != null ? parseFloat(thickness_mm) : null,
        quantity:             qty,
        material_description: material_description?.trim() || null,
        notes:                notes?.trim()                 || null,
        sort_order:           effectiveSortOrder,
        created_by:           user.id,
      })
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order, created_at')
      .single();

    if (error) {
      console.error('Cut list POST:', error.message);
      return NextResponse.json({ error: 'Failed to add cut list item' }, { status: 500 });
    }

    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    console.error('Cut list POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
