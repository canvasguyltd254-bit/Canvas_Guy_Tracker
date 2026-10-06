/**
 * app/api/production/jobs/[id]/materials/apply-template/route.js
 *
 * POST /api/production/jobs/:id/materials/apply-template
 *   Atomically loads a BoQ template into the job's material estimates.
 *
 *   Body:
 *     template_id  string (uuid)  — ID of the active BoQ template to apply
 *     mode         string         — "append" | "replace"
 *                                   append : adds template items alongside existing estimates
 *                                   replace: wipes existing estimates, then inserts template items
 *
 *   Returns: { inserted: number }
 *
 * Roles: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, props) {
  const params = await props.params;
  try {
    const { id: jobId } = params;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { template_id: templateId, mode } = body;

    if (!templateId) {
      return NextResponse.json({ error: 'template_id is required' }, { status: 400 });
    }
    if (!mode || !['append', 'replace'].includes(mode)) {
      return NextResponse.json(
        { error: 'mode must be "append" or "replace"' },
        { status: 400 },
      );
    }

    // Delegate to the PostgreSQL RPC for atomicity.
    // The RPC: locks the job row, validates the template is active and has items,
    // optionally deletes existing estimates (replace mode), and inserts all template
    // items in one transaction.
    const { data: inserted, error: rpcErr } = await serviceClient.rpc(
      'apply_boq_template_to_job',
      {
        p_job_id:      jobId,
        p_template_id: templateId,
        p_mode:        mode,
        p_applied_by:  user.id,
      },
    );

    if (rpcErr) {
      console.error('apply_boq_template_to_job RPC:', rpcErr.message);
      return NextResponse.json(
        { error: rpcErr.message || 'Failed to apply template' },
        { status: 500 },
      );
    }

    return NextResponse.json({ inserted: inserted ?? 0 });
  } catch (err) {
    console.error('apply-template POST unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
