/**
 * GET    /api/payroll/batches/:id  — get batch detail with linked entries
 * PATCH  /api/payroll/batches/:id  — reconcile (calls atomic RPC, creates payment records)
 * DELETE /api/payroll/batches/:id  — admin only; deletes pending/exported batches
 *                                    (reconciled batches are blocked — payment records exist)
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'head_of_sales', 'production_manager']);
    if (authError) return authError;

    const { data: batch } = await serviceClient
      .from('payroll_payment_batches')
      .select('*, payroll_runs(run_num, period_start, period_end, run_type)')
      .eq('id', params.id)
      .single();

    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

    // Include linked entries
    const { data: links } = await serviceClient
      .from('payroll_batch_entry_links')
      .select('amount, payroll_entries(id, snapshot_name, net_pay, amount_paid, payment_status)')
      .eq('batch_id', params.id)
      .order('payroll_entries(snapshot_name)');

    return NextResponse.json({ batch, links: links || [] });
  } catch (err) {
    console.error('GET /api/payroll/batches/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const body = await request.json();
    const { action, chatpesa_ref, notes, payment_date } = body;

    if (action === 'reconcile') {
      if (!chatpesa_ref?.trim()) {
        return NextResponse.json({ error: 'chatpesa_ref is required to reconcile' }, { status: 400 });
      }

      // Verify batch exists and is in exportable state
      const { data: batch } = await serviceClient
        .from('payroll_payment_batches')
        .select('status, batch_num, exported_entry_ids')
        .eq('id', params.id)
        .single();

      if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
      if (batch.status === 'reconciled') {
        return NextResponse.json({ error: 'Batch already reconciled' }, { status: 409 });
      }

      // Call atomic RPC — creates payment records + updates entry balances in one transaction
      const { data: result, error: rpcErr } = await serviceClient.rpc('reconcile_payment_batch', {
        p_batch_id:      params.id,
        p_chatpesa_ref:  chatpesa_ref.trim(),
        p_payment_date:  payment_date || new Date().toISOString().slice(0, 10),
        p_reconciled_by: user.id,
      });

      if (rpcErr) {
        console.error('PATCH /api/payroll/batches/[id] reconcile RPC error:', rpcErr.message);
        return NextResponse.json({ error: rpcErr.message || 'Reconciliation failed' }, { status: 500 });
      }

      if (notes) {
        await serviceClient
          .from('payroll_payment_batches')
          .update({ notes })
          .eq('id', params.id);
      }

      // ── Auto-close run if all entries are now fully paid ──────
      try {
        const { data: batchRow, error: batchLookupErr } = await serviceClient
          .from('payroll_payment_batches')
          .select('run_id')
          .eq('id', params.id)
          .single();

        if (batchLookupErr) throw new Error(`batch lookup: ${batchLookupErr.message}`);

        const runId = batchRow?.run_id;
        if (runId) {
          // .neq() uses SQL != which excludes NULLs — OR on null covers
          // entries where payment_status was never set.
          const { count: unpaidCount, error: countErr } = await serviceClient
            .from('payroll_entries')
            .select('id', { count: 'exact', head: true })
            .eq('run_id', runId)
            .or('payment_status.neq.paid,payment_status.is.null');

          if (countErr) throw new Error(`unpaid count: ${countErr.message}`);

          if (unpaidCount === 0) {
            const { error: closeErr } = await serviceClient
              .from('payroll_runs')
              .update({ status: 'closed', updated_at: new Date().toISOString() })
              .eq('id', runId)
              .eq('status', 'approved'); // guard: only close if still approved

            if (closeErr) throw new Error(`run close: ${closeErr.message}`);

            const { error: actErr } = await serviceClient.from('payroll_activities').insert({
              entity_type:   'run',
              entity_id:     runId,
              activity_type: 'closed',
              description:   `Run automatically closed — all entries fully paid after batch ${batch.batch_num} reconciliation`,
              created_by:    user.id,
            });

            if (actErr) throw new Error(`activity log: ${actErr.message}`);
          }
        }
      } catch (autoCloseErr) {
        // Log but do not fail the response — reconciliation already committed.
        console.error('PATCH /api/payroll/batches/[id] auto-close error:', autoCloseErr.message);
      }

      const resultObj = result && typeof result === 'object' ? result : {};
      await serviceClient.from('payroll_activities').insert({
        entity_type:   'batch',
        entity_id:     params.id,
        activity_type: 'reconciled',
        description:   `Batch ${batch.batch_num} reconciled by ${displayName}. Ref: ${chatpesa_ref}. ${resultObj.payments_created ?? '?'} payments created, KES ${Number(resultObj.total_paid ?? 0).toLocaleString()} disbursed`,
        new_value:     JSON.stringify({ chatpesa_ref, ...resultObj }),
        created_by:    user.id,
      });

      return NextResponse.json({ success: true, ...result });
    }

    // Non-reconcile update (notes only)
    const updates = {};
    if (notes) updates.notes = notes;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const { data: batch, error } = await serviceClient
      .from('payroll_payment_batches')
      .update(updates)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: 'Failed to update batch' }, { status: 500 });
    }

    return NextResponse.json({ batch });
  } catch (err) {
    console.error('PATCH /api/payroll/batches/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role, displayName } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    const { data: batch } = await serviceClient
      .from('payroll_payment_batches')
      .select('id, batch_num, status, total_amount')
      .eq('id', params.id)
      .single();

    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });

    if (batch.status === 'reconciled') {
      return NextResponse.json(
        { error: 'Reconciled batches cannot be deleted — payment records already exist. Contact a system administrator if a reversal is needed.' },
        { status: 409 }
      );
    }

    // Delete the batch — payroll_batch_entry_links will cascade.
    // payroll_payments rows only exist on reconciled batches, so none to worry about here.
    const { error: delErr } = await serviceClient
      .from('payroll_payment_batches')
      .delete()
      .eq('id', params.id);

    if (delErr) {
      console.error('DELETE /api/payroll/batches/[id] error:', delErr.message);
      return NextResponse.json({ error: delErr.message || 'Failed to delete batch' }, { status: 500 });
    }

    await serviceClient.from('payroll_activities').insert({
      entity_type:   'batch',
      entity_id:     params.id,
      activity_type: 'deleted',
      description:   `Payment batch ${batch.batch_num} (KES ${Number(batch.total_amount || 0).toLocaleString()}) deleted by ${displayName}`,
      created_by:    user.id,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/payroll/batches/[id] unexpected:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
