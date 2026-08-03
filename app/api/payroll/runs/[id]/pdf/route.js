/**
 * GET /api/payroll/runs/:id/pdf
 *
 * Generates a landscape A4 payroll run sheet showing all entries,
 * per-employee deduction breakdown, and run totals.
 *
 * Access: admin, production_manager
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { spawn } from 'child_process';
import { join } from 'path';

const ALLOWED_ROLES = ['admin', 'head_of_sales', 'production_manager'];

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
    const authError = requireRole(user, role, ALLOWED_ROLES);
    if (authError) return authError;

    // ── Fetch run ─────────────────────────────────────────────────────────────
    const { data: run, error: runErr } = await serviceClient
      .from('payroll_runs')
      .select('*')
      .eq('id', params.id)
      .single();

    if (runErr || !run) {
      return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 });
    }

    // ── Fetch entries ─────────────────────────────────────────────────────────
    const { data: entries, error: entErr } = await serviceClient
      .from('payroll_entries')
      .select('*, employees(name, employee_num, phone, type)')
      .eq('run_id', params.id)
      .order('snapshot_name');

    if (entErr) {
      console.error('GET /api/payroll/runs/[id]/pdf entries error:', entErr.message);
      return NextResponse.json({ error: 'Failed to load entries' }, { status: 500 });
    }

    // ── Fetch adjustments for all entries ─────────────────────────────────────
    const entryIds = (entries || []).map(e => e.id);
    let adjustments = [];
    if (entryIds.length > 0) {
      const { data: adjs, error: adjErr } = await serviceClient
        .from('payroll_adjustments')
        .select('*')
        .in('entry_id', entryIds)
        .order('created_at');
      if (adjErr) {
        console.error('GET /api/payroll/runs/[id]/pdf adjustments error:', adjErr.message);
      }
      adjustments = adjs || [];
    }

    // ── Generate PDF ──────────────────────────────────────────────────────────
    const pdfData = {
      payrollRun: { run, entries: entries || [], adjustments },
    };

    const pdfBuffer = await spawnPdf(pdfData);

    const runNum = run.run_num.replace(/[^a-zA-Z0-9-]/g, '_');
    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="Payroll_Run_${runNum}.pdf"`,
        'Content-Length':      String(pdfBuffer.length),
      },
    });
  } catch (err) {
    console.error('GET /api/payroll/runs/[id]/pdf unexpected:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
