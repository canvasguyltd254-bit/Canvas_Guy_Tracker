/**
 * app/api/orders/[id]/pnl/route.js
 *
 * GET /api/orders/:id/pnl
 *
 * Returns all supplier purchases linked to this order (via purchase_order_links)
 * so the P&L tab can compute revenue vs costs and display a gross profit / margin.
 *
 * Response shape:
 * {
 *   purchases: [
 *     {
 *       id, purchase_date, items_bought, total_amount, amount_paid,
 *       supplier: { id, name }
 *     }
 *   ],
 *   totals: {
 *     totalCost:      number,   // SUM(total_amount) across linked purchases
 *     totalPaidAP:    number,   // SUM(amount_paid)  — supplier-side AP info only
 *     outstandingAP:  number,   // totalCost - totalPaidAP
 *   }
 * }
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const orderId = params.id;

    // Verify order exists
    const { data: order } = await serviceClient
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .single();

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // Fetch all supplier purchases linked to this order via junction table
    const { data: links, error } = await serviceClient
      .from('purchase_order_links')
      .select(`
        purchase_id,
        supplier_purchases (
          id,
          purchase_date,
          items_bought,
          total_amount,
          amount_paid,
          suppliers ( id, name )
        )
      `)
      .eq('order_id', orderId);

    if (error) {
      console.error('GET /api/orders/[id]/pnl — query error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch P&L data' }, { status: 500 });
    }

    // Flatten: each link row has a nested supplier_purchases object
    const purchases = (links || [])
      .map(l => l.supplier_purchases)
      .filter(Boolean)
      .map(p => ({
        id:            p.id,
        purchase_date: p.purchase_date,
        items_bought:  p.items_bought,
        total_amount:  parseFloat(p.total_amount || 0),
        amount_paid:   parseFloat(p.amount_paid  || 0),
        supplier:      p.suppliers ? { id: p.suppliers.id, name: p.suppliers.name } : null,
      }));

    const totalCost     = purchases.reduce((s, p) => s + p.total_amount, 0);
    const totalPaidAP   = purchases.reduce((s, p) => s + p.amount_paid,  0);
    const outstandingAP = Math.max(0, totalCost - totalPaidAP);

    return NextResponse.json({
      success: true,
      purchases,
      totals: { totalCost, totalPaidAP, outstandingAP },
    });
  } catch (err) {
    console.error('GET /api/orders/[id]/pnl — unexpected error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
