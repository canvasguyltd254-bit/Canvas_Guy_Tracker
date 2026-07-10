/**
 * app/api/manual-payments/route.js
 *
 * GET  /api/manual-payments?supplier_id=&purchase_id=  — list
 * POST /api/manual-payments                            — create
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];
const METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Other'];

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

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const supplierId  = searchParams.get('supplier_id');
    const purchaseId  = searchParams.get('purchase_id');

    let query = serviceClient
      .from('manual_supplier_payments')
      .select('*, suppliers(id, name), supplier_purchases(id, purchase_date, items_bought)')
      .order('payment_date', { ascending: false });

    if (supplierId) query = query.eq('supplier_id', supplierId);
    if (purchaseId) query = query.eq('supplier_purchase_id', purchaseId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: 'Failed to fetch payments' }, { status: 500 });
    return NextResponse.json({ success: true, data: data || [] });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.supplier_id) return NextResponse.json({ error: 'supplier_id is required' }, { status: 400 });
    const amount = parseFloat(body.amount);
    if (!amount || amount <= 0) return NextResponse.json({ error: 'amount must be positive' }, { status: 400 });
    if (body.payment_method && !METHODS.includes(body.payment_method)) {
      return NextResponse.json({ error: `payment_method must be one of: ${METHODS.join(', ')}` }, { status: 400 });
    }

    const safe = {
      supplier_id:          body.supplier_id,
      supplier_purchase_id: body.supplier_purchase_id || null,
      payment_date:         body.payment_date || new Date().toISOString().split('T')[0],
      amount,
      payment_method:       body.payment_method || 'Cash',
      reference:            body.reference?.trim() || null,
      note:                 body.note?.trim() || null,
      created_by:           user.id,
    };

    const { data, error } = await serviceClient
      .from('manual_supplier_payments')
      .insert(safe)
      .select('*, suppliers(id,name), supplier_purchases(id,purchase_date,items_bought)')
      .single();

    if (error) return NextResponse.json({ error: 'Failed to create payment' }, { status: 500 });

    await recalcPurchasePayment(safe.supplier_purchase_id);

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
