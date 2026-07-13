/**
 * app/api/orders/[id]/delivery-note/pdf/route.js
 *
 * GET /api/orders/:id/delivery-note/pdf
 *
 * Query params:
 *   ?batch=[batchId]   — scope items to a specific delivery batch
 *   ?show=amounts      — include prices, totals, and payment summary (internal copy)
 *
 * Uses child_process.spawn to run scripts/run_report.js so that pdfkit
 * executes in a clean Node.js process outside webpack's module graph.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

function spawnPdf(data) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'run_report.js');
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
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
    const authError = requireRole(user, role);
    if (authError) return authError;

    const orderId     = params.id;
    const { searchParams } = new URL(request.url);
    const batchId     = searchParams.get('batch') || null;
    const showAmounts = searchParams.get('show') === 'amounts';

    // ── Fetch order ─────────────────────────────────────────────────────────
    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (orderErr || !order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    let items   = [];
    let batch   = null;

    if (batchId) {
      // ── Batch-scoped: pull items from delivery_batch_items ───────────────
      const { data: batchRow, error: bErr } = await serviceClient
        .from('delivery_batches')
        .select(`
          *,
          delivery_batch_items (
            id, quantity_planned, quantity_delivered,
            order_items ( id, category, description, size, finish_type, finish_color, wood_type, unit_price, sort_order )
          )
        `)
        .eq('id', batchId)
        .eq('order_id', orderId)
        .single();

      if (bErr || !batchRow) {
        return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
      }
      batch = batchRow;

      items = (batchRow.delivery_batch_items || [])
        .sort((a, b) => (a.order_items?.sort_order || 0) - (b.order_items?.sort_order || 0))
        .map(bi => ({
          ...bi.order_items,
          quantity: bi.quantity_planned,
          quantity_delivered: bi.quantity_delivered,
        }));
    } else {
      // ── Full order: pull all order_items ────────────────────────────────
      const { data: allItems, error: iErr } = await serviceClient
        .from('order_items')
        .select('*')
        .eq('order_id', orderId)
        .order('sort_order');

      if (iErr) {
        return NextResponse.json({ error: 'Failed to fetch items' }, { status: 500 });
      }
      items = allItems || [];
    }

    // ── Fetch payments ──────────────────────────────────────────────────────
    const { data: payments } = await serviceClient
      .from('order_payments')
      .select('*')
      .eq('order_id', orderId)
      .order('payment_date');

    // ── Build PDF data ──────────────────────────────────────────────────────
    const pdfData = {
      deliveryNote: {
        order,
        items,
        batch,
        payments: payments || [],
        showAmounts,
      },
    };

    let pdfBuffer;
    try {
      pdfBuffer = await spawnPdf(pdfData);
    } catch (err) {
      const detail = err?.message || String(err);
      console.error('GET /api/orders/[id]/delivery-note/pdf — spawnPdf error:', detail);
      return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
    }

    const variant  = showAmounts ? 'Internal_Copy' : 'Delivery_Note';
    const batchSfx = batchId ? `_Batch${batch?.batch_number || ''}` : '';
    const filename  = `${order.order_num || orderId}_${variant}${batchSfx}.pdf`
      .replace(/[^a-zA-Z0-9_.-]/g, '_');

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    const detail = err?.message || String(err);
    console.error('GET /api/orders/[id]/delivery-note/pdf — unexpected error:', detail);
    return NextResponse.json({ error: 'Internal server error', detail }, { status: 500 });
  }
}
