export const runtime = 'nodejs';

/**
 * GET /api/crm/quotations/[id]/pdf
 * Generates a client-facing quotation PDF via PDFKit (scripts/run_report.js).
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

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

    const { data: quote, error } = await serviceClient
      .from('quotations')
      .select(`
        *,
        customers(id, name, contact_person, phone, email, address, kra_pin),
        enquiries(id, enq_num, source, category),
        quote_items(*)
      `)
      .eq('id', params.id)
      .single();

    if (error || !quote) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });

    // invoice=1 query param means the caller wants the issued invoice, not the draft quote.
    // Block if the order hasn't been invoiced yet (no invoice_number on the linked order).
    const url = new URL(request.url);
    if (url.searchParams.get('invoice') === '1') {
      const { data: order } = await serviceClient
        .from('orders')
        .select('invoice_number, invoice_journal_entry_id')
        .eq('quote_id', params.id)
        .maybeSingle();
      if (!order?.invoice_number || !order?.invoice_journal_entry_id) {
        return NextResponse.json(
          { error: 'Invoice has not been issued for this quotation yet' },
          { status: 422 },
        );
      }
    }

    const items = (quote.quote_items || [])
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    let pdfBuffer;
    try {
      pdfBuffer = await spawnPdf({ quotationPdf: { quote: { ...quote, quote_items: items } } });
    } catch (err) {
      console.error('quotation pdf spawn error:', err.message);
      return NextResponse.json({ error: 'PDF generation failed', detail: err.message }, { status: 500 });
    }

    const filename = `${quote.quote_num || params.id}_Quotation.pdf`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('GET /api/crm/quotations/[id]/pdf:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
