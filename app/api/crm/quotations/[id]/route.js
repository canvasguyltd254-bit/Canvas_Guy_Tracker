export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { pick, ALLOWED_FIELDS } from '@/shared/lib/whitelist';
import { checkQuotationSuspended } from '@/shared/lib/suspendGuard';

const ROLES_CRM = ['admin', 'head_of_sales', 'sales'];

// GET /api/crm/quotations/[id]
export async function GET(request, { params }) {
  try {
    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    // quote_activities uses a polymorphic (entity_type, entity_id) reference with no FK,
    // so PostgREST cannot join it directly. Fetch separately.
    const [{ data, error }, { data: activities }] = await Promise.all([
      serviceClient
        .from('quotations')
        .select(`
          *,
          customers(id, name, phone, email, address, kra_pin, tax_status, credit_terms),
          enquiries(id, enq_num, source, category, description),
          quote_items(*),
          followups(id, due_date, note, completed_at)
        `)
        .eq('id', params.id)
        .single(),
      serviceClient
        .from('quote_activities')
        .select('id, activity_type, description, created_by, created_at')
        .eq('entity_type', 'quotation')
        .eq('entity_id', params.id)
        .order('created_at', { ascending: false }),
    ]);

    if (error || !data) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });
    return NextResponse.json({ data: { ...data, quote_activities: activities || [] } });
  } catch (err) {
    console.error('GET /api/crm/quotations/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── diff helpers ────────────────────────────────────────────────────────────
const TERM_LABELS = {
  cash_before: 'Cash Before Production',
  deposit_50:  '50% Deposit',
  on_delivery: 'On Delivery',
  net_30:      'Net 30 Days',
  net_60:      'Net 60 Days',
};

function fmtN(v) {
  return Number(v || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function diffQuote(existing, body, oldItems, newItems) {
  const changes = [];

  // Header diffs
  if (body.payment_terms && body.payment_terms !== existing.payment_terms) {
    const from = TERM_LABELS[existing.payment_terms] || existing.payment_terms || '—';
    const to   = TERM_LABELS[body.payment_terms] || body.payment_terms;
    changes.push(`Payment terms: "${from}" → "${to}"`);
  }
  if (body.tax_status && body.tax_status !== existing.tax_status) {
    changes.push(`Tax status: ${existing.tax_status} → ${body.tax_status}`);
  }
  if (body.valid_until !== undefined && body.valid_until !== existing.valid_until) {
    changes.push(`Valid until: ${body.valid_until || 'none'}`);
  }
  if (body.project_description !== undefined && body.project_description !== existing.project_description) {
    changes.push('Project description updated');
  }

  // Item diffs
  if (Array.isArray(newItems) && Array.isArray(oldItems)) {
    const oldMap = {};
    for (const item of oldItems) oldMap[item.id] = item;
    const seenIds = new Set();
    const isCharge = (it) => it.line_type && it.line_type !== 'product';

    for (const ni of newItems) {
      if (ni.id && oldMap[ni.id]) {
        const oi   = oldMap[ni.id];
        seenIds.add(ni.id);
        const name = ni.description || oi.description || 'Item';

        if (isCharge(ni) || isCharge(oi)) {
          // Charge: only amount matters (unit_price = flat gross)
          const oa = parseFloat(oi.gross_amount || oi.unit_price || 0);
          const na = parseFloat(ni.gross_amount || ni.unit_price || 0);
          if (Math.abs(na - oa) > 0.009) {
            changes.push(`${name}: KES ${fmtN(oa)} → KES ${fmtN(na)}`);
          }
        } else {
          // Product item
          const oQty = parseFloat(oi.quantity  || 0);
          const nQty = parseFloat(ni.quantity  || 0);
          const oPrice = parseFloat(oi.unit_price || 0);
          const nPrice = parseFloat(ni.unit_price || 0);
          const oGross = parseFloat(oi.gross_amount || 0);
          const nGross = parseFloat(ni.gross_amount || 0);

          if (nQty !== oQty) {
            changes.push(`"${name}": qty ${oQty} → ${nQty} (KES ${fmtN(oGross)} → KES ${fmtN(nGross)})`);
          } else if (Math.abs(nPrice - oPrice) > 0.009) {
            changes.push(`"${name}": unit price KES ${fmtN(oPrice)} → KES ${fmtN(nPrice)} (total KES ${fmtN(oGross)} → KES ${fmtN(nGross)})`);
          }

          const od = parseFloat(oi.discount_pct || 0);
          const nd = parseFloat(ni.discount_pct || 0);
          if (nd !== od) {
            if (od === 0) changes.push(`"${name}": discount added ${nd}% (saves KES ${fmtN(oGross - nGross)})`);
            else if (nd === 0) changes.push(`"${name}": discount removed (was ${od}%)`);
            else changes.push(`"${name}": discount ${od}% → ${nd}%`);
          }

          const ov = parseFloat(oi.vat_rate || 0);
          const nv = parseFloat(ni.vat_rate || 0);
          if (Math.abs(nv - ov) > 0.0001) {
            if (nv === 0) changes.push(`"${name}": VAT removed`);
            else changes.push(`"${name}": VAT ${Math.round(ov * 100)}% → ${Math.round(nv * 100)}%`);
          }
        }
      } else if (!ni.id) {
        // New item added
        const gross = parseFloat(ni.gross_amount || 0);
        if (isCharge(ni)) {
          changes.push(`${ni.description || ni.line_type || 'Charge'} added: KES ${fmtN(gross)}`);
        } else {
          const qty = parseFloat(ni.quantity || 1);
          changes.push(`"${ni.description || 'Item'}" added: qty ${qty} × KES ${fmtN(ni.unit_price)} = KES ${fmtN(gross)}`);
        }
      }
    }

    // Items in old but not in new = removed
    for (const [id, oi] of Object.entries(oldMap)) {
      if (!seenIds.has(id)) {
        const gross = parseFloat(oi.gross_amount || 0);
        if (isCharge(oi)) {
          changes.push(`${oi.description || oi.line_type || 'Charge'} removed (was KES ${fmtN(gross)})`);
        } else {
          changes.push(`"${oi.description || 'Item'}" removed (was KES ${fmtN(gross)})`);
        }
      }
    }

    // Grand total change
    const oldTotal = parseFloat(existing.total || 0);
    const newTotal = parseFloat(body.total || 0);
    if (Math.abs(newTotal - oldTotal) > 0.009 && newTotal > 0) {
      changes.push(`Grand total: KES ${fmtN(oldTotal)} → KES ${fmtN(newTotal)}`);
    }
  }

  return changes;
}
// ────────────────────────────────────────────────────────────────────────────

// PATCH /api/crm/quotations/[id]
// Updates mutable fields on any non-converted quotation.
// Converted quotes (converted_order_id IS NOT NULL) are immutable.
// Status-only patches (accept/reject/send) always allowed.
// When items are provided, diffs old vs new and logs changes to quote_activities.
export async function PATCH(request, { params }) {
  try {
    const suspendedErr = await checkQuotationSuspended(params.id);
    if (suspendedErr) return suspendedErr;

    const { user, role } = await getAuthContext();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authErr = requireRole(user, role, ROLES_CRM);
    if (authErr) return authErr;

    // Fetch enough fields to run guards + diffs
    const { data: existing } = await serviceClient
      .from('quotations')
      .select('id, status, quote_num, customer_id, converted_order_id, payment_terms, tax_status, valid_until, project_description, subtotal, vat_amount, total')
      .eq('id', params.id)
      .single();

    if (!existing) return NextResponse.json({ error: 'Quotation not found' }, { status: 404 });

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Coerce empty strings to null for UUID and date fields
    if (body.customer_id === '') body.customer_id = null;
    if (body.valid_until  === '') body.valid_until  = null;

    const isStatusOnlyPatch = Object.keys(body).length === 1 && !!body.status;

    // Only block full edits on converted quotes — status-only patches still allowed
    if (existing.converted_order_id && !isStatusOnlyPatch) {
      return NextResponse.json(
        { error: 'Cannot edit a converted quotation.' },
        { status: 422 },
      );
    }

    // Guard: accepting requires a real customer_id
    if (body.status === 'accepted' && !existing.customer_id) {
      return NextResponse.json(
        { error: 'Cannot accept a quotation linked to a prospect only. Edit the quote and link it to a customer profile first.' },
        { status: 422 },
      );
    }

    const { items, ...rest } = body;
    const safe = pick(rest, ALLOWED_FIELDS.quotations.update);

    const { data, error } = await serviceClient
      .from('quotations')
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      console.error('PATCH /api/crm/quotations/[id]:', error);
      return NextResponse.json({ error: 'Failed to update quotation' }, { status: 500 });
    }

    const activityLogs = [];

    // Full-replace items if provided — diff first, then replace
    if (Array.isArray(items)) {
      const { data: oldItems } = await serviceClient
        .from('quote_items')
        .select('*')
        .eq('quote_id', params.id);

      const changes = diffQuote(existing, body, oldItems || [], items);
      if (changes.length > 0) {
        activityLogs.push({
          entity_type:   'quotation',
          entity_id:     params.id,
          activity_type: 'edited',
          description:   changes.join(' · '),
          created_by:    user.id,
        });
      }

      await serviceClient.from('quote_items').delete().eq('quote_id', params.id);
      if (items.length > 0) {
        const itemRows = items.map((item, i) =>
          pick({ ...item, quote_id: params.id, sort_order: item.sort_order ?? i },
            ALLOWED_FIELDS.quote_items.insert),
        );
        await serviceClient.from('quote_items').insert(itemRows);
      }
    } else if (!isStatusOnlyPatch) {
      // Header-only edit (no items array) — still log header diffs
      const changes = diffQuote(existing, body, [], []);
      if (changes.length > 0) {
        activityLogs.push({
          entity_type:   'quotation',
          entity_id:     params.id,
          activity_type: 'edited',
          description:   changes.join(' · '),
          created_by:    user.id,
        });
      }
    }

    // Log status changes
    if (body.status && body.status !== existing.status) {
      activityLogs.push({
        entity_type:   'quotation',
        entity_id:     params.id,
        activity_type: 'status_change',
        description:   `Status: ${existing.status} → ${body.status}`,
        created_by:    user.id,
      });
    }

    if (activityLogs.length > 0) {
      await serviceClient.from('quote_activities').insert(activityLogs);
    }

    return NextResponse.json({ data });
  } catch (err) {
    console.error('PATCH /api/crm/quotations/[id]:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
