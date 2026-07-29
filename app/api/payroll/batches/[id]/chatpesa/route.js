/**
 * GET /api/payroll/batches/:id/chatpesa
 *
 * Returns a 9-column Chatpesa CSV for bulk M-Pesa payments.
 * Exports ONLY the entries linked to this batch (via payroll_batch_entry_links),
 * not every unpaid entry in the run.
 *
 * Column order (verified against Canvas Guy's confirmed working files):
 * 1. Type               — lowercase "mpesa"
 * 2. Amount             — plain integer, no commas, no decimals
 * 3. Account/Phone      — 9-digit format, no leading zero (e.g. 794622761)
 * 4. Paybill Number     — blank for mpesa
 * 5. Bank Paybill Number — blank
 * 6. Airtime Vendor     — blank
 * 7. Recipient Name     — MUST be blank for mpesa (causes rejection if set)
 * 8. Description        — mandatory, never blank, NO quotes (quoted = rejected)
 * 9. SMS Number         — same phone number repeated
 *
 * Header row is required, verbatim column names.
 * No double-quotes anywhere in the file.
 *
 * Access: admin only
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const batchId = params.id;

    // Fetch batch + linked run
    const { data: batch } = await serviceClient
      .from('payroll_payment_batches')
      .select('*, payroll_runs(run_num, period_start, period_end)')
      .eq('id', batchId)
      .single();

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    if (batch.status === 'reconciled') {
      return NextResponse.json({ error: 'Batch already reconciled — CSV would re-export paid rows' }, { status: 409 });
    }

    // Fetch entries linked to THIS batch (not all run entries)
    const { data: links, error: linkErr } = await serviceClient
      .from('payroll_batch_entry_links')
      .select('amount, payroll_entries(id, snapshot_name, net_pay, amount_paid, payment_status, employees(phone))')
      .eq('batch_id', batchId)
      .order('payroll_entries(snapshot_name)');

    if (linkErr) {
      return NextResponse.json({ error: 'Failed to fetch batch entries' }, { status: 500 });
    }

    if (!links?.length) {
      return NextResponse.json({ error: 'No entries linked to this batch' }, { status: 400 });
    }

    const runRef = batch.payroll_runs?.run_num || batchId.slice(0, 8);

    // Build CSV rows
    const csvRows = [];

    // Header row — required by Chatpesa, verbatim column names
    csvRows.push('Type,Amount,Account/Phone,Paybill Number,Bank Paybill Number,Airtime Vendor,Recipient Name,Description,SMS Number');

    let rowCount = 0;
    const exportedEntryIds  = [];   // entries successfully included in the CSV
    const skippedEntryNames = [];   // entries skipped (no phone) — logged for visibility

    for (const link of links) {
      const entry   = link.payroll_entries;
      if (!entry) continue;

      // Use live remaining balance (not the batch snapshot) in case of partial prior payments
      const remaining = Number(entry.net_pay) - Number(entry.amount_paid);
      // Use the lesser of the snapshotted batch amount and the live remaining balance
      const amount = Math.min(link.amount, remaining);
      if (amount <= 0.01) continue;  // already paid since batch was created

      const phone = normalisePhone(entry.employees?.phone || '');
      if (!phone) {
        console.warn(`CSV export: entry ${entry.id} (${entry.snapshot_name}) has no phone — skipped`);
        skippedEntryNames.push(entry.snapshot_name || entry.id);
        continue;
      }

      const name = (entry.snapshot_name || '').replace(/,/g, ' ');   // no commas — no quoting allowed
      const desc = `${name} - ${runRef}`;

      csvRows.push([
        'mpesa',                  // 1. Type — lowercase, exact spelling
        Math.round(amount),       // 2. Amount — plain integer
        phone,                    // 3. Account/Phone — 9-digit, no leading zero
        '',                       // 4. Paybill Number — blank for mpesa
        '',                       // 5. Bank Paybill Number — blank
        '',                       // 6. Airtime Vendor — blank
        '',                       // 7. Recipient Name — MUST be blank for mpesa
        desc,                     // 8. Description — no quotes, mandatory
        phone,                    // 9. SMS Number — repeat phone
      ].join(','));

      exportedEntryIds.push(entry.id);
      rowCount++;
    }

    if (rowCount === 0) {
      return NextResponse.json({ error: 'All entries in this batch are already paid or missing phone numbers' }, { status: 400 });
    }

    const csv      = csvRows.join('\n');
    const filename = `chatpesa_${batch.batch_num}_${new Date().toISOString().slice(0, 10)}.csv`;

    // Mark batch as exported; store which entries were included so reconciliation
    // only creates payment records for those (not for skipped no-phone entries).
    await serviceClient
      .from('payroll_payment_batches')
      .update({
        status:              'exported',
        exported_at:         new Date().toISOString(),
        exported_entry_ids:  exportedEntryIds,
      })
      .eq('id', batchId);

    const skipNote = skippedEntryNames.length > 0
      ? `. ${skippedEntryNames.length} skipped (no phone): ${skippedEntryNames.join(', ')}`
      : '';
    await serviceClient.from('payroll_activities').insert({
      entity_type:   'batch',
      entity_id:     batchId,
      activity_type: 'exported',
      description:   `Chatpesa CSV exported for batch ${batch.batch_num} (${rowCount} payments)${skipNote}`,
      created_by:    user.id,
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type':        'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'no-store',
      },
    });
  } catch (err) {
    console.error('GET /api/payroll/batches/[id]/chatpesa unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Normalise phone to 9-digit format WITHOUT leading zero (e.g. 794622761).
// Chatpesa's confirmed working format from Canvas Guy files — no leading zero.
function normalisePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  // +254 format (12 digits) → drop country code
  if (digits.startsWith('254') && digits.length === 12) {
    return digits.slice(3);           // 254794622761 → 794622761
  }
  // Leading zero (10 digits) → drop the 0
  if (digits.startsWith('0') && digits.length === 10) {
    return digits.slice(1);           // 0794622761 → 794622761
  }
  // Already 9-digit — return as-is
  if (digits.length === 9) return digits;
  // Unexpected format — return empty so the row is skipped
  return '';
}
