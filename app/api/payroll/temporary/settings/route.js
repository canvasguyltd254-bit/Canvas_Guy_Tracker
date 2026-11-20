/**
 * GET   /api/payroll/temporary/settings   current limits (run roles)
 * PATCH /api/payroll/temporary/settings   change them (admin only; the database function re-checks)
 */
import { NextResponse } from 'next/server';
import { guard, rpc, bad, readJson, serviceClient, dbError } from '@/shared/lib/payroll/temporaryServer';
import { SETTINGS_COLUMNS } from '@/shared/lib/payroll/temporaryAccess';

const NUMERIC = ['settlement_threshold_units', 'admin_approval_limit_kes', 'rolling_window_days', 'deduction_single_limit_kes', 'deduction_total_pct'];

export async function GET() {
  const g = await guard(); if (g.error) return g.error;
  const { data, error } = await serviceClient.from('temporary_worker_settings').select(SETTINGS_COLUMNS).eq('id', true).maybeSingle();
  if (error) return dbError(error);
  // A missing row is reported as such: the system is fail-closed (admin only) in that state.
  return NextResponse.json({ settings: data || null });
}

export async function PATCH(request) {
  const g = await guard(['admin']); if (g.error) return g.error;
  const b = await readJson(request);
  const changes = {};
  for (const k of NUMERIC) {
    if (!(k in b)) continue;
    if (k === 'admin_approval_limit_kes' && (b[k] === null || b[k] === '')) { changes[k] = null; continue; }   // NULL = fail-closed
    const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) return bad(`${k} must be a number of 0 or more`);
    changes[k] = n;
  }
  if ('damage_deductions_enabled' in b) changes.damage_deductions_enabled = !!b.damage_deductions_enabled;
  if (!Object.keys(changes).length) return bad('Nothing to change');
  return rpc('set_temporary_worker_settings', { p_changes: changes, p_actor: g.user.id, p_role: g.role });
}
