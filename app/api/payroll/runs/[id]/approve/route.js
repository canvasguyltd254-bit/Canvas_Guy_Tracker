/**
 * POST /api/payroll/runs/:id/approve  — approve run (locks all entries, snapshots totals)
 * POST /api/payroll/runs/:id/approve?action=reopen — reopen to draft
 *
 * Reopen rules:
 *  - Admin only
 *  - Requires a reason in the request body
 *  - Blocked if any payment batch exists for this run (exported or reconciled)
 *  - Blocked if any entry has amount_paid > 0
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function POST(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'approve';

    let body = {};
    try { body = await request.json(); } catch { /* no body */ }

    const { data: run } = await serviceClient
      .from('payroll_runs')
      .select('status, run_num, run_type, period_start')
      .eq('id', params.id)
      .single();

    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // ── REOPEN ────────────────────────────────────────────────
    if (action === 'reopen') {
      if (run.status !== 'approved') {
        return NextResponse.json({ error: 'Only approved runs can be reopened' }, { status: 409 });
      }

      const reason = (body?.reason || '').trim();
      if (!reason) {
        return NextResponse.json({ error: 'A reason is required to reopen a payroll run' }, { status: 400 });
      }

      // Block if any batch exists (even draft batches protect against accidental reopen)
      const { count: batchCount } = await serviceClient
        .from('payroll_payment_batches')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', params.id);

      if (batchCount > 0) {
        return NextResponse.json({
          error: 'Cannot reopen: payment batches already exist for this run. Delete all batches first.',
        }, { status: 409 });
      }

      // Block if any entry has been paid
      const { count: paidCount } = await serviceClient
        .from('payroll_entries')
        .select('id', { count: 'exact', head: true })
        .eq('run_id', params.id)
        .gt('amount_paid', 0);

      if (paidCount > 0) {
        return NextResponse.json({
          error: 'Cannot reopen: payments have already been recorded against entries in this run.',
        }, { status: 409 });
      }

      await serviceClient.from('payroll_runs').update({
        status:           'draft',
        approved_by:      null,
        approved_at:      null,
        approved_by_name: null,
        total_gross:      null,
        total_deductions: null,
        total_net:        null,
        employee_count:   null,
        reopen_reason:    reason,
      }).eq('id', params.id);

      // Release SHA ownership so a re-approval can re-race for the claim.
      // Without this, re-approval would find existing claim rows for this run
      // and either conflict on insert (wrong run_id) or incorrectly apply SHA
      // to a different run that has since claimed ownership.
      await serviceClient
        .from('payroll_sha_claims')
        .delete()
        .eq('run_id', params.id);

      await serviceClient.from('payroll_activities').insert({
        entity_type:   'run',
        entity_id:     params.id,
        activity_type: 'reopened',
        description:   `Run ${run.run_num} reopened to draft by ${displayName}. Reason: ${reason}`,
        old_value:     'approved',
        new_value:     'draft',
        created_by:    user.id,
      });

      return NextResponse.json({ success: true, status: 'draft' });
    }

    // ── APPROVE ───────────────────────────────────────────────
    if (run.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft runs can be approved' }, { status: 409 });
    }

    // Delegate to atomic RPC:
    // - Locks run + all entries with FOR UPDATE
    // - Enforces SHA once-per-month: committed approved/closed owner always wins
    // - Corrects sha_deduction, total_deductions, net_pay on each entry
    // - Snapshots totals and sets status = 'approved' in one transaction
    const { data: result, error: rpcErr } = await serviceClient.rpc('approve_payroll_run', {
      p_run_id:           params.id,
      p_approved_by:      user.id,
      p_approved_by_name: displayName,
    });

    if (rpcErr) {
      const status = rpcErr.message?.includes('no entries') ? 400
                   : rpcErr.message?.includes('Only draft') ? 409
                   : rpcErr.message?.includes('does not match') ? 400
                   : 500;
      return NextResponse.json({ error: rpcErr.message || 'Failed to approve run' }, { status });
    }

    const { total_gross, total_deductions, total_net, employee_count } = result;

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'run',
      entity_id:     params.id,
      activity_type: 'approved',
      description:   `Run ${run.run_num} approved by ${displayName}. ${employee_count} employees, gross KES ${total_gross.toLocaleString()}, net KES ${total_net.toLocaleString()}`,
      new_value:     JSON.stringify({ total_gross, total_deductions, total_net, employee_count }),
      created_by:    user.id,
    });

    return NextResponse.json({ success: true, status: 'approved', total_gross, total_net, employee_count });
  } catch (err) {
    console.error('POST /api/payroll/runs/[id]/approve unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
