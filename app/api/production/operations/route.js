/**
 * app/api/production/operations/route.js
 *
 * GET /api/production/operations
 *
 * Returns all production operations ordered by sort_order.
 * Used by AssignWorkersModal to populate the operation picker.
 *
 * Roles: admin, production_manager, production_staff, head_of_sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'production_staff', 'head_of_sales',
    ]);
    if (authError) return authError;

    const { data: operations, error } = await serviceClient
      .from('production_operations')
      .select('id, code, name, stage_key, is_active, sort_order')
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('Production operations GET:', error.message);
      return NextResponse.json({ error: 'Failed to fetch operations' }, { status: 500 });
    }

    return NextResponse.json({ operations: operations || [] });
  } catch (err) {
    console.error('Production operations GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
