export const runtime = 'nodejs';

/**
 * POST /api/crm/quotations/[id]/revise
 *
 * Creates a new revision of an existing quotation.
 * The new revision inherits the quote_group_id and gets revision N+1.
 * The parent quotation is marked 'superseded'.
 * Immutable quotations (accepted, rejected, expired) can still be revised —
 * the revision is a new draft for re-negotiation.
 */

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

export async function POST(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    // Fetch the parent quotation with items
    const { data: parent, error: fetchErr } = await serviceClient
      .from('quotations')
      .select('*, quote_items(*)')
      .eq('id', params.id)
      .single();

    if (fetchErr || !parent) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });

    // Cannot revise a superseded quotation (use the latest revision instead)
    if (parent.status === 'superseded') {
      return NextResponse.json(
        { error: 'Cannot revise a superseded quotation. Find the latest revision in this group.' },
        { status: 422 },
      );
    }

    // Find the highest revision number in this group
    const { data: siblings } = await serviceClient
      .from('quotations')
      .select('revision')
      .eq('quote_group_id', parent.quote_group_id)
      .order('revision', { ascending: false })
      .limit(1);

    const nextRevision = ((siblings?.[0]?.revision) ?? parent.revision) + 1;

    // Parse optional overrides from body
    let overrides = {};
    try {
      const body = await request.json();
      overrides = body || {};
    } catch { /* no body is fine */ }

    // Generate new QT number
    const { data: qtNum, error: numErr } = await serviceClient.rpc('next_qt_num');
    if (numErr || !qtNum) {
      return NextResponse.json({ error: 'Failed to generate quote number' }, { status: 500 });
    }

    // Build new quotation row
    const newQuoteData = {
      quote_num:          qtNum,
      quote_group_id:     parent.quote_group_id,
      revision:           nextRevision,
      enquiry_id:         parent.enquiry_id,
      customer_id:        overrides.customer_id    ?? parent.customer_id,
      prospect_name:      overrides.prospect_name  ?? parent.prospect_name,
      prospect_contact:   overrides.prospect_contact ?? parent.prospect_contact,
      project_description: overrides.project_description ?? parent.project_description,
      payment_terms:      overrides.payment_terms  ?? parent.payment_terms,
      valid_until:        overrides.valid_until    ?? null,
      tax_status:         overrides.tax_status     ?? parent.tax_status,
      pricing_mode:       overrides.pricing_mode   ?? parent.pricing_mode,
      subtotal:           overrides.subtotal       ?? parent.subtotal,
      vat_amount:         overrides.vat_amount     ?? parent.vat_amount,
      total:              overrides.total          ?? parent.total,
      status:             'draft',
      created_by:         user.id,
    };

    const { data: newQuote, error: insertErr } = await serviceClient
      .from('quotations')
      .insert(newQuoteData)
      .select()
      .single();

    if (insertErr) {
      console.error('POST /revise — insert new quote:', insertErr);
      return NextResponse.json({ error: 'Failed to create revision' }, { status: 500 });
    }

    // Copy items from parent to new revision
    const itemsToCopy = overrides.items ?? parent.quote_items ?? [];
    if (itemsToCopy.length > 0) {
      const itemRows = itemsToCopy.map((item, i) =>
        pick({ ...item, quote_id: newQuote.id, sort_order: item.sort_order ?? i },
          ALLOWED_FIELDS.quote_items.insert),
      );
      await serviceClient.from('quote_items').insert(itemRows);
    }

    // Mark parent as superseded
    await serviceClient
      .from('quotations')
      .update({ status: 'superseded', updated_at: new Date().toISOString() })
      .eq('id', params.id);

    // Activity log on both
    await serviceClient.from('quote_activities').insert([
      {
        entity_type: 'quotation', entity_id: params.id,
        activity_type: 'superseded',
        description: `Superseded by revision ${nextRevision} (${qtNum})`,
        created_by: user.id,
      },
      {
        entity_type: 'quotation', entity_id: newQuote.id,
        activity_type: 'created',
        description: `Revision ${nextRevision} created from ${parent.quote_num}`,
        created_by: user.id,
      },
    ]);

    return NextResponse.json({ data: newQuote }, { status: 201 });
  } catch (err) {
    console.error('POST /api/crm/quotations/[id]/revise:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
