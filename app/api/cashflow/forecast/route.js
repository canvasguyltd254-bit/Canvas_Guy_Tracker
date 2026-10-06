/**
 * app/api/cashflow/forecast/route.js
 *
 * GET /api/cashflow/forecast
 *
 * Exposes the Stage 2 forecast engine (shared/lib/cashflow) for the first
 * time: assembles a fresh CashflowSnapshot (shared/lib/cashflow/buildSnapshot.js,
 * read-only, computed on every request — nothing is cached or stored) and
 * runs it through projectCashflow() to return a complete CashflowProjection.
 *
 * Role-gated more narrowly than /api/home/summary's accounting section: see
 * homeAccess.js's CAN_SEE_CASHFLOW comment — production roles get no access
 * in Phase 1 because BoQ commitments here expose supplier pricing.
 *
 * Response: { success: true, data: CashflowProjection } — see
 * shared/lib/cashflow/types.js for the full shape.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { CAN_SEE_CASHFLOW } from '@/shared/lib/homeAccess';
import { buildCashflowSnapshot } from '@/shared/lib/cashflow/buildSnapshot';
import { projectCashflow } from '@/shared/lib/cashflow/projectCashflow';

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, CAN_SEE_CASHFLOW);
    if (authError) return authError;

    const snapshot = await buildCashflowSnapshot(serviceClient);
    const projection = projectCashflow(snapshot);

    return NextResponse.json({ success: true, data: projection });
  } catch (err) {
    console.error('GET /api/cashflow/forecast:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
