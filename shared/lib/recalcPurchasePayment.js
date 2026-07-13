/**
 * shared/lib/recalcPurchasePayment.js
 *
 * Recalculates amount_paid and payment_status on a supplier_purchases row
 * from the actual payment transaction tables — never increments directly.
 *
 * Source of truth:
 *   manual_supplier_payments  (cash / M-Pesa / bank)
 *   chatpesa_payment_allocations (Chatpesa reconciliation)
 *
 * Call this after ANY insert/delete in either payment table.
 *
 * @param {string} purchaseId  — supplier_purchases.id
 * @param {object} client      — serviceClient (Supabase admin client)
 */
export async function recalcPurchasePayment(purchaseId, client) {
  if (!purchaseId) return;

  const [
    { data: manualPmts,    error: mErr },
    { data: chatpesaAllocs,error: cErr },
    { data: purchase,      error: pErr },
  ] = await Promise.all([
    client.from('manual_supplier_payments')
      .select('amount')
      .eq('supplier_purchase_id', purchaseId),
    client.from('chatpesa_payment_allocations')
      .select('amount')
      .eq('supplier_purchase_id', purchaseId),
    client.from('supplier_purchases')
      .select('total_amount')
      .eq('id', purchaseId)
      .single(),
  ]);

  if (mErr) console.error('recalcPurchasePayment — manual_supplier_payments fetch:', mErr);
  if (cErr) console.error('recalcPurchasePayment — chatpesa_payment_allocations fetch:', cErr);
  if (pErr) {
    console.error('recalcPurchasePayment — supplier_purchases fetch:', pErr);
    throw new Error(`recalcPurchasePayment: could not fetch purchase ${purchaseId}: ${pErr.message}`);
  }

  const sumPayments = [...(manualPmts || []), ...(chatpesaAllocs || [])]
    .reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  const totalAmount   = parseFloat(purchase?.total_amount || 0);
  const amountPaid    = Math.min(sumPayments, totalAmount);
  const paymentStatus =
    amountPaid <= 0           ? 'Unpaid'   :
    amountPaid >= totalAmount ? 'Paid'     : 'Part Paid';

  const { error: uErr } = await client
    .from('supplier_purchases')
    .update({ amount_paid: amountPaid, payment_status: paymentStatus })
    .eq('id', purchaseId);

  if (uErr) {
    console.error('recalcPurchasePayment — supplier_purchases update:', uErr);
    throw new Error(`recalcPurchasePayment: failed to update purchase ${purchaseId}: ${uErr.message}`);
  }

  return true;
}
