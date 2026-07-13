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
 *  - The operational record's journal_entry_id is set to NULL.
 *  - The operational record can now be edited, deleted, or re-posted.
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

import { postJournal } from './postJournal.js';

// source_type → { table, idColumn }
const SOURCE_TABLE_MAP = {
  'purchase':                 { table: 'supplier_purchases',          col: 'journal_entry_id' },
  'manual_payment':           { table: 'manual_supplier_payments',    col: 'journal_entry_id' },
  'chatpesa_allocation':      { table: 'chatpesa_payment_allocations', col: 'journal_entry_id' },
  'supplier_opening_balance': { table: 'suppliers',                   col: 'opening_balance_journal_entry_id' },
};

/**
 * @param {object} opts
 * @param {string} opts.journalEntryId — journal_entries.id to reverse
 * @param {string} opts.reason         — mandatory human explanation (stored in description)
 * @param {string} opts.postedBy       — auth.users.id of the person reversing
 * @param {object} opts.client         — Supabase serviceClient
 * @returns {Promise<{id: string|null, error: string|null}>}
 */
export async function reverseJournal({ journalEntryId, reason, postedBy, client }) {
  if (!reason?.trim()) {
    return { id: null, error: 'Reversal reason is required' };
  }

  try {
    // 1. Fetch original entry + its lines
    const { data: entry, error: entryErr } = await client
      .from('journal_entries')
      .select('id, entry_date, description, source_type, source_id, journal_lines(account_id, amount, description)')
      .eq('id', journalEntryId)
      .single();

    if (entryErr || !entry) {
      return { id: null, error: `Journal entry ${journalEntryId} not found` };
    }

    // 2. Guard: block if this entry has already been reversed
    const { count: existingReversal } = await client
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', 'reversal')
      .eq('source_id', journalEntryId);

    if (existingReversal > 0) {
      return { id: null, error: 'This journal entry has already been reversed' };
    }

    // 3. Build reversed lines — flip every sign
    const reversedLines = (entry.journal_lines || []).map(l => ({
      account_id:  l.account_id,
      amount:      -l.amount,
      description: `REVERSAL: ${l.description || ''}`.trim(),
    }));

    if (reversedLines.length === 0) {
      return { id: null, error: 'Original journal entry has no lines — cannot reverse' };
    }

    // 4. Post the reversal entry (uses same RPC — balanced by construction)
    const { id: reversalId, error: reversalErr } = await postJournal({
      sourceType:  'reversal',
      sourceId:    journalEntryId,    // UNIQUE(source_type, source_id) blocks double-reversal
      entryDate:   new Date().toISOString().split('T')[0],
      description: `REVERSAL of "${entry.description}". Reason: ${reason.trim()}`,
      lines:       reversedLines,
      postedBy,
      client,
    });

    if (!reversalId) {
      return { id: null, error: reversalErr };
    }

    // 5. Mark the original entry as 'reversed' so it vacates the
    //    idx_journal_entries_active_source partial unique index.
    //    This allows a corrected re-post on the same (source_type, source_id)
    //    pair to succeed without hitting DUPLICATE_POSTING.
    const { error: statusErr } = await client
      .from('journal_entries')
      .update({ status: 'reversed' })
      .eq('id', journalEntryId);

    if (statusErr) {
      // Reversal journal committed — don't fail, but log. The corrected
      // re-post will still hit DUPLICATE_POSTING until this is fixed manually.
      console.error(
        `reverseJournal: reversal ${reversalId} posted but could not mark original ${journalEntryId} as reversed:`,
        statusErr.message,
      );
    }

    // 6. Clear journal_entry_id on the originating operational record so it
    //    can be edited, deleted, or re-posted without the 409 lock.
    const target = SOURCE_TABLE_MAP[entry.source_type];
    if (target) {
      const { error: clearErr } = await client
        .from(target.table)
        .update({ [target.col]: null })
        .eq('id', entry.source_id);

      if (clearErr) {
        // Reversal journal committed — don't fail, but log so it can be fixed manually.
        console.error(
          `reverseJournal: reversal ${reversalId} posted but could not clear ${target.table}.${target.col} for ${entry.source_id}:`,
          clearErr.message,
        );
      }
    } else {
      console.warn(`reverseJournal: no table mapping for source_type "${entry.source_type}" — source record not cleared`);
    }

    return { id: reversalId, error: null };
  } catch (err) {
    return { id: null, error: err.message };
  }
}
