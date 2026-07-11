/**
 * app/api/suppliers/[id]/payments/route.js
 *
 * POST /api/suppliers/:id/payments
 * Record a manual cash/bank/M-Pesa payment to a supplier.
 * Optionally links to a specific purchase and updates its amount_paid.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

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
      supplier_id:         params.id,
      supplier_purchase_id: supplier_purchase_id || null,
      payment_date,
      amount:              parseFloat(amount),
      payment_method:      payment_method || 'Cash',
      reference:           reference?.trim() || null,
      note:                note?.trim()      || null,
      created_by:          user.id,
    }, ALLOWED_FIELDS.manual_supplier_payments.insert);

    const { data: payment, error: payErr } = await serviceClient
      .from('manual_supplier_payments')
      .insert(paymentData)
      .select()
      .single();

    if (payErr) {
      console.error('INSERT manual_supplier_payments:', payErr);
      return NextResponse.json({ error: 'Failed to record payment' }, { status: 500 });
    }

    // If linked to a specific purchase, update amount_paid and payment_status on that purchase
    if (supplier_purchase_id) {
      const { data: purchase } = await serviceClient
        .from('supplier_purchases')
        .select('total_amount, amount_paid')
        .eq('id', supplier_purchase_id)
        .eq('supplier_id', params.id)
        .maybeSingle();

      if (purchase) {
        const newAmountPaid = parseFloat(purchase.amount_paid || 0) + parseFloat(amount);
        const total         = parseFloat(purchase.total_amount || 0);
        const capped        = Math.min(newAmountPaid, total); // never exceed total
        const newStatus     = capped >= total ? 'Paid' : capped > 0 ? 'Part Paid' : 'Unpaid';

        await serviceClient
          .from('supplier_purchases')
          .update({ amount_paid: capped, payment_status: newStatus })
          .eq('id', supplier_purchase_id);
      }
    }

    return NextResponse.json({ success: true, data: payment });
  } catch (err) {
    console.error('POST /api/suppliers/[id]/payments:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
