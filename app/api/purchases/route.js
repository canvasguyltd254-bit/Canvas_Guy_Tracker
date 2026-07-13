/**
 * app/api/purchases/route.js
 *
 * GET  /api/purchases              — list all purchases (with supplier + order info)
 * GET  /api/purchases?supplier_id= — filter by supplier
 * POST /api/purchases              — create purchase
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { recalcPurchasePayment } from '@/shared/lib/recalcPurchasePayment';
import { postPurchaseJournal, postManualPaymentJournal } from '@/shared/lib/accountingService';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

function deriveStatus(totalAmount, amountPaid) {
  const total = parseFloat(totalAmount) || 0;
  const paid  = parseFloat(amountPaid)  || 0;
  if (paid <= 0)          return 'Unpaid';
  if (paid >= total)      return 'Paid';
  return 'Part Paid';
}

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);
    const supplierId = searchParams.get('supplier_id');

    let query = serviceClient
      .from('supplier_purchases')
      .select('*, suppliers(id, name), purchase_order_links(order_id, orders(id, order_num, client))')
      .order('purchase_date', { ascending: false });

    if (supplierId) query = query.eq('supplier_id', supplierId);

    const { data, error } = await query;

    if (error) {
      console.error('GET /api/purchases:', error);
      return NextResponse.json({ error: 'Failed to fetch purchases' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('GET /api/purchases:', err);
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

    if (!body.supplier_id) {
      return NextResponse.json({ error: 'supplier_id is required' }, { status: 400 });
    }

    const totalAmount = parseFloat(body.total_amount) || 0;
    const amountPaid  = parseFloat(body.amount_paid)  || 0;

    if (totalAmount <= 0) {
      return NextResponse.json({ error: 'total_amount must be greater than zero' }, { status: 400 });
    }
    if (amountPaid > totalAmount) {
      return NextResponse.json({ error: 'amount_paid cannot exceed total_amount' }, { status: 400 });
    }

    const INITIAL_PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Other'];
    const initPaymentMethod    = body.initial_payment_method || 'Cash';
    const initPaymentReference = body.initial_payment_reference?.trim() || null;
    if (!INITIAL_PAYMENT_METHODS.includes(initPaymentMethod)) {
      return NextResponse.json(
        { error: `initial_payment_method must be one of: ${INITIAL_PAYMENT_METHODS.join(', ')}` },
        { status: 400 },
      );
    }

    const safe = {
      supplier_id:            body.supplier_id,
      purchase_date:          body.purchase_date || new Date().toISOString().split('T')[0],
      items_bought:           body.items_bought?.trim() || null,
      total_amount:           totalAmount,
      invoice_path:           body.invoice_path || null,
      invoice_name:           body.invoice_name || null,
      amount_paid:            amountPaid,
      payment_status:         deriveStatus(totalAmount, amountPaid),
      notes:                  body.notes?.trim() || null,
      accounting_category_id: body.accounting_category_id || null,
      created_by:             user.id,
    };

    const { data: purchase, error } = await serviceClient
      .from('supplier_purchases')
      .insert(safe)
      .select('id')
      .single();

    if (error) {
      console.error('POST /api/purchases:', error);
      return NextResponse.json({ error: 'Failed to create purchase' }, { status: 500 });
    }

    // If an initial payment was entered, create a matching manual_supplier_payments record
    // so the statement and recalc have a proper transaction to read.
    if (amountPaid > 0) {
      const paymentDate = safe.purchase_date;
      const { data: initPayment, error: pmtErr } = await serviceClient
        .from('manual_supplier_payments')
        .insert({
          supplier_id:          body.supplier_id,
          supplier_purchase_id: purchase.id,
          payment_date:         paymentDate,
          amount:               amountPaid,
          payment_method:       initPaymentMethod,
          reference:            initPaymentReference,
          note:                 'Initial payment recorded at purchase creation',
          created_by:           user.id,
        })
        .select('id')
        .single();

      if (pmtErr) {
        // Roll back the purchase so we never leave a dangling record with a
        // stale amount_paid and no corresponding payment transaction.
        console.error('POST /api/purchases — initial payment insert:', pmtErr.code, pmtErr.message);
        await serviceClient.from('supplier_purchases').delete().eq('id', purchase.id);
        return NextResponse.json(
          { error: 'Failed to record initial payment — purchase not saved.', detail: pmtErr.message },
          { status: 500 },
        );
      }

      // Recalc from payment tables so amount_paid is always derived, not stored directly
      try {
        await recalcPurchasePayment(purchase.id, serviceClient);
      } catch (recalcErr) {
        console.error('POST /api/purchases — recalc after initial payment:', recalcErr.message);
        // Purchase and payment record both exist — don't roll back, but surface the issue
        return NextResponse.json(
          { error: 'Purchase saved but payment total could not be recalculated.', detail: recalcErr.message },
          { status: 500 },
        );
      }

      // Accounting: journal for the initial payment (DR AP, CR cash/M-Pesa/bank)
      const { id: pmtJId, error: pmtJErr } = await postManualPaymentJournal({
        paymentId:     initPayment.id,
        paymentDate,
        amount:        amountPaid,
        paymentMethod: initPaymentMethod,
        postedBy:      user.id,
        client:        serviceClient,
      });
      if (pmtJId) {
        await serviceClient
          .from('manual_supplier_payments')
          .update({ journal_entry_id: pmtJId })
          .eq('id', initPayment.id);
      } else if (pmtJErr && !pmtJErr.startsWith('SKIP:')) {
        console.error('POST /api/purchases — initial payment journal failed:', pmtJErr);
      }
    }

    // Accounting: post purchase journal (fire-and-forget — purchase is already saved)
    // Skipped automatically when no accounting_category_id is provided (e.g. historical imports).
    const { id: jId, error: jErr } = await postPurchaseJournal({
      purchaseId:   purchase.id,
      purchaseDate: safe.purchase_date,
      totalAmount,
      categoryId:   safe.accounting_category_id,
      description:  safe.items_bought || '',
      postedBy:     user.id,
      client:       serviceClient,
    });
    if (jId) {
      await serviceClient
        .from('supplier_purchases')
        .update({ journal_entry_id: jId })
        .eq('id', purchase.id);
    } else if (jErr && !jErr.startsWith('SKIP:')) {
      console.error('POST /api/purchases — accounting post failed:', jErr);
    }

    // Insert order links if provided
    const orderIds = Array.isArray(body.order_ids) ? body.order_ids.filter(Boolean) : [];
    if (orderIds.length > 0) {
      const links = orderIds.map(oid => ({ purchase_id: purchase.id, order_id: oid }));
      const { error: linkError } = await serviceClient.from('purchase_order_links').insert(links);
      if (linkError) console.error('POST /api/purchases — link insert:', linkError);
    }

    // Re-fetch with full relations
    const { data, error: fetchError } = await serviceClient
      .from('supplier_purchases')
      .select('*, suppliers(id, name), purchase_order_links(order_id, orders(id, order_num, client))')
      .eq('id', purchase.id)
      .single();

    if (fetchError) {
      console.error('POST /api/purchases — re-fetch:', fetchError);
      return NextResponse.json({ error: 'Purchase created but failed to return data' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (err) {
    console.error('POST /api/purchases:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
