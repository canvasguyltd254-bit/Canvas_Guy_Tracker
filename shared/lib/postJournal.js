/**
 * shared/lib/postJournal.js
 *
 * Base journal posting function. Calls the post_journal_entry() Postgres
 * RPC function, which atomically inserts journal_entries + journal_lines
 * and validates that they sum to zero (balanced entry).
 *
 * Returns { id: uuid, error: null } on success.
 * Returns { id: null, error: string } on failure — NEVER throws.
 * On failure, the error is also written to accounting_posting_errors.
 *
 * ── Signed-amount model ──────────────────────────────────────
 *   positive amount = debit
 *   negative amount = credit
 *   SUM(lines.amount) must = 0
 *
 * ── Usage ────────────────────────────────────────────────────
 *   import { postJournal } from '@/shared/lib/postJournal';
 *
 *   const { id, error } = await postJournal({
 *     sourceType: 'purchase',
 *     sourceId:   purchaseId,
 *     entryDate:  '2026-07-13',
 *     description: 'Timber purchase',
 *     lines: [
 *       { account_id: '...', amount:  5000, description: 'Timber' },   // DR
 *       { account_id: '...', amount: -5000, description: 'AP' },        // CR
 *     ],
 *     postedBy: userId,
 *     client:   serviceClient,
 *   });
 *
 *   if (id) {
 *     // write journal_entry_id back to source record
 *   }
 */

/**
 * @param {object}  opts
 * @param {string}  opts.sourceType   — 'purchase' | 'manual_payment' | 'chatpesa_allocation'
 * @param {string}  opts.sourceId     — UUID of the originating row
 * @param {string}  opts.entryDate    — ISO date string 'YYYY-MM-DD'
 * @param {string}  opts.description  — human-readable entry description
 * @param {Array}   opts.lines        — [{account_id, amount, description?}]
 * @param {string}  opts.postedBy     — auth.users.id of the API caller
 * @param {object}  opts.client       — Supabase serviceClient
 * @returns {Promise<{id: string|null, error: string|null}>}
 */
export async function postJournal({ sourceType, sourceId, entryDate, description, lines, postedBy, client }) {
  // Belt-and-braces client-side balance check — the RPC enforces this too
  const sum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  if (Math.abs(sum) > 0.005) {
    const msg = `UNBALANCED_JOURNAL: lines sum to ${sum.toFixed(4)} (must be 0)`;
    await _logError({ sourceType, sourceId, message: msg, postedBy, client });
    return { id: null, error: msg };
  }

  const { data: entryId, error: rpcErr } = await client.rpc('post_journal_entry', {
    p_entry_date:  entryDate,
    p_description: description,
    p_source_type: sourceType,
    p_source_id:   sourceId,
    p_posted_by:   postedBy,
    p_lines:       lines,
  });

  if (rpcErr) {
    await _logError({ sourceType, sourceId, message: rpcErr.message, postedBy, client });
    return { id: null, error: rpcErr.message };
  }

  return { id: entryId, error: null };
}

/**
 * Write a posting failure to accounting_posting_errors.
 * Errors here are swallowed — the table is best-effort.
 */
async function _logError({ sourceType, sourceId, message, postedBy, client }) {
  const { error } = await client
    .from('accounting_posting_errors')
    .insert({
      source_type:  sourceType  ?? null,
      source_id:    sourceId    ?? null,
      error_message: message,
      attempted_by: postedBy    ?? null,
    });
  if (error) {
    console.error('accounting_posting_errors insert failed:', error.message);
  }
}
