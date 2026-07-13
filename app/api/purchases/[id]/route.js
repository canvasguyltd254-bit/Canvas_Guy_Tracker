/**
 * app/api/purchases/[id]/route.js
 *
 * GET    /api/purchases/:id  — fetch single purchase
 * PATCH  /api/purchases/:id  — update purchase (recalculates payment_status)
 * DELETE /api/purchases/:id  — delete purchase (admin only)
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

function deriveStatus(totalAmount, amountPaid) {
  const total = parseFloat(totalAmount) || 0;
  const paid  = parseFloat(amountPaid)  || 0;
  if (paid <= 0)     return 'Unpaid';
  if (paid >= total) return 'Paid';
  return 'Part Paid';
}

export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role);
    if (authError) return authError;

    const { data, error } = await serviceClient
      .from('supplier_purchases')
      .select('*, suppliers(id, name, phone, email), purchase_order_links(order_id, orders(id, order_num, client))')
      .eq('id', params.id)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/purchases/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, WRITE_ROLES);
    if (authError) return authError;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Fetch current record to merge amounts correctly
    const { data: current } = await serviceClient
      .from('supplier_purchases')
      .select('total_amount, amount_paid, journal_entry_id')
      .eq('id', params.id)
      .single();

    if (!current) {
      return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });
    }

    // Block any change that would make the operational record disagree with the
    // posted journal entry. Non-financial fields (invoice_path, invoice_name,
    // items_bought description, notes) are still editable.
    if (current.journal_entry_id) {
      const POSTED_LOCKED_FIELDS = ['supplier_id', 'purchase_date', 'total_amount', 'amount_paid', 'accounting_category_id'];
      const blocked = POSTED_LOCKED_FIELDS.filter(f => body[f] !== undefined);
      if (blocked.length > 0) {
        return NextResponse.json(
          {
            error: 'Cannot change financial fields on a posted purchase. Create a reversal entry first.',
            journal_entry_id: current.journal_entry_id,
            blocked_fields:   blocked,
          },
          { status: 409 },
        );
      }
    }

    const safe = {};
    if (body.supplier_id !== undefined)               safe.supplier_id    = body.supplier_id;
    if (body.purchase_date !== undefined)             safe.purchase_date  = body.purchase_date;
    if (body.items_bought !== undefined)              safe.items_bought   = body.items_bought?.trim() || null;
    if (body.total_amount !== undefined)              safe.total_amount   = parseFloat(body.total_amount) || 0;
    if (body.invoice_path !== undefined)              safe.invoice_path   = body.invoice_path || null;
    if (body.invoice_name !== undefined)              safe.invoice_name   = body.invoice_name || null;
    if (body.amount_paid !== undefined)               safe.amount_paid    = parseFloat(body.amount_paid) || 0;
    if (body.notes !== undefined)                     safe.notes          = body.notes?.trim() || null;
    if (body.accounting_category_id !== undefined)    safe.accounting_category_id = body.accounting_category_id || null;

    // Recalculate status from the merged totals
    const finalTotal = safe.total_amount ?? parseFloat(current.total_amount);
    const finalPaid  = safe.amount_paid  ?? parseFloat(current.amount_paid);

    if (finalPaid > finalTotal) {
      return NextResponse.json({ error: 'amount_paid cannot exceed total_amount' }, { status: 400 });
    }

    safe.payment_status = deriveStatus(finalTotal, finalPaid);

    if (Object.keys(safe).length <= 1) { // only payment_status
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { error: updateError } = await serviceClient
      .from('supplier_purchases')
      .update(safe)
      .eq('id', params.id);

    if (updateError) {
      console.error('PATCH /api/purchases/[id]:', updateError);
      return NextResponse.json({ error: 'Failed to update purchase' }, { status: 500 });
    }

    // Replace order links if order_ids provided in body
    if (Array.isArray(body.order_ids)) {
      await serviceClient.from('purchase_order_links').delete().eq('purchase_id', params.id);
      const orderIds = body.order_ids.filter(Boolean);
      if (orderIds.length > 0) {
        const links = orderIds.map(oid => ({ purchase_id: params.id, order_id: oid }));
        const { error: linkError } = await serviceClient.from('purchase_order_links').insert(links);
        if (linkError) console.error('PATCH /api/purchases/[id] — link insert:', linkError);
      }
    }

    // Re-fetch with full relations
    const { data, error: fetchError } = await serviceClient
      .from('supplier_purchases')
      .select('*, suppliers(id, name), purchase_order_links(order_id, orders(id, order_num, client))')
      .eq('id', params.id)
      .single();

    if (fetchError) {
      console.error('PATCH /api/purchases/[id] — re-fetch:', fetchError);
      return NextResponse.json({ error: 'Purchase updated but failed to return data' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/purchases/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ['admin']);
    if (authError) return authError;

    // Block deletion if purchase has been posted to the General Ledger.
    const { data: purchase } = await serviceClient
      .from('supplier_purchases')
      .select('id, journal_entry_id')
      .eq('id', params.id)
      .single();

    if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 });

    if (purchase.journal_entry_id) {
      return NextResponse.json(
        {
          error: 'Cannot delete a posted purchase. This purchase has a journal entry in the General Ledger. Create a reversal entry first.',
          journal_entry_id: purchase.journal_entry_id,
        },
        { status: 409 },
      );
    }

    const { error } = await serviceClient
      .from('supplier_purchases')
      .delete()
      .eq('id', params.id);

    if (error) {
      console.error('DELETE /api/purchases/[id]:', error);
      return NextResponse.json({ error: 'Failed to delete purchase' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Purchase deleted' });
  } catch (err) {
    console.error('DELETE /api/purchases/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
