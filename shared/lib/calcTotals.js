/**
 * shared/lib/calcTotals.js
 * Canonical VAT + discount calculation for line items.
 * Used by QuoteFormModal (CRM) and LineItemEditor (orders + quotes).
 *
 * @param {Array}  items             - line items with { quantity, unit_price, discount_pct, tax_treatment }
 * @param {string} pricingMode       - 'vat_inclusive' | 'vat_exclusive'
 * @param {number|string} headerDiscountPct - global discount % applied when item has none
 * @param {string} taxStatus         - 'standard' | 'exempt'
 * @returns {{ rows, subtotal, vatAmount, total }}
 *   rows       - items annotated with _net, _vat, _gross
 *   subtotal   - sum of net amounts
 *   vatAmount  - sum of VAT
 *   total      - subtotal + vatAmount
 */
export default function calcTotals(items, pricingMode, headerDiscountPct, taxStatus) {
  let sub = 0, vat = 0;
  const rows = items.map(item => {
    const qty      = parseFloat(item.quantity)   || 1;
    const price    = parseFloat(item.unit_price) || 0;
    const itemDisc = item.discount_pct !== '' && item.discount_pct != null
      ? Math.max(0, Math.min(100, parseFloat(item.discount_pct)))
      : (parseFloat(headerDiscountPct) || 0);
    const discount = 1 - itemDisc / 100;
    const exempt   = taxStatus === 'exempt' || item.tax_treatment === 'exempt';
    const vatRate  = exempt ? 0 : 0.16;
    let net, v, gross;
    if (pricingMode === 'vat_inclusive') {
      gross = Math.round(price * qty * discount * 100) / 100;
      net   = Math.round((gross / (1 + vatRate)) * 100) / 100;
      v     = Math.round((gross - net) * 100) / 100;
    } else {
      net   = Math.round(price * qty * discount * 100) / 100;
      v     = Math.round(net * vatRate * 100) / 100;
      gross = net + v;
    }
    sub += net; vat += v;
    return { ...item, _net: net, _vat: v, _gross: gross };
  });
  return {
    rows,
    subtotal:  Math.round(sub * 100) / 100,
    vatAmount: Math.round(vat * 100) / 100,
    total:     Math.round((sub + vat) * 100) / 100,
  };
}
