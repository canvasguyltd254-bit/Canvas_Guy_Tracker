/**
 * GET /api/crm/invoices/[id]/pdf
 *
 * Generates a comprehensive invoice PDF for a quote-converted order.
 * Passes all 6 sections to run_report.js (crmInvoice branch):
 *   1. invoice summary
 *   2. VAT breakdown (snapshotted from quotation)
 *   3. quote revision history
 *   4. tracker progress (stage timestamps)
 *   5. delivery history
 *   6. payment history (including reversed)
 *
 * Access: admin, head_of_sales, sales
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';
import { buildInvoiceBreakdown, loadInvoiceAdjustments } from '@/shared/lib/invoiceLines';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

const ORDER_STAGES = [
  'Quote Approved', 'Deposit Paid', 'Material Check', 'Production',
  'Quality Control', 'Ready for Delivery', 'Partially Delivered', 'Delivered', 'Closed',
];
const DELIVERED_BATCH_STATUSES = new Set(['Delivered', 'Signed']);

function spawnPdf(data) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'run_report.js');
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = []; const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('close', code => {
      if (code !== 0) reject(new Error(Buffer.concat(err).toString() || 'PDF generation failed'));
      else            resolve(Buffer.concat(out));
    });
    child.on('error', e => reject(new Error(`Failed to spawn PDF process: ${e.message}`)));
    child.stdin.write(JSON.stringify(data), 'utf8');
    child.stdin.end();
  });
}

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const orderId = params.id;

    // ── 1. Order + customer ────────────────────────────────────────────────────
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select(`
        id, order_num, client, contact_person, status, total_value,
        pricing_mode, tax_status, invoice_number, invoice_issued_at,
        customer_type, payment_terms, payment_due_date,
        batch_delivery, deliverable_units, due_date,
        customer_id, quote_id, quote_number,
        customers ( id, name, email, phone, tax_status )
      `)
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }
    if (!order.invoice_number) {
      return NextResponse.json({ error: 'Invoice has not yet been issued for this order' }, { status: 400 });
    }

    // ── 2. Quotation (provenance only — lines come from order_items) ──────────────────────────────────
    // Direct orders (no quote_id) skip this; vatBreakdown is built from order_items instead.
    let quote = null;
    if (order.quote_id) {
      const { data: quoteData, error: quoteErr } = await serviceClient
        .from('quotations')
        .select(`
          id, quote_num, revision, quote_group_id, status, pricing_mode,
          tax_status, subtotal, vat_amount, total, payment_terms
        `)
        .eq('id', order.quote_id)
        .single();

      if (quoteErr) {
        console.error('pdf/route.js quote fetch:', quoteErr.message);
        return NextResponse.json({ error: 'Failed to fetch quotation data' }, { status: 500 });
      }
      quote = quoteData;
    }

    // ── 2b. Invoice lines — ALWAYS from current order_items (same helper as the screen) ──
    // Use the historical order snapshot first; fall back to live customer record.
    const taxStatus = order.tax_status || order.customers?.tax_status || 'taxable';

    const { data: currentItems, error: oiErr } = await serviceClient
      .from('order_items')
      .select('id, description, category, line_type, quantity, unit_price, net_amount, vat_amount, gross_amount, finish_type, finish_color, wood_type, sort_order')
      .eq('order_id', orderId)
      .order('sort_order', { ascending: true });

    if (oiErr) {
      console.error('Invoice PDF order items:', oiErr.message);
      return NextResponse.json({ error: 'Failed to fetch invoice line items' }, { status: 500 });
    }

    const vatBreakdown = buildInvoiceBreakdown({ order, orderItems: currentItems, quote, taxStatus });
    const invoiceTotal = vatBreakdown.total;

    const { adjustments, error: adjErr } = await loadInvoiceAdjustments(serviceClient, orderId);
    if (adjErr) console.error('Invoice PDF adjustments:', adjErr.message);

    // ── 3. Quote history ───────────────────────────────────────────────────────
    let quoteHistory = [];
    if (quote?.quote_group_id) {
      const { data: revisions, error: revErr } = await serviceClient
        .from('quotations')
        .select('id, quote_num, revision, status, pricing_mode, tax_status, subtotal, vat_amount, total, payment_terms, created_at, converted_order_id')
        .eq('quote_group_id', quote.quote_group_id)
        .order('revision', { ascending: true });
      if (revErr) {
        console.error('pdf/route.js revisions fetch:', revErr.message);
        return NextResponse.json({ error: 'Failed to fetch quote revisions' }, { status: 500 });
      }
      quoteHistory = revisions || [];
    }

    // ── 4. Tracker progress ────────────────────────────────────────────────────
    const { data: activities, error: actErr } = await serviceClient
      .from('order_activities')
      .select('id, activity_type, description, created_at, created_by')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });

    if (actErr) {
      console.error('pdf/route.js activities fetch:', actErr.message);
      return NextResponse.json({ error: 'Failed to fetch order activities' }, { status: 500 });
    }

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
    const trackerProgress = ORDER_STAGES.map(stage => ({
      stage,
      reached_at: stageTimestamps[stage] || null,
      is_current: order.status === stage,
    }));

    // ── 5. Delivery history ────────────────────────────────────────────────────
    let deliveryHistory = [];
    if (order.batch_delivery) {
      const { data: batches, error: batchErr } = await serviceClient
        .from('delivery_batches')
        .select(`
          id, batch_number, status, actual_delivery_date, created_at,
          delivery_batch_items (
            id, quantity_planned, quantity_delivered, quantity_rejected, order_item_id,
            order_items ( id, description, category, unit_price, quantity, gross_amount )
          )
        `)
        .eq('order_id', orderId)
        .is('deleted_at', null)
        .order('batch_number', { ascending: true });

      if (batchErr) {
        console.error('pdf/route.js batches fetch:', batchErr.message);
        return NextResponse.json({ error: 'Failed to fetch delivery batches' }, { status: 500 });
      }

      deliveryHistory = (batches || []).map(batch => {
        const items = batch.delivery_batch_items || [];
        const isDelivered = DELIVERED_BATCH_STATUSES.has(batch.status);
        const batchValue = items.reduce((s, i) => {
          const oi = i.order_items;
          if (!oi) return s;
          // gross_amount stored as 0 for pre-migration rows → fall back to unit_price
          const grossUnit = Number(oi.gross_amount || 0) > 0 && Number(oi.quantity) > 0
            ? Number(oi.gross_amount) / Number(oi.quantity)
            : Number(oi.unit_price || 0);
          return s + (isDelivered ? (i.quantity_delivered || 0) : 0) * grossUnit;
        }, 0);
        return {
          batch_number: batch.batch_number,
          status: batch.status,
          actual_delivery_date: batch.actual_delivery_date,
          batch_value: batchValue,
          counts_toward_progress: isDelivered,
          items: items.map(i => {
            const oi = i.order_items;
            const grossUnit = oi && Number(oi.gross_amount || 0) > 0 && Number(oi.quantity) > 0
              ? Number(oi.gross_amount) / Number(oi.quantity)
              : Number(oi?.unit_price || 0);
            return {
              description: oi?.description || '—',
              category: oi?.category,
              quantity_planned: i.quantity_planned,
              quantity_delivered: i.quantity_delivered,
              gross_unit: grossUnit,
              line_value: (i.quantity_delivered || 0) * grossUnit,
            };
          }),
        };
      });
    } else {
      const deliveryActivity = (activities || []).find(a =>
        a.activity_type === 'status_change' && (
          a.description?.includes('Delivered') || a.description?.includes('Delivery') || a.description?.includes('Closed')
        )
      );
      const FULLY_DELIVERED_STATUSES = new Set(['Delivered', 'Closed']);
      if (FULLY_DELIVERED_STATUSES.has(order.status) || deliveryActivity) {
        deliveryHistory = [{
          batch_number: null,
          status: order.status,
          actual_delivery_date: deliveryActivity?.created_at?.split('T')[0] || null,
          batch_value: invoiceTotal,
          counts_toward_progress: true,
          items: [],
        }];
      }
    }

    // ── 6. Payment history ─────────────────────────────────────────────────────
    const { data: pmtRows, error: pmtErr } = await serviceClient
      .from('order_payments')
      .select('id, amount, payment_date, description, reversed_at, journal_entry_id, created_at')
      .eq('order_id', orderId)
      .order('payment_date', { ascending: true })
      .order('created_at', { ascending: true });

    if (pmtErr) {
      return NextResponse.json({ error: 'Failed to fetch payment data' }, { status: 500 });
    }

    const totalValue = invoiceTotal;
    let runningBalance = totalValue;
    const paymentHistory = (pmtRows || []).map(p => {
      const isReversed = !!p.reversed_at;
      const amount = Number(p.amount);
      if (!isReversed) runningBalance -= amount;
      return {
        payment_date: p.payment_date,
        description: p.description,
        amount,
        is_reversed: isReversed,
        reversed_at: p.reversed_at,
        running_balance: isReversed ? null : runningBalance,
      };
    });
    const totalPaid = (pmtRows || []).filter(p => !p.reversed_at).reduce((s, p) => s + Number(p.amount), 0);

    const invoice = {
      order_id:          order.id,
      order_num:         order.order_num,
      invoice_number:    order.invoice_number,
      invoice_issued_at: order.invoice_issued_at,
      status:            order.status,
      total_value:       totalValue,
      pricing_mode:      vatBreakdown?.pricing_mode || order.pricing_mode || 'vat_inclusive',
      customer_type:     order.customer_type,
      payment_terms:     order.payment_terms,
      payment_due_date:  order.payment_due_date,
      due_date:          order.due_date,
      batch_delivery:    order.batch_delivery,
      client:            order.client,
      contact_person:    order.contact_person,
      customer:          order.customers,
      quote_id:          order.quote_id,
      quote_num:         quote?.quote_num || order.quote_number || null,
      quote_revision:    quote ? quote.revision : null,
      total_paid:        totalPaid,
      balance:           Math.max(0, totalValue - totalPaid),
    };

    let pdfBuffer;
    try {
      pdfBuffer = await spawnPdf({
        crmInvoice: {
          invoice,
          vatBreakdown,
          adjustments,
          quoteHistory,
          trackerProgress,
          deliveryHistory,
          paymentHistory,
        },
      });
    } catch (err) {
      console.error('crm invoice pdf spawn error:', err.message);
      return NextResponse.json({ error: 'PDF generation failed', detail: err.message }, { status: 500 });
    }

    const filename = `${order.invoice_number || order.order_num}_Invoice.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('GET /api/crm/invoices/[id]/pdf:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
