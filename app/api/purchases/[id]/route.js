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
      .select('*, suppliers(id, name, phone, email), purchase_order_links(order_id, amount, orders(id, order_num, client))')
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

    const hasLinkUpdate    = Array.isArray(body.order_links) || Array.isArray(body.order_ids);
    const hasPurchaseFields = Object.keys(safe).length > 1; // more than just payment_status

    if (!hasPurchaseFields && !hasLinkUpdate) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // Only touch the purchase row when there are actual field changes
    if (hasPurchaseFields) {
      const { error: updateError } = await serviceClient
        .from('supplier_purchases')
        .update(safe)
        .eq('id', params.id);

      if (updateError) {
        console.error('PATCH /api/purchases/[id]:', updateError);
        return NextResponse.json({ error: 'Failed to update purchase' }, { status: 500 });
      }
    }

    // Replace order links
    // Prefer order_links: [{ order_id, amount }] (Option B split-amount mode).
    // Fall back to order_ids: string[] for backwards compat with AddPurchaseModal.
    //
    // Both paths use the replace_purchase_order_links RPC so that delete + insert
    // run inside a single PostgreSQL transaction — if the insert fails, the delete
    // is automatically rolled back and no data is lost.
    if (Array.isArray(body.order_links)) {
      const validLinks = body.order_links.filter(l => l && l.order_id);

      // Validate allocated total against the effective purchase total.
      // Use finalTotal (safe.total_amount ?? current.total_amount) so that a request
      // which updates total_amount and order_links in the same call uses the NEW total.
      const purchaseTotal = parseFloat(finalTotal ?? 0);
      let totalAllocated  = 0;
      for (const l of validLinks) {
        if (l.amount != null && l.amount !== '') {
          const amt = parseFloat(l.amount);
          if (!isFinite(amt) || amt < 0) {
            return NextResponse.json(
              { error: `Invalid amount "${l.amount}" — must be a non-negative number.` },
              { status: 400 },
            );
          }
          totalAllocated += amt;
        }
      }
      if (totalAllocated > purchaseTotal + 0.01) {
        return NextResponse.json(
          { error: `Allocated total (${totalAllocated.toFixed(2)}) exceeds purchase total (${purchaseTotal.toFixed(2)}).` },
          { status: 400 },
        );
      }

      // Atomic replace via RPC (delete + insert in one transaction)
      const rpcLinks = validLinks.map(l => ({
        order_id: l.order_id,
        amount:   l.amount != null && l.amount !== '' ? parseFloat(l.amount) : null,
      }));
      const { error: rpcError } = await serviceClient.rpc('replace_purchase_order_links', {
        p_purchase_id: params.id,
        p_links:       rpcLinks,
      });
      if (rpcError) {
        console.error('PATCH /api/purchases/[id] — replace_purchase_order_links RPC:', rpcError);
        return NextResponse.json({ error: 'Failed to update order links' }, { status: 500 });
      }

    } else if (Array.isArray(body.order_ids)) {
      // Legacy path — no amounts; convert to RPC format with amount: null
      const rpcLinks = body.order_ids.filter(Boolean).map(oid => ({ order_id: oid, amount: null }));
      const { error: rpcError } = await serviceClient.rpc('replace_purchase_order_links', {
        p_purchase_id: params.id,
        p_links:       rpcLinks,
      });
      if (rpcError) {
        console.error('PATCH /api/purchases/[id] — replace_purchase_order_links RPC (legacy):', rpcError);
        return NextResponse.json({ error: 'Failed to update order links' }, { status: 500 });
      }
    }

    // Re-fetch with full relations (include amount from purchase_order_links)
    const { data, error: fetchError } = await serviceClient
      .from('supplier_purchases')
      .select('*, suppliers(id, name), purchase_order_links(order_id, amount, orders(id, order_num, client))')
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
