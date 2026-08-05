/**
 * GET /api/crm/invoices
 *
 * Returns all orders that were converted from quotations — either fully invoiced
 * (invoice_number is set) or pending invoice (awaiting Deposit Paid for non-credit orders).
 *
 * Query params:
 *   customer       — partial match on customer name
 *   invoice        — partial match on invoice_number
 *   quote          — partial match on quote_num
 *   order          — partial match on order_num
 *   vat_mode       — vat_exclusive | vat_inclusive | none
 *   payment_status — unpaid | part_paid | paid
 *   order_status   — exact match on orders.status
 *   date_from      — invoice_issued_at >= (YYYY-MM-DD)
 *   date_to        — invoice_issued_at <= (YYYY-MM-DD)
 *   customer_id    — filter to a specific customer UUID
 *
 * Access: admin, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES_CRM);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const customer    = searchParams.get('customer') || '';
    const invoice     = searchParams.get('invoice') || '';
    const quote       = searchParams.get('quote') || '';
    const order       = searchParams.get('order') || '';
    const vatMode     = searchParams.get('vat_mode') || '';
    const pmtStatus   = searchParams.get('payment_status') || '';
    const orderStatus = searchParams.get('order_status') || '';
    const dateFrom    = searchParams.get('date_from') || '';
    const dateTo      = searchParams.get('date_to') || '';
    const customerId  = searchParams.get('customer_id') || '';

    // All orders that came from a quotation (quote_id is set)
    let q = serviceClient
      .from('orders')
      .select(`
        id, order_num, client, status, total_value, pricing_mode,
        invoice_number, invoice_issued_at, customer_type, payment_terms,
        customer_id, quote_id,
        customers ( id, name, email, phone ),
        order_payments ( id, amount, reversed_at ),
        order_items ( id, quantity ),
        delivery_batches (
          id, batch_number, status, deleted_at, actual_delivery_date,
          delivery_batch_items ( quantity_delivered )
        )
      `)
      .not('quote_id', 'is', null)
      .order('invoice_issued_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    // ── Filters ────────────────────────────────────────────────────────────────
    if (customerId)    q = q.eq('customer_id', customerId);
    if (orderStatus)   q = q.eq('status', orderStatus);
    if (vatMode)       q = q.eq('pricing_mode', vatMode);
    if (invoice)       q = q.ilike('invoice_number', `%${invoice}%`);
    if (order)         q = q.ilike('order_num', `%${order}%`);
    // Date filters: include pending invoices (invoice_issued_at IS NULL) regardless of range,
    // so "pending invoice" orders always appear even when a date range is applied.
    // Both bounds must be combined with AND (not OR) to properly constrain the range.
    if (dateFrom && dateTo) {
      q = q.or(`and(invoice_issued_at.gte.${dateFrom},invoice_issued_at.lte.${dateTo}T23:59:59),invoice_issued_at.is.null`);
    } else if (dateFrom) {
      q = q.or(`invoice_issued_at.gte.${dateFrom},invoice_issued_at.is.null`);
    } else if (dateTo) {
      q = q.or(`invoice_issued_at.lte.${dateTo}T23:59:59,invoice_issued_at.is.null`);
    }

    const { data: rows, error } = await q;
    if (error) {
      console.error('GET /api/crm/invoices error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch invoices' }, { status: 500 });
    }

    // Fetch quote data separately to avoid ambiguous FK join
    const quoteIds = [...new Set((rows || []).map(r => r.quote_id).filter(Boolean))];
    let quotesMap = {};
    if (quoteIds.length > 0) {
      const { data: quotes, error: quotesError } = await serviceClient
        .from('quotations')
        .select('id, quote_num, revision, quote_group_id')
        .in('id', quoteIds);
      if (quotesError) {
        console.error('GET /api/crm/invoices — quotations fetch error:', quotesError.message);
        return NextResponse.json({ error: 'Failed to fetch invoice quote details' }, { status: 500 });
      }
      for (const qt of (quotes || [])) quotesMap[qt.id] = qt;
    }

    // ── Post-query filters (needs joined data) ─────────────────────────────────
    let invoices = (rows || []).map(order => {
      const quote        = quotesMap[order.quote_id] || null;
      const payments     = order.order_payments || [];
      const items        = order.order_items || [];
      const batches      = order.delivery_batches || [];

      const totalPaid    = payments
        .filter(p => !p.reversed_at)
        .reduce((s, p) => s + Number(p.amount), 0);

      const balance      = Math.max(0, Number(order.total_value) - totalPaid);

      const totalUnits   = items.reduce((s, i) => s + (i.quantity || 0), 0);

      // Non-deleted batches only (soft-delete guard, fix 3)
      const liveBatches = batches.filter(b => !b.deleted_at);

      // Batch statuses that represent confirmed delivery (fix 2: Signed is a valid DB status)
      const DELIVERED_BATCH_STATUSES = new Set(['Delivered', 'Signed']);

      let deliveredUnits;
      if (liveBatches.length === 0) {
        // Standard (non-batch) order: only fully delivered at Delivered or Closed (fix 1)
        const FULLY_DELIVERED = new Set(['Delivered', 'Closed']);
        deliveredUnits = FULLY_DELIVERED.has(order.status) ? totalUnits : 0;
      } else {
        // Batch order: sum quantity_delivered from confirmed-status, non-deleted batches (fix 2, 3, 7)
        deliveredUnits = liveBatches
          .filter(b => DELIVERED_BATCH_STATUSES.has(b.status))
          .flatMap(b => b.delivery_batch_items || [])
          .reduce((s, i) => s + (i.quantity_delivered || 0), 0);
      }

      // Determine payment status
      let computedPmtStatus;
      if (totalPaid <= 0)                                   computedPmtStatus = 'unpaid';
      else if (balance < 0.5)                               computedPmtStatus = 'paid';
      else                                                  computedPmtStatus = 'part_paid';

      return {
        id:               order.id,
        order_num:        order.order_num,
        status:           order.status,
        total_value:      Number(order.total_value),
        pricing_mode:     order.pricing_mode,
        invoice_number:   order.invoice_number,
        invoice_issued_at: order.invoice_issued_at,
        customer_type:    order.customer_type,
        payment_terms:    order.payment_terms,
        customer_id:      order.customer_id,
        customer_name:    order.customers?.name || order.client,
        customer:         order.customers,
        quote_num:        quote?.quote_num,
        quote_id:         quote?.id,
        quote_group_id:   quote?.quote_group_id,
        quote_revision:   quote?.revision,
        total_paid:       totalPaid,
        balance,
        payment_status:   computedPmtStatus,
        total_units:      totalUnits,
        delivered_units:  deliveredUnits,
        // "Pending Invoice" = converted order without invoice yet (non-credit awaiting deposit)
        pending_invoice:  !order.invoice_number,
      };
    });

    // Filter by customer name (client-side join)
    if (customer) {
      const q = customer.toLowerCase();
      invoices = invoices.filter(i =>
        i.customer_name?.toLowerCase().includes(q)
      );
    }

    // Filter by quote_num
    if (quote) {
      const q = quote.toLowerCase();
      invoices = invoices.filter(i =>
        i.quote_num?.toLowerCase().includes(q)
      );
    }

    // Filter by payment status (computed)
    if (pmtStatus) {
      invoices = invoices.filter(i => i.payment_status === pmtStatus);
    }

    return NextResponse.json({ invoices, total: invoices.length });
  } catch (err) {
    console.error('GET /api/crm/invoices unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
