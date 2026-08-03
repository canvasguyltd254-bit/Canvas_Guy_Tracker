/**
 * GET /api/payroll/employees/:id/report/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Generates a portrait A4 payroll history report for a single employee
 * over a specified date range.
 *
 * Sections:
 *   1. Employee details header
 *   2. Period summary (balance B/F, gross, deductions, net, payments, balance C/F)
 *   3. Payroll history table (approved/closed runs only)
 *   4. Payment history table (confirmed payments in period)
 *   5. Closing balance block
 *
 * Balance logic:
 *   B/F  = approved net pay before period start − confirmed payments before period start
 *   C/F  = B/F + period net pay − period payments
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

    const { searchParams } = new URL(request.url);
    const dateFrom = searchParams.get('from');
    const dateTo   = searchParams.get('to');

    if (!dateFrom || !dateTo) {
      return NextResponse.json({ error: '?from=YYYY-MM-DD&to=YYYY-MM-DD are required' }, { status: 400 });
    }

    // ── Fetch employee ─────────────────────────────────────────────────────────
    const { data: employee, error: empErr } = await serviceClient
      .from('employees')
      .select('id, name, employee_num, type, phone, id_number, sha_amount, hire_date, is_active, bank_name, bank_account')
      .eq('id', params.id)
      .single();

    if (empErr || !employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // ── Fetch ALL approved/closed entries for this employee ────────────────────
    // Need full history (not just the period) to compute Balance B/F.
    const { data: allEntries, error: entErr } = await serviceClient
      .from('payroll_entries')
      .select(`
        *,
        payroll_runs (
          id, run_num, run_type, period_start, period_end, status
        )
      `)
      .eq('employee_id', params.id)
      .order('created_at', { ascending: true });

    if (entErr) {
      console.error('GET /api/payroll/employees/[id]/report/pdf entries error:', entErr.message);
      return NextResponse.json({ error: 'Failed to load entries' }, { status: 500 });
    }

    // Keep only approved/closed entries where the run join resolved
    const validEntries = (allEntries || []).filter(
      e => e.payroll_runs && ['approved', 'closed'].includes(e.payroll_runs.status)
    );

    // Split: before the period (for B/F) vs within the period (for report body)
    const beforeEntries   = validEntries.filter(e => e.payroll_runs.period_end < dateFrom);
    const inPeriodEntries = validEntries.filter(
      e => e.payroll_runs.period_start >= dateFrom && e.payroll_runs.period_end <= dateTo
    );

    // ── Fetch adjustments for in-period entries ────────────────────────────────
    const inPeriodIds = inPeriodEntries.map(e => e.id);
    const adjByEntry  = {};
    if (inPeriodIds.length > 0) {
      const { data: adjs } = await serviceClient
        .from('payroll_adjustments')
        .select('*')
        .in('entry_id', inPeriodIds)
        .order('created_at');
      for (const a of (adjs || [])) {
        if (!adjByEntry[a.entry_id]) adjByEntry[a.entry_id] = [];
        adjByEntry[a.entry_id].push(a);
      }
    }

    // ── Fetch ALL payments linked to this employee's valid entries ─────────────
    const allEntryIds = validEntries.map(e => e.id);
    let allPayments = [];
    if (allEntryIds.length > 0) {
      const { data: pmts } = await serviceClient
        .from('payroll_payments')
        .select('*')
        .in('entry_id', allEntryIds)
        .order('payment_date', { ascending: true });
      allPayments = pmts || [];
    }

    // Separate payments: before period (for B/F) vs in period (for report body)
    const beforePayments   = allPayments.filter(p => p.payment_date < dateFrom);
    const inPeriodPayments = allPayments.filter(
      p => p.payment_date >= dateFrom && p.payment_date <= dateTo
    );

    // Annotate in-period payments with run number for "Run Applied To" column.
    // We already have entry → run mapping from inPeriodEntries.
    const entryRunMap = {};
    for (const e of validEntries) {
      entryRunMap[e.id] = e.payroll_runs?.run_num || '—';
    }
    const annotatedPayments = inPeriodPayments.map(p => ({
      ...p,
      _runNum: entryRunMap[p.entry_id] || '—',
    }));

    // ── Balance calculations ───────────────────────────────────────────────────
    const sumN = (arr, key) => arr.reduce((s, x) => s + Number(x[key] || 0), 0);

    const balanceBF = sumN(beforeEntries, 'net_pay') - sumN(beforePayments, 'amount');

    const periodGross        = sumN(inPeriodEntries, 'gross_pay');
    const periodSha          = sumN(inPeriodEntries, 'sha_deduction');
    const periodAdvances     = sumN(inPeriodEntries, 'advance_deduction');
    const periodDamage       = sumN(inPeriodEntries, 'damage_deduction');
    const periodOther        = sumN(inPeriodEntries, 'other_deductions');
    const periodNetPay       = sumN(inPeriodEntries, 'net_pay');
    const periodPaymentsMade = sumN(inPeriodPayments, 'amount');

    const balanceCF = balanceBF + periodNetPay - periodPaymentsMade;

    // ── Build run items for PDF ────────────────────────────────────────────────
    const runs = inPeriodEntries.map(e => ({
      run:         e.payroll_runs,
      entry:       e,
      adjustments: adjByEntry[e.id] || [],
    }));

    // ── Generate PDF ───────────────────────────────────────────────────────────
    const pdfData = {
      employeePayrollReport: {
        employee,
        dateFrom,
        dateTo,
        runs,
        payments: annotatedPayments,
        balanceBF,
        balanceCF,
        periodSummary: {
          gross:        periodGross,
          sha:          periodSha,
          advances:     periodAdvances,
          damage:       periodDamage,
          other:        periodOther,
          netPay:       periodNetPay,
          paymentsMade: periodPaymentsMade,
        },
      },
    };

    const pdfBuffer = await spawnPdf(pdfData);

    const safeName = employee.name.replace(/[^a-zA-Z0-9]/g, '_');
    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="Payroll_Report_${safeName}_${dateFrom}_to_${dateTo}.pdf"`,
        'Content-Length':      String(pdfBuffer.length),
      },
    });
  } catch (err) {
    console.error('GET /api/payroll/employees/[id]/report/pdf unexpected:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
