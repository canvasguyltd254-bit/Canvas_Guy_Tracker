/**
 * app/api/orders/[id]/pnl/route.js
 *
 * GET /api/orders/:id/pnl
 *
 * Returns all supplier purchases linked to this order (via purchase_order_links)
 * so the P&L tab can compute revenue vs costs and display a gross profit / margin.
 *
 * Option B — if a link has a non-null `amount`, that figure is used as the cost
 * allocated to this order. If `amount` is null (legacy links without splits),
 * the full `total_amount` of the purchase is used as a fallback.
 *
 * Response shape:
 * {
 *   purchases: [
 *     {
 *       id, purchase_date, items_bought,
 *       total_amount,     // the ALLOCATED amount (link.amount ?? purchase.total_amount)
 *       purchase_total,   // the FULL purchase total_amount (for display)
 *       allocated_amount, // link.amount (null = not split)
 *       amount_paid,
 *       supplier: { id, name }
 *     }
 *   ],
 *   totals: {
 *     totalCost:      number,   // SUM of allocated amounts across linked purchases
 *     totalPaidAP:    number,   // SUM(amount_paid) — supplier-side AP info only
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

    // Fetch all supplier purchases linked to this order via junction table.
    // Include the per-link `amount` (Option B split-cost allocation).
    const { data: links, error } = await serviceClient
      .from('purchase_order_links')
      .select(`
        purchase_id,
        amount,
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

    // Count total order links per purchase so we can distinguish:
    //   - purchase linked to 1 order with no amount → no overstatement risk, no warning
    //   - purchase linked to N > 1 orders with no amount → full cost counted N times, warn
    const purchaseIds = (links || []).map(l => l.purchase_id).filter(Boolean);
    let linkCountByPurchase = {};
    if (purchaseIds.length > 0) {
      const { data: allLinks } = await serviceClient
        .from('purchase_order_links')
        .select('purchase_id')
        .in('purchase_id', purchaseIds);
      (allLinks || []).forEach(l => {
        linkCountByPurchase[l.purchase_id] = (linkCountByPurchase[l.purchase_id] || 0) + 1;
      });
    }

    // Flatten: each link row has a nested supplier_purchases object.
    // Use link.amount if set (Option B); fall back to p.total_amount for legacy links.
    //
    // is_unallocated = true only when a link has no amount AND the purchase is linked
    // to more than one order — that's when the full cost is being double-counted.
    const purchases = (links || [])
      .filter(l => l.supplier_purchases)
      .map(l => {
        const p = l.supplier_purchases;
        const purchaseTotal   = parseFloat(p.total_amount || 0);
        const isUnallocated   = l.amount == null && (linkCountByPurchase[l.purchase_id] || 1) > 1;
        const allocatedAmount = l.amount == null ? purchaseTotal : parseFloat(l.amount);

        // Prorate the purchase's paid amount by the allocation ratio so AP totals
        // are not duplicated across every order that shares this purchase.
        const ratio          = purchaseTotal > 0 ? allocatedAmount / purchaseTotal : 0;
        const proratedPaid   = parseFloat(p.amount_paid || 0) * ratio;

        return {
          id:               p.id,
          purchase_date:    p.purchase_date,
          items_bought:     p.items_bought,
          total_amount:     allocatedAmount,  // the cost figure used for P&L
          purchase_total:   purchaseTotal,    // full purchase total (for display)
          allocated_amount: l.amount == null ? null : allocatedAmount, // null when no explicit split was set
          is_unallocated:   isUnallocated,    // true = no split set; cost may be overstated
          amount_paid:      proratedPaid,     // prorated share of what's been paid
          supplier:         p.suppliers ? { id: p.suppliers.id, name: p.suppliers.name } : null,
        };
      });

    const totalCost     = purchases.reduce((s, p) => s + p.total_amount, 0);
    const totalPaidAP   = purchases.reduce((s, p) => s + p.amount_paid,  0);
    const outstandingAP = Math.max(0, totalCost - totalPaidAP);

    // Warn the caller when any linked purchase has no allocation amount set.
    // This means the full purchase cost is counted against this order, which
    // overstates costs if the purchase is also linked to other orders.
    const hasUnallocatedPurchases = purchases.some(p => p.is_unallocated);

    return NextResponse.json({
      success: true,
      purchases,
      totals: { totalCost, totalPaidAP, outstandingAP },
      hasUnallocatedPurchases,
    });
  } catch (err) {
    console.error('GET /api/orders/[id]/pnl — unexpected error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
