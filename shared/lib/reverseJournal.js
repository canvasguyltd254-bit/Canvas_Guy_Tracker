/**
 * shared/lib/reverseJournal.js
 *
 * Creates an equal-and-opposite (reversing) journal entry for a previously
 * posted journal, then clears the journal_entry_id on the originating
 * operational record so it can be edited, deleted, or re-posted.
 *
 * ── How reversals work ───────────────────────────────────────
 *
 *  Original entry (e.g. purchase):
 *    DR Timber (5010)      +10,000
 *    CR Accounts Payable   -10,000
 *
 *  Reversal entry:
 *    DR Accounts Payable   +10,000   ← signs flipped
 *    CR Timber (5010)      -10,000
 *
 *  Net effect on the ledger: zero.
 *
 *  After the reversal:
 *  - The original journal_entry remains in the ledger (audit trail).
 *  - A second journal_entry with source_type='reversal' is appended.
 *  - The operational record's journal reference is set to NULL.
 *  - The operational record can now be edited, deleted, or re-posted.
 *
 * ── Atomicity ────────────────────────────────────────────────
 *
 *  All six steps (lock, verify, insert header, insert lines, mark reversed,
 *  clear source) run inside the atomic_reverse_journal_entry() PostgreSQL
 *  function — a single database transaction. If any step fails, the entire
 *  operation rolls back. There is no partial-reversal state.
 *
 * ── Source-type → table mapping ──────────────────────────────
 *
 *  'purchase'                → supplier_purchases.journal_entry_id
 *  'manual_payment'          → manual_supplier_payments.journal_entry_id
 *  'chatpesa_allocation'     → chatpesa_payment_allocations.journal_entry_id
 *  'supplier_opening_balance'→ suppliers.opening_balance_journal_entry_id
 *
 * ── Usage ────────────────────────────────────────────────────
 *  const { id, error } = await reverseJournal({
 *    journalEntryId: '...',
 *    reason:         'Wrong category selected',
 *    postedBy:       userId,
 *    client:         serviceClient,
 *  });
 *
 *  if (id) { // reversal committed — source record is unlocked }
 */

/**
 * @param {object} opts
 * @param {string} opts.journalEntryId — journal_entries.id to reverse
 * @param {string} opts.reason         — mandatory human explanation
 * @param {string} opts.postedBy       — auth.users.id of the person reversing
 * @param {object} opts.client         — Supabase serviceClient
 * @returns {Promise<{id: string|null, error: string|null}>}
 */
export async function reverseJournal({ journalEntryId, reason, postedBy, client }) {
  if (!reason?.trim()) {
    return { id: null, error: 'Reversal reason is required' };
  }

  try {
    // Single atomic RPC — all six reversal steps in one PostgreSQL transaction.
    // Raises named exceptions that we map to human-readable errors below.
    const { data: reversalId, error: rpcErr } = await client.rpc('atomic_reverse_journal_entry', {
      p_journal_id: journalEntryId,
      p_reason:     reason.trim(),
      p_posted_by:  postedBy,
    });

    if (rpcErr) {
      const msg = rpcErr.message || '';

      // Map PostgreSQL exception names → caller-friendly error strings
      if (msg.includes('JOURNAL_NOT_FOUND')) {
        return { id: null, error: `Journal entry ${journalEntryId} not found` };
      }
      if (msg.includes('ALREADY_REVERSED')) {
        return { id: null, error: 'This journal entry has already been reversed' };
      }
      if (msg.includes('EMPTY_ENTRY')) {
        return { id: null, error: 'Original journal entry has no lines — cannot reverse' };
      }
      if (msg.includes('UNBALANCED_REVERSAL')) {
        return { id: null, error: 'Reversal aborted: original entry was unbalanced' };
      }

      return { id: null, error: msg };
    }

    return { id: reversalId, error: null };
  } catch (err) {
    return { id: null, error: err.message };
  }
}
