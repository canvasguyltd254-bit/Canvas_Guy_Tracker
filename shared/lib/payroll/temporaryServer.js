/**
 * Server helpers shared by the /api/payroll/temporary/* routes.
 * Every route: authenticate, allow only TEMP_ROLES, validate the shape of the input, then call ONE database
 * function that enforces the real rules atomically. No multi-step logic lives in the API.
 */
import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { TEMP_ROLES, mapTemporaryDbError } from '@/shared/lib/payroll/temporaryAccess';

/** { user, role } for an allowed caller, or { error: Response }. */
export async function guard(roles = TEMP_ROLES) {
  const { user, role } = await getAuthContext();
  const error = requireRole(user, role, roles);
  return error ? { error } : { user, role };
}

export const dbError = (error) => {
  const m = mapTemporaryDbError(error);
  if (m.status === 500) console.error('temporary-workers db error:', error?.code, error?.message);
  return NextResponse.json(m.body, { status: m.status });
};

/** Call a database function and return { data } or the mapped error response. */
export async function rpc(name, args, status = 200) {
  const { data, error } = await serviceClient.rpc(name, args);
  if (error) return dbError(error);
  return NextResponse.json({ data: data ?? null }, { status });
}

export const bad = (message, code = 'BAD_REQUEST') => NextResponse.json({ error: message, code }, { status: 400 });

export async function readJson(request) {
  try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}

export { serviceClient };
