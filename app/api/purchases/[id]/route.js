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
import { isValidIsoDate, compareIsoDates } from '@/shared/lib/isoDate';
import { deriveDueDate, buildDueDateFields } from '@/shared/lib/supplierTerms';

const WRITE_ROLES = ['admin', 'production_manager', 'head_of_sales'];

function deriveStatus(totalAmount, amountPaid) {
  const total = parseFloat(totalAmount) || 0;
  const paid  = parseFloat(amountPaid)  || 0;
  if (paid <= 0)     return 'Unpaid';
  if (paid >= total) return 'Paid';
  return 'Part Paid';
}

export async function GET(request, props) {
  const params = await props.params;
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

export async function PATCH(request, props) {
  const params = await props.params;
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
      .select('supplier_id, total_amount, amount_paid, journal_entry_id, purchase_date, due_date, due_date_source, due_date_terms_days')
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
    if (body.purchase_date !== undefined) {
      if (!isValidIsoDate(body.purchase_date)) {
        return NextResponse.json({ error: 'purchase_date must be a valid date in YYYY-MM-DD format' }, { status: 400 });
      }
      safe.purchase_date = body.purchase_date;
    }
    if (body.items_bought !== undefined)              safe.items_bought   = body.items_bought?.trim() || null;
    if (body.total_amount !== undefined)              safe.total_amount   = parseFloat(body.total_amount) || 0;
    if (body.invoice_path !== undefined)              safe.invoice_path   = body.invoice_path || null;
    if (body.invoice_name !== undefined)              safe.invoice_name   = body.invoice_name || null;
    if (body.amount_paid !== undefined)               safe.amount_paid    = parseFloat(body.amount_paid) || 0;
    if (body.notes !== undefined)                     safe.notes          = body.notes?.trim() || null;
    if (body.accounting_category_id !== undefined)    safe.accounting_category_id = body.accounting_category_id || null;

    // due_date / due_date_source / due_date_terms_days are intentionally NOT
    // in POSTED_LOCKED_FIELDS above: they carry no accounting meaning and
    // never appear in the journal, so renegotiating a payment date does not
    // put the record at odds with a posted entry.
    //
    // The resolve_purchase_due_date() trigger is BEFORE INSERT only — it does
    // not run on UPDATE — so this route is the only place that sets
    // due_date_source / due_date_terms_days after creation, and it must set
    // all three columns together, every time, so the provenance CHECK
    // constraint never has to reject an update this route itself produced.
    //
    // Unlike POST, an OMITTED due_date_mode here means "leave the due date
    // alone" (ordinary partial-update semantics), not "infer a mode". PATCH
    // touches an EXISTING row — silently re-deriving its due date from the
    // supplier's current terms just because the caller updated some
    // unrelated field (e.g. notes) would be a worse version of the exact bug
    // this file was rewritten to fix: a date changing on its own, with no
    // explicit request behind it. The legacy-omission inference rule applies
    // to POST (a brand-new row that needs some decision made), not here.
    const dueDateMode = body.due_date_mode;
    const VALID_DUE_DATE_MODES = ['explicit', 'supplier_terms', 'unrecorded'];

    if (dueDateMode !== undefined) {
      if (!VALID_DUE_DATE_MODES.includes(dueDateMode)) {
        return NextResponse.json(
          { error: `due_date_mode must be one of: ${VALID_DUE_DATE_MODES.join(', ')}` },
          { status: 400 },
        );
      }

      if (dueDateMode === 'explicit') {
        const raw = String(body.due_date ?? '').trim();
        if (!raw) {
          return NextResponse.json({ error: 'due_date is required when due_date_mode is "explicit"' }, { status: 400 });
        }
        if (!isValidIsoDate(raw)) {
          return NextResponse.json({ error: 'due_date must be a valid date in YYYY-MM-DD format' }, { status: 400 });
        }
        Object.assign(safe, buildDueDateFields('explicit', { explicitDate: raw }));
      } else {
        // supplier_terms / unrecorded: an accompanying due_date contradicts
        // the mode (the date isn't a manual entry in either case) — reject
        // rather than silently choosing one meaning over the other.
        if (String(body.due_date ?? '').trim()) {
          return NextResponse.json(
            { error: `due_date must not be provided when due_date_mode is "${dueDateMode}"` },
            { status: 400 },
          );
        }

        if (dueDateMode === 'supplier_terms') {
          const effectiveSupplierId = safe.supplier_id !== undefined ? safe.supplier_id : current.supplier_id;
          const { data: sup, error: supErr } = await serviceClient
            .from('suppliers')
            .select('payment_terms_days')
            .eq('id', effectiveSupplierId)
            .single();
          if (supErr || !sup) {
            return NextResponse.json({ error: 'Supplier not found' }, { status: 400 });
          }
          if (!Number.isInteger(sup.payment_terms_days)) {
            return NextResponse.json(
              { error: 'This supplier has no recorded credit terms. Record terms on the supplier, or use "explicit" / "unrecorded" instead.' },
              { status: 400 },
            );
          }
          const effectivePurchaseDate = safe.purchase_date !== undefined ? safe.purchase_date : current.purchase_date;
          const derived = deriveDueDate(effectivePurchaseDate, sup.payment_terms_days);
          // deriveDueDate only returns null for inputs already rejected above
          // (invalid date, unrecorded terms) — this is a defensive backstop,
          // not an expected path.
          if (!derived) {
            return NextResponse.json({ error: 'Could not derive a due date from the supplier\'s terms' }, { status: 400 });
          }
          // Snapshot the terms USED, not a pointer back to the supplier row —
          // this is what makes the label stable if the supplier's terms
          // change again later. See shared/lib/supplierTerms.js.
          Object.assign(safe, buildDueDateFields('supplier_terms', {
            derivedDate: derived,
            supplierTermsDays: sup.payment_terms_days,
          }));
        } else {
          // unrecorded — always clears all three, regardless of whether the
          // supplier currently has terms. Matches POST's "unrecorded" exactly.
          Object.assign(safe, buildDueDateFields('unrecorded'));
        }
      }
    } else if (body.due_date !== undefined) {
      // Back-compat for a caller that sends a raw due_date with no mode.
      // Both form call sites in this codebase now always send due_date_mode;
      // this branch exists only as a safety net, not a supported contract.
      const v = String(body.due_date ?? '').trim();
      if (v) {
        if (!isValidIsoDate(v)) {
          return NextResponse.json({ error: 'due_date must be a valid date in YYYY-MM-DD format' }, { status: 400 });
        }
        Object.assign(safe, buildDueDateFields('explicit', { explicitDate: v }));
      } else {
        Object.assign(safe, buildDueDateFields('unrecorded'));
      }
    }

    // Recalculate status from the merged totals
    const finalTotal = safe.total_amount ?? parseFloat(current.total_amount);
    const finalPaid  = safe.amount_paid  ?? parseFloat(current.amount_paid);

    if (finalPaid > finalTotal) {
      return NextResponse.json({ error: 'amount_paid cannot exceed total_amount' }, { status: 400 });
    }

    // due_date >= purchase_date, checked against the merged state so an edit to
    // either field alone cannot slip an invalid pair past the DB constraint.
    // Both sides are already validated ISO strings by this point, so a plain
    // string comparison via compareIsoDates is safe.
    const finalDue      = safe.due_date      !== undefined ? safe.due_date      : current.due_date;
    const finalPurchase = safe.purchase_date !== undefined ? safe.purchase_date : current.purchase_date;
    if (finalDue && finalPurchase && compareIsoDates(finalDue, finalPurchase) < 0) {
      return NextResponse.json(
        { error: 'due_date cannot be earlier than purchase_date' },
        { status: 400 },
      );
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

export async function DELETE(request, props) {
  const params = await props.params;
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
