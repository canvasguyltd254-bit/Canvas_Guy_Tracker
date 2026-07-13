/**
 * app/api/journal-entries/[id]/reverse/route.js
 *
 * POST /api/journal-entries/:id/reverse
 *
 * Creates a reversing journal entry for a previously posted transaction,
 * then clears the journal_entry_id on the originating operational record
 * so it can be corrected or re-posted.
 *
 * Required role: admin
 * Required body: { reason: string }
 *
 * Returns:
 *   201 { success: true, reversal_journal_entry_id: uuid }
 *   400 { error: 'reason is missing or entry already reversed' }
 *   404 { error: 'Journal entry not found' }
 *   409 { error: 'This journal entry has already been reversed' }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { reverseJournal } from '@/shared/lib/reverseJournal';

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    // Reversals are admin-only — they permanently alter the audit trail
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.reason?.trim()) {
      return NextResponse.json({ error: 'reason is required — explain why this entry is being reversed' }, { status: 400 });
    }

    const { id, error } = await reverseJournal({
      journalEntryId: params.id,
      reason:         body.reason.trim(),
      postedBy:       user.id,
      client:         serviceClient,
    });

    if (!id) {
      // Distinguish 404 (entry not found) vs 409 (already reversed) vs 400 (other)
      const status =
        error?.includes('not found')           ? 404 :
        error?.includes('already been reversed') ? 409 : 400;
      return NextResponse.json({ error }, { status });
    }

    return NextResponse.json({ success: true, reversal_journal_entry_id: id }, { status: 201 });
  } catch (err) {
    console.error('POST /api/journal-entries/[id]/reverse:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
