export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { randomUUID } from 'crypto';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// GET /api/crm/quotations?status=draft&customer_id=...&q=...
export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    const { searchParams } = new URL(request.url);
    const status      = searchParams.get('status');
    const customerId  = searchParams.get('customer_id');
    const q           = searchParams.get('q');

    let query = serviceClient
      .from('quotations')
      .select(`
        *,
        customers(id, name, phone, email),
        enquiries(id, enq_num, source, category),
        quote_items(id, line_type, description, quantity, unit_price, discount_pct, net_amount, vat_amount, gross_amount, sort_order),
        orders!converted_order_id(id, invoice_number, invoice_journal_entry_id)
      `)
      .order('created_at', { ascending: false })
      .limit(200);

    if (status)     query = query.eq('status', status);
    if (customerId) query = query.eq('customer_id', customerId);
    if (q)          query = query.ilike('project_description', `%${q}%`);

    const { data, error } = await query;
    if (error) {
      console.error('GET /api/crm/quotations:', error);
      return NextResponse.json({ error: 'Failed to fetch quotations' }, { status: 500 });
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('GET /api/crm/quotations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/crm/quotations
// Creates a NEW quotation (revision 1 of a new group).
// Body: { enquiry_id?, customer_id?, prospect_name?, prospect_contact?,
//         project_description, payment_terms, valid_until, tax_status,
//         pricing_mode, items: [...], subtotal, vat_amount, total }
export async function POST(request) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Must have customer or prospect
    if (!body.customer_id && !body.prospect_name?.trim()) {
      return NextResponse.json(
        { error: 'Must provide either customer_id or prospect_name' },
        { status: 422 },
      );
    }

    // Generate QT number
    const { data: qtNum, error: numErr } = await serviceClient.rpc('next_qt_num');
    if (numErr || !qtNum) {
      console.error('next_qt_num failed:', numErr);
      return NextResponse.json({ error: 'Failed to generate quote number' }, { status: 500 });
    }

    const quoteGroupId = randomUUID();
    const items = Array.isArray(body.items) ? body.items : [];

    // ── Compute totals server-side; never trust browser arithmetic ─────────────
    const pricingMode = body.pricing_mode || 'vat_exclusive';
    // Tax status: authoritative source is the customers table, not the request body.
    // Fall back to body.tax_status only for prospect quotes with no customer_id.
    let quoteTaxStatus = body.tax_status || 'taxable';
    if (body.customer_id) {
      const { data: cust } = await serviceClient
        .from('customers')
        .select('tax_status')
        .eq('id', body.customer_id)
        .maybeSingle();
      if (cust?.tax_status) quoteTaxStatus = cust.tax_status;
    }

    // Header-level discount — applied to items that have no item-level override
    const headerDiscountPct = Math.max(0, Math.min(100, parseFloat(body.discount_pct) || 0));

    let computedSubtotal = 0;
    let computedVat      = 0;

    for (const item of items) {
      const qty   = parseFloat(item.quantity)   || 1;
      const price = parseFloat(item.unit_price) || 0;

      // Per-item discount overrides header; both clamped 0–100
      const itemDiscountPct = item.discount_pct != null
        ? Math.max(0, Math.min(100, parseFloat(item.discount_pct)))
        : headerDiscountPct;
      const discount = 1 - itemDiscountPct / 100;

      // Effective VAT: 16% unless the quote-level or line-level tax status is exempt.
      // quoteTaxStatus is sourced from the customers table (authoritative), not the body.
      const lineExempt = quoteTaxStatus === 'exempt' || item.tax_treatment === 'exempt';
      const vatRate = lineExempt ? 0 : 0.16;

      let net, vat, gross;
      if (pricingMode === 'vat_inclusive') {
        gross = Math.round(price * qty * discount * 100) / 100;
        net   = Math.round((gross / (1 + vatRate)) * 100) / 100;
        vat   = Math.round((gross - net) * 100) / 100;
      } else {
        net   = Math.round(price * qty * discount * 100) / 100;
        vat   = Math.round(net * vatRate * 100) / 100;
        gross = net + vat;
      }
      // Store computed values; vat_rate persisted so the PDF and downstream GL use the same rate
      item._net      = net;
      item._vat      = vat;
      item._gross    = gross;
      item._vat_rate = vatRate;
      computedSubtotal += net;
      computedVat      += vat;
    }
    const computedTotal = Math.round((computedSubtotal + computedVat) * 100) / 100;
    computedSubtotal    = Math.round(computedSubtotal * 100) / 100;
    computedVat         = Math.round(computedVat * 100) / 100;

    const safe = pick(
      {
        ...body,
        quote_group_id: quoteGroupId,
        revision: 1,
        created_by: user.id,
        // Override with server-computed values
        subtotal:   computedSubtotal,
        vat_amount: computedVat,
        total:      computedTotal,
      },
      ALLOWED_FIELDS.quotations.insert,
    );

    const { data: quote, error: qErr } = await serviceClient
      .from('quotations')
      .insert({ ...safe, quote_num: qtNum, status: safe.status || 'draft' })
      .select()
      .single();

    if (qErr) {
      console.error('POST /api/crm/quotations:', qErr);
      return NextResponse.json({ error: 'Failed to create quotation' }, { status: 500 });
    }

    // Insert items — FATAL: roll back quotation header on failure
    if (items.length > 0) {
      const itemRows = items.map((item, i) =>
        pick(
          {
            ...item,
            quote_id:     quote.id,
            sort_order:   item.sort_order ?? i,
            net_amount:   item._net,
            vat_amount:   item._vat,
            gross_amount: item._gross,
            vat_rate:     item._vat_rate,
          },
          ALLOWED_FIELDS.quote_items.insert,
        ),
      );
      const { error: itemErr } = await serviceClient.from('quote_items').insert(itemRows);
      if (itemErr) {
        console.error('POST quote_items failed — rolling back quotation:', itemErr);
        await serviceClient.from('quotations').delete().eq('id', quote.id);
        return NextResponse.json(
          { error: 'Failed to save quote items — quotation rolled back' },
          { status: 500 },
        );
      }
    }

    // Activity log
    await serviceClient.from('quote_activities').insert({
      entity_type: 'quotation',
      entity_id: quote.id,
      activity_type: 'created',
      description: `Quotation ${qtNum} created`,
      created_by: user.id,
    });

    // If linked to enquiry, advance stage to 'quoted'
    if (body.enquiry_id) {
      await serviceClient
        .from('enquiries')
        .update({ stage: 'quoted', updated_at: new Date().toISOString() })
        .eq('id', body.enquiry_id)
        .in('stage', ['new', 'contacted']);  // only advance, never downgrade
    }

    return NextResponse.json({ data: quote }, { status: 201 });
  } catch (err) {
    console.error('POST /api/crm/quotations:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
