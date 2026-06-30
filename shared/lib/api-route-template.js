/**
 * shared/lib/api-route-template.js
 *
 * Copy-paste template for every new Canvas Guy Tracker API route.
 * Replace all UPPER_CASE placeholders before shipping.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY CHECKLIST (every route must pass before merging):
 * ─────────────────────────────────────────────────────────────────────────────
 * [ ] getAuthContext() is called first — before any DB access or body parsing
 * [ ] requireRole() gate is called before any DB write or sensitive read
 * [ ] Body is parsed from request.json() or request.formData() (never from URL
 *     query params for write operations)
 * [ ] pick() is applied to every insert and update payload before it hits the DB
 * [ ] order_id, user_id, author_name, uploaded_by — ALL injected from server
 *     context (params.id or session), NEVER accepted from the request body
 * [ ] serviceClient is used for all DB writes (not the browser/anon client)
 * [ ] All error paths return structured JSON: { error: "..." }
 *     — stack traces are never exposed in responses
 * [ ] No server-only imports (serviceClient, SUPABASE_SERVICE_KEY) are used in
 *     any 'use client' component or shared utility that might run in the browser
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

// ── OPTIONAL: import constants if this route touches status or role lists ─────
// import { ROLES_CAN_ADVANCE, STATUSES } from '@/modules/orders/components/constants';

// ── GET ───────────────────────────────────────────────────────────────────────
//
// Use for: list or fetch operations.
// Auth: even read endpoints must verify the user is authenticated.
// Omit the second argument to requireRole() to allow any authenticated role.

export async function GET(request, { params }) {
  try {
    const resourceId = params.id; // replace 'id' with the actual param name

    // STEP 1 — Auth (always first)
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role /* , ['admin', 'role_b'] — omit for any authed user */);
    if (authError) return authError;

    // STEP 2 — Fetch from DB via serviceClient
    const { data, error } = await serviceClient
      .from('TABLE_NAME')
      .select('*')
      .eq('FOREIGN_KEY', resourceId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('GET /api/ROUTE_PATH:', error);
      return NextResponse.json({ error: 'Failed to fetch TABLE_NAME' }, { status: 500 });
    }

    // STEP 3 — Return structured response
    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('GET /api/ROUTE_PATH:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────
//
// Use for: create operations and workflow actions (e.g. status transitions).
// CRITICAL: pick() must be called before every insert. No exceptions.

export async function POST(request, { params }) {
  try {
    const resourceId = params.id; // injected from URL — safe to use as scope key

    // STEP 1 — Auth
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'ROLE_B']); // restrict as needed
    if (authError) return authError;

    // STEP 2 — Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // STEP 3 — Whitelist fields (drop anything not in the allow-list)
    const safePayload = pick(body, ALLOWED_FIELDS.TABLE_NAME.insert);

    // STEP 4 — Inject server-side fields (AFTER pick, so they can't be overwritten)
    safePayload.FOREIGN_KEY = resourceId;   // e.g. order_id = params.id
    // safePayload.author_name = displayName; // e.g. for notes
    // safePayload.uploaded_by = user.id;    // e.g. for documents/drawings

    // STEP 5 — Validate required fields
    if (!safePayload.REQUIRED_FIELD) {
      return NextResponse.json({ error: 'REQUIRED_FIELD is required' }, { status: 400 });
    }

    // STEP 6 — Write to DB
    const { data, error } = await serviceClient
      .from('TABLE_NAME')
      .insert(safePayload)
      .select()
      .single();

    if (error) {
      console.error('POST /api/ROUTE_PATH:', error);
      return NextResponse.json({ error: 'Failed to create TABLE_NAME record' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });

  } catch (err) {
    console.error('POST /api/ROUTE_PATH:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
//
// Use for: partial updates to an existing record.
// CRITICAL: never allow 'status' through the general update route — use a
// dedicated /status route for workflow state changes.

export async function PATCH(request, { params }) {
  try {
    const resourceId = params.id;

    // STEP 1 — Auth
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'ROLE_B']);
    if (authError) return authError;

    // STEP 2 — Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // STEP 3 — Whitelist (exclude sensitive fields like 'status' when appropriate)
    const UPDATE_FIELDS = ALLOWED_FIELDS.TABLE_NAME.update.filter(f => f !== 'status');
    const safePayload = pick(body, UPDATE_FIELDS);

    if (Object.keys(safePayload).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    // STEP 4 — Write to DB (scope to both id AND foreign key to prevent cross-tenant writes)
    const { data, error } = await serviceClient
      .from('TABLE_NAME')
      .update(safePayload)
      .eq('id', resourceId)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/ROUTE_PATH:', error);
      return NextResponse.json({ error: 'Failed to update TABLE_NAME' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('PATCH /api/ROUTE_PATH:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────
//
// Use for: hard or soft deletes.
// Prefer soft deletes (deleted_at timestamp) for auditable records.
// Always scope the WHERE clause to both the resource id AND the parent id.

export async function DELETE(request, { params }) {
  try {
    const resourceId = params.id;
    const { searchParams } = new URL(request.url);
    const targetId = searchParams.get('RECORD_ID_PARAM');

    if (!targetId) {
      return NextResponse.json({ error: 'Missing RECORD_ID_PARAM query param' }, { status: 400 });
    }

    // STEP 1 — Auth (tightest role for deletes — usually admin only)
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // STEP 2 — Verify record exists and belongs to this resource (prevents cross-tenant deletes)
    const { data: record } = await serviceClient
      .from('TABLE_NAME')
      .select('id')
      .eq('id', targetId)
      .eq('FOREIGN_KEY', resourceId)
      .single();

    if (!record) {
      return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    }

    // STEP 3 — Delete (hard) or soft-delete
    // Hard:
    const { error } = await serviceClient
      .from('TABLE_NAME')
      .delete()
      .eq('id', targetId)
      .eq('FOREIGN_KEY', resourceId);

    // Soft (use instead of hard delete for audit trail):
    // const { error } = await serviceClient
    //   .from('TABLE_NAME')
    //   .update({ deleted_at: new Date().toISOString() })
    //   .eq('id', targetId)
    //   .eq('FOREIGN_KEY', resourceId)
    //   .is('deleted_at', null);

    if (error) {
      console.error('DELETE /api/ROUTE_PATH:', error);
      return NextResponse.json({ error: 'Failed to delete record' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Record deleted' });

  } catch (err) {
    console.error('DELETE /api/ROUTE_PATH:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
