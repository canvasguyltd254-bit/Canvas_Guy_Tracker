export const runtime = 'nodejs';

/**
 * POST /api/crm/quotations/[id]/convert
 *
 * Converts an accepted quotation to a new order via the atomic
 * convert_quote_to_order() PostgreSQL RPC (Migration F).
 *
 * The RPC now handles everything in one transaction:
 *   - Creates the order using the negotiated quote.payment_terms
 *   - Copies VAT-snapshotted items to order_items
 *   - Marks the enquiry won
 *   - For credit orders: posts the invoice GL atomically so the order
 *     is never left without an invoice journal
 *
 * The quotation must have status = 'accepted' and a linked customer_id.
 * Idempotent: if already converted, returns the existing order_id.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { data: orderId, error: rpcErr } = await serviceClient.rpc(
      'convert_quote_to_order',
      { p_quote_id: params.id, p_created_by: user.id },
    );

    if (rpcErr) {
      // Log full error so the DB-level message is visible in server logs
      console.error('convert_quote_to_order RPC error:', JSON.stringify(rpcErr, null, 2));

      // Map known exception codes to user-friendly messages
      const msg = rpcErr.message || '';
      if (msg.includes('QUOTE_NOT_FOUND'))     return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
      if (msg.includes('QUOTE_NOT_ACCEPTED'))  return NextResponse.json({ error: 'Quotation must be in Accepted status before converting' }, { status: 422 });
      if (msg.includes('QUOTE_NO_CUSTOMER'))   return NextResponse.json({ error: 'Quotation must have a linked customer before converting' }, { status: 422 });
      if (msg.includes('CUSTOMER_NOT_FOUND'))  return NextResponse.json({ error: 'Linked customer not found' }, { status: 422 });
      if (msg.includes('ACCOUNT_NOT_FOUND'))   return NextResponse.json({ error: 'Chart of accounts is incomplete — contact your administrator' }, { status: 500 });

      return NextResponse.json({ error: 'Failed to convert quotation to order' }, { status: 500 });
    }

    // Fetch the created/existing order for the response
    const { data: order } = await serviceClient
      .from('orders')
      .select('id, order_num, status, total_value, customer_type, payment_terms, invoice_number, invoice_journal_entry_id')
      .eq('id', orderId)
      .single();

    return NextResponse.json({ data: { order_id: orderId, order } });
  } catch (err) {
    console.error('POST /api/crm/quotations/[id]/convert:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
