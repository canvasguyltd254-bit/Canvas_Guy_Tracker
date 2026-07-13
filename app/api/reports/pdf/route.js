/**
 * app/api/reports/pdf/route.js
 *
 * POST /api/reports/pdf
 * Imports build_report.js directly so Next.js/Vercel can trace pdfkit as a
 * normal dependency — no child process, no missing-module surprises on Vercel.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole } from '@/shared/lib/api-auth';

// Static import so webpack sees require('pdfkit') inside build_report.js,
// externalises it via serverExternalPackages, and Vercel traces + includes it.
import buildReportModule from '../../../../scripts/build_report.js';
const buildReportPDF = buildReportModule.buildReportPDF ?? buildReportModule.default?.buildReportPDF ?? buildReportModule;

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
