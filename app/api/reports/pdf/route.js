/**
 * app/api/reports/pdf/route.js
 *
 * POST /api/reports/pdf
 * Accepts report data as JSON, generates a PDF via the Node.js
 * build_report.js script (pdfkit — no Python required).
 * Returns the PDF as a binary response.
 */

export const runtime = 'nodejs';

import { NextResponse }                from 'next/server';
import { getAuthContext, requireRole } from '@/shared/lib/api-auth';
import { buildReportPDF }              from '@/scripts/build_report.js';

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    let pdfBuffer;
    try {
      pdfBuffer = await buildReportPDF(body);
    } catch (err) {
      const detail = err?.message || String(err);
      console.error('buildReportPDF error:', detail);
      return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
    }

    const safeLabel = (body.reportLabel || 'Report').replace(/[^a-zA-Z0-9]/g, '_');
    const dateStr   = new Date().toISOString().split('T')[0];

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${safeLabel}_${dateStr}.pdf"`,
      },
    });
  } catch (err) {
    const detail = err?.message || String(err);
    console.error('POST /api/reports/pdf:', detail);
    return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
  }
}
