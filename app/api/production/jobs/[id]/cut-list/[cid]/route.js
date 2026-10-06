/**
 * app/api/production/jobs/[id]/cut-list/[cid]/route.js
 *
 * PATCH  /api/production/jobs/:id/cut-list/:cid  — update a cut list item
 * DELETE /api/production/jobs/:id/cut-list/:cid  — remove a cut list item
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function PATCH(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, cid } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Verify item belongs to this job
    const { data: existing } = await serviceClient
      .from('job_cut_list_items')
      .select('id, job_id')
      .eq('id', cid)
      .eq('job_id', jobId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Cut list item not found' }, { status: 404 });
    }

    const patch = { updated_at: new Date().toISOString() };

    if (body.piece_name !== undefined) {
      if (!body.piece_name?.trim()) {
        return NextResponse.json({ error: 'piece_name cannot be empty' }, { status: 400 });
      }
      patch.piece_name = body.piece_name.trim();
    }
    if (body.width_cm       !== undefined) patch.width_cm             = body.width_cm     != null ? parseFloat(body.width_cm)     : null;
    if (body.height_cm      !== undefined) patch.height_cm            = body.height_cm    != null ? parseFloat(body.height_cm)    : null;
    if (body.thickness_mm   !== undefined) patch.thickness_mm         = body.thickness_mm != null ? parseFloat(body.thickness_mm) : null;
    if (body.quantity       !== undefined) {
      const qty = parseInt(body.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1) {
        return NextResponse.json({ error: 'quantity must be a positive integer' }, { status: 400 });
      }
      patch.quantity = qty;
    }
    if (body.material_description !== undefined) patch.material_description = body.material_description?.trim() || null;
    if (body.notes                !== undefined) patch.notes                = body.notes?.trim()                 || null;
    if (body.sort_order           !== undefined) patch.sort_order           = parseInt(body.sort_order, 10);

    const { data: item, error } = await serviceClient
      .from('job_cut_list_items')
      .update(patch)
      .eq('id', cid)
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order, updated_at')
      .single();

    if (error) {
      console.error('Cut list PATCH:', error.message);
      return NextResponse.json({ error: 'Failed to update cut list item' }, { status: 500 });
    }

    return NextResponse.json({ item });
  } catch (err) {
    console.error('Cut list PATCH unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
  const params = await props.params;
  try {
    const { id: jobId, cid } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    // Verify item belongs to this job
    const { data: existing } = await serviceClient
      .from('job_cut_list_items')
      .select('id')
      .eq('id', cid)
      .eq('job_id', jobId)
      .single();

    if (!existing) {
      return NextResponse.json({ error: 'Cut list item not found' }, { status: 404 });
    }

    const { error } = await serviceClient
      .from('job_cut_list_items')
      .delete()
      .eq('id', cid);

    if (error) {
      console.error('Cut list DELETE:', error.message);
      return NextResponse.json({ error: 'Failed to delete cut list item' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Cut list DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
