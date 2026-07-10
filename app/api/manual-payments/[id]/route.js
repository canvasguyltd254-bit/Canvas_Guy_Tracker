/**
 * app/api/manual-payments/[id]/route.js
 *
 * DELETE /api/manual-payments/:id  — remove payment (admin / production_manager)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

async function recalcPurchasePayment(purchaseId) {
  if (!purchaseId) return;
  const [{ data: chatpesaAllocs }, { data: manualPmts }, { data: purchase }] = await Promise.all([
    serviceClient.from('chatpesa_payment_allocations').select('amount').eq('supplier_purchase_id', purchaseId),
    serviceClient.from('manual_supplier_payments').select('amount').eq('supplier_purchase_id', purchaseId),
    serviceClient.from('supplier_purchases').select('total_amount').eq('id', purchaseId).single(),
  ]);
  const totalPaid = [...(chatpesaAllocs||[]),...(manualPmts||[])].reduce((s,r)=>s+parseFloat(r.amount||0),0);
  const totalAmount = parseFloat(purchase?.total_amount||0);
  const amountPaid = Math.min(totalPaid, totalAmount);
  let paymentStatus = 'Unpaid';
  if (amountPaid > 0 && amountPaid < totalAmount) paymentStatus = 'Part Paid';
  if (amountPaid >= totalAmount) paymentStatus = 'Paid';
  await serviceClient.from('supplier_purchases').update({ amount_paid: amountPaid, payment_status: paymentStatus }).eq('id', purchaseId);
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin', 'production_manager']);
    if (authError) return authError;

    const { data: payment } = await serviceClient
      .from('manual_supplier_payments')
      .select('id, supplier_purchase_id')
      .eq('id', params.id)
      .single();

    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });

    const { error } = await serviceClient.from('manual_supplier_payments').delete().eq('id', params.id);
    if (error) return NextResponse.json({ error: 'Failed to delete payment' }, { status: 500 });

    await recalcPurchasePayment(payment.supplier_purchase_id);

    return NextResponse.json({ success: true, message: 'Payment deleted' });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
