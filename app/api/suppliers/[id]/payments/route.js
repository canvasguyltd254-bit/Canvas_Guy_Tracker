/**
 * app/api/suppliers/[id]/payments/route.js
 *
 * POST /api/suppliers/:id/payments
 * Record a manual cash/bank/M-Pesa payment to a supplier.
 * Optionally links to a specific purchase and recalculates its amount_paid.
 *
 * IMPORTANT: Never increment amount_paid directly. Always use recalcPurchasePayment
 * so the value is always SUM(manual_payments) + SUM(chatpesa_allocations).
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';
import { postManualPaymentJournal } from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { supplier_purchase_id, payment_date, amount, payment_method, reference, note } = body;

    if (!amount || parseFloat(amount) <= 0) {
      return NextResponse.json({ error: 'Amount must be greater than zero' }, { status: 400 });
    }
    if (!payment_date) {
      return NextResponse.json({ error: 'Payment date is required' }, { status: 400 });
    }

    // Verify supplier exists
    const { data: supplier } = await serviceClient
      .from('suppliers')
      .select('id')
      .eq('id', params.id)
      .maybeSingle();
    if (!supplier) {
      return NextResponse.json({ error: 'Supplier not found' }, { status: 404 });
    }

    // Build the payment record
    const paymentData = pick({
      supplier_id:          params.id,
      supplier_purchase_id: supplier_purchase_id || null,
      payment_date,
      amount:               parseFloat(amount),
      payment_method:       payment_method || 'Cash',
      reference:            reference?.trim() || null,
      note:                 note?.trim()      || null,
      created_by:           user.id,
    }, ALLOWED_FIELDS.manual_supplier_payments.insert);

    const { data: payment, error: payErr } = await serviceClient
      .from('manual_supplier_payments')
      .insert(paymentData)
      .select()
      .single();

    if (payErr) {
      console.error('POST /api/suppliers/[id]/payments — INSERT error:', payErr.code, payErr.message, payErr.details);
      return NextResponse.json(
        { error: 'Failed to record payment', detail: payErr.message },
        { status: 500 },
      );
    }

    // Recalculate from payment tables — never increment amount_paid directly
    if (supplier_purchase_id) {
      await recalcPurchasePayment(supplier_purchase_id, serviceClient);
    }

    // Accounting: post payment journal (fire-and-forget — payment is already saved)
    // 'Other' payment method has no account mapping and returns a SKIP error — expected, not logged.
    const { id: jId, error: jErr } = await postManualPaymentJournal({
      paymentId:     payment.id,
      paymentDate:   payment_date,
      amount:        parseFloat(amount),
      paymentMethod: payment_method || 'Cash',
      postedBy:      user.id,
      client:        serviceClient,
    });
    if (jId) {
      await serviceClient
        .from('manual_supplier_payments')
        .update({ journal_entry_id: jId })
        .eq('id', payment.id);
    } else if (jErr && !jErr.startsWith('SKIP:')) {
      console.error('POST /api/suppliers/[id]/payments — accounting post failed:', jErr);
    }

    return NextResponse.json({ success: true, data: payment });
  } catch (err) {
    console.error('POST /api/suppliers/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
