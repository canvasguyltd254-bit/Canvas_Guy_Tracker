/**
 * shared/lib/invoiceLines.js
 *
 * Single source of truth for CRM invoice lines. Used by BOTH
 *   GET /api/crm/invoices/[id]       (screen)
 *   GET /api/crm/invoices/[id]/pdf   (PDF)
 * so the two can never disagree.
 *
 * Rules
 *  - Invoice lines ALWAYS come from the order's CURRENT order_items, including
 *    quote-converted orders. The quotation is provenance only
 *    ("Original quotation", "Original quoted total") — its line totals are
 *    never mixed with orders.total_value.
 *  - Subtotal / VAT / total are summed from the SAME current item set.
 *  - Changes made after conversion are listed from order_item_adjustments
 *    ("Adjustments since quotation"): date · user · reason · change · amount.
 *
 * Pure functions + one loader; no framework imports.
 */

const VAT_RATE = 0.16;

/** Per-line gross/net/VAT. Stored amounts win; rows whose amounts are all 0
 *  (pre-migration) are recomputed from unit_price × quantity. */
export function computeLineAmounts(item, pricingMode, taxStatus) {
  const qty       = Number(item.quantity   || 0);
  const unitPrice = Number(item.unit_price || 0);
  let gross = Number(item.gross_amount || 0);
  let net   = Number(item.net_amount   || 0);
  let vat   = Number(item.vat_amount   || 0);
  if (gross === 0 && net === 0 && vat === 0 && unitPrice !== 0) {
    if (taxStatus === 'exempt') {
      net = unitPrice * qty; vat = 0; gross = net;
    } else if (pricingMode === 'vat_inclusive') {
      gross = unitPrice * qty; net = gross / (1 + VAT_RATE); vat = gross - net;
    } else {
      net = unitPrice * qty; vat = net * VAT_RATE; gross = net + vat;
    }
  }
  return { gross, net, vat };
}

/**
 * @param {object} p
 * @param {object} p.order        orders row (pricing_mode, tax_status, total_value, …)
 * @param {object[]} p.orderItems current order_items rows
 * @param {object|null} p.quote   quotations row (provenance only) or null
 * @param {string} p.taxStatus    resolved tax status (order snapshot first)
 */
export function buildInvoiceBreakdown({ order, orderItems, quote, taxStatus }) {
  const pricingMode = order.pricing_mode || quote?.pricing_mode || 'vat_inclusive';

  const items = [...(orderItems || [])]
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(i => {
      const { gross, net, vat } = computeLineAmounts(i, pricingMode, taxStatus);
      return {
        id:           i.id,
        description:  i.description,
        category:     i.category,
        line_type:    i.line_type,
        quantity:     Number(i.quantity   || 0),
        unit_price:   Number(i.unit_price || 0),
        net_amount:   net,
        vat_amount:   vat,
        gross_amount: gross,
        finish_type:  i.finish_type,
        finish_color: i.finish_color,
        wood_type:    i.wood_type,
      };
    });

  const subtotal = items.reduce((s, i) => s + i.net_amount,   0);
  const vatTotal = items.reduce((s, i) => s + i.vat_amount,   0);
  const total    = items.reduce((s, i) => s + i.gross_amount, 0);

  const orderTotal = Number(order.total_value || 0);

  return {
    source:       'order_items',
    pricing_mode: pricingMode,
    tax_status:   taxStatus,
    subtotal,
    vat_amount:   vatTotal,
    total,
    items,
    // Provenance — never used to compute anything above.
    quotation: quote ? {
      quote_num:      quote.quote_num,
      revision:       quote.revision,
      original_total: Number(quote.total || 0),
      current_total:  total,
      changed:        Math.abs(Number(quote.total || 0) - total) >= 0.5,
    } : null,
    // Surfaces (rather than hides) a legacy order whose stored total never
    // matched its lines. After the atomic RPC this is always false.
    order_total_value: orderTotal,
    total_mismatch:    Math.abs(orderTotal - total) >= 0.5,
  };
}

function describeSnapshot(v) {
  if (!v) return null;
  return {
    description: v.description || v.category || '—',
    category:    v.category,
    quantity:    v.quantity,
    unit_price:  Number(v.unit_price || 0),
    gross:       Number(v.gross_amount || 0),
  };
}

/** Adjustments since quotation, grouped by Save (event_id), oldest first. */
export async function loadInvoiceAdjustments(serviceClient, orderId) {
  const { data: rows, error } = await serviceClient
    .from('order_item_adjustments')
    .select('id, event_id, order_item_id, adjustment_type, before_values, after_values, gross_delta, reason, was_invoice_posted, created_at, created_by')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });

  if (error) return { adjustments: [], error };

  const userIds = [...new Set((rows || []).map(r => r.created_by).filter(Boolean))];
  const names = {};
  if (userIds.length > 0) {
    const { data: profiles } = await serviceClient
      .from('user_profiles')
      .select('id, display_name')
      .in('id', userIds);
    for (const p of profiles || []) names[p.id] = p.display_name;
  }

  const byEvent = new Map();
  for (const r of rows || []) {
    if (!byEvent.has(r.event_id)) {
      byEvent.set(r.event_id, {
        event_id:   r.event_id,
        created_at: r.created_at,
        user:       names[r.created_by] || 'Unknown user',
        reason:     r.reason,
        gross_delta: 0,
        lines:      [],
      });
    }
    const ev = byEvent.get(r.event_id);
    ev.gross_delta += Number(r.gross_delta || 0);
    ev.lines.push({
      type:   r.adjustment_type,                     // item_added | item_removed | item_changed
      before: describeSnapshot(r.before_values),
      after:  describeSnapshot(r.after_values),
      gross_delta: Number(r.gross_delta || 0),
    });
  }
  return { adjustments: [...byEvent.values()], error: null };
}
