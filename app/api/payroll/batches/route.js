/**
 * GET  /api/payroll/batches  — list payment batches
 * POST /api/payroll/batches  — compute apportionment server-side and create batch atomically
 *
 * POST body: { run_id, payment_method, notes, amount_available }
 * The server fetches the pool, runs largest-remainder apportionment,
 * builds FIFO entry links, then calls create_payroll_batch() RPC in one
 * transaction. No pre-computed links are accepted from the client.
 *
 * Access: admin only (POST), admin + production_manager (GET)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

// ── Apportionment helpers (server-side) ──────────────────────────────────────

/**
 * Largest-remainder method.
 * Returns integer shilling allocations summing to min(totalAvailable, totalOwed)
 * so full-pay (amount_available >= total_owed) never over-allocates.
 */
function apportion(workers, totalAvailable) {
  const totalOwed = workers.reduce((s, w) => s + w.total_owed, 0);
  if (totalOwed === 0) return workers.map(() => 0);

  // Cap: never pay more than is owed
  const effective = Math.min(totalAvailable, totalOwed);
  const ratio     = effective / totalOwed;

  const raw        = workers.map(w => w.total_owed * ratio);
  const floors     = raw.map(r => Math.floor(r));
  const remainders = raw.map((r, i) => r - floors[i]);

  let leftover = effective - floors.reduce((s, f) => s + f, 0);

  // Sort indices by remainder desc, then name asc, then employee_id asc for
  // full determinism even when two workers share the same display name.
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

/**
 * FIFO split: distribute a worker's total allocation across their outstanding
 * entries, oldest-first.
 */
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

// ── Route handlers ────────────────────────────────────────────────────────────

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales', 'production_manager']);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('payroll_payment_batches')
      .select('*, payroll_runs(run_num, period_start, period_end, run_type)')
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch batches' }, { status: 500 });
    }

    return NextResponse.json({ batches: data || [] });
  } catch (err) {
    console.error('GET /api/payroll/batches unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales', 'production_manager']);
    if (authError) return authError;

    const body = await request.json();
    const { run_id, payment_method = 'mpesa', notes, amount_available } = body;

    if (!run_id) {
      return NextResponse.json({ error: 'run_id is required' }, { status: 400 });
    }
    if (!Number.isSafeInteger(amount_available) || amount_available <= 0) {
      return NextResponse.json({ error: 'amount_available must be a positive whole number' }, { status: 400 });
    }

    // ── 1. Verify run is approved ──────────────────────────────
    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('id, status, run_num')
      .eq('id', run_id)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    if (run.status !== 'approved') {
      return NextResponse.json(
        { error: 'Run must be approved before creating a payment batch' },
        { status: 409 }
      );
    }

    // ── 2. Fetch current run entries ───────────────────────────
    const { data: currentEntries, error: curErr } = await serviceClient
      .from('payroll_entries')
      .select('id, employee_id, snapshot_name, net_pay, amount_paid, payment_status')
      .eq('run_id', run_id)
      .order('snapshot_name');

    if (curErr || !currentEntries?.length) {
      return NextResponse.json({ error: 'No entries found for this run' }, { status: 400 });
    }

    const employeeIds = currentEntries.map(e => e.employee_id);

    // ── 3. Fetch historical outstanding entries ────────────────
    const { data: historicalRaw, error: histErr } = await serviceClient
      .from('payroll_entries')
      .select(`
        id, employee_id, net_pay, amount_paid, payment_status,
        created_at,
        payroll_runs ( id, run_num, period_start, status )
      `)
      .in('employee_id', employeeIds)
      .neq('run_id', run_id)
      .in('payment_status', ['unpaid', 'part_paid']);

    if (histErr) {
      console.error('POST /api/payroll/batches historical query error:', histErr.message);
      return NextResponse.json({ error: 'Failed to load historical entries' }, { status: 500 });
    }

    // Only entries whose run is approved or closed
    const historical = (historicalRaw || []).filter(e =>
      ['approved', 'closed'].includes(e.payroll_runs?.status)
    );

    // Group by employee, sort period_start ASC → created_at ASC → id ASC (FIFO, deterministic)
    const histByEmployee = {};
    for (const e of historical) {
      if (!histByEmployee[e.employee_id]) histByEmployee[e.employee_id] = [];
      histByEmployee[e.employee_id].push(e);
    }
    for (const empId of Object.keys(histByEmployee)) {
      histByEmployee[empId].sort((a, b) => {
        const ps = new Date(a.payroll_runs.period_start) - new Date(b.payroll_runs.period_start);
        if (ps !== 0) return ps;
        const ca = new Date(a.created_at) - new Date(b.created_at);
        if (ca !== 0) return ca;
        return a.id.localeCompare(b.id);
      });
    }

    // ── 4. Build worker pool ───────────────────────────────────
    const workers = currentEntries.map(cur => {
      const hist = (histByEmployee[cur.employee_id] || []).map(e => ({
        entry_id: e.id,
        balance:  Number(e.net_pay) - Number(e.amount_paid),
      }));

      const balanceBroughtForward = hist.reduce((s, e) => s + e.balance, 0);
      const currentBalance        = Number(cur.net_pay) - Number(cur.amount_paid);

      return {
        employee_id:        cur.employee_id,
        employee_name:      cur.snapshot_name,
        current_entry_id:   cur.id,
        current_balance:    currentBalance,
        total_owed:         balanceBroughtForward + currentBalance,
        historical_entries: hist,
      };
    });

    // ── 5. Compute apportionment server-side ───────────────────
    const allocations = apportion(workers, amount_available);

    // ── 6. Build FIFO entry links ──────────────────────────────
    const links = [];
    for (let i = 0; i < workers.length; i++) {
      const w          = workers[i];
      const allocation = allocations[i];
      if (allocation <= 0) continue;

      // FIFO order: historical (oldest first) then current run entry
      const entries = [
        ...w.historical_entries.filter(e => e.balance > 0),
        ...(w.current_balance > 0
          ? [{ entry_id: w.current_entry_id, balance: w.current_balance }]
          : []),
      ];

      links.push(...fifoSplit(entries, allocation));
    }

    if (links.length === 0) {
      return NextResponse.json({ error: 'Nothing to pay — all balances are zero' }, { status: 400 });
    }

    // ── 7. Create batch atomically via RPC ─────────────────────
    // RPC validates amounts, checks for duplicate-in-open-batch, inserts
    // batch header + all entry links in a single transaction.
    const { data: result, error: rpcErr } = await serviceClient.rpc('create_payroll_batch', {
      p_run_id:           run_id,
      p_payment_method:   payment_method,
      p_notes:            notes || null,
      p_amount_available: amount_available,
      p_created_by:       user.id,
      p_links:            JSON.stringify(links),
    });

    if (rpcErr) {
      console.error('POST /api/payroll/batches RPC error:', rpcErr.message);
      const status = rpcErr.message?.includes('already in an open batch') ? 409 : 500;
      return NextResponse.json({ error: rpcErr.message || 'Failed to create batch' }, { status });
    }

    const { batch_id, batch_num, total_amount, entry_count } = result;

    // ── 8. Activity log ────────────────────────────────────────
    await serviceClient.from('payroll_activities').insert({
      entity_type:   'batch',
      entity_id:     batch_id,
      activity_type: 'created',
      description:
        `Payment batch ${batch_num} created by ${displayName}. ` +
        `KES ${Number(total_amount).toLocaleString()} apportioned across ` +
        `${entry_count} entries. Available: KES ${amount_available.toLocaleString()}`,
      created_by: user.id,
    });

    return NextResponse.json({ batch_id, batch_num, total_amount, entry_count }, { status: 201 });
  } catch (err) {
    console.error('POST /api/payroll/batches unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
