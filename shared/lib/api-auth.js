/**
 * shared/lib/api-auth.js
 *
 * Shared auth helpers for Next.js API routes (server-side only).
 * Extracts the pattern already used in drawings/route.js so every
 * new API route gets identical, consistent auth behaviour.
 *
 * Usage:
 *   import { getAuthContext, requireRole, unauthorized, forbidden } from '@/shared/lib/api-auth';
 *
 *   export async function POST(request, { params }) {
 *     const { user, role } = await getAuthContext();
 *     const authError = requireRole(user, role, ['admin', 'head_of_sales']);
 *     if (authError) return authError;
 *     // ... safe to proceed
 *   }
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabase } from '@/shared/supabase/server';

// Service-role client — server-side only, never sent to browser.
// Used for role lookups and DB writes after the user is verified.
const serviceClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

export { serviceClient };

// ── Auth context ──────────────────────────────────────────────────────────────

/**
 * Reads the authenticated user from request cookies.
 * Returns { user, role } — both null if unauthenticated.
 *
 * Always call this first in every API route handler.
 * Never trust role or user data from the request body.
 */
export async function getAuthContext() {
  try {
    const authClient = createServerSupabase();
    const { data: { user }, error } = await authClient.auth.getUser();

    if (error || !user) return { user: null, role: null };

    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('role, display_name')
      .eq('id', user.id)
      .single();

    return {
      user,
      role: profile?.role || 'viewer',
      displayName: profile?.display_name || user.email?.split('@')[0] || 'Unknown',
    };
  } catch {
    return { user: null, role: null };
  }
}

// ── Role guard ────────────────────────────────────────────────────────────────

/**
 * Returns a 401/403 Response if the user doesn't meet role requirements,
 * or null if they pass. Pattern: early-return the result if truthy.
 *
 * @param {object|null} user  - from getAuthContext()
 * @param {string|null} role  - from getAuthContext()
 * @param {string[]} allowed  - roles that may proceed (empty = any authenticated user)
 */
export function requireRole(user, role, allowed = []) {
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized: no active session' }, { status: 401 });
  }
  if (allowed.length > 0 && !allowed.includes(role)) {
    return NextResponse.json(
      { error: `Forbidden: requires one of [${allowed.join(', ')}]` },
      { status: 403 },
    );
  }
  return null; // passed
}

// ── Standard response helpers ─────────────────────────────────────────────────

export const unauthorized = (msg = 'Unauthorized') =>
  NextResponse.json({ error: msg }, { status: 401 });

export const forbidden = (msg = 'Forbidden') =>
  NextResponse.json({ error: msg }, { status: 403 });

export const notFound = (msg = 'Not found') =>
  NextResponse.json({ error: msg }, { status: 404 });

export const badRequest = (msg = 'Bad request') =>
  NextResponse.json({ error: msg }, { status: 400 });

export const serverError = (msg = 'Internal server error') =>
  NextResponse.json({ error: msg }, { status: 500 });

export const ok = (data) =>
  NextResponse.json({ success: true, ...data });
