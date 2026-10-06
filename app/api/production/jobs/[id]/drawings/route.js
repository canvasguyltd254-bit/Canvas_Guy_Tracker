/**
 * app/api/production/jobs/[id]/drawings/route.js
 *
 * GET    /api/production/jobs/:id/drawings   — list drawings linked to this job
 * POST   /api/production/jobs/:id/drawings   — link a drawing to this job
 * DELETE /api/production/jobs/:id/drawings   — unlink a drawing (body: { drawing_id })
 *
 * POST body: { drawing_id: uuid }
 *
 * Roles GET: admin, production_manager, head_of_sales, production_staff
 * Roles POST/DELETE: admin, production_manager
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

    const { data: drawings, error } = await serviceClient
      .from('production_job_drawings')
      .select(`
        drawing_id, linked_at,
        drawings(id, file_name, file_url, category, notes, created_at)
      `)
      .eq('job_id', jobId)
      .order('linked_at', { ascending: true });

    if (error) {
      console.error('Job drawings GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch drawings' }, { status: 500 });
    }

    return NextResponse.json({
      drawings: (drawings || []).map(d => ({
        ...d.drawings,
        linked_at: d.linked_at,
      })),
    });
  } catch (err) {
    console.error('Job drawings GET unexpected:', err.message);
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

    const { drawing_id } = body;
    if (!drawing_id) {
      return NextResponse.json({ error: 'drawing_id is required' }, { status: 400 });
    }

    const { error } = await serviceClient.rpc('link_job_drawing', {
      p_job_id:     jobId,
      p_drawing_id: drawing_id,
      p_linked_by:  user.id,
    });

    if (error) {
      console.error('link_job_drawing RPC:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error('Job drawings POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, props) {
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

    const { drawing_id } = body;
    if (!drawing_id) {
      return NextResponse.json({ error: 'drawing_id is required' }, { status: 400 });
    }

    const { error } = await serviceClient
      .from('production_job_drawings')
      .delete()
      .eq('job_id', jobId)
      .eq('drawing_id', drawing_id);

    if (error) {
      console.error('Job drawings DELETE:', error.message);
      return NextResponse.json({ error: 'Failed to unlink drawing' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Job drawings DELETE unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
