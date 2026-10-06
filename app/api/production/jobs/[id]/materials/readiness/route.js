/**
 * POST /api/production/jobs/:id/materials/readiness
 * Body: { line_id, readiness: 'unchecked' | 'ready' | 'short', note? }
 *
 * Records whether a material line is physically in hand. Writes ONLY the
 * readiness columns — never costs, quantities, job status or dates. Marking a
 * line short does not block the job; the attention helper reports it until a
 * manager raises a blocker with an owner and expected date.
 *
 * Roles: admin, production_manager, production_staff (workshop records it).
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'production_staff']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!b.line_id) return NextResponse.json({ error: 'line_id is required' }, { status: 400 });
    if (!['unchecked', 'ready', 'short'].includes(b.readiness)) {
      return NextResponse.json({ error: 'readiness must be unchecked, ready or short' }, { status: 400 });
    }
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';

    const { data: job } = await serviceClient.from('production_jobs').select('id, status').eq('id', params.id).maybeSingle();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (['Completed', 'Cancelled'].includes(job.status)) {
      return NextResponse.json({ error: `Job is ${job.status}` }, { status: 409 });
    }

    const { data, error } = await serviceClient
      .from('production_material_estimates')
      .update({
        readiness: b.readiness,
        short_note: b.readiness === 'short' ? (note || null) : null,
        readiness_updated_at: new Date().toISOString(),
        readiness_updated_by: user.id,
      })
      .eq('id', b.line_id)
      .eq('job_id', params.id)          // the line must belong to the job in the URL
      .select('id, readiness, short_note')
      .maybeSingle();

    if (error) {
      if (/readiness/i.test(error.message || '')) {
        return NextResponse.json({ error: 'Material readiness is not available yet — run production_v2d_material_readiness.sql', migration_pending: true }, { status: 503 });
      }
      console.error('Material readiness POST:', error.message);
      return NextResponse.json({ error: 'Failed to save readiness' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Material line not found for this job' }, { status: 404 });
    return NextResponse.json({ line: data });
  } catch (err) {
    console.error('Material readiness POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * GET /api/production/jobs/:id/materials/readiness
 * Material lines with their readiness only — deliberately NO cost columns, so
 * the workshop view can use it without exposing prices.
 * Roles: admin, production_manager, head_of_sales, production_staff.
 */
export async function GET(_request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager', 'head_of_sales', 'production_staff']);
    if (authError) return authError;

    let { data, error } = await serviceClient
      .from('production_material_estimates')
      .select('id, material_name, specification, unit, estimated_quantity, readiness, short_note')
      .eq('job_id', params.id)
      .order('created_at', { ascending: true });
    let pending = false;
    if (error) {
      pending = true;   // v2d not applied: fall back to lines without readiness
      ({ data, error } = await serviceClient
        .from('production_material_estimates')
        .select('id, material_name, specification, unit, estimated_quantity')
        .eq('job_id', params.id)
        .order('created_at', { ascending: true }));
    }
    if (error) {
      console.error('Material readiness GET:', error.message);
      return NextResponse.json({ error: 'Failed to load materials' }, { status: 500 });
    }
    return NextResponse.json({
      lines: (data || []).map((m) => ({ ...m, readiness: m.readiness || 'unchecked', short_note: m.short_note || null })),
      migration_pending: pending,
    });
  } catch (err) {
    console.error('Material readiness GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
