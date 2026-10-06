/**
 * app/api/production/jobs/[id]/materials/actuals/route.js
 *
 * GET  — material lines with estimate AND actuals (money). Managers only.
 * POST — body { line_id, issued_quantity?, actual_unit_cost? }  (null clears a value)
 *
 * Writes ONLY the actuals columns (production_v2f). Never touches the estimate,
 * readiness, job status or dates. Roles: admin, production_manager.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';

const PENDING = { error: 'Material actuals are not available yet — run production_v2f_material_actuals.sql', migration_pending: true };

const parseNum = (v) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export async function GET(_request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('production_material_estimates')
      .select('id, material_name, unit, estimated_quantity, estimated_unit_cost, estimated_total_cost, issued_quantity, actual_unit_cost')
      .eq('job_id', params.id).order('created_at', { ascending: true });
    if (error) {
      if (isMissingSchema(error)) return NextResponse.json(PENDING, { status: 503 });
      console.error('Material actuals GET:', error.message);
      return NextResponse.json({ error: 'Failed to load material actuals' }, { status: 500 });
    }
    return NextResponse.json({ lines: data || [] });
  } catch (err) {
    console.error('Material actuals GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let b;
    try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
    if (!b.line_id) return NextResponse.json({ error: 'line_id is required' }, { status: 400 });

    const patch = { actuals_updated_at: new Date().toISOString(), actuals_updated_by: user.id };
    if (b.issued_quantity !== undefined) {
      const n = parseNum(b.issued_quantity);
      if (Number.isNaN(n)) return NextResponse.json({ error: 'issued_quantity must be a number ≥ 0' }, { status: 400 });
      patch.issued_quantity = n;
    }
    if (b.actual_unit_cost !== undefined) {
      const n = parseNum(b.actual_unit_cost);
      if (Number.isNaN(n)) return NextResponse.json({ error: 'actual_unit_cost must be a number ≥ 0' }, { status: 400 });
      patch.actual_unit_cost = n;
    }
    if (Object.keys(patch).length === 2) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

    const { data: job } = await serviceClient.from('production_jobs').select('id, status').eq('id', params.id).maybeSingle();
    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status === 'Cancelled') return NextResponse.json({ error: 'Job is Cancelled' }, { status: 409 });

    const { data, error } = await serviceClient
      .from('production_material_estimates').update(patch)
      .eq('id', b.line_id).eq('job_id', params.id)
      .select('id, issued_quantity, actual_unit_cost').maybeSingle();
    if (error) {
      if (isMissingSchema(error)) return NextResponse.json(PENDING, { status: 503 });
      console.error('Material actuals POST:', error.message);
      return NextResponse.json({ error: 'Failed to save actuals' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'Material line not found for this job' }, { status: 404 });
    return NextResponse.json({ line: data });
  } catch (err) {
    console.error('Material actuals POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
