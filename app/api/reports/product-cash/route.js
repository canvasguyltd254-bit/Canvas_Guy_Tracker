/**
 * app/api/reports/product-cash/route.js
 *
 * GET /api/reports/product-cash?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Cash received per item category in a period. Customers pay against orders, so
 * per-category cash is ALLOCATED across each order's lines by value (see
 * shared/lib/reports/productCash.js). The allocated total is reconciled against
 * the independent Payments Received total for the same dates.
 *
 * Also returns, for orders raised in the period: invoiced, collected to date,
 * outstanding, ex-VAT revenue and estimated margin (costs are held per order,
 * so they are split by sales value).
 *
 * Roles: admin, head_of_sales.
 */

export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getAuthContext, requireRole, serviceClient } from '@/shared/lib/api-auth';
import { fetchAllRows } from '@/shared/lib/reports/fetchAll';
import { isLive } from '@/shared/lib/reports/orderRules';
import { isInvoiceRecognised } from '@/shared/lib/customerBalance';
import { buildOrderPnlRows } from '@/shared/lib/reports/orderPnl';
import { buildPaymentsReport } from '@/shared/lib/reports/paymentsReceived';
import { buildProductCash } from '@/shared/lib/reports/productCash';
import { loadPnlInputs, loadItems } from '@/shared/lib/reports/loadPnlInputs';
import { nairobiBounds, validateQueryRange } from '@/shared/lib/reports/dateBounds';

const ROLES = ['admin', 'head_of_sales'];

export async function GET(request) {
  try {
    const { user, role } = await getAuthContext();
    const authError = requireRole(user, role, ROLES);
    if (authError) return authError;

    const sp = new URL(request.url).searchParams;
    const from = sp.get('from') || null;
    const to = sp.get('to') || null;
    if (!from || !to) return NextResponse.json({ error: 'Both "from" and "to" are required.' }, { status: 400 });
    const rangeError = validateQueryRange({ from, to });
    if (rangeError) return NextResponse.json({ error: rangeError }, { status: 400 });

    const { gte, lt } = nairobiBounds({ from, to });

    // Payments dated in range (reversed ones are kept so the report can count them).
    const payments = await fetchAllRows(
      (a, b) => serviceClient.from('order_payments')
        .select('id, order_id, amount, payment_date, reversed_at, orders(status, suspended_at)')
        .gte('payment_date', from).lte('payment_date', to)
        .order('payment_date', { ascending: true }).order('id', { ascending: true })
        .range(a, b),
      { label: 'payments' },
    );

    // Orders raised in range: live and invoiced (same recognition rule as Receivables).
    const raised = await fetchAllRows(
      (a, b) => serviceClient.from('orders')
        .select('id, order_num, client, status, total_value, created_at, suspended_at, quote_id, invoice_number')
        .gte('created_at', gte).lt('created_at', lt)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .range(a, b),
      { label: 'orders' },
    );
    const cohort = raised.filter(o => isLive(o) && isInvoiceRecognised(o));
    const cohortIds = cohort.map(o => o.id);

    // Costs + items for the cohort; items only for payment orders outside it.
    const inputs = await loadPnlInputs(serviceClient, cohortIds);
    const cohortSet = new Set(cohortIds);
    const extraIds = [...new Set(payments.map(p => p.order_id).filter(id => id && !cohortSet.has(id)))];
    const extraItems = extraIds.length ? await loadItems(serviceClient, extraIds) : {};
    const itemsByOrder = { ...extraItems, ...inputs.itemsByOrder };

    const pnlRows = buildOrderPnlRows({
      orders: cohort,
      itemsByOrder: inputs.itemsByOrder,
      purchasesByOrder: inputs.purchasesByOrder,
      labourByOrder: inputs.labourByOrder,
      expensesByOrder: inputs.expensesByOrder,
      payTotals: inputs.payTotals,
    });
    const pnlByOrder = Object.fromEntries(pnlRows.map(r => [r.id, r]));

    // Independent total, computed by the Payments Received logic on the same rows.
    const expectedTotal = buildPaymentsReport(payments, { from, to, basis: 'received' }).summary.total;

    const report = buildProductCash({
      payments, cohort, itemsByOrder, payTotals: inputs.payTotals, pnlByOrder, expectedTotal,
    });

    return NextResponse.json({ success: true, data: { from, to, ...report } });
  } catch (err) {
    console.error('GET /api/reports/product-cash:', err);
    // Callers are already limited to admin / head_of_sales, so the cause is safe to show.
    return NextResponse.json(
      { error: `Failed to build the cash-by-product report. ${err?.message || ''}`.trim() },
      { status: 500 },
    );
  }
}
