/**
 * GET /api/production/labour/settings   — admin, production_manager
 * PUT /api/production/labour/settings   — admin only
 *
 * overtime_allowance (flat KES per overtime shift), sunday_rate (flat KES per Sunday),
 * monthly_working_days (for permanent staff), require_overtime_reason. Changing them affects FUTURE rate snapshots only:
 * existing assignments and time entries keep the rates they were costed with.
 */
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { isMissingSchema } from '@/shared/lib/production/dbErrors';

const PENDING = { error: 'Labour costing is not available yet — run production_v3a_labour_costing.sql', migration_pending: true };
const COLS = 'overtime_allowance, sunday_rate, monthly_working_days, require_overtime_reason, currency, updated_at';

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;
    const { data, error } = await serviceClient.from('production_labour_settings').select(COLS).eq('id', true).maybeSingle();
    if (error) {
      if (isMissingSchema(error)) return NextResponse.json(PENDING, { status: 503 });
      console.error('Labour settings GET:', error.message);
      return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
    }
    return NextResponse.json({ settings: data });
  } catch (err) {
    console.error('Labour settings GET unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;
    let b; try { b = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const patch = { updated_at: new Date().toISOString(), updated_by: user.id };
    const num = (k, min, max) => {
      if (b[k] === undefined) return null;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < min || n > max) return `${k} must be between ${min} and ${max}`;
      patch[k] = n; return null;
    };
    const err = num('overtime_allowance', 0, 100000) || num('sunday_rate', 0, 100000) || num('monthly_working_days', 1, 31);
    if (err) return NextResponse.json({ error: err }, { status: 400 });
    if (b.require_overtime_reason !== undefined) patch.require_overtime_reason = !!b.require_overtime_reason;
    if (Object.keys(patch).length === 2) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });

    const { data, error } = await serviceClient.from('production_labour_settings').update(patch).eq('id', true).select(COLS).maybeSingle();
    if (error) {
      if (isMissingSchema(error)) return NextResponse.json(PENDING, { status: 503 });
      console.error('Labour settings PUT:', error.message);
      return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
    }
    return NextResponse.json({ settings: data });
  } catch (err) {
    console.error('Labour settings PUT unexpected:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
