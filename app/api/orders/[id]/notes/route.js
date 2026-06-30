/**
 * app/api/orders/[id]/notes/route.js
 *
 * GET  /api/orders/:id/notes  — list notes (any authenticated user)
 * POST /api/orders/:id/notes  — add note
 *
 * author_name is resolved from the verified session — never accepted from body.
 */

export const runtime = 'edge';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

export async function GET(request, { params }) {
  try {
    const orderId = params.id;

    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role); // any authenticated user
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('order_notes')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('GET /api/orders/[id]/notes:', error);
      return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });

  } catch (err) {
    console.error('GET /api/orders/[id]/notes:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const orderId = params.id;

    // 1. Auth
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, [
      'admin', 'production_manager', 'head_of_sales', 'sales', 'production_staff',
    ]);
    if (authError) return authError;

    // 2. Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.content?.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    // 3. Build note — author_name is from session, NOT from body
    const noteRaw = {
      order_id: orderId,          // injected server-side
      content: body.content.trim(),
      author_name: displayName,   // injected from verified session — never from body
    };

    const safeNote = pick(noteRaw, ALLOWED_FIELDS.order_notes.insert);

    // 4. Insert
    const { data, error } = await serviceClient
      .from('order_notes')
      .insert(safeNote)
      .select()
      .single();

    if (error) {
      console.error('POST /api/orders/[id]/notes:', error);
      return NextResponse.json({ error: 'Failed to add note' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });

  } catch (err) {
    console.error('POST /api/orders/[id]/notes:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
