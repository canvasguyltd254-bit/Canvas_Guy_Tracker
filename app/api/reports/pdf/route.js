/**
 * app/api/reports/pdf/route.js
 *
 * POST /api/reports/pdf
 *
 * Spawns scripts/run_report.js as a child process so that pdfkit runs in a
 * plain Node.js environment — completely outside webpack's module graph.
 * This avoids the "s is not a constructor" error that occurs when webpack
 * bundles pdfkit.es.js and its internal identifiers collide with webpack's
 * own minified variable names.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

/**
 * Spawn scripts/run_report.js, pipe JSON data to stdin, collect PDF bytes
 * from stdout. Runs entirely outside webpack — pdfkit uses Node.js native
 * module resolution.
 */
function spawnPdf(data) {
  return new Promise((resolve, reject) => {
    const scriptPath = join(process.cwd(), 'scripts', 'run_report.js');
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));

    child.on('close', code => {
      if (code !== 0) {
        const msg = Buffer.concat(err).toString() || 'PDF generation failed';
        reject(new Error(msg));
      } else {
        resolve(Buffer.concat(out));
      }
    });

    child.on('error', err => reject(new Error(`Failed to spawn PDF process: ${err.message}`)));

    child.stdin.write(JSON.stringify(data), 'utf8');
    child.stdin.end();
  });
}

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
      pdfBuffer = await spawnPdf(body);
    } catch (err) {
      const detail = err?.message || String(err);
      console.error('POST /api/reports/pdf — spawnPdf error:', detail);
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
    console.error('POST /api/reports/pdf — unexpected error:', detail);
    return NextResponse.json({ error: 'PDF generation failed', detail }, { status: 500 });
  }
}
