/**
 * app/api/customers/[id]/notes/route.js
 *
 * GET  /api/customers/:id/notes  — list notes (newest first)
 * POST /api/customers/:id/notes  — add a note
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('customer_notes')
      .select('*')
      .eq('customer_id', params.id)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 });

    return NextResponse.json({ success: true, data: data || [] });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.content?.trim()) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 });
    }

    // Get author name from profile
    const { data: profile } = await serviceClient
      .from('user_profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    const { data, error } = await serviceClient
      .from('customer_notes')
      .insert({
        customer_id: params.id,
        content:     body.content.trim(),
        author_name: profile?.display_name || user.email || 'Unknown',
        created_by:  user.id,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: 'Failed to create note' }, { status: 500 });

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
