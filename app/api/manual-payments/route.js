/**
 * app/api/manual-payments/route.js
 *
 * GET  /api/manual-payments?supplier_id=&purchase_id=  — list
 * POST /api/manual-payments                            — create
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';
import { postManualPaymentJournal } from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];
const METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Cheque', 'Other'];

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

    // Ownership + overpayment guard — if linked to a purchase, verify it belongs
    // to the specified supplier and check the remaining balance.
    if (safe.supplier_purchase_id) {
      const { data: purchase } = await serviceClient
        .from('supplier_purchases')
        .select('supplier_id, total_amount, amount_paid')
        .eq('id', safe.supplier_purchase_id)
        .single();
      if (!purchase) {
        return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
      }
      if (purchase.supplier_id !== safe.supplier_id) {
        return NextResponse.json({ error: 'This purchase does not belong to the specified supplier' }, { status: 400 });
      }
      const remaining = parseFloat(purchase.total_amount || 0) - parseFloat(purchase.amount_paid || 0);
      if (amount > remaining + 0.01) {
        return NextResponse.json({
          error: `Overpayment: this purchase has KSh ${Math.round(remaining).toLocaleString()} remaining — a payment of KSh ${Math.round(amount).toLocaleString()} would exceed the total`,
        }, { status: 400 });
      }
    }

    const { data, error } = await serviceClient
      .from('manual_supplier_payments')
      .insert(safe)
      .select('*, suppliers(id,name), supplier_purchases(id,purchase_date,items_bought)')
      .single();

    if (error) {
      console.error('POST /api/manual-payments — INSERT error:', error.code, error.message, error.details);
      return NextResponse.json({ error: 'Failed to create payment', detail: error.message }, { status: 500 });
    }

    await recalcPurchasePayment(safe.supplier_purchase_id, serviceClient);

    // Accounting: post payment journal (fire-and-forget — payment is already saved)
    const { id: jId, error: jErr } = await postManualPaymentJournal({
      paymentId:     data.id,
      paymentDate:   safe.payment_date,
      amount:        safe.amount,
      paymentMethod: safe.payment_method,
      postedBy:      user.id,
      client:        serviceClient,
    });
    if (jId) {
      await serviceClient
        .from('manual_supplier_payments')
        .update({ journal_entry_id: jId })
        .eq('id', data.id);
    } else if (jErr && !jErr.startsWith('SKIP:')) {
      console.error('POST /api/manual-payments — accounting post failed:', jErr);
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/manual-payments
 *
 * Links an existing manual_supplier_payments row to a supplier_purchase.
 * Body: { id, supplier_purchase_id }
 *
 * Verifies:
 *   - payment exists
 *   - purchase exists and belongs to the same supplier as the payment
 *   - amount does not cause overpayment on the target purchase
 * Then updates supplier_purchase_id and recalcs purchase payment status.
 */
export async function PATCH(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { id, supplier_purchase_id } = body;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    // Load the payment
    const { data: payment } = await serviceClient
      .from('manual_supplier_payments')
      .select('id, supplier_id, supplier_purchase_id, amount')
      .eq('id', id)
      .single();

    if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });

    // If linking to a purchase (not clearing)
    if (supplier_purchase_id) {
      const { data: purchase } = await serviceClient
        .from('supplier_purchases')
        .select('id, supplier_id, total_amount, amount_paid')
        .eq('id', supplier_purchase_id)
        .single();

      if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
      if (purchase.supplier_id !== payment.supplier_id) {
        return NextResponse.json({ error: 'Purchase does not belong to the same supplier as this payment' }, { status: 400 });
      }

      // Overpayment check: existing amount_paid on that purchase already includes any previously
      // linked payment from this row — subtract it first to avoid double-counting.
      const currentlyLinked = payment.supplier_purchase_id === supplier_purchase_id
        ? parseFloat(payment.amount || 0)
        : 0;
      const alreadyPaid = parseFloat(purchase.amount_paid || 0) - currentlyLinked;
      const remaining   = parseFloat(purchase.total_amount || 0) - alreadyPaid;

      if (parseFloat(payment.amount) > remaining + 0.01) {
        return NextResponse.json({
          error: `This payment (KSh ${Math.round(payment.amount).toLocaleString()}) would exceed the remaining balance on that purchase (KSh ${Math.round(remaining).toLocaleString()}).`,
        }, { status: 400 });
      }
    }

    // Unlink from old purchase first (recalc the old one)
    const oldPurchaseId = payment.supplier_purchase_id;

    // Update the link
    const { error: updateErr } = await serviceClient
      .from('manual_supplier_payments')
      .update({ supplier_purchase_id: supplier_purchase_id || null })
      .eq('id', id);

    if (updateErr) {
      console.error('PATCH /api/manual-payments — update error:', updateErr.message);
      return NextResponse.json({ error: 'Failed to update payment link' }, { status: 500 });
    }

    // Recalc both old and new purchases
    if (oldPurchaseId) await recalcPurchasePayment(oldPurchaseId, serviceClient);
    if (supplier_purchase_id) await recalcPurchasePayment(supplier_purchase_id, serviceClient);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/manual-payments — unexpected error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
