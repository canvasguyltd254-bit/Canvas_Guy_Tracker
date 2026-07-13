/**
 * app/api/manual-payments/[id]/route.js
 *
 * DELETE /api/manual-payments/:id  — remove payment (admin / production_manager)
 *
 * Guard: if the payment has already been posted to the General Ledger
 * (journal_entry_id IS NOT NULL), deletion is blocked. The journal entry
 * must be reversed before the payment record can be removed.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data: payment } = await serviceClient
      .from('manual_supplier_payments')
      .select('id, supplier_purchase_id, journal_entry_id')
      .eq('id', params.id)
      .single();

    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });

    // Block deletion if payment has already been posted to the General Ledger.
    // A reversal journal entry must be created first (Stage 2 — accounting audit controls).
    if (payment.journal_entry_id) {
      return NextResponse.json(
        {
          error: 'Cannot delete a posted payment. This payment has a journal entry in the General Ledger. Create a reversal first.',
          journal_entry_id: payment.journal_entry_id,
        },
        { status: 409 },
      );
    }

    const { error } = await serviceClient
      .from('manual_supplier_payments')
      .delete()
      .eq('id', params.id);

    if (error) {
      console.error('DELETE /api/manual-payments/[id]:', error);
      return NextResponse.json({ error: 'Failed to delete payment' }, { status: 500 });
    }

    await recalcPurchasePayment(payment.supplier_purchase_id, serviceClient);

    return NextResponse.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    console.error('DELETE /api/manual-payments/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
