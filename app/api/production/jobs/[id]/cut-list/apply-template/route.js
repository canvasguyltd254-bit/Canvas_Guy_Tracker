/**
 * app/api/production/jobs/[id]/cut-list/apply-template/route.js
 *
 * POST /api/production/jobs/:id/cut-list/apply-template
 *
 * Copies items from a cut list template to this job's cut list.
 * Appends after any existing items — does NOT clear existing items.
 *
 * Body: { template_id: uuid }
 *
 * Returns: { inserted: number, items: CutListItem[] }
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

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

    const { template_id } = body;
    if (!template_id) {
      return NextResponse.json({ error: 'template_id is required' }, { status: 400 });
    }

    // Invoke the RPC which handles the append logic
    const { data: inserted, error } = await serviceClient
      .rpc('apply_cut_list_template', {
        p_job_id:      jobId,
        p_template_id: template_id,
        p_applied_by:  user.id,
      });

    if (error) {
      console.error('apply_cut_list_template RPC:', error.message);
      // Surface RPC RAISE EXCEPTION messages to the client
      if (error.code === 'P0001') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Failed to apply template' }, { status: 500 });
    }

    // Fetch the updated cut list so the UI can refresh in one round-trip
    const { data: items } = await serviceClient
      .from('job_cut_list_items')
      .select('id, piece_name, width_cm, height_cm, thickness_mm, quantity, material_description, notes, sort_order, created_at, updated_at')
      .eq('job_id', jobId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    return NextResponse.json({ inserted, items: items || [] });
  } catch (err) {
    console.error('apply-template POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
