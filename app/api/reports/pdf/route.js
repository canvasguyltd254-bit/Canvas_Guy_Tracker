/**
 * app/api/reports/pdf/route.js
 *
 * POST /api/reports/pdf
 * Accepts report data as JSON, runs scripts/build_report.py via Python,
 * returns the generated PDF as a binary response.
 *
 * Body shape:
 *   { reportLabel, orders, allItems, payTotals, dateFrom, dateTo,
 *     userName, showFinancials, workloadSummary }
 */

export const runtime = 'nodejs';

import { NextResponse }                      from 'next/server';
import { getAuthContext, requireRole }       from '@/shared/lib/api-auth';
import { execSync, execFileSync }            from 'child_process';
import path                                  from 'path';
import { existsSync }                        from 'fs';

// Find python3 — Next.js API routes have a stripped PATH on macOS
function findPython() {
  const candidates = [
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/opt/homebrew/opt/python3/bin/python3',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to PATH lookup
  try { execSync('which python3'); return 'python3'; } catch { /* ignore */ }
  return null;
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const body = await request.json();
    const json = JSON.stringify(body);

    const scriptPath = path.join(process.cwd(), 'scripts', 'build_report.py');
    const python     = findPython();

    if (!python) {
      return NextResponse.json(
        { error: 'PDF generation failed', detail: 'python3 not found on this machine' },
        { status: 500 },
      );
    }

    // Auto-install reportlab if missing
    try {
      execFileSync(python, ['-c', 'import reportlab'], { timeout: 5_000 });
    } catch {
      console.log('reportlab not found — installing…');
      try {
        // Try without --break-system-packages first (Homebrew Python)
        execFileSync(python, ['-m', 'pip', 'install', 'reportlab', '-q'], { timeout: 120_000 });
      } catch {
        // Fall back with --break-system-packages (system Python on macOS 13+)
        execFileSync(python, ['-m', 'pip', 'install', 'reportlab', '--break-system-packages', '-q'], { timeout: 120_000 });
      }
    }

    let pdfBytes;
    try {
      pdfBytes = execFileSync(python, [scriptPath], {
        input:     json,
        maxBuffer: 20 * 1024 * 1024,   // 20 MB
        timeout:   30_000,
      });
    } catch (err) {
      const detail = err.stderr?.toString() || err.message;
      console.error('build_report.py error:', detail);
      return NextResponse.json(
        { error: 'PDF generation failed', detail },
        { status: 500 },
      );
    }

    const safeLabel = (body.reportLabel || 'Report').replace(/[^a-zA-Z0-9]/g, '_');
    const dateStr   = new Date().toISOString().split('T')[0];

    return new NextResponse(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${safeLabel}_${dateStr}.pdf"`,
      },
    });
  } catch (err) {
    const detail = err.stderr?.toString() || err.message || String(err);
    console.error('POST /api/reports/pdf:', detail);
    return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
  }
}
