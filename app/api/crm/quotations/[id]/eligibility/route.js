/**
 * app/api/crm/quotations/[id]/eligibility/route.js
 *
 * GET /api/crm/quotations/:id/eligibility
 * Admin only.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(_req, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ['admin']);
    if (authErr) return authErr;

    const quoteId = params.id;

    const { data: quote, error: qErr } = await serviceClient
      .from('quotations')
      .select('id, quote_num, status, suspended_at, suspended_by, suspension_reason')
      .eq('id', quoteId)
      .single();

    if (qErr || !quote) {
      return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
    }

    const { data: check, error: rpcErr } = await serviceClient
      .rpc('check_quotation_deletable', { p_quote_id: quoteId });

    if (rpcErr) {
      console.error('GET /quotations/[id]/eligibility rpc:', rpcErr);
      return NextResponse.json({ error: 'Eligibility check failed' }, { status: 500 });
    }

    return NextResponse.json({
      suspended:        quote.suspended_at !== null,
      suspendedAt:      quote.suspended_at,
      suspensionReason: quote.suspension_reason,
      canSuspend:       true,
      canDelete:        check.canDelete,
      blockers:         check.blockers ?? [],
    });
  } catch (err) {
    console.error('GET /api/crm/quotations/[id]/eligibility:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
