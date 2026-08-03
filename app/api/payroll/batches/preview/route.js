/**
 * GET /api/payroll/batches/preview?run_id=X[&amount_available=Y]
 *
 * Returns the apportionment pool for a run. When amount_available is also
 * supplied the route runs the same apportion() + fifoSplit() math the batch
 * POST uses and embeds the results in each worker object:
 *
 *   worker.allocation   — integer shillings allocated to this worker
 *   worker.status       — 'paid' | 'part_paid' | 'unpaid'
 *   worker.workerLinks  — [{ entry_id, amount }, …] in FIFO order
 *
 * This makes the preview table always match what the server will save,
 * regardless of edge-cases in any client-side calculation.
 *
 * No DB writes. Used by the "New Payment Batch" modal step 2.
 *
 * Access: admin only
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

// ── Apportionment helpers (mirrors batch POST route exactly) ──────────────────

function apportion(workers, totalAvailable) {
  const totalOwed = workers.reduce((s, w) => s + w.total_owed, 0);
  if (totalOwed === 0) return workers.map(() => 0);

  // Cap so we never allocate more than what's actually owed
  const effective = Math.min(totalAvailable, totalOwed);
  const ratio     = effective / totalOwed;

  const raw        = workers.map(w => w.total_owed * ratio);
  const floors     = raw.map(r => Math.floor(r));
  const remainders = raw.map((r, i) => r - floors[i]);

  // Leftover from floor-rounding (never negative, never more than worker count)
  let leftover = effective - floors.reduce((s, f) => s + f, 0);

  // Distribute leftover 1 shilling at a time: largest remainder first,
  // break ties alphabetically so result is deterministic.
  const order = workers
    .map((w, i) => ({ i, rem: remainders[i], name: w.employee_name, eid: w.employee_id }))
    .sort((a, b) => b.rem - a.rem || a.name.localeCompare(b.name) || a.eid.localeCompare(b.eid))
    .map(x => x.i);

  const allocations = [...floors];
  for (let k = 0; k < leftover && k < order.length; k++) {
    allocations[order[k]] += 1;
  }

  return allocations;
}

function fifoSplit(entries, allocation) {
  const links = [];
  let remaining = allocation;
  for (const e of entries) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, e.balance);
    if (amount > 0) {
      links.push({ entry_id: e.entry_id, amount });
      remaining -= amount;
    }
  }
  return links;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales', 'production_manager']);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const runId       = searchParams.get('run_id');
    const amountParam = searchParams.get('amount_available');

    if (!runId) return NextResponse.json({ error: 'run_id is required' }, { status: 400 });

    // amount_available is optional — omit to get pool-only; supply to get allocations
    let amountAvailable = null;
    if (amountParam !== null) {
      amountAvailable = Number(amountParam);
      if (!Number.isSafeInteger(amountAvailable) || amountAvailable <= 0) {
        return NextResponse.json(
          { error: 'amount_available must be a positive whole number' },
          { status: 400 }
        );
      }
    }

    // ── 1. Verify run is approved ────────────────────────────
    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('id, run_num, status, period_start, period_end, run_type, total_net')
      .eq('id', runId)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'approved') {
      return NextResponse.json({ error: 'Run must be approved to preview apportionment' }, { status: 409 });
    }

    // ── 2. Current run entries ───────────────────────────────
    const { data: currentEntries, error: curErr } = await serviceClient
      .from('payroll_entries')
      .select('id, employee_id, snapshot_name, net_pay, amount_paid, payment_status')
      .eq('run_id', runId)
      .order('snapshot_name');

    if (curErr || !currentEntries?.length) {
      return NextResponse.json({ error: 'No entries found for this run' }, { status: 400 });
    }

    const employeeIds = currentEntries.map(e => e.employee_id);

    // ── 3. Historical outstanding entries ────────────────────
    // Fetch with created_at for secondary sort; filter approved/closed runs in JS.
    const { data: historicalEntries, error: histErr } = await serviceClient
      .from('payroll_entries')
      .select(`
        id, employee_id, snapshot_name, net_pay, amount_paid, payment_status,
        created_at,
        payroll_runs ( id, run_num, period_start, status )
      `)
      .in('employee_id', employeeIds)
      .neq('run_id', runId)
      .in('payment_status', ['unpaid', 'part_paid']);

    if (histErr) {
      console.error('GET /api/payroll/batches/preview historical query error:', histErr.message);
      return NextResponse.json({ error: 'Failed to load historical entries' }, { status: 500 });
    }

    // Filter: only from approved/closed runs
    const validHistorical = (historicalEntries || []).filter(e =>
      ['approved', 'closed'].includes(e.payroll_runs?.status)
    );

    // Group by employee, sort period_start ASC → created_at ASC → id ASC (FIFO, deterministic)
    const historicalByEmployee = {};
    for (const e of validHistorical) {
      if (!historicalByEmployee[e.employee_id]) historicalByEmployee[e.employee_id] = [];
      historicalByEmployee[e.employee_id].push(e);
    }
    for (const empId of Object.keys(historicalByEmployee)) {
      historicalByEmployee[empId].sort((a, b) => {
        const ps = new Date(a.payroll_runs.period_start) - new Date(b.payroll_runs.period_start);
        if (ps !== 0) return ps;
        const ca = new Date(a.created_at) - new Date(b.created_at);
        if (ca !== 0) return ca;
        return a.id.localeCompare(b.id);
      });
    }

    // ── 4. Build worker pool ─────────────────────────────────
    let runTotalOwed = 0;
    const workers = currentEntries.map(cur => {
      const historical = (historicalByEmployee[cur.employee_id] || []).map(e => ({
        entry_id:     e.id,
        run_num:      e.payroll_runs?.run_num || '?',
        period_start: e.payroll_runs?.period_start,
        net_pay:      Number(e.net_pay),
        amount_paid:  Number(e.amount_paid),
        balance:      Number(e.net_pay) - Number(e.amount_paid),
      }));

      const balanceBroughtForward = historical.reduce((s, e) => s + e.balance, 0);
      const currentBalance        = Number(cur.net_pay) - Number(cur.amount_paid);
      const totalOwed             = balanceBroughtForward + currentBalance;

      runTotalOwed += totalOwed;

      return {
        employee_id:             cur.employee_id,
        employee_name:           cur.snapshot_name,
        current_entry_id:        cur.id,
        current_net_pay:         Number(cur.net_pay),
        current_amount_paid:     Number(cur.amount_paid),
        current_balance:         currentBalance,
        balance_brought_forward: balanceBroughtForward,
        total_owed:              totalOwed,
        historical_entries:      historical,
      };
    });

    // ── 5. Compute allocations when amount_available is provided ──────────────
    let annotatedWorkers = workers;
    let allLinks         = null;
    let effectiveTotal   = null;

    if (amountAvailable !== null) {
      const allocations = apportion(workers, amountAvailable);
      allLinks = [];

      annotatedWorkers = workers.map((w, i) => {
        const allocation = allocations[i];

        // FIFO entry order: historical (oldest first), then current run entry
        const orderedEntries = [
          ...w.historical_entries.filter(e => e.balance > 0),
          ...(w.current_balance > 0
            ? [{ entry_id: w.current_entry_id, balance: w.current_balance }]
            : []),
        ];

        const workerLinks = fifoSplit(orderedEntries, allocation);
        allLinks.push(...workerLinks);

        const status =
          allocation === 0                    ? 'unpaid'
          : allocation >= w.total_owed - 0.5 ? 'paid'
          :                                    'part_paid';

        return { ...w, allocation, workerLinks, status };
      });

      effectiveTotal = allLinks.reduce((s, l) => s + l.amount, 0);
    }

    return NextResponse.json({
      run,
      workers:        annotatedWorkers,
      run_total_owed: runTotalOwed,
      // Only present when amount_available was provided:
      ...(amountAvailable !== null && {
        links:           allLinks,
        effective_total: effectiveTotal,
      }),
    });
  } catch (err) {
    console.error('GET /api/payroll/batches/preview unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
