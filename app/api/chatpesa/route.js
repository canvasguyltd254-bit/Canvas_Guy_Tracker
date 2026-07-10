/**
 * app/api/chatpesa/route.js
 *
 * GET  /api/chatpesa  — list all import sessions (most recent first)
 * POST /api/chatpesa  — import a parsed Chatpesa CSV (JSON body)
 *
 * Body for POST:
 * {
 *   meta: { accountRef, accountName, statementFrom, statementTo, reconciliationWeek },
 *   rows: [{ chatpesaId, txType, source, sourceId, accountName, accountNumber,
 *             description, confirmCode, amount, balanceAfter, transactionDate, transactionTime }]
 * }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { findBestSupplierMatch } from '@/shared/lib/fuzzy';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function GET() {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('chatpesa_imports')
      .select('*')
      .order('uploaded_at', { ascending: false });

    if (error) {
      console.error('GET /api/chatpesa:', error);
      return NextResponse.json({ error: 'Failed to fetch imports' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('GET /api/chatpesa:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { meta = {}, rows = [] } = body;
    if (!rows.length) return NextResponse.json({ error: 'No rows to import' }, { status: 400 });

    // 1. Load existing chatpesa_ids for duplicate detection
    const incomingIds = rows.map(r => r.chatpesaId).filter(Boolean);
    const { data: existingRows } = await serviceClient
      .from('chatpesa_transactions')
      .select('chatpesa_id')
      .in('chatpesa_id', incomingIds);

    const existingSet = new Set((existingRows || []).map(r => String(r.chatpesa_id)));

    // 2. Load suppliers for fuzzy matching
    const { data: suppliers } = await serviceClient
      .from('suppliers')
      .select('id, name');

    // 3. Classify rows and skip duplicates
    let debitCount = 0, creditCount = 0, refundCount = 0, dupCount = 0;
    let totalDebits = 0;
    const toInsert = [];

    for (const row of rows) {
      const idStr = String(row.chatpesaId);
      if (existingSet.has(idStr)) { dupCount++; continue; }

      // Determine type
      const rawType = (row.txType || '').toLowerCase();
      const source  = (row.source  || '').toLowerCase();
      let txType, matchStatus;

      if (rawType === 'credit') {
        if (source.includes('refund')) {
          txType = 'refund'; matchStatus = 'refund'; refundCount++;
        } else {
          txType = 'credit'; matchStatus = 'credit'; creditCount++;
        }
      } else {
        txType = 'debit'; matchStatus = 'unmatched'; debitCount++;
        totalDebits += parseFloat(row.amount || 0);
      }

      // Fuzzy supplier suggestion (debits only)
      let suggestedSupplierId = null;
      let suggestedConfidence = null;
      if (txType === 'debit' && row.accountName && suppliers?.length) {
        const match = findBestSupplierMatch(row.accountName, suppliers);
        if (match) {
          suggestedSupplierId = match.id;
          suggestedConfidence = match.score / 100;
        }
      }

      toInsert.push({
        chatpesa_id:          parseInt(row.chatpesaId, 10),
        tx_type:              txType,
        match_status:         matchStatus,
        source:               row.source      || null,
        source_id:            row.sourceId    || null,
        account_name:         row.accountName || null,
        account_number:       row.accountNumber || null,
        description:          row.description || null,
        confirm_code:         row.confirmCode || null,
        amount:               parseFloat(row.amount) || 0,
        balance_after:        row.balanceAfter ? parseFloat(row.balanceAfter) : null,
        transaction_date:     row.transactionDate,
        transaction_time:     row.transactionTime || null,
        suggested_supplier_id: suggestedSupplierId,
        suggested_confidence:  suggestedConfidence,
      });
    }

    if (!toInsert.length && dupCount > 0) {
      return NextResponse.json({
        success: true,
        imported: 0,
        duplicates: dupCount,
        message: 'All rows already imported — no new transactions.',
      });
    }

    // 4. Create the import session record
    const { data: importRecord, error: importError } = await serviceClient
      .from('chatpesa_imports')
      .insert({
        uploaded_by:        user.id,
        statement_from:     meta.statementFrom || null,
        statement_to:       meta.statementTo   || null,
        account_ref:        meta.accountRef    || null,
        account_name:       meta.accountName   || null,
        reconciliation_week: meta.reconciliationWeek || null,
        row_count:          toInsert.length,
        debit_count:        debitCount,
        credit_count:       creditCount,
        refund_count:       refundCount,
        duplicate_count:    dupCount,
        total_debits:       totalDebits,
      })
      .select()
      .single();

    if (importError) {
      console.error('POST /api/chatpesa — import insert:', importError);
      return NextResponse.json({ error: 'Failed to create import record' }, { status: 500 });
    }

    // 5. Insert transactions (batch of 500 max)
    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH).map(r => ({ ...r, import_id: importRecord.id }));
      const { error: txError } = await serviceClient.from('chatpesa_transactions').insert(batch);
      if (txError) {
        console.error('POST /api/chatpesa — tx insert:', txError);
        return NextResponse.json({ error: 'Failed to insert transactions' }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      importId:   importRecord.id,
      imported:   toInsert.length,
      debits:     debitCount,
      credits:    creditCount,
      refunds:    refundCount,
      duplicates: dupCount,
      message:    `Imported ${toInsert.length} transactions (${dupCount} duplicates skipped).`,
    }, { status: 201 });

  } catch (err) {
    console.error('POST /api/chatpesa:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
