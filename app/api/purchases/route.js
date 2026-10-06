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
import { isValidIsoDate, compareIsoDates } from '@/shared/lib/isoDate';
import { inferLegacyDueDateMode, shouldRequestSupplierTermsDerivation } from '@/shared/lib/supplierTerms';

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

    const INITIAL_PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Cheque', 'Other'];
    const initPaymentMethod    = body.initial_payment_method || 'Cash';
    const initPaymentReference = body.initial_payment_reference?.trim() || null;
    if (!INITIAL_PAYMENT_METHODS.includes(initPaymentMethod)) {
      return NextResponse.json(
        { error: `initial_payment_method must be one of: ${INITIAL_PAYMENT_METHODS.join(', ')}` },
        { status: 400 },
      );
    }

    const purchaseDate = body.purchase_date || new Date().toISOString().split('T')[0];
    if (!isValidIsoDate(purchaseDate)) {
      return NextResponse.json({ error: 'purchase_date must be a valid date in YYYY-MM-DD format' }, { status: 400 });
    }

    // due_date_mode says WHY due_date has the value it will get — provenance
    // decided at write time, never re-derived later (see shared/lib/supplierTerms.js).
    //
    // Legacy-omission rule (P0 fix): a caller that sends no due_date_mode at
    // all is NOT the same as a caller who chose "unrecorded" — that was the
    // rev-2 bug (`body.due_date_mode || 'unrecorded'` claimed "unrecorded"
    // as the default while the trigger silently derived from supplier terms
    // anyway whenever they existed, i.e. the string and the behavior
    // disagreed). The actual pre-mode contract was: a raw due_date present
    // means explicit; otherwise derive from supplier terms if the supplier
    // has any, else leave unrecorded. We reproduce that contract explicitly
    // here instead of leaving it as an accidental trigger side effect.
    const VALID_DUE_DATE_MODES = ['explicit', 'supplier_terms', 'unrecorded'];
    const rawDueDateProvided = String(body.due_date ?? '').trim() !== '';

    let dueDateMode = body.due_date_mode;
    let cachedSupplierTermsDays; // avoid a second supplier lookup below when already fetched here

    if (dueDateMode === undefined || dueDateMode === null) {
      if (!rawDueDateProvided) {
        const { data: sup, error: supErr } = await serviceClient
          .from('suppliers')
          .select('payment_terms_days')
          .eq('id', body.supplier_id)
          .single();
        if (supErr || !sup) {
          return NextResponse.json({ error: 'Supplier not found' }, { status: 400 });
        }
        cachedSupplierTermsDays = sup.payment_terms_days;
      }
      // shared/lib/supplierTerms.js — see the P0 rev-3 review for why this
      // is a named, tested rule and not an inline default string.
      dueDateMode = inferLegacyDueDateMode({
        rawDueDateProvided,
        supplierTermsDays: cachedSupplierTermsDays,
      });
    } else if (!VALID_DUE_DATE_MODES.includes(dueDateMode)) {
      return NextResponse.json(
        { error: `due_date_mode must be one of: ${VALID_DUE_DATE_MODES.join(', ')}` },
        { status: 400 },
      );
    }

    let explicitDueDate;

    if (dueDateMode === 'explicit') {
      const raw = String(body.due_date ?? '').trim();
      if (!raw) {
        return NextResponse.json({ error: 'due_date is required when due_date_mode is "explicit"' }, { status: 400 });
      }
      if (!isValidIsoDate(raw)) {
        return NextResponse.json({ error: 'due_date must be a valid date in YYYY-MM-DD format' }, { status: 400 });
      }
      if (compareIsoDates(raw, purchaseDate) < 0) {
        return NextResponse.json({ error: 'due_date cannot be earlier than purchase_date' }, { status: 400 });
      }
      explicitDueDate = raw;
      // The trigger reads NEW.due_date to decide provenance — this must be
      // the ONLY case that sets it before the row hits the trigger.
    } else {
      // supplier_terms / unrecorded: a due_date sent alongside either of
      // these is a contradiction (the mode says the date isn't a manual
      // entry), so reject rather than silently pick one meaning over the other.
      if (rawDueDateProvided) {
        return NextResponse.json(
          { error: `due_date must not be provided when due_date_mode is "${dueDateMode}"` },
          { status: 400 },
        );
      }
    }

    let requestSupplierTermsMode = false;

    if (dueDateMode === 'supplier_terms') {
      // Requested (explicitly, or via the legacy-omission rule above) —
      // confirm the supplier actually has terms so the failure is a clear
      // 400, not a silent fall-through to "unrecorded".
      let termsDays = cachedSupplierTermsDays;
      if (termsDays === undefined) {
        const { data: sup, error: supErr } = await serviceClient
          .from('suppliers')
          .select('payment_terms_days')
          .eq('id', body.supplier_id)
          .single();
        if (supErr || !sup) {
          return NextResponse.json({ error: 'Supplier not found' }, { status: 400 });
        }
        termsDays = sup.payment_terms_days;
      }
      if (!Number.isInteger(termsDays)) {
        return NextResponse.json(
          { error: 'This supplier has no recorded credit terms. Record terms on the supplier, or use "explicit" / "unrecorded" instead.' },
          { status: 400 },
        );
      }
      // Terms confirmed — leave due_date unset and instead set the internal
      // due_date_request_mode marker so the BEFORE INSERT trigger computes
      // the date, stamps due_date_source = 'supplier_terms', AND snapshots
      // the terms it used into due_date_terms_days, all from the ONE
      // authoritative read of suppliers.payment_terms_days at insert time.
      // Computing (or snapshotting) it here too would be a second
      // implementation that could silently drift from the trigger's.
      requestSupplierTermsMode = shouldRequestSupplierTermsDerivation(dueDateMode);
    }

    const safe = {
      supplier_id:            body.supplier_id,
      purchase_date:          purchaseDate,
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
    if (explicitDueDate) safe.due_date = explicitDueDate;
    // Internal marker only — never derived from client input, never part of
    // shared/lib/whitelist.js. See cashflow_v0_supplier_terms.sql.
    if (requestSupplierTermsMode) safe.due_date_request_mode = 'supplier_terms';

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
