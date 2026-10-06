/**
 * app/api/email-intake/route.js
 *
 * GET /api/email-intake?status=pending&q=search+term
 *
 * Lists rows from the email holding queue (inbound_emails) for the CRM
 * team to review. Same role gate as the rest of CRM — this queue is
 * upstream of enquiries, not a separate permission surface.
 *
 * `q` is applied here, server-side, against the full table — not just the
 * page the client currently has loaded. The response is still capped at
 * 200 rows (a reasonable amount for a human to actually review in one
 * sitting), but that cap now only limits how many matches come back, not
 * which ones are searchable: previously the UI filtered client-side over
 * whatever fit in the first 200 rows, so a match sitting past row 200
 * would silently never surface. Escaping below is not a SQL-injection
 * concern (PostgREST parameterizes ilike values) — it only keeps a
 * user-typed comma or parenthesis from being misread as OR-filter syntax,
 * and a literal % or _ from acting as an unintended wildcard.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

/** Escapes ilike wildcards so a literal %, _ or \ in the search term is matched literally. */
function escapeIlikeWildcards(term) {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'pending';
    const brand  = searchParams.get('brand');
    const q      = (searchParams.get('q') || '').trim();

    let query = serviceClient
      .from('inbound_emails')
      .select('id, brand, mailbox, from_address, from_name, subject, body_text, received_at, status, converted_enquiry_id, reviewed_by, reviewed_at, created_at')
      .order('received_at', { ascending: false })
      .limit(200);

    if (status !== 'all') query = query.eq('status', status);
    if (brand) query = query.eq('brand', brand);
    if (q) {
      // Strip characters with syntactic meaning in a PostgREST .or() filter
      // string (comma separates conditions, parentheses nest them) — a
      // search term isn't meant to control filter structure, only content.
      const cleaned = q.replace(/[,()]/g, ' ').trim();
      if (cleaned) {
        const like = `%${escapeIlikeWildcards(cleaned)}%`;
        query = query.or(
          `subject.ilike.${like},from_name.ilike.${like},from_address.ilike.${like},mailbox.ilike.${like}`
        );
      }
    }

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/email-intake:', error);
      return NextResponse.json({ error: 'Failed to fetch inbound emails' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET /api/email-intake:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
