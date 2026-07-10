/**
 * app/api/chatpesa/transactions/route.js
 *
 * GET /api/chatpesa/transactions
 *   ?status=unmatched|partial|matched|ignored|credit|refund|all
 *   ?import_id=uuid
 *   ?search=text
 *   ?limit=100
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const status   = searchParams.get('status')    || 'all';
    const importId = searchParams.get('import_id');
    const search   = searchParams.get('search')    || '';
    const limit    = Math.min(parseInt(searchParams.get('limit') || '200', 10), 500);

    let query = serviceClient
      .from('chatpesa_transactions')
      .select(`
        id, chatpesa_id, tx_type, match_status, source,
        account_name, account_number, description, confirm_code,
        amount, transaction_date, transaction_time,
        suggested_supplier_id, suggested_confidence, import_id,
        matched_at, ignored_at,
        suggested_supplier:suppliers!suggested_supplier_id(id, name),
        chatpesa_payment_allocations(id, allocation_type, amount, petty_cash_category,
          supplier_purchase:supplier_purchases(id, items_bought),
          supplier:suppliers!supplier_id(id, name)
        )
      `)
      .order('transaction_date', { ascending: false })
      .order('chatpesa_id', { ascending: false })
      .limit(limit);

    if (status !== 'all') query = query.eq('match_status', status);
    if (importId)         query = query.eq('import_id', importId);

    const { data, error } = await query;

    if (error) {
      console.error('GET /api/chatpesa/transactions:', error);
      return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
    }

    let results = data || [];

    // Client-side search (description, account_name)
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(tx =>
        [tx.account_name, tx.description, tx.confirm_code]
          .filter(Boolean).join(' ').toLowerCase().includes(q)
      );
    }

    return NextResponse.json({ success: true, data: results, total: results.length });
  } catch (err) {
    console.error('GET /api/chatpesa/transactions:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
