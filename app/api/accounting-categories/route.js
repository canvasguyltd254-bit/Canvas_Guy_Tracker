/**
 * app/api/accounting-categories/route.js
 *
 * GET /api/accounting-categories
 *   ?for_purchases=true   — categories usable on purchases (expense accounts)
 *   ?for_petty_cash=true  — categories usable for petty-cash Chatpesa allocations
 *   (no params)           — returns all categories
 *
 * Any authenticated user can read categories.
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
    const forPurchases = searchParams.get('for_purchases');
    const forPettyCash = searchParams.get('for_petty_cash');

    let query = serviceClient
      .from('accounting_categories')
      .select('id, label, account_id, for_purchases, for_petty_cash')
      .order('label', { ascending: true });

    if (forPurchases === 'true') query = query.eq('for_purchases',  true);
    if (forPettyCash === 'true') query = query.eq('for_petty_cash', true);

    const { data, error } = await query;

    if (error) {
      console.error('GET /api/accounting-categories:', error);
      return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('GET /api/accounting-categories:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
