/**
 * GET /api/crm/invoices/[id]
 *
 * Full invoice detail for a given order (id = order.id).
 *
 * Returns 6 sections:
 *   1. invoice         — invoice + order summary fields
 *   2. vatBreakdown    — snapshotted amounts from the quotation (never recalculated)
 *   3. quoteHistory    — all revisions in the same quote_group_id
 *   4. trackerProgress — order stages with timestamps from order_activities
 *   5. deliveryHistory — batches (with items) for batch orders; simple event for standard
 *   6. paymentHistory  — payments with running balance; reversed payments visible, don't reduce balance
 *
 * Access: admin, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// Fix 5: current full stage list including post-delivery statuses
const ORDER_STAGES = [
  'Quote Approved',
  'Deposit Paid',
  'Material Check',
  'Production',
  'Quality Control',
  'Ready for Delivery',
  'Partially Delivered',
  'Delivered',
  'Closed',
];

// Batch statuses that count as confirmed delivery progress.
// 'Signed' is the DB status for a customer-signed batch; 'Partially Delivered' is an ORDER status, not a batch status.
const DELIVERED_BATCH_STATUSES = new Set(['Delivered', 'Signed']);

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES_CRM);
    if (authError) return authError;

    const orderId = params.id;

    // ── 1. Order + customer ───────────────────────────────────────────────────
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select(`
        id, order_num, client, contact_person, status, total_value,
        pricing_mode, invoice_number, invoice_issued_at, invoice_journal_entry_id,
        customer_type, payment_terms, payment_due_date,
        batch_delivery, deliverable_units, due_date,
        customer_id, quote_id,
        customers ( id, name, email, phone )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (!order.quote_id) {
      return NextResponse.json({ error: 'This order was not converted from a quotation' }, { status: 400 });
    }

    // ── 2. Quotation (for VAT breakdown + quote info) ─────────────────────────
    // Fix 8: surface quotation fetch error
    const { data: quote, error: quoteErr } = await serviceClient
      .from('quotations')
      .select(`
        id, quote_num, revision, quote_group_id, status, pricing_mode,
        tax_status, subtotal, vat_amount, total, payment_terms,
        customer_id,
        quote_items (
          id, description, category, quantity, unit_price, net_amount,
          vat_amount, gross_amount, finish_type, finish_color, wood_type, sort_order
        )
      `)
      .eq('id', order.quote_id)
      .single();

    if (quoteErr) {
      console.error('GET /api/crm/invoices/[id] quote fetch error:', quoteErr.message);
      return NextResponse.json({ error: `Failed to fetch quotation: ${quoteErr.message}` }, { status: 500 });
    }

    // ── 3. Quote history — all revisions in the same quote_group_id ───────────
    let quoteHistory = [];
    if (quote?.quote_group_id) {
      const { data: revisions, error: revErr } = await serviceClient
        .from('quotations')
        .select(`
          id, quote_num, revision, status, pricing_mode, tax_status,
          subtotal, vat_amount, total, payment_terms, created_at,
          converted_order_id
        `)
        .eq('quote_group_id', quote.quote_group_id)
        .order('revision', { ascending: true });

      if (revErr) {
        console.error('GET /api/crm/invoices/[id] revision fetch error:', revErr.message);
      }
      quoteHistory = revisions || [];
    }

    // ── 4. Tracker progress — stage timestamps from order_activities ──────────
    // Fix 8: check error
    const { data: activities, error: actErr } = await serviceClient
      .from('order_activities')
      .select('id, activity_type, description, created_at, created_by')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });

    if (actErr) {
      console.error('GET /api/crm/invoices/[id] activities fetch error:', actErr.message);
    }

    // Map each stage to the FIRST matching status_change activity
    // Status changes are logged as activity_type='status_change' with the new status in description
    const stageTimestamps = {};
    for (const stage of ORDER_STAGES) {
      const match = (activities || []).find(a =>
        a.activity_type === 'status_change' && (
          a.description?.includes(`Status changed to: ${stage}`) ||
          a.description?.includes(`to ${stage}`)
        )
      );
      if (match) stageTimestamps[stage] = match.created_at;
    }

    // Fix 5: full stage list
    const trackerProgress = ORDER_STAGES.map(stage => ({
      stage,
      reached_at: stageTimestamps[stage] || null,
      is_current: order.status === stage,
    }));

    // ── 5. Delivery history ───────────────────────────────────────────────────
    // Fix 8: check batch fetch errors
    let deliveryHistory = [];

    if (order.batch_delivery) {
      // Batch orders: full batch breakdown with gross line values.
      // Fetch delivery_batch_items and order_items separately to avoid
      // triple-nested PostgREST embeds (batches → items → order_items) which cause 500s.
      const { data: batches, error: batchErr } = await serviceClient
        .from('delivery_batches')
        .select('id, batch_number, status, actual_delivery_date, created_at')
        .eq('order_id', orderId)
        .is('deleted_at', null)
        .order('batch_number', { ascending: true });

      if (batchErr) {
        console.error('GET /api/crm/invoices/[id] batch fetch error:', batchErr.message);
        return NextResponse.json({ error: 'Failed to fetch delivery data' }, { status: 500 });
      }

      const detailBatchIds = (batches || []).map(b => b.id);
      let detailBatchItemsMap = {}; // batch_id → [items with order_item joined]
      if (detailBatchIds.length > 0) {
        const { data: batchItems, error: batchItemsErr } = await serviceClient
          .from('delivery_batch_items')
          .select('id, batch_id, order_item_id, quantity_planned, quantity_delivered, quantity_rejected')
          .in('batch_id', detailBatchIds);
        if (batchItemsErr) {
          console.error('GET /api/crm/invoices/[id] batch items fetch error:', batchItemsErr.message);
          return NextResponse.json({ error: 'Failed to fetch delivery batch items' }, { status: 500 });
        }

        const orderItemIds = [...new Set((batchItems || []).map(i => i.order_item_id).filter(Boolean))];
        let orderItemsMap = {};
        if (orderItemIds.length > 0) {
          const { data: orderItems, error: oiErr } = await serviceClient
            .from('order_items')
            .select('id, description, category, unit_price, quantity, gross_amount')
            .in('id', orderItemIds);
          if (oiErr) {
            console.error('GET /api/crm/invoices/[id] order items fetch error:', oiErr.message);
            return NextResponse.json({ error: 'Failed to fetch order item details' }, { status: 500 });
          }
          for (const oi of (orderItems || [])) orderItemsMap[oi.id] = oi;
        }

        for (const item of (batchItems || [])) {
          if (!detailBatchItemsMap[item.batch_id]) detailBatchItemsMap[item.batch_id] = [];
          detailBatchItemsMap[item.batch_id].push({ ...item, order_items: orderItemsMap[item.order_item_id] || null });
        }
      }

      deliveryHistory = (batches || []).map(batch => {
        const items = detailBatchItemsMap[batch.id] || [];

        // Fix 4: use gross unit value (gross_amount ÷ quantity) so VAT + discounts are correct
        // Fix 7: only count quantities from confirmed-delivery batches toward value
        const isDeliveredBatch = DELIVERED_BATCH_STATUSES.has(batch.status);

        const batchValue = items.reduce((s, i) => {
          const oi = i.order_items;
          if (!oi) return s;
          const grossUnit = oi.gross_amount != null && Number(oi.quantity) > 0
            ? Number(oi.gross_amount) / Number(oi.quantity)
            : Number(oi.unit_price || 0);
          const delivered = isDeliveredBatch ? (i.quantity_delivered || 0) : 0;
          return s + delivered * grossUnit;
        }, 0);

        return {
          batch_id:             batch.id,
          batch_number:         batch.batch_number,
          status:               batch.status,
          actual_delivery_date: batch.actual_delivery_date,
          created_at:           batch.created_at,
          batch_value:          batchValue,
          // Fix 7: only include delivery progress for confirmed batches
          counts_toward_progress: isDeliveredBatch,
          items: items.map(i => {
            const oi = i.order_items;
            const grossUnit = oi && oi.gross_amount != null && Number(oi.quantity) > 0
              ? Number(oi.gross_amount) / Number(oi.quantity)
              : Number(oi?.unit_price || 0);
            return {
              description:        oi?.description || '—',
              category:           oi?.category,
              quantity_planned:   i.quantity_planned,
              quantity_delivered: i.quantity_delivered,
              quantity_rejected:  i.quantity_rejected,
              gross_unit:         grossUnit,
              line_value:         (i.quantity_delivered || 0) * grossUnit,
            };
          }),
        };
      });
    } else {
      // Standard orders: single delivery event from activities / order status
      // Fix 6: non-batch Delivered/Closed = all units delivered
      const deliveryActivity = (activities || []).find(a =>
        a.activity_type === 'status_change' && (
          a.description?.includes('Delivered') ||
          a.description?.includes('Delivery') ||
          a.description?.includes('Closed')
        )
      );

      // Only Delivered and Closed mean all units are fully delivered for non-batch orders
      const FULLY_DELIVERED_STATUSES = new Set(['Delivered', 'Closed']);
      if (FULLY_DELIVERED_STATUSES.has(order.status) || deliveryActivity) {
        deliveryHistory = [{
          batch_id:             null,
          batch_number:         null,
          status:               order.status,
          actual_delivery_date: deliveryActivity?.created_at?.split('T')[0] || null,
          created_at:           deliveryActivity?.created_at || null,
          batch_value:          Number(order.total_value),
          counts_toward_progress: true,
          items:                [],
        }];
      }
    }

    // ── 6. Payment history — with running balance ─────────────────────────────
    // Fix 8: check payment fetch error
    const { data: pmtRows, error: pmtErr } = await serviceClient
      .from('order_payments')
      .select('id, amount, payment_date, description, reversed_at, journal_entry_id, created_at')
      .eq('order_id', orderId)
      .order('payment_date', { ascending: true })
      .order('created_at', { ascending: true });

    if (pmtErr) {
      console.error('GET /api/crm/invoices/[id] payment fetch error:', pmtErr.message);
      return NextResponse.json({ error: 'Failed to fetch payment data' }, { status: 500 });
    }

    const totalValue = Number(order.total_value);
    let runningBalance = totalValue;
    const paymentHistory = (pmtRows || []).map(p => {
      const isReversed = !!p.reversed_at;
      const amount = Number(p.amount);
      // Reversed payments do NOT reduce the running balance
      if (!isReversed) runningBalance -= amount;

      return {
        id:               p.id,
        payment_date:     p.payment_date,
        description:      p.description,
        amount,
        is_reversed:      isReversed,
        reversed_at:      p.reversed_at,
        running_balance:  isReversed ? null : runningBalance,
        journal_entry_id: p.journal_entry_id,
      };
    });

    const totalPaid = (pmtRows || [])
      .filter(p => !p.reversed_at)
      .reduce((s, p) => s + Number(p.amount), 0);

    // ── VAT breakdown (always from snapshotted quote) ─────────────────────────
    const vatBreakdown = quote ? {
      pricing_mode: quote.pricing_mode,
      tax_status:   quote.tax_status,
      subtotal:     Number(quote.subtotal || 0),
      vat_amount:   Number(quote.vat_amount || 0),
      total:        Number(quote.total || 0),
      items:        (quote.quote_items || [])
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
        .map(i => ({
          description:  i.description,
          category:     i.category,
          quantity:     i.quantity,
          unit_price:   Number(i.unit_price || 0),
          net_amount:   Number(i.net_amount || 0),
          vat_amount:   Number(i.vat_amount || 0),
          gross_amount: Number(i.gross_amount || 0),
          finish_type:  i.finish_type,
          finish_color: i.finish_color,
          wood_type:    i.wood_type,
        })),
    } : null;

    // ── Assemble invoice summary ──────────────────────────────────────────────
    const invoice = {
      order_id:             order.id,
      order_num:            order.order_num,
      invoice_number:       order.invoice_number,
      invoice_issued_at:    order.invoice_issued_at,
      pending_invoice:      !order.invoice_number,
      status:               order.status,
      total_value:          totalValue,
      pricing_mode:         order.pricing_mode,
      customer_type:        order.customer_type,
      payment_terms:        order.payment_terms,
      payment_due_date:     order.payment_due_date,
      due_date:             order.due_date,
      batch_delivery:       order.batch_delivery,
      client:               order.client,
      contact_person:       order.contact_person,
      customer:             order.customers,
      quote_id:             order.quote_id,
      quote_num:            quote?.quote_num,
      quote_revision:       quote?.revision,
      total_paid:           totalPaid,
      balance:              Math.max(0, totalValue - totalPaid),
      payment_status:       totalPaid <= 0
                              ? 'unpaid'
                              : Math.max(0, totalValue - totalPaid) < 0.5
                                ? 'paid'
                                : 'part_paid',
    };

    return NextResponse.json({
      invoice,
      vatBreakdown,
      quoteHistory,
      trackerProgress,
      deliveryHistory,
      paymentHistory,
    });
  } catch (err) {
    console.error('GET /api/crm/invoices/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
