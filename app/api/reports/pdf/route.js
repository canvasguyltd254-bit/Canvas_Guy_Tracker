/**
 * app/api/reports/pdf/route.js
 *
 * POST /api/reports/pdf
 * Spawns scripts/build_report.js as a Node.js child process (avoids webpack
 * bundling pdfkit). Same stdin/stdout pattern as the old Python script.
 */

export const runtime = 'nodejs';

import { NextResponse }        from 'next/server';
import { getAuthContext, requireRole } from '@/shared/lib/api-auth';
import { execFileSync }        from 'child_process';
import path                    from 'path';

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const scriptPath = path.join(process.cwd(), 'scripts', 'build_report.js');
    const json       = JSON.stringify(body);

    let pdfBuffer;
    try {
      pdfBuffer = execFileSync(
        process.execPath,   // the Node.js binary that is already running — always available
        [scriptPath],
        { input: json, maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
      );
    } catch (err) {
      const detail = err.stderr?.toString() || err.message;
      console.error('build_report.js error:', detail);
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
