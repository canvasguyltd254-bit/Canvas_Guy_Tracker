export const runtime = 'nodejs';

/**
 * GET /api/orders/[id]/invoice/pdf
 * Generates an invoice PDF from the order snapshot via PDFKit (scripts/run_report.js).
 * The order must have invoice_number set (invoice must have been issued).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

const ROLES_INVOICE = ['admin', 'head_of_sales', 'sales'];

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
    const authErr = requireRole(user, role, ROLES_INVOICE);
    if (authErr) return authErr;

    const { data: order, error: orderErr } = await serviceClient
      .from('orders')
      .select(`
        *,
        customers(id, name, contact_person, phone, email, address, kra_pin),
        order_items(*),
        order_payments(id, amount, description, payment_date, journal_entry_id, reversed_at)
      `)
      .eq('id', params.id)
      .single();

    if (orderErr || !order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    const items    = (order.order_items    || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const payments = (order.order_payments || []).filter(p => !p.reversed_at);

    let pdfBuffer;
    try {
      pdfBuffer = await spawnPdf({
        invoicePdf: { order: { ...order, order_items: items, order_payments: payments } },
      });
    } catch (err) {
      console.error('invoice pdf spawn error:', err.message);
      return NextResponse.json({ error: 'PDF generation failed', detail: err.message }, { status: 500 });
    }

    const filename = `${order.invoice_number || order.order_num || params.id}_Invoice.pdf`
      .replace(/[^a-zA-Z0-9_.-]/g, '_');

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('GET /api/orders/[id]/invoice/pdf:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
